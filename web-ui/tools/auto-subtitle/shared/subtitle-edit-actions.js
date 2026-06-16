/**
 * AutoSubtitle App.tsx ??deleteWordAt, splitSubtitleAtWord, backspaceWordAt, ??
 */

import { LINE_MODE_ONLY } from "./line-mode/config.js?v=1";

import {
  displayTextFromSubtitleWords,
  lineTextIsUserLocked,
  markLineTextUserEdited,
  clearLineTextUserEdited,
  subtitleLineEditDisplayText,
  syncSubtitleLineFromWords,
  wordIsDeleted,
  wordIsSilence,
} from "./subtitles.js?v=24";
import { timelineEditLog } from "./timeline-edit-log.js";
import { bumpListableCueIndicesCache } from "./subtitle-list-playback.js?v=11";

function textFromWords(line, words, fallback) {
  const t = displayTextFromSubtitleWords(words);
  return t.length > 0 ? t : fallback;
}

/** @param {import("./subtitles.js").SubtitleLine} line @param {number} storageSplitIndex */
function splitLockedLineTextAtStorageIndex(line, storageSplitIndex) {
  const full = subtitleLineEditDisplayText(line);
  const words = line.words ?? [];
  let leftVisCount = 0;
  for (let i = 0; i < storageSplitIndex && i < words.length; i += 1) {
    const w = words[i];
    if (wordIsDeleted(w) || wordIsSilence(w)) continue;
    if (!String(w.word ?? "").trim()) continue;
    leftVisCount += 1;
  }
  const tokens = full.split(/\s+/).filter(Boolean);
  if (leftVisCount <= 0) return { left: "", right: full };
  if (leftVisCount >= tokens.length) return { left: full, right: "" };
  return {
    left: tokens.slice(0, leftVisCount).join(" "),
    right: tokens.slice(leftVisCount).join(" "),
  };
}

/** @param {import("./subtitles.js").SubtitleLine} line @param {string} text */
function withLineEditText(line, text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    const next = { ...line, text: "" };
    clearLineTextUserEdited(next);
    return next;
  }
  const next = { ...line, text: trimmed };
  if (lineTextIsUserLocked(line)) markLineTextUserEdited(next);
  return next;
}

