/**
 * AutoSubtitle playbackSchedule.ts
 */

import {
  intersectMediaIntervalsWithRange,
  playbackIntervalsFromSubtitleLines,
} from "../shared/playback-intervals.js";
import { buildTimelineClips } from "../shared/timeline-mapping.js";

/**
 * @typedef {{ clipId: number, startMediaSec: number, endMediaSec: number }} ScheduledMediaSegment
 */

/**
 * @param {readonly import("../shared/timeline-mapping.js").TimelineClip[]} clips
 * @param {number} startMediaSec
 * @param {number | null} endMediaSec
 * @returns {ScheduledMediaSegment[]}
 */
export function buildScheduledMediaSegments(clips, startMediaSec, endMediaSec) {
  if (!clips?.length) return [];
  const start = Math.max(0, startMediaSec);
  const end = endMediaSec == null ? Number.POSITIVE_INFINITY : Math.max(start, endMediaSec);
  /** @type {ScheduledMediaSegment[]} */
  const out = [];
  for (const clip of clips) {
    const segStart = Math.max(start, clip.mediaStart);
    const segEnd = Math.min(end, clip.mediaEnd);
    if (segEnd <= segStart + 1e-4) continue;
    out.push({
      clipId: clip.id,
      startMediaSec: segStart,
      endMediaSec: segEnd,
    });
  }
  return out;
}

/**
 * EDL 클립 빌드 헬퍼.
 * @param {readonly { start: number, end: number }[]} cuts
 * @param {number} mediaEndHintSec
 */
export function timelineClipsFromCuts(cuts, mediaEndHintSec) {
  return buildTimelineClips(cuts, mediaEndHintSec);
}

/**
 * @param {readonly import("../shared/subtitles.js").SubtitleLine[]} lines
 * @param {number} startMediaSec
 * @param {number | null} endMediaSec
 */
export function buildScheduledMediaSegmentsFromSubtitleWords(lines, startMediaSec, endMediaSec) {
  const intervals = playbackIntervalsFromSubtitleLines(lines);
  if (!intervals.length) return [];
  const start = Math.max(0, startMediaSec);
  const clipped = intersectMediaIntervalsWithRange(intervals, start, endMediaSec);
  const out = [];
  for (let i = 0; i < clipped.length; i += 1) {
    const iv = clipped[i];
    out.push({
      clipId: i + 1,
      startMediaSec: iv.start,
      endMediaSec: iv.end,
    });
  }
  return out;
}

/**
 * 컷 구간을 건너뛰며 원본 미디어를 순서대로 재생할 EDL 조각.
 *
 * @param {number} totalDurSec
 * @param {readonly { start: number, end: number }[]} cuts
 */
export function buildPassthroughSegmentsSkippingCuts(totalDurSec, cuts) {
  const EPS = 1e-4;
  const dur = Math.max(0, Number(totalDurSec) || 0);
  if (!(dur > EPS)) return [];

  const merged = [...(cuts || [])]
    .map((r) => ({ start: Math.max(0, r.start), end: Math.max(0, r.end) }))
    .filter((r) => r.end > r.start + EPS)
    .sort((a, b) => a.start - b.start);

  const out = [];
  let cursor = 0;
  for (const c of merged) {
    if (c.start > cursor + EPS) {
      out.push({
        clipId: out.length + 1,
        startMediaSec: cursor,
        endMediaSec: Math.min(c.start, dur),
      });
    }
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < dur - EPS) {
    out.push({
      clipId: out.length + 1,
      startMediaSec: cursor,
      endMediaSec: dur,
    });
  }
  return out.filter((s) => s.endMediaSec > s.startMediaSec + EPS);
}
