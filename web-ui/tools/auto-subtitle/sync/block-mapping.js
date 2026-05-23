/**
 * AutoSubtitle blockMapping.ts — 가상↔원본 ms 블록 매핑.
 */

/**
 * @typedef {{ vStartMs: number, vEndMs: number, oStartMs: number, oEndMs: number }} VirtualBlockMs
 */

export function assertSortedByVirtual(blocks) {
  for (let i = 1; i < blocks.length; i += 1) {
    if (blocks[i].vStartMs < blocks[i - 1].vStartMs) {
      throw new Error("virtual_blocks must be sorted by vStartMs ascending");
    }
  }
}

export function assertSortedByOriginal(blocks) {
  for (let i = 1; i < blocks.length; i += 1) {
    if (blocks[i].oStartMs < blocks[i - 1].oStartMs) {
      throw new Error("virtual_blocks must be sorted by oStartMs ascending");
    }
  }
}

/**
 * @param {number} virtualTimeMs
 * @param {readonly VirtualBlockMs[]} blocks
 */
export function findBlockIndex(virtualTimeMs, blocks) {
  const t = Math.floor(virtualTimeMs);
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = blocks[mid];
    if (t < b.vStartMs) hi = mid - 1;
    else if (t >= b.vEndMs) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * @param {number} realTimeMs
 * @param {readonly VirtualBlockMs[]} blocks
 */
export function findBlockIndexByRealMs(realTimeMs, blocks) {
  const t = Math.floor(realTimeMs);
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = blocks[mid];
    if (t < b.oStartMs) hi = mid - 1;
    else if (t >= b.oEndMs) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * @param {number} virtualTimeMs
 * @param {readonly VirtualBlockMs[]} blocks
 */
export function mapV2R(virtualTimeMs, blocks) {
  const i = findBlockIndex(virtualTimeMs, blocks);
  if (i < 0) return null;
  const b = blocks[i];
  return b.oStartMs + (virtualTimeMs - b.vStartMs);
}

/**
 * @param {number} realTimeMs
 * @param {readonly VirtualBlockMs[]} blocksByOriginal
 */
export function mapR2V(realTimeMs, blocksByOriginal) {
  const i = findBlockIndexByRealMs(realTimeMs, blocksByOriginal);
  if (i < 0) return null;
  const b = blocksByOriginal[i];
  return b.vStartMs + (realTimeMs - b.oStartMs);
}

/**
 * @param {readonly VirtualBlockMs[]} blocksSortedByV
 * @param {number} currentIndex
 */
export function nextBlockIndexInVirtualOrder(blocksSortedByV, currentIndex) {
  if (currentIndex < 0 || currentIndex >= blocksSortedByV.length - 1) return null;
  return currentIndex + 1;
}
