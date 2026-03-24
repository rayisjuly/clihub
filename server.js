/**
 * @input Dependencies: express, ws, child_process
 * @output Exports: HTTP Server (port 5678) + WebSocket Server
 * @pos Backend entry point, bridging frontend WebSocket with Claude Code CLI processes
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const crypto = require('crypto');
const db = require('./db');
const telegram = require('./telegram');

const PORT = process.env.PORT || 5678;
const PROJECTS_DIR = (process.env.PROJECTS_DIR || '~/Documents/Project').replace(/^~/, process.env.HOME);


// ─── Auth ─────────────────────────────────────────
const BEARER_TOKEN = process.env.BEARER_TOKEN;
const HOOK_TOKEN = process.env.HOOK_TOKEN || BEARER_TOKEN;
if (!BEARER_TOKEN || BEARER_TOKEN === 'your_secret_token_here') {
  console.error('Error: BEARER_TOKEN environment variable is required (and must not be the default placeholder)');
  console.error('Usage: BEARER_TOKEN=your_secret node server.js');
  process.exit(1);
}

function verifyToken(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── Rate limiting ────────────────────────────────
const loginAttempts = {};

// Clean up expired login attempts every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const ip of Object.keys(loginAttempts)) {
    if (loginAttempts[ip].lockedUntil && now > loginAttempts[ip].lockedUntil) {
      delete loginAttempts[ip];
    }
  }
}, 30 * 60 * 1000);

function checkRateLimit(ip) {
  const entry = loginAttempts[ip];
  if (!entry) return true;
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) return false;
  if (entry.lockedUntil) {
    delete loginAttempts[ip];
    return true;
  }
  return true;
}

function recordFailure(ip) {
  if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0 };
  loginAttempts[ip].count++;
  if (loginAttempts[ip].count >= 5) {
    loginAttempts[ip].lockedUntil = Date.now() + 15 * 60 * 1000;
  }
}

// ─── Database persistence (SQLite) ────────────────
db.initDB();
db.cleanupOldEvents(30);

// ─── Image storage ───────────────────────────────
const IMAGES_DIR = path.join(__dirname, 'data', 'images');
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ─── History helpers ─────────────────────────────
// Group flat DB events into structured messages for frontend
function groupEventsIntoMessages(events) {
  const messages = [];
  let currentTurn = null;

  for (const e of events) {
    if (e.type === 'user_message') {
      // Flush current assistant turn
      if (currentTurn) {
        messages.push(currentTurn);
        currentTurn = null;
      }
      messages.push({ role: 'user', content: e.content, ts: e.ts });
    } else if (e.type === 'turn_end') {
      if (currentTurn) {
        messages.push(currentTurn);
        currentTurn = null;
      }
    } else {
      // Assistant events: text, thinking, tool_use, tool_result
      if (!currentTurn) {
        currentTurn = { role: 'assistant', ts: e.ts, events: [] };
      }
      const evt = { type: e.type };
      if (e.content) evt.content = e.content;
      if (e.tool_name) evt.tool = e.tool_name;
      if (e.tool_use_id) evt.toolUseId = e.tool_use_id;
      if (e.tool_input) {
        try { evt.input = JSON.parse(e.tool_input); } catch { evt.input = e.tool_input; }
      }
      if (e.tool_output != null) evt.content = e.tool_output;
      if (e.is_error) evt.isError = true;
      currentTurn.events.push(evt);
    }
  }
  // Flush remaining turn
  if (currentTurn) messages.push(currentTurn);
  return messages;
}

function saveSessionMeta(session) {
  db.updateSession(session.id, {
    claude_session_id: session.claudeSessionId,
    input_tokens: session.usage.input_tokens,
    output_tokens: session.usage.output_tokens,
    cache_creation_tokens: session.usage.cache_creation_input_tokens,
    cache_read_tokens: session.usage.cache_read_input_tokens,
    cost_usd: session.costUsd || 0,
    model: session.model || null,
    seq: session.seq,
    server_text_buffer: session.serverTextBuffer || '',
    turn_index: session.turnIndex || 0,
  });
}

function restoreSessions() {
  const rows = db.listSessions();
  for (const data of rows) {
    const session = {
      id: data.id,
      name: data.name,
      process: null,
      projectDir: data.project_dir,
      status: 'stopped',
      claudeSessionId: data.claude_session_id || null,
      pendingPermissions: new Map(),
      approvedTools: new Set(),
      buffer: '',
      serverTextBuffer: data.server_text_buffer || '',
      seq: data.seq || 0,
      replayBuffer: [],
      turnIndex: data.turn_index || 0,
      createdAt: data.created_at || Date.now(),
      usage: {
        input_tokens: data.input_tokens || 0,
        output_tokens: data.output_tokens || 0,
        cache_creation_input_tokens: data.cache_creation_tokens || 0,
        cache_read_input_tokens: data.cache_read_tokens || 0,
      },
      costUsd: data.cost_usd || 0,
      model: data.model || null,
    };
    sessions.set(session.id, session);
    console.log(`[Restore] Session restored: ${session.id} (${session.name})`);
  }
}

// ─── Sessions Map ─────────────────────────────────
//
// Each session maps to an independent claude process
// {
//   id, process, projectDir, status,
//   claudeSessionId, pendingPermissions, buffer, serverTextBuffer
// }

const sessions = new Map();

function createSession(projectDir) {
  const id = crypto.randomUUID().slice(0, 8);
  const name = path.basename(projectDir);
  const session = {
    id,
    name,
    process: null,
    projectDir,
    status: 'idle',       // idle | thinking | stopped
    claudeSessionId: null, // for claude --resume
    pendingPermissions: new Map(), // toolUseId → {resolve, timeout}
    approvedTools: new Set(),     // tools approved in this session
    buffer: '',            // stdout NDJSON buffer
    serverTextBuffer: '',  // accumulated assistant text (for persistence)
    thinkingBuffer: '',    // accumulated thinking text (flush on block_stop)
    seq: 0,                // message sequence number (for client sync)
    replayBuffer: [],      // last N broadcast events (for reconnect replay)
    turnIndex: 0,          // increments per assistant turn
    currentBlockType: null, // track current content block type
    createdAt: Date.now(),
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    costUsd: 0,
    model: null,
  };
  sessions.set(id, session);
  db.createSession(id, name, projectDir);
  return session;
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

function deleteSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (session.process) {
    session.process.kill('SIGTERM');
  }
  telegram.cleanupSession(sessionId);
  db.deleteSession(sessionId);
  // Clean up image directory
  const imgDir = path.join(IMAGES_DIR, sessionId);
  try { fs.rmSync(imgDir, { recursive: true }); } catch {}
  sessions.delete(sessionId);
  return true;
}

function listSessions() {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    name: s.name,
    projectDir: s.projectDir,
    status: s.status,
    createdAt: s.createdAt,
    usage: s.usage,
    costUsd: s.costUsd,
    model: s.model,
  }));
}

// ─── Express ───────────────────────────────────────

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── CSP headers ──────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' https://static.cloudflareinsights.com; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "connect-src 'self' ws: wss: " + (process.env.CF_ACCESS_DOMAIN ? "https://" + process.env.CF_ACCESS_DOMAIN + " " : "") + "https://cloudflareinsights.com; " +
    "manifest-src 'self'" + (process.env.CF_ACCESS_DOMAIN ? " https://" + process.env.CF_ACCESS_DOMAIN : "") + ";"
  );
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'icon.svg'), { headers: { 'Content-Type': 'image/svg+xml' } });
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth middleware ──────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (verifyToken(token, BEARER_TOKEN) || verifyToken(token, HOOK_TOKEN)) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// ─── Auth API ─────────────────────────────────────

app.post('/api/auth/verify', (req, res) => {
  const ip = req.ip;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many attempts, try again in 15 minutes' });
  }
  const token = req.body.token;
  if (verifyToken(token, BEARER_TOKEN)) {
    delete loginAttempts[ip];
    res.json({ ok: true });
  } else {
    recordFailure(ip);
    res.status(401).json({ error: 'Incorrect password' });
  }
});

// ─── Image API ────────────────────────────────────

app.post('/api/upload', requireAuth, (req, res) => {
  const { sessionId, dataUrl } = req.body;
  if (!sessionId || !dataUrl) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  const match = dataUrl.match(/^data:(image\/(jpeg|png|webp|gif));base64,(.+)$/);
  if (!match) {
    return res.status(400).json({ error: 'Invalid image data' });
  }
  const mediaType = match[1];
  const ext = match[2] === 'jpeg' ? 'jpg' : match[2];
  const base64Data = match[3];
  const buf = Buffer.from(base64Data, 'base64');
  if (buf.length > 5 * 1024 * 1024) {
    return res.status(400).json({ error: 'Image too large (>5MB)' });
  }
  const imageId = crypto.randomUUID().slice(0, 12);
  const dir = path.join(IMAGES_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const filename = imageId + '.' + ext;
  fs.writeFileSync(path.join(dir, filename), buf);
  res.json({ imageId, filename, mediaType, url: '/api/images/' + sessionId + '/' + filename });
});

app.get('/api/images/:sessionId/:filename', requireAuth, (req, res) => {
  if (!/^[a-f0-9-]+$/.test(req.params.sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  const filePath = path.resolve(IMAGES_DIR, req.params.sessionId, req.params.filename);
  if (!filePath.startsWith(IMAGES_DIR + path.sep)) {
    return res.status(403).json({ error: 'Forbidden path' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Image not found' });
  }
  res.sendFile(filePath);
});

// ─── API ───────────────────────────────────────────

app.get('/api/projects', requireAuth, (req, res) => {
  try {
    const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.join(PROJECTS_DIR, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ baseDir: PROJECTS_DIR, projects: dirs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

app.get('/api/commands', requireAuth, (req, res) => {
  const projectDir = req.query.projectDir;
  if (projectDir) {
    const resolved = path.resolve(projectDir);
    if (!resolved.startsWith(PROJECTS_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }
  }
  // Built-in commands
  const builtins = [
    { name: '/work', desc: 'View project progress', pinned: true },
    { name: '/save', desc: 'Save session', pinned: true },
    { name: '/new', desc: 'New feature', pinned: true },
    { name: '/config', desc: 'View/edit config', pinned: true },
    { name: '/rc', desc: 'Remote connection' },
    { name: '/help', desc: 'Get help' },
    { name: '/compact', desc: 'Compact context' },
    { name: '/clear', desc: 'Clear history' },
    { name: '/init', desc: 'Init project CLAUDE.md' },
    { name: '/review', desc: 'Code review' },
    { name: '/cost', desc: 'View token usage' },
    { name: '/doctor', desc: 'Check environment' },
    { name: '/login', desc: 'Switch account' },
    { name: '/logout', desc: 'Log out' },
    { name: '/status', desc: 'View account status' },
    { name: '/permissions', desc: 'View permissions' },
  ];
  // Scan project custom commands
  const custom = [];
  if (projectDir) {
    const dir = projectDir.replace(/^~/, process.env.HOME);
    const cmdDir = path.join(dir, '.claude', 'commands');
    try {
      if (fs.existsSync(cmdDir)) {
        scanCommands(cmdDir, '', custom);
      }
    } catch {}
    // Global user commands
    const globalDir = path.join(process.env.HOME, '.claude', 'commands');
    try {
      if (fs.existsSync(globalDir)) {
        scanCommands(globalDir, '', custom);
      }
    } catch {}
  }
  res.json({ builtin: builtins, custom });
});

function scanCommands(dir, prefix, results) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      scanCommands(path.join(dir, e.name), prefix + e.name + ':', results);
    } else if (e.name.endsWith('.md')) {
      const name = '/' + prefix + e.name.replace('.md', '');
      // Read first line as description
      try {
        const first = fs.readFileSync(path.join(dir, e.name), 'utf-8').split('\n')[0];
        const desc = first.replace(/^#\s*/, '').trim() || name;
        results.push({ name, desc });
      } catch {
        results.push({ name, desc: name });
      }
    }
  }
}

