// input: CliHub namespace, WebSocket question_request/question_resolved events
// output: AskUserQuestion inline UI (options, single/multi select, Other, Submit)
// pos: frontend question interaction module, parallel to permissions.js

'use strict';

CliHub.pendingQuestions = {}; // {sessionId: [{toolUseId, tool, input}, ...]}
CliHub.answeredQuestions = new Set(); // toolUseIds that were answered

CliHub.getSessionQuestions = function (sessionId) {
  if (!this.pendingQuestions[sessionId]) this.pendingQuestions[sessionId] = [];
  return this.pendingQuestions[sessionId];
};

CliHub.getQuestionCount = function (sessionId) {
  var q = this.pendingQuestions[sessionId];
  return q ? q.length : 0;
};

CliHub.enqueueQuestion = function (msg) {
  var q = this.getSessionQuestions(msg.sessionId);
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
    this.showNextQuestion();
  }
};

CliHub.showNextQuestion = function () {
  var q = this.getSessionQuestions(this.activeSessionId);
  // Remove any existing inline question prompts
  var existing = document.querySelectorAll('.question-inline');
  existing.forEach(function (el) { el.remove(); });

  if (q.length === 0) return;

  var p = q[0];
  var hub = this;
  var esc = this.escapeHTML.bind(this);
  var questions = (p.input && p.input.questions) || [];
  if (questions.length === 0) return;

  var el = document.createElement('div');
  el.className = 'question-inline';
  el.setAttribute('data-tool-use-id', p.toolUseId);

  // Header: · Asking
  var head = document.createElement('div');
  head.className = 'tl-head';
  head.innerHTML =
    '<span class="tl-dot" data-status="running"></span>' +
    '<span class="tl-verb">' + hub.t('question.asking') + '</span>';
  el.appendChild(head);

  // State: track selections for each question
  var selections = {};

  for (var qi = 0; qi < questions.length; qi++) {
    (function (qIdx, qData) {
      var qBlock = document.createElement('div');
      qBlock.className = 'question-block';

      // Question text with header chip
      var qLabel = document.createElement('div');
      qLabel.className = 'question-label';
      var headerHtml = qData.header
        ? '<span class="question-header-chip">' + esc(qData.header) + '</span> '
        : '';
      qLabel.innerHTML = headerHtml + esc(qData.question);
      qBlock.appendChild(qLabel);

      var isMulti = !!qData.multiSelect;
      selections[qIdx] = { multi: isMulti, selected: [], other: '', useOther: false, question: qData.question };

      // Option buttons
      var options = qData.options || [];
      var optContainer = document.createElement('div');
      optContainer.className = 'question-options';

      for (var oi = 0; oi < options.length; oi++) {
        (function (optIdx, opt) {
          var btn = document.createElement('button');
          btn.className = 'question-option';
          btn.innerHTML =
            '<span class="question-option-num">[' + (optIdx + 1) + ']</span> ' +
            '<span class="question-option-label">' + esc(opt.label) + '</span>' +
            (opt.description ? ' <span class="question-option-desc">— ' + esc(opt.description) + '</span>' : '');

          btn.onclick = function () {
            var sel = selections[qIdx];
            sel.useOther = false;
            // Deselect Other visually
            var otherBtn = qBlock.querySelector('.question-other-btn');
            if (otherBtn) otherBtn.classList.remove('selected');

            if (isMulti) {
              var idx = sel.selected.indexOf(opt.label);
              if (idx >= 0) {
                sel.selected.splice(idx, 1);
                btn.classList.remove('selected');
              } else {
                sel.selected.push(opt.label);
                btn.classList.add('selected');
              }
            } else {
              // Single select: deselect all others
              sel.selected = [opt.label];
              var allBtns = optContainer.querySelectorAll('.question-option');
              allBtns.forEach(function (b) { b.classList.remove('selected'); });
              btn.classList.add('selected');
            }
            hub._updateQuestionSubmit(el, selections);
          };
          optContainer.appendChild(btn);
        })(oi, options[oi]);
      }

      // Other option
      var otherRow = document.createElement('div');
      otherRow.className = 'question-other-row';

      var otherBtn = document.createElement('button');
      otherBtn.className = 'question-option question-other-btn';
      otherBtn.innerHTML = '<span class="question-option-num">[✎]</span> ' + hub.t('question.other');
      otherRow.appendChild(otherBtn);

      var otherInput = document.createElement('input');
      otherInput.type = 'text';
      otherInput.className = 'question-other-input';
      otherInput.placeholder = hub.t('question.otherPlaceholder');
      otherInput.style.display = 'none';
      otherRow.appendChild(otherInput);

      otherBtn.onclick = function () {
        var sel = selections[qIdx];
        sel.useOther = !sel.useOther;
        otherBtn.classList.toggle('selected', sel.useOther);
        otherInput.style.display = sel.useOther ? '' : 'none';
        if (sel.useOther) {
          // Deselect all option buttons
          if (!isMulti) {
            sel.selected = [];
            optContainer.querySelectorAll('.question-option').forEach(function (b) { b.classList.remove('selected'); });
          }
          otherInput.focus();
        }
        hub._updateQuestionSubmit(el, selections);
      };

      otherInput.oninput = function () {
        selections[qIdx].other = otherInput.value;
        hub._updateQuestionSubmit(el, selections);
      };

      qBlock.appendChild(optContainer);
      qBlock.appendChild(otherRow);
      el.appendChild(qBlock);
    })(qi, questions[qi]);
  }

  // Submit button
  var submitRow = document.createElement('div');
  submitRow.className = 'question-submit-row';
  var submitBtn = document.createElement('button');
  submitBtn.className = 'question-submit-btn';
  submitBtn.disabled = true;
  submitBtn.textContent = hub.t('question.submit');
  submitBtn.onclick = function () { hub._submitQuestion(p, selections); };
  submitRow.appendChild(submitBtn);
  el.appendChild(submitRow);

  this.el.messages.appendChild(el);
  this._forceScrollToBottom();
};

