/**
 * HTML5 Canvas + Web Audio API 파형 렌더러.
 * CSS/ctx.scale()로 늘리지 않고, 보이는 시간 구간만 재샘플링해 그립니다.
 */

/** @typedef {{ background?: string, waveform?: string, baseline?: string }} WaveformColors */

export const DEFAULT_WAVEFORM_COLORS = {
  background: "#090c12",
  waveform: "rgba(45, 212, 191, 0.96)",
  baseline: "rgba(148, 163, 184, 0.72)",
};

/** 무음 구간: 중앙 기준 2px 실선 */
const SILENCE_BAR_HEIGHT_PX = 2;
const SILENCE_WAVE_COLOR = "rgba(251, 113, 133, 0.92)";

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
 * @property {{ start_sec: number, end_sec: number }[]} [silenceTimeSegments] Exact cut ranges; [] preserves all peaks.
 * @property {number} [rulerHeight] 하단 룰러 높이
 * @property {boolean} [showRuler]
 * @property {"top" | "bottom"} [rulerPosition] top = 다빈치식 위쪽 타임코드 눈금자 + 초록 클립
 * @property {number} [fps] 타임코드 표기용 FPS
 * @property {string} [clipLabel] 클립 아래쪽에 쓸 파일 이름
 */

/**
 * @typedef {Object} WaveformDrawResult
 * @property {number} startTimeSec
 * @property {number} endTimeSec
 * @property {number} pxPerSec
 * @property {number} scrollLeftPx
 */

/** 다빈치 타임라인 색 (오디오 클립 = 초록 상자 + 연한 파형) */
const CLIP_COLORS = {
  track: "#1c1d21",
  grid: "rgba(255, 255, 255, 0.05)",
  fill: "#3a6a4e",
  border: "#244832",
  wave: "rgba(220, 244, 229, 0.95)",
  label: "rgba(240, 253, 244, 0.92)",
  cutLine: "rgba(251, 113, 133, 0.75)",
  ruler: "#232428",
  rulerEdge: "#34363c",
  tickMinor: "rgba(160, 163, 170, 0.55)",
  tickMajor: "rgba(190, 193, 200, 0.85)",
  rulerText: "rgba(214, 216, 222, 0.92)",
};

/** 표시용 정수 프레임레이트 (29.97 → 30, 23.976 → 24) — 비드롭 타임코드 */
function nominalFps(fps) {
  const f = Number(fps);
  return f > 0 ? Math.max(1, Math.round(f)) : 30;
}

/**
 * 프레임 수 → HH:MM:SS:FF (비드롭 타임코드, 다빈치 기본 표기)
 * @param {number} frames
 * @param {number} fps 실제 FPS (29.97 등)
 */
