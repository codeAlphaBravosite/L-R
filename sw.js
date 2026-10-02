// Optional offline add-on for Shadow Practice.
// The app is a single HTML file and works without this. Deploy sw.js next to index.html
// and the page itself is cached, so the app can launch with no connection at all.
// Your sessions, audio, progress and recordings live in IndexedDB and never go through here.

const CACHE = 'shadow-practice-v4';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.add(new Request('./', { cache: 'reload' })))
      .catch(() => {})                       // never block activation just because the first cache fill failed
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))   // also clears the old multi-file app's cache
      .then(() => self.clients.claim())
  );
});

// Network-first for the page itself, so updates always arrive when you're online;
// falls back to the cached copy when the network is down or the server errors.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put('./', copy)).catch(() => {});
        return res;
      }
      return (await caches.match('./')) || res;
    } catch (err) {
      const cached = await caches.match('./');
      if (cached) return cached;
      throw err;
    }
  })());
});
