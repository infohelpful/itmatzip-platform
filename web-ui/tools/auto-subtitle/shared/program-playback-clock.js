/**
 * Phase 1-R — programSec ↔ mediaSec ↔ sourceSec 단일 시계 API.
 */

import {
  mapMediaToProgramSec,
  mapMediaToProgramSecWithClipHint,
  mapProgramToMediaSec,
} from "./timeline-mapping.js?v=2";
import { programToSource } from "./program-clips-ssot.js?v=2";

/**
 * @param {number} mediaSec
 * @param {readonly import("./timeline-mapping.js").TimelineClip[]} timelineClips
 * @param {number} [clipPosHint]
 */
export function resolveProgramSecFromMedia(mediaSec, timelineClips, clipPosHint = -1) {
  const t = Math.max(0, Number(mediaSec) || 0);
  if (!timelineClips?.length) return t;
  if (clipPosHint >= 0) {
    return mapMediaToProgramSecWithClipHint(t, timelineClips, clipPosHint);
  }
  return mapMediaToProgramSec(t, timelineClips);
}

/**
 * @param {number} programSec
 * @param {readonly import("./timeline-mapping.js").TimelineClip[]} timelineClips
 */
export function resolveMediaSecFromProgram(programSec, timelineClips) {
  const t = Math.max(0, Number(programSec) || 0);
  if (!timelineClips?.length) return t;
  return mapProgramToMediaSec(t, timelineClips);
}

/**
 * @param {number} programSec
 * @param {readonly import("./program-clips-ssot.js").ProgramClip[]} programClips
 */
export function resolveSourceSecFromProgram(programSec, programClips) {
  return programToSource(programClips || [], programSec);
}

/**
 * @param {HTMLMediaElement | null | undefined} audio
 * @param {readonly import("./timeline-mapping.js").TimelineClip[]} timelineClips
 */
export function resolveProgramSecFromAudio(audio, timelineClips) {
  if (!audio || !Number.isFinite(audio.currentTime)) return 0;
  return resolveProgramSecFromMedia(audio.currentTime, timelineClips);
}

/**
 * @param {number} programSec
 * @param {number} programDurationSec
 */
export function clampProgramSec(programSec, programDurationSec) {
  const t = Math.max(0, Number(programSec) || 0);
  const dur = Math.max(0, Number(programDurationSec) || 0);
  if (dur <= 0) return t;
  return Math.min(t, dur);
}

/**
 * programSec → 유효 clipPos + mediaSec (삭제·재빌드 후 playhead 보정).
 *
 * @param {number} programSec
 * @param {readonly import("./timeline-mapping.js").TimelineClip[]} timelineClips
 * @param {number} [clipPosHint]
 * @returns {{ programSec: number, mediaSec: number, clipPos: number }}
 */
export function resolveSegmentPlaybackAnchor(programSec, timelineClips, clipPosHint = -1) {
  if (!timelineClips?.length) {
    const t = Math.max(0, Number(programSec) || 0);
    return { programSec: t, mediaSec: 0, clipPos: 0 };
  }
  const dur = timelineClips[timelineClips.length - 1].editEnd;
  let program = clampProgramSec(programSec, dur);
  let media = resolveMediaSecFromProgram(program, timelineClips);

  const inClip = (c, m) => m >= c.mediaStart - 0.015 && m < c.mediaEnd - 0.015;
  let clipPos = -1;
  if (clipPosHint >= 0 && clipPosHint < timelineClips.length) {
    const hinted = timelineClips[clipPosHint];
    if (hinted && inClip(hinted, media)) clipPos = clipPosHint;
  }
  if (clipPos < 0) {
    clipPos = timelineClips.findIndex((c) => inClip(c, media));
  }
  if (clipPos < 0) {
    clipPos = timelineClips.findIndex((c) => c.mediaStart >= media - 0.015);
    if (clipPos < 0) clipPos = timelineClips.length - 1;
    const clip = timelineClips[clipPos];
    media = clip.mediaStart;
    program = clip.editStart;
  } else {
    const clip = timelineClips[clipPos];
    if (media >= clip.mediaEnd - 0.02) {
      media = Math.max(clip.mediaStart, clip.mediaEnd - 0.04);
      program = resolveProgramSecFromMedia(media, timelineClips, clipPos);
    }
  }

  return { programSec: program, mediaSec: media, clipPos };
}
