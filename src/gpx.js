/**
 * GPX 解析、幾何投影與登山統計模組
 */

const EARTH_RADIUS_M = 6371000;
const ELEVATION_THRESHOLD_M = 4; // 最小變動閾值，過濾 GPX 海拔鋸齒雜訊

/**
 * 計算兩經緯度點之間的球面距離（公尺）
 */
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 依航點名稱與 sym 自動分類圖示
 */
export function classifyWaypoint(name = '', sym = '') {
  const text = `${name} ${sym}`.toLowerCase();
  if (/山屋|山莊|避難|小屋|cabin|hut|shelter/.test(text)) return { icon: '🏠', kind: 'hut' };
  if (/營地|營|camp|tent/.test(text)) return { icon: '⛺', kind: 'camp' };
  if (/水|溪|泉|池|water|spring/.test(text)) return { icon: '💧', kind: 'water' };
  if (/拍|照|景|展望|日出|雲海|view|photo|scenic/.test(text)) return { icon: '📷', kind: 'photo' };
  if (/三角點|基石|百岳|主峰|北峰|南峰|東峰|西峰|peak|summit/.test(text)) return { icon: '🔺', kind: 'peak' };
  if (/岔|叉|路口|鞍部|登山口|junction|saddle|trailhead/.test(text)) return { icon: '⚠️', kind: 'junction' };
  return { icon: '📍', kind: 'default' };
}

/**
 * 解析 GPX XML 文字為原始結構
 */
export function parseGpxXml(xmlText, fallbackName = '未命名路線') {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error('GPX 檔案格式錯誤，無法解析 XML');
  }

  const nameEl = doc.querySelector('trk > name') || doc.querySelector('metadata > name') || doc.querySelector('rte > name');
  const name = (nameEl?.textContent || fallbackName).trim().replace(/\.gpx$/i, '');

  // 讀取軌跡點（優先 trkseg 保留分段資訊，若無則 rtept）
  const points = [];
  const segmentBreakIndices = []; // 記錄每個新 trkseg 的起始點 index

  const trkSegs = Array.from(doc.querySelectorAll('trkseg'));
  if (trkSegs.length > 0) {
    for (let sIdx = 0; sIdx < trkSegs.length; sIdx++) {
      const segPts = Array.from(trkSegs[sIdx].querySelectorAll('trkpt'));
      if (segPts.length === 0) continue;
      if (points.length > 0) {
        segmentBreakIndices.push(points.length);
      }
      for (const node of segPts) {
        const pt = parseTrackPointNode(node);
        if (pt) points.push(pt);
      }
    }
  } else {
    let ptNodes = Array.from(doc.querySelectorAll('trkpt'));
    if (ptNodes.length === 0) ptNodes = Array.from(doc.querySelectorAll('rtept'));
    for (const node of ptNodes) {
      const pt = parseTrackPointNode(node);
      if (pt) points.push(pt);
    }
  }

  if (points.length < 2) {
    throw new Error('GPX 檔案內沒有足夠的軌跡點');
  }

  // 若部分點缺乏海拔，做線性內插或補 0
  fillMissingElevations(points);

  // 讀取航點 <wpt>
  const wptNodes = Array.from(doc.querySelectorAll('wpt'));
  const waypoints = [];
  for (const node of wptNodes) {
    const lat = parseFloat(node.getAttribute('lat'));
    const lon = parseFloat(node.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const wName = (node.querySelector('name')?.textContent || '航點').trim();
    const desc = (node.querySelector('desc')?.textContent || node.querySelector('cmt')?.textContent || '').trim();
    const sym = (node.querySelector('sym')?.textContent || '').trim();
    const eleNode = node.querySelector('ele');
    const ele = eleNode ? parseFloat(eleNode.textContent) : null;
    const { icon, kind } = classifyWaypoint(wName, sym);
    waypoints.push({
      lat,
      lon,
      ele: Number.isFinite(ele) ? ele : null,
      name: wName,
      desc,
      icon,
      kind
    });
  }

  return { name, points, waypoints, segmentBreakIndices };
}

