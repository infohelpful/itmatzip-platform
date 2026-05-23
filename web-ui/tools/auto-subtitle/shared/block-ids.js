/**
 * AutoSubtitle blockIds.ts
 */

export function makeRowWordBlockId(group1Based, slot1Based) {
  return `block_${group1Based}_${slot1Based}`;
}

export function childBlockId(parentId, part1Based) {
  return `${parentId}_${part1Based}`;
}

/**
 * @template T extends { id: string }
 * @param {T[]} words
 * @param {number} group1Based
 */
export function assignSequentialBlockIds(words, group1Based) {
  return words.map((w, wi) => ({ ...w, id: makeRowWordBlockId(group1Based, wi + 1) }));
}
