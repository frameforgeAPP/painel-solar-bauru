const CACHE_NAME = 'solar-monitor-v8';

self.addEventListener('install', (e) => {
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(keys.map((key) => {
                if (key !== CACHE_NAME) return caches.delete(key);
            }));
        })
    );
});

self.addEventListener('fetch', (e) => {
    // Estratégia: Tenta rede, se falhar vai pro cache
    e.respondWith(
        fetch(e.request).catch(() => caches.match(e.request))
    );
});