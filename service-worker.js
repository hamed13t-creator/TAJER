/* TAJER SW — bump VERSION on every deploy (any byte change triggers update). */
const VERSION = 'v22';
const PREFIX = 'tajer-';
const SHELL = PREFIX + 'shell-' + VERSION;   // atomic, immutable per version
const RUNTIME = PREFIX + 'rt-' + VERSION;    // SWR for anything not precached
const CORE = ['./index.html', './manifest.json', './icon.svg', './i18n/fr.json', './i18n/en.json'];
const OPTIONAL = ['./icon-192.png', './icon-512.png', './icon-maskable.svg', './icon-maskable-192.png',
  './icon-maskable-512.png', './apple-touch-icon.png', './shortcut-96.png'];
const INDEX = new URL('./index.html', self.registration.scope).href;
const NAV_TIMEOUT = 3500;

const put = (cacheName, req, res) =>
  res && res.ok && res.type === 'basic' ? caches.open(cacheName).then((c) => c.put(req, res)) : Promise.resolve();

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // cache:'reload' bypasses the HTTP cache so a new version never precaches stale bytes.
    await c.addAll(CORE.map((u) => new Request(u, { cache: 'reload' })));         // must all succeed
    await Promise.allSettled(OPTIONAL.map((u) =>                                    // must never brick install
      fetch(new Request(u, { cache: 'reload' })).then((r) => r.ok && c.put(u, r))));
  })());
  // No unconditional skipWaiting: a mid-sale takeover would mix old page JS with new assets.
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, RUNTIME]);
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(PREFIX) && !keep.has(k)).map((k) => caches.delete(k)));
    // Legacy v1..v18 caches were named 'tajer-vNN' — matched by PREFIX above.
    // Navigation preload deliberately off: shell is cache-first, a preload would be wasted bandwidth.
    await self.clients.claim();
  })());
});

async function shellFirst(e) {
  // Versioned shell = instant, consistent HTML+i18n pair. Network only if shell is missing.
  const cached = await caches.match(INDEX, { cacheName: SHELL });
  if (cached) return cached;
  try {
    const net = await Promise.race([
      fetch(e.request),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), NAV_TIMEOUT)),
    ]);
    e.waitUntil(put(SHELL, INDEX, net.clone()));
    return net;
  } catch {
    return (await caches.match(INDEX, { ignoreSearch: true })) ||
      new Response('<!doctype html><meta charset=utf-8><title>TAJER</title><p>Hors-ligne. Reconnectez-vous une fois pour installer TAJER.',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

async function assets(e) {
  const pinned = await caches.match(e.request, { cacheName: SHELL, ignoreSearch: true });
  if (pinned) return pinned;                                   // shell assets: cache-only within a version
  const cached = await caches.match(e.request, { cacheName: RUNTIME, ignoreSearch: true });
  const net = fetch(e.request).then((r) => { e.waitUntil(put(RUNTIME, e.request, r.clone())); return r; });
  if (cached) { e.waitUntil(net.catch(() => {})); return cached; }
  return net.catch(() => Response.error());
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;                       // never cache mutations
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;            // no third-party cache poisoning
  if (request.mode === 'navigate') return e.respondWith(shellFirst(e));
  if (url.pathname.endsWith('/service-worker.js')) return;
  e.respondWith(assets(e));                                   // everything else: SWR
});
