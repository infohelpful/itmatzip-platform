/**
 * Phase 4 — Block SSOT → export virtual_audio_map / stitched program cues.
 */

import { normalizeCutRanges, remapTimeByCuts } from "../export/export-timeline.js?v=2";
import { buildExportCueLines } from "./export-cue-pipeline.js?v=4";
import {
  countValidKeepSegments,
  isSourceStartMonotonic,
  MAX_FAST_PATH_SEGMENTS,
} from "./virtual-audio-map.js?v=4";

const EPS = 1e-5;
const CLIP_END_TAIL_PAD_SEC = 0.2;

/**
 * @typedef {{
 *   blockIndex: number,
 *   cueIndex: number,
 *   sourceStart: number,
 *   sourceEnd: number,
 *   effectiveSourceEnd: number,
 *   editStart: number,
 *   editEnd: number,
 *   isSilence: boolean,
 * }} BlockExportSegment
 */

/**
 * @param {number} sec
 * @param {readonly { start: number, end: number }[]} cuts
 */
function applyCutsToSourceSec(sec, cuts) {
  return remapTimeByCuts(Math.max(0, Number(sec) || 0), cuts);
}

/**
 * @param {number} srcStart
 * @param {number} srcEnd
 * @param {readonly { start: number, end: number }[]} cuts
 */
function trimSourceSpanByCuts(srcStart, srcEnd, cuts) {
  const a = applyCutsToSourceSec(srcStart, cuts);
  const b = applyCutsToSourceSec(srcEnd, cuts);
  if (b <= a + EPS) return null;
  return { sourceStart: a, sourceEnd: b };
}

/**
 * @param {import("./block-timeline-adapter.js").Block | null | undefined} block
 */
function isBlockListableForExport(block) {
  if (!block || block.isDeleted) return false;
  if (block.isSilence) return true;
  const words = block.words || [];
  const hasVisibleWord = words.some(
    (w) => !w.isDeleted && !w.isSilence && String(w.text || "").trim(),
  );
  const hasText = String(block.text || "").trim().length > 0;
  return hasVisibleWord || hasText;
}

/**
 * @param {import("./block-timeline-adapter.js").WordBlock} w
 */
function isPlayableExportWord(w) {
  if (!w) return false;
  if (w.isDeleted && !w.mergedByEdgeTrim) return false;
  return true;
}

/**
 * @param {import("./block-timeline-adapter.js").Block} block
 * @returns {{ sourceStart: number, sourceEnd: number }[]}
 */
function playableMediaRunsForBlock(block) {
  if (block.isSilence) {
    const si = Number(block.sourceIn) || 0;
    const so = Math.max(si, Number(block.sourceOut) || si);
    if (so > si + EPS) return [{ sourceStart: si, sourceEnd: so }];
    return [];
  }

  const words = block.words || [];
  if (words.length) {
    /** @type {{ sourceStart: number, sourceEnd: number }[]} */
    const runs = [];
    let cur = null;
    for (const w of words) {
      if (!isPlayableExportWord(w)) continue;
      const si = Number(w.sourceIn) || 0;
      const so = Math.max(si, Number(w.sourceOut) || si);
      if (so <= si + EPS) continue;
      if (cur && si <= cur.sourceEnd + EPS) {
        cur.sourceEnd = Math.max(cur.sourceEnd, so);
      } else {
        cur = { sourceStart: si, sourceEnd: so };
        runs.push(cur);
      }
    }
    if (runs.length) return runs;
  }

  const si = Number(block.sourceIn) || 0;
  const so = Math.max(si, Number(block.sourceOut) || si);
  if (so > si + EPS) return [{ sourceStart: si, sourceEnd: so }];
  return [];
}

/**
 * @param {import("./block-timeline-adapter.js").Block | null | undefined} block
 */
function blockListSourceStart(block) {
  if (!block) return 0;
  const runs = playableMediaRunsForBlock(block);
  if (runs.length) return runs[0].sourceStart;
  return Number(block.sourceIn) || 0;
}

/**
 * @param {import("./block-timeline-adapter.js").Block} block
 * @param {import("./block-timeline-adapter.js").Block | null} nextBlock
 * @param {number} mediaEnd
 */
function clipSourceEndForBlock(block, nextBlock, mediaEnd, withTailPad = true) {
  let end = mediaEnd;
  const words = block.words || [];
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const w = words[i];
    if (!isPlayableExportWord(w) || w.isSilence) continue;
    const so = Math.max(Number(w.sourceIn) || 0, Number(w.sourceOut) || 0);
    end = Math.max(end, so + (withTailPad ? CLIP_END_TAIL_PAD_SEC : 0));
    break;
  }
  if (!nextBlock) return end;
  const nextStart = blockListSourceStart(nextBlock);
  if (nextStart > end + EPS) return end;
  if (withTailPad && nextStart <= end + EPS) {
    return Math.max(mediaEnd, Math.min(end, nextStart));
  }
  if (nextStart > mediaEnd + EPS) return end;
  return end;
}

