// input: ClaudeHub namespace
// output: Context window usage percentage + cost
// pos: Status bar below input field

'use strict';

ClaudeHub.CONTEXT_MAX = 200000;

// ─── Calculate total context tokens ───

ClaudeHub.contextTokens = function (usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0)
    + (usage.output_tokens || 0)
    + (usage.cache_read_input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0);
};

// ─── Render header meta (model, context%, cost) ───

ClaudeHub.renderTokenBar = function () {
  var s = this.sessions[this.activeSessionId];
  var modelEl = this.el.headerModel;
  var ctxEl = this.el.headerContext;
  var costEl = this.el.headerCost;
  if (!modelEl) return;

  var usage = (s && s.totalUsage) || (s && s.lastTurnUsage) || null;

  if (!s || !usage) {
    modelEl.textContent = '';
    ctxEl.textContent = '';
    ctxEl.className = '';
    costEl.textContent = '';
    return;
  }

  // Model (simplify name)
  if (s.model) {
    var short = s.model.replace(/^claude-/, '');
    modelEl.textContent = short;
  }

  // Context percentage with color grading
  var pct = Math.min(Math.round(this.contextTokens(usage) / this.CONTEXT_MAX * 100), 100);
  var level = pct < 50 ? 'ctx-ok' : pct < 80 ? 'ctx-warn' : 'ctx-danger';
  ctxEl.textContent = pct + '%';
  ctxEl.className = 'sb-ctx ' + level;

  // Cost
  if (s.costUsd != null && s.costUsd > 0) {
    costEl.textContent = '$' + s.costUsd.toFixed(2);
    costEl.className = 'sb-cost';
  } else {
    costEl.textContent = '';
  }
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
