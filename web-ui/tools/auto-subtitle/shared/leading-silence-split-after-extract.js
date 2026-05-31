/**
 * 추출 직후 ?�크 기�? ?�어 ?��?/?�행 무음 ??`--` 분리 (Electron leadingSilenceSplitAfterExtract.ts).
 */

import { mediaSecondsToPeakPixelRange } from "../peaks-metrics.js";
import {
  displayTextFromSubtitleWords,
  mergeConsecutiveSilenceWordsInLine,
} from "./subtitles.js?v=20";
import { DEFAULT_GAP_THRESHOLD_SEC, SILENCE_PLACEHOLDER_TEXT } from "./word-contract.js";

const DBFS_GATE_DEFAULT = -40;
const WORD_ANCHOR_DBFS_DEFAULT = -32;
const EPS = 1e-5;
const WORD_CONTINUATION_MARKER = "\u2026";
const CONTINUATION_SPLIT_GATE_RAISE_DB_DEFAULT = 10;
const VOICE_ONSET_DBFS_DEFAULT = -22;
const VOICE_ONSET_MIN_CONSECUTIVE_PIXELS_DEFAULT = 2;
const VOICE_ONSET_MIN_TAIL_SEC = 0.1;
const VOICE_ONSET_MIN_TAIL_FRAC_OF_RUN = 0.28;
const DBFS_GATE_TIGHTEN_AFTER_SILENCE_DB = 14;
export const MIN_LEAD_AFTER_SILENCE_SEC = 0.05;

/**
 * @param {readonly number[]} data
 * @param {number} col
 */
function peakDbfsAtColumn(data, col) {
  const i = col * 2;
  const mn = (data[i] ?? 0) / 127;
  const mx = (data[i + 1] ?? 0) / 127;
  const amp = Math.max(Math.abs(mn), Math.abs(mx));
  if (amp < 1e-8) return -100;
  const db = 20 * Math.log10(amp);
  if (!Number.isFinite(db)) return -100;
  return Math.max(-120, Math.min(0, db));
}

function timeLeftEdgeOfPixel(p, pixelCount, durationSec) {
  return (p / pixelCount) * durationSec;
}

function isSpeechColumn(data, p, dbfsGate) {
  return peakDbfsAtColumn(data, p) > dbfsGate;
}

function firstSustainedVoiceOnsetSec(
  data,
  pixelCount,
  durationSec,
  ws,
  we,
  voiceDbfs,
  minConsecutive,
) {
  if (!(we > ws + EPS) || minConsecutive < 1) return null;
  const { startPixel, endPixel } = mediaSecondsToPeakPixelRange(
    { data, pixelCount, durationSec },
    ws,
    we,
  );
  let run = 0;
  for (let p = startPixel; p < endPixel; p += 1) {
    if (peakDbfsAtColumn(data, p) > voiceDbfs + EPS) {
      run += 1;
      if (run >= minConsecutive) {
        const pOnset = p - minConsecutive + 1;
        return timeLeftEdgeOfPixel(pOnset, pixelCount, durationSec);
      }
    } else {
      run = 0;
    }
  }
  return null;
}

function splitPixelDbfsGateForWord(w, dbfsGate, continuationGateRaiseDb) {
  if (w.word !== WORD_CONTINUATION_MARKER) return dbfsGate;
  const raised = dbfsGate + continuationGateRaiseDb;
  return Math.max(-58, Math.min(-20, raised));
}

function maxDbfsInTimeRange(data, pixelCount, durationSec, t0, t1) {
  const { startPixel, endPixel } = mediaSecondsToPeakPixelRange(
    { data, pixelCount, durationSec },
    t0,
    t1,
  );
  let m = -150;
  for (let p = startPixel; p < endPixel; p += 1) {
    m = Math.max(m, peakDbfsAtColumn(data, p));
  }
  return m;
}

