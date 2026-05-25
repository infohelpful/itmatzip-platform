/**
 * 웹용 파형 peaks 로드 — audiowaveform(있을 때) → pcm_columns 폴백.
 */

import { requestAgent } from "../common/bridge.js?v=as9";
import { resolvePeaksTimelineMetrics } from "./peaks-metrics.js?v=30";

const TOOL_PREFIX = "/api/tools/auto-subtitle";

/** @type {Promise<object | null> | null} */
let inflight = null;

/**
 * @param {string} apiPath
 * @param {string} videoPath
 * @param {number} timeoutSec
 */
async function fetchPeaksPayload(apiPath, videoPath, timeoutSec) {
  return requestAgent({
    path: apiPath,
    method: "POST",
    json: {
      video_path: videoPath,
      timeout_sec: timeoutSec,
    },
  });
}

/**
 * @param {object | null} payload
 * @param {number} [hintSec]
 */
function metricsFromPayload(payload, hintSec) {
  if (payload == null || payload.ok === false) return null;
  return resolvePeaksTimelineMetrics(payload, hintSec);
}

/**
 * @param {'auto' | 'audiowaveform' | 'pcm_columns'} engine
 * @param {boolean | undefined} audiowaveformAvailable readiness.binaries.audiowaveform
 * @returns {('audiowaveform' | 'pcm_columns')[]}
 */
function enginesToTry(engine, audiowaveformAvailable) {
  if (engine === "pcm_columns") return ["pcm_columns"];
  if (engine === "audiowaveform") {
    return audiowaveformAvailable ? ["audiowaveform", "pcm_columns"] : ["pcm_columns"];
  }
  // auto — audiowaveform 미설치 PC에서는 pcm만 (503 콘솔 노이즈 방지)
  if (audiowaveformAvailable === true) return ["audiowaveform", "pcm_columns"];
  return ["pcm_columns"];
}

/**
 * @param {string} videoPath
 * @param {{ timeoutSec?: number, force?: boolean, engine?: 'audiowaveform' | 'pcm_columns' | 'auto', durationHintSec?: number, audiowaveformAvailable?: boolean }} [opts]
 * @returns {Promise<{ payload: object | null, metrics: import('./peaks-metrics.js').PeaksTimelineMetrics | null, fromCache?: boolean, error?: string, engine?: string }>}
 */
export async function loadWaveformPeaksForMedia(videoPath, opts = {}) {
  const p = String(videoPath || "").trim();
  if (!p) return { payload: null, metrics: null, error: "no_path" };

  if (!opts.force && inflight) {
    try {
      return await inflight;
    } catch (e) {
      return { payload: null, metrics: null, error: String(e?.message || e) };
    }
  }

  const engine = opts.engine ?? "auto";
  const timeoutSec = opts.timeoutSec ?? 900;
  const hintSec = opts.durationHintSec;
  const awAvail = opts.audiowaveformAvailable === true;

  const run = async () => {
    const tryEngines = enginesToTry(engine, awAvail);
    let lastError = "invalid_peaks";

    for (const eng of tryEngines) {
      const apiPath =
        eng === "pcm_columns"
          ? `${TOOL_PREFIX}/waveform-peaks`
          : `${TOOL_PREFIX}/waveform-peaks/audiowaveform`;
      try {
        const data = await fetchPeaksPayload(apiPath, p, timeoutSec);
        const metrics = metricsFromPayload(data, hintSec);
        if (metrics) {
          return {
            payload: data,
            metrics,
            fromCache: Boolean(data?.from_cache ?? data?.cached),
            engine: eng,
          };
        }
        const reason =
          data && typeof data === "object" && data.reason != null ? String(data.reason) : "invalid_peaks";
        lastError = `${eng}:${reason}`;
      } catch (e) {
        lastError = `${eng}:${String(e?.message || e)}`;
      }
    }

    return { payload: null, metrics: null, error: lastError };
  };

  inflight = run();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export { metricsFromPayload };
