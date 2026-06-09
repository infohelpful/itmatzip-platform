/**
 * 미디어 타임라인 SSOT — Whisper word times = audio axis.
 * A/V duration mismatch 시 video clock → word timeline 보정.
 */

import { mediaTimingDiagLog, mediaTimingDiagWarn } from "./media-timing-diagnostics.js?v=1";

/** @typedef {object} MediaTimingProbe
 * @property {boolean} [ok]
 * @property {number | null} [audio_duration_sec]
 * @property {number | null} [video_duration_sec]
 * @property {number | null} [format_duration_sec]
 * @property {number | null} [playback_duration_sec]
 * @property {number | null} [word_timeline_duration_sec]
 * @property {number | null} [whisper_duration_sec]
 * @property {number | null} [av_duration_delta_sec]
 * @property {boolean} [vfr_suspected]
 * @property {string | null} [preview_media_path]
 * @property {string | null} [source_media_path]
 * @property {string[]} [normalize_actions]
 */

/** Duration scale: word timeline → browser video element clock */
export const AV_DURATION_SCALE_MIN_DELTA_SEC = 0.05;
export const DURATION_RATIO_SCALE_THRESHOLD = 0.0005;

/** @type {MediaTimingProbe | null} */
let sessionMediaTiming = null;
/** @type {string | null} */
let sessionPreviewMediaPath = null;

/** Go MediaTimingContract 2.0 — word times align 1:1 with video.currentTime */
export function isSourceVideoPtsTimeline() {
  return sessionMediaTiming?.timeline_axis === "source_video_pts";
}

/** @param {MediaTimingProbe | null | undefined} probe */
export function setSessionMediaTiming(probe) {
  sessionMediaTiming = probe && typeof probe === "object" ? probe : null;
}

export function getSessionMediaTiming() {
  return sessionMediaTiming;
}

/** @param {string | null | undefined} path */
export function setSessionPreviewMediaPath(path) {
  const p = String(path || "").trim();
  sessionPreviewMediaPath = p || null;
}

export function clearSessionPreviewMediaPath() {
  sessionPreviewMediaPath = null;
}

export function getSessionPreviewMediaPath() {
  return sessionPreviewMediaPath;
}

export function clearSessionMediaTiming() {
  sessionMediaTiming = null;
  sessionPreviewMediaPath = null;
}

/**
 * Agent probe 없을 때 — `<video>` / `<audio>` duration으로 A/V mismatch 추정.
 * @param {HTMLVideoElement | null | undefined} video
 * @param {HTMLAudioElement | null | undefined} audio
 * @param {{ force?: boolean }} [opts]
 */
