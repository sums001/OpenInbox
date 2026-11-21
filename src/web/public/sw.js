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
    // Android draws the badge as a white silhouette in the status bar; a full-colour icon there
    // turns into a plain white square.
    badge: '/badge-96.png',
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
  const url = new URL(event.notification.data?.url || '/mail/all/inbox', self.location.origin);
  if (url.origin !== self.location.origin) return;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(url.href);
      await open.focus();
      // navigate() only works on a page this worker controls; any other tab is asked to go there
      // itself (main.tsx).
      try {
        await open.navigate(url.href);
      } catch {
        open.postMessage({ type: 'open', url: url.pathname + url.search });
      }
    })(),
  );
});

// The browser replaced or expired the subscription. Subscribe again with the same server key;
// the app tells the server about the new one the next time it opens (lib/push.ts).
self.addEventListener('pushsubscriptionchange', (event) => {
  const key = event.oldSubscription?.options?.applicationServerKey;
  if (!key) return;
  event.waitUntil(self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }).catch(() => undefined));
});
