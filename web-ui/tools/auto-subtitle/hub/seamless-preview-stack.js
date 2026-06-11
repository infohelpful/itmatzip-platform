/**
 * Vrew 스타일 — 비디오 더블 버퍼 + 듀얼 오디오 Web Audio.
 * v3.2 — micro-envelope (2–5ms pop guard, not overlap blend).
 */

import { skipCutRangeAt } from "../playback.js?v=28";
import { seekWithNudge } from "./html-audio-master-playback.js?v=4";
import { isSourceVideoPtsTimeline } from "../shared/media-timing-ssot.js?v=7";
import {
  DELETED_WORD_MEDIA_GAP_SEC,
  classifyListOrderGapTransition,
  effectiveSourceEndForClip,
  interClipEffectiveGap,
  passThroughEpsilonSec,
} from "../shared/clip-boundary-ssot.js?v=6";

const HAVE_FUTURE = HTMLMediaElement.HAVE_FUTURE_DATA;
const PREFETCH_LEAD_MIN_SEC = 0.28;
const PREFETCH_LEAD_MAX_SEC = 1.6;
const PREFETCH_LEAD_RATIO = 0.2;
const LIST_CLIP_END_EPS_SEC = 0.001;
const AUDIO_SKIP_MIN_MS = 90;
/** Dialogue 편집 pop 방지용 — overlap blend 아님 (2–5ms) */
const ENVELOPE_FADE_SEC = 0.003;
const ENVELOPE_FADE_MIN_SEC = 0.002;
const ENVELOPE_FADE_MAX_SEC = 0.005;
/** 미리보기 discontinuity envelope — 기본 OFF (pass-through·in-place seek로 충분) */
let previewCrossfadeEnabled = false;

/** @returns {boolean} */
export function isPreviewCrossfadeEnabled() {
  return previewCrossfadeEnabled;
}

/** @param {boolean} enabled */
export function setPreviewCrossfadeEnabled(enabled) {
  previewCrossfadeEnabled = Boolean(enabled);
}

const VIDEO_SYNC_PASS_THROUGH_EPS_SEC = 0.12;
const TRANSITION_IDLE_POLL_MS = 16;
const TRANSITION_IDLE_MAX_MS = 2400;

/**
 * @param {{
 *   cur: import("../shared/timeline-mapping.js").TimelineClip,
 *   next: import("../shared/timeline-mapping.js").TimelineClip,
 *   clips: import("../shared/timeline-mapping.js").TimelineClip[],
 *   curPos: number,
 *   nextPos: number,
 *   skipRanges: { start: number, end: number }[],
 * }} ctx
 */
function classifyListOrderGap(ctx) {
  return classifyListOrderGapTransition({
    cur: ctx.cur,
    next: ctx.next,
    clips: ctx.clips,
    curPos: ctx.curPos,
    nextPos: ctx.nextPos,
    skipRanges: ctx.skipRanges,
  });
}

/** @param {import("../shared/clip-boundary-ssot.js").GapTransitionClassification} cls */
function listOrderGapAllowsPassThrough(cur, next, clips, curPos, nextPos, skip) {
  return (
    classifyListOrderGap({ cur, next, clips, curPos, nextPos, skipRanges: skip }).kind ===
    "continuous"
  );
}

