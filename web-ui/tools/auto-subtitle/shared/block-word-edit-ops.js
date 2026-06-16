/**
 * Phase 3C — block[] word soft-delete with Duration Shrink (virtual tombstone 없음, preview skip은 derived).
 */

import { displayTextFromSubtitleWords } from "./subtitles.js?v=24";

const DELETE_RANGE_MIN_SEC = 1e-5;
const MIN_BLOCK_DURATION_SEC = 1e-5;

/**
 * @param {import("./block-timeline-adapter.js").WordBlock} w
 */
function wordBlockVirtualDuration(w) {
  const d = Number(w.duration);
  if (Number.isFinite(d) && d > 0) return d;
  const si = Number(w.sourceIn) || 0;
  const so = Math.max(si, Number(w.sourceOut) || si);
  return Math.max(0, so - si);
}

/**
 * @param {readonly import("./block-timeline-adapter.js").WordBlock[]} words
 */
function visibleSpeechWordBlocks(words) {
  return (words || []).filter((w) => !w.isDeleted && !w.isSilence);
}

/**
 * @param {readonly import("./block-timeline-adapter.js").WordBlock[]} words
 */
function hasVisibleSilenceChip(words) {
  return (words || []).some((w) => !w.isDeleted && w.isSilence);
}

/**
 * @param {import("./block-timeline-adapter.js").Block} block
 */
export function blockShouldHardDeleteAfterWordEdit(block) {
  if (!block || block.isSilence) return false;
  const words = block.words || [];
  if (visibleSpeechWordBlocks(words).length > 0) return false;
  return !hasVisibleSilenceChip(words);
}

/**
 * @param {readonly import("./block-timeline-adapter.js").WordBlock[]} words
 */
export function blockTextFromWords(words) {
  const asCueWords = (words || []).map((w) => ({
    word: w.text,
    start: w.sourceIn,
    end: w.sourceOut,
    isDeleted: w.isDeleted,
    is_deleted: w.isDeleted,
    isSilence: w.isSilence,
    is_silence: w.isSilence,
    mergedByEdgeTrim: w.mergedByEdgeTrim,
    merged_by_edge_trim: w.mergedByEdgeTrim,
  }));
  return displayTextFromSubtitleWords(asCueWords);
}

/**
 * @param {import("./block-timeline-adapter.js").Block} block
 * @param {readonly import("./block-timeline-adapter.js").WordBlock[]} words
 * @param {string} id
 * @param {string} [text]
 */
export function buildBlockFromWordSubset(block, words, id, text) {
  const envelope = recalcBlockMediaEnvelope(block, words);
  let duration = 0;
  for (const w of words) {
    if (w.isDeleted && !w.mergedByEdgeTrim) continue;
    duration += wordBlockVirtualDuration(w);
  }
  return {
    ...block,
    id,
    words: words.length ? [...words] : undefined,
    duration: Math.max(MIN_BLOCK_DURATION_SEC, duration),
    sourceIn: envelope.sourceIn,
    sourceOut: envelope.sourceOut,
    text: text !== undefined ? String(text) : blockTextFromWords(words),
  };
}

/**
 * @param {import("./block-timeline-adapter.js").Block} block
 * @param {readonly import("./block-timeline-adapter.js").WordBlock[]} words
 */
export function recalcBlockMediaEnvelope(block, words) {
  let min = Infinity;
  let max = -Infinity;
  for (const w of words) {
    if (w.isDeleted && !w.mergedByEdgeTrim) continue;
    const si = Number(w.sourceIn) || 0;
    const so = Math.max(si, Number(w.sourceOut) || si);
    min = Math.min(min, si);
    max = Math.max(max, so);
  }
  if (!Number.isFinite(min)) {
    return {
      sourceIn: Number(block.sourceIn) || 0,
      sourceOut: Math.max(Number(block.sourceIn) || 0, Number(block.sourceOut) || 0),
    };
  }
  return { sourceIn: min, sourceOut: Math.max(min, max) };
}

/**
 * @param {import("./block-timeline-adapter.js").Block} block
 * @param {number} fromWordIndex
 * @param {number} toWordIndexExclusive
 * @returns {{ block: import("./block-timeline-adapter.js").Block | null, becameEmpty: boolean }}
 */
