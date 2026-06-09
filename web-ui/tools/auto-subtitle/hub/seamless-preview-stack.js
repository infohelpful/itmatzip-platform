/**
 * Vrew 스타일 — 비디오 더블 버퍼 + 듀얼 오디오 Web Audio 크로스페이드.
 * 재생 시계·하이라이트는 audibleAudio.currentTime SSOT.
 */

import { skipCutRangeAt } from "../playback.js?v=28";
import { seekWithNudge } from "./html-audio-master-playback.js?v=3";
import { isSourceVideoPtsTimeline } from "../shared/media-timing-ssot.js?v=4";

const HAVE_FUTURE = HTMLMediaElement.HAVE_FUTURE_DATA;
const PREFETCH_LEAD_MIN_SEC = 0.28;
const PREFETCH_LEAD_MAX_SEC = 1.6;
const PREFETCH_LEAD_RATIO = 0.2;
const CROSSFADE_SEC = 0.055;
const LIST_TAIL_SEC = 0.02;
const LIST_CLIP_END_EPS_SEC = 0.001;
const AUDIO_SKIP_MIN_MS = 90;

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
    /** 비디오·오디오 활성 레이어 (0=A, 1=B) */
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
    this.prefetchClipPos = -1;
    this.idlePrepared = false;
    this.switchInFlight = false;
    /** @type {{ start: number, end: number }[]} */
    this.skipRanges = [];
    this.lastAudioSkipWallMs = 0;
    /** @type {(() => void) | null} */
    this.onLayerSwapped = null;

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

  /** 지금 들리는 오디오 — 시계·하이라이트 SSOT */
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

  /** Web Audio graph도 element.volume이 신호에 반영됨 — 크로스페이드는 gain만 사용 */
  normalizeAudioElementVolumes() {
    this.audioA.volume = 1;
    this.audioB.volume = 1;
  }

  /**
   * @param {string} url
   */
  async setMediaUrl(url) {
    this.mediaUrl = url;
    for (const el of [this.videoA, this.videoB, this.audioA, this.audioB]) {
      assignPreviewMediaSrc(el, url);
    }
  }

  clearMedia() {
    this.mediaUrl = "";
    this.endListOrderPlayback();
    for (const el of [this.videoA, this.videoB, this.audioA, this.audioB]) {
      el.pause();
      el.removeAttribute("src");
      try {
        el.load();
      } catch {
        /* ignore */
      }
    }
    this.setGainLevels(1, 0);
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
   * }} opts
   */
  async beginListOrderPlayback(opts) {
    await this.unlockAudioOutput();
    this.listMode = true;
    this.clips = opts.clips;
    this.clipPos = Math.max(0, Math.min(opts.clipPos, opts.clips.length - 1));
    this.skipRanges = opts.skipRanges || [];
    this.prefetchClipPos = -1;
    this.idlePrepared = false;
    this.switchInFlight = false;
    this.active = 0;
    this.setGainLevels(1, 0);

    const start = skipCutRangeAt(Math.max(0, opts.startMediaSec), this.skipRanges);
    await this.seekLayerPair(this.activeVideo, this.audibleAudio, start);
    this.applyLayerVisibility();
    this.idleVideo.pause();
    this.idleAudio.pause();
    this.normalizeAudioElementVolumes();
    this.silenceIdleAudioGain();
  }

  endListOrderPlayback() {
    this.listMode = false;
    this.clips = [];
    this.clipPos = 0;
    this.prefetchClipPos = -1;
    this.idlePrepared = false;
    this.switchInFlight = false;
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
    return this.clipPos;
  }

  /** audible 오디오 → 활성 비디오 폴백 — playhead SSOT */
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
  seekLayerPair(video, audio, mediaSec) {
    const t = Math.max(0, mediaSec);
    return new Promise((resolve) => {
      let pending = 0;
      const done = () => {
        pending -= 1;
        if (pending <= 0) resolve();
      };
      if (Math.abs(audio.currentTime - t) > 0.003) {
        pending += 1;
        seekWithNudge(audio, t, done);
      }
      if (Math.abs(video.currentTime - t) > 0.04) {
        pending += 1;
        seekWithNudge(video, t, done);
      }
      if (pending === 0) resolve();
      window.setTimeout(resolve, 480);
    });
  }

  /**
   * @param {number} toMediaSec
   * @param {number} nextClipPos
   */
  async prefetchIdleLayer(toMediaSec, nextClipPos) {
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
    if (this.prefetchClipPos === nextClipPos && this.listMode) {
      this.idlePrepared = true;
      this.silenceIdleAudioGain();
    }
  }

  /** idle 레이어 gain 0 — prefetch·정지 중 누수 방지 */
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

  /**
   * 연속 클립(미디어 시각 이어짐)만 크로스페이드 — 역행·재정렬 점프는 겹치면 기계음.
   * @param {import("../shared/timeline-mapping.js").TimelineClip} cur
   * @param {import("../shared/timeline-mapping.js").TimelineClip} next
   * @param {number} mediaSec
   * @param {boolean} hadPrefetch
   */
  shouldCrossfadeClipTransition(cur, next, mediaSec, hadPrefetch) {
    if (!hadPrefetch) return false;
    const gap = next.mediaStart - mediaSec;
    const clipGap = next.mediaStart - cur.mediaEnd;
    if (gap < -0.02 || gap >= 0.12) return false;
    if (clipGap < -0.02 || clipGap >= 0.12) return false;
    return true;
  }

  /**
   * 역행·재정렬 점프 — outgoing 완전 정지 후 idle 단일 재생 (오버랩 없음).
   * @param {number} toMediaSec
   */
  async hardSwitchToIdleLayer(toMediaSec) {
    if (this.switchInFlight) return;
    this.switchInFlight = true;
    await this.unlockAudioOutput();
    this.normalizeAudioElementVolumes();

    const targetLayer = 1 - this.active;
    const idleV = targetLayer === 0 ? this.videoA : this.videoB;
    const idleA = targetLayer === 0 ? this.audioA : this.audioB;
    const to = Math.max(0, toMediaSec);
    const outgoingAudible = this.audibleAudio;

    outgoingAudible.pause();
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
    this.normalizeAudioElementVolumes();
    if (this.graphReady) {
      this.setGainLevels(targetLayer === 0 ? 1 : 0, targetLayer === 1 ? 1 : 0);
    }
    this.applyLayerVisibility();

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

    this.switchInFlight = false;
    this.onLayerSwapped?.();
  }

  /** 연속 클립 전용 — 짧은 구간만 두 레이어 믹스 */
  async crossfadeToIdleLayer(toMediaSec) {
    if (this.switchInFlight) return;
    this.switchInFlight = true;
    await this.unlockAudioOutput();
    this.normalizeAudioElementVolumes();

    const targetLayer = 1 - this.active;
    const idleV = targetLayer === 0 ? this.videoA : this.videoB;
    const idleA = targetLayer === 0 ? this.audioA : this.audioB;
    const to = Math.max(0, toMediaSec);

    idleV.currentTime = to;
    idleA.currentTime = to;
    await Promise.all([waitMediaReady(idleV), waitMediaReady(idleA)]);

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

    if (this.graphReady && this.audioCtx && this.gainA && this.gainB) {
      const t0 = this.audioCtx.currentTime;
      const gFrom = this.active === 0 ? this.gainA : this.gainB;
      const gTo = targetLayer === 0 ? this.gainA : this.gainB;
      gFrom.gain.cancelScheduledValues(t0);
      gTo.gain.cancelScheduledValues(t0);
      gFrom.gain.setValueAtTime(gFrom.gain.value, t0);
      gFrom.gain.linearRampToValueAtTime(0, t0 + CROSSFADE_SEC);
      gTo.gain.setValueAtTime(0, t0);
      gTo.gain.linearRampToValueAtTime(1, t0 + CROSSFADE_SEC);
    } else {
      const outgoing = this.audibleAudio;
      outgoing.volume = 0;
      idleA.volume = 1;
    }

    this.applyLayerVisibility();

    window.setTimeout(() => {
      const outgoingAudible = this.audibleAudio;
      this.activeVideo.pause();
      outgoingAudible.pause();
      this.active = targetLayer;
      this.normalizeAudioElementVolumes();
      if (this.graphReady) {
        this.setGainLevels(targetLayer === 0 ? 1 : 0, targetLayer === 1 ? 1 : 0);
      }
      this.applyLayerVisibility();
      this.switchInFlight = false;
      this.onLayerSwapped?.();
    }, Math.ceil(CROSSFADE_SEC * 1000) + 16);
  }

  /**
   * @param {{ skipRanges?: { start: number, end: number }[] }} opts
   */
  syncListOrderTick(opts) {
    if (!this.listMode || !this.clips.length || this.switchInFlight) {
      return { ok: true, clipPos: this.clipPos };
    }
    const skip = opts.skipRanges ?? this.skipRanges;
    const audio = this.audibleAudio;
    const video = this.activeVideo;
    if (audio.paused) return { ok: true, paused: true, clipPos: this.clipPos };
    if (audio.seeking || video.seeking) return { ok: true, clipPos: this.clipPos };
    if (audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      if (!video.paused) video.pause();
      return { ok: true, clipPos: this.clipPos };
    }
    if (video.paused) {
      void video.play().catch(() => undefined);
    }

    let mediaSec = Math.max(0, audio.currentTime);
    const cur = this.clips[this.clipPos];
    if (!cur) return { ok: false, clipPos: this.clipPos };

    const remaining = cur.mediaEnd - mediaSec;
    const clipDur = Math.max(0.05, cur.mediaEnd - cur.mediaStart);
    const lead = Math.min(
      PREFETCH_LEAD_MAX_SEC,
      Math.max(PREFETCH_LEAD_MIN_SEC, clipDur * PREFETCH_LEAD_RATIO),
    );
    const nextPos = this.clipPos + 1;

    if (nextPos < this.clips.length && remaining <= lead && this.prefetchClipPos !== nextPos) {
      this.prefetchClipPos = nextPos;
      const next = this.clips[nextPos];
      void this.prefetchIdleLayer(skipCutRangeAt(next.mediaStart, skip), nextPos);
    }

    if (mediaSec >= cur.mediaEnd - LIST_CLIP_END_EPS_SEC && nextPos < this.clips.length) {
      const next = this.clips[nextPos];
      const gap = next.mediaStart - mediaSec;

      /** inter-cue gap — seek 없이 자연 재생 (꼬리·무음 포함) */
      if (mediaSec < next.mediaStart - 0.012) {
        return { ok: true, clipPos: this.clipPos, gapPlayback: true };
      }

      if (gap >= -0.015 && gap < 0.1) {
        this.clipPos = nextPos;
        this.prefetchClipPos = -1;
        this.idlePrepared = false;
        return { ok: true, clipPos: this.clipPos, soft: true };
      }
      const to = skipCutRangeAt(next.mediaStart, skip);
      const hadPrefetch =
        this.idlePrepared && this.prefetchClipPos === nextPos;
      this.clipPos = nextPos;
      this.prefetchClipPos = -1;
      this.idlePrepared = false;
      if (this.shouldCrossfadeClipTransition(cur, next, mediaSec, hadPrefetch)) {
        void this.crossfadeToIdleLayer(to);
        return { ok: true, clipPos: this.clipPos, crossfade: true };
      }
      /** 재정렬·역행 점프만 hard seek */
      if (hadPrefetch || gap < -0.02 || next.mediaStart - cur.mediaEnd < -0.02) {
        void this.hardSwitchToIdleLayer(to);
        return { ok: true, clipPos: this.clipPos, hardSwitch: true };
      }
      this.clipPos = nextPos;
      return { ok: true, clipPos: this.clipPos, soft: true };
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

    if (
      Number.isFinite(video.duration) &&
      video.duration > 0 &&
      Math.abs(video.currentTime - mediaSec) > 0.12
    ) {
      video.currentTime = Math.min(mediaSec, Math.max(0, video.duration - 0.001));
    }

    return { ok: true, clipPos: this.clipPos };
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

  syncListOrderTick(opts) {
    return this.stack?.syncListOrderTick(opts) ?? { ok: false };
  }

  getListClipPos() {
    return this.stack?.getClipPos() ?? -1;
  }

  getAudibleMediaSec() {
    return this.stack?.getMasterPlayheadSec() ?? null;
  }

  getMasterPlayheadSec() {
    return this.stack?.getMasterPlayheadSec() ?? null;
  }

  isAudioGraphActive() {
    return Boolean(this.stack?.isAudioGraphActive());
  }

  async unlockAudioOutput() {
    return Boolean(await this.stack?.unlockAudioOutput());
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
