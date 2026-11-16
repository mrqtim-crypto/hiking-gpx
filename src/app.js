/**
 * 山行 GPX 主應用程式控制器
 * 針對 iPhone Safari / PWA 最佳化：事件驅動零空轉省電、關螢幕即停 GPS 與羅盤
 */

import {
  parseGpxXml,
  buildTrackData,
  projectPointToTrack,
  sampleTrackAtDist,
  getDemoGpxXml
} from './gpx.js';
import {
  getAllStoredTracks,
  saveStoredTrack,
  getMeta,
  setMeta,
  downloadTilesForTrack,
  deleteTrackAndUnusedTiles
} from './storage.js';
import { MapCanvasController } from './mapCanvas.js';
import { ElevationCanvasController } from './elevationCanvas.js';

const DEFAULT_LOCATE_ZOOM = 15.5;

const state = {
  storedTracks: [],
  activeTrack: null,
  showRudyMap: false,
  isTracking: false,
  watchId: null,
  compassActive: false,
  lastHeading: null,
  gps: null, // { lat, lon, accuracy, altitude }
  gpsProjection: null, // { distanceM, distKm, ele, cumGain, cumLoss }
  pinDistKm: null,
  selectedWpt: null
};

// DOM 元素
const el = {
  gpsStatusPill: document.getElementById('gpsStatusPill'),
  gpsStatusText: document.getElementById('gpsStatusText'),
  progressPctText: document.getElementById('progressPctText'),
  progressBarFill: document.getElementById('progressBarFill'),
  valCurEle: document.getElementById('valCurEle'),
  valRemDist: document.getElementById('valRemDist'),
  valRemGain: document.getElementById('valRemGain'),
  valRemLoss: document.getElementById('valRemLoss'),

  btnTrackList: document.getElementById('btnTrackList'),
  btnRudyMap: document.getElementById('btnRudyMap'),
  btnLocate: document.getElementById('btnLocate'),
  locateBtnText: document.getElementById('locateBtnText'),

  emptyState: document.getElementById('emptyState'),
  btnEmptyImport: document.getElementById('btnEmptyImport'),
  btnLoadDemo: document.getElementById('btnLoadDemo'),

  activeTrackBadge: document.getElementById('activeTrackBadge'),
  activeTrackName: document.getElementById('activeTrackName'),
  activeTrackDir: document.getElementById('activeTrackDir'),

  pinTooltip: document.getElementById('pinTooltip'),
  pinTooltipText: document.getElementById('pinTooltipText'),
  btnClearPin: document.getElementById('btnClearPin'),

  trackModal: document.getElementById('trackModal'),
  btnCloseTrackModal: document.getElementById('btnCloseTrackModal'),
  gpxFileInput: document.getElementById('gpxFileInput'),
  trackListContainer: document.getElementById('trackListContainer'),
  downloadBanner: document.getElementById('downloadBanner'),
  downloadBannerText: document.getElementById('downloadBannerText'),
  downloadBannerPct: document.getElementById('downloadBannerPct'),
  downloadBarFill: document.getElementById('downloadBarFill'),

  wptModal: document.getElementById('wptModal'),
  btnCloseWptModal: document.getElementById('btnCloseWptModal'),
  wptCardIcon: document.getElementById('wptCardIcon'),
  wptCardName: document.getElementById('wptCardName'),
  wptCardMeta: document.getElementById('wptCardMeta'),
  wptCardDesc: document.getElementById('wptCardDesc'),
  btnPinAtWpt: document.getElementById('btnPinAtWpt')
};

const mapCtrl = new MapCanvasController(document.getElementById('mapCanvas'), {
  onSelectPinDist: (distKm) => setPinByDist(distKm),
  onSelectWaypoint: (wpt) => openWaypointModal(wpt)
});

const eleCtrl = new ElevationCanvasController(document.getElementById('elevationCanvas'), (distKm) => {
  setPinByDist(distKm);
});

/* ---------------- 初始化 ---------------- */

