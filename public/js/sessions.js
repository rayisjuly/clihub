// input: ClaudeHub namespace
// output: Session management + sidebar + project creation
// pos: Multi-session lifecycle management

'use strict';

// ─── Session operations ───

ClaudeHub.startSession = function () {
  const dir = this.el.projectSelect.value;
  if (!dir || dir === '__new__') return;
  if (this.ws && this.ws.readyState === 1) {
    this.ws.send(JSON.stringify({ type: 'create', projectDir: dir }));
  }
};

ClaudeHub.stopSession = function () {
  if (!this.activeSessionId || !this.ws || this.ws.readyState !== 1) return;
  this.ws.send(JSON.stringify({ type: 'close', sessionId: this.activeSessionId }));
};

ClaudeHub.deleteSession = function (sessionId) {
  if (!this.ws || this.ws.readyState !== 1) return;
  this.ws.send(JSON.stringify({ type: 'delete', sessionId }));
};

ClaudeHub.createProject = async function () {
  const name = this.el.newProjectName.value.trim();
  if (!name) return;
  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (data.error) {
      this.addSystemMessage(data.error);
      return;
    }
    this.el.newProjectName.value = '';
    this.el.newProjectRow.classList.remove('visible');
    await this.loadProjects();
    this.el.projectSelect.value = data.path;
  } catch (err) {
    this.addSystemMessage(this.t('session.createFailed', { error: err.message }));
  }
};

// ─── Sidebar ───

ClaudeHub.toggleSidebar = function () {
  this.el.sidebar.classList.toggle('open');
  this.el.sidebarOverlay.classList.toggle('visible');
};

ClaudeHub.openNewSession = function () {
  this.toggleSidebar();
  document.getElementById('start-panel').style.display = '';
  this.el.startBtn.style.display = 'block';
  this.el.stopBtn.style.display = 'none';
};

ClaudeHub._expandedGroups = {}; // projectDir → true

ClaudeHub.toggleGroup = function (projectDir) {
  this._expandedGroups[projectDir] = !this._expandedGroups[projectDir];
  this.renderSessionList();
};

ClaudeHub.renderSessionList = function () {
  var hub = this;
  var esc = hub.escapeHTML.bind(hub);
  var ids = Object.keys(hub.sessions);

  // Group by project
  var groups = {};
  ids.forEach(function (id) {
    var s = hub.sessions[id];
    var key = s.projectDir || s.name;
    if (!groups[key]) groups[key] = [];
    groups[key].push(id);
  });

  // Sort within each group: running first, then by createdAt descending
  var statusOrder = { thinking: 0, idle: 1, stopped: 2 };
  Object.keys(groups).forEach(function (key) {
    groups[key].sort(function (a, b) {
      var sa = statusOrder[hub.sessions[a].status] || 1;
      var sb = statusOrder[hub.sessions[b].status] || 1;
      if (sa !== sb) return sa - sb;
      return (hub.sessions[b].createdAt || 0) - (hub.sessions[a].createdAt || 0);
    });
  });

  // Sort groups by latest session time descending
  var sortedKeys = Object.keys(groups).sort(function (a, b) {
    var ta = hub.sessions[groups[a][0]].createdAt || 0;
    var tb = hub.sessions[groups[b][0]].createdAt || 0;
    return tb - ta;
  });

  var html = '';
  sortedKeys.forEach(function (key) {
    var list = groups[key];
    var projectName = esc(hub.sessions[list[0]].name);
    var expanded = !!hub._expandedGroups[key];
    var visible = expanded ? list : list.slice(0, 2);
    var hasMore = list.length > 2;

    // Project group header
    if (sortedKeys.length > 1 || hasMore) {
      html += '<div class="group-header" data-group="' + esc(key) + '">'
        + '<span class="group-arrow">' + (expanded ? '▾' : '▸') + '</span>'
        + '<span class="group-name">' + projectName + '</span>'
        + '<span class="group-count">' + list.length + '</span>'
        + '</div>';
    }

    visible.forEach(function (id) {
      var s = hub.sessions[id];
      var active = id === hub.activeSessionId ? ' active' : '';
      var permCount = hub.getPermissionCount ? hub.getPermissionCount(id) : 0;
      var badges = '';
      if (permCount > 0) {
        badges += '<span class="session-perm-badge" title="' + hub.t('session.pendingPerms') + '">' + permCount + '</span>';
      }
      if (s.unread > 0) {
        badges += '<span class="session-unread">' + esc(String(s.unread)) + '</span>';
      }
      var nested = (sortedKeys.length > 1 || hasMore) ? ' nested' : '';
      html += '<div class="session-item' + active + nested + '" data-id="' + esc(id) + '">'
        + '<span class="session-dot ' + esc(s.status) + '"></span>'
        + '<div class="session-info">'
        + '<div class="session-name">' + esc(s.name) + ' <span class="session-id">' + esc(id) + '</span></div>'
        + '<div class="session-status">' + esc(s.status) + '</div>'
        + '</div>'
        + badges
        + '<button class="session-delete" data-delete="' + esc(id) + '">&times;</button>'
        + '</div>';
    });

    if (hasMore && !expanded) {
      html += '<div class="group-more" data-group="' + esc(key) + '">'
        + hub.t('session.expandMore', { count: list.length - 2 }) + '</div>';
    }
  });

  hub.el.sessionList.innerHTML = html;
};

