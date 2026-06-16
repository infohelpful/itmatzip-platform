/** @typedef {null | 0.3 | 0.5} PlayTailOffsetSec */

export const PLAY_TAIL_OFFSET_OPTIONS = [0.3, 0.5];

/** @type {PlayTailOffsetSec} */
let activeOffset = null;

/** @type {Set<(offset: PlayTailOffsetSec) => void>} */
const listeners = new Set();

/** @returns {PlayTailOffsetSec} */
export function getPlayTailOffsetSec() {
  return activeOffset;
}

/**
 * @param {number} sec
 * @returns {PlayTailOffsetSec}
 */
export function togglePlayTailOffset(sec) {
  const next = sec === 0.3 || sec === 0.5 ? sec : null;
  if (next == null) return activeOffset;
  activeOffset = activeOffset === next ? null : next;
  for (const fn of listeners) fn(activeOffset);
  return activeOffset;
}

/** @param {(offset: PlayTailOffsetSec) => void} fn */
export function onPlayTailOffsetChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 줄 파형 재생 시작 시각 — tail 옵션 켜면 끝에서 N초 전.
 *
 * @param {{ start: number, end: number }} editRange
 * @param {number | null} playSec
 * @param {number | null | undefined} playheadEdit
 * @param {PlayTailOffsetSec} tailOffsetSec
 * @param {number} [cutEps]
 */
export function resolveLineWaveformPlayStart(
  editRange,
  playSec,
  playheadEdit,
  tailOffsetSec,
  cutEps = 1e-4,
) {
  const s = Math.min(editRange.start, editRange.end);
  const e = Math.max(editRange.start, editRange.end);
  if (tailOffsetSec != null && tailOffsetSec > 0) {
    return Math.max(s + cutEps, Math.min(e - cutEps, e - tailOffsetSec));
  }
  let startT = playSec ?? s;
  if (
    Number.isFinite(playheadEdit) &&
    playheadEdit > s + cutEps &&
    playheadEdit < e - cutEps
  ) {
    startT = playheadEdit;
  }
  if (startT >= e - 0.05) startT = s;
  return startT;
}
