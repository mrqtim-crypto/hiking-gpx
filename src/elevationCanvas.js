/**
 * 底部固定 25% 高度 XY 距離 / 海拔剖面圖模組
 */

export class ElevationCanvasController {
  constructor(canvas, onSelectDistKm) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelectDistKm = onSelectDistKm;

    this.width = 0;
    this.height = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);

    this.track = null;
    this.currentDistKm = null;
    this.pinDistKm = null;

    this.pad = { top: 14, right: 14, bottom: 20, left: 42 };
    this.isDragging = false;

    this._bindEvents();
    this.resize();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.render();
  }

  setTrack(track) {
    this.track = track;
    this.render();
  }

  setCurrentDistKm(distKm) {
    this.currentDistKm = distKm;
    this.render();
  }

  setPinDistKm(distKm) {
    this.pinDistKm = distKm;
    this.render();
  }

  _bindEvents() {
    const pickAtClientX = (clientX) => {
      if (!this.track || this.track.totalDistKm <= 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const plotW = this.width - this.pad.left - this.pad.right;
      if (plotW <= 0) return;
      const ratio = Math.max(0, Math.min(1, (x - this.pad.left) / plotW));
      const distKm = ratio * this.track.totalDistKm;
      if (this.onSelectDistKm) {
        this.onSelectDistKm(distKm);
      }
    };

    this.canvas.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        this.isDragging = true;
        if (e.touches[0]) pickAtClientX(e.touches[0].clientX);
      },
      { passive: false }
    );
    this.canvas.addEventListener(
      'touchmove',
      (e) => {
        e.preventDefault();
        if (this.isDragging && e.touches[0]) {
          pickAtClientX(e.touches[0].clientX);
        }
      },
      { passive: false }
    );
    this.canvas.addEventListener('touchend', () => {
      this.isDragging = false;
    });

    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      pickAtClientX(e.clientX);
    });
    window.addEventListener('mousemove', (e) => {
      if (this.isDragging) pickAtClientX(e.clientX);
    });
    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });
  }

  render() {
    const ctx = this.ctx;
    if (!ctx || this.width <= 0 || this.height <= 0) return;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    ctx.clearRect(0, 0, this.width, this.height);

    if (!this.track || this.track.points.length < 2) {
      ctx.fillStyle = '#8e8e93';
      ctx.font = '12px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('載入 GPX 後將顯示距離 / 海拔剖面圖', this.width / 2, this.height / 2);
      ctx.restore();
      return;
    }

    const plotW = Math.max(10, this.width - this.pad.left - this.pad.right);
    const plotH = Math.max(10, this.height - this.pad.top - this.pad.bottom);

    const totalDist = Math.max(0.01, this.track.totalDistKm);
    const rawMin = this.track.minEle;
    const rawMax = this.track.maxEle;
    const span = Math.max(50, rawMax - rawMin);
    const minEle = Math.floor((rawMin - span * 0.1) / 50) * 50;
    const maxEle = Math.ceil((rawMax + span * 0.12) / 50) * 50;
    const eleRange = Math.max(50, maxEle - minEle);

    const xForDist = (d) => this.pad.left + (d / totalDist) * plotW;
    const yForEle = (e) => this.pad.top + plotH - ((e - minEle) / eleRange) * plotH;

    // 1. 水平海拔格線與 Y 軸刻度
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#8e8e93';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const ySteps = 3;
    for (let i = 0; i <= ySteps; i++) {
      const eleVal = Math.round(minEle + (eleRange * i) / ySteps);
      const y = yForEle(eleVal);
      ctx.beginPath();
      ctx.moveTo(this.pad.left, y);
      ctx.lineTo(this.pad.left + plotW, y);
      ctx.stroke();
      ctx.fillText(`${eleVal}m`, this.pad.left - 5, y);
    }

    // 2. X 軸距離刻度
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTicks = 4;
    for (let i = 0; i <= xTicks; i++) {
      const d = (totalDist * i) / xTicks;
      const x = xForDist(d);
      const label = i === 0 ? '0' : `${d.toFixed(1)}k`;
      ctx.fillText(label, x, this.pad.top + plotH + 5);
    }

    // 3. 海拔曲線（漸層填色 + 亮綠邊線）
    const pts = this.track.points;
    const step = Math.max(1, Math.floor(pts.length / Math.max(120, plotW)));

    ctx.beginPath();
    ctx.moveTo(xForDist(pts[0].distKm), this.pad.top + plotH);
    for (let i = 0; i < pts.length; i += step) {
      ctx.lineTo(xForDist(pts[i].distKm), yForEle(pts[i].smoothEle));
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(xForDist(last.distKm), yForEle(last.smoothEle));
    ctx.lineTo(xForDist(last.distKm), this.pad.top + plotH);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, this.pad.top, 0, this.pad.top + plotH);
    grad.addColorStop(0, 'rgba(57, 255, 20, 0.35)');
    grad.addColorStop(1, 'rgba(57, 255, 20, 0.02)');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < pts.length; i += step) {
      const x = xForDist(pts[i].distKm);
      const y = yForEle(pts[i].smoothEle);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(xForDist(last.distKm), yForEle(last.smoothEle));
    ctx.strokeStyle = '#39ff14';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 4. 航點標記（僅顯示小白點，避免中文字干擾曲線閱讀）
    for (const w of this.track.waypoints) {
      if (w.trackDistM > 150) continue;
      const wx = xForDist(w.distKm);
      const wy = yForEle(w.projEle);

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(wx, wy, 2.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // 5. 目前 GPS 位置垂直藍虛線
    if (this.currentDistKm !== null) {
      const cx = xForDist(this.currentDistKm);
      const curEle = this._interpEle(this.currentDistKm);
      const cy = yForEle(curEle);

      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, this.pad.top);
      ctx.lineTo(cx, this.pad.top + plotH);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = '#00e5ff';
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // 6. 圖釘垂直橘虛線與海拔數值
    if (this.pinDistKm !== null) {
      const px = xForDist(this.pinDistKm);
      const pinEle = this._interpEle(this.pinDistKm);
      const py = yForEle(pinEle);

      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#ff7a00';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, this.pad.top);
      ctx.lineTo(px, this.pad.top + plotH);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = '#ff7a00';
      ctx.beginPath();
      ctx.arc(px, py, 4.5, 0, Math.PI * 2);
      ctx.fill();

      const label = `${Math.round(pinEle)}m`;
      ctx.font = '700 10px -apple-system, sans-serif';
      const tw = ctx.measureText(label).width + 8;
      const bx = Math.max(this.pad.left, Math.min(this.width - this.pad.right - tw, px - tw / 2));
      const by = Math.max(2, py - 20);

      ctx.fillStyle = '#ff7a00';
      ctx.beginPath();
      ctx.roundRect(bx, by, tw, 14, 4);
      ctx.fill();

      ctx.fillStyle = '#000000';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + tw / 2, by + 7.5);
    }

    ctx.restore();
  }

  _interpEle(distKm) {
    const pts = this.track.points;
    if (distKm <= 0) return pts[0].smoothEle;
    if (distKm >= this.track.totalDistKm) return pts[pts.length - 1].smoothEle;
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
    return a.smoothEle + t * (b.smoothEle - a.smoothEle);
  }
}
