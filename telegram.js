// input: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS env vars
// output: Telegram Bot interface for CliHub sessions
// pos: optional transport layer, parallel to WebSocket frontend

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const IMAGES_DIR = path.join(__dirname, 'data', 'images');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALLOWED_USERS = (process.env.TELEGRAM_ALLOWED_USERS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// ─── Streaming config ────────────────────────────────
const STREAM_EDIT_INTERVAL_MS = 3000;  // min interval between edit_message calls
const STREAM_MIN_CHARS = 40;           // min new chars before edit
const MAX_MESSAGE_LENGTH = 4000;       // Telegram limit ~4096, leave margin
const REPLAY_TOOL_MAX = 200;           // max chars for tool input preview

let bot = null;
let sessionManager = null;  // { getSession, listSessions, createSession, ... }

// Sanitize error messages to prevent token leakage in logs
function sanitizeError(err) {
  const msg = err && (err.message || String(err));
  if (!msg || !TELEGRAM_BOT_TOKEN) return msg;
  return msg.split(TELEGRAM_BOT_TOKEN).join('***');
}

// Per-chat state
// chatId → { activeSessionId, streamMsg, streamBuffer, streamLastEdit, streamTimer, isTopicGroup }
const chatStates = new Map();

function getChatState(chatId) {
  if (!chatStates.has(chatId)) {
    chatStates.set(chatId, {
      activeSessionId: null,
      streamMsg: null,          // current Telegram message being streamed to
      streamBuffer: '',         // accumulated text not yet sent
      streamLastEdit: 0,        // timestamp of last edit
      streamTimer: null,        // throttle timer
      streamFinalized: false,   // whether current stream is done
      topicId: null,            // message_thread_id for topic groups
    });
  }
  return chatStates.get(chatId);
}

// Topic mode: sessionId → { chatId, topicId }
const topicSessions = new Map();
// Reverse: "chatId:topicId" → sessionId
const topicToSession = new Map();

function isAllowed(userId) {
  if (TELEGRAM_ALLOWED_USERS.length === 0) return false;  // No whitelist = deny all
  return TELEGRAM_ALLOWED_USERS.includes(String(userId));
}

// ─── Initialize ──────────────────────────────────────

function init(manager) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[Telegram] No TELEGRAM_BOT_TOKEN set, Telegram integration disabled');
    return null;
  }

  const TelegramBot = require('node-telegram-bot-api');
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
    polling: {
      interval: 1000,
      autoStart: true,
      params: { timeout: 30 },
    },
    request: { timeout: 40000 },
  });
  sessionManager = manager;

  if (TELEGRAM_ALLOWED_USERS.length === 0) {
    console.warn('[Telegram] WARNING: TELEGRAM_ALLOWED_USERS is empty. All users will be denied. Set allowed user IDs in .env');
  } else {
    console.log(`[Telegram] Allowed users (${TELEGRAM_ALLOWED_USERS.length}): ${TELEGRAM_ALLOWED_USERS.join(', ')}`);
  }

  console.log('[Telegram] Bot starting...');

  bot.on('polling_error', (err) => {
    // Suppress 409 conflict (another instance running)
    if (err.code === 'ETELEGRAM' && err.response?.statusCode === 409) {
      console.error('[Telegram] Another bot instance is running. Stopping polling.');
      bot.stopPolling();
      return;
    }
    // Auto-reconnect on network errors
    const isNetwork = err.code === 'EFATAL' || err.message?.includes('ETIMEDOUT') || err.message?.includes('ESOCKETTIMEDOUT') || err.message?.includes('socket hang up');
    if (isNetwork) {
      console.error('[Telegram] Network polling error, reconnecting in 5s...', err.message);
      bot.stopPolling();
      setTimeout(() => {
        bot.startPolling();
        console.log('[Telegram] Polling restarted');
      }, 5000);
      return;
    }
    console.error('[Telegram] Polling error:', sanitizeError(err));
  });

  // 注册命令菜单（输入 / 时弹出列表）
  bot.setMyCommands([
    { command: 'new', description: '创建新会话' },
    { command: 'list', description: '列出所有会话' },
    { command: 'switch', description: '切换会话' },
    { command: 'stop', description: '停止当前会话' },
    { command: 'resume', description: '恢复当前会话' },
    { command: 'status', description: '查看当前状态' },
    { command: 'start', description: '显示帮助' },
  ]);

  // ─── Commands ────────────────────────────────────

  bot.onText(/^\/start$/, (msg) => {
    if (!isAllowed(msg.from.id)) return;
    const chatId = msg.chat.id;
    send(chatId, '🤖 CliHub Telegram 已连接。\n\n命令：\n/new [项目名] - 创建会话\n/list - 列出会话\n/switch [id] - 切换会话\n/stop - 停止当前会话\n/resume - 恢复当前会话\n/status - 当前状态', msg.message_thread_id);
  });

  bot.onText(/^\/new(?:\s+(.+))?$/, (msg, match) => {
    if (!isAllowed(msg.from.id)) return;
    const chatId = msg.chat.id;
    const threadId = msg.message_thread_id;
    const projectName = match[1]?.trim();

    if (!projectName) {
      // List available projects
      const projects = sessionManager.listProjects();
      if (projects.length === 0) {
        send(chatId, '没有找到项目目录。', threadId);
        return;
      }
      const buttons = projects.map(p => ([{
        text: p.name,
        callback_data: `new:${p.name}`,
      }]));
      bot.sendMessage(chatId, '选择项目：', {
        message_thread_id: threadId,
        reply_markup: { inline_keyboard: buttons },
      });
      return;
    }

    const result = sessionManager.createAndStart(projectName);
    if (result.error) {
      send(chatId, `❌ ${result.error}`, threadId);
      return;
    }

    const state = getChatState(chatId);
    state.activeSessionId = result.sessionId;

    // If in topic group, map this topic to the session
    if (threadId) {
      topicSessions.set(result.sessionId, { chatId, topicId: threadId });
      topicToSession.set(`${chatId}:${threadId}`, result.sessionId);
    }

    send(chatId, `✅ 会话已创建: ${result.name} [${result.sessionId}]`, threadId);
  });

  bot.onText(/^\/list$/, (msg) => {
    if (!isAllowed(msg.from.id)) return;
    const chatId = msg.chat.id;
    const sessions = sessionManager.listSessions();
    if (sessions.length === 0) {
      send(chatId, '没有活跃会话。', msg.message_thread_id);
      return;
    }
    const state = getChatState(chatId);
    const lines = sessions.map(s => {
      const active = s.id === state.activeSessionId ? ' 👈' : '';
      const status = s.status === 'thinking' ? '🔄' : s.status === 'idle' ? '🟢' : '⏹️';
      return `${status} \`${s.id}\` ${s.name}${active}`;
    });
    send(chatId, lines.join('\n'), msg.message_thread_id, 'Markdown');
  });

  bot.onText(/^\/switch(?:\s+(.+))?$/, (msg, match) => {
    if (!isAllowed(msg.from.id)) return;
    const chatId = msg.chat.id;
    const sessionId = match[1]?.trim();

    if (!sessionId) {
      // Show inline keyboard to pick session
      const sessions = sessionManager.listSessions();
      if (sessions.length === 0) {
        send(chatId, '没有活跃会话。', msg.message_thread_id);
        return;
      }
      const buttons = sessions.map(s => ([{
        text: `${s.status === 'thinking' ? '🔄' : s.status === 'idle' ? '🟢' : '⏹️'} ${s.name} [${s.id}]`,
        callback_data: `switch:${s.id}`,
      }]));
      bot.sendMessage(chatId, '选择会话：', {
        message_thread_id: msg.message_thread_id,
        reply_markup: { inline_keyboard: buttons },
      });
      return;
    }

    const session = sessionManager.getSession(sessionId);
    if (!session) {
      send(chatId, `❌ 会话不存在: ${sessionId}`, msg.message_thread_id);
      return;
    }
    const state = getChatState(chatId);
    state.activeSessionId = sessionId;
    send(chatId, `已切换到: ${session.name} [${sessionId}]`, msg.message_thread_id);
  });

  bot.onText(/^\/stop$/, (msg) => {
    if (!isAllowed(msg.from.id)) return;
    const chatId = msg.chat.id;
    const sessionId = resolveSessionId(chatId, msg.message_thread_id);
    if (!sessionId) {
      send(chatId, '没有活跃会话。用 /list 查看。', msg.message_thread_id);
      return;
    }
    sessionManager.stopSession(sessionId);
    send(chatId, `⏹️ 会话已停止: ${sessionId}`, msg.message_thread_id);
  });

  bot.onText(/^\/resume$/, (msg) => {
    if (!isAllowed(msg.from.id)) return;
    const chatId = msg.chat.id;
    const sessionId = resolveSessionId(chatId, msg.message_thread_id);
    if (!sessionId) {
      send(chatId, '没有活跃会话。用 /list 查看。', msg.message_thread_id);
      return;
    }
    sessionManager.resumeSession(sessionId);
    send(chatId, `▶️ 恢复会话: ${sessionId}`, msg.message_thread_id);
  });

  bot.onText(/^\/status$/, (msg) => {
    if (!isAllowed(msg.from.id)) return;
    const chatId = msg.chat.id;
    const sessionId = resolveSessionId(chatId, msg.message_thread_id);
    if (!sessionId) {
      send(chatId, '没有活跃会话。', msg.message_thread_id);
      return;
    }
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      send(chatId, '会话不存在。', msg.message_thread_id);
      return;
    }
    const statusIcon = session.status === 'thinking' ? '🔄' : session.status === 'idle' ? '🟢' : '⏹️';
    const lines = [
      `${statusIcon} ${session.name} [${session.id}]`,
      `状态: ${session.status}`,
      `目录: ${session.projectDir}`,
      `模型: ${session.model || 'unknown'}`,
      `费用: $${(session.costUsd || 0).toFixed(4)}`,
    ];
    send(chatId, lines.join('\n'), msg.message_thread_id);
  });

  // ─── Callback queries (inline keyboard) ──────────

  bot.on('callback_query', async (query) => {
    if (!isAllowed(query.from.id)) return;
    const chatId = query.message.chat.id;
    const threadId = query.message.message_thread_id;
    const data = query.data;

    if (data.startsWith('new:')) {
      const projectName = data.slice(4);
      const result = sessionManager.createAndStart(projectName);
      if (result.error) {
        bot.answerCallbackQuery(query.id, { text: result.error });
        return;
      }
      const state = getChatState(chatId);
      state.activeSessionId = result.sessionId;
      if (threadId) {
        topicSessions.set(result.sessionId, { chatId, topicId: threadId });
        topicToSession.set(`${chatId}:${threadId}`, result.sessionId);
      }
      bot.answerCallbackQuery(query.id, { text: `已创建: ${result.name}` });
      bot.editMessageText(`✅ 会话已创建: ${result.name} [${result.sessionId}]`, {
        chat_id: chatId,
        message_id: query.message.message_id,
      });
    } else if (data.startsWith('switch:')) {
      const sessionId = data.slice(7);
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        bot.answerCallbackQuery(query.id, { text: '会话不存在' });
        return;
      }
      const state = getChatState(chatId);
      state.activeSessionId = sessionId;
      bot.answerCallbackQuery(query.id, { text: `已切换到 ${session.name}` });
      bot.editMessageText(`已切换到: ${session.name} [${sessionId}]`, {
        chat_id: chatId,
        message_id: query.message.message_id,
      });
    } else if (data.startsWith('perm:')) {
      // perm:allow:sessionId:toolUseId or perm:deny:sessionId:toolUseId
      const parts = data.split(':');
      const decision = parts[1];  // allow or deny
      const sessionId = parts[2];
      const toolUseId = parts.slice(3).join(':');  // toolUseId may contain colons
      const allowed = decision === 'allow';
      const resolved = sessionManager.resolvePermission(sessionId, toolUseId, allowed);
      if (resolved) {
        bot.answerCallbackQuery(query.id, { text: allowed ? '✅ 已批准' : '❌ 已拒绝' });
        bot.editMessageText(
          query.message.text + `\n\n${allowed ? '✅ 已批准' : '❌ 已拒绝'}`,
          { chat_id: chatId, message_id: query.message.message_id }
        );
      } else {
        bot.answerCallbackQuery(query.id, { text: '请求已过期' });
      }
    } else if (data.startsWith('q:')) {
      // q:sessionId:toolUseId:answerIndex
      const parts = data.split(':');
      const sessionId = parts[1];
      const toolUseId = parts[2];
      const answerIdx = parseInt(parts[3], 10);
      const resolved = sessionManager.resolveQuestion(sessionId, toolUseId, answerIdx);
      if (resolved) {
        bot.answerCallbackQuery(query.id, { text: '已回答' });
        bot.editMessageText(
          query.message.text + `\n\n✅ 已选择选项 ${answerIdx + 1}`,
          { chat_id: chatId, message_id: query.message.message_id }
        );
      } else {
        bot.answerCallbackQuery(query.id, { text: '请求已过期' });
      }
    }
  });

  // ─── Text & photo messages (forward to active session) ───

  bot.on('message', async (msg) => {
    // Skip commands
    if (msg.text && msg.text.startsWith('/')) return;
    if (!isAllowed(msg.from.id)) return;

    const hasPhoto = msg.photo && msg.photo.length > 0;
    const text = msg.text || msg.caption || '';
    console.log(`[Telegram] Message received: hasPhoto=${hasPhoto}, text=${text ? text.substring(0, 30) : '(none)'}, from=${msg.from.id}`);
    if (!hasPhoto && !text) return;

    const chatId = msg.chat.id;
    const threadId = msg.message_thread_id;
    const sessionId = resolveSessionId(chatId, threadId);

    if (!sessionId) {
      send(chatId, '没有活跃会话。用 /new 创建或 /switch 切换。', threadId);
      return;
    }

    const session = sessionManager.getSession(sessionId);
    if (!session) {
      send(chatId, '会话不存在。', threadId);
      return;
    }

    let imageIds = null;
    if (hasPhoto) {
      try {
        // Pick largest resolution
        const photo = msg.photo[msg.photo.length - 1];
        const fileLink = await bot.getFileLink(photo.file_id);
        const imageId = crypto.randomUUID().slice(0, 12);
        const dir = path.join(IMAGES_DIR, sessionId);
        fs.mkdirSync(dir, { recursive: true });
        const filename = imageId + '.jpg';
        const filePath = path.join(dir, filename);
        await downloadFile(fileLink, filePath);
        imageIds = [imageId];
      } catch (err) {
        console.error('[Telegram] Photo download error:', sanitizeError(err));
        send(chatId, '❌ 图片下载失败', threadId);
        return;
      }
    }

    if (session.status === 'stopped') {
      sessionManager.resumeSession(sessionId);
      setTimeout(() => {
        sessionManager.sendMessage(sessionId, text || null, imageIds);
      }, 1000);
      return;
    }

    sessionManager.sendMessage(sessionId, text || null, imageIds);
  });

  console.log('[Telegram] Bot initialized');
  return bot;
}

