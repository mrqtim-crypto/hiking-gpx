/**
 * 按需載入的 3D 立體地形視角控制器（基於 MapLibre GL JS + Mapterhorn Terrarium DEM）
 * 僅在開啟 3D 模式時建立 WebGL Context，關閉時立即銷毀以維持極致省電。
 */

import { projectPointToTrack } from './gpx.js';

const RUDY_TILE_URL = 'https://tile.happyman.idv.tw/map/rudy/{z}/{x}/{y}.png';
const DEM_TILE_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';

export class Map3DController {
  constructor(container, callbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
    this.map = null;
    this.isReady = false;

    this.track = null;
    this.showRudyMap = false;
    this.gps = null;
    this.heading = null;
    this.pin = null;
  }

  init({ centerLat, centerLon, zoom, track, showRudyMap, gps, heading, pin }) {
    if (!window.maplibregl) {
      throw new Error('3D 地圖引擎尚未載入完成（請確認網路連線後再試）');
    }
    this.destroy();

    this.track = track;
    this.showRudyMap = Boolean(showRudyMap);
    this.gps = gps;
    this.heading = heading;
    this.pin = pin;
    this.isReady = false;

    const style = {
      version: 8,
      sources: {
        dem: {
          type: 'raster-dem',
          tiles: [DEM_TILE_URL],
          tileSize: 512,
          maxzoom: 12,
          encoding: 'terrarium'
        },
        rudy: {
          type: 'raster',
          tiles: [RUDY_TILE_URL],
          tileSize: 256,
          maxzoom: 17
        }
      },
      layers: [
        {
          id: 'bg-oled',
          type: 'background',
          paint: { 'background-color': '#10151c' }
        },
        {
          id: 'hillshade-base',
          type: 'hillshade',
          source: 'dem',
          paint: {
            'hillshade-exaggeration': 0.92,
            'hillshade-shadow-color': '#05070a',
            'hillshade-highlight-color': '#8a9bb0',
            'hillshade-accent-color': '#2b3542'
          }
        },
        {
          id: 'rudy-layer',
          type: 'raster',
          source: 'rudy',
          layout: {
            visibility: this.showRudyMap ? 'visible' : 'none'
          },
          paint: {
            'raster-opacity': 0.92,
            'raster-brightness-max': 0.95
          }
        }
      ],
      sky: {
        'sky-color': '#0d1826',
        'sky-horizon-blend': 0.65,
        'horizon-color': '#1f334a',
        'horizon-fog-blend': 0.8,
        'fog-color': '#121d2b',
        'fog-ground-blend': 0.55
      },
      terrain: {
        source: 'dem',
        exaggeration: 1.4
      }
    };

    this.map = new window.maplibregl.Map({
      container: this.container,
      style,
      center: [centerLon, centerLat],
      zoom: Math.max(7, Math.min(18, zoom - 0.5)),
      pitch: 58,
      bearing: 0,
      maxPitch: 75,
      attributionControl: false
    });

    this.map.on('load', () => {
      this._setupOverlayLayers();
      this.isReady = true;
      this._syncAllOverlays();
    });

    this.map.on('click', (e) => {
      if (!this.track) return;
      const { lng, lat } = e.lngLat;
      const proj = projectPointToTrack(lat, lng, this.track.points);
      if (proj.distanceM <= 450 && this.callbacks.onSelectPinDist) {
        this.callbacks.onSelectPinDist(proj.distKm);
      }
    });
  }

  _setupOverlayLayers() {
    const map = this.map;
    if (!map) return;

    map.addSource('gpx-track', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'gpx-track-outline',
      type: 'line',
      source: 'gpx-track',
      paint: { 'line-color': '#000000', 'line-width': 6.5, 'line-opacity': 0.85 }
    });
    map.addLayer({
      id: 'gpx-track-line',
      type: 'line',
      source: 'gpx-track',
      paint: { 'line-color': '#39ff14', 'line-width': 3.5 }
    });

