/**
 * AutoSubtitle exportCuePipeline.ts
 */

import { subtitleCueLinesForExport } from "./subtitles.js?v=24";

/** @param {readonly import("./subtitles.js").SubtitleLine[]} lines */
export function buildExportCueLines(lines) {
  return subtitleCueLinesForExport(lines);
}