app.post('/api/projects', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name || /[\/\\]/.test(name) || name === '.' || name === '..') {
    return res.status(400).json({ error: 'Invalid project name' });
  }
  const dir = path.join(PROJECTS_DIR, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    res.json({ name, path: dir });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Permission API (PreToolUse Hook long-polling) ──

const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);

app.post('/api/permission', requireAuth, (req, res) => {
  const { sessionId, tool, toolInput, toolUseId } = req.body;
  console.log(`[Permission] Request received: session=${sessionId}, tool=${tool}, id=${toolUseId}`);

  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ allowed: false, error: 'Session not found' });
  }

  const isInteractive = INTERACTIVE_TOOLS.has(tool);

  // Auto-approve previously allowed tools (skip for interactive tools)
  if (!isInteractive && session.approvedTools.has(tool)) {
    console.log(`[Permission] Auto-approved: session=${sessionId}, tool=${tool} (previously approved)`);
    broadcastSession(sessionId, {
      type: 'permission_auto_approved',
      sessionId, tool, toolUseId,
    });
    return res.json({ allowed: true });
  }

  // Longer timeout for AskUserQuestion (user needs thinking time)
  const timeoutMs = tool === 'AskUserQuestion' ? 180000 : 120000;

  const timeout = setTimeout(() => {
    session.pendingPermissions.delete(toolUseId);
    if (res.headersSent) return;
    res.json({ allowed: false, reason: 'timeout' });
  }, timeoutMs);

  session.pendingPermissions.set(toolUseId, {
    tool,
    input: toolInput,
    resolve: (result) => {
      clearTimeout(timeout);
      session.pendingPermissions.delete(toolUseId);
      if (res.headersSent) return;
      // Support both boolean and object {allowed, updatedInput}
      if (typeof result === 'object' && result !== null) {
        res.json(result);
      } else {
        res.json({ allowed: result });
      }
    },
  });

  // AskUserQuestion → question_request; others → permission_request
  const eventType = tool === 'AskUserQuestion' ? 'question_request' : 'permission_request';
  broadcastSession(sessionId, {
    type: eventType,
    sessionId,
    tool,
    input: toolInput,
    toolUseId,
  });
});

