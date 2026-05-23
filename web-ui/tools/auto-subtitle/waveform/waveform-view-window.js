/**
 * AutoSubtitle useWaveformViewWindow.ts — 줌 스트립 패닝·휠 줌 (vanilla).
 */

/**
 * @param {number} durationSec
 * @param {{ start: number, end: number } | null} initial
 */
export function defaultViewWindow(durationSec, initial = null) {
  if (initial && initial.end > initial.start) return { ...initial };
  const dur = Math.max(0.12, Number(durationSec) || 60);
  return { start: 0, end: dur };
}

export class WaveformViewWindowController {
  /**
   * @param {HTMLElement} outerEl
   * @param {{ getDurationSec: () => number, onChange?: (win: { start: number, end: number }) => void, enablePan?: boolean }} opts
   */
  constructor(outerEl, opts) {
    this.outerEl = outerEl;
    this.getDurationSec = opts.getDurationSec;
    this.onChange = opts.onChange || (() => {});
    /** Electron: zoom strip 패닝 비활성 — 휠 줌만 (명시 true 일 때만 패닝) */
    this.enablePan = opts.enablePan === true;
    /** @type {{ start: number, end: number } | null} */
    this.viewWin = null;
    /** @type {{ startX: number, win0: { start: number, end: number } } | null} */
    this._pan = null;
    this._onDown = (e) => this._pointerDown(e);
    this._onMove = (e) => this._pointerMove(e);
    this._onUp = (e) => this._pointerUp(e);
    this._onWheel = (e) => this._wheel(e);
    outerEl.addEventListener("pointerdown", this._onDown);
    outerEl.addEventListener("pointermove", this._onMove);
    outerEl.addEventListener("pointerup", this._onUp);
    outerEl.addEventListener("pointercancel", this._onUp);
    outerEl.addEventListener("wheel", this._onWheel, { passive: false });
  }

  destroy() {
    const el = this.outerEl;
    if (!el) return;
    el.removeEventListener("pointerdown", this._onDown);
    el.removeEventListener("pointermove", this._onMove);
    el.removeEventListener("pointerup", this._onUp);
    el.removeEventListener("pointercancel", this._onUp);
    el.removeEventListener("wheel", this._onWheel);
  }

  /**
   * @param {{ start: number, end: number } | null} win
   */
  setViewWin(win) {
    this.viewWin = win;
  }

  getViewWin() {
    return this.viewWin;
  }

  /**
   * @param {PointerEvent} e
   */
  _pointerDown(e) {
    if (!this.enablePan || !this.viewWin || e.button !== 0) return;
    this.outerEl.setPointerCapture(e.pointerId);
    this._pan = { startX: e.clientX, win0: { ...this.viewWin } };
  }

  /**
   * @param {PointerEvent} e
   */
  _pointerMove(e) {
    const p = this._pan;
    if (!p || !this.viewWin) return;
    const w = this.outerEl.clientWidth;
    if (w < 8) return;
    const dx = e.clientX - p.startX;
    const span0 = p.win0.end - p.win0.start;
    const dSec = (-dx / w) * span0;
    const dur = this.getDurationSec();
    let ns = p.win0.start + dSec;
    let ne = p.win0.end + dSec;
    if (ns < 0) {
      ne -= ns;
      ns = 0;
    }
    if (ne > dur) {
      const over = ne - dur;
      ns -= over;
      ne = dur;
      if (ns < 0) ns = 0;
    }
    if (ne > ns + 1e-6) {
      this.viewWin = { start: ns, end: ne };
      this.onChange(this.viewWin);
    }
  }

  /**
   * @param {PointerEvent} e
   */
  _pointerUp(e) {
    try {
      this.outerEl.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this._pan = null;
  }

  /**
   * @param {WheelEvent} e
   */
  _wheel(e) {
    if (!this.viewWin) return;
    e.preventDefault();
    const w = this.outerEl.clientWidth;
    const rect = this.outerEl.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / Math.max(w, 1);
    const vw = this.viewWin;
    const tAtMx = vw.start + mx * (vw.end - vw.start);
    const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    const dur = this.getDurationSec();
    let half = (vw.end - vw.start) * 0.5 * factor;
    const minSpan = 0.05;
    half = Math.min(Math.max(half, minSpan), dur);
    let ns = tAtMx - half * mx;
    let ne = tAtMx + half * (1 - mx);
    if (ns < 0) {
      ne -= ns;
      ns = 0;
    }
    if (ne > dur) {
      const over = ne - dur;
      ns -= over;
      ne = dur;
      if (ns < 0) ns = 0;
    }
    if (ne > ns + 1e-6) {
      this.viewWin = { start: ns, end: ne };
      this.onChange(this.viewWin);
    }
  }
}
