const CACHE_NAME = 'dostup-pwa-v6';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=5.8',
  './app.js?v=5.8',
  './firebase-config.js',
  './seed-data.js',
  './court-update-config.js',
  './manifest.json?v=2',
  './app-icon-beige-v1.png?v=1',
  './pwa-icon-180.png?v=2',
  './pwa-icon-192.png?v=2',
  './pwa-icon-512.png?v=2'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith('dostup-pwa-') && key !== CACHE_NAME)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request){
  const cache = await caches.open(CACHE_NAME);
  try{
    const response = await fetch(request);
    if(response.ok) cache.put(request, response.clone());
    return response;
  }catch(_err){
    return (await cache.match(request)) || (await caches.match('./'));
  }
}

async function cacheFirst(request){
  const cached = await caches.match(request);
  if(cached) return cached;
  const response = await fetch(request);
  if(response.ok){
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if(request.method !== 'GET') return;
  const url = new URL(request.url);
  if(url.origin !== self.location.origin || !url.pathname.startsWith('/DOSTUP/')) return;
  event.respondWith(request.mode === 'navigate' ? networkFirst(request) : cacheFirst(request));
});
