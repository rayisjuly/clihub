// input: ClaudeHub namespace, marked, hljs
// output: Message rendering + Markdown + streaming
// pos: Message display core module

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
ClaudeHub.renderMarkdown = function (el, text) {
  if (!text) {
    el.innerHTML = '<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span>';
    return;
  }
  var html = typeof marked !== 'undefined' ? marked.parse(text) : this.escapeHTML(text);
  el.innerHTML = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html;
};

// ─── Create message DOM element ───
ClaudeHub.createMessageEl = function (role, content) {
  var wrapper = document.createElement('div');
  wrapper.className = 'message ' + role;

  var label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = role === 'user' ? ClaudeHub.t('msg.you') : 'Claude';

  var body = document.createElement('div');
  body.className = 'message-body';

  if (role === 'user') {
    if (Array.isArray(content)) {
      var hub = this;
      content.forEach(function (block) {
        if (block.type === 'text' && block.text) {
          var p = document.createElement('p');
          p.textContent = block.text;
          body.appendChild(p);
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
              .catch(function () { imgEl.alt = ClaudeHub.t('msg.imageFailed'); });
          })(img, '/api/images/' + sid + '/' + fname, hub.token);
          body.appendChild(img);
        }
      });
    } else {
      body.textContent = content;
    }
  } else {
    this.renderMarkdown(body, content);
  }

  wrapper.appendChild(label);
  wrapper.appendChild(body);
  wrapper._body = body;
  return wrapper;
};

// ─── Add message (append to bottom) ───
ClaudeHub.addMessage = function (role, content) {
  var el = this.createMessageEl(role, content);
  this.el.messages.appendChild(el);
  this.scrollToBottom();
  return el._body;
};

// ─── System message ───
ClaudeHub.addSystemMessage = function (text) {
  const el = document.createElement('div');
  el.style.cssText = 'text-align:center;color:var(--accent);font-size:13px;margin:12px 0;';
  el.textContent = text;
  this.el.messages.appendChild(el);
  this.scrollToBottom();
};

