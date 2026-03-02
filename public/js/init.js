// input: ClaudeHub namespace, all modules
// output: DOM event bindings + Service Worker registration
// pos: Initialization entry point, runs after DOMContentLoaded

'use strict';

document.addEventListener('DOMContentLoaded', async function () {
  var hub = ClaudeHub;

  // i18n initialization
  await hub.i18n.load();
  hub.i18n.applyToDOM();

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
  document.getElementById('create-btn').addEventListener('click', function () { hub.createProject(); });

  // Send
  document.getElementById('send-btn').addEventListener('click', function () { hub.sendMessage(); });

  // Permission modal
  document.getElementById('perm-deny-btn').addEventListener('click', function () { hub.respondPermission('deny'); });
  document.getElementById('perm-allow-session-btn').addEventListener('click', function () { hub.respondPermission('allow_session'); });
  document.getElementById('perm-allow-btn').addEventListener('click', function () { hub.respondPermission('allow'); });

  // Login
  document.getElementById('login-btn').addEventListener('click', function () {
    hub.login(hub.el.loginToken.value);
  });
  document.getElementById('login-token').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') hub.login(hub.el.loginToken.value);
  });

  // Sidebar overlay
  document.getElementById('sidebar-overlay').addEventListener('click', function () { hub.toggleSidebar(); });

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