ClaudeHub.switchSession = function (sessionId) {
  if (this.activeSessionId === sessionId) return;
  this.activeSessionId = sessionId;
  const s = this.sessions[sessionId];
  if (!s) return;

  s.unread = 0;

  // Update header
  this.el.headerTitle.textContent = s.name;
  const label = { idle: this.t('status.idle'), thinking: this.t('status.thinking'), stopped: this.t('status.stopped') };
  const cls = s.status === 'thinking' ? 'thinking' : 'connected';
  this.setStatus(cls, label[s.status] || s.status);

  // Re-render message area (request last 50 history entries if empty)
  this.el.messages.innerHTML = '';
  s.hasMore = false;
  if (s.messages.length === 0 && this.ws && this.ws.readyState === 1) {
    this.ws.send(JSON.stringify({ type: 'get_history', sessionId, limit: 50 }));
  } else {
    s.messages.forEach((m) => this.addMessage(m.role, m.content));
  }

  // Restore streaming message
  if (s.textBuffer) {
    s.currentAssistantMsg = this.addMessage('assistant', '');
    this.renderMarkdown(s.currentAssistantMsg, s.textBuffer);
  }

  this.updateActiveUI();
  this.renderSessionList();
  this.scrollToBottom();
  this.renderTokenBar();

  // Check if new session has pending permissions
  this.showNextPermission();

  // Close sidebar
  if (this.el.sidebar.classList.contains('open')) this.toggleSidebar();

  // Load command completions
  this.loadCommands();
};

ClaudeHub.updateActiveUI = function () {
  var s = this.activeSessionId ? this.sessions[this.activeSessionId] : null;
  var panel = document.getElementById('start-panel');

  if (!s) {
    // No session: show start panel
    this.el.inputArea.classList.add('disabled');
    this.el.sendBtn.disabled = true;
    this.el.startBtn.style.display = 'block';
    this.el.stopBtn.style.display = 'none';
    panel.style.display = '';
    this.el.headerTitle.textContent = 'CliHub';
  } else if (s.status === 'stopped') {
    // Stopped: hide start panel, show message history, disable input
    this.el.inputArea.classList.add('disabled');
    this.el.sendBtn.disabled = true;
    panel.style.display = 'none';
  } else {
    // Running: normal interaction
    this.el.inputArea.classList.remove('disabled');
    this.el.sendBtn.disabled = false;
    this.el.startBtn.style.display = 'none';
    this.el.stopBtn.style.display = 'block';
    panel.style.display = 'none';
  }
};

// ─── WS message handlers: session lifecycle ───

ClaudeHub.registerHandler('sessions_list', function (msg) {
  const hub = ClaudeHub;
  msg.sessions.forEach((s) => {
    hub.sessions[s.id] = {
      name: s.name, projectDir: s.projectDir, status: s.status,
      messages: [], unread: 0, textBuffer: '', currentAssistantMsg: null,
      totalUsage: s.usage || null, lastTurnUsage: null, costUsd: s.costUsd || 0, model: s.model || null,
    };
  });
  hub.renderSessionList();

  // Restore active session input state after reconnect
  if (hub.activeSessionId && hub.sessions[hub.activeSessionId]) {
    hub.updateActiveUI();
  }

  // Auto-switch to target session when opened via notification click
  var params = new URLSearchParams(window.location.search);
  var targetSession = params.get('session');
  if (targetSession && hub.sessions[targetSession]) {
    hub.switchSession(targetSession);
    history.replaceState(null, '', '/');
  }
});

ClaudeHub.registerHandler('session_created', function (msg) {
  const hub = ClaudeHub;
  hub.sessions[msg.sessionId] = {
    name: msg.name, projectDir: msg.projectDir, status: 'idle',
    messages: [], unread: 0, textBuffer: '', currentAssistantMsg: null,
    totalUsage: null, lastTurnUsage: null, costUsd: 0, model: null,
  };
  hub.renderSessionList();
  hub.switchSession(msg.sessionId);
});