// ─── Download file from URL ──────────────────────────

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        downloadFile(res.headers.location, dest).then(resolve, reject);
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(resolve); });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// ─── Resolve session for chat ────────────────────────

function resolveSessionId(chatId, threadId) {
  // Topic mode: check topic → session mapping
  if (threadId) {
    const sessionId = topicToSession.get(`${chatId}:${threadId}`);
    if (sessionId) return sessionId;
  }
  // Private chat mode: use active session
  const state = getChatState(chatId);
  return state.activeSessionId;
}

// ─── Find chat targets for a session ─────────────────

function findChatsForSession(sessionId) {
  const targets = [];

  // Topic mode mapping
  const topic = topicSessions.get(sessionId);
  if (topic) {
    targets.push({ chatId: topic.chatId, threadId: topic.topicId });
  }

  // Private chat mode: any chat with this as active session
  for (const [chatId, state] of chatStates) {
    if (state.activeSessionId === sessionId) {
      // Avoid duplicate if already in topic targets
      if (!topic || topic.chatId !== chatId) {
        targets.push({ chatId, threadId: null });
      } else if (topic && topic.chatId === chatId && !topic.topicId) {
        // Same chat, no topic — already covered
      } else {
        targets.push({ chatId, threadId: null });
      }
    }
  }

  return targets;
}

