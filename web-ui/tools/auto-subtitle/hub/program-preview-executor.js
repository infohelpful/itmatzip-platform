/**
 * ProgramClip-Driven Preview Executor (v5.2)
 * SSOT: programSec · clipPos · Policy A sequential queue.
 * Stage 1: source/list successor pass-through vs seek.
 * Stage 2: discontinuity crossfade via PreviewMediaBridge.
 */

import { skipCutRangeAt } from "../playback.js?v=28";
import { programToSource } from "../shared/program-clips-ssot.js";
import {
  classifyListOrderGapTransition,
  effectiveSourceEndForClip,
  listAndSourceSuccessorsMatch,
  passThroughEpsilonSec,
} from "../shared/clip-boundary-ssot.js?v=6";
import {
  atProgramBoundary,
  atProgramPlaybackBoundary,
  clipPosForProgramSec,
  programClipEnd,
  programClipPlaybackEnd,
  programClipStart,
  programSecFromAudioSlave,
  PROGRAM_BOUNDARY_EPS,
  shouldPassThroughClipTransition,
} from "../shared/program-clip-boundary-ssot.js";

const VIDEO_SYNC_EPS_SEC = 0.1;

/**
 * @typedef {'virtual' | 'baked'} ExecutorPlaybackMode
 *
 * @typedef {{
 *   programSec: number,
 *   clipPos: number,
 *   blockIndex: number,
 *   mode: ExecutorPlaybackMode,
 *   playing: boolean,
 *   inSilence: boolean,
 *   ended: boolean,
 * }} ExecutorTickResult
 */

export class ProgramPreviewExecutor {
  constructor() {
    this.reset();
  }

  reset() {
    /** @type {readonly import("../shared/timeline-mapping.js").TimelineClip[]} */
    this.clips = [];
    /** @type {readonly import("../shared/program-clips-ssot.js").ProgramClip[]} */
    this.programClips = [];
    this.clipPos = 0;
    this.programSec = 0;
    /** @type {ExecutorPlaybackMode} */
    this.mode = "virtual";
    this.playbackRate = 1;
    this.playing = false;
    this.armed = false;
    this.inSilence = false;
    this.silenceWallMs = 0;
    this.silenceProgramAnchor = 0;
    this.ended = false;
    /** @type {{ start: number, end: number }[]} */
    this.skipRanges = [];
    this.transitionInFlight = false;
    /** @type {number} */
    this.pendingClipPos = -1;
  }

  isArmed() {
    return this.armed && this.clips.length > 0;
  }

  isTransitionPending() {
    return this.transitionInFlight;
  }

  getClipPos() {
    return this.clipPos;
  }

  getProgramSec() {
    return this.programSec;
  }

  getMode() {
    return this.mode;
  }

  /**
   * @param {{
   *   clips: readonly import("../shared/timeline-mapping.js").TimelineClip[],
   *   programClips?: readonly import("../shared/program-clips-ssot.js").ProgramClip[],
   *   clipPos?: number,
   *   programSec?: number,
   *   mode?: ExecutorPlaybackMode,
   *   playbackRate?: number,
   *   skipRanges?: { start: number, end: number }[],
   * }} opts
   */
  arm(opts) {
    this.clips = opts.clips || [];
    this.programClips = opts.programClips || [];
    this.skipRanges = opts.skipRanges || [];
    this.mode = opts.mode === "baked" ? "baked" : "virtual";
    this.playbackRate = Math.max(0.25, Math.min(4, Number(opts.playbackRate) || 1));
    this.clipPos = Math.max(
      0,
      Math.min(Number(opts.clipPos) || 0, Math.max(0, this.clips.length - 1)),
    );
    this.programSec = Number.isFinite(Number(opts.programSec))
      ? Number(opts.programSec)
      : programClipStart(this.clips[this.clipPos]);
    this.inSilence = false;
    this.ended = false;
    this.playing = false;
    this.transitionInFlight = false;
    this.pendingClipPos = -1;
    this.armed = this.clips.length > 0;
    if (this.clips[this.clipPos]?.isSilence) {
      this.enterSilenceHold();
    }
    return this.snapshot();
  }