CliHub._updateQuestionSubmit = function (el, selections) {
  var allAnswered = true;
  for (var key in selections) {
    var sel = selections[key];
    if (sel.useOther) {
      if (!sel.other.trim()) { allAnswered = false; break; }
    } else {
      if (sel.selected.length === 0) { allAnswered = false; break; }
    }
  }
  var btn = el.querySelector('.question-submit-btn');
  if (btn) btn.disabled = !allAnswered;
};

CliHub._submitQuestion = function (pending, selections) {
  var q = this.getSessionQuestions(this.activeSessionId);
  if (q.length === 0 || !this.ws || this.ws.readyState !== 1) return;

  // Build answers: {questionText: "selected label(s)"}
  var answers = {};
  for (var key in selections) {
    var sel = selections[key];
    if (sel.useOther) {
      answers[sel.question] = sel.other.trim();
    } else if (sel.multi) {
      answers[sel.question] = sel.selected.join(', ');
    } else {
      answers[sel.question] = sel.selected[0] || '';
    }
  }

  // Remove from queue
  q.shift();

  // Replace inline UI with answered summary
  var el = document.querySelector('.question-inline[data-tool-use-id="' + pending.toolUseId + '"]');
  if (el) {
    var resolved = document.createElement('div');
    resolved.className = 'tl';
    var summaryParts = [];
    for (var qText in answers) {
      summaryParts.push(answers[qText]);
    }
    resolved.innerHTML =
      '<div class="tl-head">' +
        '<span class="tl-dot" data-status="done"></span>' +
        '<span class="tl-verb">' + this.t('question.answered') + '</span> ' +
        '<span class="tl-summary">' + this.escapeHTML(summaryParts.join('; ')) + '</span>' +
      '</div>';
    el.parentNode.replaceChild(resolved, el);
  }

  // Mark as answered (suppress later tool_result error display)
  this.answeredQuestions.add(pending.toolUseId);

  // Send to server
  this.ws.send(JSON.stringify({
    type: 'question_response',
    sessionId: pending.sessionId,
    toolUseId: pending.toolUseId,
    answers: answers,
  }));

  this.renderSessionList();
  this.showNextQuestion();
};

// ─── WS message handlers ───
CliHub.registerHandler('question_request', function (msg) {
  CliHub.enqueueQuestion(msg);
  CliHub.sendNotification('question_request', msg.sessionId, {});
});

CliHub.registerHandler('question_resolved', function (msg) {
  var hub = CliHub;
  var q = hub.getSessionQuestions(msg.sessionId);
  var idx = -1;
  for (var i = 0; i < q.length; i++) {
    if (q[i].toolUseId === msg.toolUseId) { idx = i; break; }
  }
  if (idx === -1) return;
  q.splice(idx, 1);
  hub.renderSessionList();
  if (msg.sessionId === hub.activeSessionId && idx === 0) {
    hub.showNextQuestion();
  }
});
