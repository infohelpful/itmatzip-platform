/**
 * Silence-remover EDL export — sessionStorage keys and agent build-edl helpers.
 */

export const STORAGE_EDL = "itmatzip_silence_edl";
export const STORAGE_NAME = "itmatzip_silence_edl_filename";
export const STORAGE_VOCAL_MS = "itmatzip_silence_vocal_ms";
export const STORAGE_SILENCES = "itmatzip_silence_silences";
export const STORAGE_SILENCES_DISPLAY = "itmatzip_silence_silences_display";
export const STORAGE_DURATION = "itmatzip_silence_duration_sec";
export const STORAGE_FPS_RATIONAL = "itmatzip_silence_fps_rational";
export const STORAGE_FPS_NATIVE_RATIONAL = "itmatzip_silence_native_fps_rational";
export const STORAGE_FPS = "itmatzip_silence_fps";
export const STORAGE_MEAN_VOLUME_DB = "itmatzip_silence_mean_volume_db";
export const STORAGE_MAX_VOLUME_DB = "itmatzip_silence_max_volume_db";
export const STORAGE_DYNAMIC_RANGE_DB = "itmatzip_silence_dynamic_range_db";
export const STORAGE_SAMPLE_RATE_HZ = "itmatzip_silence_sample_rate_hz";
export const STORAGE_RECOMMENDED_NOISE_DB = "itmatzip_silence_recommended_noise_db";
export const STORAGE_CLIP_NAME = "itmatzip_silence_clip_name";
export const STORAGE_VIDEO_PATH = "itmatzip_silence_video_path";
/** 무음 분석·EDL이 실제로 적용된 영상 경로 (현재 입력 경로와 구분) */
export const STORAGE_ANALYSIS_VIDEO_PATH = "itmatzip_silence_analysis_video_path";
export const STORAGE_TC_OFFSET_SEC = "itmatzip_silence_tc_offset_sec";
export const STORAGE_REMOVE_SILENT = "itmatzip_silence_remove_silent";
export const STORAGE_PADDING_MS = "itmatzip_silence_padding_ms";
export const STORAGE_MIN_SILENCE_SEC = "itmatzip_silence_min_silence_sec";
export const STORAGE_MIN_SILENCE = "itmatzip_silence_min_silence_sec";
export const STORAGE_EDL_FINGERPRINT = "itmatzip_silence_edl_fp";
/** 다운로드 페이지 → 편집 화면 복귀 시에만 UI 복원 (일반 접속·새로고침은 빈 화면) */
export const STORAGE_RESTORE_EDITOR = "itmatzip_silence_restore_editor";

export const DEFAULT_PADDING_MS = 18;

export function markEditorRestorePending() {
  try {
    sessionStorage.setItem(STORAGE_RESTORE_EDITOR, "1");
  } catch {
    /* ignore */
  }
}

/** @returns {boolean} */
export function consumeEditorRestorePending() {
  try {
    const pending = sessionStorage.getItem(STORAGE_RESTORE_EDITOR) === "1";
    if (pending) sessionStorage.removeItem(STORAGE_RESTORE_EDITOR);
    return pending;
  } catch {
    return false;
  }
}

export function clipNameFromVideoPath(videoPath) {
  const p = String(videoPath || "").trim().replace(/\\/g, "/");
  if (!p) return "";
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/** @param {unknown[]} raw */
export function parseStoredSilenceSegments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => {
      if (!s || typeof s !== "object") return null;
      const start = Number(/** @type {{ start_sec?: number }} */ (s).start_sec);
      const end = Number(/** @type {{ end_sec?: number }} */ (s).end_sec);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
      return { start_sec: start, end_sec: end };
    })
    .filter((s) => s != null);
}

