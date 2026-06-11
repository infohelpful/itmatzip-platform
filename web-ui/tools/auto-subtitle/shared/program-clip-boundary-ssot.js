/**
 * ProgramClip 경계 SSOT — executor·highlight·경계 전환은 program 축만 사용.
 * effectiveSourceEnd는 단어 lookup 보조용; clipPos++에는 사용하지 않음.
 */

import { PROGRAM_CLIP_EPS } from "./program-clips-ssot.js";

export const PROGRAM_BOUNDARY_EPS = 1e-3;

/**
 * @param {import("./program-clips-ssot.js").ProgramClip | import("./timeline-mapping.js").TimelineClip | null | undefined} clip
 */
export function programClipStart(clip) {
  if (!clip) return 0;
  const v = clip.programStart ?? clip.editStart;
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

/**
 * @param {import("./program-clips-ssot.js").ProgramClip | import("./timeline-mapping.js").TimelineClip | null | undefined} clip
 */
export function programClipEnd(clip) {
  if (!clip) return 0;
  const v = clip.programEnd ?? clip.editEnd;
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

/**
 * @param {import("./program-clips-ssot.js").ProgramClip | import("./timeline-mapping.js").TimelineClip | null | undefined} clip
 */
export function programClipDuration(clip) {
  return Math.max(0, programClipEnd(clip) - programClipStart(clip));
}

/**
 * @param {number} programSec
 * @param {import("./program-clips-ssot.js").ProgramClip | import("./timeline-mapping.js").TimelineClip} clip
 */
export function atProgramBoundary(programSec, clip) {
  const t = Number(programSec) || 0;
  return t >= programClipEnd(clip) - PROGRAM_BOUNDARY_EPS;
}

/**
 * @param {number} programSec
 * @param {readonly (import("./program-clips-ssot.js").ProgramClip | import("./timeline-mapping.js").TimelineClip)[]} clips
 */
export function clipPosForProgramSec(programSec, clips) {
  if (!clips?.length) return 0;
  const t = Math.max(0, Number(programSec) || 0);
  for (let i = 0; i < clips.length; i += 1) {
    const c = clips[i];
    if (
      t >= programClipStart(c) - PROGRAM_CLIP_EPS &&
      t < programClipEnd(c) - PROGRAM_CLIP_EPS
    ) {
      return i;
    }
  }
  if (t >= programClipEnd(clips[clips.length - 1]) - PROGRAM_CLIP_EPS) {
    return clips.length - 1;
  }
  return 0;
}

/**
 * Audio-Slave — clipPos가 확정된 상태에서만 사용 (역매핑 아님).
 *
 * @param {import("./timeline-mapping.js").TimelineClip} clip
 * @param {number} audioCurrentTime
 */
export function programSecFromAudioSlave(clip, audioCurrentTime) {
  const media = Math.max(0, Number(audioCurrentTime) || 0);
  const start = Number(clip.mediaStart ?? clip.mediaIn) || 0;
  return programClipStart(clip) + (media - start);
}
