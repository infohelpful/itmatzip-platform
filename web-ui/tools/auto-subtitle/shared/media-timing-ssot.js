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

const STORAGE_PREVIEW_PATH = "auto-subtitle:preview-media-path";

/** Windows 로컬 경로 — ₩/¥ 백슬래시·NFC (agent normalize_media_path 와 동일 목적) */
export function normalizeAgentMediaPath(raw) {
  let p = String(raw ?? "").trim();
  if (!p) return "";
  p = p.replace(/^["']|["']$/g, "");
  try {
    p = p.normalize("NFC");
  } catch {
    /* ignore */
  }
  p = p.replace(/\u00A5/g, "\\").replace(/\u20A9/g, "\\");
  p = p.replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, "");
  p = p.replace(/^[\\/]+([A-Za-z]:[\\/])/i, "$1");
  p = p.replace(/^([A-Za-z])[\\/](?![\\/])/, "$1:\\");
  if (/^[A-Za-z]:/.test(p)) {
    const drive = p.slice(0, 2);
    const rest = p.slice(2).replace(/[/\\]+/g, "\\");
    p = drive + rest;
  }
  return p;
}

/** U+FFFD — sessionStorage/URL 왕복 후 한글 경로 깨짐 */
export function hasCorruptMediaPathChars(raw) {
  const p = String(raw ?? "");
  if (!p) return false;
  if (/\uFFFD/.test(p)) return true;
  try {
    if (/%EF%BF%BD/i.test(encodeURIComponent(p))) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** 미리보기 session — workspace CFR만 (D:\\ 원본은 브라우저 한글 깨짐) */
function isWorkspacePreviewStoragePath(raw) {
  const s = String(raw || "").replace(/\//g, "\\");
  return /\\auto-subtitle\\workspace\\/i.test(s);
}

/** @type {MediaTimingProbe | null} */
let sessionMediaTiming = null;
/** @type {string | null} */
let sessionPreviewMediaPath = null;
/** program-master.mp4 재생 — video.currentTime = program 축 */
let programPlaybackActive = false;

/** @param {string | null | undefined} path */
export function setSessionPreviewMediaPath(path) {
  const p = normalizeAgentMediaPath(path);
  if (p && hasCorruptMediaPathChars(p)) {
    mediaTimingDiagWarn("setSessionPreviewMediaPath", "corrupt path ignored");
    return;
  }
  if (p && !isWorkspacePreviewStoragePath(p)) {
    mediaTimingDiagWarn("setSessionPreviewMediaPath", "non-workspace preview ignored");
    return;
  }
  sessionPreviewMediaPath = p || null;
  try {
    if (p) sessionStorage.setItem(STORAGE_PREVIEW_PATH, p);
    else sessionStorage.removeItem(STORAGE_PREVIEW_PATH);
  } catch {
    /* ignore */
  }
}

/** V5 — program-master 프리뷰 재생 (word lookup은 source↔program 변환) */
export function isProgramPlaybackTimeline() {
  return programPlaybackActive;
}

/** @param {boolean} active */
export function setProgramPlaybackActive(active) {
  programPlaybackActive = !!active;
  if (!programPlaybackActive) return;
  if (sessionMediaTiming && sessionMediaTiming.timeline_axis !== "program") {
    sessionMediaTiming = { ...sessionMediaTiming, timeline_axis: "program" };
  }
}

/** Go MediaTimingContract 2.0 — word times align 1:1 with video.currentTime (source media only) */
export function isSourceVideoPtsTimeline() {
  if (programPlaybackActive) return false;
  return sessionMediaTiming?.timeline_axis === "source_video_pts";
}

/** @param {MediaTimingProbe | null | undefined} probe */
export function setSessionMediaTiming(probe) {
  sessionMediaTiming = probe && typeof probe === "object" ? probe : null;
}

export function getSessionMediaTiming() {
  return sessionMediaTiming;
}

export function restoreSessionPreviewMediaPathFromStorage() {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREVIEW_PATH) || "";
    const p = normalizeAgentMediaPath(raw);
    if (p && hasCorruptMediaPathChars(p)) {
      sessionStorage.removeItem(STORAGE_PREVIEW_PATH);
      return;
    }
    if (p && !isWorkspacePreviewStoragePath(p)) {
      sessionStorage.removeItem(STORAGE_PREVIEW_PATH);
      return;
    }
    if (p) {
      sessionPreviewMediaPath = p;
      if (p !== String(raw).trim()) {
        sessionStorage.setItem(STORAGE_PREVIEW_PATH, p);
      }
    }
  } catch {
    /* ignore */
  }
}

export function clearSessionPreviewMediaPath() {
  setSessionPreviewMediaPath(null);
}

export function getSessionPreviewMediaPath() {
  return sessionPreviewMediaPath;
}

export function clearSessionMediaTiming() {
  sessionMediaTiming = null;
  programPlaybackActive = false;
  setSessionPreviewMediaPath(null);
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

  if (isProgramPlaybackTimeline() && video && Number.isFinite(video.currentTime)) {
    return Math.max(0, video.currentTime);
  }

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
export const DEFAULT_TARGET_NTSC_FPS = "30000/1001";

/** @typedef {object} ProgramToBurninSegment
 * @property {number} [index]
 * @property {number} editStart
 * @property {number} editEnd
 * @property {number} [ptsStartActual]
 * @property {number} [ptsEndActual]
 */

/** @typedef {object} BurnInMediaContract
 * @property {string} target_ntsc_fps
 * @property {number | null} [preview_duration_sec]
 * @property {string} [timeline_axis]
 * @property {readonly ProgramToBurninSegment[]} [program_to_burnin_map]
 */

/** @returns {BurnInMediaContract} */
export function buildBurnInMediaContract() {
  const timing = getSessionMediaTiming();
  return {
    target_ntsc_fps: String(timing?.target_ntsc_fps || DEFAULT_TARGET_NTSC_FPS),
    preview_duration_sec:
      getVideoTimelineDurationSec() ?? getAudioTimelineDurationSec() ?? null,
    timeline_axis: timing?.timeline_axis || "preview_cfr",
  };
}

/** @param {string | null | undefined} a @param {string | null | undefined} b */
export function ntscFpsFractionsEqual(a, b) {
  const left = String(a || DEFAULT_TARGET_NTSC_FPS).trim();
  const right = String(b || DEFAULT_TARGET_NTSC_FPS).trim();
  return left === right;
}

/**
 * @param {number} tProgram
 * @param {readonly ProgramToBurninSegment[]} map
 */
export function mapProgramTimeToBurnInPts(tProgram, map) {
  const t = Number(tProgram);
  if (!Number.isFinite(t) || t < 0) return 0;
  if (!Array.isArray(map) || !map.length) return t;

  for (let i = 0; i < map.length; i += 1) {
    const seg = map[i];
    const es = Number(seg.editStart ?? seg.edit_start);
    const ee = Number(seg.editEnd ?? seg.edit_end);
    if (!Number.isFinite(es) || !Number.isFinite(ee) || ee <= es) continue;
    const isLast = i === map.length - 1;
    const inSeg = isLast ? t >= es - 1e-7 && t <= ee + 1e-7 : t >= es - 1e-7 && t < ee - 1e-7;
    if (!inSeg) continue;
    const ps = Number(seg.ptsStartActual ?? seg.pts_start_actual ?? es);
    const pe = Number(seg.ptsEndActual ?? seg.pts_end_actual ?? ee);
    const len = ee - es;
    if (len <= 1e-9) return ps;
    const ratio = Math.min(1, Math.max(0, (t - es) / len));
    return ps + ratio * (pe - ps);
  }

  const last = map[map.length - 1];
  const pe = Number(last?.ptsEndActual ?? last?.pts_end_actual);
  return Number.isFinite(pe) ? pe : t;
}

/** @param {readonly ProgramToBurninSegment[]} map */
export function assertProgramToBurninMapMonotonic(map) {
  if (!Array.isArray(map) || !map.length) {
    throw new Error("program_to_burnin_map is empty");
  }
  let prevEnd = -Infinity;
  for (const seg of map) {
    const ps = Number(seg.ptsStartActual ?? seg.pts_start_actual);
    const pe = Number(seg.ptsEndActual ?? seg.pts_end_actual);
    if (!Number.isFinite(ps) || !Number.isFinite(pe) || pe <= ps + 1e-6) {
      throw new Error(`invalid program_to_burnin_map segment: pts ${ps}..${pe}`);
    }
    if (ps < prevEnd - 1e-5) {
      throw new Error(`program_to_burnin_map not monotonic at ${ps} < ${prevEnd}`);
    }
    prevEnd = pe;
  }
}

/**
 * @param {readonly { start: number, end: number, text?: string, cueIndex?: number }[]} schedule
 * @param {readonly ProgramToBurninSegment[]} map
 */
/**
 * BE map 없을 때 FE 폴백 — virtual_audio_map + actual_duration (Python 동일 알고리즘).
 * @param {readonly object[]} virtualAudioMap
 * @param {number} actualDurationNormalized
 */
export function buildProgramToBurninMapFromVirtualAudioMap(
  virtualAudioMap,
  actualDurationNormalized,
) {
  /** @type {{ editStart: number, editEnd: number, length: number }[]} */
  const segments = [];
  for (const raw of virtualAudioMap || []) {
    if (!raw || typeof raw !== "object") continue;
    const srcStart = Number(raw.sourceStart ?? raw.source_start ?? 0);
    const srcEnd = Number(raw.sourceEnd ?? raw.source_end ?? 0);
    const editStart = Number(raw.editStart ?? raw.edit_start ?? 0);
    const editEnd = Number(raw.editEnd ?? raw.edit_end ?? 0);
    if (!Number.isFinite(srcEnd) || srcEnd <= srcStart + 1e-5) continue;
    if (!Number.isFinite(editEnd) || editEnd <= editStart + 1e-6) continue;
    segments.push({ editStart, editEnd, length: editEnd - editStart });
  }

  const actual = Number(actualDurationNormalized);
  if (!segments.length || !Number.isFinite(actual) || actual <= 0) {
    const dur = Number.isFinite(actual) && actual > 0 ? actual : 0.1;
    return [
      {
        index: 0,
        editStart: 0,
        editEnd: dur,
        ptsStartActual: 0,
        ptsEndActual: dur,
      },
    ];
  }

  const expectedTotal = segments[segments.length - 1].editEnd;
  const driftTotal = actual - expectedTotal;
  let cumulativeDrift = 0;
  /** @type {ProgramToBurninSegment[]} */
  const rows = [];

  segments.forEach((seg, i) => {
    const driftI = expectedTotal > 0 ? driftTotal * (seg.length / expectedTotal) : 0;
    const ptsStartActual = seg.editStart + cumulativeDrift;
    const ptsEndActual = ptsStartActual + seg.length + driftI;
    rows.push({
      index: i,
      editStart: seg.editStart,
      editEnd: seg.editEnd,
      ptsStartActual,
      ptsEndActual,
      driftSegment: driftI,
    });
    cumulativeDrift += driftI;
  });

  if (rows.length) {
    const last = rows[rows.length - 1];
    const delta = actual - last.ptsEndActual;
    if (Math.abs(delta) > 1e-4) {
      last.ptsEndActual += delta;
    }
  }
  return rows;
}

export function remapScheduleToBurninAxis(schedule, map) {
  assertProgramToBurninMapMonotonic(map);
  const minSeg = 0.01;
  return schedule
    .map((s) => ({
      ...s,
      start: mapProgramTimeToBurnInPts(s.start, map),
      end: mapProgramTimeToBurnInPts(s.end, map),
    }))
    .filter((s) => s.end > s.start + minSeg);
}

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
