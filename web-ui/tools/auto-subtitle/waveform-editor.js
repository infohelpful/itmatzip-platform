/**
 * Peaks 스타일 파형 + 삭제(컷) + 단어 경계 드래그 + 재생 헤드.
 */

import { WaveformRenderer } from "../silence-remover/waveform-renderer.js";
import { resolvePeaksTimelineMetrics } from "./peaks-metrics.js";
import { getVisibleWordCenterIndex } from "./line-zoom-window.js";
import { buildWordFillBands, drawWordContextWaveform } from "./word-waveform-draw.js";
import { buildEdlSkipMapping } from "./waveform/edl-skip-mapping.js";
import { WaveformCutMarkersOverlay } from "./waveform/cut-markers-dom.js";
import {
  ensureCueWords,
  getCueWords,
  moveWordByDelta,
  setWordEndInCues,
  setWordStartInCues,
  visibleWordSlots,
  visibleWords,
} from "./subtitle-words.js?v=18";

const CUT_FILL = "rgba(239, 68, 68, 0.42)";
const CUT_STROKE = "rgba(248, 113, 113, 0.9)";
const CUE_FILL = "rgba(139, 92, 246, 0.28)";
const CUE_STROKE = "rgba(167, 139, 250, 0.85)";
const WORD_FILL = "rgba(56, 189, 248, 0.55)";
const WORD_FILL_SEL = "rgba(250, 204, 21, 0.75)";
const WORD_STROKE = "rgba(125, 211, 252, 0.9)";
const HANDLE_FILL = "#facc15";
const PLAYHEAD = "rgba(250, 204, 21, 0.95)";
const BG = "#12151c";

const WORD_LANE_H = 18;
const CUE_LANE_H = 10;
const EDGE_HIT_PX = 7;
const MIN_CUT_DRAG_SEC = 0.08;

/**
 * @typedef {{ start: number, end: number }} CutRange
 * @typedef {{ start: number, end: number, text?: string, is_silence?: boolean, words?: unknown[] }} Cue
 * @typedef {{ peaks: number[], peaks_db?: number[], duration_sec: number, timeline_sec: number, column_count: number }} PeaksPayload
 * @typedef {'cut' | 'seek' | 'word-start' | 'word-end' | 'word-move'} DragMode
 * @typedef {{ storageIndex: number, edge: 'start' | 'end' | 'body' }} WordHit
 */

