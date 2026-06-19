/**
 * Overlay Timing SSOT parity — resolveCueAtTime vs generateCaptureSchedule 일치 검증.
 */

import {
  PREVIEW_OVERLAY_BRIDGE_SEC,
  createOverlayTimingContext,
  generateCaptureSchedule,
  resolveCueAtTime,
  scheduleSegmentAtTime,
} from "./overlay-timing-ssot.js?v=4";
import {
  assertProgramToBurninMapMonotonic,
  mapProgramTimeToBurnInPts,
} from "./media-timing-ssot.js?v=6";

const TIME_EPS = 1e-6;

/**
 * @param {ReturnType<typeof createOverlayTimingContext>} ctx
 * @param {readonly import("./overlay-timing-ssot.js").OverlayTimingSegment[]} schedule
 */
export function buildOverlayParitySampleTimes(ctx, schedule) {
  /** @type {Set<number>} */
  const samples = new Set([0]);

  for (const seg of schedule) {
    samples.add(seg.start);
    samples.add(seg.end);
    samples.add(Math.max(0, seg.start - TIME_EPS));
    samples.add(seg.start + TIME_EPS);
    samples.add(Math.max(0, seg.end - TIME_EPS));
    samples.add(seg.end + TIME_EPS);
    samples.add(Math.max(0, seg.start - PREVIEW_OVERLAY_BRIDGE_SEC));
    samples.add(seg.end + PREVIEW_OVERLAY_BRIDGE_SEC);
    const mid = seg.start + (seg.end - seg.start) / 2;
    if (mid > seg.start + TIME_EPS && mid < seg.end - TIME_EPS) {
      samples.add(mid);
    }
  }

  for (const clip of ctx.clips || []) {
    samples.add(clip.editStart);
    samples.add(clip.editEnd);
    samples.add(Math.max(0, clip.editStart - TIME_EPS));
    samples.add(clip.editEnd - TIME_EPS);
  }

  for (const cue of ctx.cues || []) {
    const start = Number(cue.start);
    const end = Number(cue.end);
    if (Number.isFinite(start)) {
      samples.add(start);
      samples.add(Math.max(0, start - PREVIEW_OVERLAY_BRIDGE_SEC));
    }
    if (Number.isFinite(end)) {
      samples.add(end);
      samples.add(end + PREVIEW_OVERLAY_BRIDGE_SEC);
    }
  }

  return [...samples]
    .filter((t) => Number.isFinite(t) && t >= 0)
    .sort((a, b) => a - b);
}

/**
 * @typedef {{ t: number, resolveCueIndex: number, scheduleCueIndex: number, resolveText: string, scheduleText: string }} OverlayParityMismatch
 */

/**
 * @param {ReturnType<typeof createOverlayTimingContext>} ctx
 * @param {readonly number[]} [sampleTimes]
 * @param {{ skipListOrderPlaying?: boolean }} [opts]
 * @returns {{ ok: boolean, mismatches: OverlayParityMismatch[], sampleCount: number }}
 */
export function assertOverlayTimingParity(ctx, sampleTimes, opts = {}) {
  const parityCtx = createOverlayTimingContext({
    ...ctx,
    playbackMode: "time",
    isMediaPlaying: false,
    resolveListOrderCueIndex: undefined,
    listPlaybackClipPos: -1,
  });
  parityCtx._scheduleCache = null;

  const schedule = generateCaptureSchedule(parityCtx);
  const times =
    sampleTimes?.length > 0
      ? sampleTimes
      : buildOverlayParitySampleTimes(parityCtx, schedule);

  /** @type {OverlayParityMismatch[]} */
  const mismatches = [];

  for (const t of times) {
    const resolved = resolveCueAtTime(parityCtx, t);
    const seg = scheduleSegmentAtTime(schedule, t);
    const resolveCueIndex = resolved?.cueIndex ?? -1;
    const scheduleCueIndex = seg?.cueIndex ?? -1;
    const resolveText = resolved?.text ?? "";
    const scheduleText = seg?.text ?? "";

    if (resolveCueIndex !== scheduleCueIndex || resolveText !== scheduleText) {
      mismatches.push({
        t,
        resolveCueIndex,
        scheduleCueIndex,
        resolveText,
        scheduleText,
      });
    }
  }

  return {
    ok: mismatches.length === 0,
    mismatches,
    sampleCount: times.length,
  };
}

