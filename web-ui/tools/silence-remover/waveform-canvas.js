/**
 * Canvas 파형 + PCM 열 기반 무음 하이라이트.
 * 파형 본체는 waveform-renderer.js (시간축 재샘플링, CSS 스케일 줌 없음).
 */

import { DEFAULT_WAVEFORM_COLORS, WaveformRenderer } from "./waveform-renderer.js";

/** @typedef {{ peaks: number[], peaks_db: number[], duration_sec: number, column_count: number, timeline_sec: number, mean_volume_db: number, max_volume_db?: number | null }} WaveformPeaksData */

const SILENCE_FILL = "rgba(210, 58, 255, 0.36)";
const SILENCE_EDGE_DARK = "rgba(12, 28, 18, 0.94)";
const SILENCE_EDGE_LIGHT = "rgba(255, 255, 255, 0.98)";
const SCOPE_SILENCE_REL_FLOOR = 0.04;

/**
 * @param {number} noiseDb
 * @param {number} meanDb
 * @param {number | null | undefined} maxDb
 */
export function resolveSilenceThresholdDb(noiseDb, meanDb, maxDb) {
  let cap = meanDb - 3;
  if (maxDb != null && Number.isFinite(maxDb)) {
    cap = Math.min(cap, maxDb - 8);
  }
  let thresh = Math.min(noiseDb, cap);
  thresh = Math.max(thresh, meanDb - 28);
  return Math.max(-70, Math.min(-12, thresh));
}

/**
 * @param {number[]} peaksDb
 * @param {number} threshDb
 */
function peaksSilentMask(peaksDb, threshDb) {
  return peaksDb.map((db) => db <= threshDb);
}

/**
 * @param {boolean[]} silent
 * @param {number} maxHole
 */
function bridgeSilentMask(silent, maxHole) {
  if (maxHole < 1 || silent.length < 3) return silent;
  const out = silent.slice();
  const n = out.length;
  let i = 0;
  while (i < n) {
    if (out[i]) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < n && !out[j]) j += 1;
    const hole = j - i;
    if (hole > 0 && hole <= maxHole && i > 0 && j < n && out[i - 1] && out[j]) {
      for (let k = i; k < j; k += 1) out[k] = true;
    }
    i = j > i ? j : i + 1;
  }
  return out;
}

/**
 * @param {number[]} peaks
 */
function peakMaxValue(peaks) {
  let mx = 1e-18;
  for (let i = 0; i < peaks.length; i += 1) {
    const p = peaks[i] ?? 0;
    if (p > mx) mx = p;
  }
  return mx;
}

/**
 * @param {WaveformPeaksData} data
 * @param {{ noiseDb: number, minSilenceSec: number, meanVolumeDb?: number, maxVolumeDb?: number | null }} opts
 * @returns {Array<[number, number]>}
 */
export function computeSilentColumnRanges(data, opts) {
  const n = data.column_count;
  const timeline = data.timeline_sec;
  if (n < 1 || timeline <= 1e-9) return [];

  const meanDb = opts.meanVolumeDb ?? data.mean_volume_db;
  const maxDb = opts.maxVolumeDb ?? data.max_volume_db;
  const thresh = resolveSilenceThresholdDb(opts.noiseDb, meanDb, maxDb);
  const peaksDb = data.peaks_db?.length === n ? data.peaks_db : null;
  let silent;
  if (peaksDb) {
    silent = peaksSilentMask(peaksDb, thresh);
  } else {
    const mx = peakMaxValue(data.peaks);
    const floor = mx * SCOPE_SILENCE_REL_FLOOR;
    silent = data.peaks.map((p) => p < floor);
  }

  const colDt = timeline / n;
  const bridgeHoles = colDt > 1e-9 ? Math.max(0, Math.min(8, Math.round(0.04 / colDt))) : 2;
  silent = bridgeSilentMask(silent, bridgeHoles);

  const minCols = Math.max(1, Math.round((opts.minSilenceSec / timeline) * n));
  /** @type {Array<[number, number]>} */
  const ranges = [];
  let i = 0;
  while (i < n) {
    if (!silent[i]) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < n && silent[j]) j += 1;
    if (j - i >= minCols) ranges.push([i, j - 1]);
    i = j;
  }
  return ranges;
}

/** @typedef {{ start_sec: number, end_sec: number }} TimeSegment */

/**
 * Auto_Cutter `_vocal_intervals_ms_with_padding` 와 동일: 무음 사이 말소리 + padding·병합.
 * @param {TimeSegment[]} silences
 * @param {number} durationSec
 * @param {number} paddingMs
 * @returns {Array<[number, number]>} [start_ms, end_ms]
 */
