/**
 * AutoSubtitle playbackCommandRouter.ts
 */

export class PlaybackCommandRouter {
  constructor() {
    this.sessionId = 0;
    this.mappingPendingRevision = 0;
    this.mappingCommittedRevision = 0;
    /** @type {{ startMediaSec: number, endMediaSec: number, sessionId: number } | null} */
    this.activeRange = null;
  }

  setMappingRevision(pending, committed) {
    this.mappingPendingRevision = Math.max(0, pending);
    this.mappingCommittedRevision = Math.max(0, committed);
  }

  isMapperReady() {
    return this.mappingCommittedRevision >= this.mappingPendingRevision;
  }

  /**
   * @param {'seek' | 'seekAndPlay' | 'togglePlay'} _kind
   */
  beginSeekLike(_kind) {
    if (!this.isMapperReady()) return { allowed: false, reason: "mapper-stale" };
    this.sessionId += 1;
    this.activeRange = null;
    return { allowed: true, sessionId: this.sessionId };
  }

  beginPlayRange(startMediaSec, endMediaSec) {
    if (!this.isMapperReady()) return { allowed: false, reason: "mapper-stale" };
    const cur = this.activeRange;
    if (
      cur &&
      Math.abs(cur.startMediaSec - startMediaSec) < 0.01 &&
      Math.abs(cur.endMediaSec - endMediaSec) < 0.01
    ) {
      return { allowed: false, reason: "range-locked" };
    }
    this.sessionId += 1;
    this.activeRange = { startMediaSec, endMediaSec, sessionId: this.sessionId };
    return { allowed: true, sessionId: this.sessionId };
  }

  finishRange(sessionId) {
    if (!this.activeRange || this.activeRange.sessionId !== sessionId) return;
    this.activeRange = null;
  }

  cancelSession(sessionId) {
    if (this.sessionId !== sessionId) return;
    if (this.activeRange?.sessionId === sessionId) this.activeRange = null;
  }

  snapshot() {
    return {
      sessionId: this.sessionId,
      mappingPendingRevision: this.mappingPendingRevision,
      mappingCommittedRevision: this.mappingCommittedRevision,
      activeRange: this.activeRange ? { ...this.activeRange } : null,
    };
  }
}

export function createPlaybackCommandRouter() {
  return new PlaybackCommandRouter();
}
