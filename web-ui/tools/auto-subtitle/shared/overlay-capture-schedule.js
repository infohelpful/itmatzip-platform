/**
 * V51 — overlay-capture-schedule: program 축 생성 후 burn-in PTS map 변환.
 */

import {
  createOverlayTimingContext,
  createProgramBurnInOverlayContext,
  generateCaptureSchedule,
  isProgramExportTimeAxis,
  PREVIEW_OVERLAY_BRIDGE_SEC,
  resolveExportCueText,
} from "./overlay-timing-ssot.js?v=4";
import {
  buildProgramDurationScaleMap,
  remapScheduleToBurninAxis,
} from "./media-timing-ssot.js?v=12";
import { normalizeCutRanges } from "../export/export-timeline.js?v=2";

export {
  isProgramExportTimeAxis,
  PREVIEW_OVERLAY_BRIDGE_SEC,
  resolveExportCueText,
};

/** @typedef {{ start: number, end: number, text: string, cueIndex?: number }} OverlayCaptureSegment */

/**
 * @param {readonly object[]} cues
 * @param {{
 *   requiresConcat?: boolean,
 *   exportTimeAxis?: string,
 *   cutRanges?: readonly { start: number, end: number }[],
 *   blocks?: readonly object[],
 *   virtualIndex?: readonly object[],
 *   programToBurninMap?: readonly object[],
 *   programClips?: readonly import("./program-clips-ssot.js").ProgramClip[],
 *   burninMediaDuration?: number,
 * }} opts
 * @returns {OverlayCaptureSegment[]}
 */
export function buildOverlayCaptureSchedule(cues, opts = {}) {
  const requiresConcat = !!opts.requiresConcat;
  const exportTimeAxis =
    opts.exportTimeAxis || (requiresConcat ? "stitched_program" : "media");
  const useProgram = isProgramExportTimeAxis(exportTimeAxis);
  const scheduleCutRanges = useProgram ? [] : normalizeCutRanges(opts.cutRanges || []);

  const ctx = useProgram
    ? createProgramBurnInOverlayContext({
        cues,
        blocks: opts.blocks,
        virtualIndex: opts.virtualIndex,
        programClips: opts.programClips,
        exportTimeAxis,
        requiresConcat,
      })
    : createOverlayTimingContext({
        cues,
        blocks: opts.blocks,
        virtualIndex: opts.virtualIndex,
        cutRanges: scheduleCutRanges,
        playbackMode: "time",
        exportTimeAxis,
        requiresConcat,
        programClips: opts.programClips,
      });

  let schedule = generateCaptureSchedule(ctx).map(({ start, end, text, cueIndex }) => ({
    start,
    end,
    text,
    cueIndex,
  }));

  if (exportTimeAxis === "program") {
    const burninDur = Number(opts.burninMediaDuration);
    if (burninDur > 0 && schedule.length > 0) {
      const programEnd = schedule[schedule.length - 1].end;
      const scaleMap = buildProgramDurationScaleMap(programEnd, burninDur);
      if (scaleMap) schedule = remapScheduleToBurninAxis(schedule, scaleMap);
    }
    return schedule;
  }

  const map = opts.programToBurninMap;
  if (map?.length) return remapScheduleToBurninAxis(schedule, map);

  return schedule;
}