function parseTrackPointNode(node) {
  const lat = parseFloat(node.getAttribute('lat'));
  const lon = parseFloat(node.getAttribute('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const eleNode = node.querySelector('ele');
  const ele = eleNode ? parseFloat(eleNode.textContent) : null;
  const timeNode = node.querySelector('time');
  let timeMs = null;
  if (timeNode?.textContent) {
    const parsed = Date.parse(timeNode.textContent.trim());
    if (Number.isFinite(parsed)) timeMs = parsed;
  }
  return {
    lat,
    lon,
    ele: Number.isFinite(ele) ? ele : null,
    timeMs
  };
}

function fillMissingElevations(points) {
  let firstValid = points.findIndex((p) => p.ele !== null);
  if (firstValid === -1) {
    for (const p of points) p.ele = 0;
    return;
  }
  for (let i = 0; i < firstValid; i++) {
    points[i].ele = points[firstValid].ele;
  }
  let lastValid = firstValid;
  for (let i = firstValid + 1; i < points.length; i++) {
    if (points[i].ele !== null) {
      const gap = i - lastValid;
      if (gap > 1) {
        const startEle = points[lastValid].ele;
        const endEle = points[i].ele;
        for (let k = 1; k < gap; k++) {
          points[lastValid + k].ele = startEle + ((endEle - startEle) * k) / gap;
        }
      }
      lastValid = i;
    }
  }
  for (let i = lastValid + 1; i < points.length; i++) {
    points[i].ele = points[lastValid].ele;
  }
}

/**
 * 依據方向（正/反）建立完整的軌跡統計資料與投影資訊
 */
export function buildTrackData(storedTrack) {
  const reversed = Boolean(storedTrack.reversed);
  const srcPts = reversed ? [...storedTrack.points].reverse() : storedTrack.points;

  // 簡易 3 點移動平均平滑海拔，減少毛刺
  const smoothedEle = srcPts.map((_, i) => {
    const prev = srcPts[Math.max(0, i - 1)].ele;
    const curr = srcPts[i].ele;
    const next = srcPts[Math.min(srcPts.length - 1, i + 1)].ele;
    return (prev + curr * 2 + next) / 4;
  });

  const points = [];
  let cumDistM = 0;
  let cumGain = 0;
  let cumLoss = 0;
  let anchorEle = smoothedEle[0];

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minEle = Infinity;
  let maxEle = -Infinity;

  for (let i = 0; i < srcPts.length; i++) {
    const p = srcPts[i];
    const ele = smoothedEle[i];
    if (i > 0) {
      cumDistM += haversineMeters(srcPts[i - 1].lat, srcPts[i - 1].lon, p.lat, p.lon);
      const diff = ele - anchorEle;
      if (diff >= ELEVATION_THRESHOLD_M) {
        cumGain += diff;
        anchorEle = ele;
      } else if (diff <= -ELEVATION_THRESHOLD_M) {
        cumLoss += -diff;
        anchorEle = ele;
      }
    }
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.ele < minEle) minEle = p.ele;
    if (p.ele > maxEle) maxEle = p.ele;

    points.push({
      lat: p.lat,
      lon: p.lon,
      ele: Math.round(p.ele),
      smoothEle: ele,
      distKm: cumDistM / 1000,
      cumGain,
      cumLoss
    });
  }

  const totalDistKm = cumDistM / 1000;
  const totalGain = Math.round(cumGain);
  const totalLoss = Math.round(cumLoss);

  // 將航點投影到路線里程上，以便在 XY 海拔圖同步標示
  const waypoints = (storedTrack.waypoints || []).map((w) => {
    const proj = projectPointToTrack(w.lat, w.lon, points);
    return {
      ...w,
      distKm: proj.distKm,
      projEle: w.ele !== null ? Math.round(w.ele) : Math.round(proj.ele),
      trackDistM: Math.round(proj.distanceM)
    };
  });

  return {
    id: storedTrack.id,
    name: storedTrack.name,
    reversed,
    points,
    waypoints,
    totalDistKm,
    totalGain,
    totalLoss,
    minEle: Math.floor(minEle),
    maxEle: Math.ceil(maxEle),
    bounds: { minLat, maxLat, minLon, maxLon }
  };
}

/**
 * 計算任意經緯度到軌跡所有線段的最短投影點
 * 使用局部平面近似（台灣緯度約 23.5 度非常精準且運算極快）
 */
export function projectPointToTrack(lat, lon, points) {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const metersPerLat = 111320;
  const metersPerLon = 111320 * cosLat;

  let bestDistSq = Infinity;
  let bestSegIdx = 0;
  let bestT = 0;
  let bestProjLat = points[0].lat;
  let bestProjLon = points[0].lon;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];

    const ax = (a.lon - lon) * metersPerLon;
    const ay = (a.lat - lat) * metersPerLat;
    const bx = (b.lon - lon) * metersPerLon;
    const by = (b.lat - lat) * metersPerLat;

    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    let t = 0;
    if (lenSq > 0) {
      t = -(ax * dx + ay * dy) / lenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }

    const px = ax + t * dx;
    const py = ay + t * dy;
    const distSq = px * px + py * py;

    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestSegIdx = i;
      bestT = t;
      bestProjLat = a.lat + t * (b.lat - a.lat);
      bestProjLon = a.lon + t * (b.lon - a.lon);
    }
  }

  const pA = points[bestSegIdx];
  const pB = points[bestSegIdx + 1];
  const distKm = pA.distKm + bestT * (pB.distKm - pA.distKm);
  const ele = pA.ele + bestT * (pB.ele - pA.ele);
  const cumGain = pA.cumGain + bestT * (pB.cumGain - pA.cumGain);
  const cumLoss = pA.cumLoss + bestT * (pB.cumLoss - pA.cumLoss);

  return {
    distanceM: Math.sqrt(bestDistSq),
    lat: bestProjLat,
    lon: bestProjLon,
    distKm,
    ele,
    cumGain,
    cumLoss,
    segIdx: bestSegIdx
  };
}

