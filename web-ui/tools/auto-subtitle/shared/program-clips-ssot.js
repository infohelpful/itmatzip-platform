/**
 * V5 SSOT — programClips (Vrew-style single timeline).
 */

import { rebuildVirtualIndexFromBlocks } from "./block-timeline-adapter.js?v=1";
import { blocksToExportSegments } from "./blocks-to-export.js?v=5";

export const PROGRAM_CLIP_EPS = 1e-5;
export const EXPORT_SCHEMA_VERSION = 5;

/**
 * @typedef {{
 *   id: string,
 *   blockIndex: number,
 *   sourceStart: number,
 *   sourceEnd: number,
 *   programStart: number,
 *   programEnd: number,
 *   isSilence: boolean,
 * }} ProgramClip
 */

/**
 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks
 * @param {readonly { start: number, end: number }[]} cutRanges
 * @returns {ProgramClip[]}
 */
export function buildProgramClips(blocks, cutRanges = []) {
  const virtualIndex = rebuildVirtualIndexFromBlocks(blocks || []);
  const segments = blocksToExportSegments(blocks, virtualIndex, { cutRanges });
  return segments.map((seg) => ({
    id: String((blocks[seg.blockIndex] && blocks[seg.blockIndex].id) || seg.blockIndex),
    blockIndex: seg.blockIndex,
    sourceStart: seg.sourceStart,
    sourceEnd: seg.sourceEnd,
    effectiveSourceEnd: seg.effectiveSourceEnd ?? seg.sourceEnd,
    programStart: seg.editStart,
    programEnd: seg.editEnd,
    isSilence: !!seg.isSilence,
  }));
}

/**
 * @param {readonly ProgramClip[]} clips
 */
export function getProgramDurationSec(clips) {
  if (!clips?.length) return 0;
  const last = clips[clips.length - 1];
  return Math.max(0, Number(last.programEnd) || 0);
}

/**
 * @param {readonly ProgramClip[]} clips
 * @param {number} programDurationSec
 */
export function assertProgramClipsDuration(clips, programDurationSec) {
  const lastEnd = getProgramDurationSec(clips);
  const expected = Number(programDurationSec) || 0;
  if (clips.length && Math.abs(lastEnd - expected) > PROGRAM_CLIP_EPS && expected > 0) {
    console.warn(
      "[programClips] duration mismatch",
      { lastEnd, expected, delta: lastEnd - expected },
    );
  }
  return lastEnd;
}

/**
 * @param {readonly ProgramClip[]} clips
 * @param {number} sourceSec
 */
export function sourceToProgram(clips, sourceSec) {
  const t = Math.max(0, Number(sourceSec) || 0);
  if (!clips?.length) return t;
  for (const c of clips) {
    if (t >= c.sourceStart - PROGRAM_CLIP_EPS && t < c.sourceEnd - PROGRAM_CLIP_EPS) {
      return c.programStart + (t - c.sourceStart);
    }
  }
  const last = clips[clips.length - 1];
  if (t >= last.sourceEnd - PROGRAM_CLIP_EPS) return last.programEnd;
  return 0;
}

/**
 * @param {readonly ProgramClip[]} clips
 * @param {number} programSec
 */
export function programToSource(clips, programSec) {
  const t = Math.max(0, Number(programSec) || 0);
  if (!clips?.length) return t;
  for (const c of clips) {
    if (t >= c.programStart - PROGRAM_CLIP_EPS && t < c.programEnd - PROGRAM_CLIP_EPS) {
      return c.sourceStart + (t - c.programStart);
    }
  }
  const last = clips[clips.length - 1];
  if (t >= last.programEnd - PROGRAM_CLIP_EPS) return last.sourceEnd;
  return 0;
}

/**
 * @param {readonly ProgramClip[]} clips
 */
export function programClipsToApiPayload(clips) {
  return (clips || []).map((c) => ({
    id: c.id,
    blockIndex: c.blockIndex,
    sourceStart: c.sourceStart,
    sourceEnd: c.sourceEnd,
    programStart: c.programStart,
    programEnd: c.programEnd,
    isSilence: !!c.isSilence,
    source_start: c.sourceStart,
    source_end: c.sourceEnd,
    program_start: c.programStart,
    program_end: c.programEnd,
    is_silence: !!c.isSilence,
  }));
}

/**
 * @param {string} previewMediaPath
 * @param {readonly ProgramClip[]} clips
 * @param {string} [cutRangesJson]
 */
/**
 * Program clips가 커버하지 않는 source 구간 → mp3/wav export cut_ranges.
 *
 * @param {readonly ProgramClip[]} programClips
 * @param {number} [mediaDurationSec]
 */
export function deriveCutRangesFromProgramClips(programClips, mediaDurationSec = 0) {
  const clips = programClips || [];
  let dur = Math.max(0, Number(mediaDurationSec) || 0);
  for (const c of clips) {
    if (!c.isSilence) dur = Math.max(dur, Number(c.sourceEnd) || 0);
  }
  if (!clips.length) return dur > PROGRAM_CLIP_EPS ? [{ start: 0, end: dur }] : [];

  /** @type {{ start: number, end: number }[]} */
  const kept = clips
    .filter((c) => !c.isSilence && c.sourceEnd > c.sourceStart + PROGRAM_CLIP_EPS)
    .map((c) => ({ start: c.sourceStart, end: c.sourceEnd }))
    .sort((a, b) => a.start - b.start);

  if (!kept.length) return dur > PROGRAM_CLIP_EPS ? [{ start: 0, end: dur }] : [];

  /** @type {{ start: number, end: number }[]} */
  const merged = [];
  for (const iv of kept) {
    const last = merged[merged.length - 1];
    if (!last || iv.start > last.end + PROGRAM_CLIP_EPS) {
      merged.push({ start: iv.start, end: iv.end });
    } else {
      last.end = Math.max(last.end, iv.end);
    }
  }

  /** @type {{ start: number, end: number }[]} */
  const cuts = [];
  let cursor = 0;
  for (const keep of merged) {
    if (keep.start > cursor + PROGRAM_CLIP_EPS) {
      cuts.push({ start: cursor, end: keep.start });
    }
    cursor = Math.max(cursor, keep.end);
  }
  if (dur > cursor + PROGRAM_CLIP_EPS) {
    cuts.push({ start: cursor, end: dur });
  }
  return cuts.filter((c) => c.end > c.start + PROGRAM_CLIP_EPS);
}

export function programClipsFingerprint(previewMediaPath, clips, cutRangesJson = "[]") {
  const payload = JSON.stringify({
    preview: String(previewMediaPath || ""),
    clips: (clips || []).map((c) => [
      c.id,
      c.blockIndex,
      c.sourceStart,
      c.sourceEnd,
      c.programStart,
      c.programEnd,
      c.isSilence,
    ]),
    cuts: cutRangesJson,
    v: EXPORT_SCHEMA_VERSION,
  });
  let h = 0;
  for (let i = 0; i < payload.length; i += 1) {
    h = (Math.imul(31, h) + payload.charCodeAt(i)) | 0;
  }
  return `pc${(h >>> 0).toString(16)}`;
}
