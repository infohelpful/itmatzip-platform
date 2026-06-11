/**
 * programClips → TimelineClip (Waveform / list-order SSOT adapter).
 */

/**
 * @param {readonly import("./program-clips-ssot.js").ProgramClip[]} programClips
 * @returns {import("./timeline-mapping.js").TimelineClip[]}
 */
export function programClipsToTimelineClips(programClips) {
  let id = 1;
  return (programClips || []).map((c) => {
    const clip = {
      id: id++,
      editStart: c.programStart,
      editEnd: c.programEnd,
      mediaIn: c.sourceStart,
      mediaOut: c.sourceEnd,
      timelineStart: c.programStart,
      timelineEnd: c.programEnd,
      mediaStart: c.sourceStart,
      mediaEnd: c.sourceEnd,
      effectiveSourceEnd: c.effectiveSourceEnd ?? c.sourceEnd,
      blockId: c.id,
      blockIndex: c.blockIndex,
      cueIndex: c.blockIndex,
      isSilence: !!c.isSilence,
    };
    return clip;
  });
}

/**
 * @param {readonly import("./program-clips-ssot.js").ProgramClip[]} programClips
 * @param {number} programSec
 */
export function mapProgramToMediaFromClips(programClips, programSec) {
  const t = Math.max(0, Number(programSec) || 0);
  const clips = programClipsToTimelineClips(programClips);
  if (!clips.length) return t;
  for (const c of clips) {
    if (t >= c.editStart && t < c.editEnd - 1e-6) {
      return c.mediaStart + (t - c.editStart);
    }
  }
  return clips[clips.length - 1].mediaEnd;
}

/**
 * @param {readonly import("./program-clips-ssot.js").ProgramClip[]} programClips
 * @param {number} mediaSec
 */
export function mapMediaToProgramFromClips(programClips, mediaSec) {
  const t = Math.max(0, Number(mediaSec) || 0);
  const clips = programClipsToTimelineClips(programClips);
  if (!clips.length) return t;
  for (const c of clips) {
    if (t >= c.mediaStart && t < c.mediaEnd - 1e-6) {
      return c.editStart + (t - c.mediaStart);
    }
  }
  return clips[clips.length - 1].timelineEnd;
}
