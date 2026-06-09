/**
 * AutoSubtitle App.tsx ??deleteWordAt, splitSubtitleAtWord, backspaceWordAt, ??
 */

import {
  displayTextFromSubtitleWords,
  lineTextIsUserLocked,
  markLineTextUserEdited,
  clearLineTextUserEdited,
  subtitleLineEditDisplayText,
  subtitleLineTextAfterWordMutation,
  syncSubtitleLineFromWords,
  visibleSubtitleWords,
  wordIsDeleted,
  wordIsSilence,
} from "./subtitles.js?v=24";
import { subtitleLinesAfterSoftDeleteWordRange } from "./virtual-timeline.js";
import { splitSubtitleLine, mergeEmptySubtitleWithPrevious } from "./subtitle-edit-ops.js";
import { timelineEditLog } from "./timeline-edit-log.js";
import {
  reorderCuesByListInsert,
  reorderCuesByListPosition,
} from "./subtitle-list-indices.js?v=6";
import { reorderCuesWithRelocate } from "./subtitle-reorder-relocate.js?v=1";
import { bumpListableCueIndicesCache } from "./subtitle-list-playback.js?v=11";

function textFromWords(line, words, fallback) {
  const t = displayTextFromSubtitleWords(words);
  return t.length > 0 ? t : fallback;
}

