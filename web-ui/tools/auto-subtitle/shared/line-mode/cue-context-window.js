/**
 * Line Mode — 줄(cue) 인라인 파형 3구역: 이전 패딩 | 줄 | 다음 패딩.
 */

export const CUE_WAVEFORM_DEFAULT_PAD_SEC = 1;
export const CUE_WAVEFORM_EXPAND_STEP_SEC = 0.25;
export const CUE_WAVEFORM_MAX_EXTRA_PAD_SEC = 4;

/**
 * @param {{ start?: number, end?: number }} cue
 * @param {number} [mediaDurationSec]
 * @param {number} [expandLeftSec] 추가 왼쪽 확장(초)
 * @param {number} [expandRightSec] 추가 오른쪽 확장(초)
 */
export function computeCueContextWindow(
  cue,
  mediaDurationSec,
  expandLeftSec = 0,
  expandRightSec = 0,
) {
  const lineStart = Number(cue.start) || 0;
  const lineEnd = Math.max(lineStart, Number(cue.end) || lineStart);
  const extraL = Math.max(0, Math.min(CUE_WAVEFORM_MAX_EXTRA_PAD_SEC, Number(expandLeftSec) || 0));
  const extraR = Math.max(0, Math.min(CUE_WAVEFORM_MAX_EXTRA_PAD_SEC, Number(expandRightSec) || 0));
  const padL = CUE_WAVEFORM_DEFAULT_PAD_SEC + extraL;
  const padR = CUE_WAVEFORM_DEFAULT_PAD_SEC + extraR;
  const dur =
    mediaDurationSec != null &&
    Number.isFinite(mediaDurationSec) &&
    mediaDurationSec > 0
      ? mediaDurationSec
      : Number.POSITIVE_INFINITY;

  let windowStart = Math.max(0, lineStart - padL);
  let windowEnd = Math.min(dur, lineEnd + padR);
  if (windowEnd <= windowStart + 1e-6) {
    windowEnd = Math.min(dur, windowStart + 0.12);
  }
  const span = Math.max(windowEnd - windowStart, 1e-6);
  return {
    lineStart,
    lineEnd,
    windowStart,
    windowEnd,
    span,
    padLeft: padL,
    padRight: padR,
    expandLeftSec: extraL,
    expandRightSec: extraR,
  };
}
