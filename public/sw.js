// input: Browser Service Worker API
// output: Offline caching strategy
// pos: PWA offline support

const CACHE_NAME = 'clihub-v28';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css',
  '/vendor/marked.min.js',
  '/vendor/highlight.min.js',
  '/vendor/purify.min.js',
  '/vendor/github-dark.min.css',
  '/vendor/github-light.min.css',
  '/js/app.js',
  '/js/i18n.js',
  '/js/tools.js',
  '/js/messages.js',
  '/js/sessions.js',
  '/js/permissions.js',
  '/js/commands.js',
  '/js/tokens.js',
  '/js/images.js',
  '/js/notifications.js',
  '/js/init.js',
  '/locales/en.json',
  '/locales/zh.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Only cache same-origin GET requests, skip CDN / WebSocket / API
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith(self.location.origin)) return;
  if (e.request.url.includes('/ws') || e.request.url.includes('/api/')) return;

  // Network-first: always try network, update cache on success, fallback to cache
  e.respondWith(
    fetch(e.request).then((response) => {
      const clone = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
      return response;
    }).catch(() => caches.match(e.request))
  );
});

// ─── Notification support ─────────────────────────────────────

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SHOW_NOTIFICATION') {
    e.waitUntil(
      self.registration.showNotification(e.data.title, e.data.options)
    );
  }
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  var sessionId = e.notification.data && e.notification.data.sessionId;

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (var i = 0; i < windowClients.length; i++) {
        if (windowClients[i].url.startsWith(self.location.origin)) {
          windowClients[i].focus();
          windowClients[i].postMessage({ type: 'NOTIFICATION_CLICK', sessionId: sessionId });
          return;
        }
      }
      return clients.openWindow('/?session=' + (sessionId || ''));
    })
  );
});
