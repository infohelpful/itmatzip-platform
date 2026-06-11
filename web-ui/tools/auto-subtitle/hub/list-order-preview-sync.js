/**
 * ProgramClip-driven list-order preview — ProgramPreviewExecutor SSOT.
 */

import {
  getPreviewMediaBridge,
  isListOrderTransitionLocked,
} from "./seamless-preview-stack.js?v=29";
import { skipCutRangeAt } from "../playback.js?v=28";
import { isProgramPlaybackTimeline } from "../shared/media-timing-ssot.js?v=7";
import { programSecFromAudioSlave } from "../shared/program-clip-boundary-ssot.js";
import {
  disarmProgramPreviewExecutor,
  getProgramPreviewExecutor,
  isProgramPreviewExecutorActive,
} from "./program-preview-executor.js?v=2";

/** @type {import("../shared/timeline-mapping.js").TimelineClip[]} */
let activeClips = [];
/** @type {import("../shared/program-clips-ssot.js").ProgramClip[]} */
let activeProgramClips = [];
let activeClipPos = 0;

/**
 * @param {{ clips: import("../shared/timeline-mapping.js").TimelineClip[], mapping?: unknown, programClips?: import("../shared/program-clips-ssot.js").ProgramClip[] }} bundle
 * @param {number} [clipPos]
 */
export function setListOrderPreviewTimeline(bundle, clipPos) {
  activeClips = bundle.clips || [];
  activeProgramClips = bundle.programClips || [];
  if (typeof clipPos === "number" && clipPos >= 0 && activeClips.length) {
    activeClipPos = Math.max(0, Math.min(clipPos, activeClips.length - 1));
  } else if (activeClipPos >= activeClips.length) {
    activeClipPos = Math.max(0, activeClips.length - 1);
  }
  const ex = getProgramPreviewExecutor();
  if (ex.isArmed()) {
    ex.arm({
      clips: activeClips,
      programClips: activeProgramClips,
      clipPos: activeClipPos,
      programSec: ex.getProgramSec(),
      mode: ex.getMode(),
      skipRanges: ex.skipRanges,
    });
  }
}

export function clearListOrderPreviewTimeline() {
  activeClips = [];
  activeProgramClips = [];
  activeClipPos = 0;
  disarmProgramPreviewExecutor();
  const bridge = getPreviewMediaBridge();
  if (bridge.isListOrderMode()) {
    bridge.endListOrderPlayback();
  }
}

/** 클립 맵 존재 (하이라이트용) */
export function isListOrderPreviewTimelineActive() {
  return activeClips.length > 0;
}

/** ProgramClip executor armed (segment program-order preview) */
export function isListOrderSeamlessPlaybackActive() {
  return isProgramPreviewExecutorActive();
}

export { isProgramPreviewExecutorActive };

export function getListOrderPreviewClips() {
  return activeClips;
}

export function getListOrderPreviewProgramClips() {
  return activeProgramClips;
}

/** @param {number} clipIndex */
export function resetListOrderPreviewClipPos(clipIndex) {
  if (!activeClips.length) {
    activeClipPos = 0;
    return;
  }
  activeClipPos = Math.max(0, Math.min(clipIndex, activeClips.length - 1));
  const ex = getProgramPreviewExecutor();
  if (ex.isArmed()) {
    ex.clipPos = activeClipPos;
  }
}

/** UI·하이라이트 SSOT — executor clipPos */
export function getListOrderPreviewCommittedClipPos() {
  const ex = getProgramPreviewExecutor();
  if (ex.isArmed()) return ex.getClipPos();
  return activeClipPos;
}

export function getListOrderPreviewClipPos() {
  return getListOrderPreviewCommittedClipPos();
}

export function getListOrderPreviewProgramSec() {
  const ex = getProgramPreviewExecutor();
  if (ex.isArmed()) return ex.getProgramSec();
  return 0;
}

export { isListOrderTransitionLocked };

/**
 * @param {HTMLVideoElement} video
 * @param {HTMLAudioElement} audio
 * @param {{ skipRanges: { start: number, end: number }[] }} opts
 */
export function syncListOrderPreviewPlayback(video, audio, opts) {
  const ex = getProgramPreviewExecutor();
  if (!ex.isArmed()) return false;
  const bridge = getPreviewMediaBridge();
  const a = bridge.audio ?? bridge.primaryAudio ?? audio;
  const v = bridge.video ?? bridge.primaryVideo ?? video;
  if (opts?.skipRanges) {
    ex.skipRanges = opts.skipRanges;
  }
  const snap = ex.tick({ audio: a, video: v });
  activeClipPos = snap.clipPos;
  return true;
}

/**
 * @param {{
 *   startMediaSec: number,
 *   skipRanges: { start: number, end: number }[],
 *   clipPos: number,
 *   useEnvelope?: boolean,
 *   programClips?: readonly import("../shared/program-clips-ssot.js").ProgramClip[],
 *   mode?: 'virtual' | 'baked',
 * }} opts
 */
export async function armListOrderSeamlessPlayback(opts) {
  const bridge = getPreviewMediaBridge();
  if (bridge.isTransitionLocked()) {
    bridge.abortActiveTransition();
    await bridge.waitTransitionIdle();
  }
  if (bridge.isListOrderMode()) {
    bridge.endListOrderPlayback();
  }

  const clips = activeClips;
  const programClips = opts.programClips?.length
    ? opts.programClips
    : activeProgramClips;
  const clipPos = Math.max(0, Math.min(opts.clipPos, clips.length - 1));
  const clip = clips[clipPos];
  const mediaStart = skipCutRangeAt(Math.max(0, opts.startMediaSec || 0), opts.skipRanges || []);
  const mode =
    opts.mode === "baked" || isProgramPlaybackTimeline() ? "baked" : "virtual";
  const programSec = clip
    ? programSecFromAudioSlave(clip, mediaStart)
    : 0;

  const ex = getProgramPreviewExecutor();
  ex.arm({
    clips,
    programClips,
    clipPos,
    programSec,
    mode,
    skipRanges: opts.skipRanges || [],
  });

  const a = bridge.audio ?? bridge.primaryAudio;
  const v = bridge.video ?? bridge.primaryVideo;
  ex.seekProgramSec(programSec, { audio: a, video: v });
  if (opts.playing === true) {
    ex.play();
  } else {
    ex.pause();
  }
  activeClipPos = clipPos;

  void opts.useEnvelope;
}

export function isListOrderPreviewPlaybackEnded() {
  const ex = getProgramPreviewExecutor();
  return ex.isArmed() && ex.ended;
}