export function vocalIntervalsWithPadding(silences, durationSec, paddingMs) {
  const durationMs = Math.max(0, Number(durationSec)) * 1000;
  if (durationMs <= 0) return [];

  const sorted = [...silences].sort((a, b) => a.start_sec - b.start_sec);
  /** @type {Array<[number, number]>} */
  const raw = [];
  let cursorSec = 0;
  for (const seg of sorted) {
    const silStart = Number(seg.start_sec) || 0;
    const silEnd = Number(seg.end_sec) || 0;
    if (silStart > cursorSec + 1e-9) {
      raw.push([cursorSec * 1000, silStart * 1000]);
    }
    cursorSec = Math.max(cursorSec, silEnd);
  }
  if (cursorSec * 1000 < durationMs - 1e-3) {
    raw.push([cursorSec * 1000, durationMs]);
  }

  const pad = Math.max(0, Number(paddingMs) || 0);
  /** @type {Array<[number, number]>} */
  const adjusted = [];
  for (const [startMs, endMs] of raw) {
    const padStart = Math.max(0, startMs - pad);
    const padEnd = Math.min(durationMs, endMs + pad);
    if (!adjusted.length) {
      adjusted.push([padStart, padEnd]);
      continue;
    }
    const prev = adjusted[adjusted.length - 1];
    if (prev[1] >= padStart) {
      prev[1] = Math.max(prev[1], padEnd);
    } else {
      adjusted.push([padStart, padEnd]);
    }
  }
  return adjusted.filter(([a, b]) => b > a + 1e-3);
}

/**
 * 말소리 사이 간격이 minSilenceSec 미만이면 한 덩어리로 병합(EDL·오버레이 공통).
 * @param {Array<[number, number]>} vocalMs
 * @param {number} minSilenceSec
 * @returns {Array<[number, number]>}
 */
export function mergeVocalIntervalsByMinGap(vocalMs, minSilenceSec) {
  const minGapMs = Math.max(0, Number(minSilenceSec) || 0) * 1000;
  if (minGapMs <= 1e-3 || !vocalMs?.length || vocalMs.length <= 1) {
    return vocalMs ?? [];
  }
  const ordered = [...vocalMs].sort((a, b) => a[0] - b[0]);
  /** @type {Array<[number, number]>} */
  const merged = [[ordered[0][0], ordered[0][1]]];
  for (let i = 1; i < ordered.length; i++) {
    const [startMs, endMs] = ordered[i];
    const gap = startMs - merged[merged.length - 1][1];
    if (gap < minGapMs - 1e-3) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], endMs);
    } else {
      merged.push([startMs, endMs]);
    }
  }
  return merged.filter(([a, b]) => b > a + 1e-3);
}

/**
 * 패딩 적용된 말소리(ms) 사이 = 무음 구간(초). 백엔드 `_silence_segments_from_vocal_ms` 와 동일.
 * @param {Array<[number, number]>} vocalMs
 * @param {number} durationSec
 * @returns {TimeSegment[]}
 */
export function silenceSegmentsFromVocalMs(vocalMs, durationSec) {
  const dur = Math.max(0, Number(durationSec) || 0);
  if (dur <= 1e-9) return [];
  if (!vocalMs?.length) return [{ start_sec: 0, end_sec: dur }];

  /** @type {TimeSegment[]} */
  const out = [];
  let cursor = 0;
  const sorted = [...vocalMs].sort((a, b) => a[0] - b[0]);
  for (const [startMs, endMs] of sorted) {
    const startS = Math.max(0, startMs / 1000);
    const endS = Math.min(dur, endMs / 1000);
    if (startS > cursor + 1e-6) {
      out.push({ start_sec: cursor, end_sec: startS });
    }
    cursor = Math.max(cursor, endS);
  }
  if (cursor < dur - 1e-6) {
    out.push({ start_sec: cursor, end_sec: dur });
  }
  return out;
}

/**
 * @param {TimeSegment[]} segments
 * @param {number} timelineSec
 * @param {number} columnCount
 * @param {number} [minSilenceSec]
 * @returns {Array<[number, number]>}
 */
export function timeSegmentsToColumnRanges(
  segments,
  timelineSec,
  columnCount,
  minSilenceSec = 0,
) {
  if (!segments.length || timelineSec <= 1e-9 || columnCount < 1) return [];
  const n = columnCount;
  const minSec = Math.max(0, Number(minSilenceSec) || 0);
  /** @type {Array<[number, number]>} */
  const ranges = [];
  for (const seg of segments) {
    const t0 = Math.max(0, Number(seg.start_sec) || 0);
    const t1 = Math.min(timelineSec, Number(seg.end_sec) || 0);
    if (t1 <= t0 || t1 - t0 < minSec - 1e-6) continue;
    let c0 = Math.floor((t0 / timelineSec) * n);
    let c1 = Math.min(n - 1, Math.ceil((t1 / timelineSec) * n) - 1);
    if (c1 < c0) c1 = c0;
    ranges.push([c0, c1]);
  }
  return ranges;
}

