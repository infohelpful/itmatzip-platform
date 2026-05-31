/**
 * AutoSubtitle subtitleEditOps.ts
 */

import {
  displayTextFromSubtitleWords,
  lineTextIsUserLocked,
  markLineTextUserEdited,
  subtitleLineEditDisplayText,
} from "./subtitles.js?v=24";

const MIN_SEGMENT_SEC = 0.05;

function textFromWords(line, words, fallback) {
  if (lineTextIsUserLocked(line)) {
    return subtitleLineEditDisplayText(line);
  }
  const t = displayTextFromSubtitleWords(words);
  return t.length > 0 ? t : fallback;
}

/**
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 * @param {number} index
 * @param {number} cursorPos
 */
export function splitSubtitleLine(lines, index, cursorPos) {
  if (index < 0 || index >= lines.length) return [...lines];
  const line = lines[index];
  const { start, end, text } = line;
  const dur = end - start;
  if (!(dur > 0) || !Number.isFinite(dur)) return [...lines];

  const clampedCursor = Math.max(0, Math.min(Math.floor(cursorPos), String(text || "").length));
  const ratio = text.length === 0 ? 0.5 : clampedCursor / text.length;
  let splitTime = start + dur * ratio;
  splitTime = Math.min(Math.max(splitTime, start + MIN_SEGMENT_SEC), end - MIN_SEGMENT_SEC);
  if (!(splitTime > start && splitTime < end)) splitTime = start + dur / 2;

  if (line.words?.length) {
    const leftWords = [];
    const rightWords = [];
    for (const w of line.words) {
      const mid = (w.start + w.end) / 2;
      if (mid <= splitTime) leftWords.push(w);
      else rightWords.push(w);
    }
    const first = {
      ...line,
      start,
      end: splitTime,
      text: lineTextIsUserLocked(line)
        ? text.slice(0, clampedCursor)
        : textFromWords(line, leftWords, text.slice(0, clampedCursor)),
      words: leftWords,
    };
    const second = {
      ...line,
      start: splitTime,
      end,
      text: lineTextIsUserLocked(line)
        ? text.slice(clampedCursor)
        : textFromWords(line, rightWords, text.slice(clampedCursor)),
      words: rightWords,
    };
    markLineTextUserEdited(first);
    markLineTextUserEdited(second);
    return [...lines.slice(0, index), first, second, ...lines.slice(index + 1)];
  }

  const left = text.slice(0, clampedCursor);
  const right = text.slice(clampedCursor);
  const first = { start, end: splitTime, text: left, lineTextUserEdited: true, line_text_user_edited: true };
  const second = { start: splitTime, end, text: right, lineTextUserEdited: true, line_text_user_edited: true };
  return [
    ...lines.slice(0, index),
    first,
    second,
    ...lines.slice(index + 1),
  ];
}

/**
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 * @param {number} index
 */
export function mergeEmptySubtitleWithPrevious(lines, index) {
  if (index <= 0 || index >= lines.length) return null;
  const cur = lines[index];
  if (String(cur.text || "").length > 0) return null;
  const prevLine = lines[index - 1];
  const mergedWords =
    prevLine.words || cur.words ? [...(prevLine.words ?? []), ...(cur.words ?? [])] : undefined;
  const text =
    mergedWords?.length
      ? textFromWords(prevLine, mergedWords, prevLine.text)
      : prevLine.text;
  const merged = {
    start: prevLine.start,
    end: cur.end,
    text,
    ...(mergedWords ? { words: mergedWords } : {}),
  };
  return [...lines.slice(0, index - 1), merged, ...lines.slice(index + 1)];
}