    map.addSource('gpx-wpts', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'gpx-wpt-circles',
      type: 'circle',
      source: 'gpx-wpts',
      paint: {
        'circle-radius': 6,
        'circle-color': '#121316',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5
      }
    });
    map.addLayer({
      id: 'gpx-wpt-labels',
      type: 'symbol',
      source: 'gpx-wpts',
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 12,
        'text-offset': [0, -1.3],
        'text-anchor': 'bottom',
        'text-allow-overlap': false
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': '#000000',
        'text-halo-width': 1.5
      }
    });

    map.addSource('gps-point', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'gps-halo',
      type: 'circle',
      source: 'gps-point',
      paint: {
        'circle-radius': 18,
        'circle-color': 'rgba(0, 229, 255, 0.22)',
        'circle-stroke-color': 'rgba(0, 229, 255, 0.65)',
        'circle-stroke-width': 1.5
      }
    });
    map.addLayer({
      id: 'gps-core',
      type: 'circle',
      source: 'gps-point',
      paint: {
        'circle-radius': 6.5,
        'circle-color': '#00e5ff',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2
      }
    });

    map.addSource('pin-point', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'pin-core',
      type: 'circle',
      source: 'pin-point',
      paint: {
        'circle-radius': 8.5,
        'circle-color': '#ff7a00',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2
      }
    });
    map.addLayer({
      id: 'pin-label',
      type: 'symbol',
      source: 'pin-point',
      layout: {
        'text-field': ['get', 'badgeText'],
        'text-size': 12,
        'text-offset': [0, -1.6],
        'text-anchor': 'bottom',
        'text-allow-overlap': true
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': '#000000',
        'text-halo-width': 1.8
      }
    });
  }

  _syncAllOverlays() {
    this.setTrack(this.track);
    this.setGps(this.gps);
    this.setPin(this.pin);
  }

  setRudyMap(enabled) {
    this.showRudyMap = Boolean(enabled);
    if (this.map && this.isReady && this.map.getLayer('rudy-layer')) {
      this.map.setLayoutProperty('rudy-layer', 'visibility', this.showRudyMap ? 'visible' : 'none');
    }
  }

  setTrack(track) {
    this.track = track;
    if (!this.map || !this.isReady) return;
    const trkSrc = this.map.getSource('gpx-track');
    const wptSrc = this.map.getSource('gpx-wpts');
    if (!trkSrc || !wptSrc) return;

    if (!track || !track.points?.length) {
      trkSrc.setData({ type: 'FeatureCollection', features: [] });
      wptSrc.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    trkSrc.setData({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: track.points.map((p) => [p.lon, p.lat])
      }
    });

    wptSrc.setData({
      type: 'FeatureCollection',
      features: (track.waypoints || []).map((w) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [w.lon, w.lat] },
        properties: { label: `${w.icon} ${w.name}` }
      }))
    });
  }

  setGps(gps) {
    this.gps = gps;
    if (!this.map || !this.isReady) return;
    const src = this.map.getSource('gps-point');
    if (!src) return;
    if (!gps) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    src.setData({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [gps.lon, gps.lat] }
    });
  }

  setHeading(heading) {
    this.heading = heading;
    // 3D 模式可選依羅盤微調或保持使用者雙指視角，避免干擾手勢
  }

  setPin(pin) {
    this.pin = pin;
    if (!this.map || !this.isReady) return;
    const src = this.map.getSource('pin-point');
    if (!src) return;
    if (!pin) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    src.setData({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [pin.lon, pin.lat] },
      properties: { badgeText: pin.badgeText || '' }
    });
  }

  centerOn(lat, lon, zoom = null) {
    if (!this.map) return;
    const opts = { center: [lon, lat], duration: 400 };
    if (zoom !== null) opts.zoom = Math.max(7, Math.min(18, zoom - 0.5));
    this.map.easeTo(opts);
  }

  getViewState() {
    if (!this.map) return null;
    const c = this.map.getCenter();
    return {
      centerLat: c.lat,
      centerLon: c.lng,
      zoom: this.map.getZoom() + 0.5
    };
  }

  resize() {
    if (this.map) this.map.resize();
  }

  destroy() {
    this.isReady = false;
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
  }
}
