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
import { intervalHasAudibleSpeechInPeaks } from "./peak-interval-speech.js";

/** 말끝에 붙는 짧은 `--` / 무음 줄 흡수 상한(초) */
export const MAX_ABSORB_TRAILING_TAIL_SEC = 0.55;

/**
 * @typedef {{ start: number, end: number, word: string, sourceStart?: number, sourceEnd?: number, source_start?: number, source_end?: number, is_silence?: boolean, is_deleted?: boolean, isSilence?: boolean, isDeleted?: boolean, merged_by_edge_trim?: boolean, mergedByEdgeTrim?: boolean, split_chain?: string, splitChain?: string }} SubtitleWord
 * @typedef {{ start: number, end: number, sourceStart?: number, sourceEnd?: number, source_start?: number, source_end?: number, text?: string, words?: SubtitleWord[], is_silence?: boolean, isSilence?: boolean, is_deleted?: boolean, isDeleted?: boolean }} SubtitleLine
 * @typedef {{ start: number, end: number, text: string }} SubtitleCueLineForExport
 */

export function wordIsDeleted(w) {
  return w.is_deleted === true || w.isDeleted === true;
}

export function wordIsSilence(w) {
  return w.is_silence === true || w.isSilence === true || String(w.word ?? "").trim() === SILENCE_PLACEHOLDER_TEXT;
}

/** 파형 edge trim 으로 이웃에 흡수된 tombstone — 재생 스킵 대상 아님 */
export function wordMergedByEdgeTrim(w) {
  return w?.merged_by_edge_trim === true || w?.mergedByEdgeTrim === true;
}

