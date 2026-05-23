/**
 * AutoSubtitle edlSkipMapping.ts — EDL skip 픽셀↔미디어 축 매핑.
 */

/**
 * @param {{ start: number, end: number }} viewWin
 * @param {readonly { start: number, end: number }[]} skips
 */
export function buildEdlSkipMapping(viewWin, skips) {
  const winStart = Math.min(viewWin.start, viewWin.end);
  const winEnd = Math.max(viewWin.start, viewWin.end);
  const viewSpanSec = Math.max(0, winEnd - winStart);

  /** @type {{ start: number, end: number }[]} */
  const out = [];
  for (const r of skips || []) {
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end)) continue;
    const a = Math.max(winStart, Math.min(r.start, r.end));
    const b = Math.min(winEnd, Math.max(r.start, r.end));
    if (b > a + 1e-9) out.push({ start: a, end: b });
  }
  out.sort((p, q) => p.start - q.start);
  /** @type {{ start: number, end: number }[]} */
  const skipsClipped = [];
  for (const r of out) {
    const last = skipsClipped[skipsClipped.length - 1];
    if (last && r.start <= last.end + 1e-9) {
      last.end = Math.max(last.end, r.end);
    } else {
      skipsClipped.push({ start: r.start, end: r.end });
    }
  }

  let totalSkipSec = 0;
  for (const r of skipsClipped) totalSkipSec += r.end - r.start;
  const activeSpanSec = Math.max(0, viewSpanSec - totalSkipSec);

  function mediaSecToActiveSec(t) {
    if (activeSpanSec <= 0) return 0;
    if (!Number.isFinite(t)) return 0;
    if (t <= winStart) return 0;
    if (t >= winEnd) return activeSpanSec;
    let active = 0;
    let cursor = winStart;
    for (const s of skipsClipped) {
      if (t < s.start) return active + (t - cursor);
      if (t <= s.end) return active + (s.start - cursor);
      active += s.start - cursor;
      cursor = s.end;
    }
    return active + (t - cursor);
  }

  function activeSecToMediaSec(a) {
    if (activeSpanSec <= 0) return winStart;
    if (!Number.isFinite(a)) return winStart;
    if (a <= 0) return winStart;
    if (a >= activeSpanSec) return winEnd;
    let cursor = winStart;
    let remaining = a;
    for (const s of skipsClipped) {
      const segLen = Math.max(0, s.start - cursor);
      if (remaining < segLen) return cursor + remaining;
      if (remaining === segLen) return s.end;
      remaining -= segLen;
      cursor = s.end;
    }
    return cursor + remaining;
  }

  function activeSecToPixel(a, wPx) {
    if (wPx <= 0 || activeSpanSec <= 0) return 0;
    const ratio = Math.max(0, Math.min(1, a / activeSpanSec));
    return ratio * wPx;
  }

  function pixelToActiveSec(x, wPx) {
    if (wPx <= 0 || activeSpanSec <= 0) return 0;
    const ratio = Math.max(0, Math.min(1, x / wPx));
    return ratio * activeSpanSec;
  }

  function mediaSecToPixel(t, wPx) {
    return activeSecToPixel(mediaSecToActiveSec(t), wPx);
  }

  function pixelToMediaSec(x, wPx) {
    return activeSecToMediaSec(pixelToActiveSec(x, wPx));
  }

  return {
    winStart,
    winEnd,
    skipsClipped,
    activeSpanSec,
    viewSpanSec,
    mediaSecToActiveSec,
    activeSecToMediaSec,
    activeSecToPixel,
    pixelToActiveSec,
    mediaSecToPixel,
    pixelToMediaSec,
  };
}