ClaudeHub.registerHandler('session_deleted', function (msg) {
  var hub = ClaudeHub;
  delete hub.sessions[msg.sessionId];
  hub.renderSessionList();
  if (hub.activeSessionId === msg.sessionId) {
    hub.activeSessionId = null;
    hub.el.messages.innerHTML = '';
    hub.updateActiveUI();
    hub.renderTokenBar();
  }
});

ClaudeHub.registerHandler('session_status', function (msg) {
  const hub = ClaudeHub;
  const s = hub.sessions[msg.sessionId];
  if (s) {
    s.status = msg.status;
    hub.renderSessionList();
    if (msg.sessionId === hub.activeSessionId) {
      const label = { idle: hub.t('status.idle'), thinking: hub.t('status.thinking'), stopped: hub.t('status.stopped') };
      const cls = msg.status === 'thinking' ? 'thinking' : 'connected';
      hub.setStatus(cls, label[msg.status] || msg.status);
    }
  }
});

ClaudeHub.registerHandler('history', function (msg) {
  var hub = ClaudeHub;
  var s = hub.sessions[msg.sessionId];
  if (!s) return;

  var newMsgs = msg.messages.map(function (m) { return { role: m.role, content: m.content, ts: m.ts }; });
  s.hasMore = !!msg.hasMore;
  s._loadingMore = false;

  if (msg.prepend) {
    // Scroll load: prepend older messages
    s.messages = newMsgs.concat(s.messages);
    if (msg.sessionId === hub.activeSessionId) {
      var container = hub.el.messages;
      var oldHeight = container.scrollHeight;
      var frag = document.createDocumentFragment();
      newMsgs.forEach(function (m) { frag.appendChild(hub.createMessageEl(m.role, m.content)); });

      // Show "load more" hint when hasMore is true
      var oldHint = container.querySelector('.load-more-hint');
      if (oldHint) oldHint.remove();
      if (s.hasMore) {
        var hint = document.createElement('div');
        hint.className = 'load-more-hint';
        hint.textContent = hub.t('session.loadMore');
        frag.insertBefore(hint, frag.firstChild);
      }

      container.insertBefore(frag, container.firstChild);
      // Preserve scroll position
      container.scrollTop = container.scrollHeight - oldHeight;
    }
  } else {
    // Initial load
    s.messages = newMsgs;
    if (msg.sessionId === hub.activeSessionId) {
      hub.el.messages.innerHTML = '';
      if (s.hasMore) {
        var hint = document.createElement('div');
        hint.className = 'load-more-hint';
        hint.textContent = hub.t('session.loadMore');
        hub.el.messages.appendChild(hint);
      }
      s.messages.forEach(function (m) { hub.addMessage(m.role, m.content); });
      hub.scrollToBottom();
    }
  }
});

// ─── Scroll to load more ───

ClaudeHub.loadMoreHistory = function () {
  var s = this.sessions[this.activeSessionId];
  if (!s || !s.hasMore || s._loadingMore) return;
  if (!s.messages.length) return;
  s._loadingMore = true;
  var oldest = s.messages[0].ts;
  this.ws.send(JSON.stringify({
    type: 'get_history',
    sessionId: this.activeSessionId,
    limit: 50,
    before: oldest,
  }));
};

// ─── Project selector events + scroll loading + session list event delegation ───
document.addEventListener('DOMContentLoaded', function () {
  // Session list: event delegation (replaces inline onclick, CSP compatible)
  ClaudeHub.el.sessionList.addEventListener('click', function (e) {
    // Delete button
    var delBtn = e.target.closest('[data-delete]');
    if (delBtn) {
      e.stopPropagation();
      ClaudeHub.deleteSession(delBtn.dataset.delete);
      return;
    }
    // Group expand/collapse
    var group = e.target.closest('[data-group]');
    if (group) {
      ClaudeHub.toggleGroup(group.dataset.group);
      return;
    }
    // Session switch
    var item = e.target.closest('[data-id]');
    if (item) {
      ClaudeHub.switchSession(item.dataset.id);
    }
  });

  // Scroll to top to load more history
  ClaudeHub.el.messages.addEventListener('scroll', function () {
    if (this.scrollTop < 80) {
      ClaudeHub.loadMoreHistory();
    }
  });

  ClaudeHub.el.projectSelect.addEventListener('change', function () {
    ClaudeHub.el.newProjectRow.classList.toggle('visible', this.value === '__new__');
  });
});
