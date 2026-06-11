/**
 * V41 공용 VirtualAudioMap — 프리뷰·보내기 SSOT.
 */

import { listableCueIndices } from "./subtitle-list-indices.js?v=6";
import { getCueWords } from "../subtitle-words.js?v=18";
import { wordVisibleInWordChipRail } from "./subtitles.js?v=28";
import { getCueSourceEnd, getCueSourceStart, getWordSourceEnd } from "./dual-axis.js?v=1";
import { normalizeCutRanges, remapTimeByCuts } from "../export/export-timeline.js?v=2";

const CLIP_END_TAIL_PAD_SEC = 0.2;

/** Python `MAX_FILTER_CONCAT_SEGMENTS` (`auto_subtitle_burn_in.py`) 와 동기화 */
export const MAX_FAST_PATH_SEGMENTS = 256;

const KEEP_SEGMENT_EPS = 1e-6;

/**
 * 유효 keep run 개수 — Python `normalize_keep_segments` 와 동치.
 *
 * @param {readonly object[] | null | undefined} map
 */
export function countValidKeepSegments(map) {
  let count = 0;
  for (const raw of map || []) {
    if (!raw || typeof raw !== "object") continue;
    const start = Number(raw.sourceStart ?? raw.source_start ?? NaN);
    const end = Number(raw.sourceEnd ?? raw.source_end ?? NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end > start + KEEP_SEGMENT_EPS) count += 1;
  }
  return count;
}

/**
 * @typedef {{
 *   cueIndex: number,
 *   sourceStart: number,
 *   sourceEnd: number,
 *   effectiveSourceEnd: number,
 *   editStart: number,
 *   editEnd: number,
 *   isSilence: boolean,
 * }} VirtualAudioSegment
 */

/**
 * @param {number} sec
 * @param {readonly { start: number, end: number }[]} cuts
 */
function applyCutsToSourceSec(sec, cuts) {
  return remapTimeByCuts(Math.max(0, Number(sec) || 0), cuts);
}

/**
 * @param {number} srcStart
 * @param {number} srcEnd
 * @param {readonly { start: number, end: number }[]} cuts
 */
function trimSourceSpanByCuts(srcStart, srcEnd, cuts) {
  const a = applyCutsToSourceSec(srcStart, cuts);
  const b = applyCutsToSourceSec(srcEnd, cuts);
  if (b <= a + 1e-5) return null;
  return { sourceStart: a, sourceEnd: b };
}

/**
 * @param {object} cue
 * @param {object | null} nextCue
 * @param {boolean} [withTailPad]
 */
function clipSourceEndForCue(cue, nextCue = null, withTailPad = true) {
  const mediaStart = getCueSourceStart(cue);
  let mediaEnd = getCueSourceEnd(cue);
  const words = getCueWords(cue);
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const w = words[i];
    if (!wordVisibleInWordChipRail(w)) continue;
    const e = getWordSourceEnd(w, cue);
    if (Number.isFinite(e)) {
      mediaEnd = Math.max(mediaEnd, e + (withTailPad ? CLIP_END_TAIL_PAD_SEC : 0));
      break;
    }
  }
  if (nextCue) {
    const nextVirtualStart = Number(nextCue.start) || 0;
    if (nextVirtualStart <= mediaEnd + 1e-5) {
      return mediaEnd;
    }
    const nextSourceStart = getCueSourceStart(nextCue);
    if (Number.isFinite(nextSourceStart) && nextSourceStart > mediaEnd + 1e-5) {
      if (withTailPad) mediaEnd = nextSourceStart;
    }
  }
  return mediaEnd;
}

/** 전환 판정용 — tail pad 미포함 */
function clipEffectiveSourceEndForCue(cue, nextCue = null) {
  return clipSourceEndForCue(cue, nextCue, false);
}

/**
 * 인접 segment sourceStart 단조 증가 여부.
 *
 * @param {readonly VirtualAudioSegment[]} map
 */
export function isSourceStartMonotonic(map) {
  for (let i = 1; i < map.length; i += 1) {
    if (map[i].sourceStart + 1e-5 < map[i - 1].sourceStart) return false;
  }
  return true;
}

/**
 * @param {readonly VirtualAudioSegment[]} segments
 */
function removeAdjacentSourceOverlaps(segments) {
  if (segments.length <= 1) return segments.map((s) => ({ ...s }));
  /** @type {VirtualAudioSegment[]} */
  const out = segments.map((s) => ({ ...s }));
  for (let i = 0; i < out.length - 1; i += 1) {
    const a = out[i];
    const b = out[i + 1];
    const overlapStart = Math.max(a.sourceStart, b.sourceStart);
    const overlapEnd = Math.min(a.sourceEnd, b.sourceEnd);
    if (overlapEnd <= overlapStart + KEEP_SEGMENT_EPS) continue;
    if (b.sourceStart >= a.sourceStart - KEEP_SEGMENT_EPS) {
      a.sourceEnd = Math.min(a.sourceEnd, b.sourceStart);
      if (Number.isFinite(a.effectiveSourceEnd)) {
        a.effectiveSourceEnd = Math.min(a.effectiveSourceEnd, b.sourceStart);
      }
    } else {
      b.sourceStart = Math.max(b.sourceStart, a.sourceEnd);
      if (Number.isFinite(b.effectiveSourceEnd)) {
        b.effectiveSourceEnd = Math.max(b.effectiveSourceEnd, a.sourceEnd);
      }
    }
    if (a.sourceEnd <= a.sourceStart + KEEP_SEGMENT_EPS) {
      out.splice(i, 1);
      i -= 1;
      continue;
    }
    if (b.sourceEnd <= b.sourceStart + KEEP_SEGMENT_EPS) {
      out.splice(i + 1, 1);
    }
  }
  return out.filter((s) => s.sourceEnd > s.sourceStart + KEEP_SEGMENT_EPS);
}

