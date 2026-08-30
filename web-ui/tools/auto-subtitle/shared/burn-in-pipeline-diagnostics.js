/**
 * Burn-in CFR / concat / FPS / actual_duration → frame sampling handoff diagnostics.
 * 콘솔: autoSubtitleBurnInPipelineDiag.enable(true)
 *       → export(보내기) 1회 → autoSubtitleBurnInPipelineDiag.report()
 *       → autoSubtitleDownloadDiagLogs()
 */

import { diagLogBufferPush } from "./diag-log-export.js?v=1";
import { fetchAgent, getAgentOrigin } from "../../common/bridge.js?v=as10";
import { DEFAULT_TARGET_NTSC_FPS, ntscFpsFractionsEqual } from "./media-timing-ssot.js?v=6";

const STORAGE_KEY = "auto-subtitle:burn-in-pipeline-diag";

let enabled = false;

/** @type {Record<string, unknown>} */
let lastHandoff = {};

/** @type {readonly { code: string, detail: string }[]} */
let lastWarnings = [];

function readStoredEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStoredEnabled(on) {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** @param {boolean} on */
export function burnInPipelineDiagSetEnabled(on) {
  enabled = Boolean(on);
  writeStoredEnabled(enabled);
}

export function burnInPipelineDiagIsEnabled() {
  return enabled;
}

/** prepare / finish / export POST body에 병합 — 구버전 에이전트도 무시 가능. */
export function burnInPipelineDiagAgentPayload() {
  return enabled ? { pipeline_diag: true } : {};
}

/** Restore toggle from localStorage (page load). */
export function burnInPipelineDiagRestoreFromStorage() {
  if (readStoredEnabled()) enabled = true;
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} [payload]
 */
export function burnInPipelineDiagLog(event, payload = {}) {
  if (!enabled) return;
  const row = { wallMs: performance.now(), ...payload };
  console.log("[BURN-IN-PIPE]", event, row);
  diagLogBufferPush("BURN-IN-PIPE", "log", event, row);
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} [payload]
 */
export function burnInPipelineDiagWarn(event, payload = {}) {
  if (!enabled) return;
  const row = { wallMs: performance.now(), ...payload };
  console.warn("[BURN-IN-PIPE]", event, row);
  diagLogBufferPush("BURN-IN-PIPE", "warn", event, row);
}

/**
 * @param {string} stage
 * @param {Record<string, unknown>} patch
 */
export function burnInPipelineDiagHandoff(stage, patch) {
  lastHandoff = {
    ...lastHandoff,
    stage,
    updatedAt: new Date().toISOString(),
    ...patch,
  };
  if (!enabled) return;
  burnInPipelineDiagLog(`handoff.${stage}`, patch);
}

/**
 * @param {Record<string, unknown>} snapshot
 * @returns {readonly { code: string, detail: string, severity: string }[]}
 */
export function analyzeBurnInPipelineHandoff(snapshot) {
  /** @type {{ code: string, detail: string, severity: string }[]} */
  const warnings = [];

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const actualDur = num(snapshot.actualDuration);
  const scheduleEnd = num(snapshot.scheduleEnd);
  const programEnd = num(snapshot.virtualProgramEnd);
  const prepDur = num(snapshot.prepareDurationSec);
  const overlayDur = num(snapshot.overlayDurationSec);
  const exportFps = num(snapshot.exportFps);
  const probeFps = num(snapshot.probeTargetFps);
  const sessionAudioDur = num(snapshot.sessionAudioDurationSec);
  const sessionVideoDur = num(snapshot.sessionVideoDurationSec);

  if (actualDur != null && scheduleEnd != null && Math.abs(actualDur - scheduleEnd) > 0.05) {
    warnings.push({
      code: "ACTUAL_VS_SCHEDULE_END",
      severity: "high",
      detail: `actual_duration=${actualDur.toFixed(3)} vs scheduleEnd=${scheduleEnd.toFixed(3)} (linear scale may be wrong)`,
    });
  }

  if (programEnd != null && actualDur != null && Math.abs(actualDur - programEnd) > 0.05) {
    warnings.push({
      code: "ACTUAL_VS_VMAP_PROGRAM_END",
      severity: "high",
      detail: `actual_duration=${actualDur.toFixed(3)} vs virtualMapProgramEnd=${programEnd.toFixed(3)}`,
    });
  }

  if (prepDur != null && actualDur != null && Math.abs(prepDur - actualDur) > 0.08) {
    warnings.push({
      code: "PREP_PROBE_VS_EXPORT_ACTUAL",
      severity: "high",
      detail: `prepare.duration_sec=${prepDur.toFixed(3)} vs export actual_duration=${actualDur.toFixed(3)} — burn-in probes at prepare time`,
    });
  }

  if (overlayDur != null && prepDur != null && overlayDur > prepDur + 0.05) {
    warnings.push({
      code: "OVERLAY_DUR_EXCEEDS_INPUT",
      severity: "medium",
      detail: `overlay_dur=${overlayDur.toFixed(3)} > input duration=${prepDur.toFixed(3)} — stdin may extend past video`,
    });
  }

  if (exportFps != null && probeFps != null && Math.abs(exportFps - probeFps) > 0.02) {
    warnings.push({
      code: "FPS_PREP_VS_PROBE",
      severity: "medium",
      detail: `prepare export_fps=${exportFps} vs probe target=${probeFps}`,
    });
  }

  if (
    sessionAudioDur != null &&
    sessionVideoDur != null &&
    Math.abs(sessionAudioDur - sessionVideoDur) > 0.05
  ) {
    warnings.push({
      code: "SESSION_AV_DURATION_MISMATCH",
      severity: "medium",
      detail: `session audio=${sessionAudioDur.toFixed(3)} vs video=${sessionVideoDur.toFixed(3)} (preview CFR normalize?)`,
    });
  }

  if (snapshot.stitched && (actualDur == null || actualDur <= 0)) {
    warnings.push({
      code: "STITCHED_MISSING_ACTUAL_DURATION",
      severity: "high",
      detail: "requires_concat/stitched but actual_duration missing",
    });
  }

  if (snapshot.stitched && !(snapshot.programMapSegments > 0)) {
    warnings.push({
      code: "STITCHED_MISSING_PROGRAM_MAP",
      severity: "high",
      detail: "stitched export but program_to_burnin_map missing",
    });
  }

  const contractFps = snapshot.contractTargetFps ?? snapshot.sessionTargetFps;
  const probeFpsFrac = snapshot.probeTargetFpsFraction ?? snapshot.probeTargetFps;
  if (
    contractFps &&
    probeFpsFrac &&
    !ntscFpsFractionsEqual(String(contractFps), String(probeFpsFrac))
  ) {
    warnings.push({
      code: "PREVIEW_VS_BURNIN_FPS",
      severity: "high",
      detail: `contract fps=${contractFps} vs burnin probe=${probeFpsFrac}`,
    });
  }

  const previewDur = num(snapshot.sessionVideoDurationSec ?? snapshot.previewDurationSec);
  const burninDur = num(snapshot.burninDuration ?? snapshot.prepareDurationSec ?? actualDur);
  if (previewDur != null && burninDur != null && Math.abs(previewDur - burninDur) > 0.12) {
    warnings.push({
      code: "PREVIEW_VS_BURNIN_DURATION",
      severity: "medium",
      detail: `preview=${previewDur.toFixed(3)} vs burnin=${burninDur.toFixed(3)}`,
    });
  }

  if (snapshot.probeVfr === true) {
    warnings.push({
      code: "BURNIN_PROBE_VFR",
      severity: "high",
      detail: "burn-in media probe reports vfr_suspected=true after CFR finalize",
    });
  }

  if (snapshot.exportTimeAxis === "filter_program" && (snapshot.finishMapSegments || 0) === 0) {
    warnings.push({
      code: "FILTER_PROGRAM_EMPTY_VMAP_ON_FINISH",
      severity: "high",
      detail: "filter_program axis but finish payload virtual_audio_map empty — Python may skip filter trim",
    });
  }

  lastWarnings = warnings;
  return warnings;
}

const HARD_GATE_CODES = new Set([
  "STITCHED_MISSING_ACTUAL_DURATION",
  "STITCHED_MISSING_PROGRAM_MAP",
  "PREVIEW_VS_BURNIN_FPS",
  "BURNIN_PROBE_VFR",
]);

/**
 * @param {Record<string, unknown>} snapshot
 * @param {{ stitched?: boolean, afterPrepare?: boolean }} [opts]
 */
export function runBurnInMediaHardGate(snapshot, opts = {}) {
  const stitched = opts.stitched === true;
  const afterPrepare = opts.afterPrepare === true;
  /** @type {{ code: string, detail: string }[]} */
  const issues = [];

  if (stitched && !(Number(snapshot.programMapSegments) > 0)) {
    issues.push({
      code: "STITCHED_MISSING_PROGRAM_MAP",
      detail: "program_to_burnin_map required for stitched export",
    });
  }

  if (afterPrepare) {
    const contractFps = String(snapshot.contractTargetFps || DEFAULT_TARGET_NTSC_FPS);
    const probeFps = String(
      snapshot.probeTargetFpsFraction ?? snapshot.probeTargetFps ?? "",
    );
    const exportFps = Number(snapshot.exportFps);
    const contractOk =
      Number.isFinite(exportFps) &&
      exportFps > 0 &&
      (contractFps === "30000/1001"
        ? Math.abs(exportFps - 30000 / 1001) < 0.05
        : true);

    if (probeFps && !ntscFpsFractionsEqual(contractFps, probeFps) && !contractOk) {
      issues.push({
        code: "PREVIEW_VS_BURNIN_FPS",
        detail: `contract ${contractFps} vs probe ${probeFps} (export_fps=${exportFps})`,
      });
    }
    if (snapshot.probeVfr === true && !contractOk) {
      issues.push({
        code: "BURNIN_PROBE_VFR",
        detail: "vfr_suspected and export_fps does not match contract",
      });
    }
  }

  const blocked = issues.some((i) => HARD_GATE_CODES.has(i.code));
  return { blocked, issues };
}

export function burnInPipelineDiagGetLastHandoff() {
  return { ...lastHandoff, warnings: [...lastWarnings] };
}

export function burnInPipelineDiagReport() {
  const warnings = analyzeBurnInPipelineHandoff(lastHandoff);
  const report = {
    handoff: getSanitizedHandoff(lastHandoff),
    warnings,
    hint: "Agent logs: set BURN_IN_PIPELINE_DIAG=1 or enable() syncs runtime flag. Filter: BURN-IN-PIPE",
  };
  console.log("[BURN-IN-PIPE] report", report);
  if (warnings.length) {
    console.warn("[BURN-IN-PIPE] warnings", warnings);
  }
  return report;
}

/** @param {Record<string, unknown>} h */
function getSanitizedHandoff(h) {
  return { ...h };
}

/**
 * @param {string} toolPrefix
 * @param {boolean} on
 * @returns {Promise<{ ok: boolean, mode: "agent" | "fe_only" | "off" }>}
 */
export async function burnInPipelineDiagSyncAgent(toolPrefix, on) {
  if (!on) {
    return { ok: true, mode: "off" };
  }
  try {
    const res = await fetchAgent(`${getAgentOrigin()}${toolPrefix}/diag/burn-in-pipeline`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ enabled: true }),
      cache: "no-store",
    });
    if (res.status === 404) {
      burnInPipelineDiagLog("agent_sync_skipped", {
        reason: "diag_endpoint_missing",
        hint: "prepare/finish/export 요청의 pipeline_diag=true 로 BE 로그 활성화 (에이전트 sync-source 후)",
      });
      return { ok: true, mode: "fe_only" };
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      burnInPipelineDiagLog("agent_sync_failed", { status: res.status, data, mode: "fe_only" });
      return { ok: true, mode: "fe_only" };
    }
    burnInPipelineDiagLog("agent_sync_ok", { enabled: data?.enabled, mode: "agent" });
    return { ok: true, mode: "agent" };
  } catch (err) {
    burnInPipelineDiagLog("agent_sync_error", {
      error: String(err),
      mode: "fe_only",
      hint: "FE 로그는 동작. BE는 pipeline_diag 또는 BURN_IN_PIPELINE_DIAG=1",
    });
    return { ok: true, mode: "fe_only" };
  }
}

/** @param {readonly object[] | null | undefined} map */
export function virtualMapProgramEndSec(map) {
  if (!Array.isArray(map) || !map.length) return null;
  let end = 0;
  for (const seg of map) {
    const e = Number(seg?.editEnd ?? seg?.edit_end);
    if (Number.isFinite(e) && e > end) end = e;
  }
  return end > 0 ? end : null;
}
