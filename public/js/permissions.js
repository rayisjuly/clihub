// input: ClaudeHub namespace
// output: Permission confirmation modal logic (grouped by session)
// pos: Tool permission approval UI

'use strict';

ClaudeHub.pendingPermissions = {}; // {sessionId: [{toolUseId, tool, input}, ...]}

ClaudeHub.getSessionPermissions = function (sessionId) {
  if (!this.pendingPermissions[sessionId]) this.pendingPermissions[sessionId] = [];
  return this.pendingPermissions[sessionId];
};

ClaudeHub.getPermissionCount = function (sessionId) {
  var q = this.pendingPermissions[sessionId];
  return q ? q.length : 0;
};

ClaudeHub.showPermissionModal = function (msg) {
  var q = this.getSessionPermissions(msg.sessionId);
  // Deduplicate: same toolUseId should not be queued twice (may resend on reconnect)
  for (var i = 0; i < q.length; i++) {
    if (q[i].toolUseId === msg.toolUseId) return;
  }
  q.push({
    sessionId: msg.sessionId,
    toolUseId: msg.toolUseId,
    tool: msg.tool,
    input: msg.input,
  });
  // Update sidebar badge
  this.renderSessionList();
  // Only show modal for current session's permissions
  if (msg.sessionId === this.activeSessionId) {
    this.showNextPermission();
  }
};

ClaudeHub.showNextPermission = function () {
  var q = this.getSessionPermissions(this.activeSessionId);
  if (q.length === 0) {
    this.el.permModal.classList.remove('visible');
    return;
  }
  var p = q[0];
  this.el.permToolName.textContent = p.tool;
  this.el.permToolInput.textContent = typeof p.input === 'string'
    ? p.input
    : JSON.stringify(p.input, null, 2);
  this.el.permModal.classList.add('visible');
};

ClaudeHub.respondPermission = function (decision) {
  var q = this.getSessionPermissions(this.activeSessionId);
  if (q.length === 0 || !this.ws || this.ws.readyState !== 1) return;
  var p = q.shift();
  this.ws.send(JSON.stringify({
    type: 'permission_response',
    sessionId: p.sessionId,
    toolUseId: p.toolUseId,
    tool: p.tool,
    decision,
  }));
  // Update sidebar badge
  this.renderSessionList();
  // Show next permission, or close modal
  this.showNextPermission();
};

// ─── WS message handlers ───
ClaudeHub.registerHandler('permission_request', function (msg) {
  ClaudeHub.showPermissionModal(msg);
  ClaudeHub.sendNotification('permission_request', msg.sessionId, { tool: msg.tool });
});

ClaudeHub.registerHandler('permission_resolved', function (msg) {
  var hub = ClaudeHub;
  var q = hub.getSessionPermissions(msg.sessionId);
  var idx = -1;
  for (var i = 0; i < q.length; i++) {
    if (q[i].toolUseId === msg.toolUseId) { idx = i; break; }
  }
  if (idx === -1) return;
  q.splice(idx, 1);
  // Update sidebar badge
  hub.renderSessionList();
  // If current session and displayed item was removed, refresh modal
  if (msg.sessionId === hub.activeSessionId && idx === 0) {
    hub.showNextPermission();
  }
});
