// Service worker. It exists only for push: no offline caching, no fetch handler,
// because a stale cache of a market price is worse than no cache.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = {}; }
  const title = d.title || "Follymarket";
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || "",
    // A tag per market means a second trade replaces the first notification
    // instead of stacking five of them on the lock screen.
    tag: d.tag || undefined,
    data: { url: d.url || "/" },
    icon: "/icon-192.png",
    badge: "/icon-192.png",
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      // Focus first, then navigate: the reverse order loses the focus on iOS.
      await client.focus();
      if (client.url !== target.href && "navigate" in client) {
        try { await client.navigate(target.href); } catch (_) {}
      }
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
