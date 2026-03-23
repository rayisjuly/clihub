// input: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS env vars
// output: Telegram Bot interface for CliHub sessions
// pos: optional transport layer, parallel to WebSocket frontend

'use strict';

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
  if (TELEGRAM_ALLOWED_USERS.length === 0) return true;  // no whitelist = allow all
  return TELEGRAM_ALLOWED_USERS.includes(String(userId));
}

// ─── Initialize ──────────────────────────────────────

function init(manager) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[Telegram] No TELEGRAM_BOT_TOKEN set, Telegram integration disabled');
    return null;
  }

  const TelegramBot = require('node-telegram-bot-api');
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  sessionManager = manager;

  console.log('[Telegram] Bot starting...');

  bot.on('polling_error', (err) => {
    // Suppress 409 conflict (another instance running)
    if (err.code === 'ETELEGRAM' && err.response?.statusCode === 409) {
      console.error('[Telegram] Another bot instance is running. Stopping polling.');
      bot.stopPolling();
      return;
    }
    console.error('[Telegram] Polling error:', err.message);
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

  // ─── Text messages (forward to active session) ───

  bot.on('message', (msg) => {
    // Skip commands
    if (msg.text && msg.text.startsWith('/')) return;
    if (!isAllowed(msg.from.id)) return;
    if (!msg.text) return;

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

    if (session.status === 'stopped') {
      // Auto-resume
      sessionManager.resumeSession(sessionId);
      // Wait a bit for process to start, then send
      setTimeout(() => {
        sessionManager.sendMessage(sessionId, msg.text);
      }, 1000);
      return;
    }

    sessionManager.sendMessage(sessionId, msg.text);
  });

  console.log('[Telegram] Bot initialized');
  return bot;
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
      bot.sendMessage(chatId, text, {
        message_thread_id: threadId,
        reply_markup: keyboard,
      }).catch(err => console.error('[Telegram] Send permission error:', err.message));
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
        bot.sendMessage(chatId, text, {
          message_thread_id: threadId,
          reply_markup: { inline_keyboard: buttons },
        }).catch(err => console.error('[Telegram] Send question error:', err.message));
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
      console.error('[Telegram] Stream flush error:', err.message);
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

function send(chatId, text, threadId, parseMode) {
  if (!bot) return;
  const opts = {};
  if (threadId) opts.message_thread_id = threadId;
  if (parseMode) opts.parse_mode = parseMode;
  return bot.sendMessage(chatId, text || '(empty)', opts)
    .catch(err => console.error('[Telegram] Send error:', err.message));
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

// ─── Exports ─────────────────────────────────────────

module.exports = {
  init,
  onSessionEvent,
  getChatState,
};
