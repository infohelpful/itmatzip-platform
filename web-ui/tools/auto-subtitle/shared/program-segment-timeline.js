/**
 * Phase 1-R — programClips → TimelineClip 단일 빌드 + preview consumer fan-out SSOT.
 */

import { mergeCutRanges } from "./timeline-collapse.js?v=1";
import {
  mapMediaToProgramSec,
  mapProgramToMediaSec,
  programDurationSec as timelineProgramDurationSec,
} from "./timeline-mapping.js?v=1";
import {
  buildProgramClips,
  getProgramDurationSec,
  programClipsFingerprint,
} from "./program-clips-ssot.js?v=2";
import { programClipsToTimelineClips } from "./program-clips-adapter.js?v=3";
import { clampProgramSec } from "./program-playback-clock.js?v=3";
import { setListOrderPreviewTimeline, armListOrderSeamlessPlayback, isListOrderSeamlessPlaybackActive } from "../hub/list-order-preview-sync.js?v=11";

/**
 * @typedef {import("./program-clips-ssot.js").ProgramClip} ProgramClip
 * @typedef {import("./timeline-mapping.js").TimelineClip} TimelineClip
 *
 * @typedef {{
 *   programClips: ProgramClip[],
 *   timelineClips: TimelineClip[],
 *   programDurationSec: number,
 *   fingerprint: string,
 *   mediaEndHintSec: number,
 *   mapping: ReturnType<typeof createStitchedMappingFromTimelineClips>,
 * }} ProgramSegmentTimelineBundle
 *
 * @typedef {{
 *   preserveProgramSec?: boolean,
 *   programSec?: number,
 *   rearmSeamlessPlayback?: boolean,
 *   clipPos?: number,
 *   startMediaSec?: number,
 *   skipOverlayRefresh?: boolean,
 *   reason?: string,
 * }} RefreshProgramSegmentTimelineOpts
 */

/** @type {ProgramSegmentTimelineBundle | null} */
let cachedBundle = null;
let timelineRebuilding = false;

export function isProgramSegmentTimelineRebuilding() {
  return timelineRebuilding;
}

/** @type {{
 *   onOrchestratorRebuild?: (bundle: ProgramSegmentTimelineBundle) => void,
 *   onOverlayRefresh?: (bundle: ProgramSegmentTimelineBundle) => void,
 *   onPlayheadClamp?: (programSec: number) => void,
 * }} */
let callbacks = {};

/**
 * @param {readonly TimelineClip[]} timelineClips
 * @param {number} mediaEndHintSec
 */
export function createStitchedMappingFromTimelineClips(timelineClips, mediaEndHintSec) {
  const clips = timelineClips || [];
  const hint = Math.max(0, Number(mediaEndHintSec) || 0);
  return {
    clips,
    mergedCuts: [],
    mediaEndHintSec: hint,
    programToMediaSec: (p) => mapProgramToMediaSec(p, clips),
    mediaToProgramSec: (m) => mapMediaToProgramSec(m, clips),
    programToMasterAudioSec: (p) => mapProgramToMediaSec(p, clips),
    masterAudioToProgramSec: (m) => mapMediaToProgramSec(m, clips),
    masterMode: "stitched",
  };
}

/**
 * @param {typeof callbacks} cbs
 */
export function setProgramSegmentTimelineCallbacks(cbs) {
  callbacks = { ...callbacks, ...cbs };
}

export function getProgramSegmentTimelineBundle() {
  return cachedBundle;
}

/** Phase 1-R-9 — list-order mapping SSOT from segment bundle (legacy cue path fallback). */
export function getListOrderPreviewMappingFromSegment() {
  if (!cachedBundle?.timelineClips?.length) return null;
  return { clips: cachedBundle.timelineClips, mapping: cachedBundle.mapping };
}

export function getProgramSegmentTimelineClips() {
  return cachedBundle?.timelineClips ?? [];
}

export function getProgramSegmentProgramClips() {
  return cachedBundle?.programClips ?? [];
}

export function getProgramSegmentDurationSec() {
  return cachedBundle?.programDurationSec ?? 0;
}

export function isProgramSegmentPreviewActive() {
  return Boolean(cachedBundle?.timelineClips?.length);
}

export function clearProgramSegmentTimeline() {
  cachedBundle = null;
  setListOrderPreviewTimeline({ clips: [], mapping: null });
}