/** @param {...import("./subtitles.js").SubtitleLine} lines */
function mergeLockedLineTexts(...lines) {
  return lines
    .map((line) => (lineTextIsUserLocked(line) ? subtitleLineEditDisplayText(line) : line?.text ?? ""))
    .map((t) => String(t).trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {number} index
 * @param {number} cursorPos
 */
export function splitSubtitleAt(hub, index, cursorPos) {
  timelineEditLog("split", { index, cursorPos });
  hub.splitBlockAtTextCursor(index, cursorPos);
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {number} index
 */
export function mergeEmptySubtitleAt(hub, index) {
  hub.mergeEmptyBlockAt(index);
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {number} index
 */
export function deleteSubtitleLineAt(hub, index) {
  timelineEditLog("delete-line", { index });
  hub.deleteBlockAt(index);
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {readonly number[]} indices cue indices, any order
 */
export function deleteSubtitleLinesAt(hub, indices) {
  const unique = [...new Set(indices)].filter((i) => i >= 0);
  if (!unique.length) return;
  timelineEditLog("delete-lines", { indices: unique });
  hub.deleteBlocksAt(unique);
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {number} fromListPos
 * @param {number} toListPos
 */
export function reorderSubtitleLinesByListPosition(hub, fromListPos, toListPos) {
  timelineEditLog("reorder-line", { fromListPos, toListPos });
  const result = hub.reorderBlocksByListPosition(fromListPos, toListPos);
  bumpListableCueIndicesCache();
  return result;
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {number} fromListPos
 * @param {number} insertBeforePos
 */
export function reorderSubtitleLinesByListInsert(hub, fromListPos, insertBeforePos) {
  timelineEditLog("reorder-line-insert", { fromListPos, insertBeforePos });
  const result = hub.reorderBlocksByListInsert(fromListPos, insertBeforePos);
  bumpListableCueIndicesCache();
  return result;
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {number} index
 * @param {number} wordIndex
 */
/**
 * 한 cue의 words 를 break_after(포함) 기준으로 여러 cue 로 분할. 칩 단위 유지.
 * @param {import("./subtitles.js").SubtitleLine} cue
 * @param {number[]} breakAfterStorageIndices
 * @returns {import("./subtitles.js").SubtitleLine[]}
 */
export function explodeCueByWordBreaks(cue, breakAfterStorageIndices) {
  const words = cue.words ?? [];
  if (!words.length) return [cue];

  const breaks = [...new Set(breakAfterStorageIndices)]
    .filter((i) => Number.isFinite(i) && i >= 0 && i < words.length - 1)
    .sort((a, b) => a - b);

  if (!breaks.length) return [cue];

  const chunks = [];
  let start = 0;
  for (const end of breaks) {
    if (end >= start) {
      chunks.push(words.slice(start, end + 1));
      start = end + 1;
    }
  }
  if (start < words.length) chunks.push(words.slice(start));
  if (chunks.length <= 1) return [cue];

  return chunks
    .filter((chunk) => chunk.length > 0)
    .map((chunkWords) => {
      let startSec = chunkWords[0].start;
      let endSec = chunkWords[chunkWords.length - 1].end;
      if (!Number.isFinite(startSec)) startSec = cue.start;
      if (!Number.isFinite(endSec)) endSec = cue.end;
      const text = textFromWords(cue, chunkWords, "");
      return withLineEditText(
        {
          ...cue,
          start: startSec,
          end: Math.max(startSec + 0.05, endSec),
          words: chunkWords,
          lineTextUserEdited: false,
          line_text_user_edited: false,
        },
        text,
      );
    });
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {number} cueIndex
 * @param {number[]} breakAfterStorageIndices
 */
export function applyCueWordAutoAlign(hub, cueIndex, breakAfterStorageIndices) {
  hub.splitBlockByWordBreaks(cueIndex, breakAfterStorageIndices);
}

export function splitSubtitleAtWord(hub, index, wordIndex) {
  if (LINE_MODE_ONLY) {
    return hub.splitLineCueAtWordIndex(index, wordIndex);
  }
  return hub.splitBlockAtWordIndex(index, wordIndex);
}

/**
 * Line Mode — 아래 줄을 위 줄로 합침 (단어칩 삭제 없음).
 *
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {number} upperCueIndex
 */
export function mergeLineBelowIntoAbove(hub, upperCueIndex) {
  if (upperCueIndex < 0 || upperCueIndex >= hub.cues.length - 1) return false;
  const cur = hub.cues[upperCueIndex];
  const nextLine = hub.cues[upperCueIndex + 1];
  if (!cur || !nextLine) return false;
  timelineEditLog("merge-line-below", { upperCueIndex });
  const mergedText =
    lineTextIsUserLocked(cur) || lineTextIsUserLocked(nextLine)
      ? mergeLockedLineTexts(cur, nextLine)
      : undefined;
  hub.mergeBlocksAt(upperCueIndex, upperCueIndex + 1, mergedText);
  return true;
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {number} cardIndex
 * @param {number} wordIndex storage index
 */
export function backspaceWordAt(hub, cardIndex, wordIndex) {
  hub.gapFillWhenBuildingVrew = false;
  timelineEditLog("backspace-word", { cardIndex, wordIndex });
  const cur = hub.cues[cardIndex];
  const words = cur?.words ?? [];
  if (wordIndex < 0 || wordIndex >= words.length) return;

  if (wordIndex > 0) {
    hub.softDeleteWordRangeAt(cardIndex, wordIndex - 1, wordIndex);
    return;
  }

  if (cardIndex === 0) return;
  const up = hub.cues[cardIndex - 1];
  const mergedText =
    lineTextIsUserLocked(up) || lineTextIsUserLocked(cur)
      ? mergeLockedLineTexts(up, cur)
      : undefined;
  hub.mergeBlocksAt(cardIndex - 1, cardIndex, mergedText);
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {number} cardIndex
 * @param {number} caretIndex storage caret (0..words.length)
 */
export function deleteWordAt(hub, cardIndex, caretIndex) {
  hub.gapFillWhenBuildingVrew = false;
  timelineEditLog("delete-word", { cardIndex, caretIndex });
  const cur = hub.cues[cardIndex];
  const words = cur?.words ?? [];
  if (cardIndex < 0 || cardIndex >= hub.blocks.length) return;
  if (caretIndex < 0 || caretIndex > words.length) return;

  if (caretIndex < words.length) {
    hub.softDeleteWordRangeAt(cardIndex, caretIndex, caretIndex + 1);
    return;
  }

  if (caretIndex === words.length && cardIndex < hub.blocks.length - 1) {
    const nextLine = hub.cues[cardIndex + 1];
    const mergedText =
      lineTextIsUserLocked(cur) || lineTextIsUserLocked(nextLine)
        ? mergeLockedLineTexts(cur, nextLine)
        : undefined;
    hub.mergeBlocksAt(cardIndex, cardIndex + 1, mergedText);
  }
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {number} cardIndex
 * @param {number} fromWordIndex
 * @param {number} toWordIndex exclusive
 */
export function deleteWordRangeAt(hub, cardIndex, fromWordIndex, toWordIndex) {
  hub.gapFillWhenBuildingVrew = false;
  timelineEditLog("delete-word-range", { cardIndex, fromWordIndex, toWordIndex });
  const words = hub.cues[cardIndex]?.words ?? [];
  const start = Math.max(0, Math.min(fromWordIndex, toWordIndex));
  const end = Math.min(words.length, Math.max(fromWordIndex, toWordIndex));
  if (start >= end) return;
  hub.softDeleteWordRangeAt(cardIndex, start, end);
}
