/**
 * 재생 동기화 — 기본: HTML `<audio>` 마스터 (Electron playMasterVideoSynced).
 * WebAudio(BufferSource)는 비활성(끊김 이슈).
 */

import { WebAudioMasterPlayback } from "./web-audio-master-playback.js";
import {
  assignMasterAudioTimelineSecIfNeeded,
  playMasterVideoSynced,
} from "./html-audio-master-playback.js";
import { mergeCutRanges, skipCutRangeAt } from "../playback.js";
import { getPlaybackOrchestrator } from "./playback-orchestrator.js";

/** @type {WebAudioMasterPlayback | null} */
let waEngine = null;

export function getWebAudioEngine() {
  if (!waEngine) waEngine = new WebAudioMasterPlayback();
  return waEngine;
}

/** 비디오 슬레이브 동기 — 잦은 seek 는 디코더·오디오 끊김 유발 */
export const VIDEO_SYNC_EPS_SEC = 0.1;
const VIDEO_SYNC_MIN_INTERVAL_MS = 120;
let lastVideoSyncWallMs = 0;

/** 재생 중 삭제 구간 스킵 — 매 RAF seek 금지 */
const VIDEO_SKIP_MIN_INTERVAL_MS = 100;
let lastVideoSkipWallMs = 0;
/** @type {{ start: number, end: number }[] | null} */
let cachedMergedSkipRanges = null;
/** @type {unknown} */
let cachedMergedSkipSource = null;

/**
 * @param {number} t
 * @param {{ start: number, end: number }[]} merged
 */
function findCutContainingTime(t, merged) {
  if (!merged.length) return null;
  let lo = 0;
  let hi = merged.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (merged[mid].start <= t) lo = mid + 1;
    else hi = mid - 1;
  }
  const r = merged[hi];
  if (r && t >= r.start && t < r.end) return r;
  return null;
}

/** @type {boolean} */
let htmlAudioMasterActive = false;

export function isHtmlAudioMasterActive() {
  return htmlAudioMasterActive;
}

/**
 * @param {string} mediaUrl
 * @param {HTMLVideoElement} video
 * @param {HTMLAudioElement} audio
 * @param {{
 *   startMediaSec: number,
 *   endMediaSec?: number | null,
 *   skipRanges: { start: number, end: number }[],
 *   onEnded?: () => void,
 * }} opts
 */
export async function startSyncedPlayback(mediaUrl, video, audio, opts) {
  const start = Math.max(0, opts.startMediaSec || 0);
  const skipRanges = opts.skipRanges || [];
  const orch = getPlaybackOrchestrator();
  if (orch.video !== video) orch.attachVideo(video, { masterAudio: audio });

  getWebAudioEngine().stopPlayback();
  orch.suspendSyncEngineForWebAudio();

  audio.pause();
  if (audio.src !== mediaUrl) {
    audio.src = mediaUrl;
    try {
      audio.load();
    } catch {
      /* ignore */
    }
  }
  audio.preload = "auto";

  const t = skipCutRangeAt(start, skipRanges);
  video.muted = true;
  audio.muted = false;
  audio.removeAttribute("muted");

  playMasterVideoSynced(audio, video, {
    targetVideoSec: t,
    targetAudioSec: t,
    onAudioPlayRejected: (err) => {
      console.warn("html-audio master play() rejected", err);
    },
  });

  htmlAudioMasterActive = true;

  const onEnded = () => {
    if (!htmlAudioMasterActive) return;
    htmlAudioMasterActive = false;
    orch.resumeSyncEngineAfterWebAudio();
    video.pause();
    audio.removeEventListener("ended", onEnded);
    if (opts.onEnded) opts.onEnded();
  };
  audio.addEventListener("ended", onEnded);

  return { mode: "html-audio", engine: null };
}

/**
 * @param {HTMLVideoElement} video
 * @param {HTMLAudioElement} [audio]
 */
export function stopSyncedPlayback(video, audio) {
  htmlAudioMasterActive = false;
  getWebAudioEngine().stopPlayback();
  getPlaybackOrchestrator().resumeSyncEngineAfterWebAudio();
  if (audio) {
    audio.pause();
    audio.removeAttribute("muted");
  }
  if (video) video.muted = false;
}

/**
 * @param {HTMLAudioElement} audio
 * @param {{ start: number, end: number }[]} skipRanges
 */
export function applySkipCutToHtmlAudioIfNeeded(audio, skipRanges) {
  if (!audio || audio.paused || audio.seeking) return false;
  const from = audio.currentTime;
  let t = skipCutRangeAt(from, skipRanges || []);
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    t = Math.min(t, Math.max(0, audio.duration - 0.001));
  }
  if (Math.abs(t - from) <= 0.001) return false;
  return assignMasterAudioTimelineSecIfNeeded(audio, t);
}

