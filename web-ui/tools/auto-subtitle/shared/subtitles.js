/**
 * AutoSubtitle subtitles.ts — SubtitleLine / SubtitleWord SSOT.
 */

import {
  FLOAT_EPS,
  SILENCE_PLACEHOLDER_TEXT,
  CONTINUATION_ELLIPSIS_TOKEN,
  scrubTimelineNoiseFromWordPiece,
  shouldOmitFromSubtitleEditLineText,
} from "./word-contract.js";

/**
 * @typedef {{ start: number, end: number, word: string, is_silence?: boolean, is_deleted?: boolean, isSilence?: boolean, isDeleted?: boolean, merged_by_edge_trim?: boolean, mergedByEdgeTrim?: boolean, split_chain?: string, splitChain?: string }} SubtitleWord
 * @typedef {{ start: number, end: number, text?: string, words?: SubtitleWord[], is_silence?: boolean, isSilence?: boolean, is_deleted?: boolean, isDeleted?: boolean }} SubtitleLine
 * @typedef {{ start: number, end: number, text: string }} SubtitleCueLineForExport
 */

export function wordIsDeleted(w) {
  return w.is_deleted === true || w.isDeleted === true;
}

export function wordIsSilence(w) {
  return w.is_silence === true || w.isSilence === true || String(w.word ?? "").trim() === SILENCE_PLACEHOLDER_TEXT;
}

/** @param {readonly SubtitleWord[] | undefined} words */
export function visibleSubtitleWords(words) {
  if (!words?.length) return [];
  return words.filter((w) => !wordIsDeleted(w) && !wordIsSilence(w));
}

/**
 * @param {SubtitleLine | undefined} line
 * @param {number} visibleIndex
 */
export function storageWordIndexFromVisibleNonDeletedIndex(line, visibleIndex) {
  if (!line?.words?.length || visibleIndex < 0) return -1;
  const words = line.words;
  let v = 0;
  for (let wi = 0; wi < words.length; wi += 1) {
    if (wordIsDeleted(words[wi])) continue;
    if (v === visibleIndex) return wi;
    v += 1;
  }
  return -1;
}