  /**
   * @param {number} programSec
   * @param {{ audio?: HTMLMediaElement | null, video?: HTMLMediaElement | null }} [media]
   */
  seekProgramSec(programSec, media = {}) {
    const dur =
      this.clips.length > 0
        ? programClipEnd(this.clips[this.clips.length - 1])
        : 0;
    this.programSec = Math.max(0, Math.min(Number(programSec) || 0, dur));
    this.clipPos = clipPosForProgramSec(this.programSec, this.clips);
    this.ended = false;
    this.transitionInFlight = false;
    this.pendingClipPos = -1;
    const clip = this.clips[this.clipPos];
    if (!clip) return this.snapshot();

    if (clip.isSilence) {
      this.enterSilenceHold();
      this.programSec = Math.min(
        this.programSec,
        programClipEnd(clip) - PROGRAM_BOUNDARY_EPS,
      );
      return this.snapshot();
    }

    this.exitSilenceHold();
    if (this.mode === "baked") {
      const t = this.programSec;
      if (media.audio) {
        media.audio.playbackRate = this.playbackRate;
        media.audio.currentTime = t;
      }
      if (media.video) {
        media.video.playbackRate = this.playbackRate;
        media.video.currentTime = t;
      }
      return this.snapshot();
    }

    const sourceSec = this.programClips.length
      ? programToSource(this.programClips, this.programSec)
      : clip.mediaStart;
    const target = skipCutRangeAt(sourceSec, this.skipRanges);
    if (media.audio) {
      media.audio.playbackRate = this.playbackRate;
      media.audio.currentTime = target;
    }
    if (media.video) {
      media.video.playbackRate = this.playbackRate;
      media.video.currentTime = target;
    }
    this.programSec = programSecFromAudioSlave(clip, target);
    return this.snapshot();
  }

  play() {
    this.playing = true;
    this.ended = false;
    if (this.inSilence) {
      this.silenceWallMs = performance.now();
      this.silenceProgramAnchor = this.programSec;
    }
  }

  pause() {
    this.playing = false;
  }

  /**
   * @param {string} blockId
   * @param {number} programSec
   * @param {{ audio?: HTMLMediaElement | null, video?: HTMLMediaElement | null }} [media]
   */
  rearm(blockId, programSec, media = {}) {
    if (!this.clips.length) return this.snapshot();
    let clipPos = this.clipPos;
    if (blockId) {
      const id = String(blockId);
      const byPc = this.programClips.findIndex((c) => String(c.id) === id);
      if (byPc >= 0) {
        clipPos = byPc;
      } else {
        const byClip = this.clips.findIndex(
          (c) => String(c.blockId) === id || String(c.id) === id,
        );
        if (byClip >= 0) clipPos = byClip;
      }
    }
    this.clipPos = clipPos;
    return this.seekProgramSec(
      Number.isFinite(programSec) ? programSec : programClipStart(this.clips[clipPos]),
      media,
    );
  }

  /**
   * @param {import("../shared/timeline-mapping.js").TimelineClip} cur
   * @param {import("../shared/timeline-mapping.js").TimelineClip} next
   * @param {number} curPos
   * @param {number} nextPos
   */
  classifyTransition(cur, next, curPos, nextPos) {
    return classifyListOrderGapTransition({
      cur,
      next,
      clips: this.clips,
      curPos,
      nextPos,
      skipRanges: this.skipRanges,
    });
  }

  /**
   * @param {{
   *   audio?: HTMLMediaElement | null,
   *   video?: HTMLMediaElement | null,
   *   wallMs?: number,
   *   bridge?: { startExecutorCrossfade?: (opts: unknown) => Promise<void>, isTransitionLocked?: () => boolean } | null,
   * }} ctx
   * @returns {ExecutorTickResult}
   */
  tick(ctx = {}) {
    if (!this.armed) {
      return this.snapshot();
    }
    const audio = ctx.audio ?? null;
    const video = ctx.video ?? null;
    const bridge = ctx.bridge ?? null;
    const wallMs = Number.isFinite(ctx.wallMs) ? ctx.wallMs : performance.now();

    if (!this.playing) {
      return this.snapshot();
    }

    if (this.transitionInFlight || bridge?.isTransitionLocked?.()) {
      return this.snapshot();
    }

    if (this.mode === "baked" && audio) {
      this.programSec = Math.max(0, audio.currentTime);
      this.clipPos = clipPosForProgramSec(this.programSec, this.clips);
      const last = this.clips[this.clips.length - 1];
      if (last && this.programSec >= programClipEnd(last) - PROGRAM_BOUNDARY_EPS) {
        this.ended = true;
        this.playing = false;
      }
      return this.snapshot();
    }

    const clip = this.clips[this.clipPos];
    if (!clip) return this.snapshot();

    if (clip.isSilence || this.inSilence) {
      return this.tickSilence(clip, wallMs, audio, video, bridge);
    }

    if (!audio) return this.snapshot();

    if (audio.seeking) {
      return this.snapshot();
    }

    if (audio.playbackRate !== this.playbackRate) {
      audio.playbackRate = this.playbackRate;
    }
    if (video && video.playbackRate !== this.playbackRate) {
      video.playbackRate = this.playbackRate;
    }

    const mediaSec = Math.max(0, audio.currentTime);
    const effEnd = effectiveSourceEndForClip(clip);
    const eps = passThroughEpsilonSec();
    const curPos = this.clipPos;
    const nextPos = curPos + 1;
    const nextClip = this.clips[nextPos];

    if (mediaSec > effEnd + eps) {
      if (!nextClip) {
        return this.finishClipAtSourceEnd(clip, effEnd, audio, video);
      }
      return this.advanceToNextClip(audio, video, bridge);
    }

    this.programSec = programSecFromAudioSlave(clip, mediaSec);

    if (nextClip && !nextClip.isSilence && !clip.isSilence) {
      const cls = this.classifyTransition(clip, nextClip, curPos, nextPos);
      const successorsMatch = listAndSourceSuccessorsMatch(
        clip,
        nextClip,
        this.clips,
        curPos,
        nextPos,
      );
      const nextStart = Number(nextClip.mediaStart) || 0;
      const interGap = nextStart - effEnd;
      if (
        successorsMatch &&
        cls.kind === "natural" &&
        interGap > eps &&
        mediaSec >= effEnd - PROGRAM_BOUNDARY_EPS &&
        mediaSec < nextStart - eps
      ) {
        this.programSec = programClipPlaybackEnd(clip);
        this.syncVideoSlave(video, { suppressSeek: true });
        return this.snapshot();
      }
    }

    if (atProgramPlaybackBoundary(this.programSec, clip)) {
      return this.advanceToNextClip(audio, video, bridge);
    }

    this.syncVideoSlave(video);
    return this.snapshot();
  }