function clipEffectiveSourceEndForBlock(block, nextBlock, mediaEnd) {
  return clipSourceEndForBlock(block, nextBlock, mediaEnd, false);
}

/**
 * @param {readonly BlockExportSegment[]} segments
 */
function removeAdjacentSourceOverlaps(segments) {
  if (segments.length <= 1) return segments.map((s) => ({ ...s }));
  /** @type {BlockExportSegment[]} */
  const out = segments.map((s) => ({ ...s }));
  for (let i = 0; i < out.length - 1; i += 1) {
    const a = out[i];
    const b = out[i + 1];
    const overlapStart = Math.max(a.sourceStart, b.sourceStart);
    const overlapEnd = Math.min(a.sourceEnd, b.sourceEnd);
    const overlaps = overlapEnd > overlapStart + EPS;
    if (!overlaps) continue;
    // Reorder — program 큐에서 source가 역행하면 각 ProgramClip 소스 구간 유지 (Policy A).
    if (b.sourceStart < a.sourceStart - EPS) {
      continue;
    }
    const sameSourceAnchor = Math.abs(b.sourceStart - a.sourceStart) <= EPS;
    if (b.sourceStart >= a.sourceStart - EPS) {
      if (!sameSourceAnchor) {
        a.sourceEnd = Math.min(a.sourceEnd, b.sourceStart);
        if (Number.isFinite(a.effectiveSourceEnd)) {
          a.effectiveSourceEnd = Math.min(a.effectiveSourceEnd, b.sourceStart);
        }
      }
    } else {
      b.sourceStart = Math.max(b.sourceStart, a.sourceEnd);
      if (Number.isFinite(b.effectiveSourceEnd)) {
        b.effectiveSourceEnd = Math.max(b.effectiveSourceEnd, a.sourceEnd);
      }
    }
    const MIN_BLOCK_SOURCE_SEC = 1e-4;
    if (a.sourceEnd <= a.sourceStart + EPS) {
      a.sourceEnd = a.sourceStart + MIN_BLOCK_SOURCE_SEC;
      if (Number.isFinite(a.effectiveSourceEnd)) {
        a.effectiveSourceEnd = Math.max(a.effectiveSourceEnd, a.sourceEnd);
      }
    }
    if (b.sourceEnd <= b.sourceStart + EPS) {
      b.sourceStart = Math.min(b.sourceStart, a.sourceEnd);
      b.sourceEnd = b.sourceStart + MIN_BLOCK_SOURCE_SEC;
      if (Number.isFinite(b.effectiveSourceEnd)) {
        b.effectiveSourceEnd = Math.max(b.effectiveSourceEnd, b.sourceEnd);
      }
    }
  }
  return out;
}

/**
 * @param {readonly BlockExportSegment[]} segments
 */
function recalcEditTimelineFromMedia(segments) {
  let cursor = 0;
  return segments.map((s) => {
    const dur = s.sourceEnd - s.sourceStart;
    const editStart = cursor;
    const editEnd = cursor + dur;
    cursor = editEnd;
    return { ...s, editStart, editEnd };
  });
}

/**
 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks
 * @param {readonly import("./block-timeline-adapter.js").VirtualIndexEntry[]} virtualIndex
 * @param {{ cutRanges?: readonly { start: number, end: number }[] }} [opts]
 * @returns {BlockExportSegment[]}
 */
export function blocksToExportSegments(blocks, virtualIndex, opts = {}) {
  const cuts = normalizeCutRanges(opts.cutRanges || []);
  /** @type {BlockExportSegment[]} */
  const raw = [];

  for (let i = 0; i < (virtualIndex || []).length; i += 1) {
    const entry = virtualIndex[i];
    const block = blocks[entry.blockIndex];
    if (!block || block.isDeleted) continue;

    const runs = playableMediaRunsForBlock(block);
    if (!runs.length) continue;

    const nextEntry = i + 1 < virtualIndex.length ? virtualIndex[i + 1] : null;
    const nextBlock = nextEntry ? blocks[nextEntry.blockIndex] : null;

    for (let ri = 0; ri < runs.length; ri += 1) {
      let srcStart = runs[ri].sourceStart;
      let srcEnd = runs[ri].sourceEnd;
      let effectiveEnd = runs[ri].sourceEnd;
      if (ri === runs.length - 1) {
        srcEnd = clipSourceEndForBlock(block, nextBlock, srcEnd);
        effectiveEnd = clipEffectiveSourceEndForBlock(block, nextBlock, effectiveEnd);
      }
      if (cuts.length) {
        const trimmed = trimSourceSpanByCuts(srcStart, srcEnd, cuts);
        if (!trimmed) continue;
        srcStart = trimmed.sourceStart;
        srcEnd = trimmed.sourceEnd;
        const trimmedEff = trimSourceSpanByCuts(srcStart, effectiveEnd, cuts);
        effectiveEnd = trimmedEff ? trimmedEff.sourceEnd : srcEnd;
      }
      effectiveEnd = Math.max(srcStart, Math.min(effectiveEnd, srcEnd));
      if (srcEnd <= srcStart + EPS) continue;
      raw.push({
        blockIndex: entry.blockIndex,
        cueIndex: entry.blockIndex,
        sourceStart: srcStart,
        sourceEnd: srcEnd,
        effectiveSourceEnd: effectiveEnd,
        editStart: 0,
        editEnd: 0,
        isSilence: !!block.isSilence,
      });
    }
  }

  return recalcEditTimelineFromMedia(removeAdjacentSourceOverlaps(raw));
}

