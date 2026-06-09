/**
 * 자막 목록(표시 IDX) 기준 재생 — 하이라이트·부드러운 stitched 프리뷰 타임라인.
 */

import { listableCueIndices } from "./subtitle-list-indices.js?v=6";
import { pickActiveWordIndex } from "../playback.js?v=31";
import { getCueSourceEnd, getCueSourceStart, getWordSourceEnd } from "./dual-axis.js?v=1";
import { buildVirtualAudioMap } from "./virtual-audio-map.js?v=2";
import { getCueWords } from "../subtitle-words.js?v=18";
import { wordVisibleInWordChipRail } from "./subtitles.js?v=28";
import {
  mapMediaToProgramSec,
  mapProgramToMediaSec,
  programDurationSec,
} from "./timeline-mapping.js";

const CLIP_END_TAIL_PAD_SEC = 0.2;

/**
 * @param {object} cue
 * @param {object | null} [nextCue]
 * @returns {number}
 */
export function clipMediaEndForCue(cue, nextCue = null) {
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

let cacheVersion = 0;
let cacheBuiltForVersion = -1;
/** @type {number[]} */
let cachedIndices = [];

/** @type {import("./timeline-mapping.js").TimelineClip[] | null} */
let cachedListClips = null;
/** @type {ReturnType<typeof createListOrderPreviewMapping> | null} */
let cachedListMapping = null;

export function bumpListableCueIndicesCache() {
  cacheVersion += 1;
  cachedListClips = null;
  cachedListMapping = null;
}

/**
 * @param {readonly object[]} cues
 */
export function getListableCueIndicesCached(cues) {
  if (cacheBuiltForVersion !== cacheVersion) {
    cachedIndices = listableCueIndices(cues);
    cachedListClips = null;
    cachedListMapping = null;
    cacheBuiltForVersion = cacheVersion;
  }
  return cachedIndices;
}

/**
 * @param {readonly object[]} cues
 * @returns {import("./timeline-mapping.js").TimelineClip[]}
 */
export function buildListOrderTimelineClips(cues, opts = {}) {
  const map = buildVirtualAudioMap(cues, { cutRanges: opts.cutRanges });
  /** @type {import("./timeline-mapping.js").TimelineClip[]} */
  const clips = [];
  let id = 1;
  for (const seg of map) {
    clips.push({
      id: id++,
      editStart: seg.editStart,
      editEnd: seg.editEnd,
      mediaIn: seg.sourceStart,
      mediaOut: seg.sourceEnd,
      timelineStart: seg.editStart,
      timelineEnd: seg.editEnd,
      mediaStart: seg.sourceStart,
      mediaEnd: seg.sourceEnd,
      cueIndex: seg.cueIndex,
    });
  }
  return clips;
}

/**
 * @param {readonly object[]} cues
 * @param {number} mediaDurationSec
 */
export function createListOrderPreviewMapping(cues, mediaDurationSec) {
  if (cachedListMapping && cacheBuiltForVersion === cacheVersion) {
    return { clips: cachedListClips ?? [], mapping: cachedListMapping };
  }
  const clips = buildListOrderTimelineClips(cues);
  const mapping = {
    clips,
    mergedCuts: [],
    mediaEndHintSec: Math.max(0, Number(mediaDurationSec) || 0),
    programToMediaSec: (p) => mapProgramToMediaSec(p, clips),
    mediaToProgramSec: (m) => mapMediaToProgramSec(m, clips),
    programToMasterAudioSec: (p) => Math.max(0, p),
    masterAudioToProgramSec: (a) => Math.max(0, a),
    masterMode: "stitched",
  };
  cachedListClips = clips;
  cachedListMapping = mapping;
  return { clips, mapping };
}

/**
 * @param {readonly object[]} cues
 * @returns {{ clipIndex: number, cueIndex: number }[]}
 */
export function listPlayableClipCuePairs(cues) {
  const indices = getListableCueIndicesCached(cues);
  /** @type {{ clipIndex: number, cueIndex: number }[]} */
  const pairs = [];
  for (const ci of indices) {
    const cue = cues[ci];
    if (!cue) continue;
    const ms = Number(cue.start) || 0;
    const me = Number(cue.end) || ms;
    if (me <= ms + 1e-5) continue;
    pairs.push({ clipIndex: pairs.length, cueIndex: ci });
  }
  return pairs;
}

/**
 * @param {readonly object[]} cues
 * @param {number} listPos
 */
export function clipIndexForListPos(clips, cues, listPos) {
  const ci = cueIndexAtListPos(cues, listPos);
  if (ci < 0) return 0;
  if (clips?.length) {
    const clipIdx = clips.findIndex((c) => c.cueIndex === ci);
    if (clipIdx >= 0) return clipIdx;
  }
  const pairs = listPlayableClipCuePairs(cues);
  const idx = pairs.findIndex((p) => p.cueIndex === ci);
  return idx >= 0 ? idx : 0;
}

/**
 * @param {readonly import("./timeline-mapping.js").TimelineClip[]} clips
 * @param {readonly object[]} cues
 * @param {number} clipIndex
 */
export function cueIndexForClipIndex(clips, cues, clipIndex) {
  if (clipIndex < 0) return -1;
  const clip = clips?.[clipIndex];
  if (clip && Number.isInteger(clip.cueIndex)) return clip.cueIndex;
  const pairs = listPlayableClipCuePairs(cues);
  if (clipIndex >= pairs.length) return -1;
  return pairs[clipIndex].cueIndex;
}

/**
 * 미디어 시각 → 목록 재생 클립 인덱스 (선형 탐색 + 현재 클립 우선).
 *
 * @param {readonly import("./timeline-mapping.js").TimelineClip[]} clips
 * @param {number} mediaSec
 * @param {number} preferClipIndex
 */
export function resolveListClipIndexFromMedia(
  clips,
  mediaSec,
  preferClipIndex = 0,
  opts = {},
) {
  if (!clips.length) return 0;
  const t = Math.max(0, mediaSec);
  const prefer =
    preferClipIndex >= 0 && preferClipIndex < clips.length ? preferClipIndex : 0;

  const inClip = (c) => t >= c.mediaStart - 0.02 && t < c.mediaEnd + 0.02;

  /** 목록 순서 재생 — prefer±1만 (재정렬 시 미디어 겹침 역매핑 오류 방지) */
  if (opts.listOrderSequential) {
    const cur = clips[prefer];
    if (cur && inClip(cur)) return prefer;
    if (prefer + 1 < clips.length && inClip(clips[prefer + 1])) return prefer + 1;
    const next = prefer + 1 < clips.length ? clips[prefer + 1] : null;
    if (cur && next && t >= next.mediaStart - 0.012) return prefer + 1;
    return prefer;
  }

  const preferred = clips[prefer];
  if (inClip(preferred)) return prefer;
  if (t >= preferred.mediaEnd - 0.018 && prefer + 1 < clips.length) {
    return prefer + 1;
  }

  for (let i = prefer; i < clips.length; i += 1) {
    if (inClip(clips[i])) return i;
  }
  for (let i = prefer - 1; i >= 0; i -= 1) {
    if (inClip(clips[i])) return i;
  }

  if (prefer + 1 < clips.length) return prefer + 1;
  return clips.length - 1;
}

/**
 * 목록 순서 클립 — 꼬리 도달 시 다음 클립(미디어 시각 역행 가능).
 *
 * @param {readonly import("./timeline-mapping.js").TimelineClip[]} clips
 * @param {number} mediaSec
 * @param {number} clipPos
 * @param {number} [tailSec]
 */
export function jumpListOrderClipAtTail(mediaSec, clips, clipPos, tailSec = 0.04) {
  if (!clips.length || clipPos < 0 || clipPos >= clips.length) {
    return { jumped: false };
  }
  const cur = clips[clipPos];
  const t = Math.max(0, mediaSec);
  if (t < cur.mediaEnd - tailSec) return { jumped: false };
  const nextPos = clipPos + 1;
  if (nextPos >= clips.length) return { jumped: false };
  const next = clips[nextPos];
  const gap = next.mediaStart - t;
  /** 미디어 축이 이어지면 seek 없이 자연 재생 */
  const softForward = gap >= -0.015 && gap < 0.1;
  return {
    jumped: true,
    toMediaSec: next.mediaStart,
    toClipPos: nextPos,
    fromClipPos: clipPos,
    softForward,
  };
}

/**
 * @param {readonly import("./timeline-mapping.js").TimelineClip[]} clips
 * @param {number} listPos
 */
export function programSecForListPos(clips, listPos) {
  if (!clips.length || listPos < 0) return 0;
  const i = Math.min(listPos, clips.length - 1);
  return clips[i].editStart;
}

/**
 * @param {readonly import("./timeline-mapping.js").TimelineClip[]} clips
 * @param {number} programSec
 */
export function listPosFromProgramSec(clips, programSec) {
  if (!clips.length) return 0;
  const t = Math.max(0, programSec);
  for (let i = 0; i < clips.length; i += 1) {
    const c = clips[i];
    if (t >= c.editStart && t < c.editEnd - 1e-6) return i;
  }
  if (t >= clips[clips.length - 1].editEnd - 1e-6) return clips.length - 1;
  return 0;
}

/**
 * @param {readonly object[]} cues
 * @param {number} cueIndex
 */
export function listPosForCueIndex(cues, cueIndex) {
  const pos = getListableCueIndicesCached(cues).indexOf(cueIndex);
  return pos >= 0 ? pos : -1;
}

/**
 * @param {readonly object[]} cues
 * @param {number} listPos
 */
export function cueIndexAtListPos(cues, listPos) {
  const indices = getListableCueIndicesCached(cues);
  if (listPos < 0 || listPos >= indices.length) return -1;
  return indices[listPos];
}

/**
 * @param {readonly object[]} cues
 * @param {number} listPos
 * @param {number} t media axis (edit sec for chips)
 */
export function resolvePlaybackAtListPos(cues, listPos, t) {
  const ci = cueIndexAtListPos(cues, listPos);
  if (ci < 0) return { cueIndex: -1, wordIndex: -1 };
  const cue = cues[ci];
  return {
    cueIndex: ci,
    wordIndex: cue ? pickActiveWordIndex(cue, t) : -1,
  };
}

/**
 * @param {readonly import("./timeline-mapping.js").TimelineClip[]} clips
 */
export function listPreviewProgramDurationSec(clips) {
  return programDurationSec(clips);
}
