const CACHE = 'gitdrop-shell-v2';
function isStaticAsset(pathname) {
  return (
    pathname.startsWith('/_next/static/') ||
    pathname === '/icon.png' ||
    pathname === '/apple-icon.png' ||
    pathname === '/favicon.ico' ||
    pathname === '/icon' ||
    pathname === '/apple-icon'
  );
}
async function cacheShell(extraAssets = []) {
  const cache = await caches.open(CACHE);
  const response = await fetch('/', { cache: 'reload' });
  if (!response.ok) throw new Error('Shell unavailable');
  const html = await response.clone().text();
  await cache.put('/', response);
  const assets = new Set(['/icon.png', '/favicon.ico', ...extraAssets]);
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const url = new URL(match[1].replaceAll('&amp;', '&'), self.location.origin);
    if (url.origin === self.location.origin && isStaticAsset(url.pathname))
      assets.add(url.href);
  }
  await Promise.all(
    [...assets].map(async (value) => {
      const url = new URL(value, self.location.origin);
      if (url.origin !== self.location.origin || !isStaticAsset(url.pathname)) return;
      const asset = await fetch(url, { cache: 'reload' });
      if (asset.ok) await cache.put(url.href, asset);
    }),
  );
}
self.addEventListener('install', (event) =>
  event.waitUntil(cacheShell().then(() => self.skipWaiting())),
);
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith('gitdrop-shell-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  ),
);
self.addEventListener('message', (event) => {
  if (event.data?.type === 'CACHE_SHELL')
    event.waitUntil(cacheShell(Array.isArray(event.data.assets) ? event.data.assets : []));
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/')
  )
    return;
  if (request.mode === 'navigate')
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE);
            await cache.put('/', response.clone());
          }
          return response;
        })
        .catch(
          async () =>
            (await caches.match('/')) ||
            new Response('Open Gitdrop online once to cache the application.', { status: 503 }),
        ),
    );
  else if (isStaticAsset(url.pathname))
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then(async (response) => {
            if (response.ok) {
              const cache = await caches.open(CACHE);
              await cache.put(request, response.clone());
            }
            return response;
          }),
      ),
    );
});
