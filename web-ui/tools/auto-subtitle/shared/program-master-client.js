/**
 * V5 — program-master bake (preview + export SSOT media).
 */

import { fetchAgent, getAgentOrigin } from "../../common/bridge.js?v=as10";
import {
  EXPORT_SCHEMA_VERSION,
  programClipsToApiPayload,
  programClipsFingerprint,
} from "./program-clips-ssot.js?v=1";

/** @type {{ path: string | null, fingerprint: string | null, durationSec: number, baking: boolean }} */
let cache = {
  path: null,
  fingerprint: null,
  durationSec: 0,
  baking: false,
};

let debounceTimer = 0;
/** @type {Promise<{ path: string, durationSec: number } | null> | null} */
let inflight = null;

export function getProgramMasterCache() {
  return { ...cache };
}

export function clearProgramMasterCache() {
  cache = { path: null, fingerprint: null, durationSec: 0, baking: false };
  inflight = null;
}

/**
 * @param {string} toolPrefix
 * @param {{
 *   previewMediaPath: string,
 *   programClips: readonly object[],
 *   programDurationSec: number,
 *   targetNtscFps?: string,
 *   cutRangesJson?: string,
 *   force?: boolean,
 * }} opts
 */
export async function bakeProgramMaster(toolPrefix, opts) {
  const preview = String(opts.previewMediaPath || "").trim();
  if (!preview) throw new Error("preview_media_path가 필요합니다.");
  const clips = opts.programClips || [];
  const fp = programClipsFingerprint(preview, clips, opts.cutRangesJson || "[]");
  if (
    !opts.force &&
    cache.path &&
    cache.fingerprint === fp &&
    Math.abs((cache.durationSec || 0) - (opts.programDurationSec || 0)) < 0.05
  ) {
    return { path: cache.path, durationSec: cache.durationSec, fingerprint: fp, cached: true, bakeLevel: null };
  }
  if (inflight && !opts.force) return inflight;

  cache.baking = true;
  const body = {
    export_schema_version: EXPORT_SCHEMA_VERSION,
    preview_media_path: preview,
    program_clips: programClipsToApiPayload(clips),
    program_duration_sec: opts.programDurationSec,
    target_ntsc_fps: opts.targetNtscFps || "30000/1001",
    fingerprint: fp,
  };

  inflight = fetchAgent(`${getAgentOrigin()}${toolPrefix}/media/bake-program-master`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.detail ? String(data.detail) : `bake-program-master HTTP ${res.status}`);
      }
      const path = String(data.program_master_path || "").trim();
      if (!path) throw new Error("program_master_path가 비어 있습니다.");
      const durationSec = Number(data.duration_sec) || opts.programDurationSec || 0;
      const bakeLevel = String(data.metrics?.bake_level || data.bake_level || "").trim() || null;
      cache = {
        path,
        fingerprint: fp,
        durationSec,
        baking: false,
      };
      return { path, durationSec, fingerprint: fp, cached: false, bakeLevel };
    })
    .finally(() => {
      cache.baking = false;
      inflight = null;
    });

  return inflight;
}

/**
 * @param {string} toolPrefix
 * @param {Parameters<typeof bakeProgramMaster>[1]} opts
 * @param {number} [debounceMs]
 */
export function scheduleBakeProgramMaster(toolPrefix, opts, debounceMs = 2500) {
  if (debounceTimer) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = 0;
    void bakeProgramMaster(toolPrefix, opts).catch((err) => {
      console.warn("[program-master] background bake failed", err);
    });
  }, debounceMs);
}

/**
 * @param {string} toolPrefix
 * @param {string} filePath
 */
export function programMasterStreamUrl(toolPrefix, filePath) {
  return `${getAgentOrigin()}${toolPrefix}/media/stream?video_path=${encodeURIComponent(filePath)}`;
}
