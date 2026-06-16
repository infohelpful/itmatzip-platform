/**
 * 재생·동기화 오케스트레이션 — SyncEngine, VideoSeekUi, CommandRouter, TimelineMapping.
 */

import { createPlaybackCommandRouter } from "../timeline/playback-command-router.js";
import { USE_WORD_BASED_PLAYBACK_SCHEDULE } from "../timeline/playback-policy.js";
import {
  buildPassthroughSegmentsSkippingCuts,
  buildScheduledMediaSegmentsFromSubtitleWords,
} from "./playback-schedule.js";
import { createTimelineMapping, jumpVideoPastClipTailIfNeeded, mapMediaToProgramSec, mapProgramToMediaSec } from "../shared/timeline-mapping.js";
import { skipCutRangeAt } from "../playback.js";
import { SyncEngineHost } from "../sync/sync-engine-host.js";
import { VideoSeekUiController } from "../sync/video-seek-ui-controller.js";
import { virtualBlocksForSyncEngine } from "../sync/virtual-blocks.js";
import { playbackWordBlocks } from "../sync/word-jump-cut.js";
import { assignMasterAudioTimelineSecIfNeeded } from "./html-audio-master-playback.js?v=5";

export class PlaybackOrchestrator {
  constructor() {
    this.router = createPlaybackCommandRouter();
    this.syncHost = new SyncEngineHost();
    /** @type {VideoSeekUiController | null} */
    this.seekUi = null;
    /** @type {ReturnType<typeof createTimelineMapping> | null} */
    this.mapping = null;
    /** @type {import("../sync/word-jump-cut.js").WordTimelineBlockMs[]} */
    this.wordBlocks = [];
    this.mappingRevision = 0;
    /** @type {HTMLVideoElement | null} */
    this.video = null;
    /** @type {HTMLAudioElement | null} */
    this.masterAudio = null;
    this.mediaDurationSec = 0;
    this.editPlayheadSec = 0;
    this.isSeekingLocked = false;
    /** @type {((ctx: { editSec: number, mediaSec: number, virtualMs: number }) => void) | null} */
    this.onPlayheadChange = null;
    /** @type {import("../shared/subtitles.js").SubtitleLine[]} */
    this.lines = [];
    /** @type {{ start: number, end: number }[]} */
    this.skipRanges = [];
    /** program-master.mp4 재생 시 SyncEngine jump-cut 비활성 (이미 편집 타임라인에 반영됨) */
    this.programMasterMode = false;
  }

  /**
   * @param {HTMLVideoElement} video
   * @param {{ onPlayheadChange?: (ctx: { editSec: number, mediaSec: number, virtualMs: number }) => void }} [opts]
   */
  attachVideo(video, opts = {}) {
    this.detachVideo();
    this.video = video;
    this.masterAudio = opts.masterAudio ?? null;
    this.onPlayheadChange = opts.onPlayheadChange ?? null;

    this.seekUi = new VideoSeekUiController(video, {
      throttleMs: 32,
      onSeekingChange: (locked) => {
        this.isSeekingLocked = locked;
      },
      onSnapRealMs: (rMs) => {
        this._applySyncContext(rMs, "seeking");
      },
      onOptimisticVirtualMs: (vMs) => {
        this.editPlayheadSec = vMs / 1000;
        this._notifyPlayhead(this.editPlayheadSec, null, vMs);
      },
    });
  }

  detachVideo() {
    this.syncHost.detach();
    this.seekUi?.dispose();
    this.seekUi = null;
    this.video = null;
    this.masterAudio = null;
  }

  /** WebAudio/수동 재생 루프 중 SyncEngine jump-cut 이 video seek 와 충돌하지 않도록 일시 정지 */
  suspendSyncEngineForWebAudio() {
    this.syncHost.stop();
  }

  resumeSyncEngineAfterWebAudio() {
    if (!this.video) return;
    if (this.syncHost.engine) {
      this.syncHost.start();
      return;
    }
    this._startSyncEngine();
  }

