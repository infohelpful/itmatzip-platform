/**
 * AutoSubtitle timelineCollapse.ts — 컷 병합·시간 스냅·미디어↔편집 축 매핑.
 */

const SNAP_SEC = 1e-5;
const EPS = 1e-9;

export function snapTimelineSec(t) {
  if (!Number.isFinite(t)) return 0;
  return Math.round(t / SNAP_SEC) * SNAP_SEC;
}

/**
 * @param {readonly { start: number, end: number }[]} ranges
 */
export function mergeCutRanges(ranges) {
  const sorted = [...(ranges || [])]
    .map((r) => ({ start: snapTimelineSec(r.start), end: snapTimelineSec(r.end) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return [];
  if (sorted.length === 1) return [sorted[0]];
  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = sorted[i];
    const last = out[out.length - 1];
    if (cur.start <= last.end + 0.001) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/**
 * @param {number} t
 * @param {readonly { start: number, end: number }[]} cuts
 */
export function mediaToEditTime(t, cuts) {
  if (!cuts?.length || !Number.isFinite(t)) return t;
  const merged = mergeCutRanges(cuts);
  let removed = 0;
  for (const c of merged) {
    if (c.end <= t + EPS) {
      removed += c.end - c.start;
    } else if (c.start + EPS < t) {
      removed += t - c.start;
      break;
    } else {
      break;
    }
  }
  return t - removed;
}

/**
 * @param {number} editT
 * @param {readonly { start: number, end: number }[]} cuts
 */
export function editToMediaTime(editT, cuts) {
  if (!cuts?.length || !Number.isFinite(editT)) return editT;
  const merged = mergeCutRanges(cuts);
  let extra = 0;
  let maxMediaEnd = 0;
  for (const c of merged) {
    extra += c.end - c.start;
    maxMediaEnd = Math.max(maxMediaEnd, c.end);
  }
  let hi = Math.max(editT + extra + 1, maxMediaEnd + extra + 10, editT * 2 + extra + 10, maxMediaEnd * 2 + 60);
  let lo = 0;
  for (let i = 0; i < 96; i += 1) {
    const mid = (lo + hi) / 2;
    if (mediaToEditTime(mid, merged) < editT - EPS) lo = mid;
    else hi = mid;
  }
  return snapTimelineSec(hi);
}
