/**
 * AutoSubtitle App.tsx ??deleteWordAt, splitSubtitleAtWord, backspaceWordAt, ??
 */

import {
  displayTextFromSubtitleWords,
  lineTextIsUserLocked,
  subtitleLineEditDisplayText,
  visibleSubtitleWords,
  wordIsDeleted,
} from "./subtitles.js?v=24";
import { subtitleLinesAfterSoftDeleteWordRange } from "./virtual-timeline.js";
import { splitSubtitleLine, mergeEmptySubtitleWithPrevious } from "./subtitle-edit-ops.js";
import { timelineEditLog } from "./timeline-edit-log.js";

function textFromWords(line, words, fallback) {
  if (lineTextIsUserLocked(line)) {
    return subtitleLineEditDisplayText(line);
  }
  const t = displayTextFromSubtitleWords(words);
  return t.length > 0 ? t : fallback;
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
 * @param {number} wordIndex
 */
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

    const first = {
      ...cur,
      end: splitTime,
      words: leftWords,
      text: textFromWords(cur, leftWords, cur.text),
    };
    const second = {
      ...cur,
      start: splitTime,
      end: cur.end,
      words: rightWords,
      text: textFromWords(cur, rightWords, cur.text),
    };
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
      const visibleNext = nextWords.filter((w) => !wordIsDeleted(w));
      if (visibleNext.length === 0) {
        return [...prev.slice(0, cardIndex), ...prev.slice(cardIndex + 1)];
      }
      const nextStart = visibleNext[0].start;
      const nextEnd = visibleNext[visibleNext.length - 1].end;
      const updated = {
        ...cur,
        start: nextStart,
        end: Math.max(nextStart + 0.1, nextEnd),
        words: nextWords,
        text: textFromWords(cur, nextWords, cur.text),
      };
      return [...prev.slice(0, cardIndex), updated, ...prev.slice(cardIndex + 1)];
    }

    if (cardIndex === 0) return prev;
    const up = prev[cardIndex - 1];
    const upWords = up.words ?? [];
    const mergedWords = [...upWords, ...words];
    if (mergedWords.length === 0) return prev;
    const merged = {
      ...up,
      start: Math.min(up.start, mergedWords[0].start),
      end: Math.max(up.end, mergedWords[mergedWords.length - 1].end),
      words: mergedWords,
      text: textFromWords(up, mergedWords, up.text),
    };
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
        const visible = (updatedCard?.words ?? []).filter((w) => !wordIsDeleted(w));
        pendingMediaCuts = mediaCutsForVirtual;
        pendingHint = words[caretIndex]?.word ?? "";
        if (visible.length === 0) {
          return [...next.slice(0, cardIndex), ...next.slice(cardIndex + 1)];
        }
        return next;
      }

      if (caretIndex === words.length && cardIndex < prev.length - 1) {
        const nextLine = prev[cardIndex + 1];
        const mergedWords = [...words, ...(nextLine.words ?? [])];
        const merged = {
          ...cur,
          end: nextLine.end,
          words: mergedWords,
          text: textFromWords(cur, mergedWords, cur.text),
        };
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
      const visible = (updatedCard?.words ?? []).filter((w) => !wordIsDeleted(w));
      if (visible.length > 0) return next;
      return [...next.slice(0, cardIndex), ...next.slice(cardIndex + 1)];
    },
    {
      afterCommit: () => applyPendingVirtualMediaCuts(hub, pendingMediaCuts, pendingHint),
    },
  );
}
