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

const PORT = process.env.PORT || 5678;
const PROJECTS_DIR = (process.env.PROJECTS_DIR || '~/Documents/Project').replace(/^~/, process.env.HOME);


// ─── Auth ─────────────────────────────────────────
const BEARER_TOKEN = process.env.BEARER_TOKEN;
const HOOK_TOKEN = process.env.HOOK_TOKEN || BEARER_TOKEN;
if (!BEARER_TOKEN) {
  console.error('Error: BEARER_TOKEN environment variable is required');
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

// ─── Message persistence (NDJSON) ─────────────────
const DATA_DIR = path.join(__dirname, 'data', 'sessions');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Image storage ───────────────────────────────
const IMAGES_DIR = path.join(__dirname, 'data', 'images');
fs.mkdirSync(IMAGES_DIR, { recursive: true });

function appendMessage(sessionId, role, content) {
  const file = path.join(DATA_DIR, sessionId + '.ndjson');
  const line = JSON.stringify({ role, content, ts: Date.now() }) + '\n';
  fs.appendFileSync(file, line);
}

function readHistory(sessionId, opts) {
  const file = path.join(DATA_DIR, sessionId + '.ndjson');
  try {
    const data = fs.readFileSync(file, 'utf-8');
    let all = data.trim().split('\n').filter(Boolean).map(JSON.parse);
    if (!opts) return all;
    if (opts.before) {
      all = all.filter(m => (m.ts || 0) < opts.before);
    }
    const limit = opts.limit || 50;
    const hasMore = all.length > limit;
    return { messages: all.slice(-limit), hasMore };
  } catch {
    return opts ? { messages: [], hasMore: false } : [];
  }
}

function deleteHistory(sessionId) {
  const file = path.join(DATA_DIR, sessionId + '.ndjson');
  try { fs.unlinkSync(file); } catch {}
  const meta = path.join(DATA_DIR, sessionId + '.json');
  try { fs.unlinkSync(meta); } catch {}
  // Clean up image directory
  const imgDir = path.join(IMAGES_DIR, sessionId);
  try { fs.rmSync(imgDir, { recursive: true }); } catch {}
}

function saveSessionMeta(session) {
  const file = path.join(DATA_DIR, session.id + '.json');
  const data = {
    id: session.id,
    name: session.name,
    projectDir: session.projectDir,
    claudeSessionId: session.claudeSessionId,
    createdAt: session.createdAt,
    usage: session.usage,
    costUsd: session.costUsd || 0,
    model: session.model || null,
  };
  fs.writeFileSync(file, JSON.stringify(data));
}

function restoreSessions() {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
        const session = {
          id: data.id,
          name: data.name,
          process: null,
          projectDir: data.projectDir,
          status: 'stopped',
          claudeSessionId: data.claudeSessionId || null,
          pendingPermissions: new Map(),
          approvedTools: new Set(),
          buffer: '',
          serverTextBuffer: '',
          createdAt: data.createdAt || Date.now(),
          usage: data.usage || { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          costUsd: data.costUsd || 0,
          model: data.model || null,
        };
        sessions.set(session.id, session);
        console.log(`[Restore] Session restored: ${session.id} (${session.name})`);
      } catch {}
    }
  } catch {}
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
    createdAt: Date.now(),
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    costUsd: 0,
    model: null,
  };
  sessions.set(id, session);
  saveSessionMeta(session);
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
  deleteHistory(sessionId);
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
    "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; " +
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
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/commands', requireAuth, (req, res) => {
  const projectDir = req.query.projectDir;
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
  if (!name || /[\/\\]/.test(name)) {
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

app.post('/api/permission', requireAuth, (req, res) => {
  const { sessionId, tool, toolInput, toolUseId } = req.body;
  console.log(`[Permission] Request received: session=${sessionId}, tool=${tool}, id=${toolUseId}`);

  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ allowed: false, error: 'Session not found' });
  }

  // Auto-approve previously allowed tools
  if (session.approvedTools.has(tool)) {
    console.log(`[Permission] Auto-approved: session=${sessionId}, tool=${tool} (previously approved)`);
    return res.json({ allowed: true });
  }

  // Store resolve callback, wait for frontend decision
  const timeout = setTimeout(() => {
    session.pendingPermissions.delete(toolUseId);
    res.json({ allowed: false, reason: 'timeout' });
  }, 120000); // 2-minute timeout auto-deny

  session.pendingPermissions.set(toolUseId, {
    tool,
    input: toolInput,
    resolve: (allowed) => {
      clearTimeout(timeout);
      session.pendingPermissions.delete(toolUseId);
      res.json({ allowed });
    },
  });

  // Notify frontend to show permission dialog
  broadcast({
    type: 'permission_request',
    sessionId,
    tool,
    input: toolInput,
    toolUseId,
  });
});

const server = http.createServer(app);

