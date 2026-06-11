/**
 * Overlay Timing SSOT — 프리뷰·캡처·번인이 공유하는 자막 표시 시각 규칙.
 * (미디어/concat 축은 media-timing-ssot 및 export 파이프라인 후처리가 담당)
 */

import { buildExportCueLines } from "./export-cue-pipeline.js?v=4";
import { normalizePreviewSubtitleText } from "./subtitle-box-chrome.js?v=25";
import { subtitleLineEditDisplayText, visibleSubtitleWords } from "./subtitles.js?v=28";
import {
  blocksToExportSegments,
  blocksToOverlayProgramSegments,
} from "./blocks-to-export.js?v=5";
import { programClipsToOverlaySegments } from "./program-clips-ssot.js?v=6";
import { buildVirtualAudioMap } from "./virtual-audio-map.js?v=3";
import {
  EXPORT_CUE_BRIDGE_SEC,
  normalizeCutRanges,
  remapTimeByCuts,
} from "../export/export-timeline.js?v=2";
import {
  cueIndexForClipIndex,
  cueIndexAtListPos,
  listPosFromProgramSec,
} from "./subtitle-list-playback.js?v=11";

export const PREVIEW_OVERLAY_BRIDGE_SEC = 0.07;

const PLAYBACK_TAIL_PRE_SEC = 0.02;
const PLAYBACK_TAIL_LEAD_SEC = 0.01;
const MIN_SEGMENT_SEC = 0.01;
const TIME_EPS = 1e-9;

/** @param {string | null | undefined} axis */
export function isProgramExportTimeAxis(axis) {
  const a = String(axis || "").trim();
  return a === "stitched_program" || a === "filter_program" || a === "program";
}

/**
 * DOM 비의존 — getPreviewCueText 정규화 파이프라인과 동치.
 *
 * @param {object | null | undefined} cue
 */
export function resolveExportCueText(cue) {
  if (!cue) return "";
  if (cue.is_silence || cue.isSilence) return "";
  const text = normalizePreviewSubtitleText(subtitleLineEditDisplayText(cue));
  if (!text || text === "[--]") return "";
  return text;
}

/**
 * @typedef {object} OverlayTimingContext
 * @property {readonly object[]} cues
 * @property {readonly object[] | undefined} blocks
 * @property {readonly object[] | undefined} virtualIndex
 * @property {readonly { start: number, end: number }[]} cutRanges
 * @property {"list-order" | "time"} playbackMode
 * @property {string} exportTimeAxis
 * @property {readonly import("./timeline-mapping.js").TimelineClip[]} clips
 * @property {readonly import("./program-clips-ssot.js").ProgramClip[]} [programClips]
 * @property {boolean} requiresConcat
 * @property {number | undefined} actualDuration
 * @property {boolean} isMediaPlaying
 * @property {number} listPlaybackClipPos
 * @property {(t: number) => number} [resolveListOrderCueIndex]
 * @property {OverlayTimingSegment[] | null} [_scheduleCache]
 */

/**
 * @typedef {{ start: number, end: number, text: string, cueIndex: number }} OverlayTimingSegment
 */

/**
 * @typedef {{ cueIndex: number, text: string, segmentStart: number, segmentEnd: number }} OverlayCueHit
 */

/**
 * 앱 전역 단일 Overlay Timing Context 빌더 (Export·Preview 공용).
 *
 * @param {{
 *   cues: readonly object[],
 *   blocks?: readonly object[],
 *   virtualIndex?: readonly object[],
 *   cutRanges?: readonly { start: number, end: number }[],
 *   playbackMode?: "list-order" | "time",
 *   exportTimeAxis?: string,
 *   clips?: readonly import("./timeline-mapping.js").TimelineClip[],
 *   requiresConcat?: boolean,
 *   actualDuration?: number,
 *   isMediaPlaying?: boolean,
 *   listPlaybackClipPos?: number,
 *   resolveListOrderCueIndex?: (t: number) => number,
 *   programClips?: readonly import("./program-clips-ssot.js").ProgramClip[],
 * }} opts
 * @returns {OverlayTimingContext}
 */