/** @param {readonly SubtitleWord[] | undefined} words */
export function displayTextFromSubtitleWords(words) {
  if (!words?.length) return "";
  return visibleSubtitleWords(words)
    .map((w) => scrubTimelineNoiseFromWordPiece(w.word))
    .filter((piece) => piece.length > 0 && !shouldOmitFromSubtitleEditLineText(piece))
    .join(" ")
    .replace(/[\u2028\u2029\u000B\u000C\u0085\r\n]/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[^\S ]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

function normSubtitleLineEdit(s) {
  return s.replace(/\s+/g, " ").trim();
}

/** @param {{ lineTextUserEdited?: boolean, line_text_user_edited?: boolean } | null | undefined} line */
export function lineTextIsUserLocked(line) {
  return line?.lineTextUserEdited === true || line?.line_text_user_edited === true;
}

/** @param {Record<string, unknown> | null | undefined} line */
export function markLineTextUserEdited(line) {
  if (!line || typeof line !== "object") return line;
  line.lineTextUserEdited = true;
  line.line_text_user_edited = true;
  return line;
}

/** @param {Record<string, unknown> | null | undefined} line */
export function clearLineTextUserEdited(line) {
  if (!line || typeof line !== "object") return line;
  delete line.lineTextUserEdited;
  delete line.line_text_user_edited;
  return line;
}

/**
 * @param {{ text?: string, words?: readonly SubtitleWord[] }} line
 */
export function subtitleLineEditDisplayText(line) {
  const words = line.words;
  const fromWords = words?.length ? displayTextFromSubtitleWords(words) : "";
  const raw = String(line.text ?? "").trim();
  const fromTextSanitized = raw
    .split(/\s+/)
    .map((t) => scrubTimelineNoiseFromWordPiece(t))
    .filter((piece) => piece.length > 0 && !shouldOmitFromSubtitleEditLineText(piece))
    .join(" ")
    .trim();

  if (fromTextSanitized.length > 0) return fromTextSanitized;
  return fromWords;
}

/** @param {{ text?: string, words?: readonly SubtitleWord[] }} line */
export function subtitleLineTextDiffersFromWords(line) {
  const fromWords = line.words?.length ? displayTextFromSubtitleWords(line.words) : "";
  const raw = String(line.text ?? "").trim();
  if (raw.length === 0) return false;
  const fromTextSanitized = raw
    .split(/\s+/)
    .map((t) => scrubTimelineNoiseFromWordPiece(t))
    .filter((piece) => piece.length > 0 && !shouldOmitFromSubtitleEditLineText(piece))
    .join(" ")
    .trim();
  if (fromTextSanitized.length === 0) return false;
  if (fromWords.length === 0) return true;
  return normSubtitleLineEdit(fromTextSanitized) !== normSubtitleLineEdit(fromWords);
}

/**
 * 단어(words) 변경 후 줄 text — 편집 영역 수정본이 있으면 유지.
 *
 * @param {{ text?: string, words?: readonly SubtitleWord[] }} line
 * @param {readonly SubtitleWord[]} newWords
 * @param {string} fromWordsText
 */
export function subtitleLineTextAfterWordMutation(line, newWords, fromWordsText) {
  if (lineTextIsUserLocked(line)) {
    return subtitleLineEditDisplayText(line);
  }
  const candidate = { ...line, words: newWords };
  if (subtitleLineTextDiffersFromWords(candidate)) {
    return subtitleLineEditDisplayText(line);
  }
  return fromWordsText;
}

function isGapLikeTimelineToken(w) {
  if (wordIsDeleted(w)) return false;
  const t = String(w.word ?? "").trim();
  if (wordIsSilence(w) || t === SILENCE_PLACEHOLDER_TEXT) return true;
  if (t === CONTINUATION_ELLIPSIS_TOKEN) return true;
  return false;
}

function isDashSilenceToken(w) {
  if (wordIsDeleted(w)) return false;
  const t = String(w.word ?? "").trim();
  return wordIsSilence(w) || t === SILENCE_PLACEHOLDER_TEXT;
}

/** @param {readonly SubtitleWord[]} words */
export function collapseGapLikeRunsInWords(words) {
  if (!words.length) return [];
  const out = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (wordIsDeleted(w) || !isGapLikeTimelineToken(w)) {
      out.push({ ...w });
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < words.length && isGapLikeTimelineToken(words[j]) && !wordIsDeleted(words[j])) {
      j += 1;
    }
    const run = words.slice(i, j);
    const dashCount = run.filter(isDashSilenceToken).length;
    const collapse = run.length >= 3 || dashCount >= 2;
    if (collapse) {
      const lo = Math.min(...run.map((x) => Math.min(x.start, x.end)));
      const hi = Math.max(...run.map((x) => Math.max(x.start, x.end)));
      out.push({
        start: lo,
        end: Math.max(lo + FLOAT_EPS, hi),
        word: SILENCE_PLACEHOLDER_TEXT,
        is_silence: true,
        isSilence: true,
      });
    } else {
      for (const x of run) out.push({ ...x });
    }
    i = j;
  }
  return out;
}

/** @param {readonly SubtitleWord[]} words */
export function mergeConsecutiveSilenceWords(words) {
  if (!words.length) return [];
  const isSilBlock = (w) => !wordIsDeleted(w) && wordIsSilence(w);

  const out = [];
  for (const w of words) {
    if (wordIsDeleted(w)) {
      out.push({ ...w });
      continue;
    }
    if (!isSilBlock(w)) {
      out.push({ ...w });
      continue;
    }
    const prev = out[out.length - 1];
    if (prev && !wordIsDeleted(prev) && isSilBlock(prev)) {
      prev.start = Math.min(prev.start, w.start);
      prev.end = Math.max(prev.end, w.end);
      prev.word = SILENCE_PLACEHOLDER_TEXT;
      prev.is_silence = true;
      prev.isSilence = true;
      continue;
    }
    out.push({
      ...w,
      word: SILENCE_PLACEHOLDER_TEXT,
      is_silence: true,
      isSilence: true,
    });
  }
  return out;
}

/** 추출 후 줄·단어 사이에만 `--` 를 넣을 최소 간격(초) */
export const EXTRACT_TEMPORAL_GAP_SILENCE_SEC = 0.08;

/**
 * 인접 단어 블록 시간 겹침 제거 (말 끝 음절과 `--` 가 같은 구간을 공유하는 현상).
 *
 * @param {readonly SubtitleWord[]} words
 */
export function resolveAdjacentWordTimelineOverlaps(words) {
  if (!words?.length) return words || [];
  const out = words.map((w) => ({ ...w }));
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 0; i < out.length - 1; i += 1) {
    const a = out[i];
    const b = out[i + 1];
    if (wordIsDeleted(a) || wordIsDeleted(b)) continue;
    const aStart = Math.min(a.start, a.end);
    const bStart = Math.min(b.start, b.end);
    const aEnd = Math.max(a.start, a.end);
    if (aEnd > bStart + FLOAT_EPS) {
      a.end = Math.max(aStart + FLOAT_EPS, bStart);
      if (a.start > a.end) a.start = aStart;
    }
  }
  return out;
}

/**
 * 줄 끝 피크 분할 잔여 `--` 제거: 직전 말소리와 겹치거나 너무 짧은 trailing silence.
 *
 * @param {readonly SubtitleWord[]} words
 * @param {number} [minKeepSilenceSec]
 */