export function inferMediaTimingFromBrowserMedia(video, audio, opts = {}) {
  const force = opts.force === true;
  if (!force && sessionMediaTiming?.ok) return sessionMediaTiming;

  const videoDur =
    video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
  const audioDur =
    audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null;

  if (!videoDur && !audioDur) return null;

  const playback = audioDur ?? videoDur;
  const avDelta =
    videoDur != null && audioDur != null ? Math.abs(videoDur - audioDur) : null;

  const probe = {
    ok: true,
    source: "browser-media",
    audio_duration_sec: audioDur,
    video_duration_sec: videoDur,
    format_duration_sec: videoDur ?? audioDur,
    playback_duration_sec: playback,
    word_timeline_duration_sec: playback,
    av_duration_delta_sec: avDelta,
    vfr_suspected: false,
  };

  if (!force && sessionMediaTiming) {
    const prevDelta = num(sessionMediaTiming.av_duration_delta_sec);
    if (prevDelta != null && avDelta != null && Math.abs(prevDelta - avDelta) < 0.01) {
      return sessionMediaTiming;
    }
  }

  setSessionMediaTiming(probe);
  if (avDelta != null && avDelta >= AV_DURATION_SCALE_MIN_DELTA_SEC) {
    mediaTimingDiagWarn("browser A/V mismatch", {
      av_delta_sec: avDelta,
      audio_sec: audioDur,
      video_sec: videoDur,
    });
  } else {
    mediaTimingDiagLog("browser probe", {
      audio_sec: audioDur,
      video_sec: videoDur,
    });
  }
  return probe;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Word / Whisper / playback SSOT — source_video_pts uses video duration */
export function getAudioTimelineDurationSec() {
  const t = sessionMediaTiming;
  if (!t) return null;
  if (isSourceVideoPtsTimeline()) {
    return num(t.video_duration_sec) ?? num(t.word_timeline_duration_sec);
  }
  return (
    num(t.word_timeline_duration_sec) ??
    num(t.playback_duration_sec) ??
    num(t.audio_duration_sec) ??
    num(t.whisper_duration_sec)
  );
}

export function getVideoTimelineDurationSec() {
  const t = sessionMediaTiming;
  if (!t) return null;
  return num(t.video_duration_sec) ?? num(t.format_duration_sec);
}

/** @returns {number | null} videoSec per 1 wordSec when axes diverge */
export function getVideoToWordTimelineScale() {
  if (isSourceVideoPtsTimeline()) return null;
  const audio = getAudioTimelineDurationSec();
  const video = getVideoTimelineDurationSec();
  if (!audio || !video) return null;
  const delta = Math.abs(video - audio);
  if (delta < AV_DURATION_SCALE_MIN_DELTA_SEC) return null;
  return video / audio;
}

/** Browser video.currentTime → word.start/end axis */
export function mapVideoTimeToWordTimeline(videoSec) {
  const t = Number(videoSec);
  if (!Number.isFinite(t)) return 0;
  const scale = getVideoToWordTimelineScale();
  if (scale == null || Math.abs(scale - 1) < DURATION_RATIO_SCALE_THRESHOLD) return Math.max(0, t);
  return Math.max(0, t / scale);
}

/** Word axis → video seek target */
export function mapWordTimelineToVideoTime(wordSec) {
  const t = Number(wordSec);
  if (!Number.isFinite(t)) return 0;
  const scale = getVideoToWordTimelineScale();
  if (scale == null || Math.abs(scale - 1) < DURATION_RATIO_SCALE_THRESHOLD) return Math.max(0, t);
  return Math.max(0, t * scale);
}

/**
 * Whisper duration vs ffprobe audio SSOT.
 * @param {number | null | undefined} whisperDur
 */
export function computeWordTimelineIngestScale(whisperDur) {
  if (isSourceVideoPtsTimeline()) return 1;
  const audio = getAudioTimelineDurationSec();
  const w = Number(whisperDur);
  if (!audio || !(w > 0)) return 1;
  const scale = audio / w;
  if (Math.abs(audio - w) < AV_DURATION_SCALE_MIN_DELTA_SEC) return 1;
  if (Math.abs(scale - 1) < DURATION_RATIO_SCALE_THRESHOLD) return 1;
  return scale;
}

/**
 * peaks vs audio SSOT — ingest scale ratio (1 = no change).
 * @param {number | null | undefined} peaksDur
 * @param {number | null | undefined} whisperDur
 * @deprecated words stay on audio axis; use computeWordTimelineIngestScale + patch peaks duration
 */
export function computeIngestDurationScale(peaksDur, whisperDur) {
  return computeWordTimelineIngestScale(whisperDur);
}

/**
 * @param {HTMLVideoElement | null | undefined} video
 * @param {HTMLAudioElement | null | undefined} audio
 */
export function applyBrowserMediaDurationHints(video, audio) {
  const audioDur = getAudioTimelineDurationSec();
  if (!audioDur) return;
  const videoDur = getVideoTimelineDurationSec();
  if (video && Number.isFinite(video.duration) && videoDur && Math.abs(video.duration - videoDur) > 0.05) {
    /* readonly — hint only via session SSOT */
  }
  if (audio && Number.isFinite(audio.duration) && Math.abs(audio.duration - audioDur) > 0.05) {
    /* browser reports container duration; word clock uses mapVideoTimeToWordTimeline when needed */
  }
}

/**
 * Preview word-highlight clock — audio element SSOT, else mapped video.
 * @param {{
 *   audio?: HTMLAudioElement | null,
 *   video?: HTMLVideoElement | null,
 *   fallbackSec?: number,
 *   preferAudio?: boolean,
 * }} opts
 */
export function resolveWordTimelineClockSec(opts = {}) {
  const audio = opts.audio ?? null;
  const video = opts.video ?? null;
  const preferAudio = opts.preferAudio !== false;

  if (isSourceVideoPtsTimeline() && video && Number.isFinite(video.currentTime)) {
    return Math.max(0, video.currentTime);
  }

  if (preferAudio && audio && Number.isFinite(audio.currentTime)) {
    return Math.max(0, audio.currentTime);
  }

  if (video && Number.isFinite(video.currentTime)) {
    return mapVideoTimeToWordTimeline(video.currentTime);
  }

  if (audio && Number.isFinite(audio.currentTime)) {
    return Math.max(0, audio.currentTime);
  }

  const fb = Number(opts.fallbackSec);
  return Number.isFinite(fb) ? fb : 0;
}

/**
 * @param {import("./subtitles.js").SubtitleLine[]} lines
 * @param {number} scale
 */
export function scaleSubtitleLinesTimesInPlace(lines, scale) {
  if (!Array.isArray(lines) || !Number.isFinite(scale) || Math.abs(scale - 1) < DURATION_RATIO_SCALE_THRESHOLD) {
    return lines;
  }
  for (const line of lines) {
    if (line.start != null) line.start = Number(line.start) * scale;
    if (line.end != null) line.end = Number(line.end) * scale;
    if (Array.isArray(line.words)) {
      for (const w of line.words) {
        if (w.start != null) w.start = Number(w.start) * scale;
        if (w.end != null) w.end = Number(w.end) * scale;
      }
    }
  }
  return lines;
}
