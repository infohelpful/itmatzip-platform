/**
 * AutoSubtitle export:by-format — 웹 보내기 클라이언트 (IPC 대체).
 */

import { buildTextExport, TEXT_EXPORT_FORMATS } from "../shared/export-subtitle-formats.js";
import { buildExportCueLines } from "../shared/export-cue-pipeline.js?v=4";
import { anyCueRelocated } from "../shared/dual-axis.js?v=1";
import { rebuildVirtualIndexFromBlocks } from "../shared/block-timeline-adapter.js?v=1";
import { buildBlockStitchedProgramExportCues } from "../shared/blocks-to-export.js?v=3";
import {
  buildProgramClips,
  deriveCutRangesFromProgramClips,
  EXPORT_SCHEMA_VERSION,
  getProgramDurationSec,
  programClipsToApiPayload,
} from "../shared/program-clips-ssot.js?v=3";
import { blocksToVirtualAudioMap } from "../shared/blocks-to-export.js?v=3";
import {
  buildStitchedProgramExportCues,
  buildVirtualAudioMap,
  countValidKeepSegments,
  isSourceStartMonotonic,
  MAX_FAST_PATH_SEGMENTS,
} from "../shared/virtual-audio-map.js?v=3";

export const EXPORT_FORMATS = ["video", "srt", "vtt", "ass", "txt", "mp3", "wav"];

const FORMAT_LABELS = {
  video: "영상",
  srt: "SRT",
  vtt: "WebVTT",
  ass: "ASS",
  txt: "텍스트",
  mp3: "MP3",
  wav: "WAV",
};

/**
 * @param {string} fmt
 */
export function normalizeExportFormat(fmt) {
  const s = String(fmt || "srt").toLowerCase();
  if (EXPORT_FORMATS.includes(s)) return s;
  throw new Error(`지원하지 않는 보내기 형식: ${fmt}`);
}

/**
 * @param {string} fmt
 */
export function exportFormatLabel(fmt) {
  return FORMAT_LABELS[normalizeExportFormat(fmt)] || fmt;
}

/**
 * V5 — legacy concat path disabled; always false for block-based video export.
 * @param {readonly object[]} lastCues
 * @param {readonly { start: number, end: number }[]} cutRanges
 */
export function computeRequiresConcatExport(lastCues, cutRanges) {
  void lastCues;
  void cutRanges;
  return false;
}

const FILTER_PROGRAM_START_EPS = 0.02;
const FILTER_PROGRAM_END_EPS = 0.05;

/**
 * Monotonic Fast-Path에서 filter trim+concat이 필요한지 (편집 없으면 false).
 *
 * @param {readonly object[]} virtualAudioMap
 * @param {number} [mediaDurationSec]
 */
export function virtualAudioMapNeedsFilterProgram(virtualAudioMap, mediaDurationSec) {
  const map = virtualAudioMap || [];
  if (map.length === 0) return false;
  if (map.length > 1) return true;
  const seg = map[0];
  const s0 = Number(seg.sourceStart ?? seg.source_start ?? 0);
  const e0 = Number(seg.sourceEnd ?? seg.source_end ?? 0);
  if (s0 > FILTER_PROGRAM_START_EPS) return true;
  const dur = Number(mediaDurationSec);
  if (Number.isFinite(dur) && dur > 0 && e0 < dur - FILTER_PROGRAM_END_EPS) return true;
  return false;
}

/**
 * @param {boolean} requiresConcat
 * @param {readonly object[]} virtualAudioMap
 * @param {number} [mediaDurationSec]
 */
export function resolveExportTimeAxis(requiresConcat, virtualAudioMap, mediaDurationSec) {
  if (requiresConcat) return "stitched_program";
  if (virtualAudioMapNeedsFilterProgram(virtualAudioMap, mediaDurationSec)) {
    return "filter_program";
  }
  return "media";
}

/**
 * @param {readonly object[]} lastCues
 * @param {readonly { start: number, end: number }[]} cutRanges
 * @param {boolean} requiresConcat
 */
export function buildExportCuesForPayload(lastCues, cutRanges, requiresConcat) {
  if (requiresConcat) {
    return buildStitchedProgramExportCues(lastCues, { cutRanges });
  }
  return buildExportCueLines(lastCues);
}

/**
 * @param {readonly object[]} lastCues
 * @param {readonly { start: number, end: number }[]} cutRanges
 * @param {object} style
 * @param {string} format
 * @param {{ previewMediaPath?: string | null, videoPath?: string | null, programMasterPath?: string | null }} [media]
 * @param {{ blocks?: readonly object[], virtualIndex?: readonly object[], mediaDurationSec?: number | null }} [blockOpts]
 */
