/**
 * Line Mode v4 — Phase C reflow (TS mirror of line_mode_reflow.py).
 */

import {
  LINE_MODE_MAX_CHARS,
  LINE_MODE_MAX_DURATION_SEC,
  LINE_MODE_REFLOW_EARLY_MIN_CHAR_RATIO,
  LINE_MODE_REFLOW_GAP_MIN_SEC,
  LINE_MODE_REFLOW_GAP_MULTIPLIER,
  LINE_MODE_REFLOW_MIN_SPLIT_SCORE,
  LINE_MODE_REFLOW_THRESHOLD_EARLY,
} from "./config.js";
import { normalizeTextSSOT } from "./text-ssot.js";
import { createCueFromWords } from "./word-hints.js";

const JOSA_SET = new Set(["은", "는", "이", "가", "을", "를", "에", "의", "와", "과"]);

/**
 * @param {{ word?: string, text?: string }} w
 */
function token(w) {
  return String(w?.word ?? w?.text ?? "").trim();
}

/**
 * @param {readonly { word?: string, text?: string, hintStart?: number, hintEnd?: number, start?: number, end?: number }[]} window
 */
function charCountWindow(window) {
  return normalizeTextSSOT(window).length;
}

/**
 * @param {readonly { hintStart?: number, hintEnd?: number, start?: number, end?: number }[]} window
 */
function windowDuration(window) {
  if (!window.length) return 0;
  const hs = Number(window[0].hintStart ?? window[0].start) || 0;
  const he = Number(window[window.length - 1].hintEnd ?? window[window.length - 1].end) || hs;
  return Math.max(0, he - hs);
}

/**
 * @param {{ word?: string, text?: string, hintStart?: number, hintEnd?: number, start?: number, end?: number }} prev
 * @param {{ word?: string, text?: string, hintStart?: number, hintEnd?: number, start?: number, end?: number }} nextW
 */
export function calculateSplitScore(prev, nextW) {
  const prevEnd = Number(prev.hintEnd ?? prev.end) || 0;
  const nextStart = Number(nextW.hintStart ?? nextW.start) || 0;
  const gap = Math.max(0, nextStart - prevEnd);
  let score = Math.max(0, gap - LINE_MODE_REFLOW_GAP_MIN_SEC) * LINE_MODE_REFLOW_GAP_MULTIPLIER;
  const pt = token(prev);
  if (pt && ".?!".includes(pt[pt.length - 1])) score += 5;
  const nt = token(nextW);
  if (JOSA_SET.has(nt)) score -= 10;
  return score;
}

/**
 * @param {object[]} window
 * @param {number} maxChars
 */
function pickForcedCut(window, maxChars) {
  const n = window.length;
  if (n <= 1) return 0;
  let bestI = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < n - 1; i += 1) {
    const s = calculateSplitScore(window[i], window[i + 1]);
    if (s > bestScore || (s === bestScore && i > bestI)) {
      bestScore = s;
      bestI = i;
    }
  }
  if (bestScore >= LINE_MODE_REFLOW_MIN_SPLIT_SCORE) return bestI;
  for (let i = n - 1; i >= 0; i -= 1) {
    const left = window.slice(0, i + 1);
    if (charCountWindow(left) <= maxChars && windowDuration(left) <= LINE_MODE_MAX_DURATION_SEC) {
      return i;
    }
  }
  return 0;
}

/**
 * @param {readonly object[]} window
 * @param {number} maxChars
 */
function windowExceeds(window, maxChars) {
  if (!window.length) return false;
  if (window.length === 1) return charCountWindow(window) > maxChars;
  return charCountWindow(window) > maxChars || windowDuration(window) > LINE_MODE_MAX_DURATION_SEC;
}

/**
 * @param {object[]} window
 * @param {number} maxChars
 */
export function emitOneCue(window, maxChars) {
  const n = window.length;
  if (!n) return { cue: null, remain: [] };
  if (n === 1) {
    return {
      cue: createCueFromWords(/** @type {any} */ (window), {
        autoReflow: charCountWindow(window) > maxChars,
      }),
      remain: [],
    };
  }

  const scoreEarly = calculateSplitScore(window[n - 2], window[n - 1]);
  const chars = charCountWindow(window);
  if (
    n >= 2 &&
    scoreEarly >= LINE_MODE_REFLOW_THRESHOLD_EARLY &&
    chars >= maxChars * LINE_MODE_REFLOW_EARLY_MIN_CHAR_RATIO
  ) {
    const cut = n - 2;
    return {
      cue: createCueFromWords(/** @type {any} */ (window.slice(0, cut + 1))),
      remain: window.slice(cut + 1),
    };
  }

  const dur = windowDuration(window);
  if (chars <= maxChars && dur <= LINE_MODE_MAX_DURATION_SEC) {
    return { cue: createCueFromWords(/** @type {any} */ (window)), remain: [] };
  }

  const cut = pickForcedCut(window, maxChars);
  return {
    cue: createCueFromWords(/** @type {any} */ (window.slice(0, cut + 1)), {
      autoReflow: chars > maxChars || dur > LINE_MODE_MAX_DURATION_SEC,
    }),
    remain: window.slice(cut + 1),
  };
}

/**
 * @param {readonly object[]} words
 * @param {"horizontal" | "vertical"} [mode]
 */
export function groupWordsIntoCues(words, mode = "horizontal") {
  const maxChars = LINE_MODE_MAX_CHARS[mode] ?? LINE_MODE_MAX_CHARS.horizontal;
  /** @type {object[]} */
  const cues = [];
  /** @type {object[]} */
  let window = [];
  for (const w of words) {
    window.push(w);
    while (windowExceeds(window, maxChars)) {
      const { cue, remain } = emitOneCue(window, maxChars);
      if (!cue) break;
      cues.push(cue);
      window = remain;
      if (!window.length) break;
    }
  }
  if (window.length) cues.push(createCueFromWords(/** @type {any} */ (window)));
  return cues;
}

/**
 * @param {readonly { words?: object[], text?: string, start?: number, end?: number, flags?: { userMoved?: boolean } }[]} cues
 * @param {"horizontal" | "vertical"} [mode]
 */
export function reflowCuesSkipUserMoved(cues, mode = "horizontal") {
  /** @type {object[]} */
  const out = [];
  /** @type {object[]} */
  let pending = [];

  const flush = () => {
    if (!pending.length) return;
    out.push(...groupWordsIntoCues(pending, mode));
    pending = [];
  };

  for (const cue of cues || []) {
    if (cue?.flags?.userMoved === true) {
      flush();
      out.push(cue);
      continue;
    }
    const words = cue?.words;
    if (Array.isArray(words) && words.length) {
      pending.push(...words);
    } else {
      const text = String(cue?.text ?? "").trim();
      if (text && text !== "--") {
        pending.push({
          word: text,
          start: Number(cue?.start) || 0,
          end: Number(cue?.end) || 0,
        });
      }
    }
  }
  flush();
  return out;
}