function assignSpeechWordTextsByAnchor(segments, w, data, pixelCount, durationSec, anchorDbfs) {
  const speechIdxs = [];
  for (let si = 0; si < segments.length; si += 1) {
    if (segments[si].is_silence !== true && segments[si].isSilence !== true) speechIdxs.push(si);
  }
  if (speechIdxs.length <= 1) return segments;

  let anchorIdx = -1;
  let bestAnchorDb = -200;
  for (const si of speechIdxs) {
    const seg = segments[si];
    const db = maxDbfsInTimeRange(data, pixelCount, durationSec, seg.start, seg.end);
    if (db > anchorDbfs + EPS && db > bestAnchorDb + EPS) {
      bestAnchorDb = db;
      anchorIdx = si;
    }
  }
  if (anchorIdx < 0) {
    anchorIdx = speechIdxs[0];
    let bestDb = maxDbfsInTimeRange(
      data,
      pixelCount,
      durationSec,
      segments[anchorIdx].start,
      segments[anchorIdx].end,
    );
    for (const si of speechIdxs.slice(1)) {
      const seg = segments[si];
      const db = maxDbfsInTimeRange(data, pixelCount, durationSec, seg.start, seg.end);
      if (db > bestDb + EPS) {
        anchorIdx = si;
        bestDb = db;
      }
    }
  }

  return segments.map((seg, i) => {
    if (seg.is_silence || seg.isSilence) return seg;
    const text = i === anchorIdx ? w.word : WORD_CONTINUATION_MARKER;
    if (seg.word === text) return seg;
    return { ...seg, word: text };
  });
}

function wordsSplitSignature(words) {
  return words
    .map((w) => {
      const del = w.is_deleted || w.isDeleted ? 1 : 0;
      const sil = w.is_silence || w.isSilence ? 1 : 0;
      return `${w.start.toFixed(6)}|${w.end.toFixed(6)}|${sil}|${del}|${w.word}`;
    })
    .join(";");
}

