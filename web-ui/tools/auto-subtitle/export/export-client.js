/**
 * AutoSubtitle export:by-format — 웹 보내기 클라이언트 (IPC 대체).
 */

import { buildTextExport, TEXT_EXPORT_FORMATS } from "../shared/export-subtitle-formats.js";
import { buildExportCueLines } from "../shared/export-cue-pipeline.js?v=4";
import { anyCueRelocated } from "../shared/dual-axis.js?v=1";
import {
  blocksRequireConcatExport,
  blocksToVirtualAudioMap,
  buildBlockStitchedProgramExportCues,
} from "../shared/blocks-to-export.js?v=1";
import {
  buildStitchedProgramExportCues,
  buildVirtualAudioMap,
  isSourceStartMonotonic,
} from "../shared/virtual-audio-map.js?v=2";

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
 * @param {readonly object[]} lastCues
 * @param {readonly { start: number, end: number }[]} cutRanges
 */
export function computeRequiresConcatExport(lastCues, cutRanges) {
  const map = buildVirtualAudioMap(lastCues, { cutRanges });
  const cuts = cutRanges || [];
  return !(
    !anyCueRelocated(lastCues) &&
    cuts.length === 0 &&
    isSourceStartMonotonic(map)
  );
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
 * @param {{ previewMediaPath?: string | null, videoPath?: string | null }} [media]
 * @param {{ blocks?: readonly object[], virtualIndex?: readonly object[] }} [blockOpts]
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
  const blocks = blockOpts.blocks;
  const virtualIndex = blockOpts.virtualIndex;
  const useBlocks =
    Array.isArray(blocks) &&
    blocks.length > 0 &&
    Array.isArray(virtualIndex) &&
    virtualIndex.length > 0;

  const requiresConcat = useBlocks
    ? blocksRequireConcatExport(blocks, virtualIndex, cutRanges)
    : computeRequiresConcatExport(lastCues, cutRanges);
  const virtualAudioMap = useBlocks
    ? blocksToVirtualAudioMap(blocks, virtualIndex, { cutRanges })
    : buildVirtualAudioMap(lastCues, { cutRanges });
  const exportCues = useBlocks
    ? buildBlockStitchedProgramExportCues(blocks, virtualIndex, lastCues, {
        cutRanges,
        requiresConcat,
      })
    : buildExportCuesForPayload(lastCues, cutRanges, requiresConcat);

  return {
    format: fmt,
    cues: exportCues,
    video_path: needsMedia ? previewMediaPath || videoPath : null,
    preview_media_path: needsMedia ? previewMediaPath : null,
    virtual_audio_map: virtualAudioMap,
    requires_concat: requiresConcat,
    export_time_axis: requiresConcat ? "stitched_program" : "media",
    cut_ranges: requiresConcat ? [] : cutRanges || [],
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