  /**
   * @param {import("../shared/subtitles.js").SubtitleLine[]} lines
   * @param {{ start: number, end: number }[]} skipRanges
   * @param {number} mediaDurationSec
   */
  rebuild(lines, skipRanges, mediaDurationSec, opts = {}) {
    this.lines = lines || [];
    this.skipRanges = skipRanges || [];
    this.mediaDurationSec = Math.max(0, Number(mediaDurationSec) || 0);
    this.programMasterMode = !!opts.programMasterMode;
    const timelineClips = opts.timelineClips;

    this.mappingRevision += 1;
    if (Array.isArray(timelineClips) && timelineClips.length > 0) {
      this.mapping = {
        clips: timelineClips,
        mergedCuts: [],
        mediaEndHintSec: this.mediaDurationSec,
        programToMediaSec: (p) => mapProgramToMediaSec(p, timelineClips),
        mediaToProgramSec: (m) => mapMediaToProgramSec(m, timelineClips),
        programToMasterAudioSec: (p) => mapProgramToMediaSec(p, timelineClips),
        masterAudioToProgramSec: (m) => mapMediaToProgramSec(m, timelineClips),
        masterMode: "stitched",
      };
    } else {
      /** UI·칩·파형 = 미디어 축 항등. 재생 skip 은 skipRanges + skipCutRangeAt 로만 처리. */
      this.mapping = createTimelineMapping([], this.mediaDurationSec, {
        masterMode: "passthrough",
      });
    }
    this.router.setMappingRevision(this.mappingRevision, this.mappingRevision);

    this.wordBlocks = virtualBlocksForSyncEngine(this.lines, []);

    if (this.video && this.syncHost.engine) {
      this.syncHost.setBlocks(this.wordBlocks);
      if (opts.stitchedProgramMode || opts.timelineClips?.length) {
        this.syncHost.stop();
        this._startSyncEngine(opts);
      }
    } else if (this.video) {
      this._startSyncEngine(opts);
    }
  }

  _startSyncEngine(opts = {}) {
    if (!this.video) return;
    const stitched = !!opts.stitchedProgramMode || (this.mapping?.masterMode === "stitched");
    const blocks = playbackWordBlocks(this.wordBlocks);
    this.syncHost.attach(this.video, blocks, {
      jumpCutEnabled: !this.programMasterMode && !stitched,
      onTick: (ctx) => {
        if (this.isSeekingLocked) return;
        const mediaSec = ctx.realTimeMs / 1000;
        const editSec = (ctx.virtualTimeMs ?? 0) / 1000;
        this.editPlayheadSec = editSec;
        this._notifyPlayhead(editSec, mediaSec, ctx.virtualTimeMs);
      },
      onSeekSnap: (ctx) => {
        this._applySyncContext(ctx.realTimeMs, ctx.phase);
      },
    });
  }

  /**
   * @param {number} realMs
   * @param {'playing' | 'seeking'} [_phase]
   */
  _applySyncContext(realMs, _phase) {
    const mediaSec = realMs / 1000;
    const editSec = this.mapping
      ? this.mapping.mediaToProgramSec(mediaSec)
      : mediaSec;
    this.editPlayheadSec = editSec;
    const virtualMs = this.syncHost.engine?.mapRealToVirtualMs(realMs) ?? realMs;
    this._notifyPlayhead(editSec, mediaSec, virtualMs);
  }

  /**
   * @param {number} editSec
   * @param {number | null} mediaSec
   * @param {number} virtualMs
   */
  _notifyPlayhead(editSec, mediaSec, virtualMs) {
    this.onPlayheadChange?.({
      editSec,
      mediaSec: mediaSec ?? (this.video ? this.video.currentTime : 0),
      virtualMs,
    });
  }

