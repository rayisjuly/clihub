// input: CliHub namespace
// output: Permission approval inline in message stream (CLI style)
// pos: Tool permission approval UI

'use strict';

CliHub.pendingPermissions = {}; // {sessionId: [{toolUseId, tool, input}, ...]}

CliHub.getSessionPermissions = function (sessionId) {
  if (!this.pendingPermissions[sessionId]) this.pendingPermissions[sessionId] = [];
  return this.pendingPermissions[sessionId];
};

CliHub.getPermissionCount = function (sessionId) {
  var q = this.pendingPermissions[sessionId];
  return q ? q.length : 0;
};

CliHub.enqueuePermission = function (msg) {
  var q = this.getSessionPermissions(msg.sessionId);
  for (var i = 0; i < q.length; i++) {
    if (q[i].toolUseId === msg.toolUseId) return;
  }
  q.push({
    sessionId: msg.sessionId,
    toolUseId: msg.toolUseId,
    tool: msg.tool,
    input: msg.input,
  });
  this.renderSessionList();
  if (msg.sessionId === this.activeSessionId) {
    this.showNextPermission();
  }
};

CliHub.showNextPermission = function () {
  var q = this.getSessionPermissions(this.activeSessionId);
  // Remove any existing inline permission prompts
  var existing = document.querySelectorAll('.perm-inline');
  existing.forEach(function (el) { el.remove(); });

  if (q.length === 0) return;

  var p = q[0];
  var hub = this;
  var esc = this.escapeHTML.bind(this);
  var inputText = typeof p.input === 'string'
    ? p.input
    : JSON.stringify(p.input, null, 2);

  // Create inline permission element in the message stream
  var el = document.createElement('div');
  el.className = 'perm-inline';
  el.setAttribute('data-tool-use-id', p.toolUseId);

  var head = document.createElement('div');
  head.className = 'tl-head';
  head.innerHTML =
    '<span class="tl-dot" data-status="running"></span>' +
    '<span class="tl-verb">' + esc(p.tool) + '</span> ' +
    '<span class="tl-summary">' + esc(inputText.split('\n')[0].slice(0, 60)) + '</span>';

  var tree = document.createElement('div');
  tree.className = 'tl-tree';
  tree.innerHTML = '<span class="tl-connector">└</span> ' + esc(inputText.length > 80 ? inputText.slice(0, 80) + '…' : inputText);

  var prompt = document.createElement('div');
  prompt.className = 'perm-prompt';

  // Custom labels for plan mode tools
  var promptLabel, allowLabel, denyLabel, showAllowSession;
  if (p.tool === 'EnterPlanMode') {
    promptLabel = this.t('perm.enterPlan');
    allowLabel = this.t('perm.allow');
    denyLabel = this.t('perm.deny');
    showAllowSession = false;
  } else if (p.tool === 'ExitPlanMode') {
    promptLabel = this.t('perm.approvePlan');
    allowLabel = this.t('perm.approve');
    denyLabel = this.t('perm.reject');
    showAllowSession = false;
  } else {
    promptLabel = 'Allow?';
    allowLabel = this.t('perm.allow');
    denyLabel = this.t('perm.deny');
    showAllowSession = true;
  }

  prompt.innerHTML =
    '<span class="perm-prompt-label">' + this.escapeHTML(promptLabel) + '</span>' +
    '<button class="perm-allow-btn" id="perm-allow-btn">' + this.escapeHTML(allowLabel) + '</button>' +
    (showAllowSession ? '<button id="perm-allow-session-btn">' + this.t('perm.allowSession') + '</button>' : '') +
    '<button id="perm-deny-btn">' + this.escapeHTML(denyLabel) + '</button>';

  el.appendChild(head);
  el.appendChild(tree);
  el.appendChild(prompt);

  // Append to message stream — force scroll (permission needs user action)
  this.el.messages.appendChild(el);
  this._forceScrollToBottom();

  // Bind buttons
  document.getElementById('perm-allow-btn').onclick = function () { hub.respondPermission('allow'); };
  var allowSessionBtn = document.getElementById('perm-allow-session-btn');
  if (allowSessionBtn) allowSessionBtn.onclick = function () { hub.respondPermission('allow_session'); };
  document.getElementById('perm-deny-btn').onclick = function () { hub.respondPermission('deny'); };
};

