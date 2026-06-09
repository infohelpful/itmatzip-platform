/**
 * V47c — 프리뷰 overlay 규칙과 동치인 PNG 캡처 스케줄 SSOT.
 */

import { buildExportCueLines } from "./export-cue-pipeline.js?v=4";
import { normalizePreviewSubtitleText } from "./subtitle-box-chrome.js?v=25";
import { subtitleLineEditDisplayText } from "./subtitles.js?v=28";
import {
  blocksToExportSegments,
  blocksToOverlayProgramSegments,
} from "./blocks-to-export.js?v=1";
import { buildVirtualAudioMap } from "./virtual-audio-map.js?v=2";
import { buildMappedSubtitles, normalizeCutRanges } from "../export/export-timeline.js?v=2";

export const PREVIEW_OVERLAY_BRIDGE_SEC = 0.07;

const PLAYBACK_TAIL_PRE_SEC = 0.02;
const PLAYBACK_TAIL_LEAD_SEC = 0.01;
const MIN_SEGMENT_SEC = 0.01;
const ACTUAL_DURATION_DEADZONE_SEC = 0.02;

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
 * @typedef {{ start: number, end: number, text: string }} OverlayCaptureSegment
 */

/**
 * @param {readonly object[]} cues
 * @param {{ requiresConcat?: boolean, cutRanges?: readonly { start: number, end: number }[], actualDuration?: number, blocks?: readonly object[], virtualIndex?: readonly object[] }} opts
 * @returns {OverlayCaptureSegment[]}
 */
export function buildOverlayCaptureSchedule(cues, opts = {}) {
  const requiresConcat = !!opts.requiresConcat;
  const cutRanges = normalizeCutRanges(opts.cutRanges || []);
  const blockOpts = {
    blocks: opts.blocks,
    virtualIndex: opts.virtualIndex,
  };
  const base = requiresConcat
    ? buildProgramAxisBaseSegments(cues, cutRanges, blockOpts)
    : buildMediaAxisBaseSegments(cues, cutRanges);
  const bridged = base.map((seg) => applyBridgeExtension(seg));
  const schedule = resolveOverlappedSegments(bridged);
  return applyActualDurationAlignment(schedule, cues, {
    requiresConcat,
    cutRanges,
    actualDuration: opts.actualDuration,
    blocks: opts.blocks,
    virtualIndex: opts.virtualIndex,
  });
}

/**
 * V50 — Slow-Path concat 실측 duration 기반 program 축 후처리 (Case A/B 이후).
 *
 * @param {readonly OverlayCaptureSegment[]} schedule
 * @param {readonly object[]} cues
 * @param {{ requiresConcat?: boolean, cutRanges?: readonly { start: number, end: number }[], actualDuration?: number, blocks?: readonly object[], virtualIndex?: readonly object[] }} opts
 * @returns {OverlayCaptureSegment[]}
 */
function applyActualDurationAlignment(schedule, cues, opts) {
  if (!opts.requiresConcat) return schedule;
  const actual = Number(opts.actualDuration);
  if (!Number.isFinite(actual) || actual <= 0) return schedule;

  const cuts = normalizeCutRanges(opts.cutRanges || []);
  const useBlocks =
    Array.isArray(opts.blocks) &&
    opts.blocks.length > 0 &&
    Array.isArray(opts.virtualIndex) &&
    opts.virtualIndex.length > 0;
  const map = useBlocks
    ? blocksToExportSegments(opts.blocks, opts.virtualIndex, { cutRanges: cuts })
    : buildVirtualAudioMap(cues, { cutRanges: cuts });
  if (!map.length) return schedule;
  const expectedEnd = Number(map[map.length - 1].editEnd) || 0;
  if (expectedEnd <= 0) return schedule;

  if (Math.abs(actual - expectedEnd) < ACTUAL_DURATION_DEADZONE_SEC) return schedule;

  let adjusted = schedule.map((s) => ({ ...s }));

  if (actual > expectedEnd) {
    const scale = actual / expectedEnd;
    adjusted = adjusted.map((s) => ({
      ...s,
      start: s.start * scale,
      end: s.end * scale,
    }));
    adjusted = adjusted.map((s) => ({
      ...s,
      start: Math.min(Math.max(0, s.start), actual),
      end: Math.min(s.end, actual),
    }));
  } else {
    adjusted = adjusted.map((s) => ({
      ...s,
      end: Math.min(s.end, actual),
    }));
  }

  return adjusted.filter((s) => s.end > s.start + MIN_SEGMENT_SEC);
}

/**
 * @param {readonly object[]} cues
 * @param {readonly { start: number, end: number }[]} cutRanges
 * @param {{ blocks?: readonly object[], virtualIndex?: readonly object[] }} [blockOpts]
 * @returns {OverlayCaptureSegment[]}
 */
function buildProgramAxisBaseSegments(cues, cutRanges, blockOpts = {}) {
  const useBlocks =
    Array.isArray(blockOpts.blocks) &&
    blockOpts.blocks.length > 0 &&
    Array.isArray(blockOpts.virtualIndex) &&
    blockOpts.virtualIndex.length > 0;

  if (useBlocks) {
    const segs = blocksToOverlayProgramSegments(blockOpts.blocks, blockOpts.virtualIndex, {
      cutRanges,
    });
    /** @type {OverlayCaptureSegment[]} */
    const out = [];
    for (let i = 0; i < segs.length; i += 1) {
      const seg = segs[i];
      if (seg.isSilence) continue;
      const cue = cues[seg.blockIndex];
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
        out.push({ start, end, text });
      }
    }
    return out;
  }

  const map = buildVirtualAudioMap(cues, { cutRanges });
  /** @type {OverlayCaptureSegment[]} */
  const out = [];

  for (let i = 0; i < map.length; i += 1) {
    const seg = map[i];
    if (seg.isSilence) continue;
    const cue = cues[seg.cueIndex];
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
      out.push({ start, end, text });
    }
  }
  return out;
}

/**
 * @param {readonly object[]} cues
 * @param {readonly { start: number, end: number }[]} cutRanges
 * @returns {OverlayCaptureSegment[]}
 */
function buildMediaAxisBaseSegments(cues, cutRanges) {
  const lines = buildExportCueLines(cues);
  /** @type {{ start: number, end: number, text: string }[]} */
  const forMap = [];
  for (const line of lines) {
    const text = resolveExportCueText(line);
    if (!text) continue;
    forMap.push({
      start: Number(line.start) || 0,
      end: Number(line.end) || 0,
      text,
    });
  }
  return buildMappedSubtitles(forMap, cutRanges).map((seg) => ({
    start: seg.start,
    end: seg.end,
    text: seg.text,
  }));
}

/**
 * @param {OverlayCaptureSegment} seg
 * @returns {OverlayCaptureSegment}
 */
function applyBridgeExtension(seg) {
  return {
    text: seg.text,
    start: Math.max(0, seg.start - PREVIEW_OVERLAY_BRIDGE_SEC),
    end: seg.end + PREVIEW_OVERLAY_BRIDGE_SEC,
  };
}

/**
 * Case A: 동일 텍스트 병합 / Case B: overlap 중점 분할.
 *
 * @param {readonly OverlayCaptureSegment[]} bridged
 * @returns {OverlayCaptureSegment[]}
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

      if (b.start >= a.end - 1e-9) {
        if (a.text === b.text && b.start - a.end < PREVIEW_OVERLAY_BRIDGE_SEC * 2) {
          a.end = Math.max(a.end, b.end);
          a.start = Math.min(a.start, b.start);
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
