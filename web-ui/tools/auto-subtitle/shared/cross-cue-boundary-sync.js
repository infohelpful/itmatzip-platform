/**
 * 줄 경계(cross-cue) 단어 경계 — block sourceIn/Out SSOT 동기화.
 * 파형 트림·타이밍 맞추기 공통.
 */

import { recalcBlockMediaEnvelope } from "./block-word-edit-ops.js?v=2";
import {
  getWordSourceEnd,
  getWordSourceStart,
  isRelocated,
  sourceSecToVirtualSec,
} from "./dual-axis.js?v=3";
import { syncSubtitleLineFromWords } from "./subtitles.js?v=24";
import { applyCueTimingDrag } from "./line-mode/cue-ops.js?v=7";

const MIN_BOUNDARY_WORD_SEC = 0.01;

/**
 * @param {import("./subtitles.js").SubtitleWord} word
 * @param {import("./subtitles.js").SubtitleLine} cue
 * @param {number} start
 * @param {number} end
 */
function setWordMediaSpan(word, cue, start, end) {
  const s = Number(start);
  const e = Math.max(s + MIN_BOUNDARY_WORD_SEC, Number(end));
  word.sourceStart = s;
  word.source_start = s;
  word.sourceEnd = e;
  word.source_end = e;
  if (isRelocated(cue)) {
    word.start = sourceSecToVirtualSec(cue, s);
    word.end = sourceSecToVirtualSec(cue, e);
  } else {
    word.start = s;
    word.end = e;
  }
}

/**
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 * @param {number} cueIndex
 */
export function nextSpokenCueIndex(lines, cueIndex) {
  if (!lines?.length || cueIndex < 0) return -1;
  for (let i = cueIndex + 1; i < lines.length; i += 1) {
    const c = lines[i];
    if (!c || c.is_deleted || c.isDeleted || c.is_silence || c.isSilence) continue;
    if (firstSpokenStorageIndex(c) >= 0) return i;
  }
  return -1;
}

/**
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 * @param {number} cueIndex
 */
export function prevSpokenCueIndex(lines, cueIndex) {
  if (!lines?.length || cueIndex <= 0) return -1;
  for (let i = cueIndex - 1; i >= 0; i -= 1) {
    const c = lines[i];
    if (!c || c.is_deleted || c.isDeleted || c.is_silence || c.isSilence) continue;
    if (lastSpokenStorageIndex(c) >= 0) return i;
  }
  return -1;
}

/**
 * @typedef {{
 *   left: { cue_index: number, word_index: number },
 *   right: { cue_index: number, word_index: number },
 *   boundary_sec: number,
 *   same_cue?: boolean,
 * }} CrossCueBoundaryPatch
 */

/**
 * @param {import("./subtitles.js").SubtitleLine | null | undefined} cue
 */
export function firstSpokenStorageIndex(cue) {
  const words = cue?.words;
  if (!words?.length) return -1;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w?.is_deleted || w?.isDeleted || w?.is_silence || w?.isSilence) continue;
    return i;
  }
  return -1;
}

/**
 * @param {import("./subtitles.js").SubtitleLine | null | undefined} cue
 */
export function lastSpokenStorageIndex(cue) {
  const words = cue?.words;
  if (!words?.length) return -1;
  let last = -1;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w?.is_deleted || w?.isDeleted || w?.is_silence || w?.isSilence) continue;
    last = i;
  }
  return last;
}

/**
 * @param {import("./block-timeline-adapter.js").WordBlock[]} words
 * @param {number} storageIndex
 */
function resolveSpokenWordIndex(words, storageIndex) {
  if (!words?.length) return -1;
  if (words[storageIndex] && !words[storageIndex].isDeleted && !words[storageIndex].isSilence) {
    return storageIndex;
  }
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w && !w.isDeleted && !w.isSilence) return i;
  }
  return storageIndex;
}

/**
 * @param {import("./block-timeline-adapter.js").WordBlock[]} words
 * @param {number} spokenIdx
 * @param {number} boundarySec
 * @param {'tail' | 'head'} side
 */
