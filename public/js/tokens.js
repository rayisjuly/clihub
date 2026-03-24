// input: CliHub namespace
// output: Context window usage percentage + cost
// pos: Status bar below input field

'use strict';

// Model → context window size mapping
CliHub.MODEL_CONTEXT = {
  'opus-4-6':    1000000,
  'sonnet-4-6':  1000000,
  'haiku-4-5':   200000,
  'opus-4':      200000,
  'sonnet-4':    200000,
  'sonnet-3-5':  200000,
  'haiku-3-5':   200000,
};
CliHub.CONTEXT_DEFAULT = 200000;

CliHub.getContextMax = function (model) {
  if (!model) return this.CONTEXT_DEFAULT;
  for (var key in this.MODEL_CONTEXT) {
    if (model.indexOf(key) !== -1) return this.MODEL_CONTEXT[key];
  }
  return this.CONTEXT_DEFAULT;
};

// ─── Calculate total context tokens ───

CliHub.contextTokens = function (usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0)
    + (usage.output_tokens || 0)
    + (usage.cache_read_input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0);
};

// ─── Render header meta (model, context%, cost) ───

CliHub.renderTokenBar = function () {
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
  var pct = Math.min(Math.round(this.contextTokens(usage) / this.getContextMax(s.model) * 100), 100);
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

CliHub.registerHandler('result', function (msg) {
  var hub = CliHub;
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

CliHub.registerHandler('history', function (msg) {
  var hub = CliHub;
  var s = hub.sessions[msg.sessionId];
  if (!s) return;

  if (msg.usage) s.totalUsage = msg.usage;
  if (msg.costUsd != null) s.costUsd = msg.costUsd;
  if (msg.model) s.model = msg.model;

  if (msg.sessionId === hub.activeSessionId) {
    hub.renderTokenBar();
  }
});