export function createOverlayTimingContext(opts) {
  const exportTimeAxis =
    opts.exportTimeAxis ||
    (opts.requiresConcat ? "stitched_program" : "media");
  return {
    cues: opts.cues || [],
    blocks: opts.blocks,
    virtualIndex: opts.virtualIndex,
    cutRanges: opts.cutRanges || [],
    playbackMode: opts.playbackMode === "list-order" ? "list-order" : "time",
    exportTimeAxis,
    clips: /** @type {readonly import("./timeline-mapping.js").TimelineClip[]} */ (
      opts.clips || []
    ),
    requiresConcat: !!opts.requiresConcat,
    actualDuration: opts.actualDuration,
    isMediaPlaying: !!opts.isMediaPlaying,
    listPlaybackClipPos: Number.isFinite(opts.listPlaybackClipPos)
      ? /** @type {number} */ (opts.listPlaybackClipPos)
      : -1,
    resolveListOrderCueIndex: opts.resolveListOrderCueIndex,
    programClips: opts.programClips?.length ? opts.programClips : undefined,
    _scheduleCache: null,
  };
}

/** @param {OverlayTimingContext | null | undefined} ctx */
export function invalidateOverlayTimingCache(ctx) {
  if (ctx) ctx._scheduleCache = null;
}

/**
 * @param {OverlayTimingContext} ctx
 */
function useProgramSchedule(ctx) {
  return isProgramExportTimeAxis(ctx.exportTimeAxis);
}

/**
 * @param {readonly object[]} cues
 * @param {number} cueIndex
 */
function exportTimeRangeForCue(cues, cueIndex) {
  const cue = cues[cueIndex];
  if (!cue) return null;
  const text = resolveExportCueText(cue);
  if (!text) return null;
  const hasWords = Array.isArray(cue.words) && cue.words.length > 0;
  if (hasWords) {
    const vis = visibleSubtitleWords(cue.words);
    if (!vis.length) return null;
    return {
      cueIndex,
      text,
      start: Math.min(...vis.map((w) => w.start)),
      end: Math.max(...vis.map((w) => w.end)),
    };
  }
  return {
    cueIndex,
    text,
    start: Number(cue.start) || 0,
    end: Number(cue.end) || 0,
  };
}

/**
 * @param {OverlayTimingContext} ctx
 * @param {readonly { start: number, end: number }[]} cutRanges
 * @returns {OverlayTimingSegment[]}
 */