function clampBlockSilenceAtBoundary(words, spokenIdx, boundarySec, side) {
  if (!words?.length || spokenIdx < 0) return;
  const t = Number(boundarySec);
  if (!Number.isFinite(t)) return;
  if (side === "tail") {
    for (let i = spokenIdx + 1; i < words.length; i += 1) {
      const w = words[i];
      if (!w || w.isDeleted) continue;
      if (!w.isSilence) break;
      w.sourceIn = t;
      w.sourceOut = t + MIN_BOUNDARY_WORD_SEC;
      w.duration = MIN_BOUNDARY_WORD_SEC;
    }
    return;
  }
  for (let i = spokenIdx - 1; i >= 0; i -= 1) {
    const w = words[i];
    if (!w || w.isDeleted) continue;
    if (!w.isSilence) break;
    w.sourceOut = t;
    w.sourceIn = Math.max(0, t - MIN_BOUNDARY_WORD_SEC);
    w.duration = MIN_BOUNDARY_WORD_SEC;
  }
}

/**
 * @param {import("./subtitles.js").SubtitleLine} cue
 * @param {number} spokenIdx
 * @param {number} boundarySec
 * @param {'tail' | 'head'} side
 */
function clampLineSilenceAtBoundary(cue, spokenIdx, boundarySec, side) {
  const words = cue?.words;
  if (!words?.length || spokenIdx < 0) return;
  const t = Number(boundarySec);
  if (!Number.isFinite(t)) return;
  if (side === "tail") {
    for (let i = spokenIdx + 1; i < words.length; i += 1) {
      const w = words[i];
      if (!w || w.is_deleted || w.isDeleted) continue;
      if (!w.is_silence && !w.isSilence) break;
      setWordMediaSpan(w, cue, t, t + MIN_BOUNDARY_WORD_SEC);
    }
    return;
  }
  for (let i = spokenIdx - 1; i >= 0; i -= 1) {
    const w = words[i];
    if (!w || w.is_deleted || w.isDeleted) continue;
    if (!w.is_silence && !w.isSilence) break;
    setWordMediaSpan(w, cue, Math.max(0, t - MIN_BOUNDARY_WORD_SEC), t);
  }
}

/**
 * @param {import("./block-timeline-adapter.js").Block[]} blocks
 * @param {CrossCueBoundaryPatch[]} patches
 */
export function applyCrossCueBoundaryPatchesToBlocks(blocks, patches) {
  if (!patches?.length || !blocks?.length) return blocks;

  const next = blocks.map((b) => ({
    ...b,
    words: b.words ? b.words.map((w) => ({ ...w })) : undefined,
  }));

  for (const patch of patches) {
    const { left, right } = patch;
    const t = Number(patch.boundary_sec);
    if (
      !left ||
      !right ||
      !Number.isFinite(t) ||
      !Number.isInteger(left.cue_index) ||
      !Number.isInteger(right.cue_index)
    ) {
      continue;
    }

    const lb = next[left.cue_index];
    const rb = next[right.cue_index];
    if (!lb?.words?.length || !rb?.words?.length) continue;

    const lwi = resolveSpokenWordIndex(lb.words, left.word_index);
    const rwi = resolveSpokenWordIndex(rb.words, right.word_index);
    const lw = lb.words[lwi];
    const rw = rb.words[rwi];
    if (!lw || !rw || lw.isDeleted || rw.isDeleted || lw.isSilence || rw.isSilence) {
      continue;
    }

    const lsi = Number(lw.sourceIn) || 0;
    let rso = Math.max(Number(rw.sourceOut) || 0, Number(rw.sourceIn) || 0);
    let tClamp = Math.max(lsi + MIN_BOUNDARY_WORD_SEC, t);
    if (tClamp > rso - MIN_BOUNDARY_WORD_SEC) {
      rso = tClamp + MIN_BOUNDARY_WORD_SEC;
    }
    tClamp = Math.max(lsi + MIN_BOUNDARY_WORD_SEC, Math.min(tClamp, rso - MIN_BOUNDARY_WORD_SEC));
    if (!(rso > lsi + MIN_BOUNDARY_WORD_SEC - 1e-9)) continue;

    lw.sourceOut = tClamp;
    lw.duration = Math.max(MIN_BOUNDARY_WORD_SEC, tClamp - lsi);
    rw.sourceIn = tClamp;
    rw.sourceOut = rso;
    rw.duration = Math.max(MIN_BOUNDARY_WORD_SEC, rso - tClamp);

    clampBlockSilenceAtBoundary(lb.words, lwi, tClamp, "tail");
    clampBlockSilenceAtBoundary(rb.words, rwi, tClamp, "head");

    const lenv = recalcBlockMediaEnvelope(lb, lb.words);
    lb.sourceIn = lenv.sourceIn;
    lb.sourceOut = lenv.sourceOut;
    lb.duration = Math.max(MIN_BOUNDARY_WORD_SEC, lenv.sourceOut - lenv.sourceIn);

    const renv = recalcBlockMediaEnvelope(rb, rb.words);
    rb.sourceIn = renv.sourceIn;
    rb.sourceOut = renv.sourceOut;
    rb.duration = Math.max(MIN_BOUNDARY_WORD_SEC, renv.sourceOut - renv.sourceIn);
  }

  return next;
}