// ─── WebSocket Server ──────────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  ws.authenticated = false;

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
        // Resend all pending permissions on reconnect
        sessions.forEach((session) => {
          if (session.pendingPermissions.size > 0) {
            session.pendingPermissions.forEach((perm, toolUseId) => {
              if (perm.tool) {
                console.log(`[Permission] Resending pending: session=${session.id}, tool=${perm.tool}, id=${toolUseId}`);
                ws.send(JSON.stringify({
                  type: 'permission_request',
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
      case 'close': {
        // Stop process only, preserve session and history
        if (!msg.sessionId) return;
        stopClaude(msg.sessionId);
        broadcast({ type: 'session_status', sessionId: msg.sessionId, status: 'stopped' });
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
        const result = readHistory(msg.sessionId, { limit: msg.limit || 50, before: msg.before || null });
        ws.send(JSON.stringify({
          type: 'history',
          sessionId: msg.sessionId,
          messages: result.messages,
          hasMore: result.hasMore,
          prepend: !!msg.before,
          usage: histSession ? histSession.usage : null,
          costUsd: histSession ? histSession.costUsd : null,
          model: histSession ? histSession.model : null,
        }));
        break;
      }
      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }));
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
          broadcast({
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
  broadcast({ type: 'session_status', sessionId, status: 'idle' });

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
    broadcast({ type: 'session_status', sessionId, status: 'stopped' });
  });

  proc.on('error', (err) => {
    console.error(`[Claude:${sessionId}] Process start failed:`, err.message);
    session.process = null;
    session.status = 'stopped';
    broadcast({ type: 'error', sessionId, message: `Process start failed: ${err.message}` });
  });
}

function sendToClaude(sessionId, text, imageIds, senderWs) {
  const session = getSession(sessionId);
  if (!session || !session.process) {
    broadcast({ type: 'error', sessionId, message: 'No active Claude process' });
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
  broadcast({ type: 'session_status', sessionId, status: 'thinking' });
  broadcast({ type: 'user_message', sessionId, content: persistContent }, senderWs);
  session.process.stdin.write(msg + '\n');
  appendMessage(sessionId, 'user', persistContent);
  console.log(`[Claude:${sessionId} stdin] ${text ? (text.length > 80 ? text.substring(0, 80) + '...' : text) : '[images]'}${imageIds ? ' +' + imageIds.length + ' images' : ''}`);
}

function stopClaude(sessionId) {
  const session = getSession(sessionId);
  if (session && session.process) {
    session.process.kill('SIGTERM');
    session.process = null;
    session.status = 'stopped';
  }
}

function resumeClaude(sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    broadcast({ type: 'error', sessionId, message: 'Session not found' });
    return;
  }
  if (session.process) {
    broadcast({ type: 'error', sessionId, message: 'Session already running' });
    return;
  }
  if (!session.claudeSessionId) {
    broadcast({ type: 'error', sessionId, message: 'Cannot resume: no claude session ID' });
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
  broadcast({ type: 'session_status', sessionId, status: 'idle' });

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
    broadcast({ type: 'session_status', sessionId, status: 'stopped' });
  });

  proc.on('error', (err) => {
    console.error(`[Claude:${sessionId}] Resume process failed:`, err.message);
    session.process = null;
    session.status = 'stopped';
    broadcast({ type: 'error', sessionId, message: `Resume failed: ${err.message}` });
  });
}

// ─── Event routing ────────────────────────────────

function escapeHTML(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function handleClaudeEvent(event, sessionId) {
  const session = getSession(sessionId);

  if (event.type === 'stream_event') {
    const e = event.event;

    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
      if (session) session.serverTextBuffer += e.delta.text;
      broadcast({ type: 'text_delta', sessionId, text: e.delta.text });
    } else if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') {
      broadcast({ type: 'thinking_delta', sessionId, text: e.delta.thinking });
    } else if (e.type === 'content_block_start') {
      if (session && e.content_block && e.content_block.type === 'tool_use') {
        session.serverTextBuffer += '\n\n> **Tool call**: `' + escapeHTML(e.content_block.name) + '`\n';
      }
      if (e.content_block && e.content_block.type === 'thinking') {
        broadcast({ type: 'thinking_start', sessionId });
      }
      broadcast({ type: 'block_start', sessionId, block: e.content_block });
    } else if (e.type === 'content_block_stop') {
      broadcast({ type: 'block_stop', sessionId });
    } else if (e.type === 'message_start') {
      if (session) session.serverTextBuffer = '';
      broadcast({ type: 'message_start', sessionId });
    } else if (e.type === 'message_stop') {
      // Persist assistant message
      if (session && session.serverTextBuffer) {
        appendMessage(sessionId, 'assistant', session.serverTextBuffer);
      }
      broadcast({ type: 'message_end', sessionId });
    }
  } else if (event.type === 'assistant') {
    // Full message snapshot — extract tool_use
    const content = event.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          // Track tool_use info
          if (session) {
            session.serverTextBuffer += '\n\n> **' + escapeHTML(block.name) + '** `' + escapeHTML(JSON.stringify(block.input).slice(0, 100)) + '`\n';
          }
          broadcast({
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
          // Track tool_result info
          if (session) {
            const output = typeof block.content === 'string'
              ? block.content.slice(0, 200)
              : JSON.stringify(block.content).slice(0, 200);
            const prefix = block.is_error ? '**Error**' : '**Result**';
            session.serverTextBuffer += '\n> ' + prefix + ': `' + escapeHTML(output) + '`\n';
          }
          broadcast({
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
        session.usage.input_tokens += (event.usage.input_tokens || 0);
        session.usage.output_tokens += (event.usage.output_tokens || 0);
        session.usage.cache_creation_input_tokens += (event.usage.cache_creation_input_tokens || 0);
        session.usage.cache_read_input_tokens += (event.usage.cache_read_input_tokens || 0);
      }
      if (event.cost_usd != null) {
        session.costUsd = (session.costUsd || 0) + event.cost_usd;
      }
      if (event.model) session.model = event.model;
      saveSessionMeta(session);
    }
    broadcast({
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

// ─── Start ──────────────────────────────────────────

restoreSessions();

server.listen(PORT, () => {
  console.log(`[Server] CliHub running at http://localhost:${PORT}`);
});
