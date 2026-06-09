/**
 * V36 이중 축 — 물리 source 앵커 vs virtual(display) 시간.
 */

const EPS = 1e-6;

/**
 * @param {object | null | undefined} cue
 */
export function getCueSourceStart(cue) {
  if (!cue) return 0;
  const s = Number(cue.sourceStart ?? cue.source_start);
  if (Number.isFinite(s)) return s;
  return Number(cue.start) || 0;
}

/**
 * @param {object | null | undefined} cue
 */
export function getCueSourceEnd(cue) {
  if (!cue) return 0;
  const e = Number(cue.sourceEnd ?? cue.source_end);
  if (Number.isFinite(e)) return e;
  return Number(cue.end) || 0;
}

/**
 * @param {object | null | undefined} word
 * @param {object} cue
 */
export function getWordSourceStart(word, cue) {
  if (!word) return getCueSourceStart(cue);
  const s = Number(word.sourceStart ?? word.source_start);
  if (Number.isFinite(s)) return s;
  return Number(word.start) || 0;
}

/**
 * @param {object | null | undefined} word
 * @param {object} cue
 */
export function getWordSourceEnd(word, cue) {
  if (!word) return getCueSourceEnd(cue);
  const e = Number(word.sourceEnd ?? word.source_end);
  if (Number.isFinite(e)) return e;
  return Number(word.end) || 0;
}

/**
 * @param {object | null | undefined} cue
 */
export function isRelocated(cue) {
  if (!cue) return false;
  const ss = cue.sourceStart ?? cue.source_start;
  const se = cue.sourceEnd ?? cue.source_end;
  if (!Number.isFinite(Number(ss)) || !Number.isFinite(Number(se))) return false;
  return (
    Math.abs(Number(cue.start) - Number(ss)) > EPS ||
    Math.abs(Number(cue.end) - Number(se)) > EPS
  );
}

/**
 * @param {readonly object[]} cues
 */
export function anyCueRelocated(cues) {
  for (const c of cues || []) {
    if (isRelocated(c)) return true;
  }
  return false;
}

/**
 * @param {import("./subtitles.js").SubtitleWord} w
 */
function anchorWordSourceIfMissing(w) {
  if (!Number.isFinite(Number(w.sourceStart ?? w.source_start))) {
    w.sourceStart = w.start;
    w.source_start = w.start;
  }
  if (!Number.isFinite(Number(w.sourceEnd ?? w.source_end))) {
    w.sourceEnd = w.end;
    w.source_end = w.end;
  }
}

/**
 * @param {import("./subtitles.js").SubtitleLine} line
 */
function anchorLineSourceIfMissing(line) {
  if (!line) return line;
  if (!Number.isFinite(Number(line.sourceStart ?? line.source_start))) {
    line.sourceStart = line.start;
    line.source_start = line.start;
  }
  if (!Number.isFinite(Number(line.sourceEnd ?? line.source_end))) {
    line.sourceEnd = line.end;
    line.source_end = line.end;
  }
  if (line.words?.length) {
    for (const w of line.words) anchorWordSourceIfMissing(w);
  }
  return line;
}

/**
 * 구버전·추출 직후 — source 앵커 1회 백필 (이미 있으면 preserve).
 *
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 */
export function anchorSourceTimesIfMissing(lines) {
  return (lines || []).map((line) => anchorLineSourceIfMissing({ ...line, words: line.words ? [...line.words] : undefined }));
}

/**
 * @param {import("./subtitles.js").SubtitleLine} line
 * @param {number} deltaSec
 */
export function shiftCueVirtualTimes(line, deltaSec) {
  const d = Number(deltaSec) || 0;
  if (Math.abs(d) < EPS) return line;
  const out = { ...line };
  out.start = (Number(out.start) || 0) + d;
  out.end = (Number(out.end) || 0) + d;
  if (out.words?.length) {
    out.words = out.words.map((w) => ({
      ...w,
      start: (Number(w.start) || 0) + d,
      end: (Number(w.end) || 0) + d,
    }));
  }
  return out;
}

/**
 * relocated cue — 미디어 시각 → 가상(칩) 시각.
 *
 * @param {object} cue
 * @param {number} sourceSec
 */
export function sourceSecToVirtualSec(cue, sourceSec) {
  const src0 = getCueSourceStart(cue);
  const v0 = Number(cue.start) || 0;
  const t = Number(sourceSec);
  if (!Number.isFinite(t)) return v0;
  if (!isRelocated(cue)) return t;
  return v0 + (t - src0);
}

/**
 * @param {object} cue
 * @param {number} virtualSec
 */
export function virtualSecToSourceSec(cue, virtualSec) {
  const src0 = getCueSourceStart(cue);
  const v0 = Number(cue.start) || 0;
  const t = Number(virtualSec);
  if (!Number.isFinite(t)) return src0;
  if (!isRelocated(cue)) return t;
  return src0 + (t - v0);
}