export function buildExportRequestPayload(
  lastCues,
  cutRanges,
  style,
  format,
  media = {},
  blockOpts = {},
) {
  const fmt = normalizeExportFormat(format);
  const needsMedia = ["video", "mp3", "wav"].includes(fmt);
  const previewMediaPath = media.previewMediaPath ?? null;
  const videoPath = media.videoPath ?? null;
  const programMasterPath = media.programMasterPath ?? null;
  const blocks = blockOpts.blocks;
  const useBlocks = Array.isArray(blocks) && blocks.length > 0;

  if (useBlocks && fmt === "video") {
    const programClips = buildProgramClips(blocks, cutRanges || []);
    const programDurationSec = getProgramDurationSec(programClips);
    const virtualIndex = rebuildVirtualIndexFromBlocks(blocks);
    const exportCues = buildBlockStitchedProgramExportCues(blocks, virtualIndex, lastCues, {
      cutRanges: cutRanges || [],
      requiresConcat: true,
    });
    return {
      format: fmt,
      cues: exportCues,
      video_path: previewMediaPath || videoPath,
      preview_media_path: previewMediaPath,
      export_schema_version: EXPORT_SCHEMA_VERSION,
      program_clips: programClipsToApiPayload(programClips),
      program_duration_sec: programDurationSec,
      program_master_path: programMasterPath,
      virtual_audio_map: [],
      requires_concat: false,
      export_time_axis: "program",
      cut_ranges: [],
      style: style || {},
    };
  }

  if (useBlocks && needsMedia && fmt !== "video") {
    const programClips = buildProgramClips(blocks, cutRanges || []);
    const mediaEndHint = Math.max(
      Number(blockOpts.mediaDurationSec) || 0,
      ...programClips.map((c) => Number(c.sourceEnd) || 0),
    );
    const derivedCuts = deriveCutRangesFromProgramClips(programClips, mediaEndHint);
    const virtualIndex = rebuildVirtualIndexFromBlocks(blocks);
    const virtualAudioMap = blocksToVirtualAudioMap(blocks, virtualIndex, {
      cutRanges: derivedCuts,
    });
    const exportCues = buildBlockStitchedProgramExportCues(blocks, virtualIndex, lastCues, {
      cutRanges: derivedCuts,
      requiresConcat: true,
    });
    return {
      format: fmt,
      cues: exportCues,
      video_path: previewMediaPath || videoPath,
      preview_media_path: previewMediaPath,
      virtual_audio_map: virtualAudioMap,
      requires_concat: false,
      export_time_axis: "program",
      cut_ranges: [],
      style: style || {},
    };
  }

  const virtualAudioMap = useBlocks
    ? blocksToVirtualAudioMap(blocks, rebuildVirtualIndexFromBlocks(blocks), { cutRanges })
    : buildVirtualAudioMap(lastCues, { cutRanges });
  const requiresConcat = false;
  const exportTimeAxis = "media";
  const exportCues = buildExportCueLines(lastCues);

  return {
    format: fmt,
    cues: exportCues,
    video_path: needsMedia ? previewMediaPath || videoPath : null,
    preview_media_path: needsMedia ? previewMediaPath : null,
    virtual_audio_map: virtualAudioMap,
    requires_concat: requiresConcat,
    export_time_axis: exportTimeAxis,
    cut_ranges: cutRanges || [],
    style: style || {},
  };
}

/** Electron export:by-format — 동일 payload로 sync 또는 async job. */
export const EXPORT_TEXT_FORMATS = TEXT_EXPORT_FORMATS;

/**
 * @param {string} fmt
 * @param {readonly object[]} cues
 * @param {readonly { start: number, end: number }[]} cutRanges
 * @param {object} style
 */
export function downloadTextExportLocally(fmt, cues, cutRanges, style) {
  const key = normalizeExportFormat(fmt);
  if (!TEXT_EXPORT_FORMATS.includes(key)) {
    throw new Error("로컬 다운로드는 srt/vtt/ass/txt만 지원합니다.");
  }
  const requiresConcat = computeRequiresConcatExport(cues, cutRanges);
  const exportCues = buildExportCuesForPayload(cues, cutRanges, requiresConcat);
  const content = buildTextExport(
    key,
    exportCues,
    requiresConcat ? [] : cutRanges,
    style,
  );
  const ext = { srt: ".srt", vtt: ".vtt", ass: ".ass", txt: ".txt" }[key];
  const mime =
    key === "vtt"
      ? "text/vtt;charset=utf-8"
      : "text/plain;charset=utf-8";
  const bom = key === "srt" || key === "txt" ? "\uFEFF" : "";
  const blob = new Blob([bom + content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `subtitles${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * @param {string} agentOrigin
 * @param {string} toolPrefix
 * @param {string} filePath
 */
export function buildDownloadUrl(agentOrigin, toolPrefix, filePath) {
  return `${agentOrigin}${toolPrefix}/download?file_path=${encodeURIComponent(filePath)}`;
}
