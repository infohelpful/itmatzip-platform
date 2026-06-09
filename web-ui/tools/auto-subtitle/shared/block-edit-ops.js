/**
 * Phase 3B — blocks[] list-order splice (listPos ↔ storage index via derived cues).
 */

import { reorderCuesByListInsert, reorderCuesByListPosition } from "./subtitle-list-indices.js?v=6";

/**
 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks
 * @param {readonly import("./subtitles.js").SubtitleLine[]} cues
 */
function blocksInCueOrder(blocks, cues) {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  /** @type {import("./block-timeline-adapter.js").Block[]} */
  const next = [];
  for (let i = 0; i < cues.length; i += 1) {
    const line = cues[i];
    const id = line?.blockId;
    if (id && byId.has(id)) {
      next.push(byId.get(id));
      continue;
    }
    if (blocks[i]) next.push(blocks[i]);
  }
  if (next.length !== blocks.length) return [...blocks];
  return next;
}

/**
 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks
 * @param {readonly import("./subtitles.js").SubtitleLine[]} cues
 * @param {number} fromListPos
 * @param {number} toListPos
 */
export function reorderBlocksByListPosition(blocks, cues, fromListPos, toListPos) {
  const reorderedCues = reorderCuesByListPosition(cues, fromListPos, toListPos);
  if (reorderedCues === cues) return blocks;
  return blocksInCueOrder(blocks, reorderedCues);
}

/**
 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks
 * @param {readonly import("./subtitles.js").SubtitleLine[]} cues
 * @param {number} fromListPos
 * @param {number} insertBeforePos
 */
export function reorderBlocksByListInsert(blocks, cues, fromListPos, insertBeforePos) {
  const reorderedCues = reorderCuesByListInsert(cues, fromListPos, insertBeforePos);
  if (reorderedCues === cues) return blocks;
  return blocksInCueOrder(blocks, reorderedCues);
}
