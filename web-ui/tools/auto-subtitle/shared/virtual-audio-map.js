/**
 * V41 공용 VirtualAudioMap — 프리뷰·보내기 SSOT.
 */

import { listableCueIndices } from "./subtitle-list-indices.js?v=6";
import { getCueWords } from "../subtitle-words.js?v=18";
import { wordVisibleInWordChipRail } from "./subtitles.js?v=28";
import { getCueSourceEnd, getCueSourceStart, getWordSourceEnd } from "./dual-axis.js?v=1";
import { normalizeCutRanges, remapTimeByCuts } from "../export/export-timeline.js?v=2";

const CLIP_END_TAIL_PAD_SEC = 0.2;

/**
 * @typedef {{
 *   cueIndex: number,
 *   sourceStart: number,
 *   sourceEnd: number,
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
 */
function clipSourceEndForCue(cue, nextCue = null) {
  const mediaStart = getCueSourceStart(cue);
  let mediaEnd = getCueSourceEnd(cue);
  const words = getCueWords(cue);
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const w = words[i];
    if (!wordVisibleInWordChipRail(w)) continue;
    const e = getWordSourceEnd(w, cue);
    if (Number.isFinite(e)) {
      mediaEnd = Math.max(mediaEnd, e + CLIP_END_TAIL_PAD_SEC);
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
      mediaEnd = nextSourceStart;
    }
  }
  return mediaEnd;
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
    if (srcEnd <= srcStart + 1e-5) continue;

    if (cuts.length) {
      const trimmed = trimSourceSpanByCuts(srcStart, srcEnd, cuts);
      if (!trimmed) continue;
      srcStart = trimmed.sourceStart;
      srcEnd = trimmed.sourceEnd;
    }

    const dur = srcEnd - srcStart;
    const editStart = editCursor;
    const editEnd = editCursor + dur;
    segments.push({
      cueIndex,
      sourceStart: srcStart,
      sourceEnd: srcEnd,
      editStart,
      editEnd,
      isSilence: !!(cue.is_silence || cue.isSilence),
    });
    editCursor = editEnd;
  }
  return segments;
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