async function init() {
  registerServiceWorker();
  bindUiEvents();

  window.addEventListener('resize', () => {
    mapCtrl.resize();
    eleCtrl.resize();
  });

  // 極致省電：偵測關閉螢幕（鎖屏）或切換背景時立即關閉 GPS 與羅盤
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.isTracking) {
      stopTracking();
    }
  });
  window.addEventListener('pagehide', () => {
    if (state.isTracking) stopTracking();
  });

  state.storedTracks = await getAllStoredTracks();
  const lastId = await getMeta('activeTrackId');
  const found = state.storedTracks.find((t) => t.id === lastId) || state.storedTracks[0] || null;
  if (found) {
    await activateTrack(found.id);
  } else {
    updateMetricsUI();
  }
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

/* ---------------- UI 事件綁定 ---------------- */

function bindUiEvents() {
  el.btnRudyMap.addEventListener('click', () => {
    state.showRudyMap = !state.showRudyMap;
    el.btnRudyMap.classList.toggle('active', state.showRudyMap);
    mapCtrl.setRudyMap(state.showRudyMap);
  });

  el.btnLocate.addEventListener('click', () => {
    if (!state.isTracking) {
      startTracking();
    } else if (state.gps) {
      // 定位中再次點擊：回到中心與適當大小
      mapCtrl.centerOn(state.gps.lat, state.gps.lon, DEFAULT_LOCATE_ZOOM);
    }
  });

  // 長按定位鈕可手動提前停止定位（除了關螢幕自動停之外的備援）
  let locatePressTimer = null;
  el.btnLocate.addEventListener('touchstart', () => {
    if (!state.isTracking) return;
    locatePressTimer = setTimeout(() => {
      stopTracking();
    }, 650);
  });
  const clearLocatePress = () => {
    if (locatePressTimer) {
      clearTimeout(locatePressTimer);
      locatePressTimer = null;
    }
  };
  el.btnLocate.addEventListener('touchend', clearLocatePress);
  el.btnLocate.addEventListener('touchcancel', clearLocatePress);

  el.btnClearPin.addEventListener('click', () => {
    clearPin();
  });

  el.btnTrackList.addEventListener('click', openTrackModal);
  el.btnEmptyImport.addEventListener('click', () => {
    openTrackModal();
    el.gpxFileInput.click();
  });
  el.btnCloseTrackModal.addEventListener('click', closeTrackModal);
  el.trackModal.addEventListener('click', (e) => {
    if (e.target === el.trackModal) closeTrackModal();
  });

  el.btnLoadDemo.addEventListener('click', async () => {
    await importGpxText(getDemoGpxXml(), '合歡北峰示範路線.gpx', true);
  });

  el.gpxFileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    for (const file of files) {
      try {
        const text = await file.text();
        await importGpxText(text, file.name, true);
      } catch (err) {
        alert(`匯入 ${file.name} 失敗：${err.message}`);
      }
    }
    el.gpxFileInput.value = '';
  });

  el.btnCloseWptModal.addEventListener('click', () => el.wptModal.classList.add('hidden'));
  el.wptModal.addEventListener('click', (e) => {
    if (e.target === el.wptModal) el.wptModal.classList.add('hidden');
  });
  el.btnPinAtWpt.addEventListener('click', () => {
    if (state.selectedWpt) {
      setPinByDist(state.selectedWpt.distKm);
      mapCtrl.centerOn(state.selectedWpt.lat, state.selectedWpt.lon);
      el.wptModal.classList.add('hidden');
    }
  });
}

/* ---------------- GPS 定位與電子羅盤 ---------------- */

async function startTracking() {
  if (!('geolocation' in navigator)) {
    alert('此裝置瀏覽器不支援 GPS 定位');
    return;
  }

  // 在使用者點擊事件內請求 iOS 電子羅盤權限
  await requestCompassPermissionAndStart();

  state.isTracking = true;
  el.btnLocate.classList.add('active');
  el.locateBtnText.textContent = '定位中';
  setStatusPill('status-searching', '搜尋衛星中...');

  let firstFix = true;

  state.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy, altitude } = pos.coords;
      state.gps = {
        lat: latitude,
        lon: longitude,
        accuracy: Math.round(accuracy || 0),
        altitude: Number.isFinite(altitude) ? Math.round(altitude) : null
      };

      mapCtrl.setGps(state.gps);
      if (firstFix) {
        firstFix = false;
        mapCtrl.centerOn(latitude, longitude, DEFAULT_LOCATE_ZOOM);
      }
      recalculateNavigation();
    },
    (err) => {
      let msg = '無法取得定位';
      if (err.code === 1) msg = '未授權定位權限';
      else if (err.code === 2) msg = '衛星訊號微弱';
      else if (err.code === 3) msg = '定位逾時';
      setStatusPill('status-off', msg);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000
    }
  );
}

