/**
 * 本機離線儲存（IndexedDB 軌跡管理 + Cache API 矩形範圍魯地圖圖磚管理）
 */

const DB_NAME = 'hiking-gpx-db';
const DB_VERSION = 1;
const STORE_TRACKS = 'tracks';
const STORE_META = 'meta';
export const TILE_CACHE_NAME = 'rudy-tiles-v1';
export const RUDY_TILE_URL = 'https://tile.happyman.idv.tw/map/rudy/{z}/{x}/{y}.png';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TRACKS)) {
        db.createObjectStore(STORE_TRACKS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllStoredTracks() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TRACKS, 'readonly');
    const req = tx.objectStore(STORE_TRACKS).getAll();
    req.onsuccess = () => {
      const list = req.result || [];
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      resolve(list);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveStoredTrack(track) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TRACKS, 'readwrite');
    tx.objectStore(STORE_TRACKS).put(track);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getMeta(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readonly');
    const req = tx.objectStore(STORE_META).get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}

export async function setMeta(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 經緯度轉 Web Mercator 圖磚座標
 */
export function latLonToTile(lat, lon, z) {
  const n = Math.pow(2, z);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y))
  };
}

export function formatTileUrl(z, x, y) {
  return RUDY_TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

/**
 * 計算分層智慧離線圖磚 URL：
 * - Z10~Z15：整條軌跡「外接矩形＋四週外擴 2km」
 * - Z16：沿線左右 ±1.0km 走廊
 * - Z17：沿線左右 ±0.4km 高清走廊
 */
export function computeBoundingBoxTiles(points, paddingKm = 2.0) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  const midLat = (minLat + maxLat) / 2;
  const cosMid = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const dLat = paddingKm / 111.32;
  const dLon = paddingKm / (111.32 * cosMid);

  const padMinLat = Math.max(-85, minLat - dLat);
  const padMaxLat = Math.min(85, maxLat + dLat);
  const padMinLon = Math.max(-180, minLon - dLon);
  const padMaxLon = Math.min(180, maxLon + dLon);

  const MAX_TILES = 2200;
  const urlSet = new Set();

  // 1. Z10~Z15：大矩形外擴 2km
  for (const z of [10, 11, 12, 13, 14, 15]) {
    const topLeft = latLonToTile(padMaxLat, padMinLon, z);
    const botRight = latLonToTile(padMinLat, padMaxLon, z);
    for (let x = topLeft.x; x <= botRight.x; x++) {
      for (let y = topLeft.y; y <= botRight.y; y++) {
        urlSet.add(formatTileUrl(z, x, y));
        if (urlSet.size >= MAX_TILES) return Array.from(urlSet);
      }
    }
  }

  // 2. Z16 (±1.0km) 與 Z17 (±0.4km) 沿線走廊
  const addCorridorTiles = (z, bufferKm) => {
    const bLat = bufferKm / 111.32;
    const bLon = bufferKm / (111.32 * cosMid);
    // 依圖磚邊長約 280~550m 進行適度點位取樣，避免對數萬點重複計算
    const step = Math.max(1, Math.floor(points.length / 400));
    for (let i = 0; i < points.length; i += step) {
      const p = points[i];
      const tl = latLonToTile(Math.min(85, p.lat + bLat), Math.max(-180, p.lon - bLon), z);
      const br = latLonToTile(Math.max(-85, p.lat - bLat), Math.min(180, p.lon + bLon), z);
      for (let x = tl.x; x <= br.x; x++) {
        for (let y = tl.y; y <= br.y; y++) {
          urlSet.add(formatTileUrl(z, x, y));
          if (urlSet.size >= MAX_TILES) return;
        }
      }
    }
    // 確保終點也被涵蓋
    const last = points[points.length - 1];
    const tl = latLonToTile(Math.min(85, last.lat + bLat), Math.max(-180, last.lon - bLon), z);
    const br = latLonToTile(Math.max(-85, last.lat - bLat), Math.min(180, last.lon + bLon), z);
    for (let x = tl.x; x <= br.x; x++) {
      for (let y = tl.y; y <= br.y; y++) {
        urlSet.add(formatTileUrl(z, x, y));
        if (urlSet.size >= MAX_TILES) return;
      }
    }
  };

  addCorridorTiles(16, 1.0);
  if (urlSet.size < MAX_TILES) {
    addCorridorTiles(17, 0.4);
  }

  return Array.from(urlSet);
}

