// input: WebSocket, DOM
// output: ClaudeHub global namespace + WS connection + message dispatch
// pos: Frontend core module, all other modules depend on this

'use strict';

window.ClaudeHub = {
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
  const hub = ClaudeHub;

  hub.el = {
    messages: $('messages'),
    msgInput: $('msg-input'),
    sendBtn: $('send-btn'),
    status: $('status'),
    startBtn: $('start-btn'),
    stopBtn: $('stop-btn'),
    inputArea: $('input-area'),
    projectSelect: $('project-select'),
    newProjectRow: $('new-project-row'),
    newProjectName: $('new-project-name'),
    sessionList: $('session-list'),
    headerTitle: document.querySelector('#header h1'),
    sidebar: $('sidebar'),
    sidebarOverlay: $('sidebar-overlay'),
    cmdPopup: $('cmd-popup'),
    tokenBar: $('token-bar'),
    imagePreview: $('image-preview'),
    attachBtn: $('attach-btn'),
    imageInput: $('image-input'),
    notifySwitch: $('notify-switch'),
    permModal: $('permission-modal'),
    permToolName: $('perm-tool-name'),
    permToolInput: $('perm-tool-input'),
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
ClaudeHub.setToken = function (t) {
  this.token = t;
  localStorage.setItem('clihub-token', t);
};

ClaudeHub.authHeaders = function () {
  return { 'Authorization': 'Bearer ' + this.token };
};

ClaudeHub.showLogin = function () {
  this.el.loginScreen.style.display = 'flex';
  this.el.appMain.style.display = 'none';
  this.el.loginError.textContent = '';
  this.el.loginToken.value = '';
  this.el.loginToken.focus();
};

ClaudeHub.showApp = function () {
  this.el.loginScreen.style.display = 'none';
  this.el.appMain.style.display = '';
};

ClaudeHub.login = async function (token) {
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

ClaudeHub.tryAutoLogin = async function () {
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
ClaudeHub.connect = function () {
  // Close old connection
  if (this.ws) {
    try { this.ws.onclose = null; this.ws.close(); } catch (e) { /* ignore */ }
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);
  this.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', token: ClaudeHub.token }));
  };

  ws.onmessage = (e) => {
    if (ws !== ClaudeHub.ws) return;
    const msg = JSON.parse(e.data);
    if (msg.type === 'sessions_list') {
      ClaudeHub.setStatus('connected', ClaudeHub.t('status.connected'));
    }
    ClaudeHub.dispatch(msg);
  };

  ws.onclose = (e) => {
    if (ws !== ClaudeHub.ws) return;
    ClaudeHub.setStatus('disconnected', ClaudeHub.t('status.disconnected'));
    ClaudeHub.el.inputArea.classList.add('disabled');
    ClaudeHub.el.sendBtn.disabled = true;
    if (e.code === 4003 || e.code === 4001) {
      ClaudeHub.token = '';
      localStorage.removeItem('clihub-token');
      ClaudeHub.showLogin();
      return;
    }
    setTimeout(() => ClaudeHub.connect(), 3000);
  };

  ws.onerror = () => {
    if (ws !== ClaudeHub.ws) return;
    ws.close();
  };
};

// ─── iOS/mobile: force check connection on page resume ───
document.addEventListener('visibilitychange', function () {
  if (!document.hidden && ClaudeHub.token) {
    var ws = ClaudeHub.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      ClaudeHub.connect();
    } else if (ws.readyState === WebSocket.OPEN) {
      // Connection looks alive, send ping to verify it's really active
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) { ClaudeHub.connect(); }
    }
  }
});

// ─── Utility functions ───
ClaudeHub.setStatus = function (cls, text) {
  this.el.status.className = cls;
  this.el.status.textContent = text;
};

ClaudeHub.scrollToBottom = function () {
  this.el.messages.scrollTop = this.el.messages.scrollHeight;
};

ClaudeHub.escapeHTML = function (str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

// ─── Project list ───
ClaudeHub.loadProjects = async function () {
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
