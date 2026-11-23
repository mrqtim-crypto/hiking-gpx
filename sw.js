const APP_CACHE = 'hiking-gpx-app-v26';
const TILE_CACHE = 'rudy-tiles-v1';
const DEM_CACHE = 'dem-tiles-v1';

const APP_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './src/app.js',
  './src/gpx.js',
  './src/storage.js',
  './src/mapCanvas.js',
  './src/map3d.js',
  './src/elevationCanvas.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js'
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
          .filter((k) => k !== APP_CACHE && k !== TILE_CACHE && k !== DEM_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // 魯地圖圖磚：優先讀離線快取，沒有且在線時才走網路（離線靜默失敗避免觸發 iOS 網路警告）
  if (url.includes('tile.happyman.idv.tw/map/rudy/')) {
    event.respondWith(
      caches.open(TILE_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => {
          if (cached) return cached;
          return fetch(event.request).catch(() => new Response('', { status: 404 }));
        })
      )
    );
    return;
  }

  // DEM 高程圖磚（3D 地形）：優先讀離線快取，離線靜默失敗
  if (url.includes('tiles.mapterhorn.com/')) {
    event.respondWith(
      caches.open(DEM_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => {
          if (cached) return cached;
          return fetch(event.request).catch(() => new Response('', { status: 404 }));
        })
      )
    );
    return;
  }

  // 第三方 CDN（如 MapLibre GL JS/CSS）：從 APP_CACHE 離線優先讀取
  if (url.startsWith('https://unpkg.com/maplibre-gl@')) {
    event.respondWith(
      caches.open(APP_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => cached || fetch(event.request))
      )
    );
    return;
  }

  // 網頁導航請求（從主畫面冷啟動或重開時）：保證優先回傳快取的 index.html
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.open(APP_CACHE).then((cache) =>
        cache.match('./index.html', { ignoreSearch: true }).then(
          (cached) => cached || cache.match('./', { ignoreSearch: true }) || fetch(event.request)
        )
      )
    );
    return;
  }

  // App Shell 靜態資源：Cache First（離線飛航模式秒開）
  if (url.startsWith(self.location.origin)) {
    event.respondWith(
      caches.open(APP_CACHE).then((cache) =>
        cache.match(event.request, { ignoreSearch: true }).then((cached) => cached || fetch(event.request))
      )
    );
  }
});