/**
 * 파형 트림 commit 후 — 줄 경계 patch 생성.
 *
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 * @param {number} cueIndex
 * @param {number} storageIndex
 * @param {'start' | 'end'} edge
 * @returns {CrossCueBoundaryPatch | null}
 */
export function crossCueBoundaryPatchForWordTrim(lines, cueIndex, storageIndex, edge) {
  if (!lines?.length || cueIndex < 0 || storageIndex < 0) return null;
  const cue = lines[cueIndex];
  const word = cue?.words?.[storageIndex];
  if (!cue || !word || word.is_deleted || word.isDeleted) return null;

  if (edge === "end") {
    if (storageIndex !== lastSpokenStorageIndex(cue)) return null;
    const nextCi = nextSpokenCueIndex(lines, cueIndex);
    const nextCue = nextCi >= 0 ? lines[nextCi] : null;
    const rwi = firstSpokenStorageIndex(nextCue);
    if (rwi < 0) return null;
    const boundary = getWordSourceEnd(word, cue);
    if (!Number.isFinite(boundary)) return null;
    return {
      left: { cue_index: cueIndex, word_index: storageIndex },
      right: { cue_index: nextCi, word_index: rwi },
      boundary_sec: boundary,
      same_cue: false,
    };
  }

  if (edge === "start") {
    if (storageIndex !== firstSpokenStorageIndex(cue)) return null;
    const prevCi = prevSpokenCueIndex(lines, cueIndex);
    const prevCue = prevCi >= 0 ? lines[prevCi] : null;
    const lwi = lastSpokenStorageIndex(prevCue);
    if (lwi < 0) return null;
    const boundary = getWordSourceStart(word, cue);
    if (!Number.isFinite(boundary)) return null;
    return {
      left: { cue_index: prevCi, word_index: lwi },
      right: { cue_index: cueIndex, word_index: storageIndex },
      boundary_sec: boundary,
      same_cue: false,
    };
  }

  return null;
}

/**
 * 파형 트림 직후 — 인접 줄 spoken 경계를 source(media) 축 하나로 강제 (cue SSOT).
 *
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 * @param {number} cueIndex
 * @param {number} storageIndex
 * @param {'start' | 'end'} edge
 * @returns {import("./subtitles.js").SubtitleLine[]}
 */
export function enforceCrossLineSpokenBoundaryOnLines(lines, cueIndex, storageIndex, edge) {
  if (!lines?.length || cueIndex < 0 || storageIndex < 0) return [...(lines || [])];

  const next = (lines || []).map((line) => ({
    ...line,
    words: line.words ? line.words.map((w) => ({ ...w })) : undefined,
  }));

  if (edge === "end") {
    const lwi = lastSpokenStorageIndex(next[cueIndex]);
    if (lwi < 0 || lwi !== storageIndex) return next;
    const nextCi = nextSpokenCueIndex(next, cueIndex);
    const nextCue = nextCi >= 0 ? next[nextCi] : null;
    const rwi = firstSpokenStorageIndex(nextCue);
    if (rwi < 0) return next;
    const leftCue = next[cueIndex];
    const lw = leftCue?.words?.[lwi];
    const rw = nextCue?.words?.[rwi];
    if (!lw || !rw) return next;
    const boundary = getWordSourceEnd(lw, leftCue);
    if (!Number.isFinite(boundary)) return next;
    const lsi = getWordSourceStart(lw, leftCue);
    let rso = getWordSourceEnd(rw, nextCue);
    let t = Math.max(lsi + MIN_BOUNDARY_WORD_SEC, boundary);
    if (t > rso - MIN_BOUNDARY_WORD_SEC) {
      rso = t + MIN_BOUNDARY_WORD_SEC;
    }
    setWordMediaSpan(lw, leftCue, lsi, t);
    setWordMediaSpan(rw, nextCue, t, rso);
    clampLineSilenceAtBoundary(leftCue, lwi, t, "tail");
    clampLineSilenceAtBoundary(nextCue, rwi, t, "head");
    syncSubtitleLineFromWords(leftCue);
    syncSubtitleLineFromWords(nextCue);
    return next;
  }

  if (edge === "start") {
    const rwi = firstSpokenStorageIndex(next[cueIndex]);
    if (rwi < 0 || rwi !== storageIndex) return next;
    const prevCi = prevSpokenCueIndex(next, cueIndex);
    const prevCue = prevCi >= 0 ? next[prevCi] : null;
    const lwi = lastSpokenStorageIndex(prevCue);
    if (lwi < 0) return next;
    const rightCue = next[cueIndex];
    const lw = prevCue?.words?.[lwi];
    const rw = rightCue?.words?.[rwi];
    if (!lw || !rw) return next;
    const boundary = getWordSourceStart(rw, rightCue);
    if (!Number.isFinite(boundary)) return next;
    let lsi = getWordSourceStart(lw, prevCue);
    const rso = getWordSourceEnd(rw, rightCue);
    let t = Math.min(rso - MIN_BOUNDARY_WORD_SEC, Math.max(lsi + MIN_BOUNDARY_WORD_SEC, boundary));
    if (t < lsi + MIN_BOUNDARY_WORD_SEC) {
      lsi = Math.max(0, t - MIN_BOUNDARY_WORD_SEC);
    }
    setWordMediaSpan(lw, prevCue, lsi, t);
    setWordMediaSpan(rw, rightCue, t, rso);
    clampLineSilenceAtBoundary(prevCue, lwi, t, "tail");
    clampLineSilenceAtBoundary(rightCue, rwi, t, "head");
    syncSubtitleLineFromWords(prevCue);
    syncSubtitleLineFromWords(rightCue);
    return next;
  }

  return next;
}

