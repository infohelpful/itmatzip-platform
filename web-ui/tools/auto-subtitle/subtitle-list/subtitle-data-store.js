/**
 * AutoSubtitle subtitleDataContext.tsx — React 없이 hub 래퍼.
 */

/**
 * @param {import("../hub/app-hub.js").SubtitleAppHub} hub
 */
export function createSubtitleDataStore(hub) {
  return {
    get cues() {
      return hub.cues;
    },
    get cutRanges() {
      return hub.cutRanges;
    },
    get gapFillWhenBuildingVrew() {
      return hub.gapFillWhenBuildingVrew;
    },
    set gapFillWhenBuildingVrew(v) {
      hub.gapFillWhenBuildingVrew = Boolean(v);
    },
    /** @param {(prev: import("../shared/subtitles.js").SubtitleLine[]) => import("../shared/subtitles.js").SubtitleLine[]} fn */
    applySubtitleChange(fn) {
      hub.applySubtitleChange(fn);
    },
    getCuesForList() {
      return hub.getCuesForList();
    },
  };
}
