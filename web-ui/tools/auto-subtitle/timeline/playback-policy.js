/**
 * AutoSubtitle playbackPolicy.ts
 */

/** true → 단어 구간 스케줄, false → EDL passthrough 컷 스킵 */
export const USE_WORD_BASED_PLAYBACK_SCHEDULE =
  typeof globalThis !== "undefined" &&
  globalThis.__AUTO_SUBTITLE_WORD_PLAYBACK__ === true;
