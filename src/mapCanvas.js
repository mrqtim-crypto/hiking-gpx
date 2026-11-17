/**
 * 2D Web Mercator Canvas 地圖引擎（純黑 OLED / 暗色魯地圖雙模式、雙指縮放、零空轉省電渲染）
 */

import { projectPointToTrack } from './gpx.js';
import { TILE_CACHE_NAME, formatTileUrl } from './storage.js';

const TILE_SIZE = 256;
const MIN_ZOOM = 7;
const MAX_ZOOM = 19;

function lonToNormX(lon) {
  return (lon + 180) / 360;
}

function latToNormY(lat) {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const clamped = Math.max(-0.9999, Math.min(0.9999, sinLat));
  return 0.5 - Math.log((1 + clamped) / (1 - clamped)) / (4 * Math.PI);
}

function lonToWorldX(lon, zoom) {
  return lonToNormX(lon) * TILE_SIZE * Math.pow(2, zoom);
}

function latToWorldY(lat, zoom) {
  return latToNormY(lat) * TILE_SIZE * Math.pow(2, zoom);
}

function worldXToLon(x, zoom) {
  return (x / (TILE_SIZE * Math.pow(2, zoom))) * 360 - 180;
}

function worldYToLat(y, zoom) {
  const n = Math.PI - (2 * Math.PI * y) / (TILE_SIZE * Math.pow(2, zoom));
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export class MapCanvasController {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.callbacks = callbacks;

    this.width = 0;
    this.height = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);

    // 視角中心與縮放（預設台灣中心）
    this.centerLat = 23.9738;
    this.centerLon = 120.982;
    this.zoom = 14.5;

    this.showRudyMap = false;
    this.track = null;
    this.gps = null; // { lat, lon, accuracy }
    this.heading = null; // 0~360 度（正北為 0）
    this.pin = null; // { lat, lon, ele, distKm }

    // 記憶體中的圖磚快取（LRU 限制最多 120 張避免佔用 iOS 記憶體）
    this.tileMemCache = new Map();
    this.tileLoading = new Set();

    // 觸控與滑鼠互動狀態
    this.activeTouches = new Map();
    this.lastPinchDist = null;
    this.lastPinchMid = null;
    this.dragStart = null;
    this.movedDistance = 0;
    this.isDraggingPin = false;
    this.isMouseDragging = false;
    this.lastMouse = null;

    this.hitWaypoints = []; // 供點擊判斷
    this._rafPending = false;
    this._trackNormPts = [];

    this._bindEvents();
    this.resize();
  }

  /**
   * 單幀合併重繪排程（Zero-Idle Loop：僅在需要更新時排程下一幀，兼顧 120Hz 絲滑與省電）
   */
  scheduleRender() {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      this.render();
    });
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.scheduleRender();
  }

  setTrack(track) {
    this.track = track;
    if (track && track.points) {
      // 預先計算標準化 Web Mercator 座標，避免縮放拖曳時重複呼叫三角函數與對數
      this._trackNormPts = track.points.map((p) => ({
        nx: lonToNormX(p.lon),
        ny: latToNormY(p.lat)
      }));
      this.fitTrackBounds();
    } else {
      this._trackNormPts = [];
      this.scheduleRender();
    }
  }

  setRudyMap(enabled) {
    this.showRudyMap = Boolean(enabled);
    this.scheduleRender();
  }

  setGps(gps) {
    this.gps = gps;
    this.scheduleRender();
  }

  setHeading(heading) {
    this.heading = heading;
    this.scheduleRender();
  }

  setPin(pin) {
    this.pin = pin;
    this.scheduleRender();
  }

  centerOn(lat, lon, targetZoom = null) {
    this.centerLat = lat;
    this.centerLon = lon;
    if (targetZoom !== null) {
      this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, targetZoom));
    }
    this.scheduleRender();
  }

  fitTrackBounds() {
    if (!this.track || this.width <= 0 || this.height <= 0) return;
    const { minLat, maxLat, minLon, maxLon } = this.track.bounds;
    this.centerLat = (minLat + maxLat) / 2;
    this.centerLon = (minLon + maxLon) / 2;

    // 算出剛好包住整條軌跡的 zoom
    for (let z = 16; z >= 10; z -= 0.5) {
      const dx = Math.abs(lonToWorldX(maxLon, z) - lonToWorldX(minLon, z));
      const dy = Math.abs(latToWorldY(minLat, z) - latToWorldY(maxLat, z));
      if (dx < this.width * 0.78 && dy < this.height * 0.78) {
        this.zoom = z;
        break;
      }
    }
    this.scheduleRender();
  }

  latLonToScreen(lat, lon) {
    const cx = lonToWorldX(this.centerLon, this.zoom);
    const cy = latToWorldY(this.centerLat, this.zoom);
    const wx = lonToWorldX(lon, this.zoom);
    const wy = latToWorldY(lat, this.zoom);
    return {
      x: this.width / 2 + (wx - cx),
      y: this.height / 2 + (wy - cy)
    };
  }

  screenToLatLon(sx, sy) {
    const cx = lonToWorldX(this.centerLon, this.zoom);
    const cy = latToWorldY(this.centerLat, this.zoom);
    const wx = cx + (sx - this.width / 2);
    const wy = cy + (sy - this.height / 2);
    return {
      lat: worldYToLat(wy, this.zoom),
      lon: worldXToLon(wx, this.zoom)
    };
  }

  panBy(dx, dy) {
    const cx = lonToWorldX(this.centerLon, this.zoom) - dx;
    const cy = latToWorldY(this.centerLat, this.zoom) - dy;
    this.centerLat = worldYToLat(cy, this.zoom);
    this.centerLon = worldXToLon(cx, this.zoom);
    this.scheduleRender();
  }

  zoomAt(newZoom, anchorX, anchorY) {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    if (clamped === this.zoom) return;

    const before = this.screenToLatLon(anchorX, anchorY);
    this.zoom = clamped;
    const afterScreen = this.latLonToScreen(before.lat, before.lon);
    this.panBy(anchorX - afterScreen.x, anchorY - afterScreen.y);
  }

  _bindEvents() {
    // Touch events（雙指縮放＋單指拖曳＋Tap 點擊）
    this.canvas.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        for (const t of e.changedTouches) {
          this.activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
        }
        if (this.activeTouches.size === 1) {
          const only = Array.from(this.activeTouches.values())[0];
          this.dragStart = { x: only.x, y: only.y };
          this.movedDistance = 0;
          this.lastPinchDist = null;
          this.lastPinchMid = null;
          const rect = this.canvas.getBoundingClientRect();
          this.isDraggingPin = this._isNearPin(only.x - rect.left, only.y - rect.top);
        } else if (this.activeTouches.size === 2) {
          this.isDraggingPin = false;
          const [p1, p2] = Array.from(this.activeTouches.values());
          this.lastPinchDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
          this.lastPinchMid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
          this.movedDistance = 999; // 雙指不觸發 Tap
        }
      },
      { passive: false }
    );

    this.canvas.addEventListener(
      'touchmove',
      (e) => {
        e.preventDefault();
        for (const t of e.changedTouches) {
          if (this.activeTouches.has(t.identifier)) {
            const prev = this.activeTouches.get(t.identifier);
            if (this.activeTouches.size === 1) {
              if (this.isDraggingPin) {
                const rect = this.canvas.getBoundingClientRect();
                this._dragPinToScreen(t.clientX - rect.left, t.clientY - rect.top);
                this.movedDistance += 10;
              } else {
                const dx = t.clientX - prev.x;
                const dy = t.clientY - prev.y;
                this.movedDistance += Math.hypot(dx, dy);
                this.panBy(dx, dy);
              }
            }
            this.activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
          }
        }

        if (this.activeTouches.size === 2) {
          const [p1, p2] = Array.from(this.activeTouches.values());
          const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
          const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
          const rect = this.canvas.getBoundingClientRect();

          if (this.lastPinchDist && this.lastPinchDist > 5) {
            const scale = dist / this.lastPinchDist;
            const deltaZoom = Math.log2(scale);
            this.zoomAt(this.zoom + deltaZoom, mid.x - rect.left, mid.y - rect.top);
          }
          if (this.lastPinchMid) {
            this.panBy(mid.x - this.lastPinchMid.x, mid.y - this.lastPinchMid.y);
          }
          this.lastPinchDist = dist;
          this.lastPinchMid = mid;
        }
      },
      { passive: false }
    );

    const endTouch = (e) => {
      for (const t of e.changedTouches) {
        this.activeTouches.delete(t.identifier);
      }
      if (this.activeTouches.size === 0) {
        if (!this.isDraggingPin && this.movedDistance < 10 && e.changedTouches.length === 1) {
          const rect = this.canvas.getBoundingClientRect();
          const t = e.changedTouches[0];
          this._handleTap(t.clientX - rect.left, t.clientY - rect.top);
        }
        this.isDraggingPin = false;
        this.lastPinchDist = null;
        this.lastPinchMid = null;
      } else if (this.activeTouches.size === 1) {
        this.lastPinchDist = null;
        this.lastPinchMid = null;
      }
    };

    this.canvas.addEventListener('touchend', endTouch, { passive: false });
    this.canvas.addEventListener('touchcancel', endTouch, { passive: false });

    // Mouse fallback（桌面測試用）
    this.canvas.addEventListener('mousedown', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.isDraggingPin = this._isNearPin(e.clientX - rect.left, e.clientY - rect.top);
      this.isMouseDragging = true;
      this.movedDistance = 0;
      this.lastMouse = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.isMouseDragging || !this.lastMouse) return;
      if (this.isDraggingPin) {
        const rect = this.canvas.getBoundingClientRect();
        this._dragPinToScreen(e.clientX - rect.left, e.clientY - rect.top);
        this.movedDistance += 10;
      } else {
        const dx = e.clientX - this.lastMouse.x;
        const dy = e.clientY - this.lastMouse.y;
        this.movedDistance += Math.hypot(dx, dy);
        this.lastMouse = { x: e.clientX, y: e.clientY };
        this.panBy(dx, dy);
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (!this.isMouseDragging) return;
      this.isMouseDragging = false;
      const wasDraggingPin = this.isDraggingPin;
      this.isDraggingPin = false;
      if (!wasDraggingPin && this.movedDistance < 6) {
        const rect = this.canvas.getBoundingClientRect();
        this._handleTap(e.clientX - rect.left, e.clientY - rect.top);
      }
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const factor = e.deltaY < 0 ? 0.35 : -0.35;
        this.zoomAt(this.zoom + factor, e.clientX - rect.left, e.clientY - rect.top);
      },
      { passive: false }
    );
  }

  _isNearPin(sx, sy) {
    if (!this.pin) return false;
    const p = this.latLonToScreen(this.pin.lat, this.pin.lon);
    return Math.hypot(p.x - sx, p.y - sy) <= 34;
  }

  _dragPinToScreen(sx, sy) {
    if (!this.track) return;
    const { lat, lon } = this.screenToLatLon(sx, sy);
    const proj = projectPointToTrack(lat, lon, this.track.points);
    if (this.callbacks.onSelectPinDist) {
      this.callbacks.onSelectPinDist(proj.distKm);
    }
  }

  _handleTap(sx, sy) {
    if (!this.track) return;

    // 1. 先檢查是否點到航點
    for (const hw of this.hitWaypoints) {
      if (Math.hypot(hw.x - sx, hw.y - sy) <= 22) {
        if (this.callbacks.onSelectWaypoint) {
          this.callbacks.onSelectWaypoint(hw.wpt);
        }
        return;
      }
    }

    // 2. 否則將點擊位置投影到軌跡上插橘色圖釘（距離點擊處 60px 內皆可吸附）
    const { lat, lon } = this.screenToLatLon(sx, sy);
    const proj = projectPointToTrack(lat, lon, this.track.points);
    const projScreen = this.latLonToScreen(proj.lat, proj.lon);
    if (Math.hypot(projScreen.x - sx, projScreen.y - sy) <= 65) {
      if (this.callbacks.onSelectPinDist) {
        this.callbacks.onSelectPinDist(proj.distKm);
      }
    }
  }

  /**
   * 讀取圖磚（優先 Cache API 離線快取，其次線上）
   */
  _getTileImage(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (this.tileMemCache.has(key)) {
      return this.tileMemCache.get(key);
    }
    if (this.tileLoading.has(key)) return null;

    this.tileLoading.add(key);
    const url = formatTileUrl(z, x, y);

    (async () => {
      try {
        let blob = null;
        if ('caches' in window) {
          const cache = await caches.open(TILE_CACHE_NAME);
          const cached = await cache.match(url);
          if (cached) blob = await cached.blob();
        }
        if (!blob) {
          const res = await fetch(url, { mode: 'cors' });
          if (res.ok) blob = await res.blob();
        }
        if (!blob) return;

        const img = new Image();
        const objUrl = URL.createObjectURL(blob);
        img.onload = () => {
          URL.revokeObjectURL(objUrl);
          if (this.tileMemCache.size > 200) {
            const firstKey = this.tileMemCache.keys().next().value;
            this.tileMemCache.delete(firstKey);
          }
          this.tileMemCache.set(key, img);
          if (this.showRudyMap) this.scheduleRender();
        };
        img.onerror = () => URL.revokeObjectURL(objUrl);
        img.src = objUrl;
      } catch {
        // 離線且無快取時忽略
      } finally {
        this.tileLoading.delete(key);
      }
    })();

    return null;
  }

  render() {
    const ctx = this.ctx;
    if (!ctx || this.width <= 0 || this.height <= 0) return;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    // 1. 純黑 OLED 背景
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, this.width, this.height);

    // 2. 若開啟魯地圖模式，繪製預載/線上圖磚並進行低眩光暗化處理
    if (this.showRudyMap) {
      this._renderRudyTiles(ctx);
    }

    // 3. 繪製 GPX 軌跡線
    if (this.track && this.track.points.length > 1) {
      this._renderTrack(ctx);
      this._renderWaypoints(ctx);
    }

    // 4. 繪製目前 GPS 藍點＋誤差圈＋羅盤方向扇形
    if (this.gps) {
      this._renderGps(ctx);
    }

    // 5. 繪製橘色前方圖釘
    if (this.pin) {
      this._renderPin(ctx);
    }

    ctx.restore();
  }

  _renderRudyTiles(ctx) {
    // 依據當前縮放匹配 Z7~Z16 圖磚（Z17~Z19 使用 Z16 平滑放大）
    const tileZ = Math.max(MIN_ZOOM, Math.min(16, Math.round(this.zoom)));
    const scaleFactor = Math.pow(2, this.zoom - tileZ);
    const drawSize = TILE_SIZE * scaleFactor;

    const cx = lonToWorldX(this.centerLon, tileZ);
    const cy = latToWorldY(this.centerLat, tileZ);
    const halfW = this.width / (2 * scaleFactor);
    const halfH = this.height / (2 * scaleFactor);

    const minTileX = Math.floor((cx - halfW) / TILE_SIZE);
    const maxTileX = Math.floor((cx + halfW) / TILE_SIZE);
    const minTileY = Math.floor((cy - halfH) / TILE_SIZE);
    const maxTileY = Math.floor((cy + halfH) / TILE_SIZE);
    const maxIndex = Math.pow(2, tileZ) - 1;

    ctx.save();
    // 壓低白底亮度，達到省電且不刺眼的暗色低眩光閱讀效果
    ctx.globalAlpha = 0.78;
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      if (tx < 0 || tx > maxIndex) continue;
      for (let ty = minTileY; ty <= maxTileY; ty++) {
        if (ty < 0 || ty > maxIndex) continue;
        const img = this._getTileImage(tileZ, tx, ty);
        const sx = this.width / 2 + (tx * TILE_SIZE - cx) * scaleFactor;
        const sy = this.height / 2 + (ty * TILE_SIZE - cy) * scaleFactor;
        if (img) {
          ctx.drawImage(img, sx, sy, drawSize + 0.5, drawSize + 0.5);
        } else {
          // 若目標層級尚在載入，嘗試用已快取的上一層級圖磚暫時墊底，消除縮放閃爍
          this._drawFallbackParentTile(ctx, tileZ, tx, ty, sx, sy, drawSize);
        }
      }
    }
    ctx.restore();

    // 疊加微暗遮罩讓綠色軌跡與藍點更突出
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.fillRect(0, 0, this.width, this.height);
  }

  _drawFallbackParentTile(ctx, z, tx, ty, sx, sy, drawSize) {
    for (let dz = 1; dz <= 2; dz++) {
      const pz = z - dz;
      if (pz < MIN_ZOOM) break;
      const factor = Math.pow(2, dz);
      const ptx = Math.floor(tx / factor);
      const pty = Math.floor(ty / factor);
      const key = `${pz}/${ptx}/${pty}`;
      const pImg = this.tileMemCache.get(key);
      if (pImg) {
        const subSize = TILE_SIZE / factor;
        const subX = (tx % factor) * subSize;
        const subY = (ty % factor) * subSize;
        ctx.drawImage(pImg, subX, subY, subSize, subSize, sx, sy, drawSize + 0.5, drawSize + 0.5);
        return;
      }
    }
  }

  _renderTrack(ctx) {
    const normPts = this._trackNormPts;
    if (!normPts || normPts.length < 2) return;

    const worldSize = TILE_SIZE * Math.pow(2, this.zoom);
    const centerWx = lonToNormX(this.centerLon) * worldSize;
    const centerWy = latToNormY(this.centerLat) * worldSize;
    const halfW = this.width / 2;
    const halfH = this.height / 2;

    // 依像素距離進行高速抽稀（距離前一點 < 1.5px 則跳過），大幅提升超長 GPX 縮放流暢度
    const screenPts = [];
    let lastX = -9999;
    let lastY = -9999;
    const len = normPts.length;
    for (let i = 0; i < len; i++) {
      const x = halfW + normPts[i].nx * worldSize - centerWx;
      const y = halfH + normPts[i].ny * worldSize - centerWy;
      if (i === 0 || i === len - 1 || Math.abs(x - lastX) >= 1.5 || Math.abs(y - lastY) >= 1.5) {
        screenPts.push(x, y);
        lastX = x;
        lastY = y;
      }
    }

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const buildPath = () => {
      ctx.beginPath();
      ctx.moveTo(screenPts[0], screenPts[1]);
      for (let i = 2; i < screenPts.length; i += 2) {
        ctx.lineTo(screenPts[i], screenPts[i + 1]);
      }
    };

    // 外層深黑描邊（在魯地圖上也能高對比）
    buildPath();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.lineWidth = 6.5;
    ctx.stroke();

    // 內層螢光綠軌跡
    buildPath();
    ctx.strokeStyle = '#39ff14';
    ctx.lineWidth = 3.2;
    ctx.stroke();

    // 起點與終點標記
    ctx.fillStyle = '#39ff14';
    ctx.beginPath();
    ctx.arc(screenPts[0], screenPts[1], 4.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ff3b30';
    ctx.beginPath();
    ctx.arc(screenPts[screenPts.length - 2], screenPts[screenPts.length - 1], 4.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  _renderWaypoints(ctx) {
    this.hitWaypoints = [];
    const placedBoxes = [];

    ctx.save();
    ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "PingFang TC", sans-serif';
    ctx.textBaseline = 'middle';

    for (const w of this.track.waypoints) {
      const { x, y } = this.latLonToScreen(w.lat, w.lon);
      if (x < -40 || x > this.width + 40 || y < -40 || y > this.height + 40) continue;

      this.hitWaypoints.push({ x, y, wpt: w });

      // 簡易防重疊檢查
      const labelW = Math.min(110, ctx.measureText(w.name).width + 26);
      const box = { x1: x - 10, y1: y - 12, x2: x + labelW, y2: y + 12 };
      const overlaps = placedBoxes.some(
        (b) => !(box.x2 < b.x1 || box.x1 > b.x2 || box.y2 < b.y1 || box.y1 > b.y2)
      );

      // 航點圓底
      ctx.fillStyle = 'rgba(18, 19, 22, 0.9)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // 圖示
      ctx.textAlign = 'center';
      ctx.fillText(w.icon, x, y + 0.5);

      if (!overlaps) {
        placedBoxes.push(box);
        const text = w.name.length > 9 ? `${w.name.slice(0, 8)}…` : w.name;
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = 'rgba(10, 10, 12, 0.85)';
        ctx.beginPath();
        ctx.roundRect(x + 13, y - 9, tw + 10, 18, 5);
        ctx.fill();

        ctx.fillStyle = '#f5f5f7';
        ctx.textAlign = 'left';
        ctx.fillText(text, x + 18, y);
      }
    }
    ctx.restore();
  }

  _renderGps(ctx) {
    const { x, y } = this.latLonToScreen(this.gps.lat, this.gps.lon);
    // 計算誤差半徑像素
    const metersPerPixel =
      (156543.03392 * Math.cos((this.gps.lat * Math.PI) / 180)) / Math.pow(2, this.zoom);
    const accPx = Math.max(12, Math.min(120, (this.gps.accuracy || 15) / metersPerPixel));

    ctx.save();

    // 誤差半徑圓
    ctx.fillStyle = 'rgba(0, 229, 255, 0.14)';
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, accPx, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 電子羅盤方向扇形（正北為 0 度，Canvas 0 rad 為正東，故需減 90 度）
    if (this.heading !== null && Number.isFinite(this.heading)) {
      const rad = ((this.heading - 90) * Math.PI) / 180;
      const spread = (28 * Math.PI) / 180;
      const coneLen = 58;
      const grad = ctx.createRadialGradient(x, y, 4, x, y, coneLen);
      grad.addColorStop(0, 'rgba(0, 229, 255, 0.55)');
      grad.addColorStop(1, 'rgba(0, 229, 255, 0.0)');

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, coneLen, rad - spread, rad + spread);
      ctx.closePath();
      ctx.fill();
    }

    // 中心發光藍點
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, 7.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#00e5ff';
    ctx.beginPath();
    ctx.arc(x, y, 5.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  _renderPin(ctx) {
    const { x, y } = this.latLonToScreen(this.pin.lat, this.pin.lon);
    ctx.save();
    // 可沿軌跡滑動的發光橘色目標游標
    ctx.fillStyle = 'rgba(255, 122, 0, 0.25)';
    ctx.beginPath();
    ctx.arc(x, y, 16, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ff7a00';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // 在橘球上方直接顯示同步距離／海拔小標籤
    if (this.pin.badgeText) {
      ctx.font = '700 11px -apple-system, BlinkMacSystemFont, "PingFang TC", sans-serif';
      const tw = ctx.measureText(this.pin.badgeText).width + 12;
      const bx = Math.max(6, Math.min(this.width - tw - 6, x - tw / 2));
      const by = Math.max(6, y - 34);

      ctx.fillStyle = 'rgba(18, 19, 22, 0.92)';
      ctx.strokeStyle = 'rgba(255, 122, 0, 0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx, by, tw, 20, 6);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.pin.badgeText, bx + tw / 2, by + 10.5);
    }
    ctx.restore();
  }
}