/**
 * 依據里程（km）在軌跡上內插出座標、海拔與爬升資訊（供 XY 圖拖曳插圖釘用）
 */
export function sampleTrackAtDist(distKm, track) {
  const pts = track.points;
  if (distKm <= 0) {
    return { lat: pts[0].lat, lon: pts[0].lon, ele: pts[0].ele, distKm: 0, cumGain: 0, cumLoss: 0 };
  }
  const total = track.totalDistKm;
  if (distKm >= total) {
    const last = pts[pts.length - 1];
    return { lat: last.lat, lon: last.lon, ele: last.ele, distKm: total, cumGain: last.cumGain, cumLoss: last.cumLoss };
  }

  // 二分搜尋
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].distKm <= distKm) lo = mid;
    else hi = mid;
  }

  const a = pts[lo];
  const b = pts[hi];
  const span = b.distKm - a.distKm;
  const t = span > 0 ? (distKm - a.distKm) / span : 0;

  return {
    lat: a.lat + t * (b.lat - a.lat),
    lon: a.lon + t * (b.lon - a.lon),
    ele: Math.round(a.ele + t * (b.ele - a.ele)),
    distKm,
    cumGain: a.cumGain + t * (b.cumGain - a.cumGain),
    cumLoss: a.cumLoss + t * (b.cumLoss - a.cumLoss)
  };
}

/**
 * 偵測 GPX 是否包含自動拆分線索（台灣時間跨日 / 多段 trkseg / 山屋營地航點）
 */
