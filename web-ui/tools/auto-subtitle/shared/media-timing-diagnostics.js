/**
 * media-timing 진단 — 콘솔 `[media-timing]` 필터.
 * autoSubtitleMediaTimingDiag.enable(true)
 */

import { diagLogBufferPush } from "./diag-log-export.js?v=1";

let enabled = false;

/** @param {boolean} on */
export function mediaTimingDiagSetEnabled(on) {
  enabled = Boolean(on);
}

export function mediaTimingDiagIsEnabled() {
  return enabled;
}

/**
 * @param {string} tag
 * @param {Record<string, unknown>} [payload]
 */
export function mediaTimingDiagLog(tag, payload = {}) {
  if (!enabled) return;
  console.log(`[media-timing] ${tag}`, payload);
  diagLogBufferPush("media-timing", "log", tag, payload);
}

/**
 * @param {string} tag
 * @param {unknown} [payload]
 */
export function mediaTimingDiagWarn(tag, payload) {
  if (!enabled) return;
  if (payload !== undefined) {
    console.warn(`[media-timing] ${tag}`, payload);
    diagLogBufferPush("media-timing", "warn", tag, payload);
  } else {
    console.warn(`[media-timing] ${tag}`);
    diagLogBufferPush("media-timing", "warn", tag, null);
  }
}
