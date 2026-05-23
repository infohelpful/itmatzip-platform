/**
 * AutoSubtitle SubtitleWaveformCanvas — Canvas 전용 단어 컨텍스트 파형 (Peaks/줌/패닝 없음).
 */

import { buildEdlSkipMapping } from "./waveform/edl-skip-mapping.js";
import { resolvePeaksTimelineMetrics } from "./peaks-metrics.js";
import {
  buildWordFillBands,
  buildWordFillBandsFromEditRange,
  collectDeletedRangesSec,
  drawWordContextWaveform,
} from "./word-waveform-draw.js";
import { getVisibleWordCenterIndex } from "./line-zoom-window.js";
import { getCueWords } from "./subtitle-words.js";

const BOX_HEIGHT_PX = 144;
const WAVE_GAIN = 2.0;

export class WaveformContextEditor {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    /** @type {object | null} */
    this.peaksData = null;
    this.cueIndex = -1;
    this.focusWordStorageIndex = -1;
    /** @type {{ start: number, end: number } | null} */
    this.viewWindow = null;
    /** @type {{ start: number, end: number } | null} */
    this.editRange = null;
    /** @type {{ start: number, end: number }[]} */
    this.playbackSkipRanges = [];
    this.skipMapping = null;
    /** @type {number | null} */
    this.mediaDurationHintSec = null;
    this._layout = { cssW: 320, cssH: BOX_HEIGHT_PX };
    this._raf = 0;
  }

  /** @param {object | null} peaks */
  setPeaks(peaks) {
    this.peaksData = peaks;
    this._scheduleDraw();
  }

  /** @param {number | null | undefined} sec */
  setMediaDurationHint(sec) {
    const n = Number(sec);
    this.mediaDurationHintSec = Number.isFinite(n) && n > 0 ? n : null;
    this._scheduleDraw();
  }

  /** @param {{ start: number, end: number } | null} win */
  setViewWindow(win) {
    this.viewWindow = win;
    this._scheduleDraw();
  }

  /** @param {{ start: number, end: number } | null} range */
  setEditRange(range) {
    this.editRange = range;
    this._scheduleDraw();
  }

  /** @param {{ start: number, end: number }[]} ranges */
  setPlaybackSkipRanges(ranges) {
    this.playbackSkipRanges = ranges || [];
    this.skipMapping = null;
    this._scheduleDraw();
  }

  /**
   * @param {number} cueIndex
   * @param {number} storageIndex
   * @param {import("./subtitle-words.js").SubtitleCue} cue
   */
  setFocus(cueIndex, storageIndex, cue) {
    this.cueIndex = cueIndex;
    this.focusWordStorageIndex = storageIndex;
    this._cue = cue;
    this._scheduleDraw();
  }

  destroy() {
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

  drawImmediate() {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
    this.draw();
  }

  _viewStart() {
    return this.viewWindow?.start ?? 0;
  }

  _viewEnd() {
    return this.viewWindow?.end ?? 0;
  }

  _viewSpan() {
    const s = this._viewStart();
    const e = this._viewEnd();
    return Math.max(e - s, 1e-9);
  }

  _updateLayout() {
    const parent = this.canvas?.parentElement;
    this._layout.cssW = Math.max(200, parent?.clientWidth || 320);
    this._layout.cssH = BOX_HEIGHT_PX;
  }

  _rebuildSkipMapping() {
    const v0 = this._viewStart();
    const v1 = this._viewEnd();
    if (!(v1 > v0)) {
      this.skipMapping = null;
      return;
    }
    const skips = [
      ...(this.playbackSkipRanges || []),
      ...this._collectDeletedInView(v0, v1),
    ];
    this.skipMapping = buildEdlSkipMapping({ start: v0, end: v1 }, skips);
  }

  _collectDeletedInView(v0, v1) {
    const cue = this._cue;
    if (!cue) return [];
    return collectDeletedRangesSec(getCueWords(cue), v0, v1);
  }

  /**
   * @param {number} t media/program sec in view
   * @param {number} [cssW]
   */
  timeToX(t, cssW) {
    const w = cssW || this._layout.cssW;
    this._rebuildSkipMapping();
    if (this.skipMapping) return this.skipMapping.mediaSecToPixel(t, w);
    const v0 = this._viewStart();
    const span = this._viewSpan();
    if (span <= 0) return 0;
    return ((t - v0) / span) * w;
  }

  /**
   * @param {number} x
   */
  xToTime(x) {
    const w = this._layout.cssW;
    if (w <= 0) return 0;
    this._rebuildSkipMapping();
    if (this.skipMapping) return this.skipMapping.pixelToMediaSec(x, w);
    const v0 = this._viewStart();
    return v0 + (x / w) * this._viewSpan();
  }

  /**
   * @param {number} t
   * @param {number} [cssW]
   */
  timeToPct(t, cssW) {
    const w = cssW || this._layout.cssW;
    const x = this.timeToX(t, w);
    return (x / w) * 100;
  }

  draw() {
    const canvas = this.canvas;
    if (!canvas || !this.peaksData || !this.viewWindow) return;
    const cue = this._cue;
    if (!cue) return;

    this._updateLayout();
    this._rebuildSkipMapping();
    const metrics = resolvePeaksTimelineMetrics(this.peaksData, this.mediaDurationHintSec ?? undefined);
    if (!metrics) return;

    const v0 = this._viewStart();
    const v1 = this._viewEnd();
    const centerVis = getVisibleWordCenterIndex(cue, this.focusWordStorageIndex);

    let fillBands = null;
    if (this.editRange) {
      fillBands = buildWordFillBandsFromEditRange(
        cue,
        centerVis,
        this.editRange,
        v0,
        v1,
      );
    } else if (centerVis >= 0) {
      fillBands = buildWordFillBands(cue, centerVis, v0, v1);
    }

    const deleted = collectDeletedRangesSec(getCueWords(cue), v0, v1);

    drawWordContextWaveform(canvas, metrics, v0, v1, deleted, fillBands, {
      heightCssPx: this._layout.cssH,
      background: "#0c1018",
      skipMapping: this.skipMapping,
      gain: WAVE_GAIN,
      topPaddingPx: 4,
    });
  }
}