  /**
   * 재생 루프 1프레임 — SyncEngine jump-cut + 클립 tail jump + 컷 스킵 폴백.
   * @returns {boolean} playhead changed
   */
  tickFrame() {
    if (!this.video || this.video.paused) return false;
    if (this.isSeekingLocked) return false;

    const before = this.video.currentTime;

    if (this.mapping?.clips?.length) {
      const jump = jumpVideoPastClipTailIfNeeded(before, this.mapping.clips);
      if (jump.jumped) {
        this.video.currentTime = jump.toMediaSec;
      }
    }

    if (this.skipRanges.length) {
      const skipped = skipCutRangeAt(this.video.currentTime, this.skipRanges);
      if (Math.abs(skipped - this.video.currentTime) > 0.001) {
        this.video.currentTime = skipped;
      }
    }

    const mediaSec = this.video.currentTime;
    const editSec = this.mapping ? this.mapping.mediaToProgramSec(mediaSec) : mediaSec;
    this.editPlayheadSec = editSec;
    const virtualMs =
      this.syncHost.engine?.mapRealToVirtualMs(Math.round(mediaSec * 1000)) ??
      Math.round(mediaSec * 1000);
    this._notifyPlayhead(editSec, mediaSec, virtualMs);
    return Math.abs(before - mediaSec) > 1e-6;
  }

  /**
   * @param {number} mediaSec
   * @param {'seek' | 'seekAndPlay'} [kind]
   */
  seekMediaSec(mediaSec, kind = "seek") {
    const decision = this.router.beginSeekLike(kind);
    if (!decision.allowed) return decision;
    this.seekUi?.seekRealSecImmediate(mediaSec);
    if (this.masterAudio?.src) {
      assignMasterAudioTimelineSecIfNeeded(this.masterAudio, mediaSec);
    }
    return decision;
  }

  /**
   * @param {number} editSec
   */
  seekEditSec(editSec) {
    if (!this.mapping) {
      this.seekMediaSec(editSec);
      return;
    }
    const media = this.mapping.programToMediaSec(editSec);
    this.seekMediaSec(skipCutRangeAt(media, this.skipRanges));
  }

  /**
   * @param {number} virtualMs
   */
  seekVirtualMs(virtualMs) {
    const realMs = this.syncHost.engine?.mapVirtualToRealMs(virtualMs);
    if (realMs != null) {
      this.seekUi?.seekRealSecImmediate(realMs / 1000);
    } else {
      this.syncHost.seekVirtualMs(virtualMs);
    }
  }

  /**
   * @param {number} startMediaSec
   * @param {number} endMediaSec
   */
  beginPlayRange(startMediaSec, endMediaSec) {
    return this.router.beginPlayRange(startMediaSec, endMediaSec);
  }

  finishPlayRange(sessionId) {
    this.router.finishRange(sessionId);
  }

  /**
   * @param {number} startMediaSec
   * @param {number | null} endMediaSec
   */
  buildScheduleSegments(startMediaSec, endMediaSec) {
    if (USE_WORD_BASED_PLAYBACK_SCHEDULE && this.lines.length) {
      return buildScheduledMediaSegmentsFromSubtitleWords(
        this.lines,
        startMediaSec,
        endMediaSec,
      );
    }
    return buildPassthroughSegmentsSkippingCuts(this.mediaDurationSec, this.skipRanges);
  }

  get mapEditToMediaSec() {
    return (editSec) =>
      this.mapping
        ? this.mapping.programToMediaSec(editSec)
        : editSec;
  }

  get mapMediaToEditSec() {
    return (mediaSec) =>
      this.mapping
        ? this.mapping.mediaToProgramSec(mediaSec)
        : mediaSec;
  }
}

/** @type {PlaybackOrchestrator | null} */
let sharedOrchestrator = null;

export function getPlaybackOrchestrator() {
  if (!sharedOrchestrator) sharedOrchestrator = new PlaybackOrchestrator();
  return sharedOrchestrator;
}