function stopTracking() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  stopCompass();
  state.isTracking = false;
  el.btnLocate.classList.remove('active');
  el.locateBtnText.textContent = '定位';
  setStatusPill('status-idle', '待機中（省電）');
}

async function requestCompassPermissionAndStart() {
  try {
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'
    ) {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm !== 'granted') return;
    }
    window.addEventListener('deviceorientation', handleDeviceOrientation, true);
    state.compassActive = true;
  } catch {
    // 若使用者拒絕或裝置不支援羅盤，仍可正常使用 GPS
  }
}

function stopCompass() {
  if (state.compassActive) {
    window.removeEventListener('deviceorientation', handleDeviceOrientation, true);
    state.compassActive = false;
  }
  state.lastHeading = null;
  mapCtrl.setHeading(null);
}

function handleDeviceOrientation(e) {
  let heading = null;
  if (typeof e.webkitCompassHeading === 'number' && Number.isFinite(e.webkitCompassHeading)) {
    heading = e.webkitCompassHeading;
  } else if (typeof e.alpha === 'number' && Number.isFinite(e.alpha)) {
    heading = (360 - e.alpha) % 360;
  }
  if (heading === null) return;

  // 節流：角度變化超過 2 度才重繪，極度省電
  if (state.lastHeading !== null) {
    let diff = Math.abs(heading - state.lastHeading);
    if (diff > 180) diff = 360 - diff;
    if (diff < 2) return;
  }

  state.lastHeading = heading;
  mapCtrl.setHeading(heading);
}

/* ---------------- 導航計算與圖釘 ---------------- */

function recalculateNavigation() {
  if (!state.activeTrack) {
    updateMetricsUI();
    return;
  }

  if (state.gps) {
    const proj = projectPointToTrack(state.gps.lat, state.gps.lon, state.activeTrack.points);
    state.gpsProjection = proj;
    eleCtrl.setCurrentDistKm(proj.distKm);

    const acc = state.gps.accuracy;
    const offM = Math.round(proj.distanceM);
    if (offM <= 25) {
      setStatusPill('status-ok', `在軌跡上 (±${acc}m)`);
    } else if (offM <= 50) {
      setStatusPill('status-warn', `輕微偏移 ${offM}m`);
    } else {
      setStatusPill('status-off', `偏離軌跡 ${offM}m`);
    }
  } else {
    state.gpsProjection = null;
    eleCtrl.setCurrentDistKm(null);
  }

  updateMetricsUI();
  updatePinTooltip();
}

function updateMetricsUI() {
  const track = state.activeTrack;
  if (!track) {
    el.valCurEle.textContent = '--';
    el.valRemDist.textContent = '--';
    el.valRemGain.textContent = '--';
    el.valRemLoss.textContent = '--';
    el.progressPctText.textContent = '0%';
    el.progressBarFill.style.width = '0%';
    return;
  }

  if (state.gpsProjection) {
    const proj = state.gpsProjection;
    const curEle = state.gps?.altitude ?? Math.round(proj.ele);
    const remDist = Math.max(0, track.totalDistKm - proj.distKm);
    const remGain = Math.max(0, Math.round(track.totalGain - proj.cumGain));
    const remLoss = Math.max(0, Math.round(track.totalLoss - proj.cumLoss));
    const pct = track.totalDistKm > 0 ? Math.min(100, Math.max(0, Math.round((proj.distKm / track.totalDistKm) * 100))) : 0;

    el.valCurEle.textContent = curEle.toLocaleString();
    el.valRemDist.textContent = remDist.toFixed(1);
    el.valRemGain.textContent = `+${remGain}`;
    el.valRemLoss.textContent = `-${remLoss}`;
    el.progressPctText.textContent = `${pct}%`;
    el.progressBarFill.style.width = `${pct}%`;
  } else {
    // 尚未開啟定位時顯示路線總覽數值
    el.valCurEle.textContent = `${track.points[0].ele}`;
    el.valRemDist.textContent = track.totalDistKm.toFixed(1);
    el.valRemGain.textContent = `+${track.totalGain}`;
    el.valRemLoss.textContent = `-${track.totalLoss}`;
    el.progressPctText.textContent = '0%';
    el.progressBarFill.style.width = '0%';
  }
}