function delayMs(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** @param {number} [durationSec] */
function clampEnvelopeFadeSec(durationSec = ENVELOPE_FADE_SEC) {
  return Math.max(
    ENVELOPE_FADE_MIN_SEC,
    Math.min(ENVELOPE_FADE_MAX_SEC, Number(durationSec) || ENVELOPE_FADE_SEC),
  );
}

/** @param {number} durationSec */
function envelopeFadeWaitMs(durationSec) {
  return Math.ceil(clampEnvelopeFadeSec(durationSec) * 1000) + 3;
}

/** Web Audio MediaElementSource — crossOrigin 없으면 CORS 제한으로 무음(zeroes) */
export function applyPreviewMediaCors(el) {
  if (!el || el.crossOrigin === "anonymous") return;
  const src = el.currentSrc || el.src || "";
  el.crossOrigin = "anonymous";
  if (src) {
    el.src = src;
    try {
      el.load();
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {HTMLMediaElement} el
 * @param {string} url
 */
export function assignPreviewMediaSrc(el, url) {
  if (!el || !url) return;
  applyPreviewMediaCors(el);
  if (el.src !== url) {
    el.src = url;
    el.preload = "auto";
    try {
      el.load();
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {HTMLMediaElement} el
 * @param {number} timeoutMs
 */
function waitMediaReady(el, timeoutMs = 2800) {
  return new Promise((resolve) => {
    if (el.readyState >= HAVE_FUTURE) {
      resolve(true);
      return;
    }
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    const onReady = () => finish(true);
    el.addEventListener("canplay", onReady, { once: true });
    el.addEventListener("loadeddata", onReady, { once: true });
    window.setTimeout(
      () => finish(el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA),
      timeoutMs,
    );
  });
}

/**
 * @param {HTMLMediaElement} el
 * @param {number} targetVolume
 * @param {number} durationSec
 */
function rampElementVolume(el, targetVolume, durationSec) {
  const from = el.volume;
  const start = performance.now();
  const ms = Math.max(8, durationSec * 1000);
  return new Promise((resolve) => {
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / ms);
      el.volume = from + (targetVolume - from) * t;
      if (t < 1) requestAnimationFrame(step);
      else resolve(undefined);
    };
    requestAnimationFrame(step);
  });
}

export class SeamlessPreviewStack {
  /**
   * @param {{
   *   frame: HTMLElement,
   *   videoA: HTMLVideoElement,
   *   videoB: HTMLVideoElement,
   *   audioA: HTMLAudioElement,
   *   audioB: HTMLAudioElement,
   * }} els
   */
  constructor(els) {
    this.frame = els.frame;
    this.videoA = els.videoA;
    this.videoB = els.videoB;
    this.audioA = els.audioA;
    this.audioB = els.audioB;
    this.active = 0;
    this.mediaUrl = "";
    this.graphReady = false;
    this.graphFailed = false;
    /** @type {AudioContext | null} */
    this.audioCtx = null;
    /** @type {GainNode | null} */
    this.gainA = null;
    /** @type {GainNode | null} */
    this.gainB = null;
    this.listMode = false;
    /** @type {import("../shared/timeline-mapping.js").TimelineClip[]} */
    this.clips = [];
    this.clipPos = 0;
    this.committedClipPos = 0;
    this.pendingClipPos = -1;
    this.prefetchClipPos = -1;
    this.idlePrepared = false;
    this.switchInFlight = false;
    this._transitionGen = 0;
    /** @type {{ start: number, end: number }[]} */
    this.skipRanges = [];
    this.lastAudioSkipWallMs = 0;
    this.silenceHoldActive = false;
    this.silenceWallStartMs = 0;
    this.silenceFreezeMediaSec = 0;
    this.silenceClipPos = -1;
    /** @type {number | null} */
    this.virtualProgramSec = null;
    /** @type {(() => void) | null} */
    this.onLayerSwapped = null;
    this._passThroughVideoSync = false;

    this.videoA.classList.add("is-layer-active");
    this.videoB.classList.remove("is-layer-active");
    this.videoA.muted = true;
    this.videoB.muted = true;
    this.audioA.muted = false;
    this.audioB.muted = false;
    for (const el of [this.videoA, this.videoB, this.audioA, this.audioB]) {
      applyPreviewMediaCors(el);
    }
  }

  get activeVideo() {
    return this.active === 0 ? this.videoA : this.videoB;
  }

  get idleVideo() {
    return this.active === 0 ? this.videoB : this.videoA;
  }

  get audibleAudio() {
    return this.active === 0 ? this.audioA : this.audioB;
  }

  get idleAudio() {
    return this.active === 0 ? this.audioB : this.audioA;
  }

  get primaryVideo() {
    return this.videoA;
  }

  get primaryAudio() {
    return this.audioA;
  }

  isTransitionLocked() {
    return this.switchInFlight;
  }

  getCommittedClipPos() {
    return this.committedClipPos;
  }

  getPendingClipPos() {
    return this.pendingClipPos;
  }

  /**
   * @param {number} pos
   */
  commitClipPos(pos) {
    const p = Math.max(0, Math.min(pos, Math.max(0, this.clips.length - 1)));
    this.clipPos = p;
    this.committedClipPos = p;
    this.pendingClipPos = -1;
  }

  /** Hot reorder — prefetch/pending flush 후 committed clipPos 고정 */
  sealHotReorderStack(clipPos) {
    this.prefetchClipPos = -1;
    this.pendingClipPos = -1;
    this.idlePrepared = false;
    this._passThroughVideoSync = false;
    if (this.listMode && this.clips.length) {
      this.commitClipPos(clipPos);
    }
  }

  abortActiveTransition() {
    this._transitionGen += 1;
    this.pendingClipPos = -1;
    this.switchInFlight = false;
    this.prefetchClipPos = -1;
    this.idlePrepared = false;
    this._passThroughVideoSync = false;
    this.normalizeAudioElementVolumes();
    this.silenceIdleAudioGain();
    this.idleVideo.pause();
    this.idleAudio.pause();
  }

  async waitTransitionIdle(maxMs = TRANSITION_IDLE_MAX_MS) {
    const start = performance.now();
    while (this.switchInFlight && performance.now() - start < maxMs) {
      await delayMs(TRANSITION_IDLE_POLL_MS);
    }
  }

  /**
   * @param {Record<string, unknown>} [extra]
   */
  makeTickResult(extra = {}) {
    return {
      ok: true,
      clipPos: this.committedClipPos,
      committedClipPos: this.committedClipPos,
      pendingClipPos: this.pendingClipPos,
      passThrough: false,
      realDiscontinuity: false,
      lockedInFlight: this.switchInFlight,
      effectiveGap: null,
      ...extra,
    };
  }

  async ensureAudioGraph() {
    if (this.graphReady) return true;
    if (this.graphFailed) return false;
    try {
      for (const el of [this.audioA, this.audioB]) {
        applyPreviewMediaCors(el);
        if (el.src && el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          await waitMediaReady(el, 1200);
        }
      }
      this.audioCtx = new AudioContext();
      this.gainA = this.audioCtx.createGain();
      this.gainB = this.audioCtx.createGain();
      const srcA = this.audioCtx.createMediaElementSource(this.audioA);
      const srcB = this.audioCtx.createMediaElementSource(this.audioB);
      srcA.connect(this.gainA).connect(this.audioCtx.destination);
      srcB.connect(this.gainB).connect(this.audioCtx.destination);
      this.setGainLevels(1, 0);
      this.graphReady = true;
      return true;
    } catch (err) {
      console.warn("[seamless-preview] Web Audio graph init failed", err);
      this.graphFailed = true;
      return false;
    }
  }

  async unlockAudioOutput() {
    for (const el of [this.videoA, this.videoB, this.audioA, this.audioB]) {
      applyPreviewMediaCors(el);
    }
    const ok = await this.ensureAudioGraph();
    if (!ok || !this.audioCtx) return false;
    if (this.audioCtx.state === "suspended") {
      try {
        await this.audioCtx.resume();
      } catch {
        return false;
      }
    }
    return this.audioCtx.state === "running";
  }

  /**
   * @param {number} a
   * @param {number} b
   */
  setGainLevels(a, b) {
    if (this.gainA) this.gainA.gain.value = a;
    if (this.gainB) this.gainB.gain.value = b;
  }

  normalizeAudioElementVolumes() {
    this.audioA.volume = 1;
    this.audioB.volume = 1;
  }

  async setMediaUrl(url) {
    this.mediaUrl = url;
    for (const el of [this.videoA, this.videoB, this.audioA, this.audioB]) {
      assignPreviewMediaSrc(el, url);
    }
  }

  clearMedia() {
    this.mediaUrl = "";
    this.endListOrderPlayback();
    this.pauseAllMedia();
    for (const el of [this.videoA, this.videoB, this.audioA, this.audioB]) {
      el.removeAttribute("src");
      try {
        el.load();
      } catch {
        /* ignore */
      }
    }
    this.setGainLevels(1, 0);
  }

  pauseAllMedia() {
    for (const el of [this.videoA, this.videoB, this.audioA, this.audioB]) {
      el.pause();
    }
  }

  applyLayerVisibility() {
    this.videoA.classList.toggle("is-layer-active", this.active === 0);
    this.videoB.classList.toggle("is-layer-active", this.active === 1);
  }

  /**
   * @param {{
   *   clips: import("../shared/timeline-mapping.js").TimelineClip[],
   *   clipPos: number,
   *   skipRanges: { start: number, end: number }[],
   *   startMediaSec: number,
   *   useEnvelope?: boolean,
   * }} opts
   */
  async beginListOrderPlayback(opts) {
    await this.waitTransitionIdle();
    this.abortActiveTransition();
    await this.unlockAudioOutput();
    this.listMode = true;
    this.clips = opts.clips;
    const pos = Math.max(0, Math.min(opts.clipPos, opts.clips.length - 1));
    this.commitClipPos(pos);
    this.skipRanges = opts.skipRanges || [];
    this.prefetchClipPos = -1;
    this.idlePrepared = false;
    this.active = 0;
    this.setGainLevels(1, 0);

    const start = skipCutRangeAt(Math.max(0, opts.startMediaSec), this.skipRanges);
    if (opts.useEnvelope === true) {
      await this.runEnvelopeSeek(async () => {
        await this.seekLayerPairCore(this.activeVideo, this.audibleAudio, start);
      });
    } else {
      await this.seekLayerPairCore(this.activeVideo, this.audibleAudio, start);
    }
    this.applyLayerVisibility();
    this.idleVideo.pause();
    this.idleAudio.pause();
    this.normalizeAudioElementVolumes();
    this.silenceIdleAudioGain();
  }

  endListOrderPlayback() {
    this.exitSilenceHold();
    this.listMode = false;
    this.clips = [];
    this.commitClipPos(0);
    this.prefetchClipPos = -1;
    this.idlePrepared = false;
    this.abortActiveTransition();
    this.active = 0;
    this.setGainLevels(1, 0);
    this.audioA.volume = 1;
    this.audioB.volume = 1;
    this.videoA.pause();
    this.videoB.pause();
    this.audioA.pause();
    this.audioB.pause();
    this.applyLayerVisibility();
  }

  isListOrderMode() {
    return this.listMode && this.clips.length > 0;
  }

  getClipPos() {
    return this.committedClipPos;
  }

  getMasterPlayheadSec() {
    const audio = this.audibleAudio;
    if (
      audio &&
      !audio.paused &&
      audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      let t = audio.currentTime;
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        t = Math.min(t, Math.max(0, audio.duration - 0.001));
      }
      return t;
    }
    const video = this.activeVideo;
    if (video && !video.paused && Number.isFinite(video.currentTime)) {
      return video.currentTime;
    }
    if (audio && Number.isFinite(audio.currentTime)) {
      return audio.currentTime;
    }
    if (video && Number.isFinite(video.currentTime)) {
      return video.currentTime;
    }
    return null;
  }

  getAudibleMediaSec() {
    const audio = this.audibleAudio;
    if (!audio || audio.paused) return null;
    return this.getMasterPlayheadSec();
  }

  isAudioGraphActive() {
    return this.graphReady && !this.graphFailed;
  }

  /**
   * @param {HTMLVideoElement} video
   * @param {HTMLAudioElement} audio
   * @param {number} mediaSec
   */
  seekLayerPairCore(video, audio, mediaSec) {
    const t = Math.max(0, mediaSec);
    return new Promise((resolve) => {
      let pending = 0;
      const done = () => {
        pending -= 1;
        if (pending <= 0) resolve(undefined);
      };
      if (Math.abs(audio.currentTime - t) > 0.003) {
        pending += 1;
        seekWithNudge(audio, t, done);
      }
      if (Math.abs(video.currentTime - t) > 0.04) {
        pending += 1;
        seekWithNudge(video, t, done);
      }
      if (pending === 0) resolve(undefined);
      window.setTimeout(resolve, 480);
    });
  }

  async fadeActiveGainOut(durationSec = ENVELOPE_FADE_SEC) {
    await this.unlockAudioOutput();
    const audio = this.audibleAudio;
    if (!isPreviewCrossfadeEnabled()) {
      if (this.graphReady && this.audioCtx && this.gainA && this.gainB) {
        const g = this.active === 0 ? this.gainA : this.gainB;
        const t0 = this.audioCtx.currentTime;
        g.gain.cancelScheduledValues(t0);
        g.gain.setValueAtTime(0, t0);
      } else if (audio) {
        audio.volume = 0;
      }
      return;
    }
    const fadeSec = clampEnvelopeFadeSec(durationSec);
    if (this.graphReady && this.audioCtx && this.gainA && this.gainB) {
      const g = this.active === 0 ? this.gainA : this.gainB;
      const t0 = this.audioCtx.currentTime;
      g.gain.cancelScheduledValues(t0);
      g.gain.setValueAtTime(g.gain.value, t0);
      g.gain.linearRampToValueAtTime(0, t0 + fadeSec);
      await delayMs(envelopeFadeWaitMs(fadeSec));
    } else if (audio) {
      await rampElementVolume(audio, 0, fadeSec);
    }
  }

  async fadeActiveGainIn(durationSec = ENVELOPE_FADE_SEC) {
    await this.unlockAudioOutput();
    const audio = this.audibleAudio;
    if (!isPreviewCrossfadeEnabled()) {
      this.normalizeAudioElementVolumes();
      if (this.graphReady && this.audioCtx && this.gainA && this.gainB) {
        const g = this.active === 0 ? this.gainA : this.gainB;
        const t0 = this.audioCtx.currentTime;
        g.gain.cancelScheduledValues(t0);
        g.gain.setValueAtTime(1, t0);
      } else if (audio) {
        audio.volume = 1;
      }
      this.silenceIdleAudioGain();
      return;
    }
    const fadeSec = clampEnvelopeFadeSec(durationSec);
    if (this.graphReady && this.audioCtx && this.gainA && this.gainB) {
      const g = this.active === 0 ? this.gainA : this.gainB;
      const t0 = this.audioCtx.currentTime;
      g.gain.cancelScheduledValues(t0);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(1, t0 + fadeSec);
      await delayMs(envelopeFadeWaitMs(fadeSec));
    } else if (audio) {
      this.normalizeAudioElementVolumes();
      await rampElementVolume(audio, 1, fadeSec);
    }
  }

  /**
   * @param {() => Promise<void>} seekFn
   */
  async runEnvelopeSeek(seekFn) {
    const gen = this._transitionGen;
    this.switchInFlight = true;
    try {
      if (!isPreviewCrossfadeEnabled()) {
        await seekFn();
        return;
      }
      await this.fadeActiveGainOut();
      if (gen !== this._transitionGen) return;
      await seekFn();
      if (gen !== this._transitionGen) return;
      await this.fadeActiveGainIn();
    } finally {
      if (gen === this._transitionGen) {
        this.switchInFlight = false;
      }
    }
  }

  /**
   * @param {number} nextClipPos
   * @param {() => Promise<void>} runner
   */
  startCrossfadeTransition(nextClipPos, runner) {
    if (this.switchInFlight) return;
    this.switchInFlight = true;
    this.pendingClipPos = nextClipPos;
    this._passThroughVideoSync = false;
    const gen = ++this._transitionGen;
    this.prefetchClipPos = -1;
    this.idlePrepared = false;

    void (async () => {
      try {
        await runner();
        if (gen !== this._transitionGen) return;
        this.commitClipPos(nextClipPos);
        this.onLayerSwapped?.();
      } catch (err) {
        console.warn("[seamless-preview] crossfade transition failed", err);
      } finally {
        if (gen === this._transitionGen) {
          this.pendingClipPos = -1;
          this.switchInFlight = false;
        }
      }
    })();
  }

  /**
   * @param {number} nextClipPos
   * @param {() => Promise<void>} runner
   */
  startDiscontinuityTransition(nextClipPos, runner) {
    if (this.switchInFlight) return;
    this.switchInFlight = true;
    this.pendingClipPos = nextClipPos;
    this._passThroughVideoSync = false;
    const gen = ++this._transitionGen;
    this.prefetchClipPos = -1;
    this.idlePrepared = false;

    void (async () => {
      try {
        if (!isPreviewCrossfadeEnabled()) {
          await runner();
        } else {
          await this.fadeActiveGainOut();
          if (gen !== this._transitionGen) return;
          await runner();
          if (gen !== this._transitionGen) return;
          await this.fadeActiveGainIn();
        }
        if (gen !== this._transitionGen) return;
        this.commitClipPos(nextClipPos);
        this.onLayerSwapped?.();
      } catch (err) {
        console.warn("[seamless-preview] discontinuity transition failed", err);
      } finally {
        if (gen === this._transitionGen) {
          this.pendingClipPos = -1;
          this.switchInFlight = false;
        }
      }
    })();
  }

  /**
   * @param {number} toMediaSec
   * @param {number} nextClipPos
   */
  async prefetchIdleLayer(toMediaSec, nextClipPos) {
    if (this.switchInFlight) return;
    const idleV = this.idleVideo;
    const idleA = this.idleAudio;
    const to = Math.max(0, toMediaSec);
    this.idlePrepared = false;
    idleV.pause();
    idleA.pause();
    if (this.mediaUrl) {
      assignPreviewMediaSrc(idleV, this.mediaUrl);
      assignPreviewMediaSrc(idleA, this.mediaUrl);
    }
    idleV.currentTime = to;
    idleA.currentTime = to;
    await Promise.all([waitMediaReady(idleV), waitMediaReady(idleA)]);
    if (this.prefetchClipPos === nextClipPos && this.listMode && !this.switchInFlight) {
      this.idlePrepared = true;
      this.silenceIdleAudioGain();
    }
  }

  silenceIdleAudioGain() {
    if (!this.graphReady || !this.audioCtx || !this.gainA || !this.gainB) return;
    const t0 = this.audioCtx.currentTime;
    const idleGain = this.active === 0 ? this.gainB : this.gainA;
    const activeGain = this.active === 0 ? this.gainA : this.gainB;
    idleGain.gain.cancelScheduledValues(t0);
    idleGain.gain.setValueAtTime(0, t0);
    activeGain.gain.cancelScheduledValues(t0);
    activeGain.gain.setValueAtTime(1, t0);
  }

  restoreActiveAudioGain() {
    this.silenceIdleAudioGain();
  }

  /**
   * @param {number} toMediaSec
   */
  async seekAudibleInPlaceCore(toMediaSec) {
    const audio = this.audibleAudio;
    const video = this.activeVideo;
    const to = Math.max(0, toMediaSec);
    const wasPlaying = !audio.paused;
    audio.pause();
    video.pause();
    await this.seekLayerPairCore(video, audio, to);
    if (wasPlaying) {
      try {
        await audio.play();
      } catch {
        /* ignore */
      }
      if (video.paused) {
        void video.play().catch(() => undefined);
      }
    }
  }

  /**
   * Discontinuity transition — sequential envelope (fade out → switch → fade in).
   * Overlapping crossfade는 서로 다른 source 구간이 동시에 들려 이중 목소리 유발.
   *
   * @param {number} toMediaSec
   * @param {number} [durationSec]
   */
  async runCrossfadeDiscontinuityCore(toMediaSec, durationSec = ENVELOPE_FADE_SEC) {
    await this.unlockAudioOutput();
    this.normalizeAudioElementVolumes();

    const activeV = this.activeVideo;
    const activeA = this.audibleAudio;
    const to = Math.max(0, toMediaSec);
    const mediaNow = Math.max(0, Number(activeA.currentTime) || 0);
    const wasPlaying = !activeA.paused;

    if (!isPreviewCrossfadeEnabled()) {
      await this.seekAudibleInPlaceCore(to);
      return;
    }

    if (Math.abs(mediaNow - to) <= 0.025) {
      await this.hardSwitchToIdleLayerCore(to);
      return;
    }

    const targetLayer = 1 - this.active;
    const idleV = targetLayer === 0 ? this.videoA : this.videoB;
    const idleA = targetLayer === 0 ? this.audioA : this.audioB;
    const fadeSec = clampEnvelopeFadeSec(durationSec);

    idleA.pause();
    idleV.pause();

    if (this.graphReady && this.audioCtx && this.gainA && this.gainB) {
      const gActive = this.active === 0 ? this.gainA : this.gainB;
      const gIdle = targetLayer === 0 ? this.gainA : this.gainB;
      const t0 = this.audioCtx.currentTime;
      gIdle.gain.cancelScheduledValues(t0);
      gIdle.gain.setValueAtTime(0, t0);
      gActive.gain.cancelScheduledValues(t0);
      gActive.gain.setValueAtTime(Math.max(0, gActive.gain.value), t0);
      gActive.gain.linearRampToValueAtTime(0, t0 + fadeSec);
    } else if (wasPlaying) {
      await rampElementVolume(activeA, 0, fadeSec);
    }

    await delayMs(envelopeFadeWaitMs(fadeSec));
    activeA.pause();
    activeV.pause();

    idleV.currentTime = to;
    idleA.currentTime = to;
    await Promise.all([waitMediaReady(idleV), waitMediaReady(idleA)]);

    this.active = targetLayer;
    this.applyLayerVisibility();

    if (this.graphReady && this.audioCtx && this.gainA && this.gainB) {
      const gNewActive = this.active === 0 ? this.gainA : this.gainB;
      const gOther = this.active === 0 ? this.gainB : this.gainA;
      const t0 = this.audioCtx.currentTime;
      gOther.gain.cancelScheduledValues(t0);
      gOther.gain.setValueAtTime(0, t0);
      gNewActive.gain.cancelScheduledValues(t0);
      gNewActive.gain.setValueAtTime(0, t0);
    } else {
      idleA.volume = 0;
    }

    if (wasPlaying) {
      try {
        await idleA.play();
      } catch {
        /* ignore */
      }
      try {
        await idleV.play();
      } catch {
        /* ignore */
      }
    }

    if (this.graphReady && this.audioCtx && this.gainA && this.gainB) {
      const gNewActive = this.active === 0 ? this.gainA : this.gainB;
      const t0 = this.audioCtx.currentTime;
      gNewActive.gain.linearRampToValueAtTime(1, t0 + fadeSec);
    } else if (wasPlaying) {
      await rampElementVolume(idleA, 1, fadeSec);
    }

    await delayMs(envelopeFadeWaitMs(fadeSec));
    this.silenceIdleAudioGain();
    this.normalizeAudioElementVolumes();
    activeA.pause();
    activeV.pause();
  }

  /**
   * @param {number} toMediaSec
   */
  async hardSwitchToIdleLayerCore(toMediaSec) {
    await this.unlockAudioOutput();
    this.normalizeAudioElementVolumes();

    const targetLayer = 1 - this.active;
    const idleV = targetLayer === 0 ? this.videoA : this.videoB;
    const idleA = targetLayer === 0 ? this.audioA : this.audioB;
    const to = Math.max(0, toMediaSec);

    this.audibleAudio.pause();
    this.activeVideo.pause();
    if (this.graphReady && this.audioCtx && this.gainA && this.gainB) {
      const t0 = this.audioCtx.currentTime;
      const gFrom = this.active === 0 ? this.gainA : this.gainB;
      const gTo = targetLayer === 0 ? this.gainA : this.gainB;
      gFrom.gain.cancelScheduledValues(t0);
      gFrom.gain.setValueAtTime(0, t0);
      gTo.gain.cancelScheduledValues(t0);
      gTo.gain.setValueAtTime(0, t0);
    }

    idleV.currentTime = to;
    idleA.currentTime = to;
    await Promise.all([waitMediaReady(idleV), waitMediaReady(idleA)]);

    this.active = targetLayer;
    this.applyLayerVisibility();
    this.normalizeAudioElementVolumes();
    this.silenceIdleAudioGain();

    try {
      await idleA.play();
    } catch {
      /* ignore */
    }
    try {
      await idleV.play();
    } catch {
      /* ignore */
    }
  }

  /** @param {import("../shared/timeline-mapping.js").TimelineClip} cur */
  enterSilenceHold(cur) {
    this.silenceHoldActive = true;
    this.silenceClipPos = this.committedClipPos;
    this.silenceWallStartMs = performance.now();
    this.silenceFreezeMediaSec = Math.max(0, cur.mediaStart);
    this.virtualProgramSec = cur.editStart;
    const audio = this.audibleAudio;
    const video = this.activeVideo;
    audio.pause();
    video.pause();
    this.idleVideo.pause();
    this.idleAudio.pause();
    video.currentTime = this.silenceFreezeMediaSec;
    if (this.graphReady && this.audioCtx && this.gainA && this.gainB) {
      const g = this.active === 0 ? this.gainA : this.gainB;
      const t0 = this.audioCtx.currentTime;
      g.gain.cancelScheduledValues(t0);
      g.gain.setValueAtTime(0, t0);
    }
  }

  exitSilenceHold() {
    if (!this.silenceHoldActive) {
      this.virtualProgramSec = null;
      return;
    }
    this.silenceHoldActive = false;
    this.silenceClipPos = -1;
    this.silenceWallStartMs = 0;
    this.silenceFreezeMediaSec = 0;
    this.virtualProgramSec = null;
    this.restoreActiveAudioGain();
  }

  /**
   * @param {import("../shared/timeline-mapping.js").TimelineClip} cur
   * @param {{ start: number, end: number }[]} skip
   */
  tickSilenceClip(cur, skip) {
    if (!this.silenceHoldActive || this.silenceClipPos !== this.committedClipPos) {
      this.enterSilenceHold(cur);
    }
    const clipDur = Math.max(0.001, cur.editEnd - cur.editStart);
    const elapsed = (performance.now() - this.silenceWallStartMs) / 1000;
    const virtualProgramSec = Math.min(cur.editStart + elapsed, cur.editEnd);
    this.virtualProgramSec = virtualProgramSec;

    if (elapsed < clipDur - LIST_CLIP_END_EPS_SEC) {
      return this.makeTickResult({
        silenceHold: true,
        virtualProgramSec,
      });
    }

    const nextPos = this.committedClipPos + 1;
    if (nextPos >= this.clips.length) {
      this.exitSilenceHold();
      this.audibleAudio.pause();
      this.activeVideo.pause();
      return this.makeTickResult({
        ended: true,
        virtualProgramSec: cur.editEnd,
      });
    }

    const next = this.clips[nextPos];
    this.exitSilenceHold();
    this.prefetchClipPos = -1;
    this.idlePrepared = false;

    if (next.isSilence) {
      this.commitClipPos(nextPos);
      return this.tickSilenceClip(next, skip);
    }

    const to = skipCutRangeAt(next.mediaStart, skip);
    const interEff = interClipEffectiveGap(cur, next);
    const silenceEndCls = classifyListOrderGap({
      cur,
      next,
      clips: this.clips,
      curPos: this.committedClipPos,
      nextPos,
      skipRanges: skip,
    });
    if (silenceEndCls.kind !== "edit") {
      this.commitClipPos(nextPos);
      this._passThroughVideoSync = true;
      return this.makeTickResult({
        passThrough: true,
        silenceEnd: true,
        virtualProgramSec: cur.editEnd,
        effectiveGap: interEff,
        gapKind: silenceEndCls.kind,
      });
    }

    this.startDiscontinuityTransition(nextPos, () =>
      this.hardSwitchToIdleLayerCore(to),
    );
    return this.makeTickResult({
      realDiscontinuity: true,
      silenceEnd: true,
      virtualProgramSec: cur.editEnd,
      effectiveGap: interEff,
      pendingClipPos: nextPos,
    });
  }

  getSilenceVirtualProgramSec() {
    return this.silenceHoldActive && Number.isFinite(this.virtualProgramSec)
      ? this.virtualProgramSec
      : null;
  }

  /**
   * list-order — programClips 큐 literal executor (export/burn-in과 동일 의미).
   * 클립[i].sourceStart~effectiveEnd 재생 후 클립[i+1].sourceStart로 seek.
   * 예외: 같은 block 분할·source ε-인접(sameBlockSplit+continuous)만 passThrough.
   */
  handleClipBoundary(cur, next, nextPos, skip, mediaSec) {
    const interEff = interClipEffectiveGap(cur, next);

    if (next.isSilence) {
      this.commitClipPos(nextPos);
      this.prefetchClipPos = -1;
      this.idlePrepared = false;
      return this.tickSilenceClip(next, skip);
    }

    const cls = classifyListOrderGap({
      cur,
      next,
      clips: this.clips,
      curPos: this.committedClipPos,
      nextPos,
      skipRanges: skip,
    });
    const tickMeta = {
      gapKind: cls.kind,
      hasCutData: cls.hasCutData,
      hasSourceJump: cls.hasSourceJump,
      sameBlockSplit: cls.sameBlockSplit,
      literalBlockJump: cls.literalBlockJump === true,
      effectiveGap: interEff,
      programClipLiteral: true,
    };

    const nextStart = skipCutRangeAt(next.mediaStart, skip);
    const eps = passThroughEpsilonSec();
    const sameBlockPassThrough =
      cls.sameBlockSplit &&
      cls.kind === "continuous" &&
      Math.abs(interEff) <= eps &&
      mediaSec >= nextStart - LIST_CLIP_END_EPS_SEC;

    if (sameBlockPassThrough) {
      this.commitClipPos(nextPos);
      this.prefetchClipPos = -1;
      this.idlePrepared = false;
      this._passThroughVideoSync = true;
      return this.makeTickResult({
        passThrough: true,
        realDiscontinuity: false,
        ...tickMeta,
      });
    }

    const useInPlace =
      interEff > DELETED_WORD_MEDIA_GAP_SEC && mediaSec < nextStart - 0.012;
    if (useInPlace) {
      this.startDiscontinuityTransition(nextPos, () => this.seekAudibleInPlaceCore(nextStart));
    } else {
      this.startCrossfadeTransition(nextPos, () => this.runCrossfadeDiscontinuityCore(nextStart));
    }
    return this.makeTickResult({
      realDiscontinuity: true,
      pendingClipPos: nextPos,
      literalQueueSeek: "programClip",
      ...tickMeta,
    });
  }

  /**
   * @param {{ skipRanges?: { start: number, end: number }[] }} opts
   */
  syncListOrderTick(opts) {
    if (!this.listMode || !this.clips.length) {
      return this.makeTickResult({ ok: false });
    }
    if (this.switchInFlight) {
      return this.makeTickResult({ lockedInFlight: true });
    }

    const skip = opts.skipRanges ?? this.skipRanges;
    const audio = this.audibleAudio;
    const video = this.activeVideo;

    const curSilence = this.clips[this.committedClipPos];
    if (curSilence?.isSilence) {
      return this.tickSilenceClip(curSilence, skip);
    }
    if (this.silenceHoldActive) {
      this.exitSilenceHold();
    }

    if (audio.paused) {
      return this.makeTickResult({ paused: true });
    }
    if (audio.seeking || video.seeking) {
      return this.makeTickResult({});
    }
    if (audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      if (!video.paused) video.pause();
      return this.makeTickResult({});
    }
    if (video.paused) {
      void video.play().catch(() => undefined);
    }

    let mediaSec = Math.max(0, audio.currentTime);
    const cur = this.clips[this.committedClipPos];
    if (!cur) return this.makeTickResult({ ok: false });

    const effectiveEnd = effectiveSourceEndForClip(cur);
    const remaining = cur.mediaEnd - mediaSec;
    const clipDur = Math.max(0.05, cur.mediaEnd - cur.mediaStart);
    const lead = Math.min(
      PREFETCH_LEAD_MAX_SEC,
      Math.max(PREFETCH_LEAD_MIN_SEC, clipDur * PREFETCH_LEAD_RATIO),
    );
    const nextPos = this.committedClipPos + 1;

    if (
      nextPos < this.clips.length &&
      remaining <= lead &&
      this.prefetchClipPos !== nextPos &&
      !this.switchInFlight
    ) {
      const next = this.clips[nextPos];
      const prefetchCls = classifyListOrderGap({
        cur,
        next,
        clips: this.clips,
        curPos: this.committedClipPos,
        nextPos,
        skipRanges: skip,
      });
      if (prefetchCls.kind === "edit") {
        this.prefetchClipPos = nextPos;
        void this.prefetchIdleLayer(skipCutRangeAt(next.mediaStart, skip), nextPos);
      }
    }

    const atBoundary =
      mediaSec >= effectiveEnd - LIST_CLIP_END_EPS_SEC ||
      mediaSec >= cur.mediaEnd - LIST_CLIP_END_EPS_SEC;

    if (atBoundary && nextPos < this.clips.length) {
      const next = this.clips[nextPos];
      const tickRes = this.handleClipBoundary(cur, next, nextPos, skip, mediaSec);
      if (tickRes.gapKind || tickRes.passThrough || tickRes.realDiscontinuity) {
        if (typeof console.debug === "function") {
          console.debug("[list-order-tick]", tickRes);
        }
      }
      return tickRes;
    }

    const wall = performance.now();
    if (
      !isSourceVideoPtsTimeline() &&
      skip.length &&
      wall - this.lastAudioSkipWallMs >= AUDIO_SKIP_MIN_MS
    ) {
      const skipped = skipCutRangeAt(mediaSec, skip);
      if (Math.abs(skipped - mediaSec) > 0.025) {
        audio.currentTime = skipped;
        mediaSec = skipped;
        this.lastAudioSkipWallMs = wall;
      }
    }

    const nextClip = this.clips[nextPos];
    const passThroughToNext =
      nextClip &&
      listOrderGapAllowsPassThrough(
        cur,
        nextClip,
        this.clips,
        this.committedClipPos,
        nextPos,
        skip,
      );
    const suppressVideoSeek = this._passThroughVideoSync || passThroughToNext;

    if (
      !suppressVideoSeek &&
      Number.isFinite(video.duration) &&
      video.duration > 0 &&
      Math.abs(video.currentTime - mediaSec) > VIDEO_SYNC_PASS_THROUGH_EPS_SEC
    ) {
      video.currentTime = Math.min(mediaSec, Math.max(0, video.duration - 0.001));
    }

    return this.makeTickResult({});
  }

  setOnLayerSwapped(cb) {
    this.onLayerSwapped = cb;
  }
}

/** @type {PreviewMediaBridge | null} */
let previewBridge = null;

export class PreviewMediaBridge {
  constructor() {
    /** @type {SeamlessPreviewStack | null} */
    this.stack = null;
  }

  bindDom(els) {
    this.stack = new SeamlessPreviewStack(els);
  }

  get video() {
    return this.stack?.activeVideo ?? this.stack?.primaryVideo ?? null;
  }

  get audio() {
    return this.stack?.audibleAudio ?? this.stack?.primaryAudio ?? null;
  }

  get primaryVideo() {
    return this.stack?.primaryVideo ?? null;
  }

  get primaryAudio() {
    return this.stack?.primaryAudio ?? null;
  }

  async setMediaUrl(url) {
    await this.stack?.setMediaUrl(url);
  }

  clearMedia() {
    this.stack?.clearMedia();
  }

  setOnLayerSwapped(cb) {
    this.stack?.setOnLayerSwapped(cb);
  }

  async beginListOrderPlayback(opts) {
    await this.stack?.beginListOrderPlayback(opts);
  }

  endListOrderPlayback() {
    this.stack?.endListOrderPlayback();
  }

  isListOrderMode() {
    return Boolean(this.stack?.isListOrderMode());
  }

  isTransitionLocked() {
    return Boolean(this.stack?.isTransitionLocked());
  }

  getCommittedClipPos() {
    return this.stack?.getCommittedClipPos() ?? -1;
  }

  abortActiveTransition() {
    this.stack?.abortActiveTransition();
  }

  /** @param {number} clipPos */
  sealHotReorderStack(clipPos) {
    this.stack?.sealHotReorderStack(clipPos);
  }

  async waitTransitionIdle(maxMs) {
    await this.stack?.waitTransitionIdle(maxMs);
  }

  /**
   * @param {{
   *   targetMediaSec: number,
   *   onComplete?: () => void,
   *   onError?: (err: unknown) => void,
   * }} opts
   */
  async startExecutorCrossfade(opts) {
    if (!this.stack) {
      opts.onComplete?.();
      return;
    }
    if (this.stack.switchInFlight) return;
    this.stack.switchInFlight = true;
    const gen = this.stack._transitionGen;
    try {
      await this.stack.runCrossfadeDiscontinuityCore(opts.targetMediaSec);
      if (gen === this.stack._transitionGen) {
        this.stack.onLayerSwapped?.();
        opts.onComplete?.();
      }
    } catch (err) {
      console.warn("[seamless-preview] executor crossfade failed", err);
      opts.onError?.(err);
      opts.onComplete?.();
    } finally {
      if (gen === this.stack._transitionGen) {
        this.stack.switchInFlight = false;
      }
    }
  }

  syncListOrderTick(opts) {
    return this.stack?.syncListOrderTick(opts) ?? { ok: false };
  }

  getListClipPos() {
    return this.stack?.getCommittedClipPos() ?? -1;
  }

  getAudibleMediaSec() {
    return this.stack?.getMasterPlayheadSec() ?? null;
  }

  getMasterPlayheadSec() {
    return this.stack?.getMasterPlayheadSec() ?? null;
  }

  getSilenceVirtualProgramSec() {
    return this.stack?.getSilenceVirtualProgramSec() ?? null;
  }

  isAudioGraphActive() {
    return Boolean(this.stack?.isAudioGraphActive());
  }

  async unlockAudioOutput() {
    return Boolean(await this.stack?.unlockAudioOutput());
  }

  pauseAllMedia() {
    this.stack?.pauseAllMedia();
  }
}

export function getPreviewMediaBridge() {
  if (!previewBridge) previewBridge = new PreviewMediaBridge();
  return previewBridge;
}

export function initPreviewMediaBridgeFromDom() {
  const bridge = getPreviewMediaBridge();
  const frame = document.getElementById("preview-media-frame");
  const videoA = document.getElementById("preview-video-a");
  const videoB = document.getElementById("preview-video-b");
  const audioA = document.getElementById("preview-audio-a");
  const audioB = document.getElementById("preview-audio-b");
  if (!frame || !videoA || !videoB || !audioA || !audioB) return bridge;
  bridge.bindDom({ frame, videoA, videoB, audioA, audioB });
  return bridge;
}

export function isListOrderTransitionLocked() {
  return getPreviewMediaBridge().isTransitionLocked();
}

function installPreviewCrossfadeDevHook() {
  if (typeof window === "undefined" || window.__itmatzipCrossfadeInstalled) return;
  window.__itmatzipCrossfadeInstalled = true;
  Object.defineProperty(window, "__itmatzipCrossfade", {
    get: () => previewCrossfadeEnabled,
    set: (v) => {
      setPreviewCrossfadeEnabled(v);
      console.info(
        "[seamless-preview] crossfade",
        previewCrossfadeEnabled ? "enabled" : "disabled (in-place seek, default)",
      );
    },
    configurable: true,
  });
}

installPreviewCrossfadeDevHook();
