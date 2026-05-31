/**
 * AutoSubtitle playbackIntervals.ts ???¬ìƒ êµ¬ê°„(?? œÂ·ë¬´ìŒ ?œì™¸).
 */

import { wordIsDeleted, wordIsSilence } from "./subtitles.js?v=20";

/**
 * @param {import("./subtitles.js").SubtitleWord} w
 * @param {{ includeSilenceSegments?: boolean }} opts
 */
function isPlaybackEligibleWord(w, opts) {
  if (wordIsDeleted(w)) return false;
  if (!opts.includeSilenceSegments && wordIsSilence(w)) return false;
  if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) return false;
  return w.end > w.start;
}

/**
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 * @param {{ mergeGapSec?: number, includeSilenceSegments?: boolean }} [options]
 */
export function playbackIntervalsFromSubtitleLines(lines, options = {}) {
  const mergeGap = Math.max(0, options.mergeGapSec ?? 0);
  const opts = {
    mergeGapSec: mergeGap,
    includeSilenceSegments: options.includeSilenceSegments === true,
  };

  const raw = [];
  for (const line of lines || []) {
    const words = line.words;
    if (!words?.length) continue;
    for (const w of words) {
      if (!isPlaybackEligibleWord(w, opts)) continue;
      raw.push({ start: w.start, end: w.end });
    }
  }

  if (raw.length === 0) return [];

  raw.sort((a, b) => a.start - b.start);

  const merged = [];
  let cur = { ...raw[0] };
  for (let i = 1; i < raw.length; i += 1) {
    const next = raw[i];
    if (next.start <= cur.end + mergeGap) {
      cur.end = Math.max(cur.end, next.end);
    } else {
      merged.push(cur);
      cur = { ...next };
    }
  }
  merged.push(cur);
  return merged;
}

export function hasPlayableSubtitleWordIntervals(lines) {
  return playbackIntervalsFromSubtitleLines(lines).length > 0;
}

/**
 * @param {readonly { start: number, end: number }[]} intervals
 * @param {number} rangeStart
 * @param {number | null} rangeEnd
 */
export function intersectMediaIntervalsWithRange(intervals, rangeStart, rangeEnd) {
  const lim = rangeEnd == null ? Number.POSITIVE_INFINITY : rangeEnd;
  const EPS = 1e-6;
  const out = [];
  for (const iv of intervals) {
    if (iv.end <= rangeStart + EPS) continue;
    if (iv.start >= lim - EPS) continue;
    const s = Math.max(iv.start, rangeStart);
    const e = Math.min(iv.end, lim);
    if (e > s + EPS) out.push({ start: s, end: e });
  }
  return out;
}