const server = http.createServer(app);

// ─── WebSocket Server ──────────────────────────────

const wss = new WebSocketServer({ server });

// ─── Server-side heartbeat (detect dead connections) ───
const HEARTBEAT_INTERVAL = 30000; // 30s ping interval
const HEARTBEAT_TIMEOUT = 10000;  // 10s to respond

const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('[WS] Heartbeat timeout, terminating connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

wss.on('close', () => clearInterval(heartbeatTimer));

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  ws.authenticated = false;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  // Disconnect if not authenticated within 10s
  const authTimeout = setTimeout(() => {
    if (!ws.authenticated) {
      console.log('[WS] Auth timeout, disconnecting');
      ws.close(4001, 'Auth timeout');
    }
  }, 10000);

  ws.on('message', (raw) => {
    console.log('[WS] Message received:', raw.toString().slice(0, 200));
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // First message must be auth
    if (!ws.authenticated) {
      if (msg.type === 'auth' && verifyToken(msg.token, BEARER_TOKEN)) {
        ws.authenticated = true;
        clearTimeout(authTimeout);
        console.log('[WS] Auth passed');
        ws.send(JSON.stringify({ type: 'sessions_list', sessions: listSessions() }));
        // Resend all pending permissions/questions on reconnect
        sessions.forEach((session) => {
          if (session.pendingPermissions.size > 0) {
            session.pendingPermissions.forEach((perm, toolUseId) => {
              if (perm.tool) {
                const eventType = perm.tool === 'AskUserQuestion' ? 'question_request' : 'permission_request';
                console.log(`[Permission] Resending pending: session=${session.id}, tool=${perm.tool}, id=${toolUseId}`);
                ws.send(JSON.stringify({
                  type: eventType,
                  sessionId: session.id,
                  tool: perm.tool,
                  input: perm.input,
                  toolUseId,
                }));
              }
            });
          }
        });
      } else {
        console.log('[WS] Auth failed, disconnecting');
        ws.close(4003, 'Auth failed');
      }
      return;
    }

    switch (msg.type) {
      case 'create': {
        const projectDir = msg.projectDir || process.env.HOME;
        const resolvedDir = path.resolve(projectDir);
        if (!resolvedDir.startsWith(PROJECTS_DIR) && resolvedDir !== process.env.HOME) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid project path' }));
          return;
        }
        const session = createSession(projectDir);
        if (session.error) {
          ws.send(JSON.stringify({ type: 'error', message: session.error }));
          return;
        }
        broadcast({
          type: 'session_created',
          sessionId: session.id,
          name: session.name,
          projectDir: session.projectDir,
        });
        startClaude(session.id);
        break;
      }
      case 'message': {
        if (!msg.sessionId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing sessionId' }));
          return;
        }
        sendToClaude(msg.sessionId, msg.text, msg.images, ws);
        break;
      }
      case 'abort': {
        if (!msg.sessionId) return;
        const abortSession = getSession(msg.sessionId);
        if (!abortSession || !abortSession.process) return;
        console.log(`[Claude] Aborting generation: ${msg.sessionId}`);
        const abortProc = abortSession.process;
        stopClaude(msg.sessionId);
        broadcastSession(msg.sessionId, { type: 'generation_aborted', sessionId: msg.sessionId });
        // Auto-resume after process exits
        abortProc.once('close', () => {
          const s = getSession(msg.sessionId);
          if (s && s.claudeSessionId) {
            resumeClaude(msg.sessionId);
          }
        });
        break;
      }
      case 'close': {
        // Stop process only, preserve session and history
        if (!msg.sessionId) return;
        stopClaude(msg.sessionId);
        broadcastSession(msg.sessionId, { type: 'session_status', sessionId: msg.sessionId, status: 'stopped' });
        break;
      }
      case 'delete': {
        // Delete session + message history completely
        if (!msg.sessionId) return;
        stopClaude(msg.sessionId);
        deleteSession(msg.sessionId);
        broadcast({ type: 'session_deleted', sessionId: msg.sessionId });
        break;
      }
      case 'resume': {
        if (!msg.sessionId) return;
        resumeClaude(msg.sessionId);
        break;
      }
      case 'get_history': {
        if (!msg.sessionId) return;
        const histSession = getSession(msg.sessionId);
        if (!histSession) return;
        const result = db.getEvents(msg.sessionId, {
          limit: msg.limit || 200,
          beforeId: msg.beforeId || null,
        });
        // Group events into messages by turn
        const messages = groupEventsIntoMessages(result.events);
        // Include minId for pagination (earliest DB id in returned events)
        const minId = result.events.length > 0 ? result.events[0].id : null;
        ws.send(JSON.stringify({
          type: 'history',
          sessionId: msg.sessionId,
          messages,
          hasMore: result.hasMore,
          minId,
          prepend: !!msg.beforeId,
          usage: histSession.usage,
          costUsd: histSession.costUsd,
          model: histSession.model,
        }));
        break;
      }
      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }
      case 'sync': {
        if (!msg.sessionId) return;
        const syncSession = getSession(msg.sessionId);
        if (!syncSession) break;
        const lastSeq = msg.lastSeq || 0;
        const buf = syncSession.replayBuffer;
        const bufferStart = buf.length > 0 ? buf[0].seq : syncSession.seq;
        const hasGap = lastSeq > 0 && lastSeq < bufferStart;
        let missed;
        if (hasGap) {
          // Fallback to SQLite when replayBuffer overflowed
          const dbEvents = db.getEventsSinceSeq(msg.sessionId, lastSeq);
          missed = dbEvents.map(e => ({
            type: e.type, sessionId: msg.sessionId, seq: e.seq, ts: e.ts,
            content: e.content, tool: e.tool_name, toolUseId: e.tool_use_id,
            input: e.tool_input ? JSON.parse(e.tool_input) : undefined,
            toolOutput: e.tool_output, isError: !!e.is_error,
          }));
        } else {
          missed = buf.filter(e => e.seq > lastSeq);
        }
        ws.send(JSON.stringify({
          type: 'sync_response',
          sessionId: msg.sessionId,
          events: missed,
          hasGap: false, // SQLite fallback means no gap anymore
          textBuffer: syncSession.serverTextBuffer || '',
          currentSeq: syncSession.seq,
        }));
        break;
      }
      case 'question_response': {
        if (!msg.sessionId) return;
        const qSession = getSession(msg.sessionId);
        const qPerm = qSession && qSession.pendingPermissions.get(msg.toolUseId);
        if (qPerm) {
          const updatedInput = { ...qPerm.input, answers: msg.answers };
          console.log(`[Question] User answered: tool_use_id=${msg.toolUseId}`);
          qPerm.resolve({ allowed: true, updatedInput });
          broadcastSession(msg.sessionId, {
            type: 'question_resolved',
            sessionId: msg.sessionId,
            toolUseId: msg.toolUseId,
            answers: msg.answers,
          });
        }
        break;
      }
      case 'permission_response': {
        if (!msg.sessionId) return;
        const session = getSession(msg.sessionId);
        var perm = session && session.pendingPermissions.get(msg.toolUseId);
        if (perm) {
          var allowed = msg.decision === 'allow' || msg.decision === 'allow_session';
          console.log(`[Permission] User decision: ${msg.decision}, tool_use_id=${msg.toolUseId}`);
          if (msg.decision === 'allow_session' && msg.tool) {
            session.approvedTools.add(msg.tool);
            console.log(`[Permission] Tool ${msg.tool} approved for session`);
          }
          perm.resolve(allowed);
          // Notify all clients to close permission dialog
          broadcastSession(msg.sessionId, {
            type: 'permission_resolved',
            sessionId: msg.sessionId,
            toolUseId: msg.toolUseId,
          });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
  });
});