export function shrinkBlockSoftDeleteWordRange(block, fromWordIndex, toWordIndexExclusive) {
  const words = block.words || [];
  if (
    fromWordIndex < 0 ||
    toWordIndexExclusive > words.length ||
    fromWordIndex >= toWordIndexExclusive
  ) {
    return { block, becameEmpty: false };
  }

  let shrinkDur = 0;
  for (let i = fromWordIndex; i < toWordIndexExclusive; i += 1) {
    const w = words[i];
    if (!w || w.isDeleted) return { block, becameEmpty: false };
    shrinkDur += wordBlockVirtualDuration(w);
  }
  if (!(shrinkDur > DELETE_RANGE_MIN_SEC)) return { block, becameEmpty: false };

  const removing = new Set();
  for (let i = fromWordIndex; i < toWordIndexExclusive; i += 1) removing.add(i);

  /** @type {import("./block-timeline-adapter.js").WordBlock[]} */
  const newWords = words.map((w, wi) =>
    removing.has(wi) ? { ...w, isDeleted: true } : w,
  );

  if (blockShouldHardDeleteAfterWordEdit({ ...block, words: newWords })) {
    return { block: null, becameEmpty: true };
  }

  const envelope = recalcBlockMediaEnvelope(block, newWords);
  const prevDur = Math.max(0, Number(block.duration) || 0);
  const nextDur = Math.max(MIN_BLOCK_DURATION_SEC, prevDur - shrinkDur);

  return {
    block: {
      ...block,
      words: newWords,
      duration: nextDur,
      sourceIn: envelope.sourceIn,
      sourceOut: envelope.sourceOut,
      text: blockTextFromWords(newWords),
    },
    becameEmpty: false,
  };
}

/**
 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks
 * @param {number} blockIndex
 * @param {number} fromWordIndex
 * @param {number} toWordIndexExclusive
 * @returns {{ blocks: import("./block-timeline-adapter.js").Block[], hardDeletedBlock: import("./block-timeline-adapter.js").Block | null }}
 */
export function applySoftDeleteWordRangeOnBlocks(blocks, blockIndex, fromWordIndex, toWordIndexExclusive) {
  const block = blocks[blockIndex];
  if (!block) return { blocks, hardDeletedBlock: null };

  const { block: updated, becameEmpty } = shrinkBlockSoftDeleteWordRange(
    block,
    fromWordIndex,
    toWordIndexExclusive,
  );
  if (becameEmpty) {
    return {
      blocks: [...blocks.slice(0, blockIndex), ...blocks.slice(blockIndex + 1)],
      hardDeletedBlock: block,
    };
  }
  if (!updated || updated === block) return { blocks, hardDeletedBlock: null };
  const next = [...blocks];
  next[blockIndex] = updated;
  return { blocks: next, hardDeletedBlock: null };
}

/**
 * @param {import("./block-timeline-adapter.js").Block} left
 * @param {import("./block-timeline-adapter.js").Block} right
 * @param {string} [mergedText]
 */
export function mergeBlockPair(left, right, mergedText) {
  const leftWords = left.words || [];
  const rightWords = right.words || [];
  const mergedWords = [...leftWords, ...rightWords];
  const envelope = recalcBlockMediaEnvelope(left, mergedWords);
  const text = mergedText !== undefined ? String(mergedText) : blockTextFromWords(mergedWords);
  return {
    ...left,
    duration: Math.max(MIN_BLOCK_DURATION_SEC, (Number(left.duration) || 0) + (Number(right.duration) || 0)),
    sourceIn: envelope.sourceIn,
    sourceOut: envelope.sourceOut,
    words: mergedWords.length ? mergedWords : undefined,
    text,
  };
}

/**
 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks
 * @param {number} leftIndex
 * @param {number} rightIndex
 * @param {string} [mergedText]
 */
export function mergeBlocksAt(blocks, leftIndex, rightIndex, mergedText) {
  const left = blocks[leftIndex];
  const right = blocks[rightIndex];
  if (!left || !right || leftIndex === rightIndex) return { blocks, hardDeletedBlock: null };
  const merged = mergeBlockPair(left, right, mergedText);
  const lo = Math.min(leftIndex, rightIndex);
  const hi = Math.max(leftIndex, rightIndex);
  return {
    blocks: [...blocks.slice(0, lo), merged, ...blocks.slice(hi + 1)],
    hardDeletedBlock: null,
  };
}