// ─── Event handler (called from server.js) ───────────

function onSessionEvent(sessionId, event) {
  if (!bot) return;

  const targets = findChatsForSession(sessionId);
  if (targets.length === 0) return;

  for (const target of targets) {
    handleEventForChat(target.chatId, target.threadId, sessionId, event);
  }
}

function handleEventForChat(chatId, threadId, sessionId, event) {
  const state = getChatState(chatId);

  switch (event.type) {
    case 'message_start':
      // Reset streaming state
      state.streamMsg = null;
      state.streamBuffer = '';
      state.streamLastEdit = 0;
      state.streamFinalized = false;
      if (state.streamTimer) {
        clearTimeout(state.streamTimer);
        state.streamTimer = null;
      }
      break;

    case 'text_delta':
      state.streamBuffer += event.text;
      scheduleStreamUpdate(chatId, threadId);
      break;

    case 'thinking_start':
      // Optional: send a typing indicator
      bot.sendChatAction(chatId, 'typing').catch(() => {});
      break;

    case 'block_stop':
      // Flush remaining buffer
      flushStream(chatId, threadId, false);
      break;

    case 'message_end':
      // Finalize: flush and mark done
      flushStream(chatId, threadId, true);
      break;

    case 'tool_use': {
      const toolName = event.tool || 'unknown';
      const inputPreview = event.input
        ? truncate(typeof event.input === 'string' ? event.input : JSON.stringify(event.input), REPLAY_TOOL_MAX)
        : '';
      const text = `🔧 ${toolName}${inputPreview ? '\n' + inputPreview : ''}`;
      send(chatId, text, threadId);
      break;
    }

    case 'tool_result': {
      const content = typeof event.content === 'string'
        ? event.content
        : JSON.stringify(event.content);
      const preview = truncate(content || '', 500);
      if (preview) {
        const prefix = event.isError ? '❌ ' : '📎 ';
        send(chatId, prefix + preview, threadId);
      }
      break;
    }

    case 'permission_request': {
      const tool = event.tool;
      const input = event.input;
      const toolUseId = event.toolUseId;
      let text = `🔐 权限请求: ${tool}`;
      if (input) {
        const preview = truncate(
          typeof input === 'string' ? input : JSON.stringify(input),
          300
        );
        text += '\n' + preview;
      }
      const keyboard = {
        inline_keyboard: [[
          { text: '✅ 批准', callback_data: `perm:allow:${sessionId}:${toolUseId}` },
          { text: '❌ 拒绝', callback_data: `perm:deny:${sessionId}:${toolUseId}` },
        ]],
      };
      sendWithRetry(() => bot.sendMessage(chatId, text, {
        message_thread_id: threadId,
        reply_markup: keyboard,
      }), 'Send permission');
      break;
    }

    case 'question_request': {
      const input = event.input;
      const toolUseId = event.toolUseId;
      let text = '❓ ' + (input?.question || 'Claude 有个问题');
      if (input?.options && Array.isArray(input.options)) {
        const buttons = input.options.map((opt, i) => ([{
          text: typeof opt === 'string' ? opt : opt.label || `选项 ${i + 1}`,
          callback_data: `q:${sessionId}:${toolUseId}:${i}`,
        }]));
        sendWithRetry(() => bot.sendMessage(chatId, text, {
          message_thread_id: threadId,
          reply_markup: { inline_keyboard: buttons },
        }), 'Send question');
      } else {
        // Free text question — user just replies in chat
        send(chatId, text, threadId);
      }
      break;
    }

    case 'session_status': {
      const statusMap = { idle: '🟢 就绪', thinking: '🔄 思考中...', stopped: '⏹️ 已停止' };
      // Only notify on stop (thinking/idle transitions are too noisy)
      if (event.status === 'stopped') {
        send(chatId, statusMap[event.status] || event.status, threadId);
      }
      break;
    }

    case 'result': {
      const MODEL_CONTEXT = {
        'opus-4-6': 1000000, 'sonnet-4-6': 1000000,
        'haiku-4-5': 200000, 'opus-4': 200000, 'sonnet-4': 200000,
        'sonnet-3-5': 200000, 'haiku-3-5': 200000,
      };
      const model = event.model || '';
      const ctxMax = Object.entries(MODEL_CONTEXT).find(([k]) => model.includes(k))?.[1] || 200000;
      const u = event.totalUsage || event.usage;
      if (u) {
        const total = (u.input_tokens || 0) + (u.output_tokens || 0)
          + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        const pct = Math.round(total / ctxMax * 100);
        const cost = event.costUsd != null ? `$${event.costUsd.toFixed(4)}` : '';
        const bar = pct >= 80 ? '🔴' : pct >= 50 ? '🟡' : '🟢';
        send(chatId, `${bar} Context: ${pct}%${cost ? ' | ' + cost : ''}`, threadId);
      }
      break;
    }

    case 'error':
      send(chatId, `⚠️ ${event.message || 'Unknown error'}`, threadId);
      break;
  }
}

