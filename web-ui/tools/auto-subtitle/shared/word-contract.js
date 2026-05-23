/**
 * AutoSubtitle wordContract.ts — 단어 타임라인 데이터 계약.
 */

/** @typedef {{ start: number, end: number, word: string, is_silence?: boolean, is_deleted?: boolean, isSilence?: boolean, isDeleted?: boolean, merged_by_edge_trim?: boolean, mergedByEdgeTrim?: boolean, split_chain?: string, splitChain?: string }} SubtitleWordLike */

export const FLOAT_EPS = 1e-4;
export const DEFAULT_GAP_THRESHOLD_SEC = 0.2;
export const SILENCE_PLACEHOLDER_TEXT = "--";
export const CONTINUATION_ELLIPSIS_TOKEN = "\u2026";

export function shouldOmitFromSubtitleEditLineText(word) {
  const t = String(word ?? "").trim();
  if (t.length === 0) return true;
  if (t === SILENCE_PLACEHOLDER_TEXT) return true;
  if (t === "??") return true;
  if (t === "-") return true;
  if (t === CONTINUATION_ELLIPSIS_TOKEN) return true;
  if (/^\.{2,}$/.test(t)) return true;
  return false;
}

export function scrubTimelineNoiseFromWordPiece(text) {
  let t = String(text ?? "").trim();
  if (t.length === 0 || shouldOmitFromSubtitleEditLineText(t)) return "";
  for (let i = 0; i < 6; i += 1) {
    const prev = t;
    t = t
      .replace(/[\s\u00A0]*(?:\.{2,}|…|\u2026)+$/u, "")
      .replace(/^(?:\.{2,}|…|\u2026)+[\s\u00A0]*/u, "")
      .replace(/[\s\u00A0]*-{2,}$/u, "")
      .replace(/^-{2,}[\s\u00A0]*/u, "")
      .trim();
    if (t === prev) break;
  }
  if (shouldOmitFromSubtitleEditLineText(t)) return "";
  return t;
}

/**
 * @param {readonly { text: string, isSilence?: boolean, is_silence?: boolean }[]} words
 */
export function lineEditDisplayFromVrewWordParts(words) {
  return words
    .filter((w) => !(w.isSilence || w.is_silence))
    .map((w) => scrubTimelineNoiseFromWordPiece(w.text))
    .filter((piece) => piece.length > 0)
    .join(" ")
    .trim();
}

function pushSilenceSegment(pieces, start, end, threshold) {
  if (!(end - start >= threshold - FLOAT_EPS)) return;
  if (end <= start + FLOAT_EPS) return;
  pieces.push({
    start,
    end,
    word: SILENCE_PLACEHOLDER_TEXT,
    is_silence: true,
    isSilence: true,
  });
}

function mergeAdjacentSilences(words) {
  if (words.length < 2) return words;
  const out = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    if (
      prev &&
      (prev.is_silence || prev.isSilence) &&
      (w.is_silence || w.isSilence) &&
      Math.abs(w.start - prev.end) < FLOAT_EPS
    ) {
      prev.end = w.end;
    } else {
      out.push({ ...w });
    }
  }
  return out;
}

/**
 * @param {{ start: number, end: number, words: SubtitleWordLike[] }} line
 * @param {{ gapThresholdSec?: number, includeLineBoundaries?: boolean, stripPreviousSilences?: boolean }} [options]
 */
export function fillGapsInSubtitleWords(line, options = {}) {
  const threshold = options.gapThresholdSec ?? DEFAULT_GAP_THRESHOLD_SEC;
  const includeLineBoundaries = options.includeLineBoundaries ?? true;
  const stripPreviousSilences = options.stripPreviousSilences ?? true;

  const nonDeleted = line.words.filter((w) => !(w.is_deleted || w.isDeleted));
  const raw = stripPreviousSilences
    ? nonDeleted.filter((w) => !(w.is_silence || w.isSilence))
    : [...nonDeleted];

  const cleaned = raw
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start + FLOAT_EPS)
    .map((w) => ({
      start: w.start,
      end: w.end,
      word: typeof w.word === "string" ? w.word.trim() : "",
    }))
    .filter((w) => w.word.length > 0);

  cleaned.sort((a, b) => a.start - b.start || a.end - b.end);

  if (cleaned.length === 0) return [];

  /** @type {SubtitleWordLike[]} */
  const pieces = [];

  if (includeLineBoundaries) {
    pushSilenceSegment(pieces, line.start, cleaned[0].start, threshold);
  }

  for (let i = 0; i < cleaned.length; i += 1) {
    pieces.push({
      start: cleaned[i].start,
      end: cleaned[i].end,
      word: cleaned[i].word,
      is_silence: false,
      is_deleted: false,
    });
    if (i < cleaned.length - 1) {
      const a = cleaned[i];
      const b = cleaned[i + 1];
      if (b.start > a.end + FLOAT_EPS) {
        pushSilenceSegment(pieces, a.end, b.start, threshold);
      }
    }
  }

  if (includeLineBoundaries) {
    const last = cleaned[cleaned.length - 1];
    pushSilenceSegment(pieces, last.end, line.end, threshold);
  }

  return mergeAdjacentSilences(pieces);
}
