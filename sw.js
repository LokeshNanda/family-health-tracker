// Service worker — cache-first app shell.
// DEPLOY CHECKLIST: bump CACHE on EVERY deploy or phones keep the old version.
const CACHE = 'fht-v8';

const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/fmt.js',
  './js/db.js',
  './js/views.js',
  './js/backup.js',
  './js/photos.js',
  './js/vitals.js',
  './js/vaccines.js',
  './js/detail.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).catch(() => {
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
