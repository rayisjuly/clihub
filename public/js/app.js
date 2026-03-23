// input: WebSocket, DOM
// output: CliHub global namespace + WS connection + message dispatch
// pos: Frontend core module, all other modules depend on this

'use strict';

window.CliHub = {
  ws: null,
  token: localStorage.getItem('clihub-token') || '',
  activeSessionId: null,
  sessions: {},    // {id: {name, projectDir, status, messages[], unread, textBuffer, currentAssistantMsg}}
  handlers: {},    // {type: [fn, fn, ...]}

  // ─── Handler registration ───
  registerHandler(type, fn) {
    if (!this.handlers[type]) this.handlers[type] = [];
    this.handlers[type].push(fn);
  },

  // ─── Dispatch WS message ───
  dispatch(msg) {
    const fns = this.handlers[msg.type];
    if (fns) {
      fns.forEach((fn) => fn(msg));
    }
  },

  // ─── DOM references ───
  el: {},
};

// ─── Cache DOM references ───
document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);
  const hub = CliHub;

  hub.el = {
    messages: $('messages'),
    msgInput: $('msg-input'),
    sendBtn: $('send-btn'),
    status: $('status'),
    startBtn: $('start-btn'),
    stopBtn: $('stop-btn'),
    resumeBtn: $('resume-btn'),
    inputArea: $('input-area'),
    projectSelect: $('project-select'),
    newProjectRow: $('new-project-row'),
    newProjectName: $('new-project-name'),
    sessionList: $('session-list'),
    headerTitle: document.querySelector('#header-center h1'),
    headerMeta: $('header-meta'),
    headerModel: $('header-model'),
    headerContext: $('header-context'),
    headerCost: $('header-cost'),
    sidebar: $('sidebar'),
    sidebarOverlay: $('sidebar-overlay'),
    cmdPopup: $('cmd-popup'),
    imagePreview: $('image-preview'),
    attachBtn: $('attach-btn'),
    imageInput: $('image-input'),
    notifySwitch: $('notify-switch'),
  };

  // ─── Login-related DOM ───
  hub.el.loginScreen = $('login-screen');
  hub.el.loginToken = $('login-token');
  hub.el.loginBtn = $('login-btn');
  hub.el.loginError = $('login-error');
  hub.el.appMain = $('app');

  // ─── Startup: check token ───
  if (hub.token) {
    hub.tryAutoLogin();
  } else {
    hub.showLogin();
  }
});

// ─── Authentication ───
CliHub.setToken = function (t) {
  this.token = t;
  localStorage.setItem('clihub-token', t);
};

CliHub.authHeaders = function () {
  return { 'Authorization': 'Bearer ' + this.token };
};

CliHub.showLogin = function () {
  this.el.loginScreen.style.display = 'flex';
  this.el.appMain.style.display = 'none';
  this.el.loginError.textContent = '';
  this.el.loginToken.value = '';
  this.el.loginToken.focus();
};

CliHub.showApp = function () {
  this.el.loginScreen.style.display = 'none';
  this.el.appMain.style.display = '';
};

CliHub.login = async function (token) {
  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (res.ok) {
      this.setToken(token);
      this.showApp();
      this.loadProjects();
      this.connect();
    } else {
      const data = await res.json();
      this.el.loginError.textContent = data.error || this.t('auth.failed');
    }
  } catch {
    this.el.loginError.textContent = this.t('auth.networkError');
  }
};

CliHub.tryAutoLogin = async function () {
  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: this.token }),
    });
    if (res.ok) {
      this.showApp();
      this.loadProjects();
      this.connect();
    } else {
      this.token = '';
      localStorage.removeItem('clihub-token');
      this.showLogin();
    }
  } catch {
    this.showLogin();
  }
};

// ─── WebSocket connection ───
CliHub._reconnectDelay = 1000;
CliHub._heartbeatTimer = null;
CliHub._disconnectTimer = null;

