// input: CliHub namespace, marked, hljs
// output: Terminal-style message rendering + Markdown + streaming
// pos: Message display core module (CLI terminal interaction model)

'use strict';

// ─── Markdown configuration ───
if (typeof marked !== 'undefined') {
  marked.setOptions({
    breaks: true,
    gfm: true,
    highlight: function (code, lang) {
      if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      if (typeof hljs !== 'undefined') return hljs.highlightAuto(code).value;
      return code;
    },
  });
}

// ─── Render Markdown ───
CliHub.renderMarkdown = function (el, text) {
  if (!text) {
    el.innerHTML = '<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span>';
    return;
  }
  var html = typeof marked !== 'undefined' ? marked.parse(text) : this.escapeHTML(text);
  el.innerHTML = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html;
  this.enhanceCodeBlocks(el);
};

// ─── Create message DOM element (terminal style) ───
CliHub.createMessageEl = function (role, content) {
  if (role === 'user') {
    // User message: ❯ prompt style
    var userEl = document.createElement('div');
    userEl.className = 'msg-user';

    var prompt = document.createElement('span');
    prompt.className = 'msg-prompt';
    prompt.textContent = '❯';

    var body = document.createElement('span');
    body.className = 'msg-user-text';

    if (Array.isArray(content)) {
      var hub = this;
      content.forEach(function (block) {
        if (block.type === 'text' && block.text) {
          var span = document.createElement('span');
          span.textContent = block.text;
          body.appendChild(span);
        } else if (block.type === 'image' && (block.imageId || block.filename)) {
          var img = document.createElement('img');
          var sid = block.sessionId || hub.activeSessionId;
          var fname = block.filename || (block.imageId + '.jpg');
          img.className = 'user-image';
          img.loading = 'lazy';
          (function (imgEl, url, token) {
            fetch(url, { headers: { 'Authorization': 'Bearer ' + token } })
              .then(function (r) { return r.blob(); })
              .then(function (blob) { imgEl.src = URL.createObjectURL(blob); })
              .catch(function () { imgEl.alt = hub.t('msg.imageFailed'); });
          })(img, '/api/images/' + sid + '/' + fname, hub.token);
          body.appendChild(img);
        }
      });
    } else {
      body.textContent = content;
    }

    userEl.appendChild(prompt);
    userEl.appendChild(body);
    userEl._body = body;
    return userEl;

  } else {
    // Assistant message: flowing text, no decoration
    var el = document.createElement('div');
    el.className = 'msg-text';
    this.renderMarkdown(el, content);
    el._body = el;
    return el;
  }
};

// ─── Enhance code blocks (copy button + language label) ───
CliHub.enhanceCodeBlocks = function (container) {
  container.querySelectorAll('pre').forEach(function (pre) {
    if (pre.querySelector('.code-header')) return;
    var codeEl = pre.querySelector('code');
    var lang = '';
    if (codeEl) {
      var cls = codeEl.className || '';
      var m = cls.match(/language-(\w+)/);
      if (m) lang = m[1];
    }
    var hdr = document.createElement('div');
    hdr.className = 'code-header';
    var langSpan = document.createElement('span');
    langSpan.className = 'code-lang';
    langSpan.textContent = lang || 'code';
    var copyBtn = document.createElement('button');
    copyBtn.className = 'code-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', function () {
      var text = codeEl ? codeEl.textContent : pre.textContent;
      navigator.clipboard.writeText(text).then(function () {
        copyBtn.textContent = '\u2713';
        setTimeout(function () { copyBtn.textContent = 'Copy'; }, 2000);
      });
    });
    hdr.appendChild(langSpan);
    hdr.appendChild(copyBtn);
    pre.parentNode.insertBefore(hdr, pre);
  });
};

// ─── Add message (append to stream) ───
CliHub.addMessage = function (role, content) {
  var el = this.createMessageEl(role, content);
  this.el.messages.appendChild(el);
  this.scrollToBottom();
  return el._body;
};

// ─── System message ───
CliHub.addSystemMessage = function (text) {
  var el = document.createElement('div');
  el.className = 'msg-system';
  el.textContent = text;
  this.el.messages.appendChild(el);
  this.scrollToBottom();
};

