const CACHE_NAME = 'veche-web-v5';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((c) => c.addAll(['/', '/index.html']))
      .catch(() => {})
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
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;

  // Стратегия network-first для ВСЕГО (app.js/style.css/crypto.js — имена стабильные, не хешированные).
  // Так свежий код подхватывается сразу после правки/деплоя; кэш — только офлайн-запасной вариант.
  const key = e.request.mode === 'navigate' ? '/index.html' : e.request;
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp && resp.ok && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(key, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(key).then((c) => c || (e.request.mode === 'navigate' ? caches.match('/') : undefined)))
  );
});

// ── Push notifications ──────────────────────────────────────
// Формат payload задаётся сервером (server.js → sendPush):
//   сообщение: { type:'message', title, body, chatId }
//   звонок:    { type:'call', from, name, avatar }
self.addEventListener('push', (e) => {
  if (!e.data) return;
  let p;
  try { p = e.data.json(); } catch { return; }

  const isCall = p.type === 'call';
  const title = p.title || p.name || 'ВЕЧЕ';
  const body = p.body || (isCall ? '📞 Входящий звонок' : 'Новое сообщение');
  const chatId = p.chatId || '';

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: p.avatar || '/icon-192.png',
      badge: '/icon-192.png',
      tag: isCall ? `call-${p.from}` : `chat-${chatId}`,
      renotify: true,
      requireInteraction: isCall,
      vibrate: isCall ? [200, 100, 200, 100, 200] : [40, 30, 40],
      data: { chatId, call: isCall, from: p.from || null },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { chatId, call, from } = e.notification.data ?? {};
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => c.url.includes(self.location.origin));
      if (existing) {
        existing.focus();
        // события клиента слушает app.js: { type:'open_chat', chatId, callFrom }
        existing.postMessage({ type: 'open_chat', chatId: call ? null : chatId, callFrom: call ? from : null });
      } else {
        const q = call ? '/?pending_call=1' : (chatId ? `/?open=${encodeURIComponent(chatId)}` : '/');
        self.clients.openWindow(self.location.origin + q);
      }
    })
  );
});
