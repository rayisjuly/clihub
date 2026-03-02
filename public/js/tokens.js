// input: ClaudeHub namespace
// output: Context window usage percentage + cost
// pos: Status bar below input field

'use strict';

ClaudeHub.CONTEXT_MAX = 200000;

// ─── Calculate total context tokens ───

ClaudeHub.contextTokens = function (usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0)
    + (usage.cache_read_input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0);
};

// ─── Render status bar ───

ClaudeHub.renderTokenBar = function () {
  var bar = this.el.tokenBar;
  if (!bar) return;
  var s = this.sessions[this.activeSessionId];
  if (!s || !s.lastTurnUsage) {
    bar.classList.remove('visible');
    return;
  }

  var pct = Math.min(Math.round(this.contextTokens(s.lastTurnUsage) / this.CONTEXT_MAX * 100), 100);
  var level = pct < 50 ? 'ctx-ok' : pct < 80 ? 'ctx-warn' : 'ctx-danger';

  var parts = [];

  // Cost
  if (s.costUsd != null && s.costUsd > 0) {
    parts.push('<span class="sb-cost">$' + s.costUsd.toFixed(2) + '</span>');
  }

  // Context percentage
  parts.push('<span class="sb-ctx ' + level + '">' + pct + '%</span>');

  bar.innerHTML = parts.join('<span class="sb-sep">|</span>');
  bar.classList.add('visible');
};

// ─── WS message handler: result event ───

ClaudeHub.registerHandler('result', function (msg) {
  var hub = ClaudeHub;
  var s = hub.sessions[msg.sessionId];
  if (!s) return;

  if (msg.usage) s.lastTurnUsage = msg.usage;
  if (msg.totalUsage) s.totalUsage = msg.totalUsage;
  if (msg.costUsd != null) s.costUsd = msg.costUsd;
  if (msg.model) s.model = msg.model;

  if (msg.sessionId === hub.activeSessionId) {
    hub.renderTokenBar();
  }
});

// ─── WS message handler: history event ───

ClaudeHub.registerHandler('history', function (msg) {
  var hub = ClaudeHub;
  var s = hub.sessions[msg.sessionId];
  if (!s) return;

  if (msg.usage) s.totalUsage = msg.usage;
  if (msg.costUsd != null) s.costUsd = msg.costUsd;
  if (msg.model) s.model = msg.model;

  if (msg.sessionId === hub.activeSessionId) {
    hub.renderTokenBar();
  }
});
