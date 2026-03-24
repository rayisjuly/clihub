// input: WebSocket tool_use/tool_result events or structured history events
// output: CLI-style tool line DOM elements (tree connectors, in-place status update)
// pos: frontend tool rendering module, creates terminal-like tool display

'use strict';

(function () {
  var hub = window.CliHub;

  // ─── Tool verb mapping (Running → Ran) ─────────────

  hub.toolVerbs = {
    Bash: { running: 'Running', done: 'Ran' },
    Read: { running: 'Reading', done: 'Read' },
    Edit: { running: 'Editing', done: 'Edited' },
    Write: { running: 'Writing', done: 'Wrote' },
    Glob: { running: 'Searching', done: 'Found' },
    Grep: { running: 'Searching', done: 'Found' },
    Agent: { running: 'Running agent', done: 'Agent done' },
    TodoWrite: { running: 'Updating tasks', done: 'Updated tasks' },
    AskUserQuestion: { running: 'Asking', done: 'Asked' },
    EnterPlanMode: { running: 'Entering plan mode', done: 'Plan mode' },
    ExitPlanMode: { running: 'Reviewing plan', done: 'Plan approved' },
    _default: { running: 'Running', done: 'Completed' },
  };

  // ─── Tool param extractors ────────────────────────

  hub.toolParams = {
    Bash: function (input) {
      var cmd = (input && input.command) || '';
      var desc = (input && input.description) || '';
      return { summary: desc || (cmd.length > 50 ? cmd.slice(0, 50) + '…' : cmd), param: cmd };
    },
    Read: function (input) {
      var p = (input && input.file_path) || '';
      return { summary: p.split('/').pop() || p, param: p };
    },
    Edit: function (input) {
      var p = (input && input.file_path) || '';
      return { summary: p.split('/').pop() || p, param: p };
    },
    Write: function (input) {
      var p = (input && input.file_path) || '';
      return { summary: p.split('/').pop() || p, param: p };
    },
    Glob: function (input) {
      var pat = (input && input.pattern) || '';
      return { summary: pat, param: pat };
    },
    Grep: function (input) {
      var pat = (input && input.pattern) || '';
      var path = (input && input.path) || '';
      return { summary: pat, param: path ? pat + ' in ' + path : pat };
    },
    Agent: function (input) {
      var desc = (input && input.description) || '';
      return { summary: desc, param: desc };
    },
    AskUserQuestion: function (input) {
      var q = (input && input.questions && input.questions[0] && input.questions[0].question) || '';
      return { summary: q, param: q };
    },
    EnterPlanMode: function () {
      return { summary: 'planning', param: '' };
    },
    ExitPlanMode: function () {
      return { summary: 'plan approval', param: '' };
    },
    _default: function (input) {
      var s = input ? JSON.stringify(input) : '';
      return { summary: s.length > 50 ? s.slice(0, 50) + '…' : s, param: s };
    },
  };

  // ─── Create tool line (CLI style) ─────────────────

  hub.createToolCard = function (toolName, input, toolUseId, opts) {
    opts = opts || {};
    var extractor = this.toolParams[toolName] || this.toolParams._default;
    var info = extractor(input, toolName);
    var verbs = this.toolVerbs[toolName] || this.toolVerbs._default;
    var esc = this.escapeHTML.bind(this);

    var el = document.createElement('div');
    el.className = 'tl';
    el.setAttribute('data-tool-use-id', toolUseId || '');
    el.setAttribute('data-tool-name', toolName);

    // Header line: · Reading file…
    var head = document.createElement('div');
    head.className = 'tl-head';
    head.innerHTML =
      '<span class="tl-dot" data-status="running"></span>' +
      '<span class="tl-verb">' + esc(verbs.running) + '</span> ' +
      '<span class="tl-summary">' + esc(info.summary) + '</span>';

    // Tree param line: └ path/to/file
    var tree = document.createElement('div');
    tree.className = 'tl-tree';
    tree.innerHTML = '<span class="tl-connector">└</span> ' + esc(info.param);

    // Output area (hidden by default, toggle on click)
    var output = document.createElement('div');
    output.className = 'tl-output';

    el.appendChild(head);
    if (info.param) el.appendChild(tree);
    el.appendChild(output);

    // Click head to toggle output
    head.addEventListener('click', function () {
      output.classList.toggle('expanded');
    });

    return el;
  };

  // ─── Set tool result (in-place update) ────────────

  hub.setToolResult = function (toolUseId, content, isError) {
    var card = document.querySelector('.tl[data-tool-use-id="' + CSS.escape(toolUseId) + '"]');
    if (!card) return;

    var name = card.getAttribute('data-tool-name') || '';

    // AskUserQuestion answered via remote UI: suppress tool error
    if (name === 'AskUserQuestion' && isError && hub.answeredQuestions && hub.answeredQuestions.has(toolUseId)) {
      isError = false;
      content = '';
    }

    // Update dot status
    var dot = card.querySelector('.tl-dot');
    if (dot) dot.setAttribute('data-status', isError ? 'error' : 'done');

    // Update verb to past tense
    var verbs = this.toolVerbs[name] || this.toolVerbs._default;
    var verbEl = card.querySelector('.tl-verb');
    if (verbEl) verbEl.textContent = isError ? 'Error' : verbs.done;

    // Populate output
    var outputArea = card.querySelector('.tl-output');
    if (!outputArea) return;

    var out = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    var resultRenderer = this.toolResultRenderers[name];

    if (resultRenderer) {
      outputArea.innerHTML = resultRenderer(out, isError);
    } else {
      outputArea.innerHTML = '<pre class="tl-pre' + (isError ? ' tl-error' : '') + '">' +
        hub.escapeHTML(out.length > 2000 ? out.slice(0, 2000) + '\n…[truncated]' : out) + '</pre>';
    }

    // Don't auto-expand on success (user clicks to see)
    if (isError) {
      outputArea.classList.add('expanded');
    }
  };

  hub.toolResultRenderers = {};

  // ─── Render structured assistant turn (for history) ─

  hub.renderAssistantTurn = function (events) {
    var frag = document.createDocumentFragment();
    var toolCards = {};

    for (var i = 0; i < events.length; i++) {
      var evt = events[i];

      if (evt.type === 'thinking') {
        var tEl = document.createElement('div');
        tEl.className = 'tl-thinking done';
        tEl.innerHTML = '<span class="tl-dot" data-status="done"></span>' +
          '<span class="tl-thinking-text">' + hub.t('msg.thinkingProcess') + '</span>';
        frag.appendChild(tEl);

      } else if (evt.type === 'text') {
        var textEl = document.createElement('div');
        textEl.className = 'msg-text';
        textEl.innerHTML = DOMPurify.sanitize(marked.parse(evt.content || ''));
        textEl.querySelectorAll('pre code').forEach(function (el) {
          hljs.highlightElement(el);
        });
        hub.enhanceCodeBlocks(textEl);
        frag.appendChild(textEl);

      } else if (evt.type === 'tool_use') {
        var card = hub.createToolCard(evt.tool, evt.input, evt.toolUseId, { open: false });
        // Mark as done (history = already completed)
        var dot = card.querySelector('.tl-dot');
        if (dot) dot.setAttribute('data-status', 'done');
        var verbEl = card.querySelector('.tl-verb');
        var hVerbs = hub.toolVerbs[evt.tool] || hub.toolVerbs._default;
        if (verbEl) verbEl.textContent = hVerbs.done;
        frag.appendChild(card);
        if (evt.toolUseId) toolCards[evt.toolUseId] = card;

      } else if (evt.type === 'tool_result') {
        var targetCard = evt.toolUseId && toolCards[evt.toolUseId];
        if (targetCard) {
          var area = targetCard.querySelector('.tl-output');
          var rOut = evt.content || '';
          var rn = targetCard.getAttribute('data-tool-name') || '';
          var rr = hub.toolResultRenderers[rn];
          if (rr) {
            area.innerHTML = rr(rOut, evt.isError);
          } else {
            area.innerHTML = '<pre class="tl-pre' + (evt.isError ? ' tl-error' : '') + '">' +
              hub.escapeHTML(rOut.length > 2000 ? rOut.slice(0, 2000) + '\n…' : rOut) + '</pre>';
          }
          if (evt.isError) {
            var st = targetCard.querySelector('.tl-dot');
            if (st) st.setAttribute('data-status', 'error');
            var vEl = targetCard.querySelector('.tl-verb');
            if (vEl) vEl.textContent = 'Error';
            area.classList.add('expanded');
          }
        }
      }
    }

    return frag;
  };

  // ─── Tool result renderers ────────────────────────

  hub.toolResultRenderers['Bash'] = function (output, isError) {
    return '<pre class="tl-pre' + (isError ? ' tl-error' : '') + '">' +
      hub.escapeHTML(output) + '</pre>';
  };

  hub.toolResultRenderers['Read'] = function (output, isError) {
    if (isError) {
      return '<pre class="tl-pre tl-error">' + hub.escapeHTML(output) + '</pre>';
    }
    // Show truncated preview
    var lines = output.split('\n');
    var preview = lines.length > 30 ? lines.slice(0, 30).join('\n') + '\n…[' + lines.length + ' lines total]' : output;
    return '<pre class="tl-pre">' + hub.escapeHTML(preview) + '</pre>';
  };

  hub.toolResultRenderers['Glob'] = function (output) {
    var lines = output.split('\n').filter(Boolean);
    return '<pre class="tl-pre">' + lines.map(function (l) { return hub.escapeHTML(l); }).join('\n') + '</pre>';
  };

  hub.toolResultRenderers['Grep'] = hub.toolResultRenderers['Glob'];

})();
