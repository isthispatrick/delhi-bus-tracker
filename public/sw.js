/* Service worker: makes the app installable and quick to reopen.
   - app shell: network first, cached copy if the network fails (so the app still opens on a bad connection)
   - /api/*: always the network (live data is never served from cache)
   - shows the "your bus is 2 stops away" notification the page asks for, and focuses the app on tap
   No offline route map (out of scope). */
const VERSION = 'v3-1';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/planner.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return; // network as usual
  // network first (a new deploy shows up on the next open), cached copy only when the network fails
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    try {
      const res = await fetch(e.request);
      if (res.ok && SHELL.includes(url.pathname)) cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) { c.navigate && c.url !== target && c.navigate(target); return c.focus(); }
    return self.clients.openWindow(target);
  }));
});
