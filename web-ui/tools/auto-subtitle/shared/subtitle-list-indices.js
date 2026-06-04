/**
 * 자막 카드 목록에 표시되는 cue 인덱스 (SSOT).
 * 표시 IDX(1,2,3…)는 이 배열의 순서 + 1.
 */

/** @param {readonly object[]} cues */
export function listableCueIndices(cues) {
  const out = [];
  for (let i = 0; i < (cues || []).length; i += 1) {
    const cue = cues[i];
    if (cue.is_deleted || cue.isDeleted) continue;
    const start = Number(cue.start) || 0;
    const end = Number(cue.end) || 0;
    const hasSpan = end > start + 1e-6;
    if (cue.is_silence || cue.isSilence) {
      if (hasSpan) out.push(i);
      continue;
    }
    if (!String(cue.text || "").trim() && !(cue.words?.length)) continue;
    out.push(i);
  }
  return out;
}

/**
 * @param {readonly object[]} cues
 * @param {number} fromListPos
 * @param {number} toListPos 목록에서의 최종 위치(0..n-1)
 */
export function reorderCuesByListPosition(cues, fromListPos, toListPos) {
  const indices = listableCueIndices(cues);
  const n = indices.length;
  if (
    fromListPos < 0 ||
    toListPos < 0 ||
    fromListPos >= n ||
    toListPos >= n ||
    fromListPos === toListPos
  ) {
    return cues;
  }
  const fromCueIndex = indices[fromListPos];
  const next = [...cues];
  const [item] = next.splice(fromCueIndex, 1);
  const after = listableCueIndices(next);
  if (toListPos >= after.length) {
    const lastIdx = after[after.length - 1];
    const insertAt = lastIdx === undefined ? next.length : lastIdx + 1;
    next.splice(insertAt, 0, item);
    return next;
  }
  const insertAt = after[toListPos];
  next.splice(insertAt, 0, item);
  return next;
}

/**
 * @param {readonly object[]} cues
 * @param {number} fromListPos
 * @param {number} insertBeforePos 0=맨 앞, length=맨 뒤
 */
export function reorderCuesByListInsert(cues, fromListPos, insertBeforePos) {
  const indices = listableCueIndices(cues);
  const n = indices.length;
  let target = Math.max(0, Math.min(insertBeforePos, n));
  if (fromListPos < 0 || fromListPos >= n) return cues;
  if (fromListPos < target) target -= 1;
  if (fromListPos === target) return cues;
  return reorderCuesByListPosition(cues, fromListPos, target);
}

/**
 * 목록(표시 IDX) 순서 기준 다음 재생 가능 cue 인덱스.
 * @param {readonly object[]} cues
 * @param {number} cueIndex
 */
export function nextListableCueIndex(cues, cueIndex) {
  const indices = listableCueIndices(cues);
  const pos = indices.indexOf(cueIndex);
  if (pos < 0 || pos >= indices.length - 1) return -1;
  return indices[pos + 1];
}

/**
 * @param {readonly object[]} cues
 * @param {number} cueIndex
 */
export function prevListableCueIndex(cues, cueIndex) {
  const indices = listableCueIndices(cues);
  const pos = indices.indexOf(cueIndex);
  if (pos <= 0) return -1;
  return indices[pos - 1];
}