CliHub.connect = function () {
  // Close old connection + clear heartbeat
  if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
  if (this.ws) {
    try { this.ws.onclose = null; this.ws.close(); } catch (e) { /* ignore */ }
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);
  this.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', token: CliHub.token }));
  };

  ws.onmessage = (e) => {
    if (ws !== CliHub.ws) return;
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch (err) {
      console.error('[WS] Invalid JSON:', err.message);
      return;
    }
    if (msg.type === 'sessions_list') {
      // Auth succeeded — cancel disconnect UI, reset backoff, start heartbeat
      if (CliHub._disconnectTimer) {
        clearTimeout(CliHub._disconnectTimer);
        CliHub._disconnectTimer = null;
      }
      CliHub.setStatus('connected', CliHub.t('status.connected'));
      CliHub._reconnectDelay = 1000;
      CliHub._startHeartbeat();
      // Sync missed messages for active session
      CliHub._syncActiveSession();
    }
    // Track seq per session
    if (msg.seq && msg.sessionId) {
      var s = CliHub.sessions[msg.sessionId];
      if (s) s.lastSeq = msg.seq;
    }
    CliHub.dispatch(msg);
  };

  ws.onclose = (e) => {
    if (ws !== CliHub.ws) return;
    if (CliHub._heartbeatTimer) { clearInterval(CliHub._heartbeatTimer); CliHub._heartbeatTimer = null; }
    if (e.code === 4003 || e.code === 4001) {
      CliHub.token = '';
      localStorage.removeItem('clihub-token');
      CliHub.showLogin();
      return;
    }
    // Grace period: delay showing "disconnected" to avoid flicker on quick reconnects
    if (!CliHub._disconnectTimer) {
      CliHub._disconnectTimer = setTimeout(() => {
        CliHub._disconnectTimer = null;
        CliHub.setStatus('disconnected', CliHub.t('status.disconnected'));
        CliHub.el.inputArea.classList.add('disabled');
        CliHub.el.sendBtn.disabled = true;
      }, 2000);
    }
    // Exponential backoff: 1s → 2s → 4s → 8s → ... → 30s max
    var delay = CliHub._reconnectDelay;
    CliHub._reconnectDelay = Math.min(delay * 2, 30000);
    setTimeout(() => CliHub.connect(), delay);
  };

  ws.onerror = () => {
    if (ws !== CliHub.ws) return;
    ws.close();
  };
};

// ─── Sync missed messages after reconnect ───
CliHub._syncActiveSession = function () {
  var sid = this.activeSessionId;
  if (!sid) return;
  var s = this.sessions[sid];
  if (!s || !s.lastSeq) return;
  this.ws.send(JSON.stringify({
    type: 'sync',
    sessionId: sid,
    lastSeq: s.lastSeq,
  }));
};

// ─── Client heartbeat (keep connection alive through tunnels/proxies) ───
CliHub._startHeartbeat = function () {
  if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
  this._heartbeatTimer = setInterval(() => {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'ping' })); } catch (e) { /* reconnect will handle it */ }
    }
  }, 25000); // 25s — under typical 30s/60s proxy idle timeouts
};

// ─── iOS/mobile: force check connection on page resume ───
document.addEventListener('visibilitychange', function () {
  if (!document.hidden && CliHub.token) {
    var ws = CliHub.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      CliHub.connect();
    } else if (ws.readyState === WebSocket.OPEN) {
      // Connection looks alive, send ping to verify it's really active
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) { CliHub.connect(); }
    }
  }
});

// ─── Utility functions ───
CliHub.setStatus = function (cls, text) {
  this.el.status.className = cls;
  this.el.status.textContent = text;
};

CliHub._isNearBottom = function () {
  var el = this.el.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 100;
};

CliHub.scrollToBottom = function () {
  if (this._isNearBottom()) {
    this.el.messages.scrollTop = this.el.messages.scrollHeight;
    this._hideNewMsgBtn();
  } else {
    this._showNewMsgBtn();
  }
};

CliHub._forceScrollToBottom = function () {
  this.el.messages.scrollTop = this.el.messages.scrollHeight;
  this._hideNewMsgBtn();
};

CliHub._showNewMsgBtn = function () {
  var btn = document.getElementById('new-msg-btn');
  if (btn) btn.classList.add('visible');
};

CliHub._hideNewMsgBtn = function () {
  var btn = document.getElementById('new-msg-btn');
  if (btn) btn.classList.remove('visible');
};

CliHub.escapeHTML = function (str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

// ─── Theme ───
CliHub.initTheme = function () {
  var saved = localStorage.getItem('clihub-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  this._updateHljsTheme();
};

CliHub.toggleTheme = function () {
  var current = document.documentElement.getAttribute('data-theme');
  var isDark = current === 'dark' || (!current && matchMedia('(prefers-color-scheme: dark)').matches);
  var next = isDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('clihub-theme', next);
  document.querySelector('meta[name="theme-color"]').content = next === 'dark' ? '#2b2a27' : '#F5F5F0';
  this._updateHljsTheme();
};

CliHub._updateHljsTheme = function () {
  var theme = document.documentElement.getAttribute('data-theme');
  var isLight = theme === 'light' || (!theme && matchMedia('(prefers-color-scheme: light)').matches);
  var link = document.getElementById('hljs-theme');
  if (link) link.href = isLight ? '/vendor/github-light.min.css' : '/vendor/github-dark.min.css';
};

// ─── Project list ───
CliHub.loadProjects = async function () {
  try {
    const res = await fetch('/api/projects', { headers: this.authHeaders() });
    const data = await res.json();
    const sel = this.el.projectSelect;
    sel.innerHTML = '';
    data.projects.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.path;
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
    const newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = this.t('project.new');
    sel.appendChild(newOpt);
  } catch (err) {
    console.error('Failed to load projects:', err);
  }
};
