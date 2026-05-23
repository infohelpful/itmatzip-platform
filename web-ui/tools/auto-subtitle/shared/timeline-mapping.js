/**
 * AutoSubtitle timeline/mapping.ts — 프로그램↔미디어↔마스터 오디오 매핑.
 */

import { mergeCutRanges } from "./timeline-collapse.js";

export const SKIP_CUT_TAIL_SEC = 2e-4;

/**
 * @param {readonly { start: number, end: number }[]} ranges
 * @param {number} mediaEndHintSec
 */
export function buildTimelineClips(ranges, mediaEndHintSec) {
  const merged = mergeCutRanges([...ranges]);
  /** @type {TimelineClip[]} */
  const clips = [];
  let timelineCursor = 0;
  let mediaCursor = 0;
  let nextId = 1;
  for (const r of merged) {
    if (r.start > mediaCursor) {
      const dur = r.start - mediaCursor;
      const editStart = timelineCursor;
      const editEnd = timelineCursor + dur;
      const mediaStart = mediaCursor;
      const mediaEnd = r.start;
      clips.push({
        id: nextId,
        editStart,
        editEnd,
        mediaIn: mediaStart,
        mediaOut: mediaEnd,
        timelineStart: editStart,
        timelineEnd: editEnd,
        mediaStart,
        mediaEnd,
      });
      nextId += 1;
      timelineCursor += dur;
    }
    mediaCursor = Math.max(mediaCursor, r.end);
  }
  const tailEnd = Math.max(mediaCursor, mediaEndHintSec);
  if (tailEnd > mediaCursor) {
    const dur = tailEnd - mediaCursor;
    clips.push({
      id: nextId,
      editStart: timelineCursor,
      editEnd: timelineCursor + dur,
      mediaIn: mediaCursor,
      mediaOut: tailEnd,
      timelineStart: timelineCursor,
      timelineEnd: timelineCursor + dur,
      mediaStart: mediaCursor,
      mediaEnd: tailEnd,
    });
  }
  return clips;
}

function findClipByProgramSec(programSec, clips) {
  if (!clips.length) return null;
  let lo = 0;
  let hi = clips.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = clips[mid];
    if (programSec < c.editStart) hi = mid - 1;
    else if (programSec >= c.editEnd) lo = mid + 1;
    else return c;
  }
  return null;
}

function findClipByMediaSec(mediaSec, clips) {
  if (!clips.length) return null;
  let lo = 0;
  let hi = clips.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = clips[mid];
    if (mediaSec < c.mediaStart) hi = mid - 1;
    else if (mediaSec >= c.mediaEnd) lo = mid + 1;
    else return c;
  }
  return null;
}

/**
 * @param {number} timeSec
 * @param {readonly { start: number, end: number }[]} ranges
 */
export function skipCutRangeAt(timeSec, ranges) {
  const merged = mergeCutRanges([...ranges]);
  let t = timeSec;
  for (let step = 0; step < 64; step += 1) {
    let jumped = false;
    for (const r of merged) {
      if (t >= r.start && t < r.end) {
        t = r.end + SKIP_CUT_TAIL_SEC;
        jumped = true;
        break;
      }
    }
    if (!jumped) break;
  }
  return t;
}

/**
 * @param {number} programSec
 * @param {readonly TimelineClip[]} clips
 */
export function mapProgramToMediaSec(programSec, clips) {
  const t = Math.max(0, programSec);
  if (!clips.length) return t;
  const c = findClipByProgramSec(t, clips);
  if (c) return c.mediaStart + (t - c.editStart);
  return clips[clips.length - 1].mediaOut;
}

/**
 * @param {number} mediaSec
 * @param {readonly TimelineClip[]} clips
 */
export function mapMediaToProgramSec(mediaSec, clips) {
  const t = Math.max(0, mediaSec);
  if (!clips.length) return t;
  const c = findClipByMediaSec(t, clips);
  if (c) return c.editStart + (t - c.mediaStart);

  const first = clips[0];
  const last = clips[clips.length - 1];
  if (t < first.mediaStart) {
    return Math.max(0, first.editStart + (t - first.mediaStart));
  }
  if (t >= last.mediaEnd) return last.timelineEnd;

  for (let i = 0; i < clips.length - 1; i += 1) {
    const a = clips[i];
    const b = clips[i + 1];
    if (t >= a.mediaEnd && t < b.mediaStart) return b.editStart;
  }
  return last.timelineEnd;
}

/**
 * @param {readonly { start: number, end: number }[]} cuts
 * @param {number} mediaEndHintSec
 * @param {{ masterMode?: 'stitched' | 'passthrough' }} [options]
 */
export function createTimelineMapping(cuts, mediaEndHintSec, options = {}) {
  const mergedCuts = mergeCutRanges([...cuts]);
  const clips = buildTimelineClips(mergedCuts, mediaEndHintSec);
  const programToMediaSec = (p) => mapProgramToMediaSec(p, clips);
  const mediaToProgramSec = (m) => mapMediaToProgramSec(m, clips);
  const inferredMode =
    options.masterMode ?? (mergedCuts.length > 0 ? "stitched" : "passthrough");

  const programToMasterAudioSec =
    inferredMode === "stitched" ? (p) => Math.max(0, p) : (p) => programToMediaSec(p);
  const masterAudioToProgramSec =
    inferredMode === "stitched" ? (a) => Math.max(0, a) : (a) => mediaToProgramSec(a);

  return {
    clips,
    mergedCuts,
    mediaEndHintSec,
    programToMediaSec,
    mediaToProgramSec,
    programToMasterAudioSec,
    masterAudioToProgramSec,
    masterMode: inferredMode,
  };
}

/**
 * @param {readonly TimelineClip[]} clips
 */
export function programDurationSec(clips) {
  if (!clips.length) return 0;
  return clips[clips.length - 1].timelineEnd;
}

/**
 * @param {number} currentMediaSec
 * @param {readonly TimelineClip[]} clips
 * @param {number} [tailSec]
 */
export function jumpVideoPastClipTailIfNeeded(currentMediaSec, clips, tailSec = 0.02) {
  if (!clips.length) return { jumped: false };
  const cur = findClipByMediaSec(currentMediaSec, clips);
  if (!cur) return { jumped: false };
  if (cur.mediaEnd - currentMediaSec > tailSec) return { jumped: false };
  const next = clips.find((c) => c.id === cur.id + 1);
  if (!next) return { jumped: false };
  return {
    jumped: true,
    fromMediaSec: currentMediaSec,
    toMediaSec: next.mediaStart,
    fromClipId: cur.id,
    toClipId: next.id,
  };
}

/** @typedef {{ id: number, editStart: number, editEnd: number, mediaIn: number, mediaOut: number, timelineStart: number, timelineEnd: number, mediaStart: number, mediaEnd: number }} TimelineClip */
