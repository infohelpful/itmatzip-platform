/**
 * ProgramClip-Driven Preview Executor (v5.1)
 * SSOT: programSec · clipPos · Policy A sequential queue.
 */

import { skipCutRangeAt } from "../playback.js?v=28";
import { programToSource } from "../shared/program-clips-ssot.js";
import {
  atProgramBoundary,
  clipPosForProgramSec,
  programClipDuration,
  programClipEnd,
  programClipStart,
  programSecFromAudioSlave,
  PROGRAM_BOUNDARY_EPS,
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
  }

  isArmed() {
    return this.armed && this.clips.length > 0;
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
   * @param {{
   *   audio?: HTMLMediaElement | null,
   *   video?: HTMLMediaElement | null,
   *   wallMs?: number,
   * }} ctx
   * @returns {ExecutorTickResult}
   */
  tick(ctx = {}) {
    if (!this.armed) {
      return this.snapshot();
    }
    const audio = ctx.audio ?? null;
    const video = ctx.video ?? null;
    const wallMs = Number.isFinite(ctx.wallMs) ? ctx.wallMs : performance.now();

    if (!this.playing) {
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
      return this.tickSilence(clip, wallMs, audio, video);
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

    this.programSec = programSecFromAudioSlave(clip, audio.currentTime);

    if (atProgramBoundary(this.programSec, clip)) {
      return this.advanceToNextClip(audio, video);
    }

    this.syncVideoSlave(video);
    return this.snapshot();
  }

  /**
   * @param {import("../shared/timeline-mapping.js").TimelineClip} clip
   * @param {number} wallMs
   * @param {HTMLMediaElement | null} audio
   * @param {HTMLMediaElement | null} video
   */
  tickSilence(clip, wallMs, audio, video) {
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

    return this.advanceToNextClip(audio, video);
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
   */
  advanceToNextClip(audio, video) {
    const nextPos = this.clipPos + 1;
    if (nextPos >= this.clips.length) {
      this.ended = true;
      this.playing = false;
      this.exitSilenceHold();
      if (audio) audio.pause();
      if (video) video.pause();
      const cur = this.clips[this.clipPos];
      if (cur) this.programSec = programClipEnd(cur);
      return this.snapshot();
    }

    this.clipPos = nextPos;
    this.exitSilenceHold();
    const next = this.clips[nextPos];

    if (next.isSilence) {
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

    if (audio) {
      audio.playbackRate = this.playbackRate;
      audio.currentTime = target;
      this.programSec = programSecFromAudioSlave(next, target);
    }
    if (video) {
      video.playbackRate = this.playbackRate;
      video.currentTime = target;
    }

    if (this.playing && audio?.paused) {
      void audio.play().catch(() => undefined);
    }
    if (this.playing && video?.paused) {
      void video.play().catch(() => undefined);
    }

    return this.snapshot();
  }

  /** @param {HTMLMediaElement | null} video */
  syncVideoSlave(video) {
    if (!video || this.mode === "baked" || !this.programClips.length) return;
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
