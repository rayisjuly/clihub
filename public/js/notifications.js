// input: ClaudeHub namespace, Notification API, Service Worker
// output: Push notification management (permissions, trigger logic, sending, toggle sync)
// pos: Frontend notification module

'use strict';

ClaudeHub._notifyEnabled = false;
ClaudeHub._lastNotifyTime = {};

// ─── Initialize notifications ───

ClaudeHub.initNotifications = function () {
  if (!('Notification' in window)) return;

  if (Notification.permission === 'granted' && localStorage.getItem('clihub-notify-enabled')) {
    this._notifyEnabled = true;
  }
};

// ─── Check if notification is needed ───

ClaudeHub.shouldNotify = function (type, sessionId) {
  if (!this._notifyEnabled) return false;

  var isCurrentSession = sessionId === this.activeSessionId;
  var isPageVisible = !document.hidden;

  if (type === 'permission_request') {
    return !isCurrentSession || !isPageVisible;
  }
  if (type === 'message_end') {
    return !isPageVisible || !isCurrentSession;
  }
  return false;
};

// ─── Send notification ───

ClaudeHub.sendNotification = function (type, sessionId, extra) {
  if (!this.shouldNotify(type, sessionId)) return;

  // 3-second deduplication
  var now = Date.now();
  var key = type + ':' + sessionId;
  if (this._lastNotifyTime[key] && now - this._lastNotifyTime[key] < 3000) return;
  this._lastNotifyTime[key] = now;

  var s = this.sessions[sessionId];
  var sessionName = s ? s.name : sessionId;
  var title, body, tag;

  if (type === 'message_end') {
    title = ClaudeHub.t('notify.replied');
    var preview = (extra.text || '').replace(/[#*>`_\[\]()]/g, '').trim();
    body = sessionName + ': ' + (preview.slice(0, 80) || ClaudeHub.t('notify.messageComplete'));
    tag = 'msg-' + sessionId;
  } else if (type === 'permission_request') {
    title = ClaudeHub.t('notify.permRequired');
    body = sessionName + ' — ' + (extra.tool || ClaudeHub.t('notify.unknown'));
    tag = 'perm-' + sessionId;
  }

  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'SHOW_NOTIFICATION',
      title: title,
      options: {
        body: body,
        tag: tag,
        icon: '/icon-192.png',
        data: { sessionId: sessionId, type: type },
        renotify: type === 'permission_request',
      },
    });
  }
};

// ─── Sidebar toggle sync ───

ClaudeHub.syncNotifySwitch = function () {
  var sw = this.el.notifySwitch;
  if (!sw) return;

  if (!('Notification' in window)) {
    sw.disabled = true;
    sw.parentElement.title = ClaudeHub.t('notify.notSupported');
    return;
  }

  sw.checked = this._notifyEnabled;
  var hub = this;

  sw.addEventListener('change', function () {
    if (this.checked) {
      Notification.requestPermission().then(function (perm) {
        if (perm === 'granted') {
          hub._notifyEnabled = true;
          localStorage.setItem('clihub-notify-enabled', '1');
        } else {
          sw.checked = false;
        }
      });
    } else {
      hub._notifyEnabled = false;
      localStorage.removeItem('clihub-notify-enabled');
    }
  });
};
