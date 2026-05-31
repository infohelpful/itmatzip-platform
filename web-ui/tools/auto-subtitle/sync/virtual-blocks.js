/**
 * SubtitleLine·TimelineClip ??SyncEngine VirtualBlockMs
 */

import { wordIsDeleted, wordIsSilence } from "../shared/subtitles.js?v=20";
import { playbackIntervalsFromSubtitleLines } from "../shared/playback-intervals.js";

/**
 * @param {readonly import("../shared/subtitles.js").SubtitleLine[]} lines
 * @param {readonly { start: number, end: number }[]} _cutRanges
 */
export function virtualBlocksFromSubtitleWords(lines, _cutRanges) {
  void _cutRanges;
  /** @type {import("./word-jump-cut.js").WordTimelineBlockMs[]} */
  const blocks = [];
  for (const line of lines || []) {
    for (const w of line.words || []) {
      if (wordIsSilence(w)) continue;
      const oStartMs = Math.round(Math.min(w.start, w.end) * 1000);
      const oEndMs = Math.round(Math.max(w.start, w.end) * 1000);
      if (oEndMs <= oStartMs) continue;
      blocks.push({
        vStartMs: oStartMs,
        vEndMs: oEndMs,
        oStartMs,
        oEndMs,
        isDeleted: wordIsDeleted(w),
      });
    }
  }
  return blocks.sort((a, b) => a.vStartMs - b.vStartMs || a.oStartMs - b.oStartMs);
}

/**
 * @param {readonly { start: number, end: number }[]} intervals media axis
 */
export function virtualBlocksFromPlaybackIntervals(intervals) {
  /** @type {import("./block-mapping.js").VirtualBlockMs[]} */
  const blocks = [];
  let vCursor = 0;
  for (const iv of intervals || []) {
    const durMs = Math.max(1, Math.round((iv.end - iv.start) * 1000));
    blocks.push({
      vStartMs: vCursor,
      vEndMs: vCursor + durMs,
      oStartMs: Math.round(iv.start * 1000),
      oEndMs: Math.round(iv.end * 1000),
    });
    vCursor += durMs;
  }
  return blocks;
}

/**
 * @param {readonly import("../shared/timeline-mapping.js").TimelineClip[]} clips
 */
export function virtualBlocksFromTimelineClips(clips) {
  return (clips || []).map((c) => ({
    vStartMs: Math.round(c.editStart * 1000),
    vEndMs: Math.round(c.editEnd * 1000),
    oStartMs: Math.round(c.mediaStart * 1000),
    oEndMs: Math.round(c.mediaEnd * 1000),
  }));
}

/**
 * @param {readonly import("../shared/subtitles.js").SubtitleLine[]} lines
 * @param {readonly { start: number, end: number }[]} cutRanges
 */
export function virtualBlocksForSyncEngine(lines, cutRanges) {
  const wordBlocks = virtualBlocksFromSubtitleWords(lines, cutRanges);
  if (wordBlocks.some((b) => !b.isDeleted)) return wordBlocks;
  const intervals = playbackIntervalsFromSubtitleLines(lines);
  return virtualBlocksFromPlaybackIntervals(intervals);
}
