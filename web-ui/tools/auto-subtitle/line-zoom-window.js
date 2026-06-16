/**
 * AutoSubtitle lineZoomWindow.ts — 카드·단어 칩·파형 줌 창.
 */

import { getCueWords } from "./subtitle-words.js";
import { lineIsSilenceOnlyCue, wordIsDeleted } from "./shared/subtitles.js";
import { getWordSourceEnd, getWordSourceStart } from "./shared/dual-axis.js?v=3";
import {
  firstSpokenStorageIndex,
  lastSpokenStorageIndex,
} from "./shared/cross-cue-boundary-sync.js?v=5";

/**
 * 파형 컨텍스트용 가시 단어 — 삭제만 제외, 무음(`--`) 포함 (Electron `activeWords` 와 동일).
 *
 * @param {import("./subtitle-words.js").SubtitleCue} cue
 */
export function waveformContextWordEntries(cue) {
  const all = getCueWords(cue);
  /** @type {{ start: number, end: number }[]} */
  const visible = [];
  /** @type {number[]} */
  const storageIdx = [];
  for (let i = 0; i < all.length; i += 1) {
    const w = all[i];
    if (wordIsDeleted(w)) continue;
    visible.push({
      start: getWordSourceStart(w, cue),
      end: getWordSourceEnd(w, cue),
    });
    storageIdx.push(i);
  }
  return { visible, storageIdx };
}

/**
 * @param {readonly object[]} cues
 * @param {number} cueIndex
 * @returns {number}
 */
function prevNonSilenceCueIndex(cues, cueIndex) {
  if (!Array.isArray(cues) || cueIndex <= 0) return -1;
  for (let i = cueIndex - 1; i >= 0; i -= 1) {
    const c = cues[i];
    if (!c || lineIsSilenceOnlyCue(c)) continue;
    const { visible } = waveformContextWordEntries(c);
    if (visible.length) return i;
  }
  return -1;
}

/**
 * @param {readonly object[]} cues
 * @param {number} cueIndex
 * @returns {number}
 */
function nextNonSilenceCueIndex(cues, cueIndex) {
  if (!Array.isArray(cues) || cueIndex < 0 || cueIndex >= cues.length - 1) return -1;
  for (let i = cueIndex + 1; i < cues.length; i += 1) {
    const c = cues[i];
    if (!c || lineIsSilenceOnlyCue(c)) continue;
    const { visible } = waveformContextWordEntries(c);
    if (visible.length) return i;
  }
  return -1;
}

/**
 * @param {number} lineStart
 * @param {number} lineEnd
 * @param {{ mediaDurationSec?: number | null, clipTrailingToLineEnd?: boolean, clipLeadingToLineStart?: boolean }} [options]
 */
export function computeLineZoomWindowFromCardBounds(lineStart, lineEnd, options = {}) {
  const lineSpan = Math.max(lineEnd - lineStart, 0.001);
  const pad = Math.max(0.08, lineSpan * 0.04);
  const dur =
    options.mediaDurationSec != null &&
    Number.isFinite(options.mediaDurationSec) &&
    options.mediaDurationSec > 0
      ? options.mediaDurationSec
      : Number.POSITIVE_INFINITY;
  const clipEnd = options.clipTrailingToLineEnd === true;
  const clipLead = options.clipLeadingToLineStart === true;
  let windowStart = clipLead ? Math.max(0, lineStart) : Math.max(0, lineStart - pad);
  let windowEnd = clipEnd ? Math.min(dur, lineEnd) : Math.min(dur, lineEnd + pad);
  if (clipEnd && windowEnd <= windowStart + 1e-6) {
    windowStart = Math.max(0, lineStart);
    windowEnd = Math.min(dur, lineEnd);
  }
  if (windowEnd <= windowStart + 1e-6) {
    windowEnd = Math.min(dur, windowStart + 0.12);
  }
  const span = Math.max(windowEnd - windowStart, 1e-6);
  return { lineStart, lineEnd, windowStart, windowEnd, span };
}

/**
 * @param {readonly { start: number, end: number }[]} words
 * @param {{ mediaDurationSec?: number | null, clipTrailingToLineEnd?: boolean, clipLeadingToLineStart?: boolean }} [options]
 */
export function computeLineZoomWindow(words, options = {}) {
  if (!words?.length) return null;
  const lineStart = Math.min(...words.map((w) => w.start));
  const lineEnd = Math.max(...words.map((w) => w.end));
  return computeLineZoomWindowFromCardBounds(lineStart, lineEnd, options);
}

/**
 * @param {{ windowStart: number, span: number }} win
 * @param {number} wordStart
 * @param {number} wordEnd
 */
export function wordChipSlotStyle(win, wordStart, wordEnd) {
  const leftPct = ((wordStart - win.windowStart) / win.span) * 100;
  const widthPct = ((wordEnd - wordStart) / win.span) * 100;
  return {
    left: `${Math.max(0, leftPct)}%`,
    width: `${Math.max(0.35, widthPct)}%`,
  };
}

