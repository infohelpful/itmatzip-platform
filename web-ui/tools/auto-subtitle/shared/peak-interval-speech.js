/**
 * PCM 피크 구간에 음성 에너지가 있는지 판별 (무음 칩 오판 보정용).
 */

import { mediaSecondsToPeakPixelRange } from "../peaks-metrics.js";

const EPS = 1e-5;
const DEFAULT_SPEECH_DBFS_GATE = -40;

/**
 * @param {readonly number[]} data
 * @param {number} col
 */
function peakDbfsAtColumn(data, col) {
  const i = col * 2;
  const mn = (data[i] ?? 0) / 127;
  const mx = (data[i + 1] ?? 0) / 127;
  const amp = Math.max(Math.abs(mn), Math.abs(mx));
  if (amp < 1e-8) return -100;
  const db = 20 * Math.log10(amp);
  if (!Number.isFinite(db)) return -100;
  return Math.max(-120, Math.min(0, db));
}

/**
 * @param {import("../peaks-metrics.js").PeaksTimelineMetrics} metrics
 * @param {number} t0
 * @param {number} t1
 */
export function maxDbfsInPeakInterval(metrics, t0, t1) {
  if (!metrics?.data?.length || metrics.pixelCount < 2) return -150;
  const { data, pixelCount, durationSec } = metrics;
  const { startPixel, endPixel } = mediaSecondsToPeakPixelRange(
    { data, pixelCount, durationSec },
    t0,
    t1,
  );
  let m = -150;
  for (let p = startPixel; p < endPixel; p += 1) {
    m = Math.max(m, peakDbfsAtColumn(data, p));
  }
  return m;
}

/**
 * @param {import("../peaks-metrics.js").PeaksTimelineMetrics | null | undefined} metrics
 * @param {number} t0
 * @param {number} t1
 * @param {number} [dbfsGate]
 */
export function intervalHasAudibleSpeechInPeaks(metrics, t0, t1, dbfsGate = DEFAULT_SPEECH_DBFS_GATE) {
  if (!metrics?.data?.length) return false;
  const a = Math.min(t0, t1);
  const b = Math.max(t0, t1);
  if (!(b > a + EPS)) return false;
  return maxDbfsInPeakInterval(metrics, a, b) > dbfsGate + EPS;
}