/** 단어 칩·캐럿에 표시할 단어(soft-delete 된 edge-trim 무음 포함) */
export function wordVisibleInWordChipRail(w) {
  if (!wordIsDeleted(w)) return true;
  return wordMergedByEdgeTrim(w) && wordIsSilence(w);
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
function sanitizeLineEditText(raw) {
  return String(raw ?? "")
    .split(/\s+/)
    .map((t) => scrubTimelineNoiseFromWordPiece(t))
    .filter((piece) => piece.length > 0 && !shouldOmitFromSubtitleEditLineText(piece))
    .join(" ")
    .trim();
}

export function subtitleLineEditDisplayText(line) {
  const words = line.words;
  const fromWords = words?.length ? displayTextFromSubtitleWords(words) : "";
  const fromTextSanitized = sanitizeLineEditText(line.text);

  if (lineTextIsUserLocked(line)) {
    return fromTextSanitized;
  }
  if (fromTextSanitized.length > 0) return fromTextSanitized;
  return fromWords;
}

/** @param {{ text?: string, words?: readonly SubtitleWord[] }} line */
export function subtitleLineTextDiffersFromWords(line) {
  const fromWords = line.words?.length ? displayTextFromSubtitleWords(line.words) : "";
  const fromTextSanitized = sanitizeLineEditText(line.text);
  if (lineTextIsUserLocked(line)) {
    return normSubtitleLineEdit(fromTextSanitized) !== normSubtitleLineEdit(fromWords);
  }
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
 * @param {SubtitleLine} line
 */
export function lineIsSilenceOnlyCue(line) {
  if (!line) return false;
  if (line.is_silence || line.isSilence) return true;
  const words = line.words ?? [];
  const alive = words.filter((w) => !wordIsDeleted(w));
  if (!alive.length) {
    return String(line.text ?? "").trim() === SILENCE_PLACEHOLDER_TEXT;
  }
  return alive.every((w) => wordIsSilence(w));
}

/**
 * @param {import("../peaks-metrics.js").PeaksTimelineMetrics | null | undefined} metrics
 * @param {number} t0
 * @param {number} t1
 */
export function shouldAbsorbMislabeledSpeechTail(metrics, t0, t1) {
  const a = Math.min(t0, t1);
  const b = Math.max(t0, t1);
  const dur = b - a;
  if (dur <= FLOAT_EPS) return false;
  if (dur <= MAX_ABSORB_TRAILING_TAIL_SEC + FLOAT_EPS) {
    if (!metrics?.data?.length) return true;
    return intervalHasAudibleSpeechInPeaks(metrics, a, b);
  }
  if (!metrics?.data?.length) return false;
  return intervalHasAudibleSpeechInPeaks(metrics, a, b);
}

/**
 * 한 줄 맨 끝 `--` 제거 — 꼬리 구간을 앞 말소리 단어 end 로 흡수 (피크·짧은 구간 기준).
 *
 * @param {SubtitleLine} line
 * @param {import("../peaks-metrics.js").PeaksTimelineMetrics | null | undefined} [metrics]
 */
export function stripLineEndTrailingSilenceWords(line, metrics = null) {
  if (!line?.words?.length || line.is_silence || line.isSilence) return line;

  let words = [...line.words].sort((a, b) => a.start - b.start || a.end - b.end);
  let changed = false;

  while (words.length > 0) {
    const last = words[words.length - 1];
    if (wordIsDeleted(last) || !wordIsSilence(last)) break;
    const ss = Math.min(last.start, last.end);
    const se = Math.max(last.start, last.end);
    let absorbed = false;
    if (words.length >= 2) {
      const prev = words[words.length - 2];
      if (!wordIsDeleted(prev) && !wordIsSilence(prev) && shouldAbsorbMislabeledSpeechTail(metrics, ss, se)) {
        const pe = Math.max(prev.start, prev.end);
        words = [...words.slice(0, -2), { ...prev, end: Math.max(pe, se) }];
        changed = true;
        absorbed = true;
      }
    }
    if (absorbed) continue;
    words = words.slice(0, -1);
    changed = true;
  }

  if (!changed) return line;
  return mergeConsecutiveSilenceWordsInLine({ ...line, words });
}

/**
 * 말소리 줄 직후 짧은 `--` 전용 줄을 이전 줄 마지막 단어에 흡수.
 *
 * @param {readonly SubtitleLine[]} lines
 * @param {import("../peaks-metrics.js").PeaksTimelineMetrics | null | undefined} [metrics]
 */
export function absorbSpuriousSilenceCuesAfterSpeech(lines, metrics = null) {
  if (!lines?.length) return [];
  /** @type {SubtitleLine[]} */
  const out = [];
  for (const line of lines) {
    if (!lineIsSilenceOnlyCue(line)) {
      out.push(line);
      continue;
    }
    const prev = out[out.length - 1];
    if (!prev || lineIsSilenceOnlyCue(prev)) {
      out.push(line);
      continue;
    }
    const t0 = Math.min(line.start, line.end);
    const t1 = Math.max(line.start, line.end);
    if (!shouldAbsorbMislabeledSpeechTail(metrics, t0, t1)) {
      out.push(line);
      continue;
    }
    const tailEnd = Math.max(
      t1,
      ...(line.words ?? []).map((w) => Math.max(w.start, w.end)),
    );
    let words = [...(prev.words ?? [])].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let wi = words.length - 1; wi >= 0; wi -= 1) {
      const w = words[wi];
      if (wordIsDeleted(w) || wordIsSilence(w)) continue;
      words[wi] = { ...w, end: Math.max(w.start + FLOAT_EPS, Math.max(w.start, w.end), tailEnd) };
      break;
    }
    const merged = syncSubtitleLineFromWords(
      stripLineEndTrailingSilenceWords({ ...prev, words }, metrics),
    );
    out[out.length - 1] = merged;
  }
  return out;
}

/**
 * @param {readonly SubtitleLine[]} lines
 * @param {import("../peaks-metrics.js").PeaksTimelineMetrics | null | undefined} [metrics]
 */
export function repairCueLinesWordTimelines(lines, metrics = null) {
  const absorbed = absorbSpuriousSilenceCuesAfterSpeech(lines || [], metrics);
  return absorbed.map((line) => {
    if (line.is_silence || line.isSilence) return line;
    return syncSubtitleLineFromWords(stripLineEndTrailingSilenceWords(line, metrics));
  });
}

/** @param {readonly SubtitleWord[]} words */
export function normalizeSilenceWordsForLineWords(words) {
  let w = mergeConsecutiveSilenceWords(words);
  w = collapseGapLikeRunsInWords(w);
  w = mergeConsecutiveSilenceWords(w);
  w = resolveAdjacentWordTimelineOverlaps(w);
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
export function insertMissingTemporalSilenceGapsInLine(
  line,
  gapThresholdSec = EXTRACT_TEMPORAL_GAP_SILENCE_SEC,
  metrics = null,
) {
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
      const skipAsSpeechTail =
        dur >= gapThresholdSec - FLOAT_EPS &&
        !wordIsSilence(prev) &&
        shouldAbsorbMislabeledSpeechTail(metrics, pe, cs);
      if (
        dur >= gapThresholdSec - FLOAT_EPS &&
        !intervalTouchedBySilence(pe, cs) &&
        !skipAsSpeechTail
      ) {
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
      const wss = Number(w.sourceStart ?? w.source_start);
      const wse = Number(w.sourceEnd ?? w.source_end);
      if (Number.isFinite(wss)) {
        entry.sourceStart = wss;
        entry.source_start = wss;
      }
      if (Number.isFinite(wse)) {
        entry.sourceEnd = wse;
        entry.source_end = wse;
      }
      const hss = Number(w.hintStart ?? w.hint_start);
      const hse = Number(w.hintEnd ?? w.hint_end);
      if (Number.isFinite(hss)) entry.hintStart = hss;
      if (Number.isFinite(hse)) entry.hintEnd = hse;
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
    /** @type {SubtitleLine} */
    const line = {
      start,
      end,
      text: lineText,
      words: mergedWords,
      is_silence: item.is_silence === true || item.isSilence === true,
      ...(locked ? { lineTextUserEdited: true, line_text_user_edited: true } : {}),
    };
    const lss = Number(item.sourceStart ?? item.source_start);
    const lse = Number(item.sourceEnd ?? item.source_end);
    if (Number.isFinite(lss)) {
      line.sourceStart = lss;
      line.source_start = lss;
    }
    if (Number.isFinite(lse)) {
      line.sourceEnd = lse;
      line.source_end = lse;
    }
    if (item.flags && typeof item.flags === "object") {
      line.flags = { ...item.flags };
    }
    out.push(line);
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