export function framesToTimecode(frames, fps) {
  const n = nominalFps(fps);
  const total = Math.max(0, Math.round(Number(frames) || 0));
  const ff = total % n;
  const secs = Math.floor(total / n);
  const pad = (v) => String(v).padStart(2, "0");
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}:${pad(ff)}`;
}

/** 초 → HH:MM:SS:FF @param {number} sec @param {number} fps */
export function formatTimecode(sec, fps) {
  const f = Number(fps) > 0 ? Number(fps) : 30;
  return framesToTimecode(Math.round(Math.max(0, sec) * f), f);
}

/**
 * 눈금 간격(타임코드 프레임 단위). 29.97 처럼 정수가 아닌 FPS 도 다빈치처럼 00:00:20:00 에 눈금이 서도록
 * 프레임 번호(= 타임코드)로 고르고, 화면 위치는 실제 시간(프레임 / 실제 FPS)으로 계산한다.
 * @returns {{ major: number, minor: number, fps: number }} major·minor = 프레임 수, fps = 실제 FPS
 */
function timecodeTicks(startSec, endSec, pxPerSec, fps) {
  const ui = waveformUiScale();
  const real = Number(fps) > 0 ? Number(fps) : 30;
  const n = nominalFps(real);
  const pxPerFrame = pxPerSec / real;
  const secs = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  const steps = [1, 2, 5, 10, ...(n % 2 === 0 ? [n / 2] : []), ...secs.map((v) => v * n)];
  const minLabelPx = 118 * ui;
  const major = steps.find((f) => f * pxPerFrame >= minLabelPx) ?? steps[steps.length - 1];
  let minor = major;
  for (const div of [10, 5, 2]) {
    if (major % div === 0 && (major / div) * pxPerFrame >= 6 * ui) {
      minor = major / div;
      break;
    }
  }
  return { major, minor, fps: real };
}

/** 보이는 구간 안의 step(프레임) 배수 눈금을 [프레임, x] 로 돌려준다 */
function tickPositions(startSec, endSec, pxPerSec, fps, step) {
  /** @type {Array<[number, number]>} */
  const out = [];
  const f0 = Math.ceil((startSec * fps) / step - 1e-9) * step;
  for (let f = f0; f / fps <= endSec + 1e-9; f += step) out.push([f, Math.round((f / fps - startSec) * pxPerSec) + 0.5]);
  return out;
}

/** @param {CanvasRenderingContext2D} ctx */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), Math.max(0, r));
    return;
  }
  ctx.rect(x, y, Math.max(0, w), Math.max(0, h));
}

/** CSS 의 --u 배율과 같은 계산(화면 폭·높이에 비례, 1배~2.4배). 눈금 글자·높이를 화면에 맞춰 키운다. */
export function waveformUiScale() {
  if (typeof window === "undefined" || window.innerWidth < 1100) return 1;
  return Math.min(2.4, Math.max(1, Math.min(window.innerWidth / 1700, window.innerHeight / 820)));
}

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
    const rulerH = view.showRuler !== false ? (view.rulerHeight ?? Math.round(36 * waveformUiScale())) : 0;
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
    // 클립이 화면 폭보다 짧으면 보이는 구간(=클립 전체)은 pxPerSec 기준의 폭만 차지한다.
    // 예전에는 이 구간을 캔버스 전체 폭으로 늘려 그려서, 룰러·무음 띠(실제 배율)와 어긋났다.
    const windowPx = Math.max(1, Math.min(cssW, Math.round((endTimeSec - startTimeSec) * pxPerSec)));
    const { peaks: rawPeaks, silent } = this.resamplePeaksForWindow(
      startTimeSec,
      endTimeSec,
      windowPx,
      silenceThreshold,
      flattenSilence && !Array.isArray(view.silenceTimeSegments),
      silenceThresholdDb,
    );
    if (flattenSilence && Array.isArray(view.silenceTimeSegments)) {
      let segmentIndex = 0;
      const segments = view.silenceTimeSegments;
      for (let px = 0; px < windowPx; px += 1) {
        const t0 = startTimeSec + (px / windowPx) * (endTimeSec - startTimeSec);
        const t1 = startTimeSec + ((px + 1) / windowPx) * (endTimeSec - startTimeSec);
        while (segmentIndex < segments.length && segments[segmentIndex].end_sec < t1 - 1e-9) {
          segmentIndex += 1;
        }
        const segment = segments[segmentIndex];
        if (segment && t0 >= segment.start_sec - 1e-9 && t1 <= segment.end_sec + 1e-9) {
          silent[px] = 1;
          rawPeaks[px] = 0;
        }
      }
    }
    const peaks = this._smoothDisplayPeaks(rawPeaks, silent);

    // 다빈치식: 위쪽 타임코드 눈금자 + 남는 구간을 초록 클립으로
    if (view.rulerPosition === "top") {
      const waveTop = rulerH;
      ctx.fillStyle = CLIP_COLORS.track;
      ctx.fillRect(0, 0, cssW, cssH);
      const ticks = rulerH > 0 ? timecodeTicks(startTimeSec, endTimeSec, pxPerSec, view.fps) : null;
      ctx.save();
      ctx.translate(0, waveTop);
      if (ticks) this._drawGrid(ctx, waveH, tickPositions(startTimeSec, endTimeSec, pxPerSec, ticks.fps, ticks.major));
      this._drawClips(ctx, windowPx, waveH, startTimeSec, endTimeSec, pxPerSec, peaks, silent, view);
      ctx.restore();
      if (ticks) this._drawTimecodeRuler(ctx, cssW, rulerH, startTimeSec, endTimeSec, pxPerSec, view.fps, ticks);
      return { startTimeSec, endTimeSec, pxPerSec, scrollLeftPx, waveTop, waveH, rulerH };
    }

    ctx.fillStyle = colors.background ?? DEFAULT_WAVEFORM_COLORS.background;
    ctx.fillRect(0, 0, cssW, waveH);
    this._drawWaveform(ctx, windowPx, waveH, peaks, silent, colors);
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

    return { startTimeSec, endTimeSec, pxPerSec, scrollLeftPx, waveTop: 0, waveH, rulerH };
  }

  /**
   * 남는 구간(무음 구간의 여집합)을 초록 클립 상자로, 그 안에 연한 파형과 파일 이름을 그린다.
   * 잘린 구간은 어두운 트랙 위에 가는 선만 남긴다(빨간 표시는 waveform-canvas 가 덧그림).
   * @param {CanvasRenderingContext2D} ctx
   * @param {Float32Array} peaks
   * @param {Uint8Array} silent
   * @param {WaveformRenderView} view
   */
  _drawClips(ctx, windowPx, waveH, startSec, endSec, pxPerSec, peaks, silent, view) {
    const ui = waveformUiScale();
    const segs = Array.isArray(view.silenceTimeSegments) ? view.silenceTimeSegments : [];
    /** @type {Array<[number, number]>} */
    const keeps = [];
    let cursor = 0;
    for (const s of segs) {
      const a = Number(s.start_sec) || 0;
      const b = Number(s.end_sec) || 0;
      if (a > cursor) keeps.push([cursor, a]);
      cursor = Math.max(cursor, b);
    }
    if (cursor < this._durationSec) keeps.push([cursor, this._durationSec]);

    const pad = Math.max(2, Math.round(3 * ui));
    const y0 = pad;
    const y1 = waveH - pad;
    const labelH = waveH >= 90 ? Math.round(18 * ui) : 0;
    const waveBottom = y1 - labelH;
    const cy = (y0 + waveBottom) / 2;
    // 다빈치처럼 위아래 여백을 남긴다
    const halfMax = Math.max(2, ((waveBottom - y0) / 2) * 0.82);
    const label = String(view.clipLabel || "");
    ctx.font = `${Math.round(11.5 * ui)}px "Pretendard", system-ui, sans-serif`;

    let mx = 1e-18;
    for (let i = 0; i < peaks.length; i += 1) if (!silent[i] && peaks[i] > mx) mx = peaks[i];

    for (const [a, b] of keeps) {
      if (b <= startSec || a >= endSec) continue;
      const x0 = Math.round((a - startSec) * pxPerSec);
      const x1 = Math.round((b - startSec) * pxPerSec);
      const cw = Math.max(1, x1 - x0);
      ctx.fillStyle = CLIP_COLORS.fill;
      roundRect(ctx, x0 + 0.5, y0 + 0.5, cw - 1, y1 - y0 - 1, Math.min(4, cw / 3));
      ctx.fill();
      ctx.strokeStyle = CLIP_COLORS.border;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 + 1, y0 + 1, cw - 2, y1 - y0 - 2);
      ctx.clip();
      ctx.fillStyle = CLIP_COLORS.wave;
      const pa = Math.max(0, x0);
      const pb = Math.min(windowPx, x1);
      for (let x = pa; x < pb; x += 1) {
        if (silent[x]) continue;
        const raw = peaks[x] ?? 0;
        const amp = mx > 1e-18 ? Math.sqrt(Math.max(0, Math.min(1, raw / mx))) : 0;
        const hh = Math.max(0.75, amp * halfMax);
        ctx.fillRect(x, cy - hh, 1, hh * 2);
      }
      if (labelH && label && cw > 48 * ui) {
        ctx.fillStyle = CLIP_COLORS.label;
        ctx.textBaseline = "middle";
        ctx.fillText(`⛓ ${label}`, Math.max(x0, 0) + 6 * ui, y1 - labelH / 2 - 1);
        ctx.textBaseline = "alphabetic";
      }
      ctx.restore();
    }

    // 잘린 구간: 어두운 트랙 가운데 가는 선
    ctx.fillStyle = CLIP_COLORS.cutLine;
    for (let x = 0; x < windowPx; x += 1) if (silent[x]) ctx.fillRect(x, Math.round(cy) - 1, 1, 2);
  }

  /** 트랙 바탕의 세로 격자(큰 눈금 위치) @param {CanvasRenderingContext2D} ctx */
  _drawGrid(ctx, waveH, positions) {
    ctx.strokeStyle = CLIP_COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [, x] of positions) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, waveH);
    }
    ctx.stroke();
  }

  /**
   * 다빈치식 위쪽 눈금자: 위에서 내려오는 작은 눈금 + 큰 눈금 옆 타임코드(HH:MM:SS:FF).
   * @param {CanvasRenderingContext2D} ctx
   */
  _drawTimecodeRuler(ctx, w, rulerH, startSec, endSec, pxPerSec, fps, ticks) {
    const ui = waveformUiScale();
    ctx.fillStyle = CLIP_COLORS.ruler;
    ctx.fillRect(0, 0, w, rulerH);
    ctx.fillStyle = CLIP_COLORS.rulerEdge;
    ctx.fillRect(0, rulerH - 1, w, 1);

    const minorH = Math.round(5 * ui);
    const majorH = Math.round(rulerH * 0.55);
    ctx.strokeStyle = CLIP_COLORS.tickMinor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [, x] of tickPositions(startSec, endSec, pxPerSec, ticks.fps, ticks.minor)) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, minorH);
    }
    ctx.stroke();

    ctx.strokeStyle = CLIP_COLORS.tickMajor;
    ctx.fillStyle = CLIP_COLORS.rulerText;
    ctx.font = `${Math.round(11.5 * ui)}px Consolas, "D2Coding", monospace`;
    ctx.textBaseline = "middle";
    ctx.beginPath();
    for (const [f, x] of tickPositions(startSec, endSec, pxPerSec, ticks.fps, ticks.major)) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, majorH);
      ctx.fillText(framesToTimecode(f, ticks.fps), x + 5 * ui, rulerH * 0.66);
    }
    ctx.stroke();
    ctx.textBaseline = "alphabetic";
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
        const raw = peaks[x] ?? 0;
        const amp = mx > 1e-18 ? Math.sqrt(Math.max(0, Math.min(1, raw / mx))) : 0;
        const hh = raw < 1e-7 ? silenceHalf : Math.max(silenceHalf, Math.min(14, amp * halfMax * 0.2));
        ctx.fillStyle = SILENCE_WAVE_COLOR;
        ctx.fillRect(x, cy - hh, 1, hh * 2);
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
    ctx.strokeStyle = color ?? "rgba(100, 116, 139, .35)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (const y of [waveH * 0.38, waveH * 0.62]) {
      ctx.beginPath();
      ctx.moveTo(0, Math.floor(y) + 0.5);
      ctx.lineTo(w, Math.floor(y) + 0.5);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  /** @param {CanvasRenderingContext2D} ctx */
  _drawCenterBaseline(ctx, w, waveH, color) {
    WaveformRenderer.drawCenterBaseline(ctx, w, waveH, color);
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   */
  _drawRuler(ctx, w, waveH, rulerH, startSec, endSec, pxPerSec) {
    const RULER_BG = "#0d1017";
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
    const uiScale = waveformUiScale();
    ctx.font = `${Math.round(13 * uiScale)}px system-ui, sans-serif`;
    let lastLabelX = -999;

    for (let t = t0; t <= endSec + minor * 0.5; t += minor) {
      if (t < startSec - 1e-9) continue;
      const x = Math.floor((t - startSec) * pxPerSec);
      if (x < 0 || x > w) continue;
      const kRound = Math.round(t / major);
      const isMajor = Math.abs(t - kRound * major) < minor * 0.46 || t < 1e-6;
      const tickH = Math.round((isMajor ? 12 : 5) * uiScale);
      ctx.strokeStyle = isMajor ? "rgba(150,150,150,1)" : "rgba(85,85,85,1)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, waveH + rulerH - 1);
      ctx.lineTo(x, waveH + rulerH - 1 - tickH);
      ctx.stroke();
      if (isMajor && pxPerSec * major >= 24 && x - lastLabelX >= 48 * uiScale) {
        const label =
          visDur < 8
            ? `${Math.max(0, t).toFixed(t < 100 ? 1 : 0)}s`
            : formatWaveformTimeLabel(t);
        ctx.fillText(label, Math.min(x + 3, w - 58 * uiScale), waveH + Math.round(20 * uiScale));
        lastLabelX = x;
      }
    }
  }
}
