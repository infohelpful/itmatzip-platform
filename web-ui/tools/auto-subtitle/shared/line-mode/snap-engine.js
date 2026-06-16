/**
 * Line Mode v4 — SnapGrid build + findNearestSnap (lower_bound).
 */

import { LINE_MODE_SNAP_RADIUS_SEC } from "./config.js";

const ONSET_DB_ABOVE_FLOOR = 6;
const SILENCE_DB_ABOVE_FLOOR = 3;
const SILENCE_MIN_SEC = 0.15;
const SILENCE_PAD_SEC = 0.3;
const VALLEY_MIN_GAP_SEC = 0.04;

/**
 * @param {readonly number[]} peaksDb
 */
function medianDb(peaksDb, meanVolumeDb) {
  if (peaksDb?.length) {
    const sorted = [...peaksDb].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  if (Number.isFinite(meanVolumeDb)) return Number(meanVolumeDb);
  return -60;
}

/**
 * @param {readonly number[]} peaksDb
 * @param {number} durationSec
 * @param {number | null | undefined} meanVolumeDb
 */
export function buildSnapGridFromPeaks(peaksDb, durationSec, meanVolumeDb) {
  const empty = /** @type {{ t: number, kind: string }[]} */ ([]);
  if (!peaksDb?.length || !(durationSec > 0)) {
    return {
      onsets: empty,
      silences: empty,
      silencePads: empty,
      dragStartSnaps: empty,
      noiseFloorDb: -60,
      hopSec: 0.01,
    };
  }

  const n = peaksDb.length;
  const dt = durationSec / n;
  const floor = medianDb(peaksDb, meanVolumeDb);
  const onsetThresh = floor + ONSET_DB_ABOVE_FLOOR;
  const silenceThresh = floor + SILENCE_DB_ABOVE_FLOOR;
  const minSilentCols = Math.max(1, Math.round(SILENCE_MIN_SEC / dt));

  /** @type {{ t: number, kind: string }[]} */
  const onsets = [];
  for (let i = 1; i < n; i += 1) {
    if (peaksDb[i - 1] < onsetThresh && peaksDb[i] >= onsetThresh) {
      onsets.push({ t: i * dt, kind: "onset" });
    }
  }

  /** @type {{ t: number, kind: string }[]} */
  const silences = [];
  let runStart = null;
  for (let i = 0; i < n; i += 1) {
    if (peaksDb[i] <= silenceThresh) {
      if (runStart == null) runStart = i;
    } else if (runStart != null) {
      const runLen = i - runStart;
      if (runLen >= minSilentCols) silences.push({ t: runStart * dt, kind: "silence" });
      runStart = null;
    }
  }
  if (runStart != null) {
    const runLen = n - runStart;
    if (runLen >= minSilentCols) silences.push({ t: runStart * dt, kind: "silence" });
  }

  /** @type {{ t: number, kind: string }[]} */
  const valleys = [];
  const minValleyGapCols = Math.max(1, Math.round(VALLEY_MIN_GAP_SEC / dt));
  let lastValleyCol = -minValleyGapCols;
  for (let i = 1; i < n - 1; i += 1) {
    const left = peaksDb[i - 1];
    const cur = peaksDb[i];
    const right = peaksDb[i + 1];
    const isLocalMin = cur <= left && cur <= right;
    if (!isLocalMin) continue;
    if (cur > silenceThresh) continue;
    if (i - lastValleyCol < minValleyGapCols) continue;
    valleys.push({ t: i * dt, kind: "valley" });
    lastValleyCol = i;
  }

  const silencePads = silences.map((s) => ({ t: s.t + SILENCE_PAD_SEC, kind: "silence_pad" }));
  onsets.sort((a, b) => a.t - b.t);
  silences.sort((a, b) => a.t - b.t);
  valleys.sort((a, b) => a.t - b.t);
  silencePads.sort((a, b) => a.t - b.t);

  return {
    onsets,
    silences,
    valleys,
    silencePads,
    dragStartSnaps: [...onsets],
    noiseFloorDb: floor,
    hopSec: dt,
  };
}

/**
 * @param {import("../peaks-metrics.js").PeaksTimelineMetrics | null | undefined} metrics
 */
export function buildSnapGridFromPeaksMetrics(metrics) {
  if (!metrics?.peaksDb?.length || !(metrics.durationSec > 0)) {
    return buildSnapGridFromPeaks([], 0, null);
  }
  return buildSnapGridFromPeaks(metrics.peaksDb, metrics.durationSec, null);
}

/**
 * @param {readonly { t: number }[]} grid
 */
function lowerBound(grid, target) {
  let lo = 0;
  let hi = grid.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (grid[mid].t < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * @param {number} target
 * @param {readonly { t: number }[]} grid
 * @param {number} [radius]
 * @param {boolean} [alt]
 */
export function findNearestSnap(target, grid, radius = LINE_MODE_SNAP_RADIUS_SEC, alt = false) {
  if (alt) return target;
  if (!grid?.length) return target;
  const i = lowerBound(grid, target);
  let best = target;
  let bestDist = radius + 1;
  const candidates = [i, i - 1].filter((idx) => idx >= 0 && idx < grid.length);
  for (const idx of candidates) {
    const d = Math.abs(grid[idx].t - target);
    if (d <= radius && d < bestDist) {
      bestDist = d;
      best = grid[idx].t;
    }
  }
  return bestDist <= radius ? best : target;
}

/**
 * @param {object | null | undefined} payload
 */
export function buildSnapGridFromPeaksPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return buildSnapGridFromPeaks([], 0, null);
  }
  const peaksDb = Array.isArray(payload.peaks_db) ? payload.peaks_db.map(Number) : [];
  const dur = Number(payload.timeline_sec ?? payload.duration_sec) || 0;
  const meanDb = payload.mean_volume_db != null ? Number(payload.mean_volume_db) : null;
  return buildSnapGridFromPeaks(peaksDb, dur, meanDb);
}
