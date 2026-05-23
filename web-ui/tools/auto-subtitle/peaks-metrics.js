/**
 * AutoSubtitle peakPixelMapping.ts + agent peaks API 페이로드 통합.
 */

import { detectPeaksFormat, getAudiowaveformDataArray } from "./waveform-json.js";

/**
 * @typedef {object} PeaksTimelineMetrics
 * @property {readonly number[]} data min/max interleaved (audiowaveform) 또는 synthetic
 * @property {readonly number[]} [columnPeaks] agent 열 피크 (원본)
 * @property {readonly number[]} [peaksDb]
 * @property {number} pixelCount
 * @property {number} durationSec
 * @property {'agent-columns' | 'audiowaveform-minmax'} format
 * @property {number} peakMax column 정규화용
 */

/**
 * Audiowaveform JSON 타임라인 길이 (stitchWaveformJson.exactTimelineDurationSecFromWaveformJson).
 *
 * @param {import('./waveform-json.js').JsonWaveformData} json
 * @param {number} [mediaDurationHintSec]
 */
export function exactTimelineDurationSecFromWaveformJson(json, mediaDurationHintSec) {
  const data = getAudiowaveformDataArray(json);
  if (!data || data.length < 4) return null;

  const sr =
    typeof json.sample_rate === "number" && Number.isFinite(json.sample_rate) && json.sample_rate > 0
      ? json.sample_rate
      : null;
  let spp =
    typeof json.samples_per_pixel === "number" &&
    Number.isFinite(json.samples_per_pixel) &&
    json.samples_per_pixel > 0
      ? json.samples_per_pixel
      : null;

  const pixelCount = Math.floor(data.length / 2);
  if (pixelCount <= 0 || !sr) return null;

  if (!spp) {
    const hint = mediaDurationHintSec;
    if (!(typeof hint === "number" && Number.isFinite(hint) && hint > 0)) return null;
    spp = (sr * hint) / pixelCount;
  }

  const impliedDur = (pixelCount * spp) / sr;
  return Number.isFinite(impliedDur) && impliedDur > 0 ? impliedDur : null;
}

/**
 * @param {import('./waveform-json.js').JsonWaveformData | import('./waveform-json.js').AgentPeaksPayload | null | undefined} json
 * @param {number} [mediaDurationHintSec]
 * @returns {PeaksTimelineMetrics | null}
 */
export function resolvePeaksTimelineMetrics(json, mediaDurationHintSec) {
  if (json == null) return null;
  const fmt = detectPeaksFormat(json);
  if (!fmt) return null;

  const hint =
    mediaDurationHintSec != null && Number.isFinite(mediaDurationHintSec) && mediaDurationHintSec > 0
      ? mediaDurationHintSec
      : null;

  if (fmt === "agent-columns") {
    const peaks = /** @type {number[]} */ (json.peaks);
    const pixelCount = peaks.length;
    if (pixelCount < 2) return null;

    /** pcm_columns 피크 축 = timeline_sec. Whisper duration hint 로 덮으면 선행 무음 분할이 밀려 음성·자막이 한 줄씩 어긋남 */
    const timelineSec = Number(json.timeline_sec ?? json.duration_sec);
    let dur = timelineSec > 0 ? timelineSec : hint ?? 0;
    if (!(dur > 0)) return null;

    let peakMax = 1e-18;
    for (let i = 0; i < peaks.length; i += 1) {
      const p = Number(peaks[i]) || 0;
      if (p > peakMax) peakMax = p;
    }

    /** agent 열 → 대칭 min/max envelope (waveformCanvasDrawing 과 동일 시각) */
    const data = new Array(pixelCount * 2);
    for (let i = 0; i < pixelCount; i += 1) {
      const norm = Math.min(1, Math.max(0, (Number(peaks[i]) || 0) / peakMax));
      const v = Math.round(norm * 127);
      data[i * 2] = -v;
      data[i * 2 + 1] = v;
    }

    const peaksDb = Array.isArray(json.peaks_db) && json.peaks_db.length === pixelCount ? json.peaks_db : null;

    return {
      data,
      columnPeaks: peaks,
      peaksDb: peaksDb ?? undefined,
      pixelCount,
      durationSec: dur,
      format: "agent-columns",
      peakMax,
    };
  }

  const data = getAudiowaveformDataArray(/** @type {import('./waveform-json.js').JsonWaveformData} */ (json));
  if (!data) return null;
  const pixelCount = Math.floor(data.length / 2);
  if (pixelCount <= 0) return null;

  const computed = exactTimelineDurationSecFromWaveformJson(
    /** @type {import('./waveform-json.js').JsonWaveformData} */ (json),
    hint ?? mediaDurationHintSec,
  );
  let dur =
    computed ??
    (hint != null ? hint : null) ??
    (mediaDurationHintSec != null && Number.isFinite(mediaDurationHintSec) && mediaDurationHintSec > 0
      ? mediaDurationHintSec
      : null);
  if (
    computed != null &&
    computed > 0 &&
    hint != null &&
    hint > 0 &&
    Math.abs(computed - hint) / computed > 0.004
  ) {
    dur = computed;
  }
  if (dur == null || !(dur > 0)) return null;

  return {
    data,
    pixelCount,
    durationSec: dur,
    format: "audiowaveform-minmax",
    peakMax: 127,
  };
}

/**
 * @param {PeaksTimelineMetrics} metrics
 * @param {number} startSec
 * @param {number} endSec
 */
export function mediaSecondsToPeakPixelRange(metrics, startSec, endSec) {
  const { pixelCount, durationSec } = metrics;
  const t0 = Math.max(0, Math.min(startSec, endSec));
  const t1 = Math.max(0, Math.max(startSec, endSec));
  const p0 = Math.floor((t0 / durationSec) * pixelCount);
  const p1 = Math.min(pixelCount, Math.ceil((t1 / durationSec) * pixelCount));
  const startPixel = Math.max(0, Math.min(p0, pixelCount - 1));
  const endPixel = Math.max(startPixel + 1, Math.min(p1, pixelCount));
  return { startPixel, endPixel };
}

/**
 * @param {PeaksTimelineMetrics} metrics
 * @param {number} timeSec
 */
export function mediaSecToPeakPixelIndex(metrics, timeSec) {
  const { pixelCount, durationSec } = metrics;
  const t = Math.max(0, Math.min(timeSec, durationSec));
  const p = Math.floor((t / durationSec) * pixelCount);
  return Math.max(0, Math.min(p, pixelCount - 1));
}

/**
 * @param {PeaksTimelineMetrics} metrics
 * @param {number} timeSec
 * @param {number} [meanVolumeDb]
 */
export function isMutedAtTime(metrics, timeSec, meanVolumeDb = -24) {
  if (!metrics.peaksDb?.length) return false;
  const pi = mediaSecToPeakPixelIndex(metrics, timeSec);
  const db = metrics.peaksDb[pi];
  if (!Number.isFinite(db)) return false;
  const thresh = Number.isFinite(meanVolumeDb) ? meanVolumeDb : -24;
  return db <= thresh;
}