/**
 * EDL·말소리 여백과 동일한 무음 오버레이(피크 임계값 + padding).
 * @param {WaveformPeaksData} data
 * @param {{
 *   rawSilences: TimeSegment[],
 *   paddingMs: number,
 *   minSilenceSec: number,
 *   noiseDb?: number,
 *   meanVolumeDb?: number,
 *   maxVolumeDb?: number | null,
 * }} opts
 */
export function computePaddedSilenceColumnRanges(data, opts) {
  const timeline = data.timeline_sec;
  const n = data.column_count;
  if (n < 1 || timeline <= 1e-9) return [];

  const raw = opts.rawSilences ?? [];
  if (!raw.length) {
    return computeSilentColumnRanges(data, {
      noiseDb: opts.noiseDb ?? -40,
      minSilenceSec: opts.minSilenceSec,
      meanVolumeDb: opts.meanVolumeDb,
      maxVolumeDb: opts.maxVolumeDb,
    });
  }

  const vocalMs = mergeVocalIntervalsByMinGap(
    vocalIntervalsWithPadding(raw, timeline, opts.paddingMs),
    opts.minSilenceSec,
  );
  const silenceSegs = silenceSegmentsFromVocalMs(vocalMs, timeline);
  return timeSegmentsToColumnRanges(silenceSegs, timeline, n, 0);
}

/**
 * 편집 FPS 프레임 격자로 무음 열 구간 경계 스냅.
 * @param {Array<[number, number]>} ranges
 * @param {number} timelineSec
 * @param {number} columnCount
 * @param {number} editorFps
 */
export function snapColumnRangesToEditorFps(ranges, timelineSec, columnCount, editorFps) {
  const f = Number(editorFps);
  if (!ranges.length || !Number.isFinite(f) || f <= 0 || timelineSec <= 1e-9 || columnCount < 1) {
    return ranges;
  }
  const segments = columnRangesToTimeSegments(ranges, timelineSec, columnCount);
  const snapped = segments
    .map((s) => ({
      start_sec: Math.max(0, Math.round(s.start_sec * f) / f),
      end_sec: Math.min(timelineSec, Math.round(s.end_sec * f) / f),
    }))
    .filter((s) => s.end_sec > s.start_sec + 1e-6);
  return timeSegmentsToColumnRanges(snapped, timelineSec, columnCount, 0);
}

/**
 * 파형 peaks_db 미리보기: 민감도 → 최소 무음 → 말소리 여백 → FPS 격자 (EDL과 별도).
 * @param {WaveformPeaksData} data
 * @param {{
 *   noiseDb: number,
 *   minSilenceSec: number,
 *   paddingMs: number,
 *   meanVolumeDb?: number,
 *   maxVolumeDb?: number | null,
 *   editorFps?: number,
 * }} opts
 * @returns {Array<[number, number]>}
 */
export function computePreviewSilenceColumnRanges(data, opts) {
  const timeline = data.timeline_sec;
  const n = data.column_count;
  if (n < 1 || timeline <= 1e-9) return [];

  const rawColRanges = computeSilentColumnRanges(data, {
    noiseDb: opts.noiseDb,
    minSilenceSec: opts.minSilenceSec,
    meanVolumeDb: opts.meanVolumeDb,
    maxVolumeDb: opts.maxVolumeDb,
  });
  const rawSilences = columnRangesToTimeSegments(rawColRanges, timeline, n, 0);

  let ranges = computePaddedSilenceColumnRanges(data, {
    rawSilences,
    paddingMs: opts.paddingMs,
    minSilenceSec: opts.minSilenceSec,
    noiseDb: opts.noiseDb,
    meanVolumeDb: opts.meanVolumeDb,
    maxVolumeDb: opts.maxVolumeDb,
  });

  const fps = opts.editorFps;
  if (fps != null && Number(fps) > 0) {
    ranges = snapColumnRangesToEditorFps(ranges, timeline, n, fps);
  }
  return ranges;
}

/**
 * @param {Array<[number, number]>} columnRanges
 * @param {number} timelineSec
 * @param {number} columnCount
 * @returns {Array<{ start_sec: number, end_sec: number }>}
 */