/** @param {readonly import("./subtitles.js").SubtitleLine[]} lines @param {number} cardIndex */
function linesWithoutEmptySpeechCue(lines, cardIndex) {
  const card = lines[cardIndex];
  if (!card || card.is_silence || card.isSilence) return lines;
  if (visibleSubtitleWords(card.words ?? []).length > 0) return lines;
  const words = card.words ?? [];
  const hasVisibleSilenceChip = words.some(
    (w) => !wordIsDeleted(w) && wordIsSilence(w),
  );
  if (hasVisibleSilenceChip) return lines;
  return [...lines.slice(0, cardIndex), ...lines.slice(cardIndex + 1)];
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
 * @param {{ start: number, end: number }[]} cuts
 * @param {string} [textHint]
 */
function applyPendingVirtualMediaCuts(hub, cuts, textHint = "") {
  if (!cuts?.length) return;
  for (const r of cuts) {
    hub.mergeVirtualTimelineDeleted(r, textHint);
  }
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {number} index
 * @param {number} cursorPos
 */
export function splitSubtitleAt(hub, index, cursorPos) {
  timelineEditLog("split", { index, cursorPos });
  hub.applySubtitleChange((prev) => splitSubtitleLine(prev, index, cursorPos));
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {number} index
 */
export function mergeEmptySubtitleAt(hub, index) {
  hub.applySubtitleChange((prev) => mergeEmptySubtitleWithPrevious(prev, index) ?? prev);
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {number} index
 */
export function deleteSubtitleLineAt(hub, index) {
  timelineEditLog("delete-line", { index });
  hub.applySubtitleChange((prev) => {
    if (index < 0 || index >= prev.length) return prev;
    return [...prev.slice(0, index), ...prev.slice(index + 1)];
  });
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {readonly number[]} indices cue indices, any order
 */
export function deleteSubtitleLinesAt(hub, indices) {
  const unique = [...new Set(indices)].filter((i) => i >= 0).sort((a, b) => b - a);
  if (!unique.length) return;
  timelineEditLog("delete-lines", { indices: unique });
  hub.applySubtitleChange((prev) => {
    let next = prev;
    for (const i of unique) {
      if (i < 0 || i >= next.length) continue;
      next = [...next.slice(0, i), ...next.slice(i + 1)];
    }
    return next;
  });
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {number} fromListPos
 * @param {number} toListPos
 */
export function reorderSubtitleLinesByListPosition(hub, fromListPos, toListPos) {
  timelineEditLog("reorder-line", { fromListPos, toListPos });
  hub.applySubtitleChange((prev) => reorderCuesByListPosition(prev, fromListPos, toListPos));
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {number} fromListPos
 * @param {number} insertBeforePos
 */
export function reorderSubtitleLinesByListInsert(hub, fromListPos, insertBeforePos) {
  timelineEditLog("reorder-line-insert", { fromListPos, insertBeforePos });
  const result = reorderCuesWithRelocate(hub.cues, fromListPos, insertBeforePos);
  if (!result.ok) return result;
  hub.applySubtitleChange(() => result.cues);
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
  hub.applySubtitleChange((prev) => {
    if (cueIndex < 0 || cueIndex >= prev.length) return prev;
    const parts = explodeCueByWordBreaks(prev[cueIndex], breakAfterStorageIndices);
    if (parts.length <= 1) return prev;
    return [...prev.slice(0, cueIndex), ...parts, ...prev.slice(cueIndex + 1)];
  });
}

export function splitSubtitleAtWord(hub, index, wordIndex) {
  hub.applySubtitleChange((prev) => {
    if (index < 0 || index >= prev.length) return prev;
    const cur = prev[index];
    const words = cur.words ?? [];
    if (wordIndex <= 0 || wordIndex >= words.length) return prev;

    const leftWords = words.slice(0, wordIndex);
    const rightWords = words.slice(wordIndex);
    if (leftWords.length === 0 || rightWords.length === 0) return prev;

    const leftEndRaw = leftWords[leftWords.length - 1].end;
    const rightStartRaw = rightWords[0].start;
    let splitTime = (leftEndRaw + rightStartRaw) / 2;
    if (!Number.isFinite(splitTime)) splitTime = rightStartRaw;
    splitTime = Math.max(cur.start + 0.1, Math.min(cur.end - 0.1, splitTime));
    if (!(splitTime > cur.start && splitTime < cur.end)) return prev;

    const locked = lineTextIsUserLocked(cur);
    const { left: lockedLeft, right: lockedRight } = locked
      ? splitLockedLineTextAtStorageIndex(cur, wordIndex)
      : { left: "", right: "" };
    const leftText = locked ? lockedLeft : textFromWords(cur, leftWords, cur.text);
    const rightText = locked ? lockedRight : textFromWords(cur, rightWords, cur.text);

    let first = {
      ...cur,
      end: splitTime,
      words: leftWords,
    };
    let second = {
      ...cur,
      start: splitTime,
      end: cur.end,
      words: rightWords,
    };
    if (locked) {
      first = withLineEditText(first, leftText);
      second = withLineEditText(second, rightText);
    } else {
      clearLineTextUserEdited(first);
      clearLineTextUserEdited(second);
      first.text = leftText;
      second.text = rightText;
      syncSubtitleLineFromWords(first);
      syncSubtitleLineFromWords(second);
    }
    return [...prev.slice(0, index), first, second, ...prev.slice(index + 1)];
  });
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {number} cardIndex
 * @param {number} wordIndex storage index
 */
export function backspaceWordAt(hub, cardIndex, wordIndex) {
  hub.gapFillWhenBuildingVrew = false;
  hub.applySubtitleChange((prev) => {
    if (cardIndex < 0 || cardIndex >= prev.length) return prev;
    const cur = prev[cardIndex];
    const words = cur.words ?? [];
    if (wordIndex < 0 || wordIndex >= words.length) return prev;

    if (wordIndex > 0) {
      const nextWords = words.map((w, i) =>
        i === wordIndex - 1 ? { ...w, is_deleted: true, isDeleted: true } : w,
      );
      const visibleNext = visibleSubtitleWords(nextWords);
      if (visibleNext.length === 0) {
        return linesWithoutEmptySpeechCue(prev, cardIndex);
      }
      const nextStart = visibleNext[0].start;
      const nextEnd = visibleNext[visibleNext.length - 1].end;
      const fromWords = textFromWords(cur, nextWords, cur.text);
      const updated = {
        ...cur,
        start: nextStart,
        end: Math.max(nextStart + 0.1, nextEnd),
        words: nextWords,
        text: subtitleLineTextAfterWordMutation(cur, nextWords, fromWords),
      };
      return [...prev.slice(0, cardIndex), updated, ...prev.slice(cardIndex + 1)];
    }

    if (cardIndex === 0) return prev;
    const up = prev[cardIndex - 1];
    const upWords = up.words ?? [];
    const mergedWords = [...upWords, ...words];
    if (mergedWords.length === 0) return prev;
    const merged = withLineEditText(
      {
        ...up,
        start: Math.min(up.start, mergedWords[0].start),
        end: Math.max(up.end, mergedWords[mergedWords.length - 1].end),
        words: mergedWords,
      },
      lineTextIsUserLocked(up) || lineTextIsUserLocked(cur)
        ? mergeLockedLineTexts(up, cur)
        : textFromWords(up, mergedWords, up.text),
    );
    return [...prev.slice(0, cardIndex - 1), merged, ...prev.slice(cardIndex + 1)];
  });
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {number} cardIndex
 * @param {number} caretIndex storage caret (0..words.length)
 */
export function deleteWordAt(hub, cardIndex, caretIndex) {
  hub.gapFillWhenBuildingVrew = false;
  /** @type {{ start: number, end: number }[]} */
  let pendingMediaCuts = [];
  let pendingHint = "";

  hub.applySubtitleChange(
    (prev) => {
      if (cardIndex < 0 || cardIndex >= prev.length) return prev;
      const cur = prev[cardIndex];
      const words = cur.words ?? [];
      if (caretIndex < 0 || caretIndex > words.length) return prev;

      if (caretIndex < words.length) {
        const result = subtitleLinesAfterSoftDeleteWordRange(
          prev,
          cardIndex,
          caretIndex,
          caretIndex + 1,
        );
        if (!result) return prev;
        const { lines: next, mediaCutsForVirtual } = result;
        const updatedCard = next[cardIndex];
        const visible = visibleSubtitleWords(updatedCard?.words ?? []);
        pendingMediaCuts = mediaCutsForVirtual;
        pendingHint = words[caretIndex]?.word ?? "";
        if (visible.length === 0) {
          return linesWithoutEmptySpeechCue(next, cardIndex);
        }
        return next;
      }

      if (caretIndex === words.length && cardIndex < prev.length - 1) {
        const nextLine = prev[cardIndex + 1];
        const mergedWords = [...words, ...(nextLine.words ?? [])];
        const merged = withLineEditText(
          {
            ...cur,
            end: nextLine.end,
            words: mergedWords,
          },
          lineTextIsUserLocked(cur) || lineTextIsUserLocked(nextLine)
            ? mergeLockedLineTexts(cur, nextLine)
            : textFromWords(cur, mergedWords, cur.text),
        );
        return [...prev.slice(0, cardIndex), merged, ...prev.slice(cardIndex + 2)];
      }

      return prev;
    },
    {
      afterCommit: () => applyPendingVirtualMediaCuts(hub, pendingMediaCuts, pendingHint),
    },
  );
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {number} cardIndex
 * @param {number} fromWordIndex
 * @param {number} toWordIndex exclusive
 */
export function deleteWordRangeAt(hub, cardIndex, fromWordIndex, toWordIndex) {
  hub.gapFillWhenBuildingVrew = false;
  /** @type {{ start: number, end: number }[]} */
  let pendingMediaCuts = [];
  let pendingHint = "";

  hub.applySubtitleChange(
    (prev) => {
      if (cardIndex < 0 || cardIndex >= prev.length) return prev;
      const words = prev[cardIndex].words ?? [];
      const start = Math.max(0, Math.min(fromWordIndex, toWordIndex));
      const end = Math.min(words.length, Math.max(fromWordIndex, toWordIndex));
      if (start >= end) return prev;

      const result = subtitleLinesAfterSoftDeleteWordRange(prev, cardIndex, start, end);
      if (!result) return prev;
      const { lines: next, mediaCutsForVirtual } = result;
      pendingMediaCuts = mediaCutsForVirtual;
      pendingHint = words[start]?.word ?? "";
      const updatedCard = next[cardIndex];
      const visible = visibleSubtitleWords(updatedCard?.words ?? []);
      if (visible.length > 0) return next;
      return linesWithoutEmptySpeechCue(next, cardIndex);
    },
    {
      afterCommit: () => applyPendingVirtualMediaCuts(hub, pendingMediaCuts, pendingHint),
    },
  );
}
