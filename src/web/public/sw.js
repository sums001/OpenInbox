// OpenInbox Service Worker for Web Push notifications
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { body: event.data.text() };
    }
  }

  const title = data.title || 'OpenInbox';
  const options = {
    body: data.body || 'New message received',
    icon: data.icon || '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'openinbox-mail',
    renotify: true,
    data: {
      url: data.url || '/mail',
      threadId: data.threadId,
    },
  };

  if (navigator.setAppBadge) {
    navigator.setAppBadge().catch(() => undefined);
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (navigator.clearAppBadge) {
    navigator.clearAppBadge().catch(() => undefined);
  }
  const targetUrl = event.notification.data?.url || '/mail/all/inbox';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          if ('navigate' in client) {
            client.navigate(targetUrl);
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    }),
  );
});