export function columnRangesToTimeSegments(columnRanges, timelineSec, columnCount) {
  if (!columnRanges.length || timelineSec <= 1e-9 || columnCount < 1) return [];
  return columnRanges.map(([c0, c1]) => ({
    start_sec: (c0 / columnCount) * timelineSec,
    end_sec: ((c1 + 1) / columnCount) * timelineSec,
  }));
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w
 * @param {number} waveH
 * @param {number} startTimeSec
 * @param {number} pxPerSec
 * @param {Array<{ start_sec: number, end_sec: number }>} segments
 */
function drawSilenceOverlayTimeBased(ctx, w, waveH, startTimeSec, pxPerSec, segments) {
  const bandFrac = 0.48;
  const vm = (1 - bandFrac) * 0.5;
  const yBand0 = Math.round(waveH * vm);
  const yBand1 = Math.round(waveH * (1 - vm)) - 1;

  for (const seg of segments) {
    const a = Number(seg.start_sec) || 0;
    const b = Number(seg.end_sec) || 0;
    if (b <= a) continue;
    const x0 = Math.floor((a - startTimeSec) * pxPerSec);
    const x1 = Math.ceil((b - startTimeSec) * pxPerSec) - 1;
    if (x1 < 0 || x0 >= w) continue;
    const clipX0 = Math.max(0, x0);
    const clipX1 = Math.min(w - 1, x1);
    if (clipX1 < clipX0) continue;

    ctx.fillStyle = SILENCE_FILL;
    ctx.fillRect(clipX0, yBand0, clipX1 - clipX0 + 1, yBand1 - yBand0 + 1);
    for (const x of [clipX0, clipX1]) {
      ctx.strokeStyle = SILENCE_EDGE_DARK;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, yBand0);
      ctx.lineTo(x, yBand1);
      ctx.stroke();
      ctx.strokeStyle = SILENCE_EDGE_LIGHT;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yBand0);
      ctx.lineTo(x, yBand1);
      ctx.stroke();
    }
  }
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {WaveformPeaksData} data
 * @param {{
 *   noiseDb: number,
 *   minSilenceSec: number,
 *   height?: number,
 *   showRuler?: boolean,
 *   showSilenceOverlay?: boolean,
 *   silenceColumnRanges?: Array<[number, number]>,
 *   silenceTimeSegments?: TimeSegment[],
 *   pxPerSec: number,
 *   scrollLeftPx?: number,
 *   canvasWidth?: number,
 *   amplitudeSilenceThreshold?: number,
 *   renderer?: WaveformRenderer,
 * }} opts
 */
export function drawSilenceWaveform(canvas, data, opts) {
  const h = opts.height ?? 280;
  const rulerH = opts.showRuler !== false ? 36 : 0;
  const waveH = h - rulerH;
  const cssW = Math.max(1, Math.floor(opts.canvasWidth ?? canvas.clientWidth ?? 800));
  const pxPerSec = Math.max(1e-6, opts.pxPerSec);
  const scrollLeftPx = Math.max(0, opts.scrollLeftPx ?? 0);

  const renderer =
    opts.renderer ??
    WaveformRenderer.fromPeaks(data.peaks, data.timeline_sec, data.peaks_db);

  const threshDb = resolveSilenceThresholdDb(
    opts.noiseDb,
    data.mean_volume_db,
    data.max_volume_db,
  );

  const viewResult = renderer.render(
    canvas,
    {
      pxPerSec,
      scrollLeftPx,
      canvasWidth: cssW,
      canvasHeight: h,
      flattenSilence: opts.flattenSilence !== false,
      silenceThresholdDb: threshDb,
      silenceThreshold: opts.amplitudeSilenceThreshold ?? 0.01,
      rulerHeight: rulerH,
      showRuler: opts.showRuler !== false,
    },
    undefined,
  );

  if (!opts.showSilenceOverlay) return viewResult;

  const ctx = canvas.getContext("2d");
  if (!ctx) return viewResult;

  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  /** @type {TimeSegment[]} */
  let timeSegments;
  if (opts.silenceColumnRanges?.length) {
    timeSegments = columnRangesToTimeSegments(
      opts.silenceColumnRanges,
      data.timeline_sec,
      data.column_count,
    );
  } else if (opts.silenceTimeSegments?.length) {
    timeSegments = opts.silenceTimeSegments;
  } else {
    const colRanges = computeSilentColumnRanges(data, {
      noiseDb: opts.noiseDb,
      minSilenceSec: opts.minSilenceSec,
    });
    timeSegments = columnRangesToTimeSegments(
      colRanges,
      data.timeline_sec,
      data.column_count,
    );
  }

  drawSilenceOverlayTimeBased(
    ctx,
    cssW,
    waveH,
    viewResult.startTimeSec,
    pxPerSec,
    timeSegments,
  );

  WaveformRenderer.drawCenterBaseline(
    ctx,
    cssW,
    waveH,
    DEFAULT_WAVEFORM_COLORS.baseline,
  );

  return viewResult;
}

export { WaveformRenderer } from "./waveform-renderer.js";