// ─── Streaming helpers ───────────────────────────────

function scheduleStreamUpdate(chatId, threadId) {
  const state = getChatState(chatId);
  if (state.streamTimer) return;  // already scheduled

  const elapsed = Date.now() - state.streamLastEdit;
  const delay = Math.max(0, STREAM_EDIT_INTERVAL_MS - elapsed);

  state.streamTimer = setTimeout(() => {
    state.streamTimer = null;
    flushStream(chatId, threadId, false);
  }, delay);
}

async function flushStream(chatId, threadId, finalize) {
  const state = getChatState(chatId);

  if (state.streamTimer) {
    clearTimeout(state.streamTimer);
    state.streamTimer = null;
  }

  if (state.streamFinalized) return;
  if (!state.streamBuffer && !finalize) return;

  const text = state.streamBuffer || '...';

  // Truncate if too long for a single message
  const displayText = finalize
    ? truncateEnd(text, MAX_MESSAGE_LENGTH)
    : truncateEnd(text, MAX_MESSAGE_LENGTH - 2) + ' ▌';

  try {
    if (!state.streamMsg) {
      // First chunk: send new message
      if (state.streamBuffer.length < STREAM_MIN_CHARS && !finalize) return;
      const sent = await bot.sendMessage(chatId, displayText, {
        message_thread_id: threadId,
      });
      state.streamMsg = sent;
      state.streamLastEdit = Date.now();
    } else {
      // Subsequent: edit existing message
      const newChars = state.streamBuffer.length - (state.streamMsg._lastLength || 0);
      if (newChars < STREAM_MIN_CHARS && !finalize) return;

      await bot.editMessageText(displayText, {
        chat_id: chatId,
        message_id: state.streamMsg.message_id,
      });
      state.streamLastEdit = Date.now();
    }
    state.streamMsg._lastLength = state.streamBuffer.length;
  } catch (err) {
    // Message not modified (same content) or rate limit — ignore
    if (err.response?.statusCode === 429) {
      // Rate limited, retry after delay
      const retryAfter = (err.response?.body?.parameters?.retry_after || 3) * 1000;
      state.streamTimer = setTimeout(() => {
        state.streamTimer = null;
        flushStream(chatId, threadId, finalize);
      }, retryAfter);
      return;
    }
    if (!err.message?.includes('message is not modified')) {
      console.error('[Telegram] Stream flush error:', sanitizeError(err));
    }
  }

  if (finalize) {
    state.streamFinalized = true;
    // If text was too long, send continuation
    if (text.length > MAX_MESSAGE_LENGTH) {
      const remaining = text.slice(MAX_MESSAGE_LENGTH);
      const chunks = splitText(remaining, MAX_MESSAGE_LENGTH);
      for (const chunk of chunks) {
        await send(chatId, chunk, threadId);
      }
    }
  }
}