function buildProgramAxisBaseSegments(ctx, cutRanges) {
  const { cues, blocks, virtualIndex, programClips } = ctx;

  if (programClips?.length) {
    const segs = programClipsToOverlaySegments(programClips);
    /** @type {OverlayTimingSegment[]} */
    const out = [];
    for (let i = 0; i < segs.length; i += 1) {
      const seg = segs[i];
      if (seg.isSilence) continue;
      const cueIndex = seg.blockIndex;
      const cue = cues[cueIndex];
      const text = resolveExportCueText(cue);
      if (!text) continue;

      let start = seg.editStart;
      let end = seg.editEnd;

      const nextSeg = i + 1 < segs.length ? segs[i + 1] : null;
      if (nextSeg && cue) {
        const cueEndVirtual = seg.virtualEnd;
        const nextStartVirtual = nextSeg.editStart;
        if (Number.isFinite(nextStartVirtual) && nextStartVirtual > cueEndVirtual + 1e-5) {
          const tailStart = seg.editEnd - PLAYBACK_TAIL_PRE_SEC;
          const tailEnd = Math.min(
            nextSeg.editStart - PLAYBACK_TAIL_LEAD_SEC,
            seg.editEnd + PREVIEW_OVERLAY_BRIDGE_SEC,
          );
          if (tailEnd > tailStart + MIN_SEGMENT_SEC) {
            end = Math.max(end, tailEnd);
          }
        }
      }

      if (end > start + MIN_SEGMENT_SEC) {
        out.push({ start, end, text, cueIndex });
      }
    }
    return out;
  }

  const useBlocks =
    Array.isArray(blocks) &&
    blocks.length > 0 &&
    Array.isArray(virtualIndex) &&
    virtualIndex.length > 0;

  if (useBlocks) {
    const segs = blocksToOverlayProgramSegments(blocks, virtualIndex, { cutRanges });
    /** @type {OverlayTimingSegment[]} */
    const out = [];
    for (let i = 0; i < segs.length; i += 1) {
      const seg = segs[i];
      if (seg.isSilence) continue;
      const cueIndex = seg.blockIndex;
      const cue = cues[cueIndex];
      const text = resolveExportCueText(cue);
      if (!text) continue;

      let start = seg.editStart;
      let end = seg.editEnd;

      const nextSeg = i + 1 < segs.length ? segs[i + 1] : null;
      if (nextSeg && cue) {
        const cueEndVirtual = seg.virtualEnd;
        const nextStartVirtual = nextSeg.editStart;
        if (Number.isFinite(nextStartVirtual) && nextStartVirtual > cueEndVirtual + 1e-5) {
          const tailStart = seg.editEnd - PLAYBACK_TAIL_PRE_SEC;
          const tailEnd = Math.min(
            nextSeg.editStart - PLAYBACK_TAIL_LEAD_SEC,
            seg.editEnd + PREVIEW_OVERLAY_BRIDGE_SEC,
          );
          if (tailEnd > tailStart + MIN_SEGMENT_SEC) {
            end = Math.max(end, tailEnd);
          }
        }
      }

      if (end > start + MIN_SEGMENT_SEC) {
        out.push({ start, end, text, cueIndex });
      }
    }
    return out;
  }

  const map = buildVirtualAudioMap(cues, { cutRanges });
  /** @type {OverlayTimingSegment[]} */
  const out = [];

  for (let i = 0; i < map.length; i += 1) {
    const seg = map[i];
    if (seg.isSilence) continue;
    const cueIndex = seg.cueIndex;
    const cue = cues[cueIndex];
    const text = resolveExportCueText(cue);
    if (!text) continue;

    let start = seg.editStart;
    let end = seg.editEnd;

    const nextSeg = i + 1 < map.length ? map[i + 1] : null;
    if (nextSeg && cue) {
      const nextCue = cues[nextSeg.cueIndex];
      const cueEndVirtual = Number(cue.end) || 0;
      const nextStartVirtual = Number(nextCue?.start);
      if (Number.isFinite(nextStartVirtual) && nextStartVirtual > cueEndVirtual + 1e-5) {
        const tailStart = seg.editEnd - PLAYBACK_TAIL_PRE_SEC;
        const tailEnd = Math.min(
          nextSeg.editStart - PLAYBACK_TAIL_LEAD_SEC,
          seg.editEnd + PREVIEW_OVERLAY_BRIDGE_SEC,
        );
        if (tailEnd > tailStart + MIN_SEGMENT_SEC) {
          end = Math.max(end, tailEnd);
        }
      }
    }

    if (end > start + MIN_SEGMENT_SEC) {
      out.push({ start, end, text, cueIndex });
    }
  }
  return out;
}

/**
 * @param {readonly OverlayTimingSegment[]} subtitles
 */
function normalizeMappedSegmentsWithCue(subtitles) {
  if (!subtitles || subtitles.length <= 1) return [...(subtitles || [])];
  const sorted = [...subtitles].sort((a, b) => a.start - b.start || a.end - b.end);
  /** @type {OverlayTimingSegment[]} */
  const out = [];
  for (const cur of sorted) {
    const text = String(cur.text || "").trim();
    if (!text) continue;
    if (out.length === 0) {
      if (cur.end > cur.start + 0.02) out.push({ ...cur, text });
      continue;
    }
    const last = out[out.length - 1];
    const gap = cur.start - last.end;
    let nextStart = cur.start;
    if (nextStart < last.end) {
      nextStart = last.end;
    } else if (gap > 0 && gap < EXPORT_CUE_BRIDGE_SEC) {
      nextStart = last.end;
    }
    if (cur.end <= nextStart + 0.01) continue;
    out.push({ start: nextStart, end: cur.end, text, cueIndex: cur.cueIndex });
  }
  return out;
}

/**
 * @param {readonly object[]} cues
 * @param {readonly { start: number, end: number }[]} cutRanges
 * @returns {OverlayTimingSegment[]}
 */
