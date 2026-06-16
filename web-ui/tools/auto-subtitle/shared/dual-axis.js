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

/**
 * virtual(edit) → source 앵커 — block SSOT·파형 재생 축 동기화.
 *
 * @param {import("./subtitles.js").SubtitleLine} cue
 */
export function syncCueWordSourcesFromEdit(cue) {
  if (!cue?.words?.length) return cue;
  for (const w of cue.words) {
    if (w.is_deleted || w.isDeleted) continue;
    const s = Number(w.start);
    const e = Number(w.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (!isRelocated(cue)) {
      w.sourceStart = s;
      w.source_start = s;
      w.sourceEnd = e;
      w.source_end = e;
      continue;
    }
    const srcS = virtualSecToSourceSec(cue, s);
    const srcE = virtualSecToSourceSec(cue, e);
    w.sourceStart = srcS;
    w.source_start = srcS;
    w.sourceEnd = srcE;
    w.source_end = srcE;
  }
  return cue;
}

/**
 * @param {readonly import("./subtitles.js").SubtitleLine[]} cues
 */
export function syncAllCueWordSourcesFromEdit(cues) {
  return (cues || []).map((cue) => {
    if (!cue?.words?.length) return cue;
    const words = cue.words.map((w) => {
      if (w.is_deleted || w.isDeleted) return w;
      const s = Number(w.start);
      const e = Number(w.end);
      if (!Number.isFinite(s) || !Number.isFinite(e)) return w;
      if (!isRelocated(cue)) {
        return {
          ...w,
          sourceStart: s,
          source_start: s,
          sourceEnd: e,
          source_end: e,
        };
      }
      const srcS = virtualSecToSourceSec(cue, s);
      const srcE = virtualSecToSourceSec(cue, e);
      return {
        ...w,
        sourceStart: srcS,
        source_start: srcS,
        sourceEnd: srcE,
        source_end: srcE,
      };
    });
    return { ...cue, words };
  });
}