// ─── Utilities ───────────────────────────────────────

async function sendWithRetry(fn, label) {
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isNetwork = err.code === 'EFATAL' || err.message?.includes('ETIMEDOUT') || err.message?.includes('ESOCKETTIMEDOUT') || err.message?.includes('socket hang up');
      if (isNetwork && attempt < 3) {
        const delay = 2000 * Math.pow(2, attempt);
        console.warn(`[Telegram] ${label} failed (attempt ${attempt + 1}/3), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.error(`[Telegram] ${label} error:`, sanitizeError(err));
      return;
    }
  }
}

function send(chatId, text, threadId, parseMode) {
  if (!bot) return;
  const opts = {};
  if (threadId) opts.message_thread_id = threadId;
  if (parseMode) opts.parse_mode = parseMode;
  return sendWithRetry(() => bot.sendMessage(chatId, text || '(empty)', opts), 'Send');
}

function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

function truncateEnd(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen);
}

function splitText(text, maxLen) {
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

// ─── Cleanup ─────────────────────────────────────────

function cleanupSession(sessionId) {
  // Clean topic mappings
  const topic = topicSessions.get(sessionId);
  if (topic) {
    topicToSession.delete(`${topic.chatId}:${topic.topicId}`);
    topicSessions.delete(sessionId);
  }
}

// ─── Exports ─────────────────────────────────────────

module.exports = {
  init,
  onSessionEvent,
  getChatState,
  cleanupSession,
};
