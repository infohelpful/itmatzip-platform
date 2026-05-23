/**
 * AutoSubtitle lineZoomWindow.ts — 카드·단어 칩·파형 줌 창.
 */

import { getCueWords } from "./subtitle-words.js";
import { wordIsDeleted } from "./shared/subtitles.js";

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
    visible.push({ start: w.start, end: w.end });
    storageIdx.push(i);
  }
  return { visible, storageIdx };
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
 * @param {{ mediaDurationSec?: number | null }} [options]
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
  const lo = Math.max(0, activeWordIndex - 1 - expL);
  const hi = Math.min(words.length - 1, activeWordIndex + 1 + expR);

  const lineStart = words[lo].start;
  const lineEnd = words[hi].end;

  const dur =
    options.mediaDurationSec != null &&
    Number.isFinite(options.mediaDurationSec) &&
    options.mediaDurationSec > 0
      ? options.mediaDurationSec
      : Number.POSITIVE_INFINITY;

  const span = Math.max(lineEnd - lineStart, 0.001);
  const pad = Math.max(0.04, span * 0.02);
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
 * @param {import("./subtitle-words.js").SubtitleCue} cue
 * @param {number} storageWordIndex
 * @param {number} [mediaDurationSec]
 */
export function computeWordContextForCue(cue, storageWordIndex, mediaDurationSec) {
  const { visible, storageIdx } = waveformContextWordEntries(cue);
  const visIdx = storageIdx.indexOf(storageWordIndex);
  if (visIdx < 0) return null;
  return computeWordContextWindow(visible, visIdx, 0, 0, {
    mediaDurationSec: mediaDurationSec ?? undefined,
  });
}

/**
 * @param {import("./subtitle-words.js").SubtitleCue} cue
 * @param {number} storageWordIndex
 */
export function getVisibleWordCenterIndex(cue, storageWordIndex) {
  const { storageIdx } = waveformContextWordEntries(cue);
  return storageIdx.indexOf(storageWordIndex);
}
