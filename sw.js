const CACHE_NAME = 'apx-thermal-auto';
const ASSETS = ['./', './index.html', './style.css', './app.js', './manifest.json'];

// Activation immédiate sans attendre la fermeture de l'app
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-First : vérifie toujours GitHub en premier, sinon utilise le cache hors-ligne
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((networkResponse) => {
        const clone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return networkResponse;
      })
      .catch(() => caches.match(e.request))
  );
});