/**
 * @param {HTMLVideoElement} video
 * @param {HTMLAudioElement} audio
 * @param {{ skipRanges: { start: number, end: number }[] }} opts
 */
export function syncVideoFromHtmlAudioMaster(video, audio, opts) {
  if (!htmlAudioMasterActive || audio.paused) return false;
  if (video.seeking || audio.seeking) return true;
  if (audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    if (!video.paused) video.pause();
    return true;
  }
  if (video.paused && !audio.paused) {
    void video.play().catch(() => undefined);
  }

  applySkipCutToHtmlAudioIfNeeded(audio, opts.skipRanges || []);

  let mediaSec = audio.currentTime;
  if (Number.isFinite(video.duration) && video.duration > 0) {
    mediaSec = Math.min(mediaSec, Math.max(0, video.duration - 0.001));
  }

  const wall = performance.now();
  if (wall - lastVideoSyncWallMs < VIDEO_SYNC_MIN_INTERVAL_MS) return true;
  if (Math.abs(video.currentTime - mediaSec) > VIDEO_SYNC_EPS_SEC) {
    video.currentTime = mediaSec;
    lastVideoSyncWallMs = wall;
  }
  return true;
}

/**
 * @param {HTMLAudioElement} audio
 * @param {{ skipRanges: { start: number, end: number }[] }} opts
 * @returns {{ active: boolean, mediaSec: number | null }}
 */
export function readHtmlAudioMasterPlayhead(audio, opts) {
  if (!htmlAudioMasterActive || audio.paused) {
    return { active: false, mediaSec: null };
  }
  if (audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return { active: true, mediaSec: null };
  }
  let t = audio.currentTime;
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    t = Math.min(t, Math.max(0, audio.duration - 0.001));
  }
  return { active: true, mediaSec: t };
}

/** @deprecated WebAudio 경로 — readHtmlAudioMasterPlayhead 사용 */
export function readWebAudioMasterPlayhead(_video, _opts) {
  return { active: false, mediaSec: null };
}

/** @deprecated */
export function syncVideoPlayheadFromWebAudio(_video, _opts) {
  return false;
}

/**
 * 정지·시크 시 오디오·비디오 모두 컷 밖으로 맞춤.
 * @param {HTMLVideoElement} video
 * @param {HTMLAudioElement | null} audio
 * @param {{ skipRanges: { start: number, end: number }[] }} opts
 */
/**
 * 재생 중 비디오 1개만 디코딩 — 삭제 구간 진입 시에만 스로틀 seek.
 * @param {HTMLVideoElement} video
 * @param {{ start: number, end: number }[]} skipRanges
 */
export function applyThrottledVideoSkipCut(video, skipRanges) {
  if (!video || video.paused || video.seeking) return false;
  const skip = skipRanges || [];
  if (!skip.length) return false;

  if (skip !== cachedMergedSkipSource) {
    cachedMergedSkipSource = skip;
    cachedMergedSkipRanges = mergeCutRanges(skip);
  }
  const merged = cachedMergedSkipRanges || [];

  const from = video.currentTime;
  if (!findCutContainingTime(from, merged)) return false;

  const wall = performance.now();
  if (wall - lastVideoSkipWallMs < VIDEO_SKIP_MIN_INTERVAL_MS) return false;

  let t = skipCutRangeAt(from, skip);
  if (Number.isFinite(video.duration) && video.duration > 0) {
    t = Math.min(t, Math.max(0, video.duration - 0.001));
  }
  if (Math.abs(t - from) <= 0.001) return false;
  video.currentTime = t;
  lastVideoSkipWallMs = wall;
  return true;
}

export function resetPlaybackSkipThrottle() {
  lastVideoSkipWallMs = 0;
  lastVideoSyncWallMs = 0;
  cachedMergedSkipRanges = null;
  cachedMergedSkipSource = null;
}

export function applyPlaybackSkipToPreviewMedia(video, audio, opts) {
  const skip = opts.skipRanges || [];
  if (!skip.length) return;
  const from = video?.currentTime ?? 0;
  let t = skipCutRangeAt(from, skip);
  if (video && Number.isFinite(video.duration) && video.duration > 0) {
    t = Math.min(t, Math.max(0, video.duration - 0.001));
  }
  if (video && Math.abs(video.currentTime - t) > 0.002) {
    video.currentTime = t;
  }
  if (audio?.src) {
    assignMasterAudioTimelineSecIfNeeded(audio, t);
  }
}
