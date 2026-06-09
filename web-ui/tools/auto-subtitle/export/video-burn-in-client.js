/**
 * Electron exportByFormat(video) 웹 대응 — 자막 캡처 + 단일 패스 FFmpeg 번인.
 */

import { fetchAgent, getAgentOrigin } from "../../common/bridge.js?v=as9";
import { buildOverlayCaptureSchedule } from "../shared/overlay-capture-schedule.js?v=2";
import { bindExportStyleVideoNative } from "../shared/export-render-scale.js?v=1";
import { captureSubtitleFrameSequence } from "./subtitle-bgra-capture.js?v=5";

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
      body: JSON.stringify({ video_path: videoPath }),
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
 * @param {{ index: number, start: number, end: number, png: Uint8Array }} frame
 */
async function uploadBurnInFrame(toolPrefix, jobId, frame) {
  const url =
    `${getAgentOrigin()}${toolPrefix}/export/video-burn-in/frame` +
    `?job_id=${encodeURIComponent(jobId)}` +
    `&index=${frame.index}` +
    `&start=${encodeURIComponent(String(frame.start))}` +
    `&end=${encodeURIComponent(String(frame.end))}`;
  const res = await fetchAgentResilient(url, {
    method: "POST",
    headers: { "Content-Type": "image/png", Accept: "application/json" },
    body: frame.png,
    cache: "no-store",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.detail ? String(data.detail) : `프레임 업로드 실패 (${res.status})`);
  }
}

/**
 * @param {string} toolPrefix
 * @param {string} jobId
 * @param {readonly object[]} cutRanges
 * @param {{ path?: string, position?: string } | null | undefined} watermark
 */
async function finishBurnIn(toolPrefix, jobId, cutRanges, watermark) {
  return fetchAgentResilient(`${getAgentOrigin()}${toolPrefix}/export/video-burn-in/finish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      job_id: jobId,
      cut_ranges: cutRanges || [],
      watermark: watermark?.path ? watermark : null,
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
 * @param {"stitched_program" | "media"} [opts.exportTimeAxis]
 * @param {number} [opts.actualDuration]
 * @param {{ path?: string, position?: string } | null | undefined} [opts.watermark]
 * @param {(patch: { progress?: number, step?: string, message?: string }) => void} [opts.onUiProgress]
 * @param {readonly object[]} [opts.blocks]
 * @param {readonly object[]} [opts.virtualIndex]
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
  watermark,
  onUiProgress,
  blocks,
  virtualIndex,
}) {
  const stitched =
    requiresConcat === true || exportTimeAxis === "stitched_program";
  const schedule = buildOverlayCaptureSchedule(lastCues, {
    requiresConcat: stitched,
    cutRanges: stitched ? [] : cutRanges,
    actualDuration: stitched ? actualDuration : undefined,
    blocks,
    virtualIndex,
  });
  if (!schedule.length) throw new Error("보낼 자막이 없습니다.");

  burnInConsoleLog("export_start", {
    videoPath,
    stitched,
    scheduleSegments: schedule.length,
    actualDuration: stitched ? actualDuration : undefined,
    scheduleEnd: schedule.length ? schedule[schedule.length - 1].end : 0,
  });

  onUiProgress?.({ progress: 2, step: "영상 · 준비", message: "FFmpeg·해상도 확인…" });
  const prep = await prepareBurnIn(toolPrefix, videoPath);
  burnInConsoleLog("prepare_done", {
    jobId: prep.job_id,
    durationSec: prep.duration_sec,
    renderW: prep.render_width,
    renderH: prep.render_height,
    fullW: prep.full_width,
    fullH: prep.full_height,
  });
  const renderW = prep.render_width;
  const renderH = prep.render_height;
  const exportStyle = bindExportStyleVideoNative(
    style,
    prep.full_width || style.videoWidth,
    prep.full_height || style.videoHeight,
  );

  onUiProgress?.({ progress: 8, step: "영상 · 캡처", message: "자막 프레임 생성…" });
  const frames = await captureSubtitleFrameSequence(
    schedule,
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
  for (let i = 0; i < frames.length; i += 1) {
    await uploadBurnInFrame(toolPrefix, prep.job_id, frames[i]);
    const pct = 32 + Math.round(((i + 1) / frames.length) * 8);
    onUiProgress?.({
      progress: pct,
      step: "영상 · 업로드",
      message: `프레임 업로드 ${i + 1}/${frames.length}`,
    });
  }

  burnInConsoleLog("upload_done", { jobId: prep.job_id, frameCount: frames.length });

  const finishCuts = stitched ? [] : cutRanges || [];
  onUiProgress?.({ progress: 40, step: "영상 · 인코딩", message: "FFmpeg 번인 시작…" });
  burnInConsoleLog("finish_request", { jobId: prep.job_id, cutCount: finishCuts.length });
  const finishStatus = await finishBurnIn(toolPrefix, prep.job_id, finishCuts, watermark);
  burnInConsoleLog("finish_accepted", {
    jobId: prep.job_id,
    phase: finishStatus?.phase,
    progress: finishStatus?.progress,
    message: finishStatus?.message,
  });
  return prep;
}
