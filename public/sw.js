// Service worker: makes the game work offline after the first visit.
//  - The app itself and the team data are saved when the app is first opened.
//  - Team data tries the network first (so the weekly update shows up) and falls back to the saved copy.
//  - Everything else is served from the saved copy instantly and refreshed in the background.
const VERSION = 'v2';
const SHELL = `cc-shell-${VERSION}`;
const DATA = `cc-data-${VERSION}`;
const CORE = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

const assetsIn = (html) => [...html.matchAll(/(?:src|href)="(\.?\/?assets\/[^"]+)"/g)].map((m) => (m[1].startsWith('.') ? m[1] : './' + m[1].replace(/^\//, '')));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(CORE);
    try {
      const res = await fetch('./', { cache: 'no-store' });
      const html = await res.clone().text();
      await shell.put('./', res);
      await shell.addAll(assetsIn(html));
    } catch (e) { /* offline during install: runtime caching will fill in */ }
    try {
      const data = await caches.open(DATA);
      const res = await fetch('./data/manifest.json', { cache: 'no-store' });
      const manifest = await res.clone().json();
      await data.put('./data/manifest.json', res);
      await Promise.all(manifest.teams.map((t) => data.add(`./data/teams/${t.abbr}.json`)));
    } catch (e) { /* data will be cached as it is used */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== DATA) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function pruneAssets(html) {
  const keep = new Set(assetsIn(html).map((a) => new URL(a, self.registration.scope).href));
  const shell = await caches.open(SHELL);
  for (const req of await shell.keys()) {
    if (req.url.includes('/assets/') && !keep.has(req.url)) await shell.delete(req);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes('/data/')) {
    event.respondWith((async () => {
      const cache = await caches.open(DATA);
      try {
        const fresh = await fetch(req, { cache: 'no-cache' });
        if (fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
        if (hit) return hit;
        throw e;
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
    const refresh = fetch(req).then(async (res) => {
      if (res.ok) {
        cache.put(req, res.clone());
        if (req.mode === 'navigate') pruneAssets(await res.clone().text()).catch(() => {});
      }
      return res;
    }).catch(() => undefined);
    if (hit) {
      event.waitUntil(refresh);
      return hit;
    }
    const res = await refresh;
    if (res) return res;
    if (req.mode === 'navigate') {
      const home = await cache.match('./', { ignoreVary: true });
      if (home) return home;
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});
