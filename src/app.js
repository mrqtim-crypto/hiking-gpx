/**
 * 山行 GPX 主應用程式控制器
 * 針對 iPhone Safari / PWA 最佳化：事件驅動零空轉省電、關螢幕即停 GPS 與羅盤
 */

import {
  parseGpxXml,
  buildTrackData,
  projectPointToTrack,
  sampleTrackAtDist,
  getDemoGpxXml,
  detectSplitCandidates,
  splitRawTrackByIndices
} from './gpx.js';
import {
  getAllStoredTracks,
  saveStoredTrack,
  getMeta,
  setMeta,
  downloadTilesForTrack,
  deleteTrackAndUnusedTiles,
  getStorageUsageSummary
} from './storage.js';
import { MapCanvasController } from './mapCanvas.js';
import { ElevationCanvasController } from './elevationCanvas.js';

const DEFAULT_LOCATE_ZOOM = 15.5;

const state = {
  storedTracks: [],
  activeTrack: null,
  showRudyMap: false,
  projMode: 'all', // 'all' (全線) | 'outbound' (去程) | 'return' (回程)
  isTracking: false,
  isStartingTracking: false,
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
  progressBadge: document.getElementById('progressBadge'),
  progressPctText: document.getElementById('progressPctText'),
  progressBarFill: document.getElementById('progressBarFill'),
  valCurEle: document.getElementById('valCurEle'),
  valRemDist: document.getElementById('valRemDist'),
  valRemGain: document.getElementById('valRemGain'),
  valRemLoss: document.getElementById('valRemLoss'),

  btnTrackList: document.getElementById('btnTrackList'),
  btnRudyMap: document.getElementById('btnRudyMap'),
  btnProjMode: document.getElementById('btnProjMode'),
  projModeText: document.getElementById('projModeText'),
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
  storageSummaryText: document.getElementById('storageSummaryText'),
  btnCheckUpdate: document.getElementById('btnCheckUpdate'),

  wptModal: document.getElementById('wptModal'),
  btnCloseWptModal: document.getElementById('btnCloseWptModal'),
  wptCardIcon: document.getElementById('wptCardIcon'),
  wptCardName: document.getElementById('wptCardName'),
  wptCardMeta: document.getElementById('wptCardMeta'),
  wptCardDesc: document.getElementById('wptCardDesc'),
  btnPinAtWpt: document.getElementById('btnPinAtWpt'),

  splitModal: document.getElementById('splitModal'),
  btnCloseSplitModal: document.getElementById('btnCloseSplitModal'),
  splitAutoBox: document.getElementById('splitAutoBox'),
  splitAutoDesc: document.getElementById('splitAutoDesc'),
  btnApplyAutoSplit: document.getElementById('btnApplyAutoSplit'),
  splitWaypointsSection: document.getElementById('splitWaypointsSection'),
  splitWaypointsList: document.getElementById('splitWaypointsList'),
  splitPreviewCanvas: document.getElementById('splitPreviewCanvas'),
  splitResultPreview: document.getElementById('splitResultPreview'),
  btnResetSplits: document.getElementById('btnResetSplits'),
  btnConfirmSplit: document.getElementById('btnConfirmSplit')
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

  // 鎖定 iOS Safari 雙指整頁縮放手勢，確保縮放只作用於地圖 Canvas
  document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });

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

/**
 * 一鍵更新軟體：僅更新網頁程式碼與 App 快取，完全保留 IndexedDB 軌跡與離線魯地圖圖磚
 */
async function forceUpdateApp() {
  if (!navigator.onLine) {
    alert('目前為離線狀態，請連線後再更新軟體。');
    return;
  }
  el.btnCheckUpdate.disabled = true;
  el.btnCheckUpdate.textContent = '更新中...';
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith('hiking-gpx-app-')).map((k) => caches.delete(k))
      );
    }
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.update();
      }
    }
    window.location.reload();
  } catch (err) {
    el.btnCheckUpdate.disabled = false;
    el.btnCheckUpdate.textContent = '一鍵更新軟體';
    alert(`更新失敗：${err.message}`);
  }
}

/* ---------------- UI 事件綁定 ---------------- */

