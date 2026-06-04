/**
 * 목록 순서 seamless 프리뷰 — 클립 메타 + 스택 tick.
 */

import { getPreviewMediaBridge } from "./seamless-preview-stack.js?v=7";

/** @type {import("../shared/timeline-mapping.js").TimelineClip[]} */
let activeClips = [];
let activeClipPos = 0;

/**
 * @param {import("../shared/subtitle-list-playback.js").createListOrderPreviewMapping} bundle
 */
export function setListOrderPreviewTimeline(bundle) {
  activeClips = bundle.clips;
  activeClipPos = 0;
}

export function clearListOrderPreviewTimeline() {
  activeClips = [];
  activeClipPos = 0;
  getPreviewMediaBridge().endListOrderPlayback();
}

/** 클립 맵 존재 (하이라이트용) */
export function isListOrderPreviewTimelineActive() {
  return activeClips.length > 0;
}

/** 실제 seamless 목록 재생 중 */
export function isListOrderSeamlessPlaybackActive() {
  return getPreviewMediaBridge().isListOrderMode();
}

export function getListOrderPreviewClips() {
  return activeClips;
}

/** @param {number} clipIndex */
export function resetListOrderPreviewClipPos(clipIndex) {
  if (!activeClips.length) {
    activeClipPos = 0;
    return;
  }
  activeClipPos = Math.max(0, Math.min(clipIndex, activeClips.length - 1));
}

export function getListOrderPreviewClipPos() {
  const bridge = getPreviewMediaBridge();
  if (bridge.isListOrderMode()) {
    const p = bridge.getListClipPos();
    if (p >= 0) return p;
  }
  return activeClipPos;
}

/**
 * @param {HTMLVideoElement} _video
 * @param {HTMLAudioElement} _audio
 * @param {{ skipRanges: { start: number, end: number }[] }} opts
 */
export function syncListOrderPreviewPlayback(_video, _audio, opts) {
  if (!isListOrderSeamlessPlaybackActive()) return false;
  const bridge = getPreviewMediaBridge();
  if (!bridge.stack) return false;

  const res = bridge.syncListOrderTick(opts);
  if (typeof res?.clipPos === "number" && res.clipPos >= 0) {
    activeClipPos = res.clipPos;
  }
  return true;
}

/**
 * @param {{
 *   startMediaSec: number,
 *   skipRanges: { start: number, end: number }[],
 *   clipPos: number,
 * }} opts
 */
export async function armListOrderSeamlessPlayback(opts) {
  const bridge = getPreviewMediaBridge();
  await bridge.beginListOrderPlayback({
    clips: activeClips,
    clipPos: opts.clipPos,
    skipRanges: opts.skipRanges,
    startMediaSec: opts.startMediaSec,
  });
  activeClipPos = opts.clipPos;
}
