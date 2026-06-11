/**
 * ProgramClip 경계 SSOT — executor·highlight·경계 전환은 program 축만 사용.
 * 재생 경계(clipPos++)는 tail pad 제외 effectiveSourceEnd → programClipPlaybackEnd.
 */

import { PROGRAM_CLIP_EPS } from "./program-clips-ssot.js";
import {
  effectiveSourceEndForClip,
  passThroughEpsilonSec,
} from "./clip-boundary-ssot.js?v=5";

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
 * 재생·경계 전환용 program 시각 — effectiveSourceEnd 기준 (tail pad 미포함).
 *
 * @param {import("./program-clips-ssot.js").ProgramClip | import("./timeline-mapping.js").TimelineClip | null | undefined} clip
 */
export function programClipPlaybackEnd(clip) {
  if (!clip) return 0;
  const progStart = programClipStart(clip);
  const mediaStart =
    Number(clip.mediaStart ?? clip.mediaIn ?? clip.sourceStart) || 0;
  const effEnd = effectiveSourceEndForClip(clip);
  return progStart + Math.max(0, effEnd - mediaStart);
}

/**
 * @param {number} programSec
 * @param {import("./program-clips-ssot.js").ProgramClip | import("./timeline-mapping.js").TimelineClip} clip
 */
export function atProgramPlaybackBoundary(programSec, clip) {
  const t = Number(programSec) || 0;
  return t >= programClipPlaybackEnd(clip) - PROGRAM_BOUNDARY_EPS;
}

/**
 * 경계 seek 생략 — source ε-인접·자연 pause 구간(이미 재생 중)은 pass-through.
 *
 * @param {import("./timeline-mapping.js").TimelineClip} cur
 * @param {import("./timeline-mapping.js").TimelineClip} next
 * @param {number} mediaNow
 * @param {number} targetMediaSec
 * @param {import("./clip-boundary-ssot.js").GapTransitionClassification} cls
 */
export function shouldPassThroughClipTransition(
  cur,
  next,
  mediaNow,
  targetMediaSec,
  cls,
) {
  const now = Math.max(0, Number(mediaNow) || 0);
  const target = Math.max(0, Number(targetMediaSec) || 0);
  const gap = target - now;
  const eps = passThroughEpsilonSec();
  if (
    cls?.passThrough === false ||
    cls?.literalBlockJump ||
    cls?.kind === "edit"
  ) {
    return false;
  }
  if (cls?.hasCutData || cls?.hasSourceJump) return false;
  if (gap < -eps - 0.005) return false;
  if (Math.abs(gap) <= eps) return true;
  if (cls?.passThrough && gap >= -eps && now >= target - eps) return true;
  const effEnd = effectiveSourceEndForClip(cur);
  const interGap = Number(next?.mediaStart) - effEnd;
  if (interGap > eps && gap > eps && now >= target - eps) return true;
  return false;
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