export class AutoSubtitleWaveformEditor {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLVideoElement | null} video
   */
  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;
    /** @type {PeaksPayload | null} */
    this.peaksData = null;
    /** @type {WaveformRenderer | null} */
    this.renderer = null;
    /** @type {CutRange[]} */
    this.cutRanges = [];
    /** @type {Cue[]} */
    this.cues = [];
    this.selectedCueIndex = -1;
    /** @type {DragMode | null} */
    this._dragMode = null;
    this._dragStartX = null;
    this._dragEndX = null;
    this._dragStartY = null;
    /** @type {WordHit | null} */
    this._wordHit = null;
    this._wordMoveAnchorTime = 0;
    /** @type {(cuts: CutRange[]) => void | null} */
    this.onCutsChange = null;
    /** @type {(sec: number) => void | null} */
    this.onSeek = null;
    /** @type {((cueIndex: number, cue: Cue) => void) | null} */
    this.onWordsChange = null;
    /** @type {((cueIndex: number, cue: object) => void) | null} */
    this.onWordsDragPreview = null;
    /** @type {(() => void) | null} */
    this.onWordsDragEnd = null;
    /** @type {((start: number, end: number) => void) | null} */
    this.onTimeRangeCut = null;
    /** @type {{ start: number, end: number } | null} */
    this.viewWindow = null;
    /** @type {import("./waveform/edl-skip-mapping.js").ReturnType<import("./waveform/edl-skip-mapping.js").buildEdlSkipMapping> | null} */
    this.skipMapping = null;
    /** @type {{ start: number, end: number }[]} */
    this.playbackSkipRanges = [];
    /** @type {WaveformCutMarkersOverlay | null} */
    this.cutMarkers = null;
    /** storage index — 단어 컨텍스트 파형 모드 */
    this.focusWordStorageIndex = -1;
    this.cutToolActive = false;
    /** @type {number | null} */
    this.splitMarkerSec = null;
    /** @type {((start: number, end: number, visibleWordIndex: number) => void) | null} */
    this.onSplitWordAtSec = null;
    this._bound = false;
    this._resizeObs = null;
    this._raf = 0;
    this._layout = { cssW: 640, cssH: 120 };
    this._bind();
  }

  /** @param {PeaksPayload} data */
  setPeaks(data) {
    this.peaksData = data;
    const dur = Number(data.timeline_sec || data.duration_sec) || 0;
    this.renderer = WaveformRenderer.fromPeaks(
      data.peaks || [],
      dur,
      data.peaks_db?.length === data.column_count ? data.peaks_db : null,
    );
    this._scheduleDraw();
  }

  /** @param {WaveformCutMarkersOverlay | null} overlay */
  setCutMarkersOverlay(overlay) {
    this.cutMarkers = overlay;
  }

  /** @param {{ start: number, end: number }[]} ranges */
  setPlaybackSkipRanges(ranges) {
    this.playbackSkipRanges = ranges || [];
    this._scheduleDraw();
  }

  /** @param {CutRange[]} cuts */
  setCutRanges(cuts) {
    this.cutRanges = (cuts || [])
      .map((c) => ({
        start: Math.max(0, Number(c.start) || 0),
        end: Math.max(0, Number(c.end) || 0),
      }))
      .filter((c) => c.end > c.start + 0.02);
    this._scheduleDraw();
  }

  /** @param {Cue[]} cues */
  setCues(cues) {
    this.cues = cues || [];
    this._scheduleDraw();
  }

  /** @param {number} index */
  setSelectedCueIndex(index) {
    this.selectedCueIndex = index;
    this._scheduleDraw();
  }

  getDuration() {
    return Number(this.peaksData?.timeline_sec || this.peaksData?.duration_sec) || 0;
  }

  _viewStart() {
    const dur = this.getDuration();
    if (this.viewWindow && this.viewWindow.end > this.viewWindow.start) {
      return Math.max(0, this.viewWindow.start);
    }
    return 0;
  }

  _viewEnd() {
    const dur = this.getDuration();
    if (this.viewWindow && this.viewWindow.end > this.viewWindow.start) {
      return Math.min(dur, this.viewWindow.end);
    }
    return dur;
  }

  _viewSpan() {
    return Math.max(1e-6, this._viewEnd() - this._viewStart());
  }

  _bind() {
    if (this._bound || !this.canvas) return;
    this._bound = true;
    const c = this.canvas;
    c.addEventListener("mousedown", (e) => this._onDown(e));
    c.addEventListener("mousemove", (e) => this._onMove(e));
    c.addEventListener("mouseleave", () => this._clearHoverCursor());
    window.addEventListener("mouseup", () => this._onUp());
    if (this.video) {
      this.video.addEventListener("timeupdate", () => this._scheduleDraw());
      this.video.addEventListener("seeked", () => this._scheduleDraw());
    }
    if (typeof ResizeObserver !== "undefined") {
      this._resizeObs = new ResizeObserver(() => this._scheduleDraw());
      this._resizeObs.observe(c.parentElement || c);
    }
    window.addEventListener("resize", () => this._scheduleDraw());
  }

  destroy() {
    if (this._resizeObs) this._resizeObs.disconnect();
    this._resizeObs = null;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _scheduleDraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.draw();
    });
  }

  _updateLayout() {
    const parent = this.canvas?.parentElement;
    this._layout.cssW = Math.max(320, parent?.clientWidth || 640);
    this._layout.cssH = 120;
  }

  /** @param {MouseEvent} e */
  _pointer(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    return { x, y };
  }

  _rebuildSkipMapping() {
    const v0 = this._viewStart();
    const v1 = this._viewEnd();
    if (!(v1 > v0)) {
      this.skipMapping = null;
      return;
    }
    const skips = [...(this.playbackSkipRanges || []), ...this._collectDeletedInView(v0, v1)];
    this.skipMapping = buildEdlSkipMapping({ start: v0, end: v1 }, skips);
  }

  /** @param {number} x */
  _xToTime(x) {
    const w = this._layout.cssW;
    if (w <= 0) return 0;
    this._rebuildSkipMapping();
    if (this.skipMapping) return this.skipMapping.pixelToMediaSec(x, w);
    const v0 = this._viewStart();
    const span = this._viewSpan();
    return v0 + (x / w) * span;
  }

  /** @param {number} t */
  _timeToX(t, cssW) {
    const w = cssW || this._layout.cssW;
    this._rebuildSkipMapping();
    if (this.skipMapping) return this.skipMapping.mediaSecToPixel(t, w);
    const v0 = this._viewStart();
    const span = this._viewSpan();
    if (span <= 0) return 0;
    return ((t - v0) / span) * w;
  }

  _inWordLane(y) {
    return y >= this._layout.cssH - WORD_LANE_H;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {WordHit | null}
   */
  _hitTestWords(x, y) {
    if (this.selectedCueIndex < 0 || !this._inWordLane(y)) return null;
    const cue = this.cues[this.selectedCueIndex];
    if (!cue || cue.is_silence) return null;
    ensureCueWords(cue);
    const cssW = this._layout.cssW;
    const slots = visibleWordSlots(cue);

    let bestEdge = null;
    let bestDist = EDGE_HIT_PX + 1;

    for (const { word: w, storageIndex } of slots) {
      const x0 = this._timeToX(w.start, cssW);
      const x1 = this._timeToX(w.end, cssW);
      for (const [edge, px] of /** @type {const} */ ([["start", x0], ["end", x1]])) {
        const d = Math.abs(x - px);
        if (d <= EDGE_HIT_PX && d < bestDist) {
          bestDist = d;
          bestEdge = { storageIndex, edge };
        }
      }
    }

    if (bestEdge) return bestEdge;

    for (const { word: w, storageIndex } of slots) {
      const x0 = this._timeToX(w.start, cssW);
      const x1 = this._timeToX(w.end, cssW);
      if (x >= x0 + EDGE_HIT_PX && x <= x1 - EDGE_HIT_PX) {
        return { storageIndex, edge: "body" };
      }
    }
    return null;
  }

  /** @param {MouseEvent} e */
  _onDown(e) {
    if (!this.peaksData) return;
    this._updateLayout();
    const { x, y } = this._pointer(e);
    this._dragStartX = x;
    this._dragEndX = x;
    this._dragStartY = y;

    const forceCut = e.altKey || (this.cutToolActive && !this._inWordLane(y));
    if (this.cutToolActive && !forceCut && e.detail === 2 && this._inWordLane(y)) {
      const t = this._xToTime(x);
      const cue = this.cues[this.selectedCueIndex];
      const centerVis = cue ? getVisibleWordCenterIndex(cue, this.focusWordStorageIndex) : -1;
      if (centerVis >= 0 && this.onSplitWordAtSec) {
        this.onSplitWordAtSec(t, centerVis);
      }
      return;
    }
    if (this.cutToolActive && !forceCut && !this._inWordLane(y)) {
      this.splitMarkerSec = this._xToTime(x);
      this._syncCutMarkers();
      this._scheduleDraw();
      return;
    }

    const wordHit = !forceCut ? this._hitTestWords(x, y) : null;

    if (wordHit) {
      this._wordHit = wordHit;
      if (wordHit.edge === "start") this._dragMode = "word-start";
      else if (wordHit.edge === "end") this._dragMode = "word-end";
      else {
        this._dragMode = "word-move";
        const cue = this.cues[this.selectedCueIndex];
        const words = getCueWords(cue);
        this._wordMoveAnchorTime = this._xToTime(x) - (words[wordHit.storageIndex]?.start || 0);
      }
      return;
    }

    if (this._inWordLane(y) && !forceCut) {
      this._dragMode = "seek";
      const t = this._xToTime(x);
      if (this.video && Number.isFinite(t)) this.video.currentTime = t;
      if (this.onSeek) this.onSeek(t);
      this._scheduleDraw();
      return;
    }

    this._dragMode = forceCut || !this._inWordLane(y) ? "cut" : "seek";
    if (this._dragMode === "seek") {
      const t = this._xToTime(x);
      if (this.video && Number.isFinite(t)) this.video.currentTime = t;
      if (this.onSeek) this.onSeek(t);
    }
    this._scheduleDraw();
  }

  /** @param {MouseEvent} e */
  _onMove(e) {
    this._updateLayout();
    const { x, y } = this._pointer(e);

    if (this._dragMode == null) {
      this._setHoverCursor(x, y);
      return;
    }

    this._dragEndX = x;

    if (
      this._dragMode === "word-start" ||
      this._dragMode === "word-end" ||
      this._dragMode === "word-move"
    ) {
      if (this.canvas) {
        this.canvas.style.cursor =
          this._dragMode === "word-move" ? "grabbing" : "ew-resize";
      }
      this._applyWordDrag(x, false);
      this._scheduleDraw();
      return;
    }

    if (this._dragMode === "cut") {
      if (this.cutMarkers && this._dragStartX != null && this._dragEndX != null) {
        this.cutMarkers.setCutPreview(this._dragStartX, this._dragEndX);
      }
      this._scheduleDraw();
      return;
    }

    this._setHoverCursor(x, y);
  }

  /** @param {number} x */
  _applyWordDrag(x, commitMode = false) {
    if (this.selectedCueIndex < 0 || !this._wordHit) return;
    const ci = this.selectedCueIndex;
    const cue = this.cues[ci];
    if (!cue) return;
    const t = this._xToTime(x);
    const { storageIndex } = this._wordHit;

    if (this._dragMode === "word-start") {
      const updated = setWordStartInCues(this.cues, ci, storageIndex, t, commitMode);
      this.cues[ci] = updated;
    } else if (this._dragMode === "word-end") {
      const updated = setWordEndInCues(this.cues, ci, storageIndex, t, commitMode);
      this.cues[ci] = updated;
    } else if (this._dragMode === "word-move") {
      const words = getCueWords(cue);
      const w = words[storageIndex];
      if (!w) return;
      moveWordByDelta(cue, storageIndex, t - this._wordMoveAnchorTime - w.start);
    }

    if (commitMode) {
      if (this.onWordsChange) this.onWordsChange(ci, this.cues[ci]);
    } else if (this.onWordsDragPreview) {
      this.onWordsDragPreview(ci, this.cues[ci]);
    }
  }

  _onUp() {
    if (this._dragMode == null || !this.peaksData) return;

    const endedWordDrag =
      this._dragMode === "word-start" ||
      this._dragMode === "word-end" ||
      this._dragMode === "word-move";

    if (this._dragMode === "cut" && this._dragStartX != null && this._dragEndX != null) {
      const t0 = this._xToTime(this._dragStartX);
      const t1 = this._xToTime(this._dragEndX);
      if (Math.abs(t1 - t0) >= MIN_CUT_DRAG_SEC) {
        const start = Math.min(t0, t1);
        const end = Math.max(t0, t1);
        if (this.onTimeRangeCut) {
          this.onTimeRangeCut(start, end);
        } else {
          this.cutRanges = [...this.cutRanges, { start, end }].sort((a, b) => a.start - b.start);
          if (this.onCutsChange) this.onCutsChange(this.cutRanges);
        }
      }
    }

    if (
      endedWordDrag &&
      this._dragEndX != null &&
      (this._dragMode === "word-start" || this._dragMode === "word-end")
    ) {
      this._applyWordDrag(this._dragEndX, true);
    }

    this.cutMarkers?.clearCutPreview();
    this._dragMode = null;
    this._dragStartX = null;
    this._dragEndX = null;
    this._dragStartY = null;
    this._wordHit = null;
    this._clearHoverCursor();
    this._syncCutMarkers();
    this._scheduleDraw();
    if (endedWordDrag && this.onWordsDragEnd) {
      this.onWordsDragEnd();
    }
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  _setHoverCursor(x, y) {
    if (!this.canvas) return;
    if (this.selectedCueIndex < 0) {
      this.canvas.style.cursor = "crosshair";
      return;
    }
    const hit = this._hitTestWords(x, y);
    if (!hit) {
      this.canvas.style.cursor = this._inWordLane(y) ? "pointer" : "crosshair";
      return;
    }
    if (hit.edge === "start" || hit.edge === "end") {
      this.canvas.style.cursor = "ew-resize";
    } else {
      this.canvas.style.cursor = "grab";
    }
  }

  _clearHoverCursor() {
    if (this.canvas) this.canvas.style.cursor = "";
  }

  _isWordContextMode() {
    return (
      this.viewWindow != null &&
      this.viewWindow.end > this.viewWindow.start &&
      this.focusWordStorageIndex >= 0 &&
      this.selectedCueIndex >= 0
    );
  }

  _collectDeletedInView(v0, v1) {
    const cue = this.cues[this.selectedCueIndex];
    if (!cue) return [];
    const ranges = [];
    for (const w of getCueWords(cue)) {
      if (!w.is_deleted) continue;
      const a = Math.min(w.start, w.end);
      const b = Math.max(w.start, w.end);
      const s = Math.max(v0, a);
      const e = Math.min(v1, b);
      if (e > s + 1e-9) ranges.push({ start: s, end: e });
    }
    return ranges;
  }

  draw() {
    const canvas = this.canvas;
    if (!canvas || !this.peaksData) return;

    this._updateLayout();
    const { cssW, cssH } = this._layout;
    const v0 = this._viewStart();
    const v1 = this._viewEnd();
    const span = this._viewSpan();

    this._rebuildSkipMapping();

    if (this._isWordContextMode()) {
      const metrics = resolvePeaksTimelineMetrics(this.peaksData);
      const cue = this.cues[this.selectedCueIndex];
      const centerVis = cue ? getVisibleWordCenterIndex(cue, this.focusWordStorageIndex) : -1;
      const fillBands =
        cue && centerVis >= 0 ? buildWordFillBands(cue, centerVis, v0, v1) : null;
      if (metrics) {
        drawWordContextWaveform(canvas, metrics, v0, v1, this._collectDeletedInView(v0, v1), fillBands, {
          heightCssPx: cssH,
          background: BG,
          meanVolumeDb: Number(this.peaksData?.mean_volume_db) || -24,
          skipMapping: this.skipMapping,
        });
      }
      const ctx = canvas.getContext("2d");
      if (!ctx || span <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const wordLaneTop = cssH - WORD_LANE_H;
      this._drawWordContextLane(ctx, cssW, wordLaneTop, cssH);
      this._drawPlayhead(ctx, cssW, cssH);
      this._syncCutMarkers();
      return;
    }

    const renderer = this.renderer;
    if (!renderer) return;
    const pxPerSec = cssW / span;

    renderer.render(
      canvas,
      {
        canvasWidth: cssW,
        canvasHeight: cssH,
        showRuler: false,
        pxPerSec,
        scrollLeftPx: v0 * pxPerSec,
        flattenSilence: false,
      },
      {
        background: BG,
        waveform: "rgba(200, 210, 230, 0.92)",
        baseline: "rgba(80, 90, 110, 0.5)",
      },
    );

    const ctx = canvas.getContext("2d");
    if (!ctx || span <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const wordLaneTop = cssH - WORD_LANE_H;
    const cueLaneTop = wordLaneTop - CUE_LANE_H;

    this.cues.forEach((cue, ci) => {
      if (cue.is_silence) return;
      const text = String(cue.text || "").trim();
      if (!text) return;
      const x0 = this._timeToX(Number(cue.start) || 0, cssW);
      const x1 = this._timeToX(Number(cue.end) || 0, cssW);
      if (x1 <= x0) return;
      const selected = ci === this.selectedCueIndex;
      ctx.fillStyle = selected ? "rgba(139, 92, 246, 0.45)" : CUE_FILL;
      ctx.strokeStyle = selected ? "rgba(250, 204, 21, 0.9)" : CUE_STROKE;
      ctx.fillRect(x0, cueLaneTop, x1 - x0, CUE_LANE_H);
      ctx.strokeRect(x0, cueLaneTop, x1 - x0, CUE_LANE_H);

      const words = visibleWords(getCueWords(cue));
      for (const w of words) {
        const wx0 = this._timeToX(w.start, cssW);
        const wx1 = this._timeToX(w.end, cssW);
        if (wx1 <= wx0) continue;
        ctx.fillStyle = selected ? WORD_FILL_SEL : WORD_FILL;
        ctx.strokeStyle = WORD_STROKE;
        ctx.fillRect(wx0, wordLaneTop, Math.max(2, wx1 - wx0), WORD_LANE_H);
        if (selected) {
          ctx.fillStyle = HANDLE_FILL;
          ctx.fillRect(wx0 - 1, wordLaneTop, 3, WORD_LANE_H);
          ctx.fillRect(wx1 - 2, wordLaneTop, 3, WORD_LANE_H);
        }
        if (wx1 - wx0 > 14) {
          ctx.fillStyle = "#0f1115";
          ctx.font = "10px Pretendard, sans-serif";
          const label = w.word.length > 8 ? `${w.word.slice(0, 7)}…` : w.word;
          ctx.fillText(label, wx0 + 2, cssH - 4);
        }
      }
    });

    for (const cut of this.cutRanges) {
      const x0 = this._timeToX(cut.start, cssW);
      const x1 = this._timeToX(cut.end, cssW);
      ctx.fillStyle = CUT_FILL;
      ctx.fillRect(x0, 0, x1 - x0, cueLaneTop);
      ctx.strokeStyle = CUT_STROKE;
      ctx.strokeRect(x0, 0, x1 - x0, cueLaneTop);
    }

    if (this._dragMode === "cut" && this._dragStartX != null && this._dragEndX != null) {
      const x0 = Math.min(this._dragStartX, this._dragEndX);
      const x1 = Math.max(this._dragStartX, this._dragEndX);
      ctx.fillStyle = "rgba(239, 68, 68, 0.25)";
      ctx.strokeStyle = CUT_STROKE;
      ctx.fillRect(x0, 0, x1 - x0, cueLaneTop);
      ctx.strokeRect(x0, 0, x1 - x0, cueLaneTop);
    }

    this._drawPlayhead(ctx, cssW, cssH);
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cssW
   * @param {number} wordLaneTop
   * @param {number} cssH
   */
  _drawWordContextLane(ctx, cssW, wordLaneTop, cssH) {
    const cue = this.cues[this.selectedCueIndex];
    if (!cue) return;
    ensureCueWords(cue);
    const centerVis = getVisibleWordCenterIndex(cue, this.focusWordStorageIndex);
    const slots = visibleWordSlots(cue);
    for (const { word: w, storageIndex } of slots) {
      const wx0 = this._timeToX(w.start, cssW);
      const wx1 = this._timeToX(w.end, cssW);
      if (wx1 <= wx0) continue;
      let visIdx = -1;
      let vi = 0;
      const all = getCueWords(cue);
      for (let i = 0; i < all.length; i += 1) {
        if (all[i].is_deleted) continue;
        if (i === storageIndex) {
          visIdx = vi;
          break;
        }
        vi += 1;
      }
      const isSel = visIdx === centerVis;
      const isNeighbor = centerVis >= 0 && Math.abs(visIdx - centerVis) === 1;
      ctx.fillStyle = isSel ? WORD_FILL_SEL : isNeighbor ? "rgba(255,255,255,0.35)" : "rgba(56,189,248,0.35)";
      ctx.strokeStyle = isSel ? "rgba(255,232,132,0.95)" : WORD_STROKE;
      ctx.fillRect(wx0, wordLaneTop, Math.max(2, wx1 - wx0), WORD_LANE_H);
      if (isSel) {
        ctx.fillStyle = HANDLE_FILL;
        ctx.fillRect(wx0 - 1, wordLaneTop, 3, WORD_LANE_H);
        ctx.fillRect(wx1 - 2, wordLaneTop, 3, WORD_LANE_H);
      }
    }
    if (this._dragMode === "cut" && this._dragStartX != null && this._dragEndX != null) {
      const x0 = Math.min(this._dragStartX, this._dragEndX);
      const x1 = Math.max(this._dragStartX, this._dragEndX);
      ctx.fillStyle = "rgba(239, 68, 68, 0.25)";
      ctx.strokeStyle = CUT_STROKE;
      ctx.fillRect(x0, 0, x1 - x0, wordLaneTop);
      ctx.strokeRect(x0, 0, x1 - x0, wordLaneTop);
    }
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cssW
   * @param {number} cssH
   */
  _drawPlayhead(ctx, cssW, cssH) {
    if (this.video && Number.isFinite(this.video.currentTime)) {
      const px = this._timeToX(this.video.currentTime, cssW);
      ctx.strokeStyle = PLAYHEAD;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, cssH);
      ctx.stroke();
    }
  }

  _syncCutMarkers() {
    if (!this.cutMarkers) return;
    if (this.splitMarkerSec != null && Number.isFinite(this.splitMarkerSec)) {
      const px = this._timeToX(this.splitMarkerSec, this._layout.cssW);
      const t = this.splitMarkerSec;
      const label = `${t.toFixed(2)}s`;
      this.cutMarkers.setCutPoint(px, label);
    } else {
      this.cutMarkers.clearCutPoint();
    }
  }
}
