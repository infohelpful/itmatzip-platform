/**
 * AutoSubtitle virtualTimeline.ts — tombstone·미디어 컷 (웹 핵심 부분).
 */

import { wordIsDeleted, displayTextFromSubtitleWords, visibleSubtitleWords } from "./subtitles.js";
import { mergeCutRanges, snapTimelineSec } from "./timeline-collapse.js";

const DELETE_RANGE_MIN_SEC = 1e-5;

/**
 * @param {import("./subtitles.js").SubtitleLine} line
 * @param {import("./subtitles.js").SubtitleWord[]} newWords
 */
function rebuildLineMetaAfterWordsChange(line, newWords) {
  const vis = visibleSubtitleWords(newWords);
  if (vis.length === 0) {
    return {
      ...line,
      words: newWords,
      text: displayTextFromSubtitleWords(newWords),
    };
  }
  return {
    ...line,
    words: newWords,
    start: vis[0].start,
    end: Math.max(vis[0].start + 0.1, vis[vis.length - 1].end),
    text: displayTextFromSubtitleWords(newWords),
  };
}

export function wordMergedByEdgeTrim(w) {
  return w.merged_by_edge_trim === true || w.mergedByEdgeTrim === true;
}

/**
 * @param {readonly import("./subtitles.js").SubtitleWord[]} words
 * @param {number} wordIndex
 * @param {ReadonlySet<number> | null} alsoRemovingWordIndices
 */
export function clampTombstoneMediaRangeToAliveNeighbors(words, wordIndex, alsoRemovingWordIndices) {
  const w = words[wordIndex];
  if (!w) return null;
  let ms = snapTimelineSec(Math.min(w.start, w.end));
  let me = snapTimelineSec(Math.max(w.start, w.end));
  if (me < ms) {
    const t = ms;
    ms = me;
    me = t;
  }

  const skipNeighbor = (idx) => {
    if (alsoRemovingWordIndices?.has(idx)) return true;
    const x = words[idx];
    return wordIsDeleted(x);
  };

  for (let j = wordIndex - 1; j >= 0; j -= 1) {
    if (skipNeighbor(j)) continue;
    const p = words[j];
    ms = Math.max(ms, snapTimelineSec(Math.max(p.start, p.end)));
    break;
  }
  for (let j = wordIndex + 1; j < words.length; j += 1) {
    if (skipNeighbor(j)) continue;
    const n = words[j];
    me = Math.min(me, snapTimelineSec(Math.min(n.start, n.end)));
    break;
  }

  if (!(me > ms + 1e-9)) return null;
  return { start: ms, end: me };
}

/**
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 */
export function collectDeletedWordSkipRangesFromLines(lines) {
  /** @type {{ start: number, end: number }[]} */
  const ranges = [];
  for (let li = 0; li < (lines || []).length; li += 1) {
    const words = lines[li]?.words ?? [];
    for (let wi = 0; wi < words.length; wi += 1) {
      const w = words[wi];
      if (!wordIsDeleted(w)) continue;
      if (wordMergedByEdgeTrim(w)) continue;
      const clamped = clampTombstoneMediaRangeToAliveNeighbors(words, wi, null);
      if (clamped) {
        ranges.push(clamped);
      } else {
        const ms = snapTimelineSec(Math.min(w.start, w.end));
        const me = snapTimelineSec(Math.max(w.start, w.end));
        if (me > ms + 1e-9) ranges.push({ start: ms, end: me });
      }
    }
  }
  return mergeCutRanges(ranges);
}

/**
 * @typedef {{ id: string, mediaStartSec: number, mediaEndSec: number, text?: string, isDeleted: boolean }} VirtualTimelineBlock
 */

/**
 * @param {readonly VirtualTimelineBlock[]} blocks
 */
export function cutRangesFromDeletedBlocks(blocks) {
  const dels = (blocks || []).filter(
    (b) => b.isDeleted && b.mediaEndSec > b.mediaStartSec + 1e-9,
  );
  return mergeCutRanges(
    dels.map((b) => ({
      start: snapTimelineSec(b.mediaStartSec),
      end: snapTimelineSec(b.mediaEndSec),
    })),
  );
}

/**
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 * @param {readonly { start: number, end: number }[]} mergedCuts
 */
export function tombstoneBlocksFromSoftDeletedSubtitleWords(lines, mergedCuts) {
  void mergedCuts;
  /** @type {VirtualTimelineBlock[]} */
  const blocks = [];
  for (let li = 0; li < (lines || []).length; li += 1) {
    const words = lines[li]?.words ?? [];
    for (let wi = 0; wi < words.length; wi += 1) {
      const w = words[wi];
      if (!wordIsDeleted(w)) continue;
      if (wordMergedByEdgeTrim(w)) continue;
      const clamped = clampTombstoneMediaRangeToAliveNeighbors(words, wi, null);
      let ms;
      let me;
      if (clamped) {
        ms = clamped.start;
        me = clamped.end;
      } else {
        ms = snapTimelineSec(Math.min(w.start, w.end));
        me = snapTimelineSec(Math.max(w.start, w.end));
      }
      if (!(me > ms + 1e-9)) continue;
      blocks.push({
        id: `softdel:${li}:${wi}:${snapTimelineSec(ms)}:${snapTimelineSec(me)}`,
        mediaStartSec: ms,
        mediaEndSec: me,
        text: w.word,
        isDeleted: true,
      });
    }
  }
  return blocks;
}

