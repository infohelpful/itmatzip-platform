/**
 * Phase 3D — block split / merge (Tier 3 structural edits).
 */

import { childBlockId } from "./block-ids.js";
import { buildBlockFromWordSubset, blockTextFromWords, mergeBlocksAt } from "./block-word-edit-ops.js?v=2";

const MIN_SEGMENT_SEC = 0.05;
const MIN_BLOCK_DURATION_SEC = 1e-5;

/**
 * @param {import("./block-timeline-adapter.js").Block} block
 * @param {string} leftText
 * @param {string} rightText
 * @param {number} splitMediaSec
 */
function splitBlockByMediaTime(block, leftText, rightText, splitMediaSec) {
  const si = Number(block.sourceIn) || 0;
  const so = Math.max(si, Number(block.sourceOut) || si);
  const span = so - si;
  const dur = Math.max(MIN_BLOCK_DURATION_SEC, Number(block.duration) || span);
  let split = Number(splitMediaSec);
  if (!Number.isFinite(split)) split = si + span / 2;
  split = Math.min(Math.max(split, si + MIN_SEGMENT_SEC), so - MIN_SEGMENT_SEC);
  if (!(split > si && split < so)) split = si + span / 2;

  const leftRatio = span > 0 ? (split - si) / span : 0.5;
  const leftDur = Math.max(MIN_BLOCK_DURATION_SEC, dur * leftRatio);
  const rightDur = Math.max(MIN_BLOCK_DURATION_SEC, dur - leftDur);

  const left = {
    ...block,
    id: block.id,
    sourceIn: si,
    sourceOut: split,
    duration: leftDur,
    text: leftText,
    words: undefined,
  };
  const right = {
    ...block,
    id: childBlockId(block.id, 2),
    sourceIn: split,
    sourceOut: so,
    duration: rightDur,
    text: rightText,
    words: undefined,
  };
  return [left, right];
}

/**
 * @param {import("./block-timeline-adapter.js").Block} block
 * @param {number} wordIndex storage index — right chunk starts here
 * @returns {[import("./block-timeline-adapter.js").Block, import("./block-timeline-adapter.js").Block] | null}
 */
export function splitBlockAtWordIndex(block, wordIndex) {
  const words = block.words || [];
  if (wordIndex <= 0 || wordIndex >= words.length) return null;
  const leftWords = words.slice(0, wordIndex);
  const rightWords = words.slice(wordIndex);
  if (!leftWords.length || !rightWords.length) return null;

  const leftEnd = Number(leftWords[leftWords.length - 1].sourceOut) || 0;
  const rightStart = Number(rightWords[0].sourceIn) || leftEnd;
  let splitMedia = (leftEnd + rightStart) / 2;
  if (!Number.isFinite(splitMedia)) splitMedia = rightStart;
  const si = Number(block.sourceIn) || 0;
  const so = Math.max(si, Number(block.sourceOut) || si);
  splitMedia = Math.min(Math.max(splitMedia, si + MIN_SEGMENT_SEC), so - MIN_SEGMENT_SEC);
  if (!(splitMedia > si && splitMedia < so)) return null;

  const left = buildBlockFromWordSubset(
    block,
    leftWords,
    block.id,
    blockTextFromWords(leftWords),
  );
  const right = buildBlockFromWordSubset(
    block,
    rightWords,
    childBlockId(block.id, 2),
    blockTextFromWords(rightWords),
  );
  left.sourceOut = splitMedia;
  right.sourceIn = splitMedia;
  return [left, right];
}

/**
 * @param {import("./block-timeline-adapter.js").Block} block
 * @param {number} cursorPos character index in block.text
 * @returns {[import("./block-timeline-adapter.js").Block, import("./block-timeline-adapter.js").Block] | null}
 */
