/**
 * ??? ???????shared SSOT ??? (?? import ?? ????).
 */

import {
  displayTextFromSubtitleWords,
  lineTextIsUserLocked,
  markLineTextUserEdited,
  parseSubtitleLines,
  storageWordIndexFromVisibleNonDeletedIndex,
  subtitleLineEditDisplayText,
  subtitleLineTextDiffersFromWords,
  syncAllSubtitleLinesFromWords,
  syncSubtitleLineFromWords,
  visibleSubtitleWords,
  wordIsDeleted,
  wordIsSilence,
} from "./shared/subtitles.js?v=24";
import { applyWordEdgeDrag, MIN_WORD_DURATION_SEC } from "./shared/subtitle-word-edge-drag.js?v=25";
import { syncAllCueWordSourcesFromEdit } from "./shared/dual-axis.js?v=2";
import { SILENCE_PLACEHOLDER_TEXT } from "./shared/word-contract.js";

export const MIN_WORD_SPAN_SEC = MIN_WORD_DURATION_SEC;

/**
 * @typedef {import("./shared/subtitles.js").SubtitleWord} SubtitleWord
 * @typedef {import("./shared/subtitles.js").SubtitleLine} SubtitleCue
 * @typedef {{ word: SubtitleWord, storageIndex: number }} VisibleWordSlot
 */

