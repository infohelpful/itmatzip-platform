/**
 * AutoSubtitle subtitleWordCaretMap.ts
 */

import { wordIsDeleted, wordVisibleInWordChipRail } from "./subtitles.js?v=28";

/** @param {readonly import("./subtitles.js").SubtitleWord[] | undefined} words */
export function nearestValidStorageCaret(words, caret) {
  if (!words?.length) return 0;
  const n = words.length;
  let c = Math.max(0, Math.min(caret, n));

  const boundaryOk = (pos) => {
    if (pos === 0 || pos === n) return true;
    const leftAlive = wordVisibleInWordChipRail(words[pos - 1]);
    const rightAlive = wordVisibleInWordChipRail(words[pos]);
    return leftAlive || rightAlive;
  };

  if (boundaryOk(c)) return c;
  for (let d = 1; d <= n; d += 1) {
    const candidates = [];
    if (c - d >= 0 && boundaryOk(c - d)) candidates.push(c - d);
    if (c + d <= n && boundaryOk(c + d)) candidates.push(c + d);
    if (candidates.length > 0) return Math.min(...candidates);
  }
  return 0;
}

export function renderableCaretToStorageCaret(words, renderableCaret) {
  const n = words.length;
  let need = Math.max(0, renderableCaret);
  for (let i = 0; i <= n; i += 1) {
    if (i === n) return n;
    if (wordVisibleInWordChipRail(words[i])) {
      if (need === 0) return i;
      need -= 1;
    }
  }
  return n;
}

export function storageCaretToRenderableCaret(words, storageCaret) {
  const n = words.length;
  const c = Math.max(0, Math.min(storageCaret, n));
  let r = 0;
  for (let i = 0; i < c; i += 1) {
    if (wordVisibleInWordChipRail(words[i])) r += 1;
  }
  return r;
}

export function visibleWordStorageIndices(words) {
  if (!words) return [];
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    if (wordVisibleInWordChipRail(words[i])) out.push(i);
  }
  return out;
}

/** ???????????? ????? storage caret ?? */
export function stepStorageCaretByRenderable(words, storageCaret, deltaRenderable) {
  const rc = storageCaretToRenderableCaret(words, storageCaret);
  const m = visibleWordStorageIndices(words).length;
  const nextRc = Math.max(0, Math.min(m, rc + deltaRenderable));
  return renderableCaretToStorageCaret(words, nextRc);
}
