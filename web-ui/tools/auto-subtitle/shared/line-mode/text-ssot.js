/**
 * Line Mode v4 — text SSOT (Python build_cue_text 와 동일 규칙).
 *
 * @param {readonly { word?: string, text?: string }[]} words
 */
export function normalizeTextSSOT(words) {
  const parts = [];
  for (const w of words || []) {
    const t = String(w?.word ?? w?.text ?? "").trim();
    if (t) parts.push(t);
  }
  return parts.join(" ");
}
