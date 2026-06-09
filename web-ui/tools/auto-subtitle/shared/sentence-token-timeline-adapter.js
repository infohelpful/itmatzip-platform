/**
 * SubtitleLine[] ↔ SentenceTokenTimeline (Electron sentenceTokenTimelineAdapter.ts).
 * 변경 없는 줄은 WeakMap으로 reference 유지.
 */

import {
  displayTextFromSubtitleWords,
  lineTextIsUserLocked,
  normalizeSilenceWordsForLineWords,
  subtitleLineEditDisplayText,
  subtitleLineTextDiffersFromWords,
  visibleSubtitleWords,
} from "./subtitles.js?v=24";

/** @typedef {{ id: string, text: string, start_original: number, end_original: number, source_start_original?: number, source_end_original?: number, is_deleted?: boolean, isSilence?: boolean, splitChain?: string }} TimelineToken */
/** @typedef {{ id: string, tokens: TimelineToken[], is_deleted?: boolean, editedDisplayText?: string, lineTextUserEdited?: boolean, line_text_user_edited?: boolean, source_start_original?: number, source_end_original?: number }} TimelineSentence */
/** @typedef {TimelineSentence[]} SentenceTokenTimeline */

/** @type {WeakMap<object, TimelineSentence>} */
const lineToSentence = new WeakMap();
/** @type {WeakMap<object, object>} */
const sentenceToLine = new WeakMap();

function sentenceIdForLineIndex(li) {
  return `sub-${li}`;
}

function tokenIdFor(li, wi) {
  return `tok-${li}-${wi}`;
}

/**
 * @param {import("./subtitles.js").SubtitleLine} line
 * @param {number} li
 */
function buildSentenceFromLine(line, li) {
  const words = line.words;
  if (words?.length) {
    const tokens = words.map((w, wi) => {
      /** @type {TimelineToken} */
      const t = {
        id: tokenIdFor(li, wi),
        text: w.word,
        start_original: w.start,
        end_original: w.end,
      };
      const wss = Number(w.sourceStart ?? w.source_start);
      const wse = Number(w.sourceEnd ?? w.source_end);
      if (Number.isFinite(wss)) t.source_start_original = wss;
      if (Number.isFinite(wse)) t.source_end_original = wse;
      if (w.is_deleted || w.isDeleted) t.is_deleted = true;
      if (w.is_silence || w.isSilence) t.isSilence = true;
      if (w.split_chain || w.splitChain) t.splitChain = w.split_chain || w.splitChain;
      return t;
    });
    /** @type {TimelineSentence} */
    const sentence = {
      id: sentenceIdForLineIndex(li),
      tokens,
      is_deleted: line.is_deleted || line.isDeleted ? true : false,
    };
    if (lineTextIsUserLocked(line) || subtitleLineTextDiffersFromWords(line)) {
      sentence.editedDisplayText = subtitleLineEditDisplayText(line);
    }
    if (lineTextIsUserLocked(line)) {
      sentence.lineTextUserEdited = true;
      sentence.line_text_user_edited = true;
    }
    const lss = Number(line.sourceStart ?? line.source_start);
    const lse = Number(line.sourceEnd ?? line.source_end);
    if (Number.isFinite(lss)) sentence.source_start_original = lss;
    if (Number.isFinite(lse)) sentence.source_end_original = lse;
    return sentence;
  }
  return {
    id: sentenceIdForLineIndex(li),
    tokens: [
      {
        id: tokenIdFor(li, 0),
        text: String(line.text ?? "").trim() || " ",
        start_original: line.start,
        end_original: line.end,
      },
    ],
    is_deleted: line.is_deleted || line.isDeleted ? true : false,
  };
}

/**
 * @param {TimelineSentence} sentence
 */
function buildLineFromSentence(sentence) {
  const raw = sentence.tokens;
  if (!raw.length) return null;

  const wordsRaw = raw.map((t) => {
    /** @type {import("./subtitles.js").SubtitleWord} */
    const w = {
      start: t.start_original,
      end: t.end_original,
      word: t.text,
    };
    if (Number.isFinite(t.source_start_original)) {
      w.sourceStart = t.source_start_original;
      w.source_start = t.source_start_original;
    }
    if (Number.isFinite(t.source_end_original)) {
      w.sourceEnd = t.source_end_original;
      w.source_end = t.source_end_original;
    }
    if (t.is_deleted) {
      w.is_deleted = true;
      w.isDeleted = true;
    }
    if (t.isSilence) {
      w.is_silence = true;
      w.isSilence = true;
    }
    if (t.splitChain) w.split_chain = t.splitChain;
    return w;
  });

  const words = normalizeSilenceWordsForLineWords(wordsRaw);
  const vis = visibleSubtitleWords(words);
  const start =
    vis.length > 0 ? Math.min(...vis.map((w) => w.start)) : Math.min(...words.map((w) => w.start));
  const end =
    vis.length > 0 ? Math.max(...vis.map((w) => w.end)) : Math.max(...words.map((w) => w.end));
  const text =
    typeof sentence.editedDisplayText === "string" && sentence.editedDisplayText.trim()
      ? sentence.editedDisplayText.trim()
      : displayTextFromSubtitleWords(words);

  /** @type {import("./subtitles.js").SubtitleLine} */
  const line = {
    start,
    end: Math.max(start + 0.1, end),
    text,
    words,
  };
  if (sentence.is_deleted) {
    line.is_deleted = true;
    line.isDeleted = true;
  }
  if (sentence.lineTextUserEdited || sentence.line_text_user_edited) {
    line.lineTextUserEdited = true;
    line.line_text_user_edited = true;
  }
  if (Number.isFinite(sentence.source_start_original)) {
    line.sourceStart = sentence.source_start_original;
    line.source_start = sentence.source_start_original;
  }
  if (Number.isFinite(sentence.source_end_original)) {
    line.sourceEnd = sentence.source_end_original;
    line.source_end = sentence.source_end_original;
  }
  return line;
}

/**
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 * @returns {SentenceTokenTimeline}
 */
export function subtitleLinesToSentenceTokenTimeline(lines) {
  const out = [];
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    const cached = lineToSentence.get(line);
    if (cached !== undefined) {
      out.push(cached);
      continue;
    }
    const sentence = buildSentenceFromLine(line, li);
    lineToSentence.set(line, sentence);
    sentenceToLine.set(sentence, line);
    out.push(sentence);
  }
  return out;
}

/**
 * @param {SentenceTokenTimeline} timeline
 * @returns {import("./subtitles.js").SubtitleLine[]}
 */
export function sentenceTokenTimelineToSubtitleLines(timeline) {
  const result = [];
  for (const sentence of timeline) {
    const cached = sentenceToLine.get(sentence);
    if (cached !== undefined) {
      result.push(cached);
      continue;
    }
    const line = buildLineFromSentence(sentence);
    if (line === null) continue;
    sentenceToLine.set(sentence, line);
    lineToSentence.set(line, sentence);
    result.push(line);
  }
  return result;
}

/**
 * @param {import("./subtitles.js").SubtitleLine[]} lines
 */
export function commitSubtitleLinesThroughTimeline(lines) {
  const timeline = subtitleLinesToSentenceTokenTimeline(lines);
  return sentenceTokenTimelineToSubtitleLines(timeline);
}