// ─── Process Bridge ────────────────────────────────

function startClaude(sessionId) {
  const session = getSession(sessionId);
  if (!session) return;
  if (session.process) return;

  const projectDir = session.projectDir;
  console.log(`[Claude] Starting process, session: ${sessionId}, dir: ${projectDir}`);

  const env = { ...process.env };
  delete env.CLAUDE_CODE;
  env.CLIHUB_SESSION = sessionId;

  const proc = spawn('claude', [
    '-p',
    '--permission-mode', 'bypassPermissions',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
  ], {
    cwd: projectDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  session.process = proc;
  session.status = 'idle';
  broadcastSession(sessionId, { type: 'session_status', sessionId, status: 'idle' });

  // stdout: parse NDJSON line by line
  proc.stdout.on('data', (chunk) => {
    session.buffer += chunk.toString();
    const lines = session.buffer.split('\n');
    session.buffer = lines.pop(); // Keep incomplete last line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        handleClaudeEvent(event, sessionId);
      } catch {
        console.log(`[Claude:${sessionId} stdout]`, line);
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    console.error(`[Claude:${sessionId} stderr]`, chunk.toString());
  });

  proc.on('close', (code) => {
    console.log(`[Claude:${sessionId}] Process exited, code: ${code}`);
    session.process = null;
    session.status = 'stopped';
    broadcastSession(sessionId, { type: 'session_status', sessionId, status: 'stopped' });
  });

  proc.on('error', (err) => {
    console.error(`[Claude:${sessionId}] Process start failed:`, err.message);
    session.process = null;
    session.status = 'stopped';
    broadcastSession(sessionId, { type: 'error', sessionId, message: `Process start failed: ${err.message}` });
  });
}

function sendToClaude(sessionId, text, imageIds, senderWs) {
  const session = getSession(sessionId);
  if (!session || !session.process) {
    broadcastSession(sessionId, { type: 'error', sessionId, message: 'No active Claude process' });
    return;
  }

  let content;
  let persistContent;
  if (imageIds && imageIds.length > 0) {
    content = [];
    persistContent = [];
    for (const imageId of imageIds) {
      // Find image file (supports multiple extensions)
      const dir = path.join(IMAGES_DIR, sessionId);
      const files = fs.readdirSync(dir).filter(f => f.startsWith(imageId + '.'));
      if (!files.length) continue;
      const filename = files[0];
      const ext = path.extname(filename).slice(1);
      const mediaType = 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
      const buf = fs.readFileSync(path.join(dir, filename));
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') },
      });
      persistContent.push({ type: 'image', imageId, filename });
    }
    if (text) {
      content.push({ type: 'text', text });
      persistContent.push({ type: 'text', text });
    }
  } else {
    content = text;
    persistContent = text;
  }

  const msg = JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
  });

  session.status = 'thinking';
  broadcastSession(sessionId, { type: 'session_status', sessionId, status: 'thinking' });
  broadcastSession(sessionId, { type: 'user_message', sessionId, content: persistContent }, senderWs);
  session.process.stdin.write(msg + '\n');
  db.appendEvent(sessionId, {
    seq: session.seq,
    ts: Date.now(),
    type: 'user_message',
    content: typeof persistContent === 'string' ? persistContent : JSON.stringify(persistContent),
  });
  console.log(`[Claude:${sessionId} stdin] ${text ? (text.length > 80 ? text.substring(0, 80) + '...' : text) : '[images]'}${imageIds ? ' +' + imageIds.length + ' images' : ''}`);
}

