// input: CliHub namespace, all modules
// output: DOM event bindings + Service Worker registration
// pos: Initialization entry point, runs after DOMContentLoaded

'use strict';

document.addEventListener('DOMContentLoaded', async function () {
  var hub = CliHub;

  // i18n initialization
  await hub.i18n.load();
  hub.i18n.applyToDOM();

  // Theme initialization + toggle
  hub.initTheme();
  document.getElementById('theme-toggle').addEventListener('click', function () {
    hub.toggleTheme();
  });

  // Language toggle
  document.getElementById('lang-toggle').addEventListener('click', function () {
    var next = hub.i18n.locale === 'zh' ? 'en' : 'zh';
    hub.i18n.switchTo(next);
  });

  // Header bar buttons
  document.getElementById('menu-btn').addEventListener('click', function () { hub.toggleSidebar(); });
  document.getElementById('new-session-btn').addEventListener('click', function () { hub.openNewSession(); });

  // Start panel
  document.getElementById('start-btn').addEventListener('click', function () { hub.startSession(); });
  document.getElementById('stop-btn').addEventListener('click', function () { hub.stopSession(); });
  document.getElementById('resume-btn').addEventListener('click', function () { hub.resumeSession(); });
  document.getElementById('create-btn').addEventListener('click', function () { hub.createProject(); });

  // Send / Abort (same button, mode-dependent)
  document.getElementById('send-btn').addEventListener('click', function () {
    if (this.classList.contains('abort-mode')) {
      hub.abortGeneration();
    } else {
      hub.sendMessage();
    }
  });

  // Permission buttons are bound dynamically in permissions.js showNextPermission()

  // Login
  document.getElementById('login-btn').addEventListener('click', function () {
    hub.login(hub.el.loginToken.value);
  });
  document.getElementById('login-token').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') hub.login(hub.el.loginToken.value);
  });

  // Sidebar overlay
  document.getElementById('sidebar-overlay').addEventListener('click', function () { hub.toggleSidebar(); });

  // New messages floating button
  document.getElementById('new-msg-btn').addEventListener('click', function () {
    hub._forceScrollToBottom();
  });
  hub.el.messages.addEventListener('scroll', function () {
    if (hub._isNearBottom()) hub._hideNewMsgBtn();
  });

  // Image handling
  hub.initImageHandlers();

  // Notifications
  hub.initNotifications();
  hub.syncNotifySwitch();

  // Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'NOTIFICATION_CLICK' && e.data.sessionId) {
        if (hub.sessions[e.data.sessionId]) {
          hub.switchSession(e.data.sessionId);
        }
      }
    });
  }
});