/** Dev/staging 또는 localStorage OVERLAY_PARITY_BLOCK=1 이면 export 차단. */
export function shouldBlockExportOnParityFailure() {
  try {
    if (typeof localStorage !== "undefined") {
      if (localStorage.getItem("OVERLAY_PARITY_BLOCK") === "1") return true;
      if (localStorage.getItem("OVERLAY_PARITY_BLOCK") === "0") return false;
    }
  } catch {
    /* ignore */
  }
  if (typeof location === "undefined") return false;
  const host = String(location.hostname || "").toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".local") ||
    host.includes("staging") ||
    host.startsWith("dev.")
  );
}

/**
 * Export 직전 parity gate.
 *
 * @param {ReturnType<typeof createOverlayTimingContext>} ctx
 * @returns {{ ok: boolean, blocked: boolean, mismatches: OverlayParityMismatch[], sampleCount: number }}
 */
export function runExportParityGate(ctx) {
  const result = assertOverlayTimingParity(ctx);
  const blocked = !result.ok && shouldBlockExportOnParityFailure();

  if (!result.ok) {
    for (const m of result.mismatches.slice(0, 8)) {
      const msg = `[overlay-parity] mismatch t=${m.t.toFixed(4)} resolveCueIndex=${m.resolveCueIndex} scheduleCueIndex=${m.scheduleCueIndex}`;
      if (blocked) {
        console.error(msg, m);
      } else {
        console.warn(msg, m);
      }
    }
    if (result.mismatches.length > 8) {
      const tail = `[overlay-parity] +${result.mismatches.length - 8} more mismatches`;
      if (blocked) console.error(tail);
      else console.warn(tail);
    }
  }

  return { ...result, blocked };
}

/**
 * @param {readonly object[]} map
 * @returns {{ ok: boolean, blocked: boolean, issues: { code: string, detail: string }[], sampleCount: number }}
 */
export function runProgramMapParityGate(map) {
  /** @type {{ code: string, detail: string }[]} */
  const issues = [];
  try {
    assertProgramToBurninMapMonotonic(map);
  } catch (err) {
    issues.push({
      code: "MAP_MONOTONICITY",
      detail: String(err instanceof Error ? err.message : err),
    });
  }

  const sampleTimes = [];
  for (const seg of map) {
    const es = Number(seg.editStart ?? seg.edit_start);
    const ee = Number(seg.editEnd ?? seg.edit_end);
    if (!Number.isFinite(es) || !Number.isFinite(ee)) continue;
    sampleTimes.push(es, ee, es + (ee - es) / 2);
    sampleTimes.push(Math.max(0, es - TIME_EPS), ee + TIME_EPS);
  }

  let prevBurnin = -Infinity;
  for (const t of [...new Set(sampleTimes)].sort((a, b) => a - b)) {
    const burninT = mapProgramTimeToBurnInPts(t, map);
    if (burninT < prevBurnin - 1e-5) {
      issues.push({
        code: "MAP_SAMPLE_NON_MONOTONIC",
        detail: `t_program=${t.toFixed(4)} → t_burnin=${burninT.toFixed(4)} < prev ${prevBurnin.toFixed(4)}`,
      });
      break;
    }
    prevBurnin = burninT;
  }

  const blocked = issues.length > 0 && shouldBlockExportOnParityFailure();
  return {
    ok: issues.length === 0,
    blocked,
    issues,
    sampleCount: sampleTimes.length,
  };
}
