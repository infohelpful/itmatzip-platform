/**
 * V36 목록 재정렬 + virtual gap shift (source 앵커 보존).
 */

import { listableCueIndices } from "./subtitle-list-indices.js?v=6";
import { reorderCuesByListInsert } from "./subtitle-list-indices.js?v=6";
import {
  anchorSourceTimesIfMissing,
  getCueSourceEnd,
  getCueSourceStart,
  shiftCueVirtualTimes,
} from "./dual-axis.js?v=1";
import { syncSubtitleLineFromWords } from "./subtitles.js?v=28";

const EPS = 1e-5;
const MIN_GAP_SEC = 0.02;

/**
 * @typedef {{
 *   ok: boolean,
 *   cues: import("./subtitles.js").SubtitleLine[],
 *   reason?: string,
 *   targetCueIndex?: number,
 * }} ReorderResult
 */

/**
 * @param {readonly import("./subtitles.js").SubtitleLine[]} cues
 */
function deepCloneCues(cues) {
  return JSON.parse(JSON.stringify(cues || []));
}

/**
 * @param {readonly import("./subtitles.js").SubtitleLine[]} cues
 * @param {number} listPos
 */
function cueIndexAtListPos(cues, listPos) {
  const indices = listableCueIndices(cues);
  return indices[listPos] ?? -1;
}

/**
 * 이동 대상 cue의 virtual 시간을 목록 이웃 갭에 shift-only 배치.
 *
 * @param {import("./subtitles.js").SubtitleLine[]} cues
 * @param {number} movedCueIndex
 */
function relocateMovedCueVirtualTimes(cues, movedCueIndex) {
  const indices = listableCueIndices(cues);
  const listPos = indices.indexOf(movedCueIndex);
  if (listPos < 0) return { ok: true };

  const cue = cues[movedCueIndex];
  if (!cue) return { ok: false, reason: "cue_missing" };

  const dur = Math.max(
    (Number(cue.end) || 0) - (Number(cue.start) || 0),
    getCueSourceEnd(cue) - getCueSourceStart(cue),
    MIN_GAP_SEC,
  );

  const prevCue = listPos > 0 ? cues[indices[listPos - 1]] : null;
  const nextCue = listPos + 1 < indices.length ? cues[indices[listPos + 1]] : null;

  const gapStart = prevCue ? Number(prevCue.end) || 0 : 0;
  const gapEnd = nextCue ? Number(nextCue.start) || gapStart + dur : gapStart + dur + 3600;
  const gapSize = gapEnd - gapStart;

  if (gapSize + EPS < dur) {
    return { ok: false, reason: "duration_overflow" };
  }

  const newStart = gapStart;
  const delta = newStart - (Number(cue.start) || 0);
  const shifted = shiftCueVirtualTimes(cue, delta);
  shifted.end = newStart + dur;
  if (shifted.words?.length) {
    shifted.words = shifted.words.map((w) => ({
      ...w,
      start: (Number(w.start) || 0) + delta,
      end: (Number(w.end) || 0) + delta,
    }));
  }
  cues[movedCueIndex] = syncSubtitleLineFromWords(shifted);
  return { ok: true };
}

/**
 * @param {readonly import("./subtitles.js").SubtitleLine[]} cues
 * @param {number} fromListPos
 * @param {number} insertBeforePos
 * @returns {ReorderResult}
 */
export function reorderCuesWithRelocate(cues, fromListPos, insertBeforePos) {
  let working = anchorSourceTimesIfMissing(deepCloneCues(cues));
  const beforeIdx = cueIndexAtListPos(working, fromListPos);
  if (beforeIdx < 0) {
    return { ok: false, cues: working, reason: "invalid_from_pos" };
  }

  working = reorderCuesByListInsert(working, fromListPos, insertBeforePos);

  let targetListPos = insertBeforePos;
  if (fromListPos < insertBeforePos) targetListPos = insertBeforePos - 1;
  const movedCueIndex = cueIndexAtListPos(working, targetListPos);
  if (movedCueIndex < 0) {
    return { ok: false, cues: working, reason: "invalid_target_pos" };
  }

  const relocate = relocateMovedCueVirtualTimes(working, movedCueIndex);
  if (!relocate.ok) {
    return {
      ok: false,
      cues: anchorSourceTimesIfMissing(deepCloneCues(cues)),
      reason: relocate.reason || "relocate_failed",
      targetCueIndex: beforeIdx,
    };
  }

  return {
    ok: true,
    cues: working,
    targetCueIndex: movedCueIndex,
  };
}
