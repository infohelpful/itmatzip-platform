/**
 * Electron exportByFormat(video) 웹 대응 — 자막 캡처 + 단일 패스 FFmpeg 번인.
 */

import { fetchAgent, getAgentOrigin } from "../../common/bridge.js?v=as9";
import { buildOverlayCaptureSchedule, isProgramExportTimeAxis } from "../shared/overlay-capture-schedule.js?v=6";
import {
  createOverlayTimingContext,
  createProgramBurnInOverlayContext,
} from "../shared/overlay-timing-ssot.js?v=4";
import { runExportParityGate, runProgramMapParityGate } from "../shared/overlay-timing-parity.js?v=2";
import {
  analyzeBurnInPipelineHandoff,
  burnInPipelineDiagAgentPayload,
  burnInPipelineDiagHandoff,
  burnInPipelineDiagIsEnabled,
  burnInPipelineDiagLog,
  burnInPipelineDiagWarn,
  runBurnInMediaHardGate,
  virtualMapProgramEndSec,
} from "../shared/burn-in-pipeline-diagnostics.js?v=3";
import {
  buildBurnInMediaContract,
  buildProgramDurationScaleMap,
  buildProgramToBurninMapFromVirtualAudioMap,
  DEFAULT_TARGET_NTSC_FPS,
  ntscFpsFractionsEqual,
  remapScheduleToBurninAxis,
} from "../shared/media-timing-ssot.js?v=12";
import { bindExportStyleVideoNative } from "../shared/export-render-scale.js?v=1";
import { captureSubtitleFrameSequence } from "./subtitle-bgra-capture.js?v=7";

const TRANSIENT_HTTP = new Set([502, 503, 504]);

/** 번인 디버그 — 브라우저 DevTools 콘솔 전용 */
export function burnInConsoleLog(event, detail = {}) {
  try {
    console.info("[burn-in]", event, detail);
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {{ retries?: number, delayMs?: number }} [opts]
 */
async function fetchAgentResilient(url, init, { retries = 6, delayMs = 700 } = {}) {
  let lastRes = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const res = await fetchAgent(url, init);
    if (!TRANSIENT_HTTP.has(res.status)) return res;
    lastRes = res;
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  return /** @type {Response} */ (lastRes);
}

/**
 * 영상 번인 API가 설치된 에이전트에 있는지 확인 (404면 구버전).
 * @param {string} toolPrefix
 */
export async function isVideoBurnInApiAvailable(toolPrefix) {
  const res = await fetchAgent(`${getAgentOrigin()}${toolPrefix}/export/video-burn-in/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ video_path: "__api_probe__" }),
    cache: "no-store",
  });
  if (res.status === 404) return false;
  return res.status !== 404;
}

/**
 * @param {unknown} err
 */
export function isVideoBurnInNotFoundError(err) {
  const msg = String(err instanceof Error ? err.message : err || "");
  return /404|Not Found|video-burn-in/i.test(msg);
}

/**
 * @param {string} toolPrefix
 * @param {string} videoPath
 */
async function prepareBurnIn(toolPrefix, videoPath) {
  return /** @type {Promise<any>} */ (
    fetchAgentResilient(`${getAgentOrigin()}${toolPrefix}/export/video-burn-in/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ video_path: videoPath, ...burnInPipelineDiagAgentPayload() }),
      cache: "no-store",
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data?.detail ? String(data.detail) : `HTTP ${res.status}`;
        if (res.status === 404) {
          throw new Error("Not Found");
        }
        throw new Error(msg);
      }
      return data;
    })
  );
}

/**
 * @param {string} toolPrefix
 * @param {string} jobId
 * @param {readonly { index: number, start: number, end: number, png: Uint8Array }[]} frames
 */