  /**
   * @param {import("../shared/timeline-mapping.js").TimelineClip} clip
   * @param {number} wallMs
   * @param {HTMLMediaElement | null} audio
   * @param {HTMLMediaElement | null} video
   * @param {{ startExecutorCrossfade?: (opts: unknown) => Promise<void> } | null} bridge
   */
  tickSilence(clip, wallMs, audio, video, bridge) {
    void bridge;
    if (!this.inSilence) {
      this.enterSilenceHold();
    }
    if (audio && !audio.paused) audio.pause();
    if (video && !video.paused) video.pause();

    const elapsed = ((wallMs - this.silenceWallMs) / 1000) * this.playbackRate;
    const end = programClipEnd(clip);
    this.programSec = Math.min(this.silenceProgramAnchor + elapsed, end);

    if (!atProgramBoundary(this.programSec, clip)) {
      return this.snapshot();
    }

    return this.advanceToNextClip(audio, video, bridge);
  }

  enterSilenceHold() {
    const clip = this.clips[this.clipPos];
    if (!clip) return;
    this.inSilence = true;
    this.silenceWallMs = performance.now();
    this.silenceProgramAnchor = programClipStart(clip);
    if (this.programSec < this.silenceProgramAnchor) {
      this.programSec = this.silenceProgramAnchor;
    }
  }

  exitSilenceHold() {
    this.inSilence = false;
    this.silenceWallMs = 0;
    this.silenceProgramAnchor = 0;
  }

  /**
   * @param {HTMLMediaElement | null} audio
   * @param {HTMLMediaElement | null} video
   * @param {{ startExecutorCrossfade?: (opts: unknown) => Promise<void> } | null} [bridge]
   */
  advanceToNextClip(audio, video, bridge = null) {
    const curPos = this.clipPos;
    const cur = this.clips[curPos];
    const nextPos = curPos + 1;
    if (nextPos >= this.clips.length) {
      this.ended = true;
      this.playing = false;
      this.exitSilenceHold();
      if (audio) audio.pause();
      if (video) video.pause();
      if (cur) this.programSec = programClipEnd(cur);
      return this.snapshot();
    }

    const next = this.clips[nextPos];

    if (next.isSilence) {
      this.clipPos = nextPos;
      this.exitSilenceHold();
      this.programSec = programClipStart(next);
      this.enterSilenceHold();
      if (audio) audio.pause();
      if (video) video.pause();
      return this.snapshot();
    }

    const sourceSec = this.programClips.length
      ? programToSource(this.programClips, programClipStart(next))
      : next.mediaStart;
    const target = skipCutRangeAt(sourceSec, this.skipRanges);
    const mediaNow = Math.max(0, Number(audio?.currentTime) || target);
    const cls = cur
      ? this.classifyTransition(cur, next, curPos, nextPos)
      : null;
    const passThrough = shouldPassThroughClipTransition(
      cur,
      next,
      mediaNow,
      target,
      cls,
    );

    if (passThrough) {
      this.clipPos = nextPos;
      this.exitSilenceHold();
      if (audio) {
        audio.playbackRate = this.playbackRate;
        this.programSec = programSecFromAudioSlave(next, mediaNow);
      }
      if (video) {
        video.playbackRate = this.playbackRate;
        this.syncVideoSlave(video, { suppressSeek: false });
      }
      if (this.playing && audio?.paused) {
        void audio.play().catch(() => undefined);
      }
      if (this.playing && video?.paused) {
        void video.play().catch(() => undefined);
      }
      return this.snapshot();
    }

    const eps = passThroughEpsilonSec();
    if (Math.abs(mediaNow - target) <= eps + 0.01) {
      this.applySyncSeekToNext(audio, video, next, nextPos, target);
      return this.snapshot();
    }

    if (bridge?.startExecutorCrossfade && !this.transitionInFlight) {
      this.transitionInFlight = true;
      this.pendingClipPos = nextPos;
      void bridge.startExecutorCrossfade({
        targetMediaSec: target,
        onComplete: () => {
          this.transitionInFlight = false;
          this.pendingClipPos = -1;
          this.clipPos = nextPos;
          this.exitSilenceHold();
          this.programSec = programSecFromAudioSlave(next, target);
        },
        onError: () => {
          this.applySyncSeekToNext(audio, video, next, nextPos, target);
        },
      });
      return this.snapshot();
    }

    this.applySyncSeekToNext(audio, video, next, nextPos, target);
    return this.snapshot();
  }

