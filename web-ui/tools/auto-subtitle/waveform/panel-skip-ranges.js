/**
 * 파형 패널 EDL skip — 줄 경계 coupled 뷰에서는 per-cue tombstone이 이웃 줄 음성을 먹지 않게.
 */

import { getCueWords } from "../subtitle-words.js";
import { collectDeletedRangesSec } from "../word-waveform-draw.js";

/**
 * @param {{ start: number, end: number }} viewWin
 * @param {readonly { start: number, end: number }[]} playbackSkips
 * @param {import("../subtitle-words.js").SubtitleCue | null | undefined} cue
 * @param {{ prevWord?: { start: number, end: number }, nextWord?: { start: number, end: number }, coupled?: boolean } | null | undefined} crossLineBounds
 */
export function buildPanelSkipRanges(viewWin, playbackSkips, cue, crossLineBounds) {
  const v0 = Math.min(viewWin.start, viewWin.end);
  const v1 = Math.max(viewWin.start, viewWin.end);
  /** @type {{ start: number, end: number }[]} */
  const skips = [...(playbackSkips || [])];
  if (!cue) return skips;

  const local = collectDeletedRangesSec(getCueWords(cue), v0, v1, cue);
  if (!crossLineBounds?.coupled) {
    skips.push(...local);
    return skips;
  }

  const protectLo = Math.min(
    crossLineBounds.prevWord?.start ?? Infinity,
    crossLineBounds.nextWord?.start ?? Infinity,
  );
  const protectHi = Math.max(
    crossLineBounds.prevWord?.end ?? -Infinity,
    crossLineBounds.nextWord?.end ?? -Infinity,
  );

  for (const r of local) {
    if (r.end <= protectLo + 1e-9 || r.start >= protectHi - 1e-9) {
      skips.push(r);
    }
  }
  return skips;
}