/**
 * 下載矩形範圍內的魯地圖圖磚至 Cache API
 */
export async function downloadTilesForTrack(track, onProgress) {
  const urls = computeBoundingBoxTiles(track.points, 2.0);
  const cache = await caches.open(TILE_CACHE_NAME);

  let done = 0;
  let totalBytes = 0;
  const total = urls.length;
  const CONCURRENCY = 4;
  let cursor = 0;

  async function worker() {
    while (cursor < total) {
      const idx = cursor++;
      const url = urls[idx];
      try {
        const existing = await cache.match(url);
        if (existing) {
          const blob = await existing.clone().blob();
          totalBytes += blob.size;
        } else {
          const res = await fetch(url, { mode: 'cors' });
          if (res.ok) {
            const clone = res.clone();
            const blob = await clone.blob();
            totalBytes += blob.size;
            await cache.put(url, res);
          }
        }
      } catch {
        // 忽略單張圖磚網路失敗，不中斷整體下載
      } finally {
        done++;
        if (onProgress) onProgress(done, total);
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker());
  await Promise.all(workers);

  track.tileKeys = urls;
  track.tileBytes = totalBytes;
  await saveStoredTrack(track);
  return { count: urls.length, bytes: totalBytes };
}

/**
 * 刪除軌跡，並自動刪除「僅屬於該軌跡、未被其他軌跡共用」的離線圖磚
 */
export async function deleteTrackAndUnusedTiles(trackId) {
  const allTracks = await getAllStoredTracks();
  const target = allTracks.find((t) => t.id === trackId);
  if (!target) return;

  const sharedSet = new Set();
  for (const t of allTracks) {
    if (t.id !== trackId && Array.isArray(t.tileKeys)) {
      for (const k of t.tileKeys) sharedSet.add(k);
    }
  }

  if (Array.isArray(target.tileKeys) && target.tileKeys.length > 0 && 'caches' in window) {
    const cache = await caches.open(TILE_CACHE_NAME);
    const toDelete = target.tileKeys.filter((k) => !sharedSet.has(k));
    await Promise.all(toDelete.map((url) => cache.delete(url)));
  }

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TRACKS, 'readwrite');
    tx.objectStore(STORE_TRACKS).delete(trackId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 統計目前離線快取總容量（支援 iOS Safari StorageManager API）
 */
export async function getStorageUsageSummary(tracks) {
  let uniqueTilesCount = 0;
  const uniqueUrls = new Set();
  let sumTrackBytes = 0;

  for (const t of tracks) {
    if (Array.isArray(t.tileKeys)) {
      for (const k of t.tileKeys) uniqueUrls.add(k);
    }
    if (t.tileBytes) sumTrackBytes += t.tileBytes;
  }
  uniqueTilesCount = uniqueUrls.size;

  let usageMb = null;
  let quotaMb = null;
  if (navigator.storage && typeof navigator.storage.estimate === 'function') {
    try {
      const est = await navigator.storage.estimate();
      if (typeof est.usage === 'number') usageMb = est.usage / (1024 * 1024);
      if (typeof est.quota === 'number') quotaMb = est.quota / (1024 * 1024);
    } catch {
      // 忽略部分瀏覽器不支援
    }
  }

  return {
    uniqueTilesCount,
    approxTilesMb: sumTrackBytes / (1024 * 1024),
    usageMb,
    quotaMb
  };
}

/**
 * 僅清空所有離線魯地圖圖磚，保留已匯入的 GPX 軌跡
 */
export async function clearAllTileCache() {
  if ('caches' in window) {
    await caches.delete(TILE_CACHE_NAME);
  }
  const allTracks = await getAllStoredTracks();
  for (const t of allTracks) {
    t.tileKeys = [];
    t.tileBytes = 0;
    await saveStoredTrack(t);
  }
}