/**
 * @param {readonly import("./block-timeline-adapter.js").WordBlock[]} words
 */
function lastSpokenWordIndexInBlock(words) {
  if (!words?.length) return -1;
  let last = -1;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w && !w.isDeleted && !w.isSilence) last = i;
  }
  return last;
}

/**
 * @param {readonly import("./block-timeline-adapter.js").WordBlock[]} words
 */
function firstSpokenWordIndexInBlock(words) {
  if (!words?.length) return -1;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w && !w.isDeleted && !w.isSilence) return i;
  }
  return -1;
}

/**
 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks
 * @param {number} blockIndex
 */
function nextSpokenBlockIndex(blocks, blockIndex) {
  if (!blocks?.length || blockIndex < 0) return -1;
  for (let i = blockIndex + 1; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (!b || b.isDeleted || b.isSilence) continue;
    if (firstSpokenWordIndexInBlock(b.words) >= 0) return i;
  }
  return -1;
}

/**
 * 인접 block spoken 경계 — sourceOut(N) = sourceIn(N+1), 꼬리/머리 무음 클램프.
 *
 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks
 */
export function enforceAdjacentCrossLineBlockBoundaries(blocks) {
  if (!blocks?.length) return blocks || [];
  const next = blocks.map((b) => ({
    ...b,
    words: b.words ? b.words.map((w) => ({ ...w })) : undefined,
  }));

  for (let bi = 0; bi < next.length; bi += 1) {
    const nextBi = nextSpokenBlockIndex(next, bi);
    if (nextBi < 0) continue;
    const lb = next[bi];
    const rb = next[nextBi];
    if (!lb?.words?.length || !rb?.words?.length) continue;
    if (lb.isDeleted || rb.isDeleted) continue;

    const lwi = lastSpokenWordIndexInBlock(lb.words);
    const rwi = firstSpokenWordIndexInBlock(rb.words);
    if (lwi < 0 || rwi < 0) continue;

    const lw = lb.words[lwi];
    const rw = rb.words[rwi];
    const lsi = Number(lw.sourceIn) || 0;
    let rso = Math.max(Number(rw.sourceOut) || 0, Number(rw.sourceIn) || 0);
    let t = Number(lw.sourceOut);
    if (!Number.isFinite(t)) t = Number(rw.sourceIn);
    if (!Number.isFinite(t)) continue;
    t = Math.max(lsi + MIN_BOUNDARY_WORD_SEC, t);
    if (t > rso - MIN_BOUNDARY_WORD_SEC) {
      rso = t + MIN_BOUNDARY_WORD_SEC;
    }
    t = Math.max(lsi + MIN_BOUNDARY_WORD_SEC, Math.min(t, rso - MIN_BOUNDARY_WORD_SEC));

    lw.sourceOut = t;
    lw.duration = Math.max(MIN_BOUNDARY_WORD_SEC, t - lsi);
    rw.sourceIn = t;
    rw.sourceOut = rso;
    rw.duration = Math.max(MIN_BOUNDARY_WORD_SEC, rso - t);

    clampBlockSilenceAtBoundary(lb.words, lwi, t, "tail");
    clampBlockSilenceAtBoundary(rb.words, rwi, t, "head");

    const lenv = recalcBlockMediaEnvelope(lb, lb.words);
    lb.sourceIn = lenv.sourceIn;
    lb.sourceOut = lenv.sourceOut;
    lb.duration = Math.max(MIN_BOUNDARY_WORD_SEC, lenv.sourceOut - lenv.sourceIn);

    const renv = recalcBlockMediaEnvelope(rb, rb.words);
    rb.sourceIn = renv.sourceIn;
    rb.sourceOut = renv.sourceOut;
    rb.duration = Math.max(MIN_BOUNDARY_WORD_SEC, renv.sourceOut - renv.sourceIn);
  }

  return next;
}