function buildMediaAxisBaseSegments(cues, cutRanges) {
  const normalized = normalizeCutRanges(cutRanges);
  /** @type {OverlayTimingSegment[]} */
  const mapped = [];
  for (let i = 0; i < cues.length; i += 1) {
    const entry = exportTimeRangeForCue(cues, i);
    if (!entry) continue;
    const mappedStart = remapTimeByCuts(Number(entry.start), normalized);
    const mappedEnd = remapTimeByCuts(Number(entry.end), normalized);
    if (!(mappedEnd > mappedStart + 0.01)) continue;
    mapped.push({
      start: mappedStart,
      end: mappedEnd,
      text: entry.text,
      cueIndex: entry.cueIndex,
    });
  }
  return normalizeMappedSegmentsWithCue(mapped);
}

/**
 * @param {OverlayTimingSegment} seg
 * @returns {OverlayTimingSegment}
 */
function applyBridgeExtension(seg) {
  return {
    ...seg,
    start: Math.max(0, seg.start - PREVIEW_OVERLAY_BRIDGE_SEC),
    end: seg.end + PREVIEW_OVERLAY_BRIDGE_SEC,
  };
}

/**
 * Case A: 동일 텍스트 병합 / Case B: overlap 중점 분할 — 비중첩 [start, end) 보장.
 *
 * @param {readonly OverlayTimingSegment[]} bridged
 * @returns {OverlayTimingSegment[]}
 */
function resolveOverlappedSegments(bridged) {
  let segs = bridged
    .filter((s) => s.end > s.start + MIN_SEGMENT_SEC)
    .map((s) => ({ ...s }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  if (segs.length <= 1) return segs;

  let changed = true;
  let guard = 0;
  while (changed && guard < 512) {
    guard += 1;
    changed = false;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const a = segs[i];
      const b = segs[i + 1];

      if (b.start >= a.end - TIME_EPS) {
        if (a.text === b.text && b.start - a.end < PREVIEW_OVERLAY_BRIDGE_SEC * 2) {
          a.end = Math.max(a.end, b.end);
          a.start = Math.min(a.start, b.start);
          a.cueIndex = a.cueIndex >= 0 ? a.cueIndex : b.cueIndex;
          segs.splice(i + 1, 1);
          changed = true;
          break;
        }
        continue;
      }

      const overlapStart = Math.max(a.start, b.start);
      const overlapEnd = Math.min(a.end, b.end);
      if (overlapEnd <= overlapStart + MIN_SEGMENT_SEC) continue;

      if (a.text === b.text) {
        a.end = Math.max(a.end, b.end);
        a.start = Math.min(a.start, b.start);
        segs.splice(i + 1, 1);
        changed = true;
        break;
      }

      const split = overlapStart + (overlapEnd - overlapStart) / 2;
      a.end = Math.max(a.start + MIN_SEGMENT_SEC, split);
      b.start = Math.min(b.end - MIN_SEGMENT_SEC, split);
      if (b.end <= b.start + MIN_SEGMENT_SEC) {
        segs.splice(i + 1, 1);
      }
      changed = true;
      break;
    }
  }

  return segs.filter((s) => s.end > s.start + MIN_SEGMENT_SEC);
}

/**
 * @param {OverlayTimingContext} ctx
 * @returns {OverlayTimingSegment[]}
 */
function buildCoreSchedule(ctx) {
  const program = useProgramSchedule(ctx);
  const cutRanges = normalizeCutRanges(program ? [] : ctx.cutRanges || []);
  const base = program
    ? buildProgramAxisBaseSegments(ctx, cutRanges)
    : buildMediaAxisBaseSegments(ctx.cues, ctx.cutRanges || []);
  const bridged = base.map((seg) => applyBridgeExtension(seg));
  return resolveOverlappedSegments(bridged);
}

/**
 * 이벤트 기반 비중첩 PNG 캡처 스케줄 (1/fps naive loop 금지).
 *
 * @param {OverlayTimingContext} ctx
 * @returns {OverlayTimingSegment[]}
 */
export function generateCaptureSchedule(ctx) {
  if (ctx._scheduleCache) return ctx._scheduleCache;
  const schedule = buildCoreSchedule(ctx);
  ctx._scheduleCache = schedule;
  return schedule;
}

/**
 * @param {readonly OverlayTimingSegment[]} schedule
 * @param {number} t
 * @returns {OverlayTimingSegment | null}
 */
export function scheduleSegmentAtTime(schedule, t) {
  if (!schedule.length || !Number.isFinite(t)) return null;
  let lo = 0;
  let hi = schedule.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = schedule[mid];
    if (t < seg.start - TIME_EPS) {
      hi = mid - 1;
    } else if (t >= seg.end - TIME_EPS) {
      lo = mid + 1;
    } else {
      return seg;
    }
  }
  return null;
}

