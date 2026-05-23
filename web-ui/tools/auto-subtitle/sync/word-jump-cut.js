/**
 * AutoSubtitle wordJumpCut.ts
 */

import {
  findBlockIndexByRealMs,
  nextBlockIndexInVirtualOrder,
} from "./block-mapping.js";

/**
 * @typedef {import("./block-mapping.js").VirtualBlockMs & { isDeleted?: boolean }} WordTimelineBlockMs
 */

/**
 * @param {readonly WordTimelineBlockMs[]} blocks
 */
export function playbackWordBlocks(blocks) {
  return [...blocks]
    .filter((b) => b.isDeleted !== true)
    .sort((a, b) => a.vStartMs - b.vStartMs || a.oStartMs - b.oStartMs)
    .map(({ isDeleted: _d, ...rest }) => rest);
}

/**
 * @param {number} realTimeMs
 * @param {readonly import("./block-mapping.js").VirtualBlockMs[]} blocksByV
 * @param {readonly import("./block-mapping.js").VirtualBlockMs[]} blocksByO
 * @param {number} tailMs
 * @param {number} deadbandSec
 */
export function checkJumpCutAtRealMs(realTimeMs, blocksByV, blocksByO, tailMs, deadbandSec) {
  if (blocksByV.length < 2) return null;

  const iv = findBlockIndexByRealMs(realTimeMs, blocksByO);
  if (iv < 0) return null;
  const b = blocksByO[iv];
  if (realTimeMs < b.oEndMs - tailMs) return null;

  const curIdx = blocksByV.indexOf(b);
  if (curIdx < 0) return null;
  const nextIdx = nextBlockIndexInVirtualOrder(blocksByV, curIdx);
  if (nextIdx == null) return null;
  const nb = blocksByV[nextIdx];
  const targetSec = Math.max(0, nb.oStartMs / 1000 + deadbandSec);
  return { targetSec };
}
