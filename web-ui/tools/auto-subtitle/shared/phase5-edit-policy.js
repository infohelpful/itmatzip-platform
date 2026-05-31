/**
 * AutoSubtitle phase5EditPolicy.ts ???? ??gap-fill ??.
 */

import { displayTextFromSubtitleWords, lineTextIsUserLocked, subtitleLineEditDisplayText } from "./subtitles.js?v=24";
import { visibleSubtitleWords } from "./subtitles.js?v=20";

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
      text: lineTextIsUserLocked(line)
        ? subtitleLineEditDisplayText(line)
        : displayTextFromSubtitleWords(words),
    });
  }
  return out;
}