/**
 * 파형 cross-line 트림 — lines enforce → blocks SSOT → 인접 경계 강제 (단일 commit).
 *
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 * @param {number} cueIndex
 * @param {number} storageIndex
 * @param {'start' | 'end'} edge
 */
export function commitCrossLineWordTrimOnHub(hub, lines, cueIndex, storageIndex, edge) {
  if (!hub) return;
  const nextLines = enforceCrossLineSpokenBoundaryOnLines(lines, cueIndex, storageIndex, edge);
  hub.applySubtitleChange(() => nextLines, { forceCommit: true });
  const patch = crossCueBoundaryPatchForWordTrim(hub.cues, cueIndex, storageIndex, edge);
  hub.applyBlockChange((blocks) => {
    let next = blocks;
    if (patch) {
      next = applyCrossCueBoundaryPatchesToBlocks(blocks, [patch]);
    }
    return enforceAdjacentCrossLineBlockBoundaries(next);
  });
  hub._derivedCues = null;
  hub._syncVirtualTimelineDeleted();
  hub._notify();
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {CrossCueBoundaryPatch | null | undefined} patch
 */
export function commitCrossCueBoundaryOnHub(hub, patch) {
  if (!hub || !patch) return;
  hub.applyBlockChange(
    (blocks) => applyCrossCueBoundaryPatchesToBlocks(blocks, [patch]),
    { recordHistory: false },
  );
  hub._derivedCues = null;
  hub._syncVirtualTimelineDeleted();
  hub._notify();
}

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 * @param {number} cueIndex
 * @param {number} storageIndex
 * @param {'start' | 'end'} edge
 */
export function syncCrossCueBoundaryAfterWordTrim(hub, lines, cueIndex, storageIndex, edge) {
  const patch = crossCueBoundaryPatchForWordTrim(lines, cueIndex, storageIndex, edge);
  commitCrossCueBoundaryOnHub(hub, patch);
}

/**
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 */
function cloneSubtitleLines(lines) {
  return (lines || []).map((line) => ({
    ...line,
    words: line.words?.map((w) => ({ ...w })),
  }));
}

/**
 * Line Mode 줄 파형 — 끝 핸들만. 현재 줄 end + 아래 줄 start 를 같은 경계로 이동.
 *
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 * @param {number} cueIndex
 * @param {number} targetSec
 * @param {{ onsets?: readonly { t: number }[], silencePads?: readonly { t: number }[], alt?: boolean }} snap
 * @param {number} mediaDurationSec
 */
export function applyCueLineEndTrimCoupled(
  lines,
  cueIndex,
  targetSec,
  snap,
  mediaDurationSec,
) {
  const cue = lines?.[cueIndex];
  if (!cue) return cloneSubtitleLines(lines);
  const fixedStart = Number(cue.start) || 0;
  let next = cloneSubtitleLines(lines);
  next[cueIndex] = applyCueTimingDrag(cue, "end", targetSec, snap, mediaDurationSec);
  const lwi = lastSpokenStorageIndex(next[cueIndex]);
  if (lwi >= 0 && nextSpokenCueIndex(next, cueIndex) >= 0) {
    next = enforceCrossLineSpokenBoundaryOnLines(next, cueIndex, lwi, "end");
  }
  const cur = next[cueIndex];
  if (cur) {
    const start = fixedStart;
    const end = Math.max(start + 1e-4, Number(cur.end) || start);
    cur.start = start;
    cur.end = end;
    const fwi = firstSpokenStorageIndex(cur);
    if (fwi >= 0 && cur.words?.[fwi]) {
      const fw = cur.words[fwi];
      fw.start = start;
      fw.hintStart = start;
      if ((Number(fw.end) || start) < start) {
        fw.end = start;
        fw.hintEnd = start;
      }
    }
  }
  return next;
}
