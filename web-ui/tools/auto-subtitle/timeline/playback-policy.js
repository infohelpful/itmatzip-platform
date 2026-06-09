/**
 * AutoSubtitle playbackPolicy.ts
 */

/** true → 단어 구간 스케줄, false → EDL passthrough 컷 스킵 */
export const USE_WORD_BASED_PLAYBACK_SCHEDULE =
  typeof globalThis !== "undefined" &&
  globalThis.__AUTO_SUBTITLE_WORD_PLAYBACK__ === true;

/** Phase 2 — _virtualIndex 이진 탐색 cue 하이라이트 (false로 끄면 legacy pickActiveCueIndex) */
export const USE_BLOCK_VIRTUAL_HIGHLIGHT =
  typeof globalThis === "undefined" ||
  globalThis.__AUTO_SUBTITLE_BLOCK_VIRTUAL_HIGHLIGHT__ !== false;

/** Phase 3C — 단어 soft-delete: virtual은 Duration Shrink, 재생은 soft-delete 구간 skip */
export const USE_BLOCK_DURATION_SHRINK =
  typeof globalThis === "undefined" ||
  globalThis.__AUTO_SUBTITLE_BLOCK_DURATION_SHRINK__ !== false;
