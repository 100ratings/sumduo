// Online: always fetch the newest app files. Offline: use the last cached copy.
// Keep this cache name stable: routine app.js/style.css edits do not require version bumps.
const CACHE_NAME = 'sumduo-live-v1';
const APP_SHELL = ['./', './index.html', './style.css', './app.js', './manifest.webmanifest', './calc-icon.png'];
const SCOPE = new URL(self.registration.scope);
const INDEX_URL = new URL('index.html', SCOPE).href;
const SHELL_PATHS = new Set(APP_SHELL.map((file) => new URL(file, SCOPE).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith('sumduo-') && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin || !SHELL_PATHS.has(url.pathname)) return;

  // Normalize page URLs and query strings (including ?t=...) to a single shell cache entry.
  // Asset requests likewise never create a new cache entry for each query string.
  const shellRequest = request.mode === 'navigate'
    ? new Request(INDEX_URL)
    : new Request(url.origin + url.pathname);

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const fresh = await fetch(request, { cache: 'no-store' });
      if (!fresh.ok) throw new Error('App shell fetch failed: ' + fresh.status);
      // Cache writes need not delay display, but survive the fetch event.
      event.waitUntil(cache.put(shellRequest, fresh.clone()).catch(() => {}));
      return fresh;
    } catch (_error) {
      const stored = await cache.match(shellRequest);
      if (stored) return stored;
      return Response.error();
    }
  })());
});