/** @param {readonly import("./block-timeline-adapter.js").Block[]} blocks @param {readonly import("./block-timeline-adapter.js").VirtualIndexEntry[]} virtualIndex @param {{ cutRanges?: readonly { start: number, end: number }[] }} [opts] */
export function blocksToVirtualAudioMap(blocks, virtualIndex, opts = {}) {
  return blocksToExportSegments(blocks, virtualIndex, opts);
}

/**
 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks
 * @param {readonly import("./block-timeline-adapter.js").VirtualIndexEntry[]} virtualIndex
 * @param {readonly { start: number, end: number }[]} cutRanges
 */
/** @deprecated V5 — program-master path; always false. */
export function blocksRequireConcatExport(blocks, virtualIndex, cutRanges) {
  void blocks;
  void virtualIndex;
  void cutRanges;
  return false;
}

/**
 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks
 * @param {readonly import("./block-timeline-adapter.js").VirtualIndexEntry[]} virtualIndex
 * @param {readonly object[]} cues
 * @param {{ cutRanges?: readonly { start: number, end: number }[], requiresConcat?: boolean }} [opts]
 */
export function buildBlockStitchedProgramExportCues(blocks, virtualIndex, cues, opts = {}) {
  if (!opts.requiresConcat) {
    return buildExportCueLines(cues);
  }

  const map = blocksToExportSegments(blocks, virtualIndex, { cutRanges: opts.cutRanges });
  /** @type {{ start: number, end: number, text: string, words?: object[] }[]} */
  const out = [];

  for (const seg of map) {
    const block = blocks[seg.blockIndex];
    if (!block || block.isDeleted) continue;
    if (seg.isSilence) continue;

    const text = String(block.text ?? "").trim();
    const words = block.words || [];
    const hasWords = words.length > 0;

    if (hasWords) {
      const vis = words.filter(
        (w) => isPlayableExportWord(w) && !w.isSilence && String(w.text || "").trim(),
      );
      if (!vis.length) continue;

      const remapped = vis
        .map((w) => {
          const ws =
            seg.editStart + (Number(w.sourceIn) - seg.sourceStart);
          const we =
            seg.editStart + (Number(w.sourceOut) - seg.sourceStart);
          return {
            word: w.text,
            start: Math.max(seg.editStart, ws),
            end: Math.min(seg.editEnd, we),
          };
        })
        .filter((w) => w.end > w.start + EPS);

      if (!remapped.length) continue;
      const start = Math.min(...remapped.map((w) => w.start));
      const end = Math.max(...remapped.map((w) => w.end));
      out.push({
        start,
        end,
        text: text || remapped.map((w) => w.word).join(" "),
        words: remapped,
      });
    } else if (text) {
      out.push({ start: seg.editStart, end: seg.editEnd, text });
    }
  }

  return out;
}

/**
 * overlay-capture-schedule용 — block virtual 축 + segment media envelope.
 *
 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks
 * @param {readonly import("./block-timeline-adapter.js").VirtualIndexEntry[]} virtualIndex
 * @param {{ cutRanges?: readonly { start: number, end: number }[] }} [opts]
 */
export function blocksToOverlayProgramSegments(blocks, virtualIndex, opts = {}) {
  const map = blocksToExportSegments(blocks, virtualIndex, opts);
  /** @type {{ blockIndex: number, editStart: number, editEnd: number, virtualEnd: number, isSilence: boolean }[]} */
  const out = [];
  const seen = new Set();
  for (const seg of map) {
    const bi = seg.blockIndex;
    if (seen.has(bi)) continue;
    seen.add(bi);
    out.push({
      blockIndex: bi,
      editStart: seg.editStart,
      editEnd: seg.editEnd,
      virtualEnd: seg.editEnd,
      isSilence: !!seg.isSilence,
    });
  }
  return out;
}

/**
 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks
 * @param {number} blockIndex
 */
export function blockForExportOverlay(blocks, blockIndex) {
  return blocks[blockIndex] ?? null;
}