export function suppressTrailingOverlapSilence(
  words,
  minKeepSilenceSec = EXTRACT_TEMPORAL_GAP_SILENCE_SEC,
) {
  let w = resolveAdjacentWordTimelineOverlaps(words);
  if (w.length < 2) return w;
  const last = w[w.length - 1];
  const prev = w[w.length - 2];
  if (wordIsDeleted(last) || wordIsDeleted(prev)) return w;
  if (!wordIsSilence(last) || wordIsSilence(prev)) return w;

  const ps = Math.min(prev.start, prev.end);
  let pe = Math.max(prev.start, prev.end);
  const ss = Math.min(last.start, last.end);
  const se = Math.max(last.start, last.end);
  const overlap = pe - ss;
  const silDur = se - ss;

  if (overlap > FLOAT_EPS) {
    pe = Math.max(ps + FLOAT_EPS, ss);
    prev.end = pe;
  }

  if (silDur < minKeepSilenceSec - FLOAT_EPS || overlap > FLOAT_EPS) {
    return w.slice(0, -1);
  }
  return w;
}

/** @param {readonly SubtitleWord[]} words */
export function normalizeSilenceWordsForLineWords(words) {
  let w = mergeConsecutiveSilenceWords(words);
  w = collapseGapLikeRunsInWords(w);
  w = mergeConsecutiveSilenceWords(w);
  w = resolveAdjacentWordTimelineOverlaps(w);
  w = suppressTrailingOverlapSilence(w);
  w = mergeConsecutiveSilenceWords(w);
  return w;
}

/** @param {SubtitleLine} line */
export function mergeConsecutiveSilenceWordsInLine(line) {
  if (!line.words?.length) return line;
  const merged = normalizeSilenceWordsForLineWords(line.words);
  let same = merged.length === line.words.length;
  if (same) {
    for (let i = 0; i < merged.length; i += 1) {
      const a = merged[i];
      const b = line.words[i];
      if (
        a.start !== b.start ||
        a.end !== b.end ||
        a.word !== b.word ||
        Boolean(a.is_silence || a.isSilence) !== Boolean(b.is_silence || b.isSilence) ||
        wordIsDeleted(a) !== wordIsDeleted(b)
      ) {
        same = false;
        break;
      }
    }
  }
  if (same) return line;
  const alive = merged.filter((x) => !wordIsDeleted(x));
  const start = alive.length > 0 ? Math.min(...alive.map((x) => x.start)) : line.start;
  const end = alive.length > 0 ? Math.max(...alive.map((x) => x.end)) : line.end;
  return {
    ...line,
    start,
    end: Math.max(start + 0.01, end),
    words: merged,
    text: lineTextIsUserLocked(line)
      ? subtitleLineEditDisplayText(line)
      : displayTextFromSubtitleWords(merged) || line.text,
  };
}

/**
 * @param {SubtitleLine} line
 * @param {number} [gapThresholdSec]
 */
export function insertMissingTemporalSilenceGapsInLine(line, gapThresholdSec = EXTRACT_TEMPORAL_GAP_SILENCE_SEC) {
  if (!line.words?.length) return line;
  if (line.words.some(wordIsDeleted)) return line;

  const sorted = [...line.words].sort((a, b) => a.start - b.start || a.end - b.end);
  const intervalTouchedBySilence = (t0, t1) =>
    line.words.some(
      (w) =>
        !wordIsDeleted(w) &&
        wordIsSilence(w) &&
        !(w.end <= t0 + FLOAT_EPS || w.start >= t1 - FLOAT_EPS),
    );

  const out = [];
  let inserted = false;
  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const pe = Math.max(prev.start, prev.end);
      const cs = Math.min(cur.start, cur.end);
      const dur = cs - pe;
      if (dur >= gapThresholdSec - FLOAT_EPS && !intervalTouchedBySilence(pe, cs)) {
        out.push({
          start: pe,
          end: cs,
          word: SILENCE_PLACEHOLDER_TEXT,
          is_silence: true,
          isSilence: true,
        });
        inserted = true;
      }
    }
    out.push({ ...sorted[i] });
  }

  if (!inserted) return line;
  return mergeConsecutiveSilenceWordsInLine({ ...line, words: out });
}

/** @param {readonly SubtitleLine[]} lines */
export function subtitleCueLinesForExport(lines) {
  const out = [];
  for (const line of lines || []) {
    const hasWords = Array.isArray(line.words) && line.words.length > 0;
    const text = subtitleLineEditDisplayText(line);
    if (text.length === 0) continue;
    if (hasWords) {
      const vis = visibleSubtitleWords(line.words);
      if (vis.length === 0) continue;
      const start = Math.min(...vis.map((w) => w.start));
      const end = Math.max(...vis.map((w) => w.end));
      out.push({ start, end, text });
    } else {
      out.push({ start: line.start, end: line.end, text });
    }
  }
  return out;
}