// ─── Send message ───
CliHub.sendMessage = function () {
  var hub = this;
  var text = hub.el.msgInput.value.trim();
  var hasImages = hub._pendingImages && hub._pendingImages.length > 0;
  if ((!text && !hasImages) || !hub.ws || hub.ws.readyState !== 1 || !hub.activeSessionId) return;

  hub.el.sendBtn.disabled = true;

  if (hasImages) {
    var uploads = hub._pendingImages.map(function (img) {
      return hub.uploadImage(hub.activeSessionId, img.dataUrl);
    });
    Promise.all(uploads).then(function (results) {
      var imageIds = results.map(function (r) { return r.imageId; });
      var persistContent = [];
      results.forEach(function (r) {
        persistContent.push({ type: 'image', imageId: r.imageId, filename: r.filename });
      });
      if (text) persistContent.push({ type: 'text', text: text });

      var s = hub.sessions[hub.activeSessionId];
      if (s) s.messages.push({ role: 'user', content: persistContent });

      hub.addMessage('user', persistContent);
      hub.ws.send(JSON.stringify({ type: 'message', sessionId: hub.activeSessionId, text: text, images: imageIds }));
      hub.el.msgInput.value = '';
      hub.el.msgInput.style.height = 'auto';
      hub.clearPendingImages();
    }).catch(function (err) {
      hub.addSystemMessage(hub.t('msg.uploadFailed', { error: err.message }));
      hub.el.sendBtn.disabled = false;
    });
  } else {
    var s = hub.sessions[hub.activeSessionId];
    if (s) s.messages.push({ role: 'user', content: text });

    hub.addMessage('user', text);
    hub.ws.send(JSON.stringify({ type: 'message', sessionId: hub.activeSessionId, text: text }));
    hub.el.msgInput.value = '';
    hub.el.msgInput.style.height = 'auto';
  }
};

// ─── WS message handlers: streaming ───

CliHub.registerHandler('message_start', function (msg) {
  var hub = CliHub;
  var s = hub.sessions[msg.sessionId];
  if (!s) return;
  s.textBuffer = '';
  if (msg.sessionId === hub.activeSessionId) {
    s.currentAssistantMsg = hub.addMessage('assistant', '');
    hub.setStatus('thinking', hub.t('status.thinking'));
    // Switch send button to abort button
    hub.el.sendBtn.textContent = '\u25A0'; // ■ stop icon
    hub.el.sendBtn.classList.add('abort-mode');
    hub.el.sendBtn.disabled = false;
  }
});

CliHub.registerHandler('thinking_start', function (msg) {
  var hub = CliHub;
  var s = hub.sessions[msg.sessionId];
  if (!s) return;
  s._thinkingBuffer = '';
  if (msg.sessionId === hub.activeSessionId) {
    // CLI-style thinking indicator: · Thinking…
    var el = document.createElement('div');
    el.className = 'tl-thinking';
    el.innerHTML =
      '<span class="tl-dot" data-status="running"></span>' +
      '<span class="tl-thinking-text">' + hub.t('msg.thinkingDots') + '</span>';
    hub.el.messages.appendChild(el);
    s._thinkingEl = el;
    hub.scrollToBottom();
  }
});

CliHub.registerHandler('thinking_delta', function (msg) {
  var hub = CliHub;
  var s = hub.sessions[msg.sessionId];
  if (!s) return;
  s._thinkingBuffer = (s._thinkingBuffer || '') + msg.text;
  // Thinking text is not displayed inline in CLI mode (it's just the spinner)
});

CliHub.registerHandler('text_delta', function (msg) {
  var hub = CliHub;
  var s = hub.sessions[msg.sessionId];
  if (!s) return;

  // Collapse thinking indicator when real text arrives
  if (s._thinkingEl) {
    var dot = s._thinkingEl.querySelector('.tl-dot');
    if (dot) dot.setAttribute('data-status', 'done');
    var txt = s._thinkingEl.querySelector('.tl-thinking-text');
    if (txt) txt.textContent = hub.t('msg.thinkingProcess');
    s._thinkingEl.classList.add('done');
    s._thinkingEl = null;
  }

  s.textBuffer += msg.text;
  if (msg.sessionId === hub.activeSessionId) {
    if (!s.currentAssistantMsg) {
      s.textBuffer = msg.text;
      s.currentAssistantMsg = hub.addMessage('assistant', '');
    }
    hub.renderMarkdown(s.currentAssistantMsg, s.textBuffer);
    hub.scrollToBottom();
  }
});

CliHub.registerHandler('block_start', function () {
  // handled implicitly
});