/**
 * @param {readonly { start: number, end: number }[]} words
 * @param {number} activeWordIndex visible words 배열 기준
 * @param {number} [expandLeft]
 * @param {number} [expandRight]
 * @param {{ mediaDurationSec?: number | null, crossLineBounds?: { prevWord?: { start: number, end: number }, nextWord?: { start: number, end: number } } | null, firstSpokenVisIdx?: number, lastSpokenVisIdx?: number }} [options]
 */
export function computeWordContextWindow(
  words,
  activeWordIndex,
  expandLeft = 0,
  expandRight = 0,
  options = {},
) {
  if (!words?.length) return null;
  if (activeWordIndex < 0 || activeWordIndex >= words.length) return null;

  const expL = Math.max(0, Math.floor(expandLeft));
  const expR = Math.max(0, Math.floor(expandRight));
  const firstSpokenVisIdx = options.firstSpokenVisIdx ?? -1;
  const lastSpokenVisIdx = options.lastSpokenVisIdx ?? -1;

  let lo = Math.max(0, activeWordIndex - 1 - expL);
  let hi = Math.min(words.length - 1, activeWordIndex + 1 + expR);
  if (lastSpokenVisIdx >= 0 && activeWordIndex === lastSpokenVisIdx) {
    hi = activeWordIndex;
  }
  if (firstSpokenVisIdx >= 0 && activeWordIndex === firstSpokenVisIdx) {
    lo = activeWordIndex;
  }

  let lineStart = words[lo].start;
  let lineEnd = words[hi].end;

  const cross = options.crossLineBounds;
  if (cross?.prevWord && firstSpokenVisIdx >= 0 && activeWordIndex === firstSpokenVisIdx) {
    lineStart = Math.min(lineStart, Math.min(cross.prevWord.start, cross.prevWord.end));
  }
  if (cross?.nextWord && lastSpokenVisIdx >= 0 && activeWordIndex === lastSpokenVisIdx) {
    lineEnd = Math.max(lineEnd, cross.nextWord.start, cross.nextWord.end);
  }

  const dur =
    options.mediaDurationSec != null &&
    Number.isFinite(options.mediaDurationSec) &&
    options.mediaDurationSec > 0
      ? options.mediaDurationSec
      : Number.POSITIVE_INFINITY;

  const span = Math.max(lineEnd - lineStart, 0.001);
  const pad = cross?.prevWord || cross?.nextWord
    ? Math.max(0.22, span * 0.18)
    : Math.max(0.08, span * 0.04);
  let windowStart = Math.max(0, lineStart - pad);
  let windowEnd = Math.min(dur, lineEnd + pad);
  if (windowEnd <= windowStart + 1e-6) {
    windowEnd = Math.min(dur, windowStart + 0.12);
  }
  const finalEnd = windowEnd;
  return {
    lineStart,
    lineEnd,
    windowStart,
    windowEnd: finalEnd,
    span: Math.max(finalEnd - windowStart, 1e-6),
  };
}

/**
 * 줄 경계 spoken 쌍 — 윗줄 마지막·아랫줄 첫 spoken이 **동일** viewWin/lineBounds 사용.
 * (파형 픽셀↔미디어 매핑이 같아야 경계 오른쪽·아래 첫 단어가 같은 오디오로 보임)
 *
 * @param {readonly object[]} cues
 * @param {number} cueIndex
 * @param {number} storageWordIndex
 * @param {number} [mediaDurationSec]
 */
export function computeCoupledCrossLineViewWindow(cues, cueIndex, storageWordIndex, mediaDurationSec) {
  const cue = Array.isArray(cues) ? cues[cueIndex] : null;
  if (!cue) return null;

  const firstSpoken = firstSpokenStorageIndex(cue);
  const lastSpoken = lastSpokenStorageIndex(cue);

  /** @type {'upper_end' | 'lower_start' | null} */
  let role = null;
  /** @type {object | null} */
  let prevCue = null;
  /** @type {object | null} */
  let nextCue = null;
  /** @type {object | null} */
  let prevLastWord = null;
  /** @type {object | null} */
  let nextFirstWord = null;

  if (lastSpoken >= 0 && storageWordIndex === lastSpoken) {
    const ni = nextNonSilenceCueIndex(cues, cueIndex);
    if (ni < 0) return null;
    nextCue = cues[ni];
    const frwi = firstSpokenStorageIndex(nextCue);
    if (frwi < 0) return null;
    nextFirstWord = nextCue.words?.[frwi];
    if (!nextFirstWord || wordIsDeleted(nextFirstWord)) return null;
    prevCue = cue;
    prevLastWord = cue.words?.[lastSpoken];
    if (!prevLastWord || wordIsDeleted(prevLastWord)) return null;
    role = "upper_end";
  } else if (firstSpoken >= 0 && storageWordIndex === firstSpoken) {
    const pi = prevNonSilenceCueIndex(cues, cueIndex);
    if (pi < 0) return null;
    prevCue = cues[pi];
    const plwi = lastSpokenStorageIndex(prevCue);
    if (plwi < 0) return null;
    prevLastWord = prevCue.words?.[plwi];
    if (!prevLastWord || wordIsDeleted(prevLastWord)) return null;
    nextCue = cue;
    nextFirstWord = cue.words?.[firstSpoken];
    if (!nextFirstWord || wordIsDeleted(nextFirstWord)) return null;
    role = "lower_start";
  } else {
    return null;
  }

  const prevStart = getWordSourceStart(prevLastWord, prevCue);
  const prevEnd = getWordSourceEnd(prevLastWord, prevCue);
  const nextStart = getWordSourceStart(nextFirstWord, nextCue);
  const nextEnd = getWordSourceEnd(nextFirstWord, nextCue);

  const lineStart = Math.min(prevStart, nextStart);
  const lineEnd = Math.max(prevEnd, nextEnd);
  const dur =
    mediaDurationSec != null &&
    Number.isFinite(mediaDurationSec) &&
    mediaDurationSec > 0
      ? mediaDurationSec
      : Number.POSITIVE_INFINITY;
  const span = Math.max(lineEnd - lineStart, 0.001);
  const pad = Math.max(0.22, span * 0.18);
  let windowStart = Math.max(0, lineStart - pad);
  let windowEnd = Math.min(dur, lineEnd + pad);
  if (windowEnd <= windowStart + 1e-6) {
    windowEnd = Math.min(dur, windowStart + 0.12);
  }

  return {
    lineStart,
    lineEnd,
    windowStart,
    windowEnd,
    span: Math.max(windowEnd - windowStart, 1e-6),
    crossLineBounds: {
      prevWord: { start: prevStart, end: prevEnd },
      nextWord: { start: nextStart, end: nextEnd },
      coupled: true,
      role,
    },
  };
}

