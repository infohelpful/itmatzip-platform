/**
 * Line Mode v4 — cue block move / resize / Enter split.
 */

import { LINE_MODE_MIN_CUE_SEC } from "./config.js";
import { findNearestSnap } from "./snap-engine.js";
import { normalizeTextSSOT } from "./text-ssot.js";
import { createCueFromWords } from "./word-hints.js";
import { wordIsDeleted, wordIsSilence } from "../subtitles.js";
import { splitWordTextAtMediaCut } from "../subtitle-word-text-split.js";

const CUE_SPLIT_MARGIN_SEC = 0.04;
const MIN_IN_WORD_SPLIT_SEC = 0.01;

/**
 * @param {readonly import("../subtitles.js").SubtitleWord[]} words
 */
function visibleStorageBounds(words) {
  let first = -1;
  let last = -1;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (wordIsDeleted(w) || wordIsSilence(w)) continue;
    if (first < 0) first = i;
    last = i;
  }
  return { first, last };
}

/**
 * 줄 start/end와 단어 타임라인 정합 — syncSubtitleLineFromWords가 되돌리지 않게.
 *
 * @param {readonly import("../subtitles.js").SubtitleWord[]} words
 * @param {number} start
 * @param {number} end
 */
function mapWordsToCueBounds(words, start, end) {
  const { first, last } = visibleStorageBounds(words);
  return (words || []).map((w, i) => {
    if (wordIsDeleted(w) || wordIsSilence(w)) return { ...w };
    const hs0 = Number(w.hintStart ?? w.start) || 0;
    const he0 = Number(w.hintEnd ?? w.end) || hs0;
    let hs = Math.max(hs0, start);
    let he = Math.min(he0, end);
    if (i === first) hs = start;
    if (i === last) he = end;
    if (he < hs) he = hs;
    return { ...w, start: hs, end: he, hintStart: hs, hintEnd: he };
  });
}

/**
 * @param {import("../subtitles.js").SubtitleLine} cue
 * @param {number} deltaSec
 */
export function moveCueBlock(cue, deltaSec) {
  const d = Number(deltaSec) || 0;
  const start = (Number(cue.start) || 0) + d;
  const end = (Number(cue.end) || 0) + d;
  const words = (cue.words || []).map((w) => {
    const hs = (Number(w.hintStart ?? w.start) || 0) + d;
    const he = (Number(w.hintEnd ?? w.end) || 0) + d;
    return {
      ...w,
      start: hs,
      end: he,
      hintStart: hs,
      hintEnd: he,
    };
  });
  return {
    ...cue,
    start,
    end,
    words,
    flags: { ...(cue.flags || {}), userMoved: true, autoReflow: false },
  };
}

/**
 * @param {import("../subtitles.js").SubtitleLine} cue
 * @param {number} newStart
 * @param {number} mediaDurationSec
 */
export function resizeCueStart(cue, newStart, mediaDurationSec) {
  const end = Number(cue.end) || 0;
  const maxStart = Math.max(0, end - LINE_MODE_MIN_CUE_SEC);
  const start = Math.min(Math.max(0, newStart), maxStart);
  void mediaDurationSec;
  const words = mapWordsToCueBounds(cue.words || [], start, end);
  return {
    ...cue,
    start,
    end,
    words,
    flags: { ...(cue.flags || {}), userMoved: true, autoReflow: false },
  };
}

/**
 * @param {import("../subtitles.js").SubtitleLine} cue
 * @param {number} newEnd
 * @param {number} mediaDurationSec
 */
export function resizeCueEnd(cue, newEnd, mediaDurationSec) {
  const start = Number(cue.start) || 0;
  const cap = mediaDurationSec > 0 ? mediaDurationSec : newEnd;
  const end = Math.min(Math.max(start + LINE_MODE_MIN_CUE_SEC, newEnd), cap);
  const words = mapWordsToCueBounds(cue.words || [], start, end);
  return {
    ...cue,
    start,
    end,
    words,
    flags: { ...(cue.flags || {}), userMoved: true, autoReflow: false },
  };
}

