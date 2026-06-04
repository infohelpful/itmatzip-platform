/**
 * AutoSubtitle buildMappedSubtitles / remapTimeByCuts — 웹 보내기용.
 */

/** @param {readonly { start: number, end: number }[]} ranges */
export function normalizeCutRanges(ranges) {
  const sorted = (ranges || [])
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .map((r) => ({ start: Math.max(0, r.start), end: Math.max(0, r.end) }))
    .sort((a, b) => a.start - b.start);
  if (sorted.length <= 1) return sorted;
  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = sorted[i];
    const last = out[out.length - 1];
    if (cur.start <= last.end + 0.001) last.end = Math.max(last.end, cur.end);
    else out.push({ ...cur });
  }
  return out;
}

/** @param {number} sec @param {readonly { start: number, end: number }[]} cuts */
export function remapTimeByCuts(sec, cuts) {
  let shift = 0;
  for (const c of cuts || []) {
    if (sec >= c.end) shift += c.end - c.start;
    else if (sec > c.start) shift += sec - c.start;
    else break;
  }
  return Math.max(0, sec - shift);
}

/**
 * @param {readonly { start: number, end: number, text: string }[]} subtitles
 * @param {readonly { start: number, end: number }[]} cuts
 */
export function buildMappedSubtitles(subtitles, cuts) {
  const normalized = normalizeCutRanges(cuts);
  const out = [];
  for (const item of subtitles || []) {
    const mappedStart = remapTimeByCuts(Number(item.start), normalized);
    const mappedEnd = remapTimeByCuts(Number(item.end), normalized);
    if (!(mappedEnd > mappedStart + 0.01)) continue;
    const text = String(item.text ?? "").trim();
    if (!text) continue;
    out.push({ start: mappedStart, end: mappedEnd, text });
  }
  return normalizeMappedSubtitles(out);
}

/** 번인 오버레이 프레임 간 짧은 무자막 깜박임 방지 (~2프레임 @30fps) */
export const EXPORT_CUE_BRIDGE_SEC = 0.07;

/** @param {readonly { start: number, end: number, text: string }[]} subtitles */
export function normalizeMappedSubtitles(subtitles) {
  if (!subtitles || subtitles.length <= 1) return [...(subtitles || [])];
  const sorted = [...subtitles].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const cur of sorted) {
    const text = String(cur.text || "").trim();
    if (!text) continue;
    if (out.length === 0) {
      if (cur.end > cur.start + 0.02) out.push({ ...cur, text });
      continue;
    }
    const last = out[out.length - 1];
    const gap = cur.start - last.end;
    let nextStart = cur.start;
    if (nextStart < last.end) {
      nextStart = last.end;
    } else if (gap > 0 && gap < EXPORT_CUE_BRIDGE_SEC) {
      nextStart = last.end;
    }
    if (cur.end <= nextStart + 0.01) continue;
    out.push({ start: nextStart, end: cur.end, text });
  }
  return out;
}

/** @param {number} fullW @param {number} fullH */
export function getSubtitleRenderDimensions(fullW, fullH) {
  let w = Math.max(16, Math.round(fullW));
  let h = Math.max(16, Math.round(fullH));
  const maxW = 1920;
  const maxH = 1080;
  if (w <= maxW && h <= maxH) return { width: w, height: h };
  const ratio = Math.min(maxW / w, maxH / h);
  return {
    width: Math.max(16, Math.round(w * ratio)),
    height: Math.max(16, Math.round(h * ratio)),
  };
}
