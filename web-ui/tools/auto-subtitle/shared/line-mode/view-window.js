/**
 * Line Mode — 선택 Cue 주변 줌 윈도우 (미디어 초).
 */

/**
 * @param {{ start?: number, end?: number }} cue
 * @param {number} mediaDur
 */
export function computeCueViewWindow(cue, mediaDur) {
  const start = Number(cue.start) || 0;
  const end = Math.max(start, Number(cue.end) || start);
  const span = Math.max(end - start, 0.08);
  const pad = Math.max(2, span * 2);
  let viewStart = Math.max(0, start - pad);
  let viewEnd = Math.min(mediaDur > 0 ? mediaDur : end + pad, end + pad);
  if (viewEnd - viewStart < 4) {
    const mid = (start + end) / 2;
    viewStart = Math.max(0, mid - 2);
    viewEnd = Math.min(mediaDur > 0 ? mediaDur : mid + 2, mid + 2);
  }
  if (viewEnd <= viewStart) viewEnd = viewStart + 4;
  return { viewStart, viewEnd, cueStart: start, cueEnd: end };
}