function snapSec(t) {
  return Math.round(t * 100) / 100;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * @param {Record<string, unknown>} w
 * @returns {SubtitleWord}
 */
export function normalizeWord(w) {
  return {
    start: Number(w.start) || 0,
    end: Number(w.end) || 0,
    word: String(w.word ?? w.text ?? "").trim(),
    is_silence: Boolean(w.is_silence ?? w.isSilence),
    isSilence: Boolean(w.is_silence ?? w.isSilence),
    is_deleted: Boolean(w.is_deleted ?? w.isDeleted),
    isDeleted: Boolean(w.is_deleted ?? w.isDeleted),
    merged_by_edge_trim: Boolean(w.merged_by_edge_trim ?? w.mergedByEdgeTrim),
    mergedByEdgeTrim: Boolean(w.merged_by_edge_trim ?? w.mergedByEdgeTrim),
    split_chain: typeof w.split_chain === "string" ? w.split_chain : w.splitChain,
    splitChain: typeof w.split_chain === "string" ? w.split_chain : w.splitChain,
  };
}

/**
 * @param {SubtitleCue} cue
 * @returns {SubtitleWord[]}
 */
export function getCueWords(cue) {
  if (!cue?.words?.length) return [];
  return cue.words.map((w) => normalizeWord(/** @type {Record<string, unknown>} */ (w)));
}

/** @param {SubtitleWord[]} words */
export function visibleWords(words) {
  return visibleSubtitleWords(words || []);
}

/** @param {SubtitleWord[]} words */
export function displayTextFromWords(words) {
  return displayTextFromSubtitleWords(words);
}

export { subtitleLineEditDisplayText, storageWordIndexFromVisibleNonDeletedIndex, parseSubtitleLines, markLineTextUserEdited, lineTextIsUserLocked };

/**
 * @param {SubtitleCue} cue
 * @returns {SubtitleCue}
 */
export function ensureCueWords(cue) {
  if (!cue) return cue;
  if (cue.is_silence || cue.isSilence) {
    const existing = getCueWords(cue);
    if (existing.length) {
      cue.words = existing;
      return cue;
    }
    const start = Number(cue.start) || 0;
    const end = Number(cue.end) || start;
    if (end > start + 1e-6) {
      cue.words = [
        {
          start,
          end,
          word: SILENCE_PLACEHOLDER_TEXT,
          is_silence: true,
          isSilence: true,
          is_deleted: false,
        },
      ];
    } else {
      cue.words = [];
    }
    return cue;
  }
  const existing = getCueWords(cue);
  if (existing.length) {
    cue.words = existing;
    return cue;
  }
  const text = String(cue.text || "").trim();
  if (!text) {
    cue.words = [];
    return cue;
  }
  const parts = text.split(/\s+/).filter(Boolean);
  const start = Number(cue.start) || 0;
  const end = Number(cue.end) || start;
  const dur = Math.max(0.05, end - start);
  const step = dur / parts.length;
  cue.words = parts.map((word, i) => ({
    start: start + i * step,
    end: start + (i + 1) * step,
    word,
    is_silence: false,
    is_deleted: false,
  }));
  return cue;
}

/**
 * @param {SubtitleCue} cue
 * @returns {SubtitleCue}
 */
export function syncCueFromWords(cue) {
  if (!cue) return cue;
  ensureCueWords(cue);
  return syncSubtitleLineFromWords(cue);
}

/**
 * @param {SubtitleCue[]} cues
 */
export function syncAllCuesFromWords(cues) {
  return syncAllSubtitleLinesFromWords(cues || []);
}

/**
 * @param {SubtitleCue} cue
 * @param {number} wordIndex
 */
export function tombstoneWord(cue, wordIndex) {
  ensureCueWords(cue);
  const words = getCueWords(cue);
  if (!words[wordIndex]) return cue;
  words[wordIndex].is_deleted = true;
  words[wordIndex].isDeleted = true;
  cue.words = words;
  return syncCueFromWords(cue);
}

/**
 * @param {SubtitleCue} cue
 */
export function rebuildWordsFromLineText(cue) {
  const text = String(cue.text || "").trim();
  const start = Number(cue.start) || 0;
  const end = Number(cue.end) || start;
  if (!text) {
    cue.words = [];
    return syncCueFromWords(cue);
  }
  const parts = text.split(/\s+/).filter(Boolean);
  const dur = Math.max(0.05, end - start);
  const step = dur / parts.length;
  cue.words = parts.map((word, i) => ({
    start: start + i * step,
    end: start + (i + 1) * step,
    word,
    is_silence: false,
    is_deleted: false,
  }));
  return syncCueFromWords(cue);
}

/**
 * ?? ??(textarea) ???? ?? ??? ??? words? ? ???? ??.
 * ?????????? SSOT ? words? ??? ? text? ?? ??? ????.
 *
 * @param {SubtitleCue} cue
 */
export function reconcileCueWordsToLineText(cue) {
  if (!cue || cue.is_silence || cue.isSilence) return cue;
  ensureCueWords(cue);
  if (lineTextIsUserLocked(cue)) {
    const next = { ...cue, text: String(cue.text ?? "") };
    markLineTextUserEdited(next);
    return rebuildWordsFromLineText(next);
  }
  if (!subtitleLineTextDiffersFromWords(cue)) return cue;
  const next = { ...cue, text: subtitleLineEditDisplayText(cue) };
  markLineTextUserEdited(next);
  return rebuildWordsFromLineText(next);
}

/**
 * @param {SubtitleCue[]} cues
 */
export function reconcileAllCuesWordsToLineText(cues) {
  return (cues || []).map((cue) => reconcileCueWordsToLineText(cue));
}

/**
 * @param {SubtitleCue} cue
 */
export function countVisibleWords(cue) {
  return visibleWords(getCueWords(cue)).length;
}

/**
 * @param {SubtitleCue} cue
 * @returns {VisibleWordSlot[]}
 */
export function visibleWordSlots(cue) {
  const words = getCueWords(cue);
  /** @type {VisibleWordSlot[]} */
  const slots = [];
  words.forEach((w, storageIndex) => {
    if (!wordIsDeleted(w) && !wordIsSilence(w) && w.word) {
      slots.push({ word: w, storageIndex });
    }
  });
  return slots;
}

/**
 * @param {SubtitleCue[]} cues
 * @param {number} lineIndex
 * @param {number} storageIndex
 * @param {'start' | 'end'} edge
 * @param {number} newSec
 * @param {boolean} commitMode
 */
export function applyCueWordEdgeDrag(cues, lineIndex, storageIndex, edge, newSec, commitMode = false) {
  const result = applyWordEdgeDrag({
    subtitles: cues,
    target: { lineIndex, wordIndex: storageIndex },
    edge,
    newSec,
    commitMode,
  });
  return syncAllCueWordSourcesFromEdit(result.subtitles);
}

/**
 * @param {SubtitleCue} cue
 * @param {number} storageIndex
 */
function slotContext(cue, storageIndex) {
  const slots = visibleWordSlots(cue);
  const idx = slots.findIndex((s) => s.storageIndex === storageIndex);
  const lineStart = Number(cue.start) || 0;
  const lineEnd = Number(cue.end) || lineStart;
  const prevEnd = idx > 0 ? slots[idx - 1].word.end : lineStart;
  const nextStart = idx >= 0 && idx < slots.length - 1 ? slots[idx + 1].word.start : lineEnd;
  return { slots, idx, prevEnd, nextStart, lineStart, lineEnd };
}

/**
 * @param {SubtitleCue} cue
 * @param {number} storageIndex
 * @param {number} newStart
 */
/**
 * @param {SubtitleCue[]} cues
 * @param {number} cueIndex
 * @param {number} storageIndex
 * @param {number} newStart
 * @param {boolean} [commitMode]
 */
export function setWordStartInCues(cues, cueIndex, storageIndex, newStart, commitMode = false) {
  const updated = applyCueWordEdgeDrag(cues, cueIndex, storageIndex, "start", newStart, commitMode);
  return updated[cueIndex];
}

/**
 * @param {SubtitleCue[]} cues
 * @param {number} cueIndex
 * @param {number} storageIndex
 * @param {number} newEnd
 * @param {boolean} [commitMode]
 */
export function setWordEndInCues(cues, cueIndex, storageIndex, newEnd, commitMode = false) {
  const updated = applyCueWordEdgeDrag(cues, cueIndex, storageIndex, "end", newEnd, commitMode);
  return updated[cueIndex];
}

/**
 * @param {SubtitleCue} cue
 * @param {number} storageIndex
 * @param {number} deltaSec
 */
export function moveWordByDelta(cue, storageIndex, deltaSec) {
  ensureCueWords(cue);
  const words = getCueWords(cue);
  const w = words[storageIndex];
  if (!w || wordIsDeleted(w)) return cue;
  const dur = w.end - w.start;
  const { prevEnd, nextStart } = slotContext(cue, storageIndex);
  let start = snapSec(w.start + deltaSec);
  start = clamp(start, prevEnd, nextStart - dur);
  w.start = start;
  w.end = snapSec(start + dur);
  cue.words = words;
  return syncCueFromWords(cue);
}

