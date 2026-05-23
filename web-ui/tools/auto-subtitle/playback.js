/**
 * 재생 헤드 · 컷 스킵 · 활성 자막/단어 선택.
 */

import { mergeCutRanges } from "./shared/timeline-collapse.js?v=17";
import { collectDeletedWordSkipRangesFromLines } from "./shared/virtual-timeline.js?v=17";
import { getCueWords, visibleWords } from "./subtitle-words.js?v=18";
import { wordIsDeleted } from "./shared/subtitles.js?v=17";

export const SKIP_CUT_TAIL_SEC = 0.02;

export { mergeCutRanges };

/**
 * @param {number} timeSec
 * @param {{ start: number, end: number }[]} ranges
 */
export function skipCutRangeAt(timeSec, ranges) {
  const merged = mergeCutRanges(ranges);
  let t = timeSec;
  for (let step = 0; step < 64; step += 1) {
    let jumped = false;
    for (const r of merged) {
      if (t >= r.start && t < r.end) {
        t = r.end + SKIP_CUT_TAIL_SEC;
        jumped = true;
        break;
      }
    }
    if (!jumped) break;
  }
  return t;
}

/**
 * @param {Array<{ start: number, end: number, words?: unknown[], is_silence?: boolean }>} cues
 */
export function collectDeletedWordSkipRanges(cues) {
  return collectDeletedWordSkipRangesFromLines(cues);
}

/**
 * @param {Array<{ start: number, end: number }>} hardCuts
 * @param {Array<{ start: number, end: number, words?: unknown[], is_silence?: boolean }>} cues
 */
export function buildPlaybackSkipRanges(hardCuts, cues) {
  return mergeCutRanges([...(hardCuts || []), ...collectDeletedWordSkipRanges(cues)]);
}

/**
 * @param {{ is_silence?: boolean, isSilence?: boolean, text?: string, start?: number, end?: number }} c
 */
function cueIsPlayableListRow(c) {
  if (!c) return false;
  if (c.is_silence || c.isSilence) {
    const start = Number(c.start) || 0;
    const end = Number(c.end) || 0;
    return end > start + 1e-6;
  }
  return Boolean(String(c.text || "").trim());
}

/**
 * @param {Array<{ start: number, end: number, text?: string, is_silence?: boolean }>} cues
 * @param {number} t
 */
export function pickActiveCueIndex(cues, t) {
  let found = -1;
  for (let i = 0; i < (cues || []).length; i += 1) {
    const c = cues[i];
    if (!cueIsPlayableListRow(c)) continue;
    if (t >= c.start && t < c.end) found = i;
  }
  return found;
}

/**
 * 재생 중 이전 활성 줄 힌트로 국소 탐색 — 겹치는 구간은 뒤 줄 우선 (pickActiveCueIndex 와 동일).
 * @param {Array<{ start: number, end: number, text?: string, is_silence?: boolean }>} cues
 * @param {number} t
 * @param {number} [hint]
 */
export function pickActiveCueIndexWithHint(cues, t, hint = -1) {
  const list = cues || [];
  const n = list.length;
  if (n === 0) return -1;

  if (hint >= 0 && hint < n) {
    const h = list[hint];
    if (cueIsPlayableListRow(h) && t >= h.start && t < h.end) return hint;

    let found = -1;
    const lo = Math.max(0, hint - 4);
    const hi = Math.min(n - 1, hint + 8);
    for (let i = lo; i <= hi; i += 1) {
      const c = list[i];
      if (!cueIsPlayableListRow(c)) continue;
      if (t >= c.start && t < c.end) found = i;
    }
    if (found >= 0) return found;
  }

  return pickActiveCueIndex(list, t);
}

/**
 * @param {object} cue
 * @param {number} t
 * @returns {number} storage index or -1
 */
export function pickActiveWordIndex(cue, t) {
  if (!cue) return -1;
  const words = getCueWords(cue);
  let found = -1;
  for (let wi = 0; wi < words.length; wi += 1) {
    const w = words[wi];
    if (wordIsDeleted(w)) continue;
    const s = Number(w.start);
    const e = Number(w.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (t >= s && t < e) found = wi;
  }
  return found;
}
