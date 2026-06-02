/**
 * HTML5 Canvas + Web Audio API 파형 렌더러.
 * CSS/ctx.scale()로 늘리지 않고, 보이는 시간 구간만 재샘플링해 그립니다.
 */

/** @typedef {{ background?: string, waveform?: string, baseline?: string }} WaveformColors */

export const DEFAULT_WAVEFORM_COLORS = {
  background: "#2d7d5a",
  waveform: "rgba(230, 247, 255, 0.96)",
  baseline: "rgba(210, 245, 235, 0.98)",
};

/** 무음 구간: 중앙 기준 2px 실선 */
const SILENCE_BAR_HEIGHT_PX = 2;
const SILENCE_WAVE_COLOR = "rgba(255, 255, 255, 0.32)";

/** 룰러·상태 표시용 시:분:초 */
export function formatWaveformTimeLabel(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const total = Math.max(0, sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * @typedef {Object} WaveformRenderView
 * @property {number} pxPerSec 초당 픽셀(시간축 줌)
 * @property {number} [scrollLeftPx] 가로 스크롤(px) → 시작 시간
 * @property {number} [canvasWidth] CSS 픽셀 너비
 * @property {number} [canvasHeight] CSS 픽셀 높이
 * @property {number} [silenceThreshold] peaks_db 없을 때 상대 진폭 임계(0~1)
 * @property {boolean} [flattenSilence] true면 threshold 이하를 2px 실선(기본 true)
 * @property {number} [silenceThresholdDb] flattenSilence + peaks_db일 때 dB 임계
 * @property {number} [rulerHeight] 하단 룰러 높이
 * @property {boolean} [showRuler]
 */

/**
 * @typedef {Object} WaveformDrawResult
 * @property {number} startTimeSec
 * @property {number} endTimeSec
 * @property {number} pxPerSec
 * @property {number} scrollLeftPx
 */

export class WaveformRenderer {
  /**
   * @param {{ audioBuffer?: AudioBuffer, channelData?: Float32Array, sampleRate?: number, peaks?: number[], durationSec: number }} source
   */
  constructor(source) {
    if (source.audioBuffer) {
      const buf = source.audioBuffer;
      this._channel = buf.getChannelData(0);
      this._sampleRate = buf.sampleRate;
      this._durationSec = buf.duration;
      this._peaks = null;
    } else if (source.channelData && source.sampleRate) {
      this._channel = source.channelData;
      this._sampleRate = source.sampleRate;
      this._durationSec =
        source.durationSec > 0
          ? source.durationSec
          : source.channelData.length / source.sampleRate;
      this._peaks = null;
    } else if (source.peaks && source.durationSec > 0) {
      this._peaks = source.peaks;
      this._peaksDb = source.peaksDb ?? null;
      this._durationSec = source.durationSec;
      this._sampleRate = 0;
      this._channel = null;
    } else {
      throw new Error("WaveformRenderer: audioBuffer, channelData, 또는 peaks가 필요합니다.");
    }
    this._peaksDb = this._peaksDb ?? null;
    this._peakMax = this._peaks ? this._computePeakMax(this._peaks) : 1;
  }

  /** @param {number[]} peaks */
  _computePeakMax(peaks) {
    let mx = 1e-18;
    for (let i = 0; i < peaks.length; i += 1) {
      const p = peaks[i] ?? 0;
      if (p > mx) mx = p;
    }
    return mx;
  }

  get durationSec() {
    return this._durationSec;
  }

  /** 전체 타임라인이 width(px)에 맞도록 px/s 계산 */
  static pxPerSecFit(durationSec, widthPx) {
    if (durationSec <= 1e-9 || widthPx < 1) return 100;
    return widthPx / durationSec;
  }

  /**
   * @param {File|Blob} file
   * @returns {Promise<WaveformRenderer>}
   */
  static async fromAudioFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const ctx = new AudioContext();
    try {
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      return new WaveformRenderer({ audioBuffer });
    } finally {
      await ctx.close();
    }
  }

  /**
   * @param {number[]} peaks
   * @param {number} durationSec
   * @param {number[] | null} [peaksDb]
   */
  static fromPeaks(peaks, durationSec, peaksDb = null) {
    return new WaveformRenderer({ peaks, durationSec, peaksDb });
  }

  /**
   * @param {number} scrollLeftPx
   * @param {number} pxPerSec
   * @param {number} canvasWidthPx
   */
  visibleTimeWindow(scrollLeftPx, pxPerSec, canvasWidthPx) {
    const dur = this._durationSec;
    const start = Math.max(0, scrollLeftPx / Math.max(pxPerSec, 1e-9));
    const end = Math.min(dur, start + canvasWidthPx / Math.max(pxPerSec, 1e-9));
    return { startTimeSec: start, endTimeSec: end };
  }

  /** 스크롤 가능한 전체 트랙 너비(px) */
  totalWidthPx(pxPerSec) {
    return Math.max(1, Math.ceil(this._durationSec * pxPerSec));
  }

  /**
   * 보이는 구간만 픽셀당 피크 추출 (windowing).
   * @param {number} startTimeSec
   * @param {number} endTimeSec
   * @param {number} pixelCount
   * @param {number} silenceThreshold
   * @returns {Float32Array}
   */
  resamplePeaksForWindow(
    startTimeSec,
    endTimeSec,
    pixelCount,
    silenceThreshold,
    flattenSilence,
    silenceThresholdDb,
  ) {
    const peaks = new Float32Array(Math.max(1, pixelCount));
    const silent = new Uint8Array(Math.max(1, pixelCount));
    if (pixelCount < 1 || endTimeSec <= startTimeSec) {
      return { peaks, silent };
    }

    if (this._channel) {
      return this._resampleFromChannel(
        startTimeSec,
        endTimeSec,
        pixelCount,
        silenceThreshold,
        flattenSilence,
      );
    }
    return this._resampleFromPeakColumns(
      startTimeSec,
      endTimeSec,
      pixelCount,
      silenceThreshold,
      flattenSilence,
      silenceThresholdDb,
    );
  }

  /**
   * @param {number} startTimeSec
   * @param {number} endTimeSec
   * @param {number} pixelCount
   * @param {number} silenceThreshold
   */
  _resampleFromChannel(startTimeSec, endTimeSec, pixelCount, silenceThreshold, flattenSilence) {
    const out = new Float32Array(pixelCount);
    const silent = new Uint8Array(pixelCount);
    const sr = this._sampleRate;
    const data = this._channel;
    if (!data || sr <= 0) return { peaks: out, silent };

    const i0 = Math.max(0, Math.floor(startTimeSec * sr));
    const i1 = Math.min(data.length, Math.ceil(endTimeSec * sr));
    if (i1 <= i0) return { peaks: out, silent };

    const span = i1 - i0;
    for (let px = 0; px < pixelCount; px += 1) {
      const sStart = i0 + Math.floor((px * span) / pixelCount);
      const sEnd = i0 + Math.floor(((px + 1) * span) / pixelCount);
      if (sEnd <= sStart) {
        const v = Math.abs(data[Math.min(sStart, data.length - 1)] ?? 0);
        const isSilent = flattenSilence && v < silenceThreshold;
        silent[px] = isSilent ? 1 : 0;
        out[px] = isSilent ? 0 : v;
        continue;
      }
      let peak = 0;
      for (let s = sStart; s < sEnd; s += 1) {
        const av = Math.abs(data[s] ?? 0);
        if (av > peak) peak = av;
      }
      const isSilent = flattenSilence && peak < silenceThreshold;
      silent[px] = isSilent ? 1 : 0;
      out[px] = isSilent ? 0 : peak;
    }
    return { peaks: out, silent };
  }

  /**
   * @param {number} startTimeSec
   * @param {number} endTimeSec
   * @param {number} pixelCount
   * @param {number} silenceThreshold
   */
  _resampleFromPeakColumns(
    startTimeSec,
    endTimeSec,
    pixelCount,
    silenceThreshold,
    flattenSilence,
    silenceThresholdDb,
  ) {
    const out = new Float32Array(pixelCount);
    const silent = new Uint8Array(pixelCount);
    const peaks = this._peaks;
    const peaksDb = this._peaksDb;
    const dur = this._durationSec;
    const n = peaks?.length ?? 0;
    if (!peaks || n < 1 || dur <= 1e-9) return { peaks: out, silent };

    const useDb =
      flattenSilence &&
      peaksDb &&
      peaksDb.length === n &&
      Number.isFinite(silenceThresholdDb);
    const relThresh =
      flattenSilence && !useDb && silenceThreshold <= 1
        ? silenceThreshold * this._peakMax
        : 0;

    for (let px = 0; px < pixelCount; px += 1) {
      const t0 = startTimeSec + (px / pixelCount) * (endTimeSec - startTimeSec);
      const t1 = startTimeSec + ((px + 1) / pixelCount) * (endTimeSec - startTimeSec);
      const c0 = Math.max(0, Math.floor((t0 / dur) * n));
      const c1 = Math.min(n - 1, Math.max(c0, Math.ceil((t1 / dur) * n) - 1));
      let peak = 0;
      let maxDb = Number.NEGATIVE_INFINITY;
      for (let c = c0; c <= c1; c += 1) {
        const p = peaks[c] ?? 0;
        if (p > peak) peak = p;
        if (useDb) {
          const db = peaksDb[c];
          if (Number.isFinite(db) && db > maxDb) maxDb = db;
        }
      }
      const norm = this._peakMax > 1e-18 ? peak / this._peakMax : 0;
      let isSilent = false;
      if (flattenSilence) {
        if (useDb) {
          isSilent = !Number.isFinite(maxDb) || maxDb <= silenceThresholdDb;
        } else {
          isSilent = norm < relThresh;
        }
      }
      silent[px] = isSilent ? 1 : 0;
      out[px] = isSilent ? 0 : norm;
    }
    return { peaks: out, silent };
  }

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {WaveformRenderView} view
   * @param {WaveformColors} [colors]
   * @returns {WaveformDrawResult}
   */
  render(canvas, view, colors = DEFAULT_WAVEFORM_COLORS) {
    const cssW = Math.max(1, Math.floor(view.canvasWidth ?? canvas.clientWidth ?? 800));
    const rulerH = view.showRuler !== false ? (view.rulerHeight ?? 36) : 0;
    const cssH = Math.max(1, Math.floor(view.canvasHeight ?? 280));
    const waveH = cssH - rulerH;
    const pxPerSec = Math.max(1e-6, view.pxPerSec);
    const scrollLeftPx = Math.max(0, view.scrollLeftPx ?? 0);
    const flattenSilence = view.flattenSilence === true;
    const silenceThreshold = view.silenceThreshold ?? 0.01;
    const silenceThresholdDb = view.silenceThresholdDb;

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return {
        startTimeSec: 0,
        endTimeSec: 0,
        pxPerSec,
        scrollLeftPx,
      };
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { startTimeSec, endTimeSec } = this.visibleTimeWindow(
      scrollLeftPx,
      pxPerSec,
      cssW,
    );
    const { peaks: rawPeaks, silent } = this.resamplePeaksForWindow(
      startTimeSec,
      endTimeSec,
      cssW,
      silenceThreshold,
      flattenSilence,
      silenceThresholdDb,
    );
    const peaks = this._smoothDisplayPeaks(rawPeaks, silent);

    this._drawWaveform(ctx, cssW, waveH, peaks, silent, colors);
    this._drawCenterBaseline(ctx, cssW, waveH, colors.baseline ?? DEFAULT_WAVEFORM_COLORS.baseline);

    if (rulerH > 0) {
      this._drawRuler(
        ctx,
        cssW,
        waveH,
        rulerH,
        startTimeSec,
        endTimeSec,
        pxPerSec,
      );
    }

    return { startTimeSec, endTimeSec, pxPerSec, scrollLeftPx };
  }

  /**
   * @param {Float32Array} peaks
   * @param {Uint8Array} silent
   */
  _smoothDisplayPeaks(peaks, silent) {
    if (peaks.length < 3) return peaks;
    const out = new Float32Array(peaks.length);
    for (let i = 0; i < peaks.length; i += 1) {
      if (silent[i]) {
        out[i] = 0;
        continue;
      }
      const lo = Math.max(0, i - 1);
      const hi = Math.min(peaks.length - 1, i + 1);
      let mx = 0;
      for (let j = lo; j <= hi; j += 1) {
        if (silent[j]) continue;
        if ((peaks[j] ?? 0) > mx) mx = peaks[j];
      }
      out[i] = mx > 0 ? mx : peaks[i];
    }
    return out;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w
   * @param {number} waveH
   * @param {Float32Array} peaks normalized 0..1
   * @param {Uint8Array} silent
   * @param {WaveformColors} colors
   */
  _drawWaveform(ctx, w, waveH, peaks, silent, colors) {
    ctx.fillStyle = colors.background ?? DEFAULT_WAVEFORM_COLORS.background;
    ctx.fillRect(0, 0, w, waveH);

    const cy = waveH / 2;
    const vertPad = 2;
    const halfMax = Math.max(2, (waveH * 0.78) / 2 - vertPad);
    const silenceHalf = SILENCE_BAR_HEIGHT_PX / 2;
    const vocalColor = colors.waveform ?? DEFAULT_WAVEFORM_COLORS.waveform;

    let mx = 1e-18;
    for (let i = 0; i < peaks.length; i += 1) {
      if (silent[i]) continue;
      if (peaks[i] > mx) mx = peaks[i];
    }

    for (let x = 0; x < w; x += 1) {
      if (silent[x]) {
        ctx.fillStyle = SILENCE_WAVE_COLOR;
        ctx.fillRect(x, cy - silenceHalf, 1, SILENCE_BAR_HEIGHT_PX);
        continue;
      }

      const raw = peaks[x] ?? 0;
      if (raw < 1e-7) {
        ctx.fillStyle = SILENCE_WAVE_COLOR;
        ctx.fillRect(x, cy - silenceHalf, 1, SILENCE_BAR_HEIGHT_PX);
        continue;
      }

      const amp =
        mx > 1e-18
          ? Math.sqrt(Math.max(0, Math.min(1, raw / mx)))
          : Math.sqrt(Math.max(0, raw));
      const hh = Math.max(2, amp * halfMax);
      ctx.fillStyle = vocalColor;
      const x0 = x;
      const x1 = x + 1;
      ctx.beginPath();
      ctx.moveTo(x0, cy);
      ctx.lineTo(x0, cy - hh);
      ctx.lineTo(x1, cy - hh);
      ctx.lineTo(x1, cy);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x0, cy);
      ctx.lineTo(x0, cy + hh);
      ctx.lineTo(x1, cy + hh);
      ctx.lineTo(x1, cy);
      ctx.closePath();
      ctx.fill();
    }
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w
   * @param {number} waveH
   * @param {string} [color]
   */
  static drawCenterBaseline(ctx, w, waveH, color) {
    const cy = Math.floor(waveH / 2) + 0.5;
    ctx.strokeStyle = color ?? DEFAULT_WAVEFORM_COLORS.baseline;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(w, cy);
    ctx.stroke();
  }

  /** @param {CanvasRenderingContext2D} ctx */
  _drawCenterBaseline(ctx, w, waveH, color) {
    WaveformRenderer.drawCenterBaseline(ctx, w, waveH, color);
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   */
  _drawRuler(ctx, w, waveH, rulerH, startSec, endSec, pxPerSec) {
    const RULER_BG = "#0f1115";
    ctx.fillStyle = RULER_BG;
    ctx.fillRect(0, waveH, w, rulerH);
    ctx.strokeStyle = "rgba(55, 55, 55, 1)";
    ctx.beginPath();
    ctx.moveTo(0, waveH);
    ctx.lineTo(w, waveH);
    ctx.stroke();

    const span = endSec - startSec;
    if (span <= 1e-9) return;

    let minor = 1;
    if (span > 30) minor = 5;
    if (span > 120) minor = 10;
    if (span > 600) minor = 30;

    const visDur = span;
    let major = minor * 5;
    if (pxPerSec * minor < 4) {
      minor = Math.max(0.1, minor / 5);
      major = minor * 5;
    }

    const t0 = Math.floor(startSec / minor) * minor;
    ctx.fillStyle = "rgba(200, 200, 200, 0.95)";
    ctx.font = "11px system-ui, sans-serif";
    let lastLabelX = -999;

    for (let t = t0; t <= endSec + minor * 0.5; t += minor) {
      if (t < startSec - 1e-9) continue;
      const x = Math.floor((t - startSec) * pxPerSec);
      if (x < 0 || x > w) continue;
      const kRound = Math.round(t / major);
      const isMajor = Math.abs(t - kRound * major) < minor * 0.46 || t < 1e-6;
      const tickH = isMajor ? 12 : 5;
      ctx.strokeStyle = isMajor ? "rgba(150,150,150,1)" : "rgba(85,85,85,1)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, waveH + rulerH - 1);
      ctx.lineTo(x, waveH + rulerH - 1 - tickH);
      ctx.stroke();
      if (isMajor && pxPerSec * major >= 24 && x - lastLabelX >= 40) {
        const label =
          visDur < 8
            ? `${Math.max(0, t).toFixed(t < 100 ? 1 : 0)}s`
            : formatWaveformTimeLabel(t);
        ctx.fillText(label, Math.min(x + 3, w - 52), waveH + 18);
        lastLabelX = x;
      }
    }
  }
}