CliHub.registerHandler('message_end', function (msg) {
  var hub = CliHub;
  var s = hub.sessions[msg.sessionId];
  if (!s) return;
  if (s.textBuffer) {
    s.messages.push({ role: 'assistant', content: s.textBuffer });
  }
  if (msg.sessionId === hub.activeSessionId) {
    if (s.currentAssistantMsg && s.textBuffer) {
      hub.renderMarkdown(s.currentAssistantMsg, s.textBuffer);
      s.currentAssistantMsg.querySelectorAll('pre code').forEach(function (el) {
        hljs.highlightElement(el);
      });
    }
    // Close any running tool indicators
    hub.el.messages.querySelectorAll('.tl-dot[data-status="running"]').forEach(function (el) {
      el.setAttribute('data-status', 'done');
    });
    hub.setStatus('connected', hub.t('status.idle'));
    hub.el.sendBtn.disabled = false;
    hub.el.sendBtn.textContent = '\u25B6'; // ▶ send icon
    hub.el.sendBtn.classList.remove('abort-mode');
  } else {
    s.unread++;
    hub.renderSessionList();
  }
  hub.sendNotification('message_end', msg.sessionId, { text: s.textBuffer });

  s.currentAssistantMsg = null;
  s.textBuffer = '';
});

CliHub.registerHandler('tool_use', function (msg) {
  var hub = CliHub;
  var s = hub.sessions[msg.sessionId];
  if (!s) return;
  if (msg.sessionId === hub.activeSessionId) {
    // Flush any accumulated text before the tool line
    if (s.currentAssistantMsg && s.textBuffer) {
      hub.renderMarkdown(s.currentAssistantMsg, s.textBuffer);
      s.currentAssistantMsg.querySelectorAll('pre code').forEach(function (el) {
        hljs.highlightElement(el);
      });
      s.currentAssistantMsg = null;
    }
    var card = hub.createToolCard(msg.tool, msg.input, msg.toolUseId);
    hub.el.messages.appendChild(card);
    hub.scrollToBottom();
  }
});

CliHub.registerHandler('tool_result', function (msg) {
  var hub = CliHub;
  var s = hub.sessions[msg.sessionId];
  if (!s) return;
  if (msg.sessionId === hub.activeSessionId) {
    hub.setToolResult(msg.toolUseId, msg.content, msg.isError);
    hub.scrollToBottom();
  }
});

CliHub.registerHandler('result', function (msg) {
  var hub = CliHub;
  var s = hub.sessions[msg.sessionId];
  if (s && msg.sessionId === hub.activeSessionId) {
    hub.setStatus('connected', hub.t('status.idle'));
  }
});

CliHub.registerHandler('user_message', function (msg) {
  var hub = CliHub;
  var s = hub.sessions[msg.sessionId];
  if (!s) return;
  s.messages.push({ role: 'user', content: msg.content });
  if (msg.sessionId === hub.activeSessionId) {
    hub.addMessage('user', msg.content);
  }
});

CliHub.registerHandler('generation_aborted', function (msg) {
  var hub = CliHub;
  var s = hub.sessions[msg.sessionId];
  if (!s) return;

  // Close any running thinking/tool indicators
  if (s._thinkingEl) {
    var dot = s._thinkingEl.querySelector('.tl-dot');
    if (dot) dot.setAttribute('data-status', 'done');
    s._thinkingEl.classList.add('done');
    s._thinkingEl = null;
  }

  // Keep partial text if any
  if (s.textBuffer) {
    s.messages.push({ role: 'assistant', content: s.textBuffer });
  }
  s.currentAssistantMsg = null;
  s.textBuffer = '';

  if (msg.sessionId === hub.activeSessionId) {
    hub.el.messages.querySelectorAll('.tl-dot[data-status="running"]').forEach(function (el) {
      el.setAttribute('data-status', 'done');
    });
    hub.addSystemMessage(hub.t('msg.generationAborted'));
    hub.el.sendBtn.textContent = '\u25B6';
    hub.el.sendBtn.classList.remove('abort-mode');
    hub.el.sendBtn.disabled = false;
    hub.setStatus('connected', hub.t('status.idle'));
  }
});

CliHub.registerHandler('error', function (msg) {
  CliHub.addSystemMessage(msg.message || CliHub.t('msg.unknownError'));
});

// ─── Sync response: replay missed events after reconnect ───
CliHub.registerHandler('sync_response', function (msg) {
  var s = CliHub.sessions[msg.sessionId];
  if (!s) return;

  if (msg.hasGap) {
    s.messages = [];
    s.textBuffer = '';
    s.currentAssistantMsg = null;
    if (msg.sessionId === CliHub.activeSessionId) {
      CliHub.el.messages.innerHTML = '';
    }
    CliHub.ws.send(JSON.stringify({
      type: 'get_history', sessionId: msg.sessionId, limit: 50
    }));
    return;
  }

  if (msg.events && msg.events.length > 0) {
    msg.events.forEach(function (event) {
      CliHub.dispatch(event);
    });
  }

  s.lastSeq = msg.currentSeq;
});