/**
 * Block drag — snap start only; preserve duration.
 *
 * @param {import("../subtitles.js").SubtitleLine} cue
 * @param {number} newStart
 * @param {{ dragStartSnaps?: readonly { t: number }[], alt?: boolean }} snap
 * @param {number} mediaDurationSec
 */
export function moveCueBlockWithSnap(cue, newStart, snap, mediaDurationSec) {
  const oldStart = Number(cue.start) || 0;
  const oldEnd = Number(cue.end) || 0;
  const dur = Math.max(LINE_MODE_MIN_CUE_SEC, oldEnd - oldStart);
  const snapped = findNearestSnap(newStart, snap?.dragStartSnaps || [], undefined, snap?.alt);
  const clampedStart = Math.max(0, Math.min(snapped, Math.max(0, mediaDurationSec - dur)));
  return moveCueBlock(cue, clampedStart - oldStart);
}

/**
 * @param {import("../subtitles.js").SubtitleLine} cue
 * @param {number} splitIndex storage index — right chunk starts here
 */
export function splitCueByEnter(cue, splitIndex) {
  const words = cue.words || [];
  if (splitIndex <= 0 || splitIndex >= words.length) return [cue];
  const dur = (Number(cue.end) || 0) - (Number(cue.start) || 0);
  if (dur < 0.08) return [cue];
  const prev = words[splitIndex - 1];
  const next = words[splitIndex];
  if (prev?.is_silence || prev?.isSilence || next?.is_silence || next?.isSilence) return [cue];

  const prevEnd = Number(prev.hintEnd ?? prev.end) || 0;
  const nextStart = Number(next.hintStart ?? next.start) || 0;
  let mid = (prevEnd + nextStart) / 2;
  const lo = (Number(cue.start) || 0) + 0.04;
  const hi = (Number(cue.end) || 0) - 0.04;
  mid = Math.min(Math.max(mid, lo), hi);

  const leftWords = words.slice(0, splitIndex).map((w) => ({ ...w }));
  const rightWords = words.slice(splitIndex).map((w) => ({ ...w }));
  if (leftWords.length) {
    const lw = leftWords[leftWords.length - 1];
    lw.end = mid;
    lw.hintEnd = mid;
  }
  if (rightWords.length) {
    const rw = rightWords[0];
    rw.start = mid;
    rw.hintStart = mid;
  }

  const cue1 = {
    ...cue,
    end: mid,
    text: normalizeTextSSOT(leftWords),
    words: leftWords,
    flags: { userMoved: false, autoReflow: false },
  };
  const cue2 = {
    ...cue,
    start: mid,
    text: normalizeTextSSOT(rightWords),
    words: rightWords,
    flags: { userMoved: false, autoReflow: false },
  };
  return [cue1, cue2];
}

/**
 * Line Mode — 재생(자르기) 라인 시각에서 줄 분할.
 * 단어 경계 또는 단어 내부(텍스트·타임 분할)를 지원.
 *
 * @param {import("../subtitles.js").SubtitleLine} cue
 * @param {number} splitMediaSec
 */