/**
 * @param {readonly object[]} cues
 * @param {number} cueIndex
 * @param {number} storageWordIndex
 * @param {number} [mediaDurationSec]
 */
export function computeWordContextForCue(cues, cueIndex, storageWordIndex, mediaDurationSec) {
  const coupled = computeCoupledCrossLineViewWindow(
    cues,
    cueIndex,
    storageWordIndex,
    mediaDurationSec,
  );
  if (coupled) return coupled;

  const cue = Array.isArray(cues) ? cues[cueIndex] : null;
  if (!cue) return null;
  const { visible, storageIdx } = waveformContextWordEntries(cue);
  const visIdx = storageIdx.indexOf(storageWordIndex);
  if (visIdx < 0) return null;

  const firstSpoken = firstSpokenStorageIndex(cue);
  const lastSpoken = lastSpokenStorageIndex(cue);

  /** @type {{ prevWord?: { start: number, end: number }, nextWord?: { start: number, end: number } } | null} */
  let crossLineBounds = null;
  if (Array.isArray(cues) && cues.length > 0 && Number.isFinite(cueIndex)) {
    /** @type {{ prevWord?: { start: number, end: number }, nextWord?: { start: number, end: number } }} */
    const bounds = {};
    if (firstSpoken >= 0 && storageWordIndex === firstSpoken) {
      const pi = prevNonSilenceCueIndex(cues, cueIndex);
      if (pi >= 0) {
        const prevCue = cues[pi];
        const prevWords = prevCue?.words;
        const plwi = lastSpokenStorageIndex(prevCue);
        const pw = plwi >= 0 ? prevWords?.[plwi] : null;
        if (pw && !wordIsDeleted(pw)) {
          bounds.prevWord = {
            start: getWordSourceStart(pw, prevCue),
            end: getWordSourceEnd(pw, prevCue),
          };
        }
      }
    }
    if (lastSpoken >= 0 && storageWordIndex === lastSpoken) {
      const ni = nextNonSilenceCueIndex(cues, cueIndex);
      if (ni >= 0) {
        const nextCue = cues[ni];
        const nextWords = nextCue?.words;
        const frwi = firstSpokenStorageIndex(nextCue);
        const nw = frwi >= 0 ? nextWords?.[frwi] : null;
        if (nw && !wordIsDeleted(nw)) {
          bounds.nextWord = {
            start: getWordSourceStart(nw, nextCue),
            end: getWordSourceEnd(nw, nextCue),
          };
        }
      }
    }
    if (bounds.prevWord || bounds.nextWord) crossLineBounds = bounds;
  }

  const win = computeWordContextWindow(visible, visIdx, 0, 0, {
    mediaDurationSec: mediaDurationSec ?? undefined,
    crossLineBounds,
    firstSpokenVisIdx: firstSpoken >= 0 ? storageIdx.indexOf(firstSpoken) : -1,
    lastSpokenVisIdx: lastSpoken >= 0 ? storageIdx.indexOf(lastSpoken) : -1,
  });
  if (!win) return null;
  return crossLineBounds ? { ...win, crossLineBounds } : win;
}

/**
 * @param {import("./subtitle-words.js").SubtitleCue} cue
 * @param {number} storageWordIndex
 */
export function getVisibleWordCenterIndex(cue, storageWordIndex) {
  const { storageIdx } = waveformContextWordEntries(cue);
  return storageIdx.indexOf(storageWordIndex);
}