export function detectSplitCandidates(rawTrack) {
  const pts = rawTrack.points || [];
  if (pts.length < 4) return { autoType: null, autoBreaks: [], stayWaypoints: [] };

  // 1. 檢查台灣時區 (UTC+8) 跨日
  const twDateKey = (ms) => {
    const d = new Date(ms + 8 * 3600 * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  };

  const dateBreaks = [];
  let prevDate = null;
  for (let i = 0; i < pts.length; i++) {
    const ms = pts[i].timeMs;
    if (!ms) continue;
    const key = twDateKey(ms);
    if (prevDate && key !== prevDate && i > 1 && i < pts.length - 1) {
      dateBreaks.push(i);
    }
    prevDate = key;
  }

  // 2. 檢查多段 trkseg
  const segBreaks = (rawTrack.segmentBreakIndices || []).filter((idx) => idx > 1 && idx < pts.length - 1);

  // 3. 檢查山屋 / 營地航點在軌跡上的投影索引
  const built = buildTrackData(rawTrack);
  const stayWaypoints = [];
  for (const w of built.waypoints) {
    if ((w.kind === 'hut' || w.kind === 'camp') && w.trackDistM <= 300) {
      // 找最近點 index
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = haversineMeters(w.lat, w.lon, pts[i].lat, pts[i].lon);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      if (bestIdx > 1 && bestIdx < pts.length - 2) {
        stayWaypoints.push({
          name: w.name,
          icon: w.icon,
          distKm: w.distKm,
          ele: w.projEle,
          pointIndex: bestIdx
        });
      }
    }
  }
  stayWaypoints.sort((a, b) => a.pointIndex - b.pointIndex);

  let autoType = null;
  let autoBreaks = [];
  if (dateBreaks.length > 0) {
    autoType = 'byDate';
    autoBreaks = dateBreaks;
  } else if (segBreaks.length > 0) {
    autoType = 'bySegments';
    autoBreaks = segBreaks;
  }

  return { autoType, autoBreaks, stayWaypoints };
}

/**
 * 依據切分點索引陣列，將一條軌跡拆成多天獨立軌跡（相鄰天重疊交界點以確保路線連續）
 */
export function splitRawTrackByIndices(rawTrack, breakIndices) {
  const pts = rawTrack.points;
  const sorted = Array.from(new Set(breakIndices))
    .filter((idx) => idx > 0 && idx < pts.length - 1)
    .sort((a, b) => a - b);

  const ranges = [];
  let start = 0;
  for (const br of sorted) {
    ranges.push([start, br]);
    start = br;
  }
  ranges.push([start, pts.length - 1]);

  const baseName = rawTrack.name.replace(/\s*Day\s*\d+$/i, '').trim();
  const totalDays = ranges.length;

  return ranges.map(([s, e], dayIdx) => {
    const subPts = pts.slice(s, e + 1).map((p) => ({ ...p }));
    // 篩選落在這天路線附近（<= 400m）的航點
    const subWpts = (rawTrack.waypoints || []).filter((w) =>
      subPts.some((p) => haversineMeters(w.lat, w.lon, p.lat, p.lon) <= 400)
    );
    return {
      name: `${baseName} Day${dayIdx + 1}`,
      points: subPts,
      waypoints: subWpts,
      reversed: false,
      totalDays
    };
  });
}

/**
 * 產生合歡北峰示範 GPX 文字（供初次無檔案時測試）
 */
export function getDemoGpxXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="HikingGPX-Demo">
  <metadata><name>合歡北峰示範路線</name></metadata>
  <wpt lat="24.1628" lon="121.2869"><ele>2975</ele><name>北峰登山口</name><desc>台14甲線37.1K登山口，起登陡上。</desc></wpt>
  <wpt lat="24.1672" lon="121.2842"><ele>3120</ele><name>展望拍照點</name><desc>視野開闊，可遠眺合歡主峰與奇萊連峰。</desc></wpt>
  <wpt lat="24.1725" lon="121.2810"><ele>3290</ele><name>反射板岔路</name><desc>往天巒池與小溪營地重要岔路口。</desc></wpt>
  <wpt lat="24.1766" lon="121.2784"><ele>3280</ele><name>小溪營地水源</name><desc>營地旁溪溝，枯水期需確認水量。</desc></wpt>
  <wpt lat="24.1815" lon="121.2817"><ele>3422</ele><name>合歡北峰三角點</name><desc>百岳排名第34，二等三角點。</desc></wpt>
  <trk><name>合歡北峰示範路線</name><trkseg>
    <trkpt lat="24.1628" lon="121.2869"><ele>2975</ele></trkpt>
    <trkpt lat="24.1642" lon="121.2860"><ele>3025</ele></trkpt>
    <trkpt lat="24.1658" lon="121.2851"><ele>3078</ele></trkpt>
    <trkpt lat="24.1672" lon="121.2842"><ele>3120</ele></trkpt>
    <trkpt lat="24.1689" lon="121.2830"><ele>3185</ele></trkpt>
    <trkpt lat="24.1707" lon="121.2819"><ele>3242</ele></trkpt>
    <trkpt lat="24.1725" lon="121.2810"><ele>3290</ele></trkpt>
    <trkpt lat="24.1744" lon="121.2797"><ele>3275</ele></trkpt>
    <trkpt lat="24.1766" lon="121.2784"><ele>3280</ele></trkpt>
    <trkpt lat="24.1782" lon="121.2796"><ele>3345</ele></trkpt>
    <trkpt lat="24.1799" lon="121.2808"><ele>3392</ele></trkpt>
    <trkpt lat="24.1815" lon="121.2817"><ele>3422</ele></trkpt>
  </trkseg></trk>
</gpx>`;
}