async function uploadBurnInFramesBatch(toolPrefix, jobId, frames) {
  const form = new FormData();
  form.append("job_id", jobId);
  form.append(
    "meta",
    JSON.stringify(
      frames.map((f) => ({
        index: f.index,
        start: f.start,
        end: f.end,
      })),
    ),
  );
  for (const f of frames) {
    form.append(`frame_${f.index}`, new Blob([f.png]), `frame_${f.index}.png`);
  }
  const res = await fetchAgentResilient(
    `${getAgentOrigin()}${toolPrefix}/export/video-burn-in/frames-batch`,
    {
      method: "POST",
      body: form,
      cache: "no-store",
    },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.detail ? String(data.detail) : `프레임 배치 업로드 실패 (${res.status})`);
  }
  return res.json().catch(() => ({}));
}

/**
 * @param {string} toolPrefix
 * @param {string} jobId
 * @param {object} finishPayload
 * @param {{ path?: string, position?: string } | null | undefined} finishPayload.watermark
 * @param {readonly object[]} [finishPayload.cut_ranges]
 * @param {readonly object[]} [finishPayload.virtual_audio_map]
 * @param {boolean} [finishPayload.requires_concat]
 * @param {string} [finishPayload.export_time_axis]
 */
async function finishBurnIn(toolPrefix, jobId, finishPayload) {
  const watermark = finishPayload?.watermark;
  return fetchAgentResilient(`${getAgentOrigin()}${toolPrefix}/export/video-burn-in/finish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      job_id: jobId,
      cut_ranges: finishPayload?.cut_ranges || [],
      virtual_audio_map: finishPayload?.virtual_audio_map || [],
      requires_concat: !!finishPayload?.requires_concat,
      export_time_axis: finishPayload?.export_time_axis || null,
      program_duration_sec:
        typeof finishPayload?.program_duration_sec === "number"
          ? finishPayload.program_duration_sec
          : null,
      watermark: watermark?.path ? watermark : null,
      ...burnInPipelineDiagAgentPayload(),
    }),
    cache: "no-store",
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.detail ? String(data.detail) : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  });
}

/**
 * @param {object} opts
 * @param {string} opts.toolPrefix
 * @param {string} opts.videoPath
 * @param {readonly object[]} lastCues
 * @param {readonly object[]} cutRanges
 * @param {object} style
 * @param {boolean} [opts.requiresConcat]
 * @param {"stitched_program" | "filter_program" | "media"} [opts.exportTimeAxis]
 * @param {number} [opts.actualDuration]
 * @param {number} [opts.burninDuration]
 * @param {readonly object[]} [opts.programToBurninMap]
 * @param {object} [opts.burnInMediaContract]
 * @param {{ path?: string, position?: string } | null | undefined} [opts.watermark]
 * @param {(patch: { progress?: number, step?: string, message?: string }) => void} [opts.onUiProgress]
 * @param {readonly object[]} [opts.blocks]
 * @param {readonly object[]} [opts.virtualIndex]
 * @param {readonly object[]} [opts.virtualAudioMap]
 * @param {readonly import("../shared/program-clips-ssot.js").ProgramClip[]} [opts.programClips]
 */
export async function runVideoBurnInExport({
  toolPrefix,
  videoPath,
  lastCues,
  cutRanges,
  style,
  requiresConcat,
  exportTimeAxis,
  actualDuration,
  burninDuration,
  programToBurninMap,
  burnInMediaContract,
  watermark,
  onUiProgress,
  blocks,
  virtualIndex,
  virtualAudioMap,
  programClips,
}) {
  const axis = exportTimeAxis || (requiresConcat ? "stitched_program" : "media");
  const isV5Program = axis === "program";
  const stitched = !isV5Program && (requiresConcat === true || axis === "stitched_program");
  const useProgramSchedule = isProgramExportTimeAxis(axis);
  const scheduleCutRanges = useProgramSchedule ? [] : cutRanges;
  const contract = burnInMediaContract || buildBurnInMediaContract();
  let map = programToBurninMap?.length
    ? programToBurninMap
    : contract?.program_to_burnin_map?.length
      ? contract.program_to_burnin_map
      : null;

  if (
    stitched &&
    (!map || !map.length) &&
    typeof actualDuration === "number" &&
    actualDuration > 0 &&
    (virtualAudioMap || []).length
  ) {
    map = buildProgramToBurninMapFromVirtualAudioMap(virtualAudioMap, actualDuration);
    burnInConsoleLog("program_map_fe_fallback", { segments: map.length, actualDuration });
  }

  if (stitched && !isV5Program && (!map || !map.length)) {
    throw new Error(
      "program_to_burnin_map이 없습니다. itmatzip-agent를 재빌드·재시작한 뒤 export를 다시 시도하세요.",
    );
  }

  const overlayCtx = useProgramSchedule
    ? createProgramBurnInOverlayContext({
        cues: lastCues,
        blocks,
        virtualIndex,
        programClips,
        exportTimeAxis: axis,
        requiresConcat: stitched,
        actualDuration,
      })
    : createOverlayTimingContext({
        cues: lastCues,
        blocks,
        virtualIndex,
        cutRanges: scheduleCutRanges,
        playbackMode: "time",
        exportTimeAxis: axis,
        requiresConcat: stitched,
        programClips,
      });
  const parity = runExportParityGate(overlayCtx);
  burnInConsoleLog("overlay_parity", {
    ok: parity.ok,
    blocked: parity.blocked,
    sampleCount: parity.sampleCount,
    mismatchCount: parity.mismatches.length,
  });
  if (parity.blocked) {
    throw new Error(
      `Overlay timing parity failed (${parity.mismatches.length} mismatches / ${parity.sampleCount} samples). Export blocked.`,
    );
  }

  if (map?.length) {
    const mapParity = runProgramMapParityGate(map);
    if (mapParity.blocked) {
      throw new Error(
        `Program→burnin map parity failed (${mapParity.issues.length} issues). Export blocked.`,
      );
    }
  }

  const schedule = buildOverlayCaptureSchedule(lastCues, {
    requiresConcat: stitched,
    exportTimeAxis: axis,
    cutRanges: scheduleCutRanges,
    blocks,
    virtualIndex,
    programClips,
    programToBurninMap: map || undefined,
  });
  if (!schedule.length) throw new Error("보낼 자막이 없습니다.");

  const scheduleEnd = schedule.length ? schedule[schedule.length - 1].end : 0;
  const burninDur =
    typeof burninDuration === "number" && burninDuration > 0
      ? burninDuration
      : typeof actualDuration === "number" && actualDuration > 0
        ? actualDuration
        : scheduleEnd;
  const contractProgramDur = Number(contract?.program_duration_sec) || 0;
  const overlayDurationSec = isV5Program
    ? Math.max(
        burninDur > 0 ? burninDur : 0,
        contractProgramDur > 0 ? contractProgramDur : 0,
        scheduleEnd,
        0.1,
      )
    : Math.min(scheduleEnd, burninDur);
  const virtualProgramEnd = virtualMapProgramEndSec(virtualAudioMap);
  const handoffBase = {
    burninMediaPath: videoPath,
    exportTimeAxis: axis,
    stitched,
    requiresConcat: stitched,
    actualDuration: stitched ? actualDuration : undefined,
    burninDuration: burninDur,
    overlayDurationSec,
    programMapSegments: map?.length || 0,
    contractTargetFps: contract?.target_ntsc_fps,
    scheduleSegments: schedule.length,
    scheduleEnd,
    scheduleFirstStart: schedule.length ? schedule[0].start : 0,
    virtualProgramEnd,
    virtualMapSegments: (virtualAudioMap || []).length,
    finishMapSegments: axis === "filter_program" ? (virtualAudioMap || []).length : 0,
  };
  burnInPipelineDiagHandoff("schedule_built", handoffBase);
  analyzeBurnInPipelineHandoff(handoffBase);
  const hardGate = runBurnInMediaHardGate(handoffBase, { stitched });
  if (hardGate.blocked) {
    throw new Error(
      `Burn-in media contract gate failed: ${hardGate.issues.map((i) => i.code).join(", ")}`,
    );
  }

  burnInConsoleLog("export_start", {
    videoPath,
    stitched,
    exportTimeAxis: axis,
    useProgramSchedule,
    scheduleSegments: schedule.length,
    actualDuration: stitched ? actualDuration : undefined,
    scheduleEnd,
  });
  burnInPipelineDiagLog("export_start", handoffBase);

  onUiProgress?.({ progress: 2, step: "영상 · 준비", message: "FFmpeg·해상도 확인…" });
  const prep = await prepareBurnIn(toolPrefix, videoPath);
  const prepHandoff = {
    jobId: prep.job_id,
    prepareDurationSec: prep.duration_sec,
    exportFps: prep.export_fps,
    probeTargetFps: prep.media_probe?.target_ntsc_fps,
    probeVideoDur: prep.media_probe?.video_duration_sec,
    probeAudioDur: prep.media_probe?.audio_duration_sec,
    probeVfr: prep.media_probe?.vfr_suspected,
    renderW: prep.render_width,
    renderH: prep.render_height,
  };
  burnInPipelineDiagHandoff("prepare_done", { ...handoffBase, ...prepHandoff });
  analyzeBurnInPipelineHandoff({
    ...handoffBase,
    ...prepHandoff,
    overlayDurationSec,
    contractTargetFps: contract?.target_ntsc_fps || DEFAULT_TARGET_NTSC_FPS,
    probeTargetFpsFraction: prep.media_probe?.target_ntsc_fps,
    fpsFractionMatch: ntscFpsFractionsEqual(
      contract?.target_ntsc_fps,
      prep.media_probe?.target_ntsc_fps,
    ),
  });
  const prepGate = runBurnInMediaHardGate(
    {
      ...handoffBase,
      ...prepHandoff,
      contractTargetFps: contract?.target_ntsc_fps,
      probeTargetFpsFraction: prep.media_probe?.target_ntsc_fps,
      probeVfr: prep.media_probe?.vfr_suspected,
    },
    { stitched, afterPrepare: true },
  );
  if (prepGate.blocked) {
    throw new Error(
      `prepare_done media gate failed: ${prepGate.issues.map((i) => i.code).join(", ")}`,
    );
  }
  burnInConsoleLog("prepare_done", {
    jobId: prep.job_id,
    durationSec: prep.duration_sec,
    exportFps: prep.export_fps,
    mediaProbe: prep.media_probe,
    renderW: prep.render_width,
    renderH: prep.render_height,
    fullW: prep.full_width,
    fullH: prep.full_height,
  });
  burnInPipelineDiagLog("prepare_done", prepHandoff);
  const renderW = prep.render_width;
  const renderH = prep.render_height;

  let captureSchedule = schedule;
  if (isV5Program && prep.duration_sec > 0 && schedule.length > 0) {
    const scaleMap = buildProgramDurationScaleMap(scheduleEnd, prep.duration_sec);
    if (scaleMap) {
      captureSchedule = remapScheduleToBurninAxis(schedule, scaleMap);
      burnInConsoleLog("program_duration_scale", {
        programEnd: scheduleEnd,
        burninMediaDur: prep.duration_sec,
      });
    }
  }

  const exportStyle = bindExportStyleVideoNative(
    style,
    prep.full_width || style.videoWidth,
    prep.full_height || style.videoHeight,
  );

  onUiProgress?.({ progress: 8, step: "영상 · 캡처", message: "자막 프레임 생성…" });
  const frames = await captureSubtitleFrameSequence(
    captureSchedule,
    exportStyle,
    renderW,
    renderH,
    (done, total) => {
      const pct = 8 + Math.round((done / Math.max(1, total)) * 24);
      onUiProgress?.({
        progress: pct,
        step: "영상 · 캡처",
        message: `자막 캡처 ${done}/${total}`,
      });
    },
  );
  burnInConsoleLog("capture_done", { frameCount: frames.length });

  onUiProgress?.({ progress: 32, step: "영상 · 업로드", message: "프레임 전송…" });
  try {
    await uploadBurnInFramesBatch(toolPrefix, prep.job_id, frames);
    onUiProgress?.({
      progress: 40,
      step: "영상 · 업로드",
      message: `프레임 배치 업로드 ${frames.length}장`,
    });
  } catch (batchErr) {
    burnInConsoleLog("upload_batch_fallback", { error: String(batchErr) });
    for (let i = 0; i < frames.length; i += 1) {
      const url =
        `${getAgentOrigin()}${toolPrefix}/export/video-burn-in/frame` +
        `?job_id=${encodeURIComponent(prep.job_id)}` +
        `&index=${frames[i].index}` +
        `&start=${encodeURIComponent(String(frames[i].start))}` +
        `&end=${encodeURIComponent(String(frames[i].end))}`;
      const res = await fetchAgentResilient(url, {
        method: "POST",
        headers: { "Content-Type": "image/png", Accept: "application/json" },
        body: frames[i].png,
        cache: "no-store",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.detail ? String(data.detail) : `프레임 업로드 실패 (${res.status})`);
      }
      const pct = 32 + Math.round(((i + 1) / frames.length) * 8);
      onUiProgress?.({
        progress: pct,
        step: "영상 · 업로드",
        message: `프레임 업로드 ${i + 1}/${frames.length}`,
      });
    }
  }

  burnInConsoleLog("upload_done", { jobId: prep.job_id, frameCount: frames.length });

  const finishCuts = useProgramSchedule ? [] : cutRanges || [];
  onUiProgress?.({ progress: 44, step: "영상 · 인코딩", message: "FFmpeg 번인 시작…" });
  burnInConsoleLog("finish_request", {
    jobId: prep.job_id,
    cutCount: finishCuts.length,
    exportTimeAxis: axis,
    mapSegments: (virtualAudioMap || []).length,
  });
  if (burnInPipelineDiagIsEnabled()) {
    burnInPipelineDiagLog("finish_request", {
      jobId: prep.job_id,
      exportTimeAxis: axis,
      requiresConcat: stitched,
      cutCount: finishCuts.length,
      finishVirtualMapSegments: axis === "filter_program" ? (virtualAudioMap || []).length : 0,
      frameCount: frames.length,
      firstFrame: frames[0]
        ? { start: frames[0].start, end: frames[0].end, index: frames[0].index }
        : null,
      lastFrame: frames.length
        ? {
            start: frames[frames.length - 1].start,
            end: frames[frames.length - 1].end,
            index: frames[frames.length - 1].index,
          }
        : null,
    });
  }
  const finishStatus = await finishBurnIn(toolPrefix, prep.job_id, {
    cut_ranges: finishCuts,
    virtual_audio_map: axis === "filter_program" ? virtualAudioMap || [] : [],
    requires_concat: stitched,
    export_time_axis: axis,
    program_duration_sec: isV5Program ? overlayDurationSec : undefined,
    watermark,
  });
  burnInConsoleLog("finish_accepted", {
    jobId: prep.job_id,
    phase: finishStatus?.phase,
    progress: finishStatus?.progress,
    message: finishStatus?.message,
  });
  burnInPipelineDiagHandoff("finish_accepted", {
    jobId: prep.job_id,
    phase: finishStatus?.phase,
    progress: finishStatus?.progress,
    message: finishStatus?.message,
  });
  burnInPipelineDiagLog("finish_accepted", {
    jobId: prep.job_id,
    phase: finishStatus?.phase,
    progress: finishStatus?.progress,
  });
  return prep;
}