function bindUiEvents() {
  el.btnRudyMap.addEventListener('click', () => {
    state.showRudyMap = !state.showRudyMap;
    el.btnRudyMap.classList.toggle('active', state.showRudyMap);
    mapCtrl.setRudyMap(state.showRudyMap);
  });

  // 地圖左下角切換：全線 -> 去程 -> 回程
  el.btnProjMode.addEventListener('click', () => {
    if (state.projMode === 'all') state.projMode = 'outbound';
    else if (state.projMode === 'outbound') state.projMode = 'return';
    else state.projMode = 'all';
    updateProjModeUI();
    recalculateNavigation();
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
  el.btnCheckUpdate.addEventListener('click', forceUpdateApp);
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

  bindSplitModalEvents();
}

/* ---------------- GPS 定位與電子羅盤 ---------------- */

async function startTracking() {
  if (!('geolocation' in navigator)) {
    alert('此裝置瀏覽器不支援 GPS 定位');
    return;
  }
  if (state.isTracking || state.isStartingTracking) return;
  state.isStartingTracking = true;

  // 在使用者點擊事件內請求 iOS 電子羅盤權限
  await requestCompassPermissionAndStart();

  // 若等待授權期間使用者已關閉螢幕或取消，直接中止啟動
  if (document.hidden || !state.isStartingTracking) {
    state.isStartingTracking = false;
    stopCompass();
    return;
  }

  state.isStartingTracking = false;
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
  state.isStartingTracking = false;
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
    let startIdx = 0;
    let endIdx = state.activeTrack.points.length - 1;
    if (state.projMode === 'outbound') {
      endIdx = state.activeTrack.peakPointIndex;
    } else if (state.projMode === 'return') {
      startIdx = state.activeTrack.peakPointIndex;
    }
    const proj = projectPointToTrack(state.gps.lat, state.gps.lon, state.activeTrack.points, startIdx, endIdx);
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

function updateProjModeUI() {
  el.btnProjMode.classList.remove('mode-outbound', 'mode-return');
  if (state.projMode === 'outbound') {
    el.projModeText.textContent = '去程';
    el.btnProjMode.classList.add('mode-outbound');
  } else if (state.projMode === 'return') {
    el.projModeText.textContent = '回程';
    el.btnProjMode.classList.add('mode-return');
  } else {
    el.projModeText.textContent = '全線';
  }
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
    mapCtrl.setPin(null);
    return;
  }
  const pinSample = sampleTrackAtDist(state.pinDistKm, state.activeTrack);
  const isNearTrack = Boolean(state.gpsProjection && state.gpsProjection.distanceM <= 200);
  let badgeText = `${pinSample.ele}m`;

  if (isNearTrack) {
    const deltaDist = pinSample.distKm - state.gpsProjection.distKm;
    // 若橘點在目前位置前方：還需要爬升 = pin.cumGain - gps.cumGain，還需要下降 = pin.cumLoss - gps.cumLoss
    const segGain = Math.max(0, Math.round(
      deltaDist >= 0 ? pinSample.cumGain - state.gpsProjection.cumGain : state.gpsProjection.cumGain - pinSample.cumGain
    ));
    const segLoss = Math.max(0, Math.round(
      deltaDist >= 0 ? pinSample.cumLoss - state.gpsProjection.cumLoss : state.gpsProjection.cumLoss - pinSample.cumLoss
    ));
    const distLabel = deltaDist >= 0 ? `距目前 ${deltaDist.toFixed(1)} km` : `在後方 ${Math.abs(deltaDist).toFixed(1)} km`;
    el.pinTooltipText.textContent = `${distLabel} · 爬升 +${segGain}m · 下降 -${segLoss}m`;
    // 橘球上方直接顯示：距離 · 累積爬升/下降
    const shortDist = `${deltaDist >= 0 ? '' : '後'}${Math.abs(deltaDist).toFixed(1)}km`;
    badgeText = `${shortDist} · +${segGain}/-${segLoss}m`;
  } else {
    el.pinTooltipText.textContent = `里程 ${pinSample.distKm.toFixed(1)} km · 海拔 ${pinSample.ele}m`;
  }

  mapCtrl.setPin({ ...pinSample, badgeText });
  eleCtrl.setPinDistKm(state.pinDistKm);
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
    segmentBreakIndices: parsed.segmentBreakIndices || [],
    reversed: false,
    tileKeys: [],
    tileBytes: 0,
    createdAt: Date.now()
  };

  // 若偵測到跨日時間戳記或多段 trkseg，詢問是否直接自動拆成多天
  const candidates = detectSplitCandidates(stored);
  if (candidates.autoBreaks.length > 0) {
    const days = candidates.autoBreaks.length + 1;
    const reason = candidates.autoType === 'byDate' ? '跨日時間紀錄' : '多段軌跡結構';
    if (confirm(`偵測到「${stored.name}」包含 ${reason}，要直接自動拆成 ${days} 天行程並下載各自離線地圖嗎？`)) {
      await executeSplitAndSave(stored, candidates.autoBreaks, false, autoDownloadTiles);
      return;
    }
  }

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
  state.projMode = 'all';
  updateProjModeUI();
  await setMeta('activeTrackId', trackId);

  el.emptyState.classList.add('hidden');
  el.activeTrackBadge.classList.remove('hidden');
  updateActiveTrackBadge();

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

async function renameTrack(trackId) {
  const raw = state.storedTracks.find((t) => t.id === trackId);
  if (!raw) return;
  const nextName = prompt('請輸入新的路線名稱：', raw.name);
  if (nextName === null) return;
  const trimmed = nextName.trim();
  if (!trimmed || trimmed === raw.name) return;

  raw.name = trimmed;
  await saveStoredTrack(raw);
  state.storedTracks = await getAllStoredTracks();
  if (state.activeTrack && state.activeTrack.id === trackId) {
    state.activeTrack.name = trimmed;
    updateActiveTrackBadge();
  }
  renderTrackList();
}

function updateActiveTrackBadge() {
  if (!state.activeTrack) return;
  el.activeTrackName.textContent = state.activeTrack.name;
  el.activeTrackDir.textContent = state.activeTrack.reversed ? '反向' : '正向';
  el.activeTrackDir.classList.toggle('reversed', state.activeTrack.reversed);
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

async function renderTrackList() {
  const summary = await updateStorageSummary();
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

    let tileStatusText = '尚未預載離線魯地圖';
    if (tileCount > 0) {
      if (summary.quotaMb && summary.quotaMb > 0) {
        const trackMb = (raw.tileBytes || 0) / (1024 * 1024);
        const trackPct = Math.max(0.1, (trackMb / summary.quotaMb) * 100);
        tileStatusText = `已預載離線地圖（約佔可用空間 ${trackPct.toFixed(1)}%）`;
      } else {
        tileStatusText = '已預載離線地圖';
      }
    }

    const card = document.createElement('div');
    card.className = `track-card ${isActive ? 'active' : ''}`;
    card.innerHTML = `
      <div class="track-card-top">
        <div>
          <div class="track-name">${escapeHtml(built.name)}</div>
          <div class="track-stats">${built.totalDistKm.toFixed(1)} km · 爬升 +${built.totalGain}m · 下降 -${built.totalLoss}m</div>
          <div class="track-tile-status">${tileStatusText}</div>
        </div>
        <span class="dir-tag ${built.reversed ? 'reversed' : ''}">${built.reversed ? '反向' : '正向'}</span>
      </div>
      <div class="track-card-actions">
        <button class="chip-btn primary" data-act="use">${isActive ? '使用中' : '切換此路線'}</button>
        <button class="chip-btn" data-act="rename">改名</button>
        <button class="chip-btn" data-act="reverse">反轉方向</button>
        <button class="chip-btn" data-act="split">拆分多天</button>
        <button class="chip-btn" data-act="tiles">${tileCount > 0 ? '更新離線地圖' : '下載離線地圖'}</button>
        <button class="chip-btn danger" data-act="delete">刪除</button>
      </div>
    `;

    card.querySelector('[data-act="use"]').addEventListener('click', async () => {
      await activateTrack(raw.id);
      closeTrackModal();
    });
    card.querySelector('[data-act="rename"]').addEventListener('click', async () => {
      await renameTrack(raw.id);
    });
    card.querySelector('[data-act="reverse"]').addEventListener('click', async () => {
      await toggleTrackDirection(raw.id);
    });
    card.querySelector('[data-act="split"]').addEventListener('click', () => {
      openSplitModal(raw);
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

async function updateStorageSummary() {
  const s = await getStorageUsageSummary(state.storedTracks);
  if (s.usageMb !== null && s.quotaMb !== null && s.quotaMb > 0) {
    const pct = Math.min(100, (s.usageMb / s.quotaMb) * 100);
    el.storageSummaryText.textContent = `離線空間總計已佔用 ${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%`;
  } else {
    el.storageSummaryText.textContent = `離線空間已就緒`;
  }
  return s;
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

/* ---------------- 多日軌跡拆分彈窗邏輯 ---------------- */

let splitSession = {
  rawTrack: null,
  builtTrack: null,
  candidates: null,
  breakIndices: []
};

function bindSplitModalEvents() {
  el.btnCloseSplitModal.addEventListener('click', () => el.splitModal.classList.add('hidden'));
  el.splitModal.addEventListener('click', (e) => {
    if (e.target === el.splitModal) el.splitModal.classList.add('hidden');
  });

  el.btnResetSplits.addEventListener('click', () => {
    splitSession.breakIndices = [];
    renderSplitUI();
  });

  el.btnApplyAutoSplit.addEventListener('click', () => {
    if (!splitSession.candidates) return;
    splitSession.breakIndices = [...splitSession.candidates.autoBreaks];
    renderSplitUI();
  });

  el.splitPreviewCanvas.addEventListener('click', (e) => {
    if (!splitSession.builtTrack) return;
    const rect = el.splitPreviewCanvas.getBoundingClientRect();
    const ratio = Math.max(0.02, Math.min(0.98, (e.clientX - rect.left) / rect.width));
    const pts = splitSession.builtTrack.points;
    const targetDist = ratio * splitSession.builtTrack.totalDistKm;

    // 找最接近 targetDist 的點 index
    let bestIdx = 1;
    let bestDiff = Infinity;
    for (let i = 1; i < pts.length - 1; i++) {
      const diff = Math.abs(pts[i].distKm - targetDist);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }

    // 若點擊在既有切分點附近（距離總長 3% 內）則移除，否則新增
    const nearExisting = splitSession.breakIndices.findIndex(
      (idx) => Math.abs(pts[idx].distKm - targetDist) < splitSession.builtTrack.totalDistKm * 0.035
    );
    if (nearExisting >= 0) {
      splitSession.breakIndices.splice(nearExisting, 1);
    } else {
      splitSession.breakIndices.push(bestIdx);
      splitSession.breakIndices.sort((a, b) => a - b);
    }
    renderSplitUI();
  });

  el.btnConfirmSplit.addEventListener('click', async () => {
    if (!splitSession.rawTrack || splitSession.breakIndices.length === 0) return;
    el.splitModal.classList.add('hidden');
    await executeSplitAndSave(splitSession.rawTrack, splitSession.breakIndices, true, true);
  });
}

function openSplitModal(rawTrack) {
  splitSession.rawTrack = rawTrack;
  splitSession.builtTrack = buildTrackData({ ...rawTrack, reversed: false });
  splitSession.candidates = detectSplitCandidates(rawTrack);
  splitSession.breakIndices =
    splitSession.candidates.autoBreaks.length > 0 ? [...splitSession.candidates.autoBreaks] : [];

  el.splitModal.classList.remove('hidden');
  renderSplitUI();
}

function renderSplitUI() {
  const { candidates, builtTrack, breakIndices } = splitSession;
  if (!builtTrack) return;

  if (candidates.autoBreaks.length > 0) {
    el.splitAutoBox.classList.remove('hidden');
    const days = candidates.autoBreaks.length + 1;
    el.splitAutoDesc.textContent =
      candidates.autoType === 'byDate'
        ? `偵測到跨日時間紀錄（建議拆成 ${days} 天）`
        : `偵測到 ${days} 段獨立軌跡分段`;
  } else {
    el.splitAutoBox.classList.add('hidden');
  }

  // 山屋 / 營地候選切分點
  if (candidates.stayWaypoints.length > 0) {
    el.splitWaypointsSection.classList.remove('hidden');
    el.splitWaypointsList.innerHTML = '';
    for (const w of candidates.stayWaypoints) {
      const selected = breakIndices.includes(w.pointIndex);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `split-wpt-chip ${selected ? 'selected' : ''}`;
      chip.textContent = `${w.icon} ${w.name} (${w.distKm.toFixed(1)}km)`;
      chip.addEventListener('click', () => {
        const pos = splitSession.breakIndices.indexOf(w.pointIndex);
        if (pos >= 0) splitSession.breakIndices.splice(pos, 1);
        else {
          splitSession.breakIndices.push(w.pointIndex);
          splitSession.breakIndices.sort((a, b) => a - b);
        }
        renderSplitUI();
      });
      el.splitWaypointsList.appendChild(chip);
    }
  } else {
    el.splitWaypointsSection.classList.add('hidden');
  }

  drawSplitPreviewCanvas();

  // 顯示拆分預覽清單
  const parts = splitRawTrackByIndices(splitSession.rawTrack, breakIndices);
  el.splitResultPreview.innerHTML = '';
  parts.forEach((p) => {
    const b = buildTrackData(p);
    const row = document.createElement('div');
    row.className = 'split-day-row';
    row.innerHTML = `<span>${escapeHtml(b.name)}</span><span>${b.totalDistKm.toFixed(1)} km · +${b.totalGain}m / -${b.totalLoss}m</span>`;
    el.splitResultPreview.appendChild(row);
  });

  el.btnConfirmSplit.disabled = breakIndices.length === 0;
  el.btnConfirmSplit.textContent =
    breakIndices.length > 0 ? `確認拆分成 ${parts.length} 天` : '請先選擇切分點';
}

function drawSplitPreviewCanvas() {
  const canvas = el.splitPreviewCanvas;
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(200, rect.width);
  const h = Math.max(80, rect.height);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const track = splitSession.builtTrack;
  const pts = track.points;
  const totalDist = Math.max(0.01, track.totalDistKm);
  const eleSpan = Math.max(50, track.maxEle - track.minEle);
  const padY = 12;

  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let i = 0; i < pts.length; i++) {
    const x = (pts[i].distKm / totalDist) * w;
    const y = h - padY - ((pts[i].smoothEle - track.minEle) / eleSpan) * (h - padY * 2);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = 'rgba(57, 255, 20, 0.25)';
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = (pts[i].distKm / totalDist) * w;
    const y = h - padY - ((pts[i].smoothEle - track.minEle) / eleSpan) * (h - padY * 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#39ff14';
  ctx.lineWidth = 2;
  ctx.stroke();

  // 畫橘色切分線
  ctx.strokeStyle = '#ff7a00';
  ctx.lineWidth = 2;
  for (const idx of splitSession.breakIndices) {
    const x = (pts[idx].distKm / totalDist) * w;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  ctx.restore();
}

async function executeSplitAndSave(rawTrack, breakIndices, deleteOriginal, downloadTiles) {
  const parts = splitRawTrackByIndices(rawTrack, breakIndices);
  const createdTracks = [];
  const baseTs = Date.now();

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const stored = {
      id: `trk_${baseTs}_${i}_${Math.random().toString(36).slice(2, 6)}`,
      name: p.name,
      points: p.points,
      waypoints: p.waypoints,
      reversed: false,
      tileKeys: [],
      tileBytes: 0,
      createdAt: baseTs + (parts.length - i) // 讓 Day 1 排在最上方
    };
    await saveStoredTrack(stored);
    createdTracks.push(stored);
  }

  if (deleteOriginal && rawTrack.id) {
    await deleteTrackAndUnusedTiles(rawTrack.id);
  }

  state.storedTracks = await getAllStoredTracks();
  if (createdTracks.length > 0) {
    await activateTrack(createdTracks[0].id);
  }
  renderTrackList();

  if (downloadTiles && navigator.onLine) {
    for (const t of createdTracks) {
      await runTileDownload(t);
    }
  }
}

init();
