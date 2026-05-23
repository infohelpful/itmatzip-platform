/**
 * AutoSubtitle SyncEngineReact.tsx — React 없이 비디오에 SyncEngine 부착.
 */

import { SyncEngine } from "./sync-engine.js";
import { playbackWordBlocks } from "./word-jump-cut.js";

export class SyncEngineHost {
  constructor() {
    /** @type {SyncEngine | null} */
    this.engine = null;
    /** @type {HTMLVideoElement | null} */
    this.video = null;
  }

  /**
   * @param {HTMLVideoElement} video
   * @param {import("./block-mapping.js").VirtualBlockMs[]} blocks
   * @param {import("./sync-engine.js").SyncEngine['constructor'] extends Function ? Parameters<SyncEngine['constructor']>[1] : never} options
   */
  attach(video, blocks, options = {}) {
    this.detach();
    this.video = video;
    const playBlocks = playbackWordBlocks(blocks);
    this.engine = new SyncEngine(video, {
      blocks: playBlocks,
      ...options,
    });
    this.engine.start();
  }

  /**
   * @param {import("./word-jump-cut.js").WordTimelineBlockMs[]} blocks
   */
  setBlocks(blocks) {
    this.engine?.setBlocks(playbackWordBlocks(blocks));
  }

  seekVirtualMs(virtualMs) {
    this.engine?.seekVirtualMs(virtualMs);
  }

  seekRealMs(realMs) {
    this.engine?.seekRealMs(realMs);
  }

  start() {
    this.engine?.start();
  }

  stop() {
    this.engine?.stop();
  }

  detach() {
    this.engine?.dispose();
    this.engine = null;
    this.video = null;
  }
}