export function loadStoredVocalIntervalsMs() {
  const vocalRaw = sessionStorage.getItem(STORAGE_VOCAL_MS);
  if (!vocalRaw) return null;
  try {
    const parsed = JSON.parse(vocalRaw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const out = parsed
      .map((v) => {
        if (!v || typeof v !== "object") return null;
        const start_ms = Number(/** @type {{ start_ms?: number }} */ (v).start_ms);
        const end_ms = Number(/** @type {{ end_ms?: number }} */ (v).end_ms);
        if (!Number.isFinite(start_ms) || !Number.isFinite(end_ms) || end_ms <= start_ms) {
          return null;
        }
        return { start_ms, end_ms };
      })
      .filter((v) => v != null);
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function loadStoredSilenceIntervals() {
  const raw = sessionStorage.getItem(STORAGE_SILENCES);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parseStoredSilenceSegments(parsed) : [];
  } catch {
    return [];
  }
}

export function getRemoveSilentFromSession() {
  return sessionStorage.getItem(STORAGE_REMOVE_SILENT) === "true";
}

export function getPaddingMsFromSession() {
  const stored = sessionStorage.getItem(STORAGE_PADDING_MS);
  const n = stored != null ? Number(stored) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PADDING_MS;
}

export function getEditorFpsFromSession() {
  const stored = sessionStorage.getItem(STORAGE_FPS);
  const n = stored != null ? Number(stored) : NaN;
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

export function getMinSilenceSecFromSession() {
  const stored =
    sessionStorage.getItem(STORAGE_MIN_SILENCE_SEC) ||
    sessionStorage.getItem(STORAGE_MIN_SILENCE);
  const n = stored != null ? Number(stored) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0.3;
}

/** @param {unknown} v */
function readStoredDb(v) {
  if (v == null || v === "") return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function getMeanVolumeDbFromSession() {
  return readStoredDb(sessionStorage.getItem(STORAGE_MEAN_VOLUME_DB));
}

export function getRecommendedNoiseDbFromSession() {
  return readStoredDb(sessionStorage.getItem(STORAGE_RECOMMENDED_NOISE_DB));
}

export function getMaxVolumeDbFromSession() {
  return readStoredDb(sessionStorage.getItem(STORAGE_MAX_VOLUME_DB));
}

export function getDynamicRangeDbFromSession() {
  return readStoredDb(sessionStorage.getItem(STORAGE_DYNAMIC_RANGE_DB));
}

export function getSampleRateHzFromSession() {
  return readStoredDb(sessionStorage.getItem(STORAGE_SAMPLE_RATE_HZ));
}

/** @param {number} hz */
export function formatSampleRateLabel(hz) {
  if (!Number.isFinite(hz) || hz <= 0) return "—";
  const khz = hz / 1000;
  return Number.isInteger(khz) ? `${khz} kHz` : `${Math.round(khz * 100) / 100} kHz`;
}

/** @param {Record<string, unknown>} meta */
export function saveProbeMetaToSession(meta) {
  if (!meta || typeof meta !== "object") return;
  const fps = readStoredDb(meta.fps);
  if (fps > 0) sessionStorage.setItem(STORAGE_FPS, String(fps));
  const mean = readStoredDb(meta.mean_volume_db);
  if (Number.isFinite(mean)) {
    sessionStorage.setItem(STORAGE_MEAN_VOLUME_DB, String(mean));
  }
  const max = readStoredDb(meta.max_volume_db);
  if (Number.isFinite(max)) {
    sessionStorage.setItem(STORAGE_MAX_VOLUME_DB, String(max));
  }
  const dr = readStoredDb(meta.dynamic_range_db);
  if (Number.isFinite(dr)) {
    sessionStorage.setItem(STORAGE_DYNAMIC_RANGE_DB, String(dr));
  }
  const sr = readStoredDb(meta.sample_rate_hz);
  if (Number.isFinite(sr) && sr > 0) {
    sessionStorage.setItem(STORAGE_SAMPLE_RATE_HZ, String(Math.round(sr)));
  }
  const rec = readStoredDb(meta.recommended_noise_db);
  if (Number.isFinite(rec)) {
    sessionStorage.setItem(STORAGE_RECOMMENDED_NOISE_DB, String(rec));
  }
}

export function clearProbeMetaFromSession() {
  sessionStorage.removeItem(STORAGE_MEAN_VOLUME_DB);
  sessionStorage.removeItem(STORAGE_MAX_VOLUME_DB);
  sessionStorage.removeItem(STORAGE_DYNAMIC_RANGE_DB);
  sessionStorage.removeItem(STORAGE_SAMPLE_RATE_HZ);
  sessionStorage.removeItem(STORAGE_RECOMMENDED_NOISE_DB);
}

export function edlExportSettingsFingerprintFromSession() {
  const fps = getEditorFpsFromSession();
  return JSON.stringify({
    rs: getRemoveSilentFromSession() ? 1 : 0,
    pad: getPaddingMsFromSession(),
    min: getMinSilenceSecFromSession(),
    fps: Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : null,
  });
}

export function markStoredEdlFingerprintFromSession() {
  sessionStorage.setItem(STORAGE_EDL_FINGERPRINT, edlExportSettingsFingerprintFromSession());
}

/** @returns {string} */
export function getStoredEdlFromSession() {
  return sessionStorage.getItem(STORAGE_EDL)?.trim() || "";
}

/** 분석 직후 저장된 EDL이 현재 내보내기 설정(FPS·패딩 등)과 일치하는지 */
export function storedEdlMatchesExportSettingsFromSession() {
  const fp = sessionStorage.getItem(STORAGE_EDL_FINGERPRINT);
  if (fp == null) return false;
  return fp === edlExportSettingsFingerprintFromSession();
}

/**
 * 편집 화면 DOM → sessionStorage (download.html 이동 직전)
 */
export function snapshotExportSettingsFromDom() {
  const pathInput = document.getElementById("video-path");
  const optRemoveSilent = document.getElementById("opt-remove-silent");
  const optPadding = document.getElementById("opt-padding");
  const optFps = document.getElementById("opt-fps");
  const optAvgDb = document.getElementById("opt-avg-db");
  const optRecDb = document.getElementById("opt-rec-db");
  const optSens = document.getElementById("opt-sensitivity");
  const optMinSilence = document.getElementById("opt-min-silence");

  const videoPath =
    pathInput instanceof HTMLInputElement ? pathInput.value.trim() : "";
  if (videoPath) {
    sessionStorage.setItem(STORAGE_VIDEO_PATH, videoPath);
    const base = videoPath.replace(/[/\\]+$/, "").split(/[/\\]/).pop();
    if (base) sessionStorage.setItem(STORAGE_NAME, base);
    const clip = clipNameFromVideoPath(videoPath);
    if (clip) sessionStorage.setItem(STORAGE_CLIP_NAME, clip);
  }

  if (optRemoveSilent instanceof HTMLInputElement) {
    sessionStorage.setItem(STORAGE_REMOVE_SILENT, optRemoveSilent.checked ? "true" : "false");
  }

  if (optPadding instanceof HTMLInputElement) {
    const v = Number(optPadding.value);
    if (Number.isFinite(v) && v >= 0) {
      sessionStorage.setItem(STORAGE_PADDING_MS, String(v));
    }
  }

  if (optFps instanceof HTMLInputElement) {
    const v = Number(optFps.value);
    if (Number.isFinite(v) && v > 0) {
      sessionStorage.setItem(STORAGE_FPS, String(v));
    }
  }

  if (optAvgDb instanceof HTMLInputElement) {
    const v = Number(optAvgDb.value);
    if (Number.isFinite(v)) {
      sessionStorage.setItem(STORAGE_MEAN_VOLUME_DB, String(v));
    }
  }

  if (optRecDb instanceof HTMLInputElement) {
    const v = Number(optRecDb.value);
    if (Number.isFinite(v)) {
      sessionStorage.setItem(STORAGE_RECOMMENDED_NOISE_DB, String(v));
    }
  } else if (optSens instanceof HTMLInputElement) {
    const v = Number(optSens.value);
    if (Number.isFinite(v)) {
      sessionStorage.setItem(STORAGE_RECOMMENDED_NOISE_DB, String(v));
    }
  }

  if (optMinSilence instanceof HTMLInputElement) {
    const v = Number(optMinSilence.value);
    if (Number.isFinite(v) && v >= 0) {
      sessionStorage.setItem(STORAGE_MIN_SILENCE_SEC, String(v));
      sessionStorage.setItem(STORAGE_MIN_SILENCE, String(v));
    }
  }
}

export function canExportFromSession() {
  const edl = sessionStorage.getItem(STORAGE_EDL);
  const silences = sessionStorage.getItem(STORAGE_SILENCES);
  return Boolean((edl && edl.trim()) || (silences && silences !== "[]"));
}

/** @returns {string} */
export function getStoredVideoPath() {
  return sessionStorage.getItem(STORAGE_VIDEO_PATH)?.trim() || "";
}

/** @returns {string} */
export function getAnalysisBoundVideoPath() {
  return sessionStorage.getItem(STORAGE_ANALYSIS_VIDEO_PATH)?.trim() || "";
}

/** @param {string} videoPath */
export function setAnalysisBoundVideoPath(videoPath) {
  const p = String(videoPath || "").trim();
  if (p) sessionStorage.setItem(STORAGE_ANALYSIS_VIDEO_PATH, p);
}

export function clearAnalysisBoundVideoPath() {
  sessionStorage.removeItem(STORAGE_ANALYSIS_VIDEO_PATH);
}

/**
 * @param {string} videoPath
 * @param {(a: string, b: string) => boolean} pathsEqual
 */
export function canRestoreAnalysisForPath(videoPath, pathsEqual) {
  if (!canExportFromSession()) return false;
  const bound = getAnalysisBoundVideoPath();
  const p = String(videoPath || "").trim();
  if (!bound || !p) return false;
  return pathsEqual(bound, p);
}

/** 편집 화면 복원에 필요한 최소 데이터가 sessionStorage에 있는지 */
export function hasRestorableEditorSession() {
  const videoPath = getStoredVideoPath();
  if (!videoPath || !canExportFromSession()) return false;
  const bound = getAnalysisBoundVideoPath();
  if (!bound) return false;
  const norm = (p) =>
    String(p)
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  return norm(bound) === norm(videoPath);
}

/**
 * @returns {{ ok: boolean, message?: string }}
 */
export function validateExportPrerequisitesFromSession() {
  if (!canExportFromSession()) {
    return { ok: false, message: "먼저 무음 구간 분석을 실행해 주세요." };
  }

  const vocalIntervalsMs = loadStoredVocalIntervalsMs();
  const durationRaw = sessionStorage.getItem(STORAGE_DURATION);
  const durationSec = durationRaw != null ? Number(durationRaw) : NaN;
  const editorFps = getEditorFpsFromSession();

  if (
    (!vocalIntervalsMs || vocalIntervalsMs.length === 0) &&
    (!Number.isFinite(durationSec) || durationSec <= 0)
  ) {
    return { ok: false, message: "먼저 무음 구간 분석을 실행해 주세요." };
  }
  if (!Number.isFinite(editorFps) || editorFps <= 0) {
    return { ok: false, message: "편집기 FPS를 입력한 뒤 다시 시도해 주세요." };
  }

  return { ok: true };
}

export function edlDownloadFilename() {
  const base = sessionStorage.getItem(STORAGE_NAME) || "";
  const stem = base.replace(/\.[^./\\]+$/i, "").trim() || "silence";
  return `${stem}_silence.edl`;
}

/**
 * 저장 위치 선택 (반드시 클릭 직후·다른 await 전에 호출).
 * @returns {Promise<FileSystemFileHandle | null>}
 */
export async function pickEdlSaveFileHandle() {
  if (typeof window.showSaveFilePicker !== "function") return null;
  return window.showSaveFilePicker({
    suggestedName: edlDownloadFilename(),
    types: [
      {
        description: "EDL",
        accept: { "text/plain": [".edl"] },
      },
    ],
  });
}

/**
 * EDL을 로컬에 저장합니다.
 * @param {string} edl
 * @param {{ fileHandle?: FileSystemFileHandle | null }} [opts]
 *   fileHandle — pickEdlSaveFileHandle()로 클릭 직후 받은 핸들. 없으면 브라우저 다운로드(anchor).
 * @returns {Promise<{ saved: boolean, cancelled?: boolean }>}
 */
export async function saveEdlBlobToDisk(edl, opts = {}) {
  const blob = new Blob([edl], { type: "text/plain;charset=utf-8" });
  const filename = edlDownloadFilename();
  const handle = opts.fileHandle ?? null;

  if (handle) {
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return { saved: true };
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
  return { saved: true };
}

/**
 * @param {(opts: import("./bridge.js").AgentRequestOptions) => Promise<unknown>} requestAgent
 * @returns {Promise<{ ok: boolean, edl?: string, error?: string }>}
 */
export async function buildEdlViaAgent(requestAgent) {
  const check = validateExportPrerequisitesFromSession();
  if (!check.ok) {
    return { ok: false, error: check.message };
  }

  const silences = loadStoredSilenceIntervals();
  const vocalIntervalsMs = loadStoredVocalIntervalsMs();
  const durationRaw = sessionStorage.getItem(STORAGE_DURATION);
  const durationSec = durationRaw != null ? Number(durationRaw) : NaN;
  const editorFps = getEditorFpsFromSession();
  const videoPath = sessionStorage.getItem(STORAGE_VIDEO_PATH) || "";
  const clipName =
    sessionStorage.getItem(STORAGE_CLIP_NAME) || clipNameFromVideoPath(videoPath);

  const storedEdl = getStoredEdlFromSession();
  if (
    storedEdl &&
    storedEdlMatchesExportSettingsFromSession() &&
    !storedEdl.includes("말소리 구간이 없습니다")
  ) {
    return { ok: true, edl: storedEdl };
  }

  const tcOffRaw = sessionStorage.getItem(STORAGE_TC_OFFSET_SEC);
  const tcOff = tcOffRaw != null ? Number(tcOffRaw) : 0;

  try {
    const data = await requestAgent({
      method: "POST",
      path: "/api/tools/silence-remover/build-edl",
      json: {
        silences,
        ...(vocalIntervalsMs && vocalIntervalsMs.length > 0
          ? { vocal_intervals_ms: vocalIntervalsMs }
          : {}),
        duration_sec: durationSec,
        fps: editorFps,
        remove_silent: getRemoveSilentFromSession(),
        title: "AutoCut_Option",
        ...(clipName ? { clip_name: clipName } : {}),
        ...(videoPath ? { video_path: videoPath } : {}),
        ...(Number.isFinite(tcOff) && tcOff >= 0 ? { source_tc_offset_sec: tcOff } : {}),
      },
    });
    const edl =
      data && typeof data === "object" && typeof data.edl === "string" ? data.edl : "";
    if (edl.trim() && !edl.includes("말소리 구간이 없습니다")) {
      sessionStorage.setItem(STORAGE_EDL, edl);
      markStoredEdlFingerprintFromSession();
      return { ok: true, edl };
    }
    return {
      ok: false,
      error: "EDL을 생성하지 못했습니다. 무음 구간이 없거나 분석을 다시 실행해 주세요.",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `EDL 생성에 실패했습니다. 로컬 에이전트를 실행한 뒤 다시 시도해 주세요.\n\n${msg}`,
    };
  }
}
