/**
 * AutoSubtitle subtitleWordTextSplit.ts
 */

export function splitWordTextAtMediaCut(text, wordStart, wordEnd, cutSec) {
  const g = Array.from(text);
  const n = g.length;
  if (n === 0) return { left: "", right: "" };
  const lo = Math.min(wordStart, wordEnd);
  const hi = Math.max(wordStart, wordEnd);
  const dur = hi - lo;
  if (dur < 1e-9) return { left: "", right: text };
  let t = (cutSec - lo) / dur;
  t = Math.max(0, Math.min(1, t));
  const idx = Math.round(t * n);
  const i = Math.max(0, Math.min(n, idx));
  return { left: g.slice(0, i).join(""), right: g.slice(i).join("") };
}