function setStatusPill(cls, text) {
  el.gpsStatusPill.className = `status-pill ${cls}`;
  el.gpsStatusText.textContent = text;
}

function setPinByDist(distKm) {
  if (!state.activeTrack) return;
  state.pinDistKm = distKm;
  const sample = sampleTrackAtDist(distKm, state.activeTrack);
  mapCtrl.setPin(sample);
  eleCtrl.setPinDistKm(distKm);
  updatePinTooltip();
}

function clearPin() {
  state.pinDistKm = null;
  mapCtrl.setPin(null);
  eleCtrl.setPinDistKm(null);
  el.pinTooltip.classList.add('hidden');
}

function updatePinTooltip() {
  if (state.pinDistKm === null || !state.activeTrack) {
    el.pinTooltip.classList.add('hidden');
    return;
  }
  const pinSample = sampleTrackAtDist(state.pinDistKm, state.activeTrack);
  if (state.gpsProjection) {
    const deltaDist = pinSample.distKm - state.gpsProjection.distKm;
    const deltaEle = Math.round(pinSample.ele - (state.gps?.altitude ?? state.gpsProjection.ele));
    const distLabel = deltaDist >= 0 ? `距目前 ${deltaDist.toFixed(1)} km` : `在後方 ${Math.abs(deltaDist).toFixed(1)} km`;
    const eleSign = deltaEle >= 0 ? `+${deltaEle}m` : `${deltaEle}m`;
    el.pinTooltipText.textContent = `${distLabel} · 海拔 ${pinSample.ele}m (${eleSign})`;
  } else {
    el.pinTooltipText.textContent = `里程 ${pinSample.distKm.toFixed(1)} km · 海拔 ${pinSample.ele}m`;
  }
  el.pinTooltip.classList.remove('hidden');
}

/* ---------------- 軌跡清單管理與自動下載/刪除 ---------------- */

