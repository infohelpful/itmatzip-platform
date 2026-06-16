/**
 * Line Mode — API / reflow 직렬화.
 */

/**
 * @param {readonly import("../subtitles.js").SubtitleLine[]} cues
 */
export function serializeCuesForReflow(cues) {
  return (cues || []).map((cue) => ({
    start: Number(cue.start) || 0,
    end: Number(cue.end) || 0,
    text: String(cue.text ?? ""),
    flags: cue.flags
      ? { ...cue.flags }
      : { userMoved: false, autoReflow: false },
    is_silence: cue.is_silence === true || cue.isSilence === true,
    isSilence: cue.isSilence === true || cue.is_silence === true,
    words: (cue.words || []).map((w) => ({
      word: String(w.word ?? ""),
      start: Number(w.start) || 0,
      end: Number(w.end) || 0,
      hintStart: Number(w.hintStart ?? w.start) || 0,
      hintEnd: Number(w.hintEnd ?? w.end) || 0,
      is_silence: w.is_silence === true || w.isSilence === true,
      isSilence: w.isSilence === true || w.is_silence === true,
    })),
  }));
}

/**
 * @param {object | null | undefined} snapGrid
 */
export function buildLineModeProjectSection(snapGrid) {
  return {
    version: 1,
    reflowMode: "horizontal",
    snapGrid: snapGrid ? JSON.parse(JSON.stringify(snapGrid)) : null,
  };
}

/**
 * @param {unknown} raw
 */
export function parseLineModeFromProject(raw) {
  if (!raw || typeof raw !== "object") return null;
  const doc = /** @type {Record<string, unknown>} */ (raw);
  const lm = doc.lineMode ?? doc.line_mode;
  if (!lm || typeof lm !== "object") return null;
  const section = /** @type {Record<string, unknown>} */ (lm);
  const mode = String(section.reflowMode ?? section.reflow_mode ?? "horizontal");
  const snapGrid = section.snapGrid ?? section.snap_grid ?? null;
  return {
    reflowMode: mode === "vertical" ? "vertical" : "horizontal",
    snapGrid: snapGrid && typeof snapGrid === "object" ? snapGrid : null,
  };
}
