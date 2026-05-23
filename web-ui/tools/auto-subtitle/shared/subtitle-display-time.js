/**
 * AutoSubtitle subtitleDisplayTime.ts — 표시용 시간 라벨.
 */

export const DISPLAY_GAP_ABSORB_MS = 50;
export const DISPLAY_CROSS_CARD_GAP_ABSORB_MS = 120;

export function resolveDisplayEndSec(ownEndSec, nextStartSec, maxGapMs = DISPLAY_GAP_ABSORB_MS) {
  if (nextStartSec == null) return ownEndSec;
  if (!Number.isFinite(ownEndSec) || !Number.isFinite(nextStartSec)) return ownEndSec;
  const gapMs = (nextStartSec - ownEndSec) * 1000;
  if (gapMs > 0 && gapMs <= maxGapMs) return nextStartSec;
  return ownEndSec;
}
