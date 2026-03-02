// input: ClaudeHub namespace
// output: Command completion popup
// pos: Slash command autocomplete

'use strict';

ClaudeHub.allCommands = [];
ClaudeHub.filteredCommands = [];
ClaudeHub.activeIndex = -1;

ClaudeHub.loadCommands = async function () {
  const s = this.activeSessionId ? this.sessions[this.activeSessionId] : null;
  const dir = s ? s.projectDir : this.el.projectSelect.value;
  if (!dir || dir === '__new__') return;
  try {
    const res = await fetch('/api/commands?projectDir=' + encodeURIComponent(dir), {
      headers: this.authHeaders(),
    });
    const data = await res.json();
    this.allCommands = [...data.builtin, ...data.custom];
  } catch (e) { /* ignore */ }
};

ClaudeHub.showCmdPopup = function (filter) {
  const q = filter.toLowerCase();
  this.filteredCommands = this.allCommands.filter((c) =>
    c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q)
  );
  if (!this.filteredCommands.length) {
    this.el.cmdPopup.classList.remove('visible');
    return;
  }
  this.activeIndex = 0;
  this.el.cmdPopup.innerHTML = this.filteredCommands.map((c, i) =>
    '<div class="cmd-item' + (i === 0 ? ' active' : '') + '" data-index="' + i + '">'
    + '<span class="cmd-name">' + this.escapeHTML(c.name) + '</span>'
    + '<span class="cmd-desc">' + this.escapeHTML(c.desc) + '</span>'
    + '</div>'
  ).join('');
  this.el.cmdPopup.classList.add('visible');

  this.el.cmdPopup.querySelectorAll('.cmd-item').forEach((el) => {
    el.addEventListener('click', () => ClaudeHub.selectCommand(parseInt(el.dataset.index)));
  });
};

ClaudeHub.hideCmdPopup = function () {
  this.el.cmdPopup.classList.remove('visible');
  this.activeIndex = -1;
};

ClaudeHub.selectCommand = function (index) {
  const cmd = this.filteredCommands[index];
  if (cmd) {
    this.el.msgInput.value = cmd.name + ' ';
    this.el.msgInput.focus();
  }
  this.hideCmdPopup();
};

ClaudeHub.navigatePopup = function (dir) {
  if (!this.filteredCommands.length) return;
  this.activeIndex = (this.activeIndex + dir + this.filteredCommands.length) % this.filteredCommands.length;
  this.el.cmdPopup.querySelectorAll('.cmd-item').forEach((el, i) => {
    el.classList.toggle('active', i === this.activeIndex);
  });
  const activeEl = this.el.cmdPopup.querySelector('.cmd-item.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
};

// ─── Input field event bindings ───
document.addEventListener('DOMContentLoaded', function () {
  const hub = ClaudeHub;

  hub.el.msgInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    hub.el.sendBtn.disabled = !this.value.trim();

    if (this.value.startsWith('/')) {
      hub.showCmdPopup(this.value);
    } else {
      hub.hideCmdPopup();
    }
  });

  hub.el.msgInput.addEventListener('keydown', function (e) {
    if (hub.el.cmdPopup.classList.contains('visible')) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        hub.navigatePopup(-1);
        return;
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        hub.navigatePopup(1);
        return;
      } else if (e.key === 'Enter' && !e.shiftKey && hub.activeIndex >= 0) {
        e.preventDefault();
        hub.selectCommand(hub.activeIndex);
        return;
      } else if (e.key === 'Escape') {
        hub.hideCmdPopup();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      hub.sendMessage();
    }
  });
});
