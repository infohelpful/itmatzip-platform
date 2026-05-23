/**
 * AutoSubtitle webAudioMasterPlayback.ts (웹 포팅)
 */

const EPS = 1e-4;
const SCHEDULE_LOOKAHEAD_SEC = 0.02;

export class WebAudioMasterPlayback {
  constructor() {
    /** @type {AudioContext | null} */
    this.ctx = null;
    /** @type {GainNode | null} */
    this.gain = null;
    /** @type {AudioBuffer | null} */
    this.buffer = null;
    this.loadedFromUrl = null;
    /** @type {AudioBufferSourceNode[]} */
    this.activeSources = [];
    /** @type {Array<{ ctxStart: number, mediaStartSec: number, durationSec: number }>} */
    this.timeline = [];
    this.playingFlag = false;
    this.scheduleSeq = 0;
    /** @type {((scheduleId: number, reason: 'natural' | 'stopped') => void) | null} */
    this.onScheduleEnded = null;
  }

  isLoadedForUrl(url) {
    return this.buffer != null && this.loadedFromUrl === url;
  }

  isPlaying() {
    return this.playingFlag;
  }

  get currentScheduleId() {
    return this.scheduleSeq;
  }

  /**
   * @param {((scheduleId: number, reason: 'natural' | 'stopped') => void) | null} cb
   */
  setOnScheduleEnded(cb) {
    this.onScheduleEnded = cb;
  }

  ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      this.gain.gain.value = 1;
    }
    return this.ctx;
  }

  /**
   * @param {string} url
   */
  async loadFromUrl(url) {
    if (this.loadedFromUrl === url && this.buffer) return;
    this.stopPlayback();
    const ctx = this.ensureContext();
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`WebAudio load failed: ${res.status}`);
    const arr = await res.arrayBuffer();
    const buf = await ctx.decodeAudioData(arr.slice(0));
    this.buffer = buf;
    this.loadedFromUrl = url;
  }

  /**
   * @param {Array<{ startMediaSec: number, endMediaSec: number }>} segments
   * @param {number} startMediaSec
   * @param {number | null} endMediaSec
   */
  async scheduleFromEdl(segments, startMediaSec, endMediaSec) {
    const ctx = this.ensureContext();
    await ctx.resume().catch(() => undefined);
    this.stopPlayback();
    const buf = this.buffer;
    if (!buf || !segments.length) return;

    const bufDur = buf.duration;
    const pieces = [];
    const endLimit = endMediaSec == null ? Number.POSITIVE_INFINITY : Math.max(0, endMediaSec);
    let startApplied = false;
    const startAt = Math.max(0, startMediaSec);

    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      let s = Math.max(0, seg.startMediaSec);
      let e = Math.min(seg.endMediaSec, bufDur);
      if (endMediaSec != null) e = Math.min(e, endLimit);
      if (!startApplied) {
        if (startAt >= e - EPS) continue;
        s = Math.max(s, startAt);
        startApplied = true;
      }
      if (e <= s + EPS) continue;
      pieces.push({ mediaStartSec: s, durationSec: e - s });
    }

    if (!pieces.length) return;

    let wall = ctx.currentTime + SCHEDULE_LOOKAHEAD_SEC;
    this.timeline = [];
    this.activeSources = [];
    this.scheduleSeq += 1;
    const thisScheduleId = this.scheduleSeq;

    for (const p of pieces) {
      const dur = Math.min(p.durationSec, Math.max(0, bufDur - p.mediaStartSec));
      if (dur <= EPS) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gain);
      this.timeline.push({ ctxStart: wall, mediaStartSec: p.mediaStartSec, durationSec: dur });
      src.start(wall, p.mediaStartSec, dur);
      this.activeSources.push(src);
      src.onended = () => {
        const idx = this.activeSources.indexOf(src);
        if (idx >= 0) this.activeSources.splice(idx, 1);
        if (this.activeSources.length === 0 && this.scheduleSeq === thisScheduleId) {
          this.playingFlag = false;
          const cb = this.onScheduleEnded;
          if (cb) cb(thisScheduleId, "natural");
        }
      };
      wall += dur;
    }
    if (this.activeSources.length > 0) this.playingFlag = true;
  }

  /**
   * @param {number} [ctxNow]
   */
  getCurrentMediaSec(ctxNow) {
    const ctx = this.ctx;
    if (!ctx || !this.playingFlag || !this.timeline.length) return null;
    const now = ctxNow ?? ctx.currentTime;
    for (const frag of this.timeline) {
      const fragEnd = frag.ctxStart + frag.durationSec;
      if (now + 1e-4 < frag.ctxStart) return null;
      if (now < fragEnd + 1e-4) return frag.mediaStartSec + Math.max(0, now - frag.ctxStart);
    }
    const last = this.timeline[this.timeline.length - 1];
    return last.mediaStartSec + last.durationSec;
  }

  stopPlayback() {
    const hadActive = this.activeSources.length > 0;
    const stoppedScheduleId = this.scheduleSeq;
    for (const n of this.activeSources) {
      n.onended = null;
      try {
        n.stop(0);
      } catch {
        /* already stopped */
      }
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.activeSources = [];
    this.timeline = [];
    this.playingFlag = false;
    if (hadActive) {
      const cb = this.onScheduleEnded;
      if (cb) cb(stoppedScheduleId, "stopped");
    }
  }

  dispose() {
    this.stopPlayback();
    try {
      this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.gain = null;
    this.buffer = null;
    this.loadedFromUrl = null;
  }
}