function splitSingleWordByPeakSilenceRuns(
  w,
  data,
  pixelCount,
  durationSec,
  dbfsGate,
  minLead,
  wordAnchorDbfs,
  continuationGateRaiseDb,
  voiceOnsetDbfs,
  voiceOnsetMinConsecutivePixels,
  relaxVoiceOnsetAfterSilence,
) {
  const ws = Math.min(w.start, w.end);
  const we = Math.max(w.start, w.end);
  if (!(we > ws + EPS)) return null;

  const splitPxGate = splitPixelDbfsGateForWord(w, dbfsGate, continuationGateRaiseDb);
  const { startPixel, endPixel } = mediaSecondsToPeakPixelRange(
    { data, pixelCount, durationSec },
    ws,
    we,
  );
  const n = endPixel - startPixel;
  if (n <= 0) return null;

  const sil = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const p = startPixel + i;
    sil[i] = isSpeechColumn(data, p, splitPxGate) ? 0 : 1;
  }

  let i = 0;
  while (i < n) {
    if (sil[i] !== 1) {
      i += 1;
      continue;
    }
    const j = i;
    while (i < n && sil[i] === 1) i += 1;
    const t0 = timeLeftEdgeOfPixel(j + startPixel, pixelCount, durationSec);
    const t1 = timeLeftEdgeOfPixel(i + startPixel, pixelCount, durationSec);
    if (t1 - t0 < minLead - EPS) {
      for (let k = j; k < i; k += 1) sil[k] = 0;
    }
  }

  /** @type {{ silent: boolean, p0: number, p1: number }[]} */
  const runs = [];
  let k = 0;
  while (k < n) {
    const bit = sil[k];
    const k0 = k;
    while (k < n && sil[k] === bit) k += 1;
    runs.push({ silent: bit === 1, p0: startPixel + k0, p1: startPixel + k });
  }

  const out = [];
  let speechChunkIndex = 0;

  for (const run of runs) {
    let t0 = timeLeftEdgeOfPixel(run.p0, pixelCount, durationSec);
    let t1 = timeLeftEdgeOfPixel(run.p1, pixelCount, durationSec);
    t0 = Math.max(ws, Math.min(we, t0));
    t1 = Math.max(ws, Math.min(we, t1));
    if (!(t1 > t0 + EPS)) continue;

    if (run.silent) {
      out.push({
        start: t0,
        end: t1,
        word: SILENCE_PLACEHOLDER_TEXT,
        is_silence: true,
        isSilence: true,
      });
      continue;
    }

    let segStart = speechChunkIndex === 0 && out.length === 0 ? ws : Math.max(ws, t0);
    const segEnd = Math.min(we, t1);

    const voiceOnset = firstSustainedVoiceOnsetSec(
      data,
      pixelCount,
      durationSec,
      segStart,
      segEnd,
      voiceOnsetDbfs,
      voiceOnsetMinConsecutivePixels,
    );
    const runDur = segEnd - segStart;
    const minTailAfterOnset = Math.max(VOICE_ONSET_MIN_TAIL_SEC, VOICE_ONSET_MIN_TAIL_FRAC_OF_RUN * runDur);
    let onsetSplitAt = null;
    if (
      voiceOnset != null &&
      voiceOnset > segStart + minLead - EPS &&
      voiceOnset < segEnd - EPS
    ) {
      const tailDur = segEnd - voiceOnset;
      const headDb = maxDbfsInTimeRange(data, pixelCount, durationSec, segStart, voiceOnset);
      const tailDb = maxDbfsInTimeRange(data, pixelCount, durationSec, voiceOnset, segEnd);
      const headTailSlackDb = relaxVoiceOnsetAfterSilence ? 6 : 1.5;
      if (tailDur >= minTailAfterOnset - EPS && tailDb >= headDb - headTailSlackDb) {
        onsetSplitAt = voiceOnset;
      }
    }
    if (onsetSplitAt != null) {
      out.push({
        start: segStart,
        end: onsetSplitAt,
        word: SILENCE_PLACEHOLDER_TEXT,
        is_silence: true,
        isSilence: true,
      });
      segStart = onsetSplitAt;
    }

    if (!(segEnd > segStart + EPS)) continue;

    const wordText = speechChunkIndex === 0 ? w.word : WORD_CONTINUATION_MARKER;
    speechChunkIndex += 1;
    out.push({ ...w, start: segStart, end: segEnd, word: wordText });
  }

  if (out.length === 0) return null;

  const hasSpeech = out.some((s) => !(s.is_silence || s.isSilence));
  if (!hasSpeech) {
    if (w.word === WORD_CONTINUATION_MARKER && we - ws >= minLead - EPS) {
      return [
        {
          start: ws,
          end: we,
          word: SILENCE_PLACEHOLDER_TEXT,
          is_silence: true,
          isSilence: true,
        },
      ];
    }
    return null;
  }

  const outAnchored = assignSpeechWordTextsByAnchor(
    out,
    w,
    data,
    pixelCount,
    durationSec,
    wordAnchorDbfs,
  );

  if (
    outAnchored.length === 1 &&
    !(outAnchored[0].is_silence || outAnchored[0].isSilence) &&
    outAnchored[0].word === w.word &&
    Math.abs(outAnchored[0].start - ws) < 1e-3 &&
    Math.abs(outAnchored[0].end - we) < 1e-3
  ) {
    return null;
  }

  return outAnchored;
}