async function importGpxText(xmlText, fileName, autoDownloadTiles = true) {
  const parsed = parseGpxXml(xmlText, fileName);
  const id = `trk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const stored = {
    id,
    name: parsed.name,
    points: parsed.points,
    waypoints: parsed.waypoints,
    reversed: false,
    tileKeys: [],
    tileBytes: 0,
    createdAt: Date.now()
  };

  await saveStoredTrack(stored);
  state.storedTracks = await getAllStoredTracks();
  await activateTrack(id);
  renderTrackList();

  if (autoDownloadTiles && navigator.onLine) {
    await runTileDownload(stored);
  }
}

async function runTileDownload(storedTrack) {
  el.downloadBanner.classList.remove('hidden');
  el.downloadBannerText.textContent = `正在預載「${storedTrack.name}」矩形魯地圖...`;
  el.downloadBannerPct.textContent = '0%';
  el.downloadBarFill.style.width = '0%';

  await downloadTilesForTrack(storedTrack, (done, total) => {
    const pct = total > 0 ? Math.round((done / total) * 100) : 100;
    el.downloadBannerPct.textContent = `${pct}% (${done}/${total})`;
    el.downloadBarFill.style.width = `${pct}%`;
  });

  el.downloadBanner.classList.add('hidden');
  state.storedTracks = await getAllStoredTracks();
  renderTrackList();
}

async function activateTrack(trackId) {
  const raw = state.storedTracks.find((t) => t.id === trackId);
  if (!raw) return;

  state.activeTrack = buildTrackData(raw);
  await setMeta('activeTrackId', trackId);

  el.emptyState.classList.add('hidden');
  el.activeTrackBadge.classList.remove('hidden');
  el.activeTrackName.textContent = state.activeTrack.name;
  el.activeTrackDir.textContent = state.activeTrack.reversed ? '反向' : '正向';
  el.activeTrackDir.classList.toggle('reversed', state.activeTrack.reversed);

  clearPin();
  mapCtrl.setTrack(state.activeTrack);
  eleCtrl.setTrack(state.activeTrack);
  recalculateNavigation();
  renderTrackList();
}

async function toggleTrackDirection(trackId) {
  const raw = state.storedTracks.find((t) => t.id === trackId);
  if (!raw) return;
  raw.reversed = !raw.reversed;
  await saveStoredTrack(raw);
  state.storedTracks = await getAllStoredTracks();
  if (state.activeTrack && state.activeTrack.id === trackId) {
    await activateTrack(trackId);
  } else {
    renderTrackList();
  }
}

async function removeTrack(trackId) {
  await deleteTrackAndUnusedTiles(trackId);
  state.storedTracks = await getAllStoredTracks();

  if (state.activeTrack && state.activeTrack.id === trackId) {
    state.activeTrack = null;
    clearPin();
    if (state.storedTracks.length > 0) {
      await activateTrack(state.storedTracks[0].id);
    } else {
      el.emptyState.classList.remove('hidden');
      el.activeTrackBadge.classList.add('hidden');
      mapCtrl.setTrack(null);
      eleCtrl.setTrack(null);
      updateMetricsUI();
    }
  }
  renderTrackList();
}

function openTrackModal() {
  renderTrackList();
  el.trackModal.classList.remove('hidden');
}

function closeTrackModal() {
  el.trackModal.classList.add('hidden');
}

function renderTrackList() {
  const container = el.trackListContainer;
  container.innerHTML = '';

  if (state.storedTracks.length === 0) {
    container.innerHTML = `<div style="text-align:center;color:#8e8e93;padding:24px 0;font-size:13px;">尚無已匯入的軌跡，請點擊上方匯入 GPX。</div>`;
    return;
  }

  for (const raw of state.storedTracks) {
    const built = buildTrackData(raw);
    const isActive = state.activeTrack && state.activeTrack.id === raw.id;
    const tileCount = Array.isArray(raw.tileKeys) ? raw.tileKeys.length : 0;
    const tileMb = raw.tileBytes ? (raw.tileBytes / (1024 * 1024)).toFixed(1) : '0.0';

    const card = document.createElement('div');
    card.className = `track-card ${isActive ? 'active' : ''}`;
    card.innerHTML = `
      <div class="track-card-top">
        <div>
          <div class="track-name">${escapeHtml(built.name)}</div>
          <div class="track-stats">${built.totalDistKm.toFixed(1)} km · 爬升 +${built.totalGain}m · 下降 -${built.totalLoss}m</div>
          <div class="track-tile-status">${
            tileCount > 0 ? `已預載矩形魯地圖：${tileCount} 張（約 ${tileMb} MB）` : '尚未預載離線魯地圖'
          }</div>
        </div>
        <span class="dir-tag ${built.reversed ? 'reversed' : ''}">${built.reversed ? '反向' : '正向'}</span>
      </div>
      <div class="track-card-actions">
        <button class="chip-btn primary" data-act="use">${isActive ? '使用中' : '切換此路線'}</button>
        <button class="chip-btn" data-act="reverse">反轉方向</button>
        <button class="chip-btn" data-act="tiles">${tileCount > 0 ? '更新離線地圖' : '下載離線地圖'}</button>
        <button class="chip-btn danger" data-act="delete">刪除</button>
      </div>
    `;

    card.querySelector('[data-act="use"]').addEventListener('click', async () => {
      await activateTrack(raw.id);
      closeTrackModal();
    });
    card.querySelector('[data-act="reverse"]').addEventListener('click', async () => {
      await toggleTrackDirection(raw.id);
    });
    card.querySelector('[data-act="tiles"]').addEventListener('click', async () => {
      if (!navigator.onLine) {
        alert('目前為離線狀態，無法下載地圖圖磚');
        return;
      }
      await runTileDownload(raw);
    });
    card.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (confirm(`確定要刪除「${built.name}」並自動清理其專屬離線地圖嗎？`)) {
        await removeTrack(raw.id);
      }
    });

    container.appendChild(card);
  }
}

function openWaypointModal(wpt) {
  state.selectedWpt = wpt;
  el.wptCardIcon.textContent = wpt.icon;
  el.wptCardName.textContent = wpt.name;
  el.wptCardMeta.textContent = `海拔 ${wpt.projEle} m · 里程 ${wpt.distKm.toFixed(1)} km`;
  el.wptCardDesc.textContent = wpt.desc || '（此航點無額外備註說明）';
  el.wptModal.classList.remove('hidden');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

init();