export function splitBlockAtTextCursor(block, cursorPos) {
  const text = String(block.text ?? "");
  const si = Number(block.sourceIn) || 0;
  const so = Math.max(si, Number(block.sourceOut) || si);
  const span = so - si;
  if (!(span > MIN_SEGMENT_SEC)) return null;

  const words = block.words || [];
  if (words.length) {
    const clampedCursor = Math.max(0, Math.min(Math.floor(cursorPos), text.length));
    const ratio = text.length === 0 ? 0.5 : clampedCursor / text.length;
    let splitMedia = si + span * ratio;
    splitMedia = Math.min(Math.max(splitMedia, si + MIN_SEGMENT_SEC), so - MIN_SEGMENT_SEC);

    const leftWords = [];
    const rightWords = [];
    for (const w of words) {
      const mid = (Number(w.sourceIn) + Number(w.sourceOut)) / 2;
      if (mid <= splitMedia) leftWords.push(w);
      else rightWords.push(w);
    }
    if (!leftWords.length || !rightWords.length) return null;

    const leftText = text.slice(0, clampedCursor);
    const rightText = text.slice(clampedCursor);
    const left = buildBlockFromWordSubset(block, leftWords, block.id, leftText);
    const right = buildBlockFromWordSubset(
      block,
      rightWords,
      childBlockId(block.id, 2),
      rightText,
    );
    left.sourceOut = splitMedia;
    right.sourceIn = splitMedia;
    return [left, right];
  }

  const clampedCursor = Math.max(0, Math.min(Math.floor(cursorPos), text.length));
  const ratio = text.length === 0 ? 0.5 : clampedCursor / text.length;
  let splitMedia = si + span * ratio;
  splitMedia = Math.min(Math.max(splitMedia, si + MIN_SEGMENT_SEC), so - MIN_SEGMENT_SEC);
  return splitBlockByMediaTime(block, text.slice(0, clampedCursor), text.slice(clampedCursor), splitMedia);
}

/**
 * @param {import("./block-timeline-adapter.js").Block} block
 * @param {readonly number[]} breakAfterStorageIndices
 * @returns {import("./block-timeline-adapter.js").Block[] | null}
 */
export function splitBlockByWordBreaks(block, breakAfterStorageIndices) {
  const words = block.words || [];
  if (!words.length) return null;

  const breaks = [...new Set(breakAfterStorageIndices)]
    .filter((i) => Number.isFinite(i) && i >= 0 && i < words.length - 1)
    .sort((a, b) => a - b);
  if (!breaks.length) return null;

  /** @type {import("./block-timeline-adapter.js").WordBlock[][]} */
  const chunks = [];
  let start = 0;
  for (const end of breaks) {
    if (end >= start) {
      chunks.push(words.slice(start, end + 1));
      start = end + 1;
    }
  }
  if (start < words.length) chunks.push(words.slice(start));
  if (chunks.length <= 1) return null;

  return chunks.map((chunkWords, i) =>
    buildBlockFromWordSubset(
      block,
      chunkWords,
      i === 0 ? block.id : childBlockId(block.id, i + 1),
      blockTextFromWords(chunkWords),
    ),
  );
}

/**
 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks
 * @param {number} blockIndex
 * @returns {import("./block-timeline-adapter.js").Block[] | null}
 */
export function mergeEmptyBlockWithPrevious(blocks, blockIndex) {
  if (blockIndex <= 0 || blockIndex >= blocks.length) return null;
  const cur = blocks[blockIndex];
  if (String(cur.text ?? "").trim().length > 0) return null;
  const result = mergeBlocksAt(blocks, blockIndex - 1, blockIndex);
  return result.blocks;
}

/**
 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks
 * @param {number} blockIndex
 * @param {number} wordIndex
 */
export function spliceSplitBlockAtWordIndex(blocks, blockIndex, wordIndex) {
  const block = blocks[blockIndex];
  if (!block) return { blocks };
  const pair = splitBlockAtWordIndex(block, wordIndex);
  if (!pair) return { blocks };
  return {
    blocks: [...blocks.slice(0, blockIndex), ...pair, ...blocks.slice(blockIndex + 1)],
  };
}

/**
 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks
 * @param {number} blockIndex
 * @param {number} cursorPos
 */
export function spliceSplitBlockAtTextCursor(blocks, blockIndex, cursorPos) {
  const block = blocks[blockIndex];
  if (!block) return { blocks };
  const pair = splitBlockAtTextCursor(block, cursorPos);
  if (!pair) return { blocks };
  return {
    blocks: [...blocks.slice(0, blockIndex), ...pair, ...blocks.slice(blockIndex + 1)],
  };
}

/**
 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks
 * @param {number} blockIndex
 * @param {readonly number[]} breakAfterStorageIndices
 */
export function spliceSplitBlockByWordBreaks(blocks, blockIndex, breakAfterStorageIndices) {
  const block = blocks[blockIndex];
  if (!block) return { blocks };
  const parts = splitBlockByWordBreaks(block, breakAfterStorageIndices);
  if (!parts?.length) return { blocks };
  return {
    blocks: [...blocks.slice(0, blockIndex), ...parts, ...blocks.slice(blockIndex + 1)],
  };
}