function isRecord(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * end ≤ start 단어 제거 (Electron onTranscribeComplete).
 *
 * @param {readonly SubtitleLine[]} lines
 */
export function pruneInvalidSubtitleWords(lines) {
  return (lines || []).map((line) => {
    if (!line.words?.length) return line;
    const words = line.words.filter(
      (w) =>
        wordIsDeleted(w) ||
        (Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start + FLOAT_EPS),
    );
    if (words.length === line.words.length) return line;
    return syncSubtitleLineFromWords({ ...line, words });
  });
}

/** @param {unknown} raw */
export function parseSubtitleLines(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const start = Number(item.start);
    const end = Number(item.end);
    const text = typeof item.text === "string" ? item.text : "";
    const wordsRaw = Array.isArray(item.words) ? item.words : [];
    /** @type {SubtitleWord[]} */
    const words = [];
    for (const w of wordsRaw) {
      if (!isRecord(w)) continue;
      const ws = Number(w.start);
      const we = Number(w.end);
      const ww = typeof w.word === "string" ? w.word : "";
      const isSilence = w.isSilence === true || w.is_silence === true;
      const isDeleted = w.isDeleted === true || w.is_deleted === true;
      if (!Number.isFinite(ws) || !Number.isFinite(we)) continue;
      if (we <= ws + FLOAT_EPS && !isDeleted) continue;
      if (ww.trim().length === 0 && !isSilence && !isDeleted) continue;
      const tw = ww.trim();
      /** @type {SubtitleWord} */
      const entry = {
        start: ws,
        end: we,
        word: isSilence ? SILENCE_PLACEHOLDER_TEXT : tw.length > 0 ? tw : "??",
      };
      if (isSilence) {
        entry.is_silence = true;
        entry.isSilence = true;
      }
      if (isDeleted) {
        entry.is_deleted = true;
        entry.isDeleted = true;
      }
      if (w.mergedByEdgeTrim === true || w.merged_by_edge_trim === true) {
        entry.merged_by_edge_trim = true;
        entry.mergedByEdgeTrim = true;
      }
      if (typeof w.splitChain === "string") entry.split_chain = w.splitChain;
      if (typeof w.split_chain === "string") entry.split_chain = w.split_chain;
      words.push(entry);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const mergedWords = normalizeSilenceWordsForLineWords(words);
    const lineText =
      mergedWords.length > 0
        ? subtitleLineEditDisplayText({ text, words: mergedWords })
        : text.trim();
    const locked =
      item.lineTextUserEdited === true || item.line_text_user_edited === true;
    out.push({
      start,
      end,
      text: lineText,
      words: mergedWords,
      is_silence: item.is_silence === true || item.isSilence === true,
      ...(locked ? { lineTextUserEdited: true, line_text_user_edited: true } : {}),
    });
  }
  return out;
}

/** @param {SubtitleLine} line */
export function syncSubtitleLineFromWords(line) {
  if (!line?.words?.length) return line;
  const vis = visibleSubtitleWords(line.words);
  if (!vis.length) {
    if (!lineTextIsUserLocked(line)) line.text = "";
    return line;
  }
  line.start = Math.min(...vis.map((w) => w.start));
  line.end = Math.max(...vis.map((w) => w.end));
  if (!lineTextIsUserLocked(line) && !subtitleLineTextDiffersFromWords(line)) {
    line.text = displayTextFromSubtitleWords(line.words);
  }
  return line;
}

/**
 * Whisper/RMS 축 → 재생·pcm 피크 축 (timeline_sec) 정렬.
 *
 * @param {readonly SubtitleLine[]} lines
 * @param {number} scale
 */
export function scaleSubtitleLinesTimes(lines, scale) {
  const s = Number(scale);
  if (!(s > 0) || Math.abs(s - 1) < 0.004) return [...(lines || [])];
  const mapWord = (w) => ({
    ...w,
    start: w.start * s,
    end: w.end * s,
  });
  return (lines || []).map((line) => {
    const words = line.words?.map(mapWord);
    const next = words?.length ? { ...line, words } : { ...line };
    if (Number.isFinite(line.start)) next.start = line.start * s;
    if (Number.isFinite(line.end)) next.end = line.end * s;
    return next;
  });
}

/** @param {SubtitleLine[]} lines */
export function syncAllSubtitleLinesFromWords(lines) {
  for (const line of lines || []) {
    if (line?.is_silence || line?.isSilence) continue;
    if (line?.words?.length) syncSubtitleLineFromWords(line);
  }
  return lines;
}

/** @param {SubtitleLine[]} lines */
export function linesContainDeletedWords(lines) {
  for (const line of lines || []) {
    for (const w of line.words || []) {
      if (wordIsDeleted(w)) return true;
    }
  }
  return false;
}