/**
 * @param {readonly import("./timeline-mapping.js").TimelineClip[]} clips
 * @param {number} cueIndex
 */
function clipBoundsForCueIndex(clips, cueIndex) {
  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i];
    if (clip.cueIndex === cueIndex) {
      return { segmentStart: clip.editStart, segmentEnd: clip.editEnd };
    }
  }
  return null;
}

/**
 * @param {OverlayTimingContext} ctx
 * @param {number} cueIndex
 */
function resolveListOrderCueHit(ctx, cueIndex) {
  if (cueIndex < 0) return null;
  const cue = ctx.cues[cueIndex];
  const text = resolveExportCueText(cue);
  if (!text) return null;
  const clipBounds = clipBoundsForCueIndex(ctx.clips, cueIndex);
  if (clipBounds) {
    return {
      cueIndex,
      text,
      segmentStart: clipBounds.segmentStart,
      segmentEnd: clipBounds.segmentEnd,
    };
  }
  const range = exportTimeRangeForCue(ctx.cues, cueIndex);
  return {
    cueIndex,
    text,
    segmentStart: range?.start ?? 0,
    segmentEnd: range?.end ?? 0,
  };
}

/**
 * @param {OverlayTimingContext} ctx
 * @param {number} t
 * @returns {OverlayCueHit | null}
 */
export function resolveCueAtTime(ctx, t) {
  const time = Number(t);
  if (!Number.isFinite(time)) return null;

  if (
    ctx.playbackMode === "list-order" &&
    ctx.isMediaPlaying &&
    ctx.clips.length > 0
  ) {
    let cueIndex = -1;
    if (typeof ctx.resolveListOrderCueIndex === "function") {
      cueIndex = ctx.resolveListOrderCueIndex(time);
    } else if (ctx.listPlaybackClipPos >= 0) {
      cueIndex = cueIndexForClipIndex(ctx.clips, ctx.cues, ctx.listPlaybackClipPos);
    } else {
      const listPos = listPosFromProgramSec(ctx.clips, time);
      cueIndex = cueIndexAtListPos(ctx.cues, listPos);
    }
    return resolveListOrderCueHit(ctx, cueIndex);
  }

  const schedule = generateCaptureSchedule(ctx);
  const seg = scheduleSegmentAtTime(schedule, time);
  if (!seg) return null;
  return {
    cueIndex: seg.cueIndex,
    text: seg.text,
    segmentStart: seg.start,
    segmentEnd: seg.end,
  };
}

/**
 * Export-only helper — cue lines without schedule (legacy compat).
 *
 * @param {readonly object[]} cues
 */
export function buildExportCueTextLines(cues) {
  return buildExportCueLines(cues);
}

/**
 * Program axis segment map for media-timing post-process (read-only export).
 *
 * @param {OverlayTimingContext} ctx
 */
export function overlayContextProgramMap(ctx) {
  const cuts = normalizeCutRanges(ctx.cutRanges || []);
  const useBlocks =
    Array.isArray(ctx.blocks) &&
    ctx.blocks.length > 0 &&
    Array.isArray(ctx.virtualIndex) &&
    ctx.virtualIndex.length > 0;
  return useBlocks
    ? blocksToExportSegments(ctx.blocks, ctx.virtualIndex, { cutRanges: cuts })
    : buildVirtualAudioMap(ctx.cues, { cutRanges: cuts });
}
