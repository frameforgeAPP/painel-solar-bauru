// Item 3 & 9: Cache offline + versionamento automático
const CACHE_NAME = 'solar-monitor-v33';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './manifest.json',
    './icon-v2.png'
];

self.addEventListener('install', (e) => {
    // Pré-cacheia todos os assets locais para funcionar offline
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS_TO_CACHE))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    // Remove caches antigos automaticamente (cache-busting automático)
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(keys.map((key) => {
                if (key !== CACHE_NAME) return caches.delete(key);
            }));
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    const isLocalAsset = url.origin === self.location.origin;

    if (isLocalAsset) {
        // Estratégia Network-First para assets locais → garante atualização automática e obrigatória do app
        e.respondWith(
            fetch(e.request).then(response => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
                return response;
            }).catch(() => {
                return caches.match(e.request);
            })
        );
    } else {
        // Estratégia Network-First para APIs externas (Firebase, Solax, Clima)
        e.respondWith(
            fetch(e.request).catch(() => caches.match(e.request))
        );
    }
});