/**
 * Peaks/재생 EDL — 하드 컷 + tombstone 단어 + 가상 삭제 블록.
 *
 * @param {readonly { start: number, end: number }[]} mergedCuts
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 * @param {readonly VirtualTimelineBlock[]} deletedMediaBlocks
 */
export function mergeWaveformPeaksStitchCutRanges(mergedCuts, lines, deletedMediaBlocks) {
  const fromWords = cutRangesFromDeletedBlocks(
    tombstoneBlocksFromSoftDeletedSubtitleWords(lines, mergedCuts),
  );
  const fromVirtual = cutRangesFromDeletedBlocks(
    (deletedMediaBlocks || []).filter((b) => b.isDeleted),
  );
  return mergeCutRanges([...(mergedCuts || []), ...fromWords, ...fromVirtual]);
}

/**
 * @param {readonly VirtualTimelineBlock[]} prev
 * @param {{ start: number, end: number }} mediaCut
 * @param {string} [textHint]
 */
export function mergeDeletedMediaIntoTimeline(prev, mediaCut, textHint = "") {
  const s = snapTimelineSec(Math.max(0, Math.min(mediaCut.start, mediaCut.end)));
  const e = snapTimelineSec(Math.max(0, Math.max(mediaCut.start, mediaCut.end)));
  if (!(e > s + 0.001)) return [...(prev || [])];

  const active = (prev || []).filter((b) => !b.isDeleted);
  const merged = mergeCutRanges([
    ...cutRangesFromDeletedBlocks((prev || []).filter((b) => b.isDeleted)),
    { start: s, end: e },
  ]);
  /** @type {VirtualTimelineBlock[]} */
  const tombstones = merged.map((r) => ({
    id: `del:${snapTimelineSec(r.start)}:${snapTimelineSec(r.end)}`,
    mediaStartSec: r.start,
    mediaEndSec: r.end,
    text: textHint,
    isDeleted: true,
  }));
  return [...active, ...tombstones];
}

/**
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 * @param {number} deletedLineIndex
 * @param {number} fromWordIndex
 * @param {number} toWordIndexExclusive
 */
export function subtitleLinesAfterSoftDeleteWordRange(
  lines,
  deletedLineIndex,
  fromWordIndex,
  toWordIndexExclusive,
) {
  if (deletedLineIndex < 0 || deletedLineIndex >= lines.length) return null;
  const line = lines[deletedLineIndex];
  const words = line.words ?? [];
  if (
    fromWordIndex < 0 ||
    toWordIndexExclusive > words.length ||
    fromWordIndex >= toWordIndexExclusive
  ) {
    return null;
  }

  const deletedIndices = [];
  for (let i = fromWordIndex; i < toWordIndexExclusive; i += 1) deletedIndices.push(i);

  let totalDur = 0;
  for (const i of deletedIndices) {
    const w = words[i];
    if (!w || wordIsDeleted(w)) return null;
    totalDur += Math.max(0, w.end - w.start);
  }
  if (!(totalDur > DELETE_RANGE_MIN_SEC)) return null;

  const removing = new Set(deletedIndices);
  /** @type {{ start: number, end: number }[]} */
  const mediaCutPieces = [];
  for (const i of deletedIndices) {
    const w = words[i];
    const clamped = clampTombstoneMediaRangeToAliveNeighbors(words, i, removing);
    if (clamped && clamped.end > clamped.start + 1e-9) {
      mediaCutPieces.push({ start: clamped.start, end: clamped.end });
      continue;
    }
    let ms = snapTimelineSec(Math.min(w.start, w.end));
    let me = snapTimelineSec(Math.max(w.start, w.end));
    if (me < ms) {
      const t = ms;
      ms = me;
      me = t;
    }
    if (me > ms + 1e-9) mediaCutPieces.push({ start: ms, end: me });
  }
  const mediaCutsForVirtual = mergeCutRanges(mediaCutPieces);

  const out = lines.map((ln, li) => {
    if (li !== deletedLineIndex) return ln;
    const ws = ln.words ?? [];
    const nw = ws.map((w, wi) =>
      removing.has(wi) ? { ...w, is_deleted: true, isDeleted: true } : w,
    );
    return rebuildLineMetaAfterWordsChange(ln, nw);
  });

  return { lines: out, mediaCutsForVirtual };
}
