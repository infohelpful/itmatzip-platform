/**
 * AutoSubtitle phase5EditPolicy.ts — 편집 후 gap-fill 정책.
 */

import { displayTextFromSubtitleWords } from "./subtitles.js";
import { visibleSubtitleWords } from "./subtitles.js";

export const NO_AUTO_GAP_FILL_AFTER_EDIT = true;

export function shouldFillGapsWhenBuildingVrewRows(gapFillWhenBuildingVrew, subtitlesContainDeletedWords) {
  if (subtitlesContainDeletedWords) return false;
  return gapFillWhenBuildingVrew;
}

/**
 * @param {import("./subtitles.js").SubtitleLine[]} lines
 */
export function removeSilenceWordsFromSubtitleLines(lines) {
  const out = [];
  for (const line of lines || []) {
    const words = (line.words ?? []).filter((w) => !(w.is_silence || w.isSilence));
    if (words.length === 0) continue;
    const vis = visibleSubtitleWords(words);
    if (vis.length === 0) continue;
    const start = Math.min(...vis.map((w) => w.start));
    const end = Math.max(...vis.map((w) => w.end));
    out.push({
      ...line,
      start,
      end,
      words,
      text: displayTextFromSubtitleWords(words),
    });
  }
  return out;
}
