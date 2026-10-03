// Karat service worker.
// Bump CACHE on every deploy so installed copies pick up the new files.
const CACHE = 'karat-v2';
const FONT_CACHE = 'karat-fonts';

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (url) => {
      // cache: 'reload' skips the HTTP cache so a new version never precaches stale files.
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (!res.ok) throw new Error(`Precache failed for ${url}: ${res.status}`);
      await cache.put(url, await clean(res));
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE && key !== FONT_CACHE).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Prices: never intercept, always straight to the network.
  if (url.hostname === 'api.gold-api.com') return;

  // Google Fonts: cache-first, stored on first use so the app looks right offline.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req));
    return;
  }

  // App files: serve from cache, refresh the cache in the background.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(event, req));
  }
});

async function cacheFirst(req) {
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

// Hosts may redirect (e.g. index.html -> ./). Safari refuses redirected responses for
// navigations served by a service worker, so store a plain copy instead.
async function clean(res) {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(CACHE);
  // The app is a single page: every navigation is served from the './' entry.
  const isPage = req.mode === 'navigate';
  const key = isPage ? './' : req;
  const hit = await cache.match(key, { ignoreSearch: true });

  const network = fetch(req)
    .then(async (res) => {
      if (res.ok && res.type === 'basic') {
        const copy = await clean(res.clone());
        await cache.put(key, copy);
      }
      return res;
    })
    .catch(() => undefined);

  if (hit) {
    event.waitUntil(network);
    return hit;
  }
  const res = await network;
  return res || new Response('Offline', { status: 503, statusText: 'Offline' });
}