  /**
   * @param {HTMLMediaElement | null} audio
   * @param {HTMLMediaElement | null} video
   * @param {import("../shared/timeline-mapping.js").TimelineClip} next
   * @param {number} nextPos
   * @param {number} target
   */
  applySyncSeekToNext(audio, video, next, nextPos, target) {
    this.clipPos = nextPos;
    this.exitSilenceHold();
    this.transitionInFlight = false;
    this.pendingClipPos = -1;
    if (audio) {
      audio.playbackRate = this.playbackRate;
      audio.currentTime = target;
      this.programSec = programSecFromAudioSlave(next, target);
    }
    if (video) {
      video.playbackRate = this.playbackRate;
      if (Math.abs(video.currentTime - target) > VIDEO_SYNC_EPS_SEC) {
        video.currentTime = target;
      }
    }
    if (this.playing && audio?.paused) {
      void audio.play().catch(() => undefined);
    }
    if (this.playing && video?.paused) {
      void video.play().catch(() => undefined);
    }
  }

  /**
   * @param {import("../shared/timeline-mapping.js").TimelineClip} clip
   * @param {number} effEnd
   * @param {HTMLMediaElement | null} audio
   * @param {HTMLMediaElement | null} video
   */
  finishClipAtSourceEnd(clip, effEnd, audio, video) {
    const clamp = skipCutRangeAt(effEnd, this.skipRanges);
    if (audio && Math.abs(audio.currentTime - clamp) > passThroughEpsilonSec()) {
      audio.currentTime = clamp;
    }
    if (video && Math.abs(video.currentTime - clamp) > VIDEO_SYNC_EPS_SEC) {
      video.currentTime = clamp;
    }
    this.programSec = programClipPlaybackEnd(clip);
    this.ended = true;
    this.playing = false;
    this.exitSilenceHold();
    if (audio) audio.pause();
    if (video) video.pause();
    return this.snapshot();
  }

  /**
   * @param {HTMLMediaElement | null} video
   * @param {{ suppressSeek?: boolean }} [opts]
   */
  syncVideoSlave(video, opts = {}) {
    if (!video || this.mode === "baked" || !this.programClips.length) return;
    if (opts.suppressSeek) return;
    const target = programToSource(this.programClips, this.programSec);
    if (!Number.isFinite(target)) return;
    if (Math.abs(video.currentTime - target) > VIDEO_SYNC_EPS_SEC) {
      video.currentTime = target;
    }
  }

  /** @returns {ExecutorTickResult} */
  snapshot() {
    const clip = this.clips[this.clipPos];
    const blockIndex =
      clip && Number.isInteger(clip.blockIndex) ? clip.blockIndex : this.clipPos;
    return {
      programSec: this.programSec,
      clipPos: this.clipPos,
      blockIndex,
      mode: this.mode,
      playing: this.playing,
      inSilence: this.inSilence,
      ended: this.ended,
    };
  }
}

/** @type {ProgramPreviewExecutor | null} */
let sharedExecutor = null;

export function getProgramPreviewExecutor() {
  if (!sharedExecutor) sharedExecutor = new ProgramPreviewExecutor();
  return sharedExecutor;
}

export function isProgramPreviewExecutorActive() {
  return sharedExecutor?.isArmed() === true;
}

export function disarmProgramPreviewExecutor() {
  sharedExecutor?.reset();
}
