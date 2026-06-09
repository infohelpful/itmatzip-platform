/**
 * 캐럿·재생 경로 진단 — 콘솔 `[CARET-PLAY]` 필터.
 * autoSubtitleCaretPlayDiag.enable(true)
 */

import { diagLogBufferPush } from "./diag-log-export.js?v=1";

let enabled = false;
let lastTickLogWallMs = 0;
const TICK_LOG_INTERVAL_MS = 250;

/** @param {boolean} on */
export function caretPlayDiagSetEnabled(on) {
  enabled = Boolean(on);
  if (enabled) lastTickLogWallMs = 0;
}

export function caretPlayDiagIsEnabled() {
  return enabled;
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} [payload]
 */
export function caretPlayDiagLog(event, payload = {}) {
  if (!enabled) return;
  const row = { wallMs: performance.now(), ...payload };
  console.log("[CARET-PLAY]", event, row);
  diagLogBufferPush("CARET-PLAY", "log", event, row);
}

/**
 * playbackTick 등 고빈도 구간 — 상태 변화 시 force=true.
 *
 * @param {string} event
 * @param {Record<string, unknown>} [payload]
 * @param {boolean} [force]
 */
export function caretPlayDiagLogTick(event, payload = {}, force = false) {
  if (!enabled) return;
  const wallMs = performance.now();
  if (!force && wallMs - lastTickLogWallMs < TICK_LOG_INTERVAL_MS) return;
  lastTickLogWallMs = wallMs;
  const row = { wallMs, ...payload };
  console.log("[CARET-PLAY]", event, row);
  diagLogBufferPush("CARET-PLAY", "log", event, row);
}