/**
 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks
 * @param {readonly { start: number, end: number }[]} cutRanges
 * @param {number} mediaDurationSec
 * @param {string} previewMediaPath
 */
function buildProgramSegmentTimelineBundle(blocks, cutRanges, mediaDurationSec, previewMediaPath) {
  const programClips = buildProgramClips(blocks, cutRanges);
  if (!programClips.length) return null;
  const timelineClips = programClipsToTimelineClips(programClips);
  if (!timelineClips.length) return null;
  const programDurationSec = getProgramDurationSec(programClips);
  const mediaEndHintSec = Math.max(
    programDurationSec,
    timelineProgramDurationSec(timelineClips),
    Number(mediaDurationSec) || 0,
  );
  const fingerprint = programClipsFingerprint(
    previewMediaPath,
    programClips,
    JSON.stringify(cutRanges || []),
  );
  const mapping = createStitchedMappingFromTimelineClips(timelineClips, mediaEndHintSec);
  return {
    programClips,
    timelineClips,
    programDurationSec,
    fingerprint,
    mediaEndHintSec,
    mapping,
  };
}

/**
 * @param {readonly { start: number, end: number }[]} hardDeletedMediaSkips
 */
export function mergePreviewHardDeleteSkips(hardDeletedMediaSkips) {
  return mergeCutRanges([...(hardDeletedMediaSkips || [])]);
}

/**
 * @param {{
 *   blocks: readonly import("./block-timeline-adapter.js").Block[],
 *   cutRanges?: readonly { start: number, end: number }[],
 *   previewMediaPath?: string | null,
 *   mediaDurationSec?: number | null,
 *   hardDeletedMediaSkips?: readonly { start: number, end: number }[],
 * }} input
 * @param {RefreshProgramSegmentTimelineOpts} [opts]
 * @returns {ProgramSegmentTimelineBundle | null}
 */
export function refreshProgramSegmentTimeline(input, opts = {}) {
  timelineRebuilding = true;
  try {
    const blocks = input.blocks || [];
    if (!blocks.length) {
      clearProgramSegmentTimeline();
      return null;
    }

    const cutRanges = input.cutRanges || [];
    const previewMediaPath = String(input.previewMediaPath || "").trim();
    const mediaDurationSec = Number(input.mediaDurationSec) || 0;
    const bundle = buildProgramSegmentTimelineBundle(
      blocks,
      cutRanges,
      mediaDurationSec,
      previewMediaPath,
    );
    if (!bundle) {
      clearProgramSegmentTimeline();
      return null;
    }

    cachedBundle = bundle;
    const clipPosHint = Math.max(0, Number(opts.clipPos) || 0);
    setListOrderPreviewTimeline(
      {
        clips: bundle.timelineClips,
        mapping: bundle.mapping,
        programClips: bundle.programClips,
      },
      clipPosHint,
    );
    callbacks.onOrchestratorRebuild?.(bundle);

    if (!opts.skipOverlayRefresh) {
      callbacks.onOverlayRefresh?.(bundle);
    }

    if (opts.preserveProgramSec !== false && callbacks.onPlayheadClamp) {
      const current = Number.isFinite(Number(opts.programSec))
        ? Number(opts.programSec)
        : 0;
      callbacks.onPlayheadClamp(clampProgramSec(current, bundle.programDurationSec));
    }

    if (opts.rearmSeamlessPlayback && isListOrderSeamlessPlaybackActive()) {
      const skipRanges = mergePreviewHardDeleteSkips(input.hardDeletedMediaSkips);
      const clipPos = Math.max(
        0,
        Math.min(Number(opts.clipPos) || 0, bundle.timelineClips.length - 1),
      );
      const startClip = bundle.timelineClips[clipPos];
      const startMediaSec = Number.isFinite(Number(opts.startMediaSec))
        ? Number(opts.startMediaSec)
        : startClip
          ? startClip.mediaStart
          : 0;
      void armListOrderSeamlessPlayback({
        startMediaSec,
        skipRanges,
        clipPos,
        programClips: bundle.programClips,
        playing: true,
      });
    }

    if (opts.reason && typeof console.debug === "function") {
      console.debug("[program-segment]", opts.reason, {
        clips: bundle.timelineClips.length,
        programSec: bundle.programDurationSec,
      });
    }

    return bundle;
  } finally {
    timelineRebuilding = false;
  }
}