/**
 * @param {readonly VirtualAudioSegment[]} segments
 */
function recalcEditTimelineFromSource(segments) {
  let cursor = 0;
  return segments.map((s) => {
    const dur = s.sourceEnd - s.sourceStart;
    const editStart = cursor;
    const editEnd = cursor + dur;
    cursor = editEnd;
    return { ...s, editStart, editEnd };
  });
}

/**
 * @param {readonly object[]} cues
 * @param {{ cutRanges?: readonly { start: number, end: number }[] }} [opts]
 * @returns {VirtualAudioSegment[]}
 */
export function buildVirtualAudioMap(cues, opts = {}) {
  const cuts = normalizeCutRanges(opts.cutRanges || []);
  const indices = listableCueIndices(cues);
  /** @type {VirtualAudioSegment[]} */
  const segments = [];
  let editCursor = 0;

  for (let i = 0; i < indices.length; i += 1) {
    const cueIndex = indices[i];
    const cue = cues[cueIndex];
    if (!cue) continue;
    const nextIdx = i + 1 < indices.length ? indices[i + 1] : -1;
    const nextCue = nextIdx >= 0 ? cues[nextIdx] : null;

    let srcStart = getCueSourceStart(cue);
    let srcEnd = clipSourceEndForCue(cue, nextCue);
    let effectiveEnd = clipEffectiveSourceEndForCue(cue, nextCue);
    if (srcEnd <= srcStart + 1e-5) continue;

    if (cuts.length) {
      const trimmed = trimSourceSpanByCuts(srcStart, srcEnd, cuts);
      if (!trimmed) continue;
      srcStart = trimmed.sourceStart;
      srcEnd = trimmed.sourceEnd;
      const trimmedEff = trimSourceSpanByCuts(srcStart, effectiveEnd, cuts);
      effectiveEnd = trimmedEff ? trimmedEff.sourceEnd : srcEnd;
    }
    effectiveEnd = Math.max(srcStart, Math.min(effectiveEnd, srcEnd));

    const dur = srcEnd - srcStart;
    const editStart = editCursor;
    const editEnd = editCursor + dur;
    segments.push({
      cueIndex,
      sourceStart: srcStart,
      sourceEnd: srcEnd,
      effectiveSourceEnd: effectiveEnd,
      editStart,
      editEnd,
      isSilence: !!(cue.is_silence || cue.isSilence),
    });
    editCursor = editEnd;
  }
  const deduped = removeAdjacentSourceOverlaps(segments);
  return recalcEditTimelineFromSource(deduped);
}

/**
 * @param {readonly VirtualAudioSegment[]} map
 * @param {number} cueIndex
 */
export function segmentForCueIndex(map, cueIndex) {
  return (map || []).find((s) => s.cueIndex === cueIndex) ?? null;
}

/**
 * Stitched Program export cue lines.
 *
 * @param {readonly object[]} cues
 * @param {{ cutRanges?: readonly { start: number, end: number }[] }} [opts]
 */
export function buildStitchedProgramExportCues(cues, opts = {}) {
  const map = buildVirtualAudioMap(cues, opts);
  const byCue = new Map(map.map((s) => [s.cueIndex, s]));
  /** @type {{ start: number, end: number, text: string, words?: object[] }[]} */
  const out = [];

  for (const seg of map) {
    const cue = cues[seg.cueIndex];
    if (!cue) continue;
    const text = String(cue.text ?? "").trim();
    const words = getCueWords(cue);
    const hasWords = words.length > 0;
    if (!text && !hasWords) continue;

    if (hasWords) {
      const vis = words.filter((w) => wordVisibleInWordChipRail(w));
      if (!vis.length) continue;
      const remapped = vis.map((w) => {
        const ws = seg.editStart + (Number(w.start) - getCueSourceStart(cue));
        const we = seg.editStart + (Number(w.end) - getCueSourceStart(cue));
        return {
          ...w,
          start: Math.max(seg.editStart, ws),
          end: Math.min(seg.editEnd, we),
        };
      });
      const start = Math.min(...remapped.map((w) => w.start));
      const end = Math.max(...remapped.map((w) => w.end));
      out.push({ start, end, text: text || remapped.map((w) => w.word).join(" "), words: remapped });
    } else {
      out.push({ start: seg.editStart, end: seg.editEnd, text });
    }
  }

  void byCue;
  return out;
}