function stopClaude(sessionId) {
  const session = getSession(sessionId);
  if (session && session.process) {
    const proc = session.process;
    session.status = 'stopped';
    proc.kill('SIGTERM');
    // SIGKILL fallback after 5 seconds
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (e) { /* already dead */ }
    }, 5000);
  }
}

function resumeClaude(sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    broadcastSession(sessionId, { type: 'error', sessionId, message: 'Session not found' });
    return;
  }
  if (session.process) {
    broadcastSession(sessionId, { type: 'error', sessionId, message: 'Session already running' });
    return;
  }
  if (!session.claudeSessionId) {
    broadcastSession(sessionId, { type: 'error', sessionId, message: 'Cannot resume: no claude session ID' });
    return;
  }

  console.log(`[Claude] Resuming session: ${sessionId}, claude session: ${session.claudeSessionId}`);

  const env = { ...process.env };
  delete env.CLAUDE_CODE;
  env.CLIHUB_SESSION = sessionId;

  const proc = spawn('claude', [
    '-p',
    '--permission-mode', 'bypassPermissions',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--resume', session.claudeSessionId,
  ], {
    cwd: session.projectDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  session.process = proc;
  session.status = 'idle';
  session.buffer = '';
  broadcastSession(sessionId, { type: 'session_status', sessionId, status: 'idle' });

  proc.stdout.on('data', (chunk) => {
    session.buffer += chunk.toString();
    const lines = session.buffer.split('\n');
    session.buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        handleClaudeEvent(event, sessionId);
      } catch {
        console.log(`[Claude:${sessionId} stdout]`, line);
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    console.error(`[Claude:${sessionId} stderr]`, chunk.toString());
  });

  proc.on('close', (code) => {
    console.log(`[Claude:${sessionId}] Resume process exited, code: ${code}`);
    session.process = null;
    session.status = 'stopped';
    broadcastSession(sessionId, { type: 'session_status', sessionId, status: 'stopped' });
  });

  proc.on('error', (err) => {
    console.error(`[Claude:${sessionId}] Resume process failed:`, err.message);
    session.process = null;
    session.status = 'stopped';
    broadcastSession(sessionId, { type: 'error', sessionId, message: `Resume failed: ${err.message}` });
  });
}

// ─── Event routing ────────────────────────────────

function handleClaudeEvent(event, sessionId) {
  const session = getSession(sessionId);

  if (event.type === 'stream_event') {
    const e = event.event;

    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
      if (session) session.serverTextBuffer += e.delta.text;
      broadcastSession(sessionId, { type: 'text_delta', sessionId, text: e.delta.text });
    } else if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') {
      if (session) session.thinkingBuffer = (session.thinkingBuffer || '') + e.delta.thinking;
      broadcastSession(sessionId, { type: 'thinking_delta', sessionId, text: e.delta.thinking });
    } else if (e.type === 'content_block_start') {
      if (session && e.content_block) {
        session.currentBlockType = e.content_block.type;
      }
      if (e.content_block && e.content_block.type === 'thinking') {
        broadcastSession(sessionId, { type: 'thinking_start', sessionId });
      }
      broadcastSession(sessionId, { type: 'block_start', sessionId, block: e.content_block });
    } else if (e.type === 'content_block_stop') {
      // Flush accumulated text/thinking to SQLite on block boundary
      if (session) {
        if (session.currentBlockType === 'thinking' && session.thinkingBuffer) {
          db.appendEvent(sessionId, {
            seq: session.seq, ts: Date.now(), type: 'thinking',
            content: session.thinkingBuffer,
          });
          session.thinkingBuffer = '';
        } else if (session.currentBlockType === 'text' && session.serverTextBuffer) {
          db.appendEvent(sessionId, {
            seq: session.seq, ts: Date.now(), type: 'text',
            content: session.serverTextBuffer,
          });
          // Keep serverTextBuffer for sync (cleared on message_start)
        }
        session.currentBlockType = null;
      }
      broadcastSession(sessionId, { type: 'block_stop', sessionId });
    } else if (e.type === 'message_start') {
      if (session) {
        session.serverTextBuffer = '';
        session.thinkingBuffer = '';
        session.turnIndex = (session.turnIndex || 0) + 1;
      }
      broadcastSession(sessionId, { type: 'message_start', sessionId });
    } else if (e.type === 'message_stop') {
      // Write turn_end marker to SQLite
      if (session) {
        db.appendEvent(sessionId, {
          seq: session.seq, ts: Date.now(), type: 'turn_end',
        });
        saveSessionMeta(session);
      }
      broadcastSession(sessionId, { type: 'message_end', sessionId });
    }
  } else if (event.type === 'assistant') {
    // Full message snapshot — extract tool_use
    const content = event.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          // Store full tool_use to SQLite (no truncation)
          db.appendEvent(sessionId, {
            seq: session ? session.seq : 0, ts: Date.now(), type: 'tool_use',
            toolName: block.name,
            toolUseId: block.id,
            toolInput: JSON.stringify(block.input),
          });
          broadcastSession(sessionId, {
            type: 'tool_use',
            sessionId,
            tool: block.name,
            input: block.input,
            toolUseId: block.id,
          });
        }
      }
    }
  } else if (event.type === 'user') {
    // tool_result — CLI auto-executed result
    const content = event.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          const output = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
          // Store full tool_result to SQLite (no truncation, db.js handles 100KB limit)
          db.appendEvent(sessionId, {
            seq: session ? session.seq : 0, ts: Date.now(), type: 'tool_result',
            toolUseId: block.tool_use_id,
            toolOutput: output,
            isError: !!block.is_error,
          });
          broadcastSession(sessionId, {
            type: 'tool_result',
            sessionId,
            toolUseId: block.tool_use_id,
            content: block.content,
            isError: !!block.is_error,
          });
        }
      }
    }
  } else if (event.type === 'result') {
    const session = getSession(sessionId);
    if (session) {
      session.claudeSessionId = event.session_id;
      session.status = 'idle';
      if (event.usage) {
        // Replace (not accumulate) — these represent current context window size, not increments
        session.usage.input_tokens = event.usage.input_tokens || 0;
        session.usage.output_tokens = event.usage.output_tokens || 0;
        session.usage.cache_creation_input_tokens = event.usage.cache_creation_input_tokens || 0;
        session.usage.cache_read_input_tokens = event.usage.cache_read_input_tokens || 0;
      }
      if (event.cost_usd != null) {
        session.costUsd = (session.costUsd || 0) + event.cost_usd;
      }
      if (event.model) session.model = event.model;
      saveSessionMeta(session);
    }
    broadcastSession(sessionId, {
      type: 'result',
      sessionId,
      claudeSessionId: event.session_id,
      usage: event.usage,
      totalUsage: session ? session.usage : null,
      costUsd: session ? session.costUsd : null,
      model: session ? session.model : null,
    });
  }
}

