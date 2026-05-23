/**
 * AutoSubtitle VideoSeekUiController.ts
 */

export class VideoSeekUiController {
  /**
   * @param {HTMLVideoElement} video
   * @param {{
   *   throttleMs?: number,
   *   onSeekingChange?: (locked: boolean) => void,
   *   onSnapRealMs?: (realMs: number) => void,
   *   onOptimisticVirtualMs?: (virtualMs: number) => void,
   * }} [options]
   */
  constructor(video, options = {}) {
    this.video = video;
    this.opts = options;
    this.throttleMs = options.throttleMs ?? 32;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.throttleTimer = null;
    /** @type {number | null} */
    this.pendingRealSec = null;
    /** @type {number | null} */
    this.optimisticVirtualMs = null;

    this.boundSeeking = () => this.opts.onSeekingChange?.(true);
    this.boundSeeked = () => {
      this.opts.onSeekingChange?.(false);
      const rMs = Math.round(this.video.currentTime * 1000);
      this.optimisticVirtualMs = null;
      this.opts.onSnapRealMs?.(rMs);
    };

    video.addEventListener("seeking", this.boundSeeking);
    video.addEventListener("seeked", this.boundSeeked);
  }

  get isPlayheadCommitLocked() {
    return this.video.seeking;
  }

  get lastOptimisticVirtualMs() {
    return this.optimisticVirtualMs;
  }

  /**
   * @param {Partial<{ throttleMs: number, onSeekingChange: Function, onSnapRealMs: Function, onOptimisticVirtualMs: Function }>} patch
   */
  updateOptions(patch) {
    this.opts = { ...this.opts, ...patch };
    if (patch.throttleMs != null) this.throttleMs = Math.max(0, patch.throttleMs);
  }

  /**
   * @param {number} virtualMs
   * @param {(vMs: number) => number | null} mapVirtualToRealSec
   */
  scrubVirtualMs(virtualMs, mapVirtualToRealSec) {
    this.optimisticVirtualMs = virtualMs;
    this.opts.onOptimisticVirtualMs?.(virtualMs);
    const realSec = mapVirtualToRealSec(virtualMs);
    if (realSec == null || !Number.isFinite(realSec)) return;
    this.pendingRealSec = realSec;

    if (this.throttleMs <= 0) {
      this.video.currentTime = Math.max(0, realSec);
      return;
    }
    if (this.throttleTimer != null) window.clearTimeout(this.throttleTimer);
    this.throttleTimer = window.setTimeout(() => {
      this.throttleTimer = null;
      if (this.pendingRealSec != null) {
        this.video.currentTime = Math.max(0, this.pendingRealSec);
      }
    }, this.throttleMs);
  }

  /**
   * @param {number} realSec
   */
  seekRealSecImmediate(realSec) {
    if (this.throttleTimer != null) {
      window.clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.pendingRealSec = realSec;
    this.video.currentTime = Math.max(0, realSec);
  }

  dispose() {
    if (this.throttleTimer != null) {
      window.clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.video.removeEventListener("seeking", this.boundSeeking);
    this.video.removeEventListener("seeked", this.boundSeeked);
  }
}