export function splitCueAtMediaSec(cue, splitMediaSec) {
  const words = (cue.words || []).map((w) => ({ ...w }));
  if (words.length < 1) return [cue];

  const cueStart = Number(cue.start) || 0;
  const cueEnd = Number(cue.end) || cueStart;
  if (cueEnd - cueStart < 0.08) return [cue];

  const lo = cueStart + CUE_SPLIT_MARGIN_SEC;
  const hi = cueEnd - CUE_SPLIT_MARGIN_SEC;
  let t = Number(splitMediaSec);
  if (!Number.isFinite(t)) return [cue];
  t = Math.min(Math.max(t, lo), hi);
  if (!(t > lo && t < hi)) return [cue];

  let splitIndex = -1;

  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (wordIsDeleted(w) || wordIsSilence(w)) continue;

    const a = Math.min(Number(w.start) || 0, Number(w.end) || 0);
    const b = Math.max(Number(w.start) || 0, Number(w.end) || 0);

    if (b <= t + 1e-6) continue;

    if (a >= t - 1e-6) {
      splitIndex = i;
      break;
    }

    if (
      b - a > MIN_IN_WORD_SPLIT_SEC * 2 &&
      t > a + MIN_IN_WORD_SPLIT_SEC &&
      t < b - MIN_IN_WORD_SPLIT_SEC
    ) {
      const { left: leftText, right: rightText } = splitWordTextAtMediaCut(w.word, a, b, t);
      const leftFinal = leftText.length > 0 ? leftText : w.word;
      const rightFinal = rightText.length > 0 ? rightText : w.word;
      const parentChain = w.split_chain ?? w.splitChain ?? "";
      const leftChain = `${parentChain}1`;
      const rightChain = `${parentChain}2`;
      words.splice(
        i,
        1,
        {
          ...w,
          start: a,
          end: t,
          hintStart: a,
          hintEnd: t,
          word: leftFinal,
          split_chain: leftChain,
          splitChain: leftChain,
        },
        {
          ...w,
          start: t,
          end: b,
          hintStart: t,
          hintEnd: b,
          word: rightFinal,
          split_chain: rightChain,
          splitChain: rightChain,
        },
      );
      splitIndex = i + 1;
      break;
    }

    splitIndex = i + 1;
    break;
  }

  if (splitIndex <= 0 || splitIndex >= words.length) return [cue];

  const prev = words[splitIndex - 1];
  const next = words[splitIndex];
  if (wordIsSilence(prev) || wordIsSilence(next)) return [cue];

  const leftWords = words.slice(0, splitIndex).map((w) => ({ ...w }));
  const rightWords = words.slice(splitIndex).map((w) => ({ ...w }));
  if (!leftWords.length || !rightWords.length) return [cue];

  if (leftWords.length) {
    const lw = leftWords[leftWords.length - 1];
    lw.end = t;
    lw.hintEnd = t;
  }
  if (rightWords.length) {
    const rw = rightWords[0];
    rw.start = t;
    rw.hintStart = t;
  }

  const cue1 = {
    ...cue,
    end: t,
    text: normalizeTextSSOT(leftWords),
    words: leftWords,
    flags: { userMoved: false, autoReflow: false },
  };
  const cue2 = {
    ...cue,
    start: t,
    text: normalizeTextSSOT(rightWords),
    words: rightWords,
    flags: { userMoved: false, autoReflow: false },
  };
  return [cue1, cue2];
}

/**
 * @param {import("../subtitles.js").SubtitleLine} cue
 * @param {"start" | "end" | "block"} handle
 * @param {number} targetSec
 * @param {{ onsets?: readonly { t: number }[], silencePads?: readonly { t: number }[], valleys?: readonly { t: number }[], dragStartSnaps?: readonly { t: number }[], alt?: boolean }} snap
 * @param {number} mediaDurationSec
 */
export function applyCueTimingDrag(cue, handle, targetSec, snap, mediaDurationSec) {
  if (snap?.alt) {
    if (handle === "block") return moveCueBlock(cue, targetSec - (Number(cue.start) || 0));
    if (handle === "start") return resizeCueStart(cue, targetSec, mediaDurationSec);
    return resizeCueEnd(cue, targetSec, mediaDurationSec);
  }
  if (handle === "block") return moveCueBlockWithSnap(cue, targetSec, snap, mediaDurationSec);
  if (handle === "start") {
    const snapped = findNearestSnap(targetSec, snap?.onsets || []);
    return resizeCueStart(cue, snapped, mediaDurationSec);
  }
  const endSnapGrid = [...(snap?.silencePads || []), ...(snap?.valleys || [])].sort(
    (a, b) => a.t - b.t,
  );
  const snapped = findNearestSnap(targetSec, endSnapGrid);
  return resizeCueEnd(cue, snapped, mediaDurationSec);
}
