/**
 * AutoSubtitle SyncEngine.ts — 비디오 currentTime 마스터 RAF 동기화.
 */

import { mapV2R, mapR2V, findBlockIndex, findBlockIndexByRealMs } from "./block-mapping.js";
import { checkJumpCutAtRealMs } from "./word-jump-cut.js";

const DEFAULT_TAIL_MS = 2;
const DEFAULT_JUMP_DEADBAND_SEC = 0.001;

function cloneSorted(blocks) {
  const byV = [...blocks].sort((a, b) => a.vStartMs - b.vStartMs || a.oStartMs - b.oStartMs);
  const byO = [...blocks].sort((a, b) => a.oStartMs - b.oStartMs || a.vStartMs - b.vStartMs);
  return { byV, byO };
}

function realMsFromVideo(video) {
  const sec = video.currentTime;
  if (!Number.isFinite(sec)) return 0;
  return Math.round(sec * 1000);
}

export class SyncEngine {
  /**
   * @param {HTMLVideoElement} video
   * @param {{
   *   blocks: import("./block-mapping.js").VirtualBlockMs[],
   *   onTick?: (ctx: import("./sync-engine.js").SyncTickContext) => void,
   *   onSeekSnap?: (ctx: import("./sync-engine.js").SyncTickContext) => void,
   *   jumpCutEnabled?: boolean,
   *   suppressTickWhileVideoSeeking?: boolean,
   *   jumpCutTailMs?: number,
   *   jumpDeadbandSec?: number,
   * }} options
   */
  constructor(video, options) {
    this.video = video;
    this.onTick = options.onTick;
    this.onSeekSnap = options.onSeekSnap;
    this.jumpCutEnabled = options.jumpCutEnabled !== false;
    this.suppressTickWhileVideoSeeking = options.suppressTickWhileVideoSeeking !== false;
    this.jumpCutTailMs = options.jumpCutTailMs ?? DEFAULT_TAIL_MS;
    this.jumpDeadbandSec = options.jumpDeadbandSec ?? DEFAULT_JUMP_DEADBAND_SEC;

    /** @type {import("./block-mapping.js").VirtualBlockMs[]} */
    this.blocksByV = [];
    /** @type {import("./block-mapping.js").VirtualBlockMs[]} */
    this.blocksByO = [];

    this.rafId = null;
    this.running = false;
    /** @type {'playing' | 'seeking'} */
    this.phase = "playing";

    this.boundSeeking = () => {
      this.phase = "seeking";
    };
    this.boundSeeked = () => {
      this.phase = "playing";
      this.emitSnap();
    };

    this.setBlocks(options.blocks);
    video.addEventListener("seeking", this.boundSeeking);
    video.addEventListener("seeked", this.boundSeeked);
  }

  /**
   * @param {import("./block-mapping.js").VirtualBlockMs[]} blocks
   */
  setBlocks(blocks) {
    const { byV, byO } = cloneSorted(blocks);
    this.blocksByV = byV;
    this.blocksByO = byO;
  }

  /**
   * @param {Partial<{ onTick: Function, onSeekSnap: Function, jumpCutEnabled: boolean }>} patch
   */
  updateOptions(patch) {
    if (patch.onTick !== undefined) this.onTick = patch.onTick;
    if (patch.onSeekSnap !== undefined) this.onSeekSnap = patch.onSeekSnap;
    if (patch.jumpCutEnabled !== undefined) this.jumpCutEnabled = patch.jumpCutEnabled;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.rafId = window.requestAnimationFrame(loop);
      this.tickFrame();
    };
    this.rafId = window.requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this.rafId != null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  dispose() {
    this.stop();
    this.video.removeEventListener("seeking", this.boundSeeking);
    this.video.removeEventListener("seeked", this.boundSeeked);
  }

  seekVirtualMs(virtualTimeMs) {
    const r = mapV2R(virtualTimeMs, this.blocksByV);
    if (r == null) return;
    this.video.currentTime = r / 1000;
  }

  seekRealMs(realTimeMs) {
    this.video.currentTime = Math.max(0, realTimeMs) / 1000;
  }

  mapVirtualToRealMs(vMs) {
    return mapV2R(vMs, this.blocksByV);
  }

  mapRealToVirtualMs(rMs) {
    return mapR2V(rMs, this.blocksByO);
  }

  emitSnap() {
    const ctx = this.buildContext("playing");
    this.onSeekSnap?.(ctx);
    this.onTick?.(ctx);
  }

  buildContext(phase) {
    const realTimeMs = realMsFromVideo(this.video);
    const virtualTimeMs = mapR2V(realTimeMs, this.blocksByO) ?? 0;
    return {
      virtualTimeMs,
      realTimeMs,
      blockIndexVirtual: findBlockIndex(virtualTimeMs, this.blocksByV),
      blockIndexReal: findBlockIndexByRealMs(realTimeMs, this.blocksByO),
      phase,
    };
  }

  checkJumpCut(currentTimeSec) {
    const realTimeMs = Math.round(Math.max(0, currentTimeSec) * 1000);
    const cut = checkJumpCutAtRealMs(
      realTimeMs,
      this.blocksByV,
      this.blocksByO,
      this.jumpCutTailMs,
      this.jumpDeadbandSec,
    );
    if (!cut) return false;
    this.video.currentTime = cut.targetSec;
    return true;
  }

  maybeJumpCut(realTimeMs) {
    if (!this.jumpCutEnabled || this.blocksByV.length === 0) return;
    if (this.video.paused) return;
    const cut = checkJumpCutAtRealMs(
      realTimeMs,
      this.blocksByV,
      this.blocksByO,
      this.jumpCutTailMs,
      this.jumpDeadbandSec,
    );
    if (cut) this.video.currentTime = cut.targetSec;
  }

  tickFrame() {
    const seeking = this.video.seeking;
    if (seeking && this.suppressTickWhileVideoSeeking) return;

    const realTimeMs = realMsFromVideo(this.video);
    this.maybeJumpCut(realTimeMs);

    const ctx = this.buildContext(seeking ? "seeking" : "playing");
    if (seeking && this.suppressTickWhileVideoSeeking) return;
    this.onTick?.(ctx);
  }
}

export { mapV2R, mapR2V, findBlockIndex } from "./block-mapping.js";
