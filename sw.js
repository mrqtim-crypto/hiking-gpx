const APP_CACHE = 'hiking-gpx-app-v10';
const TILE_CACHE = 'rudy-tiles-v1';

const APP_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './src/app.js',
  './src/gpx.js',
  './src/storage.js',
  './src/mapCanvas.js',
  './src/elevationCanvas.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(APP_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== APP_CACHE && k !== TILE_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // 魯地圖圖磚：優先讀離線快取，沒有再走網路
  if (url.includes('tile.happyman.idv.tw/map/rudy/')) {
    event.respondWith(
      caches.open(TILE_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => cached || fetch(event.request))
      )
    );
    return;
  }

  // App Shell：Cache First（離線飛航模式秒開），並背景更新或 fallback
  if (url.startsWith(self.location.origin)) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});
