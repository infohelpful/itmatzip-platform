/**
 * AutoSubtitle wordMerge.ts (일부)
 */

const EPS = 1e-4;

/**
 * @param {Array<{ start: number, end: number, text: string, isSilence?: boolean, is_silence?: boolean }>} words
 */
export function mergeAdjacentOverlappingWords(words) {
  if (words.length < 2) return words.map((w) => ({ ...w }));
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const out = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = out[out.length - 1];
    const cur = sorted[i];
    if (prev.end > cur.start + EPS) {
      const bothSil = Boolean(prev.isSilence || prev.is_silence) && Boolean(cur.isSilence || cur.is_silence);
      prev.text = bothSil ? `${prev.text}${cur.text}` : `${prev.text} ${cur.text}`.trim();
      prev.end = Math.max(prev.end, cur.end);
      prev.isSilence = bothSil;
      prev.is_silence = bothSil;
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}