// Broadcast to all authenticated clients, excludeWs optional (exclude sender)
function broadcast(msg, excludeWs) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === 1 && client.authenticated && client !== excludeWs) {
      client.send(data);
    }
  });
}

// Broadcast session event with sequence number + replay buffer
const REPLAY_BUFFER_SIZE = 500;

function broadcastSession(sessionId, msg, excludeWs) {
  const session = getSession(sessionId);
  if (!session) return broadcast(msg, excludeWs);

  msg.seq = ++session.seq;

  session.replayBuffer.push(msg);
  if (session.replayBuffer.length > REPLAY_BUFFER_SIZE) {
    session.replayBuffer.shift();
  }

  broadcast(msg, excludeWs);

  // Notify Telegram
  telegram.onSessionEvent(sessionId, msg);
}

// ─── Telegram session manager interface ──────────────

const telegramManager = {
  getSession(sessionId) {
    const s = getSession(sessionId);
    if (!s) return null;
    return { id: s.id, name: s.name, status: s.status, projectDir: s.projectDir, model: s.model, costUsd: s.costUsd };
  },
  listSessions,
  listProjects() {
    try {
      const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({ name: e.name, path: path.join(PROJECTS_DIR, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch { return []; }
  },
  createAndStart(projectName) {
    const projectDir = path.join(PROJECTS_DIR, projectName);
    if (!fs.existsSync(projectDir)) {
      return { error: `项目目录不存在: ${projectName}` };
    }
    const session = createSession(projectDir);
    startClaude(session.id);
    return { sessionId: session.id, name: session.name };
  },
  sendMessage(sessionId, text) {
    sendToClaude(sessionId, text, null, null);
  },
  stopSession(sessionId) {
    stopClaude(sessionId);
    broadcastSession(sessionId, { type: 'session_status', sessionId, status: 'stopped' });
  },
  resumeSession(sessionId) {
    resumeClaude(sessionId);
  },
  resolvePermission(sessionId, toolUseId, allowed) {
    const session = getSession(sessionId);
    if (!session) return false;
    const perm = session.pendingPermissions.get(toolUseId);
    if (!perm) return false;
    perm.resolve(allowed);
    broadcastSession(sessionId, { type: 'permission_resolved', sessionId, toolUseId });
    return true;
  },
  resolveQuestion(sessionId, toolUseId, answerIdx) {
    const session = getSession(sessionId);
    if (!session) return false;
    const perm = session.pendingPermissions.get(toolUseId);
    if (!perm || !perm.input) return false;
    const options = perm.input.options || [];
    const answer = options[answerIdx];
    const updatedInput = { ...perm.input, answers: [typeof answer === 'string' ? answer : answer?.value || String(answerIdx)] };
    perm.resolve({ allowed: true, updatedInput });
    broadcastSession(sessionId, { type: 'question_resolved', sessionId, toolUseId });
    return true;
  },
};

// ─── Start ──────────────────────────────────────────

restoreSessions();
telegram.init(telegramManager);

process.on('uncaughtException', (err) => {
  console.error('[Fatal] Uncaught exception:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Fatal] Unhandled rejection:', reason);
});

server.listen(PORT, () => {
  console.log(`[Server] CliHub running at http://localhost:${PORT}`);
});
