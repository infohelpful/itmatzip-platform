/**
 * Line Mode v4 — Whisper word → hint SSOT mapping.
 */

import { normalizeTextSSOT } from "./text-ssot.js";

/**
 * @param {unknown} raw
 */
function wordText(raw) {
  if (!raw || typeof raw !== "object") return "";
  const w = /** @type {{ word?: string, text?: string }} */ (raw);
  return String(w.word ?? w.text ?? "").trim();
}

/**
 * @param {unknown} raw
 */
function hintStart(raw) {
  if (!raw || typeof raw !== "object") return 0;
  const w = /** @type {Record<string, unknown>} */ (raw);
  const v = w.hintStart ?? w.hint_start ?? w.start;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {unknown} raw
 */
function hintEnd(raw) {
  if (!raw || typeof raw !== "object") return hintStart(raw);
  const w = /** @type {Record<string, unknown>} */ (raw);
  const v = w.hintEnd ?? w.hint_end ?? w.end;
  const n = Number(v);
  const hs = hintStart(raw);
  return Number.isFinite(n) ? n : hs;
}

/**
 * @param {readonly unknown[]} rawWords
 */
export function mapWhisperWords(rawWords) {
  /** @type {Array<{ word: string, start: number, end: number, hintStart: number, hintEnd: number, gap?: number }>} */
  const out = [];
  for (const raw of rawWords || []) {
    const text = wordText(raw);
    if (!text || text === "--") continue;
    let hs = hintStart(raw);
    let he = hintEnd(raw);
    if (he < hs) he = hs;
    out.push({
      word: text,
      start: hs,
      end: he,
      hintStart: hs,
      hintEnd: he,
    });
  }
  let prevEnd = null;
  for (const item of out) {
    item.gap = prevEnd == null ? 0 : Math.max(0, item.hintStart - prevEnd);
    prevEnd = item.hintEnd;
  }
  return out;
}

/**
 * @param {readonly { words?: unknown[], text?: string, start?: number, end?: number }[]} subtitles
 */
export function flattenWordsFromSubtitles(subtitles) {
  /** @type {unknown[]} */
  const stream = [];
  for (const cue of subtitles || []) {
    const words = cue?.words;
    if (Array.isArray(words) && words.length) {
      stream.push(...words);
    } else {
      const text = String(cue?.text ?? "").trim();
      if (!text || text === "--") continue;
      const hs = Number(cue?.start) || 0;
      const he = Number(cue?.end) || hs;
      stream.push({ word: text, start: hs, end: he });
    }
  }
  return mapWhisperWords(stream);
}

/**
 * @param {ReturnType<typeof mapWhisperWords>} words
 * @param {{ autoReflow?: boolean }} [opts]
 */
export function createCueFromWords(words, opts = {}) {
  if (!words?.length) throw new Error("empty cue");
  const start = words[0].hintStart;
  const end = words[words.length - 1].hintEnd;
  return {
    start,
    end,
    text: normalizeTextSSOT(words),
    words: words.map((w) => ({
      word: w.word,
      start: w.hintStart,
      end: w.hintEnd,
      hintStart: w.hintStart,
      hintEnd: w.hintEnd,
    })),
    flags: { userMoved: false, autoReflow: opts.autoReflow === true },
  };
}