CliHub.respondPermission = function (decision) {
  var q = this.getSessionPermissions(this.activeSessionId);
  if (q.length === 0 || !this.ws || this.ws.readyState !== 1) return;
  var p = q.shift();
  var allowed = decision === 'allow' || decision === 'allow_session';

  // Remove the inline prompt from the stream
  var promptEl = document.querySelector('.perm-inline[data-tool-use-id="' + CSS.escape(p.toolUseId) + '"]');
  if (promptEl) {
    // Replace with a resolved line
    var resolved = document.createElement('div');
    resolved.className = 'tl';
    var status = !allowed ? 'error' : 'done';
    var label;
    if (!allowed) {
      label = p.tool === 'ExitPlanMode' ? 'Rejected' : 'Denied';
    } else if (p.tool === 'ExitPlanMode') {
      label = 'Approved';
    } else {
      label = 'Allowed';
    }
    resolved.innerHTML =
      '<div class="tl-head">' +
        '<span class="tl-dot" data-status="' + status + '"></span>' +
        '<span class="tl-verb">' + label + '</span> ' +
        '<span class="tl-summary">' + this.escapeHTML(p.tool) + '</span>' +
      '</div>';
    promptEl.parentNode.replaceChild(resolved, promptEl);
  }

  // Track plan mode state
  if (p.tool === 'EnterPlanMode' && allowed) {
    this.setPlanMode(p.sessionId, true);
  } else if (p.tool === 'ExitPlanMode') {
    this.setPlanMode(p.sessionId, false);
  } else if (p.tool === 'EnterPlanMode' && !allowed) {
    this.setPlanMode(p.sessionId, false);
  }

  this.ws.send(JSON.stringify({
    type: 'permission_response',
    sessionId: p.sessionId,
    toolUseId: p.toolUseId,
    tool: p.tool,
    decision,
  }));
  this.renderSessionList();
  this.showNextPermission();
};

// ─── Plan mode indicator ───
CliHub.setPlanMode = function (sessionId, active) {
  var s = this.sessions[sessionId];
  if (s) s.planMode = active;
  if (sessionId === this.activeSessionId) {
    this._renderPlanBanner(active);
  }
};

CliHub._renderPlanBanner = function (show) {
  var existing = document.getElementById('plan-mode-banner');
  if (!show) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return; // already shown
  var banner = document.createElement('div');
  banner.id = 'plan-mode-banner';
  banner.innerHTML =
    '<span class="plan-mode-icon">&#9998;</span> ' +
    '<span>' + this.t('perm.planModeActive') + '</span>';
  // Insert before messages area
  this.el.messages.parentNode.insertBefore(banner, this.el.messages);
};

// ─── WS message handlers ───
CliHub.registerHandler('permission_request', function (msg) {
  CliHub.enqueuePermission(msg);
  CliHub.sendNotification('permission_request', msg.sessionId, { tool: msg.tool });
});

CliHub.registerHandler('permission_resolved', function (msg) {
  var hub = CliHub;
  var q = hub.getSessionPermissions(msg.sessionId);
  var idx = -1;
  for (var i = 0; i < q.length; i++) {
    if (q[i].toolUseId === msg.toolUseId) { idx = i; break; }
  }
  if (idx === -1) return;
  q.splice(idx, 1);
  hub.renderSessionList();
  if (msg.sessionId === hub.activeSessionId && idx === 0) {
    hub.showNextPermission();
  }
});

CliHub.registerHandler('permission_timeout', function (msg) {
  var hub = CliHub;
  var q = hub.getSessionPermissions(msg.sessionId);
  var idx = -1;
  for (var i = 0; i < q.length; i++) {
    if (q[i].toolUseId === msg.toolUseId) { idx = i; break; }
  }
  if (idx >= 0) q.splice(idx, 1);
  // Replace inline prompt with timeout indicator
  var el = document.querySelector('[data-tool-use-id="' + CSS.escape(msg.toolUseId) + '"]');
  if (el) {
    var resolved = document.createElement('div');
    resolved.className = 'tl';
    resolved.innerHTML =
      '<div class="tl-head">' +
        '<span class="tl-dot" data-status="error"></span>' +
        '<span class="tl-verb">Timeout</span> ' +
        '<span class="tl-summary">' + hub.escapeHTML(msg.tool) + '</span>' +
      '</div>';
    el.parentNode.replaceChild(resolved, el);
  }
  hub.renderSessionList();
  if (msg.sessionId === hub.activeSessionId) {
    hub.showNextPermission();
  }
});