function expandWordsOnePeakSilencePass(
  words,
  data,
  pixelCount,
  durationSec,
  dbfsGate,
  minLead,
  wordAnchorDbfs,
  continuationGateRaiseDb,
  voiceOnsetDbfs,
  voiceOnsetMinConsecutivePixels,
) {
  const next = [];
  for (let wi = 0; wi < words.length; wi += 1) {
    const w = words[wi];
    if (w.is_deleted || w.isDeleted) {
      next.push({ ...w });
      continue;
    }
    if (w.is_silence || w.isSilence) {
      next.push({ ...w });
      continue;
    }

    const prev = wi > 0 ? words[wi - 1] : undefined;
    const afterSilenceBlock =
      prev != null && !(prev.is_deleted || prev.isDeleted) && (prev.is_silence || prev.isSilence);
    const effGate = afterSilenceBlock ? dbfsGate - DBFS_GATE_TIGHTEN_AFTER_SILENCE_DB : dbfsGate;
    const effMinLead = afterSilenceBlock ? Math.min(minLead, MIN_LEAD_AFTER_SILENCE_SEC) : minLead;

    const pieces = splitSingleWordByPeakSilenceRuns(
      w,
      data,
      pixelCount,
      durationSec,
      effGate,
      effMinLead,
      wordAnchorDbfs,
      continuationGateRaiseDb,
      voiceOnsetDbfs,
      voiceOnsetMinConsecutivePixels,
      afterSilenceBlock,
    );
    if (pieces == null) {
      const ws = Math.min(w.start, w.end);
      const we = Math.max(w.start, w.end);
      next.push({ ...w, start: ws, end: we });
    } else {
      next.push(...pieces);
    }
  }
  return next;
}

/**
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 * @param {import("../peaks-metrics.js").PeaksTimelineMetrics} metrics
 * @param {object} [options]
 */
export function splitLeadingSilenceInSubtitleLines(lines, metrics, options = {}) {
  if (!metrics?.data?.length || metrics.pixelCount < 2) return [...lines];

  const dbfsGate = options.dbfsGate ?? DBFS_GATE_DEFAULT;
  const minLead = options.minLeadingSilenceSec ?? DEFAULT_GAP_THRESHOLD_SEC;
  const wordAnchorDbfs = options.wordAnchorDbfs ?? WORD_ANCHOR_DBFS_DEFAULT;
  const continuationGateRaiseDb =
    options.continuationSplitGateRaiseDb ?? CONTINUATION_SPLIT_GATE_RAISE_DB_DEFAULT;
  const voiceOnsetDbfs = options.voiceOnsetDbfs ?? VOICE_ONSET_DBFS_DEFAULT;
  const voiceOnsetMinConsecutivePixels =
    options.voiceOnsetMinConsecutivePixels ?? VOICE_ONSET_MIN_CONSECUTIVE_PIXELS_DEFAULT;
  const { data, pixelCount, durationSec } = metrics;

  const outLines = lines.map((line) => {
    if (!line.words?.length) return line;

    const sorted = [...line.words].sort((a, b) => a.start - b.start || a.end - b.end);
    let cur = sorted;
    for (let r = 0; r < 12; r += 1) {
      const nxt = expandWordsOnePeakSilencePass(
        cur,
        data,
        pixelCount,
        durationSec,
        dbfsGate,
        minLead,
        wordAnchorDbfs,
        continuationGateRaiseDb,
        voiceOnsetDbfs,
        voiceOnsetMinConsecutivePixels,
      );
      if (wordsSplitSignature(nxt) === wordsSplitSignature(cur)) {
        cur = nxt;
        break;
      }
      cur = nxt;
    }

    if (cur.length === sorted.length) {
      const same = cur.every((nw, i) => {
        const ow = sorted[i];
        return (
          nw.start === ow.start &&
          nw.end === ow.end &&
          nw.word === ow.word &&
          (nw.is_silence || nw.isSilence) === (ow.is_silence || ow.isSilence)
        );
      });
      if (same) return line;
    }

    if (!cur.length) return line;

    const lo = Math.min(...cur.map((x) => x.start));
    const hi = Math.max(...cur.map((x) => x.end));
    return {
      ...line,
      start: lo,
      end: hi,
      words: cur,
      text: displayTextFromSubtitleWords(cur) || line.text,
    };
  });

  return outLines.map((l) => mergeConsecutiveSilenceWordsInLine(l));
}