// ─── Send message ───
ClaudeHub.sendMessage = function () {
  var hub = this;
  var text = hub.el.msgInput.value.trim();
  var hasImages = hub._pendingImages && hub._pendingImages.length > 0;
  if ((!text && !hasImages) || !hub.ws || hub.ws.readyState !== 1 || !hub.activeSessionId) return;

  // Disable send button to prevent duplicates
  hub.el.sendBtn.disabled = true;

  if (hasImages) {
    // Upload all images then send
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

ClaudeHub.registerHandler('message_start', function (msg) {
  const hub = ClaudeHub;
  const s = hub.sessions[msg.sessionId];
  if (!s) return;
  s.textBuffer = '';
  if (msg.sessionId === hub.activeSessionId) {
    s.currentAssistantMsg = hub.addMessage('assistant', '');
    hub.setStatus('thinking', hub.t('status.thinking'));
  }
});

ClaudeHub.registerHandler('thinking_start', function (msg) {
  var hub = ClaudeHub;
  var s = hub.sessions[msg.sessionId];
  if (!s) return;
  s._thinkingBuffer = '';
  if (msg.sessionId === hub.activeSessionId) {
    // Create collapsible thinking block
    var details = document.createElement('details');
    details.className = 'thinking-block';
    details.open = true;
    var summary = document.createElement('summary');
    summary.textContent = ClaudeHub.t('msg.thinkingDots');
    var content = document.createElement('div');
    content.className = 'thinking-content';
    details.appendChild(summary);
    details.appendChild(content);
    hub.el.messages.appendChild(details);
    s._thinkingEl = content;
    s._thinkingDetails = details;
    hub.scrollToBottom();
  }
});

ClaudeHub.registerHandler('thinking_delta', function (msg) {
  var hub = ClaudeHub;
  var s = hub.sessions[msg.sessionId];
  if (!s) return;
  s._thinkingBuffer = (s._thinkingBuffer || '') + msg.text;
  if (msg.sessionId === hub.activeSessionId && s._thinkingEl) {
    s._thinkingEl.textContent = s._thinkingBuffer;
    hub.scrollToBottom();
  }
});

ClaudeHub.registerHandler('text_delta', function (msg) {
  const hub = ClaudeHub;
  const s = hub.sessions[msg.sessionId];
  if (!s) return;
  // Received body text -> collapse thinking
  if (s._thinkingDetails) {
    s._thinkingDetails.open = false;
    s._thinkingDetails.querySelector('summary').textContent = ClaudeHub.t('msg.thinkingProcess');
    s._thinkingDetails = null;
    s._thinkingEl = null;
  }
  s.textBuffer += msg.text;
  if (msg.sessionId === hub.activeSessionId && s.currentAssistantMsg) {
    hub.renderMarkdown(s.currentAssistantMsg, s.textBuffer);
    hub.scrollToBottom();
  }
});

ClaudeHub.registerHandler('block_start', function (msg) {
  if (!msg.block || msg.block.type !== 'tool_use') return;
  const hub = ClaudeHub;
  const s = hub.sessions[msg.sessionId];
  if (!s) return;
  s.textBuffer += '\n\n> **' + hub.t('msg.toolCall') + '**: `' + hub.escapeHTML(msg.block.name) + '`\n';
  if (msg.sessionId === hub.activeSessionId && s.currentAssistantMsg) {
    hub.renderMarkdown(s.currentAssistantMsg, s.textBuffer);
    hub.scrollToBottom();
  }
});

ClaudeHub.registerHandler('message_end', function (msg) {
  const hub = ClaudeHub;
  const s = hub.sessions[msg.sessionId];
  if (!s) return;
  if (s.textBuffer) {
    s.messages.push({ role: 'assistant', content: s.textBuffer });
  }
  if (msg.sessionId === hub.activeSessionId) {
    if (s.currentAssistantMsg) {
      hub.renderMarkdown(s.currentAssistantMsg, s.textBuffer);
      s.currentAssistantMsg.querySelectorAll('pre code').forEach((el) => {
        hljs.highlightElement(el);
      });
    }
    hub.setStatus('connected', hub.t('status.idle'));
    hub.el.sendBtn.disabled = false;
  } else {
    s.unread++;
    hub.renderSessionList();
  }
  // Notification
  hub.sendNotification('message_end', msg.sessionId, { text: s.textBuffer });

  s.currentAssistantMsg = null;
  s.textBuffer = '';
});

ClaudeHub.registerHandler('tool_use', function (msg) {
  const hub = ClaudeHub;
  const s = hub.sessions[msg.sessionId];
  if (!s) return;
  const info = '\n\n> **' + hub.escapeHTML(msg.tool) + '** `' + hub.escapeHTML(JSON.stringify(msg.input).slice(0, 100)) + '`\n';
  s.textBuffer += info;
  if (msg.sessionId === hub.activeSessionId && s.currentAssistantMsg) {
    hub.renderMarkdown(s.currentAssistantMsg, s.textBuffer);
    hub.scrollToBottom();
  }
});

ClaudeHub.registerHandler('tool_result', function (msg) {
  const hub = ClaudeHub;
  const s = hub.sessions[msg.sessionId];
  if (!s) return;
  const output = typeof msg.content === 'string'
    ? msg.content.slice(0, 200)
    : JSON.stringify(msg.content).slice(0, 200);
  const prefix = msg.isError ? '**' + hub.t('msg.error') + '**' : '**' + hub.t('msg.result') + '**';
  s.textBuffer += '\n> ' + prefix + ': `' + hub.escapeHTML(output) + '`\n';
  if (msg.sessionId === hub.activeSessionId && s.currentAssistantMsg) {
    hub.renderMarkdown(s.currentAssistantMsg, s.textBuffer);
    hub.scrollToBottom();
  }
});

ClaudeHub.registerHandler('result', function (msg) {
  const hub = ClaudeHub;
  const s = hub.sessions[msg.sessionId];
  if (s && msg.sessionId === hub.activeSessionId) {
    hub.setStatus('connected', hub.t('status.idle'));
  }
});

ClaudeHub.registerHandler('user_message', function (msg) {
  var hub = ClaudeHub;
  var s = hub.sessions[msg.sessionId];
  if (!s) return;
  s.messages.push({ role: 'user', content: msg.content });
  if (msg.sessionId === hub.activeSessionId) {
    hub.addMessage('user', msg.content);
  }
});

ClaudeHub.registerHandler('error', function (msg) {
  ClaudeHub.addSystemMessage(msg.message || ClaudeHub.t('msg.unknownError'));
});
