/**
 * Line Mode — 예전 subwave 3구역 UI를 줄(cue) 단위로 재사용.
 * - 가운데: 이 줄 · 앞뒤 1초 neighbor
 * - 트림 핸들: 줄 start/end
 * - 세로 라인: 재생 위치만 (자르기/분할 없음)
 */

import { WaveformContextEditor } from "../waveform-context-editor.js";
import { resolvePeaksTimelineMetrics } from "../peaks-metrics.js";
import { buildEdlSkipMapping } from "../waveform/edl-skip-mapping.js";
import { buildPanelSkipRanges } from "../waveform/panel-skip-ranges.js";
import {
  cardBoundsDeltaForStrip,
  computeFirstBoxLayoutPxForAnchor,
  CUE_WAVE_MOUNT_LEFT_PAD_RATIO,
} from "../waveform/subwave-panel-layout.js";
import {
  computeConnectorGeomForRail,
  computeTrimHandlePct,
  ensureConnectorOverlayHost,
  paintConnectorOverlay,
} from "../waveform/waveform-connector-geom.js";
import { applyCueLineEndTrimCoupled } from "../shared/cross-cue-boundary-sync.js?v=8";
import {
  computeCueContextWindow,
  CUE_WAVEFORM_DEFAULT_PAD_SEC,
  CUE_WAVEFORM_MAX_EXTRA_PAD_SEC,
} from "../shared/line-mode/cue-context-window.js";
import { registerWaveformPanel, unregisterWaveformPanel } from "../waveform-panel-registry.js";
import { shouldDeferWaveformSpaceToCaret } from "../subtitle-list/word-caret-ui.js?v=61";
import { syncCuesAfterWordEdit } from "../shared/cues-ssot.js";
import {
  getPlayTailOffsetSec,
  onPlayTailOffsetChange,
  resolveLineWaveformPlayStart,
  togglePlayTailOffset,
} from "../shared/line-mode/play-tail-offset.js";

const CUT_EPS = 1e-4;
const CUT_SNAP_MS = 220;
const WAVEFORM_PLAY_START_GUARD_MS = 600;
const PLAY_LINE_SPLIT_MARGIN_SEC = 0.04;
/** 재생 중 파란 재생 라인 — CSS left 보간 (초) */
const PLAY_LINE_MOTION_SMOOTH_SEC = 0.1;
let lastWaveformPlayStartMs = 0;

/** 끝라인 스냅 디버그 — `window.__LINE_END_SNAP_LOG = true` 로 켬 */
function isLineEndSnapLogEnabled() {
  if (typeof window === "undefined") return false;
  return window.__LINE_END_SNAP_LOG === true;
}

let lineEndSnapLogSeq = 0;

function lineEndSnapLog(phase, detail = {}) {
  if (!isLineEndSnapLogEnabled()) return;
  lineEndSnapLogSeq += 1;
  console.log(`[line-end-snap] #${lineEndSnapLogSeq} ${phase}`, detail);
}

/** @type {Map<number, number>} cueIndex → 재생 라인 위치 */
const playSecByCueIndex = new Map();

function peaksMetricsForPanel(peaks, durHint) {
  return resolvePeaksTimelineMetrics(peaks, durHint ?? undefined);
}

export class LineModeCueWaveformPanel {
  /**
   * @param {HTMLElement} mount
   * @param {object} deps
   */
  constructor(mount, deps) {
    this.mount = mount;
    this.deps = deps;
    this.root = mount;
    this.cueIndex = -1;
    this.editor = null;
    this.viewWin = null;
    this.editRange = null;
    this.playSec = null;
    this._expandLeftSec = 0;
    this._expandRightSec = 0;
    this._playDragging = false;
    this._trimDragging = null;
    this._trimMoveRaf = 0;
    this._trimPendingClientX = null;
    this._trimBypassSnap = false;
    this._isPlayingRange = false;
    this._isPlayLineMotion = false;
    this._playLabelEl = null;
    this._playGripEl = null;
    this._playSliderEl = null;
    this._connectorAnchorKey = null;
    this._connectorGeom = null;
    this._connectorRo = null;
    this._cardEl = null;
    this.boxLayoutPx = null;
    this.lockedAnchorKey = null;
    this.pps = null;
    this.frozenViewWin = null;
    this.lastTrimEdge = null;
    this.viewWinAnchorKey = null;
    this._panelMediaDurHint = null;
    this._boundKeydown = null;
    this._unsubTailOffset = null;
  }

  /** @returns {{ v0: number, v1: number } | null} */
  _viewWinSec() {
    if (!this.viewWin) return null;
    return {
      v0: Math.min(this.viewWin.start, this.viewWin.end),
      v1: Math.max(this.viewWin.start, this.viewWin.end),
    };
  }

  /**
   * @param {number} cueIndex
   */
  show(cueIndex) {
    registerWaveformPanel(this);
    this.cueIndex = cueIndex;
    this._connectorAnchorKey = null;
    this._connectorGeom = null;
    this.boxLayoutPx = null;
    this.lockedAnchorKey = null;
    this.pps = null;
    this.frozenViewWin = null;
    this.lastTrimEdge = null;
    this.viewWinAnchorKey = null;
    void this._renderAsync();
  }

  hide() {
    unregisterWaveformPanel(this);
    if (this._trimMoveRaf) {
      cancelAnimationFrame(this._trimMoveRaf);
      this._trimMoveRaf = 0;
    }
    this._trimPendingClientX = null;
    this._trimBypassSnap = false;
    this.finishRangePlay(false);
    this._unbindKeys();
    this._unsubTailOffset?.();
    this._unsubTailOffset = null;
    this._connectorRo?.disconnect();
    this._connectorRo = null;
    this._connectorAnchorKey = null;
    this._connectorGeom = null;
    this.editor?.destroy();
    if (this.root) this.root.innerHTML = "";
    this.editor = null;
    this.viewWin = null;
    this.editRange = null;
    this.playSec = null;
    this.cueIndex = -1;
    const card = this.deps.getCard?.();
    card?.querySelector(".subwave-connector-overlay")?.remove();
  }

  destroy() {
    this.hide();
  }

  sync() {
    this.syncPlayhead();
  }

  /** @param {number} sec @param {{ forDisplay?: boolean }} [opts] */
  _clampPlaySecToRange(sec, opts = {}) {
    if (!this.editRange || !Number.isFinite(sec)) return sec;
    const s = Math.min(this.editRange.start, this.editRange.end);
    const e = Math.max(this.editRange.start, this.editRange.end);
    if (opts.forDisplay) return Math.min(e, Math.max(s, sec));
    return Math.min(e - CUT_EPS, Math.max(s + CUT_EPS, sec));
  }

  /** @param {boolean} [animate] */
  _rewindPlayLineToTrimStart(animate) {
    const targets = [this._playLabelEl, this._playGripEl, this._playSliderEl].filter(
      (el) => el instanceof HTMLElement,
    );
    if (animate && targets.length) {
      for (const el of targets) {
        el.classList.add("is-snapping-home");
        el.style.willChange = "left";
        el.style.transition = `left ${CUT_SNAP_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`;
      }
      requestAnimationFrame(() => {
        this._syncPlayLineDom({ fromRewind: true });
      });
      window.setTimeout(() => {
        for (const el of targets) {
          el.classList.remove("is-snapping-home");
          el.style.willChange = "";
          el.style.transition = "";
        }
      }, CUT_SNAP_MS + 40);
      return;
    }
    this._syncPlayLineDom({ fromRewind: true });
  }

  syncPlayhead() {
    if (this.deps.isPlaying?.() && this._isPlayingRange) return;
    if (this.editRange && this.playSec != null && !this._isPlayLineMotion && !this._playDragging) {
      this._syncPlayLineDom();
    }
    this.editor?._scheduleDraw?.();
    if (this._cardEl) this._syncConnector(this._cardEl);
  }

  /** @param {number} editSec */
  syncPlayheadFromEditSec(editSec) {
    if (this._playDragging) return;
    if (!this.deps.isPlaying?.()) {
      this.editor?._scheduleDraw?.();
      if (this._cardEl) this._syncConnector(this._cardEl);
      return;
    }
    if (!this._isPlayLineMotion) this._enterPlayingMotion();
    this._paintPlayLine(editSec);
  }

  /** @param {boolean} [animate] @param {{ rewindToTrimStart?: boolean, playheadEditSec?: number }} [opts] */
  finishRangePlay(animate = true, opts = {}) {
    const shouldRewind = opts.rewindToTrimStart === true;
    const shouldSyncPlayhead = Number.isFinite(opts.playheadEditSec);
    if (
      !this._isPlayingRange &&
      !this._isPlayLineMotion &&
      !shouldRewind &&
      !shouldSyncPlayhead
    ) {
      return;
    }
    this._isPlayingRange = false;
    this._exitPlayingMotion();

    if (!this.editRange) return;

    const s = Math.min(this.editRange.start, this.editRange.end);
    const e = Math.max(this.editRange.start, this.editRange.end);

    if (shouldRewind) {
      this.playSec = e;
      playSecByCueIndex.set(this.cueIndex, e);
      this._paintPlayLine(e);
      this.playSec = s;
      playSecByCueIndex.set(this.cueIndex, s);
      this._rewindPlayLineToTrimStart(animate);
      return;
    }

    if (shouldSyncPlayhead) {
      this.playSec = this._clampPlaySecToRange(opts.playheadEditSec, { forDisplay: true });
      playSecByCueIndex.set(this.cueIndex, this.playSec);
    }
    this._syncPlayLineDom();
  }

  /** @param {number} startEditSec */
  beginRangePlay(startEditSec) {
    this._isPlayingRange = true;
    this._enterPlayingMotion();
    if (Number.isFinite(startEditSec)) {
      requestAnimationFrame(() => {
        if (this._isPlayingRange && this.deps.isPlaying?.()) {
          this._paintPlayLine(startEditSec);
        }
      });
    }
  }

  togglePlayFromCut() {
    this._togglePlayFromPlayLine();
  }

  async _renderAsync() {
    if (!this.root) return;
    const cues = this.deps.getCues?.() || [];
    const cue = cues[this.cueIndex];
    if (!cue) return;

    this.root.innerHTML = `<p class="subwave-meta">오디오 파형 준비 중…</p>`;

    const durHint = this.deps.getMediaDurationSec?.() ?? null;
    let peaks = this.deps.getPeaksData?.();
    let metrics = peaksMetricsForPanel(peaks, durHint);
    if (!metrics && this.deps.ensurePeaksLoad) {
      await this.deps.ensurePeaksLoad();
      peaks = this.deps.getPeaksData?.();
      metrics = peaksMetricsForPanel(peaks, durHint);
    }

    if (!metrics) {
      this.root.innerHTML =
        `<p class="subwave-meta">파형을 불러올 수 없습니다. 원본 영상 경로를 확인한 뒤 다시 더블클릭하세요.</p>`;
      return;
    }

    const dur = metrics.durationSec;
    const ctx = this._computeCtxWin(cue, dur);
    if (!ctx) {
      this.root.innerHTML = `<p class="subwave-meta">줌 구간을 계산할 수 없습니다.</p>`;
      return;
    }

    this.viewWin = { start: ctx.windowStart, end: ctx.windowEnd };
    const lineStart = Number(cue.start) || 0;
    const lineEnd = Math.max(lineStart, Number(cue.end) || lineStart);
    this.editRange = { start: lineStart, end: lineEnd };
    this._syncPlaySecFromRange();
    this._panelMediaDurHint = dur;
    this._renderPanel(cue, peaks);
  }

  /**
   * @param {import("../shared/subtitles.js").SubtitleLine} cue
   * @param {number} dur
   */
  _computeCtxWin(cue, dur) {
    return computeCueContextWindow(cue, dur, this._expandLeftSec, this._expandRightSec);
  }

  _syncPlaySecFromRange() {
    if (!this.editRange) {
      this.playSec = null;
      return;
    }
    const s = Math.min(this.editRange.start, this.editRange.end);
    const e = Math.max(this.editRange.start, this.editRange.end);
    const stored = playSecByCueIndex.get(this.cueIndex);
    const playhead = Number(this.deps.getPlayheadSec?.());
    let next =
      stored != null && Number.isFinite(stored)
        ? stored
        : Number.isFinite(playhead) && playhead >= s && playhead <= e
          ? playhead
          : s + Math.min(0.05, (e - s) * 0.15);
    next = this._clampPlaySecToRange(next, { forDisplay: true });
    this.playSec = next;
    playSecByCueIndex.set(this.cueIndex, next);
  }

  /**
   * @param {import("../shared/subtitles.js").SubtitleLine} cue
   * @param {object} peaks
   */
  _renderPanel(cue, peaks) {
    if (!this.root || !this.viewWin || !this.editRange) return;

    const fmt = this.deps.formatTime || ((s) => `${Number(s).toFixed(2)}s`);
    const spanSec = Math.max(this.editRange.end - this.editRange.start, 0.04);
    const card = this.deps.getCard?.() ?? null;
    const cacheHint = peaks.from_cache ? " · 캐시" : "";

    this.root.innerHTML = `
      <div class="subwave-flow-root" tabindex="0" data-subwave-flow>
        <div class="subwave-stage">
          <div class="subwave-box" data-wave-strip>
            <div class="subwave-cut-rail subwave-cut-rail--play-only" data-play-rail>
              <span class="subwave-cut-label" data-play-label hidden></span>
              <div class="subwave-cut-grip" data-play-grip title="재생 위치 (드래그)" aria-label="재생 위치"></div>
            </div>
            <div class="subwave-chrome">
              <div class="subwave-snap-guides" data-snap-guides aria-hidden="true"></div>
              <div class="subwave-canvas-wrap">
                <canvas class="subwave-canvas" aria-label="줄 싱크 파형"></canvas>
              </div>
              <div class="subwave-trim-handles" aria-hidden="false">
                <div class="subwave-trim-handle subwave-trim-handle--start subwave-trim-handle--locked" data-trim="start" title="시작 시간 (고정)" aria-hidden="true"></div>
                <div class="subwave-trim-handle subwave-trim-handle--end" data-trim="end" title="줄 끝 조절 (아래 줄 시작 연동)"></div>
              </div>
              <div class="subwave-cut-line" data-play-slider aria-hidden="false" title="재생 위치"></div>
            </div>
            <p class="subwave-duration-badge">${spanSec.toFixed(1)}초</p>
            <div class="subwave-actions">
              <button type="button" class="subwave-btn" data-act="play" title="재생 위치부터 재생 (Space)">▶</button>
              <div class="subwave-tail-offset-group" role="group" aria-label="끝 구간 미리듣기">
                <button type="button" class="subwave-btn subwave-btn--tail-offset" data-act="tail-0.3" title="끝 0.3초 전부터 재생" aria-pressed="false">0.3</button>
                <button type="button" class="subwave-btn subwave-btn--tail-offset" data-act="tail-0.5" title="끝 0.5초 전부터 재생" aria-pressed="false">0.5</button>
              </div>
              <button type="button" class="subwave-btn" data-act="split" title="재생 라인 위치에서 줄 분할" disabled aria-label="재생 라인 위치에서 줄 분할">✂</button>
              <button type="button" class="subwave-btn subwave-btn--close" data-act="close" title="닫기">✕</button>
            </div>
            <p class="subwave-meta">${fmt(this.editRange.start)} – ${fmt(this.editRange.end)}${cacheHint}</p>
          </div>
        </div>
      </div>
    `;

    const flow = this.root.querySelector("[data-subwave-flow]");
    const canvas = this.root.querySelector(".subwave-canvas");
    const trimStart = this.root.querySelector('[data-trim="start"]');
    const trimEnd = this.root.querySelector('[data-trim="end"]');
    this._playLabelEl = this.root.querySelector("[data-play-label]");
    this._playGripEl = this.root.querySelector("[data-play-grip]");
    this._playSliderEl = this.root.querySelector("[data-play-slider]");
    const badge = this.root.querySelector(".subwave-duration-badge");

    if (!(canvas instanceof HTMLCanvasElement)) return;

    this.editor = new WaveformContextEditor(canvas);
    this.editor.setCueLineFillMode(true);
    this.editor.setMediaDurationHint(this._panelMediaDurHint ?? this.deps.getMediaDurationSec?.() ?? null);
    this.editor.setPeaks(peaks);
    this.editor.setViewWindow(this.viewWin);
    this.editor.setEditRange(this.editRange);
    this.editor.setPlaybackSkipRanges(this.deps.getPlaybackSkipRanges?.() || []);
    this.editor.setFocus(this.cueIndex, -1, cue);

    this._applyBoxLayoutLock(cue, peaks);
    this._applyBoxLayoutToDom();
    this._syncOverlays(trimStart, trimEnd, badge);
    this._syncSnapGuides();
    this._syncPlayLineDom();
    this._syncConnector(card);
    this._wireTrim(trimStart, trimEnd, badge);
    this._wirePlayLine(this._playGripEl, this._playSliderEl);
    this._wireActions();

    flow?.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (e.code === "Space" || e.key === " ") {
        if (!this.deps.isWaveformPanelActive?.()) return;
        if (shouldDeferWaveformSpaceToCaret()) return;
        e.preventDefault();
        if (this._pausePlaybackIfAllowed()) return;
        this._togglePlayFromPlayLine();
      }
    });

    this._bindKeys();
    this._cardEl = card;
    this._scheduleConnectorMeasure(card);

    requestAnimationFrame(() => {
      this._applyBoxLayoutLock(cue, peaks, 1);
      this._applyBoxLayoutToDom();
      this._nudgeBoxInsideCard(card);
      this.editor?._scheduleDraw?.();
      this._syncOverlays(trimStart, trimEnd, badge);
      this._syncSnapGuides();
      this._syncPlayLineDom();
      this._syncConnector(card);
    });
  }

  /** @param {HTMLElement | null} card */
  _findRailAnchor(card) {
    return card?.querySelector(".subtitle-word-rail") ?? null;
  }

  _applyBoxLayoutLock(cue, peaks, retry = 0) {
    const card = this.deps.getCard?.();
    const mount = this.root;
    const anchor = this._findRailAnchor(card);
    if (!(mount instanceof HTMLElement) || !card || !(anchor instanceof HTMLElement)) {
      if (retry < 12) {
        requestAnimationFrame(() => {
          this._applyBoxLayoutLock(cue, peaks, retry + 1);
          this._applyBoxLayoutToDom();
        });
      }
      return false;
    }

    const anchorKey = `cue:${this.cueIndex}`;
    const durHint = this.deps.getMediaDurationSec?.() ?? null;
    const metrics = peaksMetricsForPanel(peaks, durHint);
    const dur = metrics?.durationSec ?? durHint ?? 0;
    if (!(dur > 0)) return false;

    const ctxWin = this._computeCtxWin(cue, dur);
    if (!ctxWin) return false;

    const skips = this.deps.getPlaybackSkipRanges?.() || [];
    const lineStart = Number(cue.start) || 0;
    const lineEnd = Math.max(lineStart, Number(cue.end) || lineStart);
    const anchorSpan = { start: lineStart, end: lineEnd };
    const spanKey = `${anchorKey}|${lineStart}:${lineEnd}`;
    const isFirstLock = this.lockedAnchorKey !== anchorKey;

    if (isFirstLock) {
      const layout = computeFirstBoxLayoutPxForAnchor({
        mount,
        anchorEl: anchor,
        activeSpan: anchorSpan,
        ctxWin,
        skipRanges: buildPanelSkipRanges(
          { start: ctxWin.windowStart, end: ctxWin.windowEnd },
          skips,
          cue,
          null,
        ),
      });
      if (!layout) {
        if (retry < 12) {
          requestAnimationFrame(() => {
            this._applyBoxLayoutLock(cue, peaks, retry + 1);
            this._applyBoxLayoutToDom();
          });
        }
        return false;
      }
      this.boxLayoutPx = { left: layout.left, width: layout.width };
      this.pps = layout.pps;
      this.frozenViewWin = { ...layout.viewWin };
      this.viewWin = { ...layout.viewWin };
      this.lockedAnchorKey = anchorKey;
      this.viewWinAnchorKey = spanKey;
      this.editor?.setViewWindow(this.viewWin);
    }

    return true;
  }

  _applyBoxLayoutToDom() {
    const box = this.root?.querySelector("[data-wave-strip]");
    if (!(box instanceof HTMLElement)) return;
    if (this.boxLayoutPx) {
      box.style.marginLeft = `${this.boxLayoutPx.left}px`;
      box.style.marginRight = "0";
      box.style.width = `${this.boxLayoutPx.width}px`;
    } else {
      box.style.marginLeft = "";
      box.style.marginRight = "";
      box.style.width = "";
    }
  }

  /** @param {HTMLElement | null} card */
  _nudgeBoxInsideCard(card) {
    if (!this.boxLayoutPx || !card) return;
    const box = this.root?.querySelector("[data-wave-strip]");
    if (!(box instanceof HTMLElement)) return;
    const delta = cardBoundsDeltaForStrip(this.boxLayoutPx, card, box, {
      leftPadRatio: CUE_WAVE_MOUNT_LEFT_PAD_RATIO,
    });
    if (Math.abs(delta) < 0.25) return;
    this.boxLayoutPx = { ...this.boxLayoutPx, left: this.boxLayoutPx.left + delta };
    this._applyBoxLayoutToDom();
  }

  _getSkipMapping() {
    if (!this.viewWin) return null;
    const v0 = Math.min(this.viewWin.start, this.viewWin.end);
    const v1 = Math.max(this.viewWin.start, this.viewWin.end);
    const cues = this.deps.getCues?.();
    const cue = cues?.[this.cueIndex] ?? null;
    const skips = buildPanelSkipRanges(
      { start: v0, end: v1 },
      this.deps.getPlaybackSkipRanges?.() || [],
      cue,
      null,
    );
    return buildEdlSkipMapping({ start: v0, end: v1 }, skips);
  }

  _getTrimHandlePct() {
    const mapping = this._getSkipMapping();
    if (!mapping || !this.editRange) return null;
    return computeTrimHandlePct(this.viewWin, this.editRange, mapping);
  }

  _syncOverlays(trimStart, trimEnd, badge) {
    if (!this.editor || !this.editRange) return;
    const er = this.editRange;
    const trimPct = this._getTrimHandlePct();
    const sPct = trimPct?.startPct ?? this.editor.timeToPct(er.start);
    const ePct = trimPct?.endPct ?? this.editor.timeToPct(er.end);
    if (trimStart instanceof HTMLElement) trimStart.style.left = `${sPct}%`;
    if (trimEnd instanceof HTMLElement) trimEnd.style.left = `${ePct}%`;
    if (badge) badge.textContent = `${Math.max(er.end - er.start, 0).toFixed(1)}초`;
  }

  _snapLog(phase, extra = {}) {
    const hubCue = this.deps.getCues?.()?.[this.cueIndex];
    lineEndSnapLog(phase, {
      cueIndex: this.cueIndex,
      editRange: this.editRange ? { start: this.editRange.start, end: this.editRange.end } : null,
      hubStart: hubCue != null ? Number(hubCue.start) : null,
      hubEnd: hubCue != null ? Number(hubCue.end) : null,
      viewWin: this.viewWin ? { start: this.viewWin.start, end: this.viewWin.end } : null,
      ...extra,
    });
  }

  _collectSnapGuideTimesSec() {
    const snap = this.deps.getSnapGrid?.() || {};
    // 끝 핸들 스냅과 1:1 매칭되는 가이드만 노출한다.
    const bins = [snap.valleys, snap.silencePads];
    const times = [];
    const seen = new Set();
    for (const bin of bins) {
      if (!Array.isArray(bin)) continue;
      for (const item of bin) {
        const t = Number(item?.t);
        if (!Number.isFinite(t)) continue;
        const key = t.toFixed(4);
        if (seen.has(key)) continue;
        seen.add(key);
        times.push(t);
      }
    }
    return times;
  }

  /** 열린 파동 패널 viewWin 안의 V골·silencePad 시각만 (전체 타임라인 X) */
  _snapTimesInViewWin() {
    const bounds = this._viewWinSec();
    if (!bounds) return [];
    const { v0, v1 } = bounds;
    return this._collectSnapGuideTimesSec()
      .filter((t) => Number.isFinite(t) && t > v0 + 1e-6 && t < v1 - 1e-6)
      .sort((a, b) => a - b);
  }

  _syncSnapGuides() {
    const host = this.root?.querySelector("[data-snap-guides]");
    if (!(host instanceof HTMLElement) || !this.viewWin) return;
    const secs = this._snapTimesInViewWin();
    if (!secs.length) {
      host.replaceChildren();
      return;
    }
    const frag = document.createDocumentFragment();
    for (const sec of secs) {
      const pct = this._playLinePct(sec)?.pct;
      if (pct == null || pct <= 0 || pct >= 100) continue;
      const line = document.createElement("div");
      line.className = "subwave-snap-guide-line";
      line.style.left = `${pct}%`;
      frag.appendChild(line);
    }
    host.replaceChildren(frag);
  }

  /** @param {HTMLElement | null} card @param {boolean} [force] */
  _syncConnector(card, force = false) {
    if (!card || !this.root || !this.editRange) return;
    const anchor = this._findRailAnchor(card);
    const waveBox = this.root.querySelector(".subwave-chrome");
    if (!(anchor instanceof HTMLElement) || !(waveBox instanceof HTMLElement)) {
      paintConnectorOverlay(ensureConnectorOverlayHost(card), null);
      return;
    }
    const trimPct = this._getTrimHandlePct();
    if (!trimPct) return;
    const chipSpan = anchor instanceof HTMLElement
      ? [...anchor.querySelectorAll(".subtitle-word-chip")]
          .filter((el) => el instanceof HTMLElement && el.getBoundingClientRect().width > 0.5)
          .map((el) => el.getBoundingClientRect())
      : [];
    const chipKey =
      chipSpan.length > 0
        ? `${chipSpan[0].left.toFixed(1)}:${chipSpan[chipSpan.length - 1].right.toFixed(1)}`
        : "rail";
    const anchorKey = `cue:${this.cueIndex}|${chipKey}|${trimPct.startPct.toFixed(2)}:${trimPct.endPct.toFixed(2)}`;
    if (!force && this._connectorAnchorKey === anchorKey && this._connectorGeom) {
      paintConnectorOverlay(ensureConnectorOverlayHost(card), this._connectorGeom);
      return;
    }
    const geom = computeConnectorGeomForRail(card, waveBox, anchor, trimPct);
    if (!geom) {
      paintConnectorOverlay(ensureConnectorOverlayHost(card), null);
      return;
    }
    this._connectorAnchorKey = anchorKey;
    this._connectorGeom = geom;
    paintConnectorOverlay(ensureConnectorOverlayHost(card), geom);
  }

  /** @param {HTMLElement | null} card */
  _scheduleConnectorMeasure(card) {
    this._connectorRo?.disconnect();
    this._connectorRo = null;
    if (!card) return;
    let settled = false;
    const ro = new ResizeObserver(() => {
      if (settled) return;
      this._syncConnector(card, true);
      if (this._connectorGeom) {
        settled = true;
        ro.disconnect();
        this._connectorRo = null;
      }
    });
    this._connectorRo = ro;
    ro.observe(card);
    const waveBox = this.root?.querySelector(".subwave-chrome");
    if (waveBox instanceof HTMLElement) ro.observe(waveBox);
    const anchor = this._findRailAnchor(card);
    if (anchor instanceof HTMLElement) ro.observe(anchor);
    requestAnimationFrame(() => this._syncConnector(card, true));
  }

  /**
   * 트림 commit 후 — viewWin·boxLayout 고정, editRange·오버레이만 갱신.
   * @param {readonly import("../shared/subtitles.js").SubtitleLine[]} cues
   */
  syncFromLineEndTrim(cues) {
    const cue = cues?.[this.cueIndex];
    if (!cue || !this.editor) {
      this._snapLog("sync-from-trim:skip", {
        reason: !cue ? "no-cue" : "no-editor",
      });
      return;
    }
    const before = this.editRange ? { ...this.editRange } : null;
    const start = Number(cue.start) || 0;
    const end = Math.max(start, Number(cue.end) || start);
    this.editRange = { start, end };
    this._snapLog("sync-from-trim", {
      before,
      after: { start, end },
      deltaEnd: before ? end - before.end : null,
    });
    this.editor.setEditRange(this.editRange);
    this.editor.setPreviewCue(cue);
    if (this.playSec != null) {
      this.playSec = Math.max(
        start + CUT_EPS,
        Math.min(end - CUT_EPS, this.playSec),
      );
      playSecByCueIndex.set(this.cueIndex, this.playSec);
    }
    const trimStart = this.root?.querySelector('[data-trim="start"]');
    const trimEnd = this.root?.querySelector('[data-trim="end"]');
    const badge = this.root?.querySelector(".subwave-duration-badge");
    this._syncOverlays(trimStart, trimEnd, badge);
    this._syncSnapGuides();
    this._syncPlayLineDom();
    const meta = this.root?.querySelector(".subwave-meta");
    if (meta) {
      const fmt = this.deps.formatTime || ((s) => `${Number(s).toFixed(2)}s`);
      meta.textContent = `${fmt(start)} – ${fmt(end)}`;
    }
    this.editor._scheduleDraw?.();
    if (this._cardEl) this._syncConnector(this._cardEl, true);
  }

  /** @param {number} clientX */
  _pointerToTimeOnStrip(clientX) {
    const outer = this.root?.querySelector(".subwave-chrome");
    const vw = this.viewWin;
    if (!(outer instanceof HTMLElement) || !vw) return 0;
    const rect = outer.getBoundingClientRect();
    const width = Math.max(rect.width, 1);
    const xPx = Math.max(0, Math.min(width, clientX - rect.left));
    const map = this._getSkipMapping();
    if (map && map.activeSpanSec > 0) return map.pixelToMediaSec(xPx, width);
    const a = Math.min(vw.start, vw.end);
    const b = Math.max(vw.start, vw.end);
    return a + (xPx / width) * (b - a);
  }

  /** @param {'start' | 'end'} edge */
  _maybeExpandViewForTrim(edge, t) {
    void edge;
    void t;
  }

  /**
   * @param {number} t
   * @param {{ notifyHub?: boolean, bypassSnap?: boolean }} [opts]
   */
  _previewEndTrim(t, opts = {}) {
    const cues = this.deps.getCues?.() || [];
    const mediaDur = Number(this.deps.getMediaDurationSec?.()) || 0;
    const snap = this.deps.getSnapGrid?.() || {};
    const lines = applyCueLineEndTrimCoupled(
      cues,
      this.cueIndex,
      t,
      { ...snap, alt: opts.bypassSnap === true },
      mediaDur,
    );
    // 드래그 preview는 커밋과 동일한 SSOT 동기화 흐름(syncCuesAfterWordEdit)을 타야
    // 끝 핸들이 "지멋대로" 되돌아가는 현상을 줄일 수 있다.
    const synced = syncCuesAfterWordEdit(lines);
    const cue = synced?.[this.cueIndex];
    if (!cue) return null;
    const start = Number(cue.start) || 0;
    const end = Math.max(start, Number(cue.end) || start);
    if (!(end > start + 1e-6)) return null;
    if (opts.notifyHub) {
      this.deps.onPreviewCueLineEndTrim?.(this.cueIndex, synced);
    }
    return { lines: synced, start, end };
  }

  /**
   * @param {number} clientX
   * @param {HTMLElement | null} handleStart
   * @param {HTMLElement | null} handleEnd
   * @param {HTMLElement | null} badge
   * @param {{ bypassSnap?: boolean }} [opts]
   */
  _applyEndTrimPreviewAtClientX(clientX, handleStart, handleEnd, badge, opts = {}) {
    const t = this._pointerToTimeOnStrip(clientX);
    const preview = this._previewEndTrim(t, {
      notifyHub: false,
      bypassSnap: opts.bypassSnap === true,
    });
    if (!preview) return null;
    this.editRange = { start: preview.start, end: preview.end };
    const previewCue = preview.lines?.[this.cueIndex];
    if (previewCue) {
      this.editor?.setPreviewCue(previewCue);
    }
    this.editor?.setEditRange(this.editRange);
    if (this.playSec != null) {
      this.playSec = Math.max(
        preview.start + CUT_EPS,
        Math.min(preview.end - CUT_EPS, this.playSec),
      );
    }
    this._syncOverlays(handleStart, handleEnd, badge);
    this._syncPlayLineDom();
    if (this._cardEl) this._syncConnector(this._cardEl);
    return preview;
  }

  _wireTrim(handleStart, handleEnd, badge) {
    const onTrimEnd = (e) => {
      if (!this.editor || !this.viewWin || !this.editRange) return;
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget;
      if (!(target instanceof HTMLElement)) return;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }

      this._trimDragging = "end";
      this._trimBypassSnap = Boolean(e.ctrlKey);
      if (this._isPlayingRange || this.deps.isPlaying?.()) {
        this.finishRangePlay(false);
        this.deps.onPausePlayback?.();
      }
      target.classList.add("is-dragging");
      /** @type {import("../shared/subtitles.js").SubtitleLine[] | null} */
      let lastPreviewLines = null;

      const flushTrimPreview = () => {
        this._trimMoveRaf = 0;
        const clientX = this._trimPendingClientX;
        if (clientX == null) return;
        const preview = this._applyEndTrimPreviewAtClientX(
          clientX,
          handleStart,
          handleEnd,
          badge,
          { bypassSnap: this._trimBypassSnap },
        );
        if (preview) lastPreviewLines = preview.lines;
      };

      const move = (ev) => {
        this._trimPendingClientX = ev.clientX;
        this._trimBypassSnap = Boolean(ev.ctrlKey);
        if (this._trimMoveRaf) return;
        this._trimMoveRaf = requestAnimationFrame(flushTrimPreview);
      };

      const up = (ev) => {
        if (this._trimMoveRaf) {
          cancelAnimationFrame(this._trimMoveRaf);
          this._trimMoveRaf = 0;
        }
        this._trimPendingClientX = ev.clientX;
        this._trimBypassSnap = Boolean(ev.ctrlKey);
        flushTrimPreview();
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        try {
          target.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        target.classList.remove("is-dragging");
        this._trimDragging = null;
        this._trimPendingClientX = null;
        if (!this.editRange) {
          this._trimBypassSnap = false;
          return;
        }
        const cues = this.deps.getCues?.() || [];
        const mediaDur = Number(this.deps.getMediaDurationSec?.()) || 0;
        const snap = this.deps.getSnapGrid?.() || {};
        const lines =
          lastPreviewLines ??
          applyCueLineEndTrimCoupled(
            cues,
            this.cueIndex,
            this.editRange.end,
            { ...snap, alt: this._trimBypassSnap === true },
            mediaDur,
          );
        lineEndSnapLog("drag-commit", {
          cueIndex: this.cueIndex,
          bypassSnap: this._trimBypassSnap === true,
          targetEnd: this.editRange.end,
          linesEnd: Number(lines[this.cueIndex]?.end),
          usedPreview: Boolean(lastPreviewLines),
        });
        this.deps.onCommitCueLineEndTrim?.(this.cueIndex, lines);
        const cuesNow = this.deps.getCues?.() || [];
        const cue = cuesNow[this.cueIndex] ?? lines[this.cueIndex];
        if (cue) {
          const start = Number(cue.start) || 0;
          const end = Math.max(start, Number(cue.end) || start);
          this.editRange = { start, end };
          this.editor?.setPreviewCue(cue);
        }
        this.editor?.setEditRange(this.editRange);
        this._connectorAnchorKey = null;
        this._connectorGeom = null;
        this._syncPlaySecFromRange();
        this._syncPlayLineDom();
        this._syncOverlays(handleStart, handleEnd, badge);
        this._syncSnapGuides();
        const meta = this.root?.querySelector(".subwave-meta");
        if (meta && this.editRange) {
          const fmt = this.deps.formatTime || ((s) => `${Number(s).toFixed(2)}s`);
          meta.textContent = `${fmt(this.editRange.start)} – ${fmt(this.editRange.end)}`;
        }
        this.editor?._scheduleDraw?.();
        this._syncSplitButton();
        this._trimBypassSnap = false;
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    };

    handleEnd?.addEventListener("pointerdown", (e) => {
      onTrimEnd(e);
    });
  }

  /** @param {number} sec */
  _playLinePct(sec) {
    const map = this._getSkipMapping();
    if (!map || sec == null || !Number.isFinite(sec)) return null;
    const span = Math.max(map.activeSpanSec, 1e-9);
    const activeSec = map.mediaSecToActiveSec(sec);
    const pct = Math.max(0, Math.min(100, (activeSec / span) * 100));
    return { pct, sec };
  }

  /** @param {{ fromDrag?: boolean, fromRewind?: boolean }} [opts] */
  _syncPlayLineDom(opts = {}) {
    if (!this.editRange || this.playSec == null) return;
    if (
      this._isPlayLineMotion &&
      !opts.fromDrag &&
      !opts.fromRewind &&
      !this._playDragging
    ) {
      return;
    }
    const pct = this._playLinePct(this.playSec)?.pct;
    if (pct == null) return;
    const left = `${pct}%`;
    const fmt = this.deps.formatTime || ((s) => `${Number(s).toFixed(2)}s`);
    for (const el of [this._playLabelEl, this._playGripEl, this._playSliderEl]) {
      if (!(el instanceof HTMLElement)) continue;
      el.hidden = false;
      el.style.left = left;
    }
    if (this._playLabelEl) this._playLabelEl.textContent = fmt(this.playSec);
    this._syncSplitButton();
  }

  /** @param {number} editT */
  _paintPlayLine(editT) {
    if (this._playDragging || !this.editRange) return;
    const live = this._clampPlaySecToRange(editT, { forDisplay: true });
    this.playSec = live;
    playSecByCueIndex.set(this.cueIndex, live);

    const pct = this._playLinePct(live)?.pct;
    if (pct == null) return;
    const left = `${pct}%`;
    const fmt = this.deps.formatTime || ((s) => `${Number(s).toFixed(2)}s`);
    for (const el of [this._playLabelEl, this._playGripEl, this._playSliderEl]) {
      if (!(el instanceof HTMLElement)) continue;
      el.hidden = false;
      if (el.style.left !== left) el.style.left = left;
    }
    if (this._playLabelEl) {
      const txt = fmt(live);
      if (this._playLabelEl.textContent !== txt) this._playLabelEl.textContent = txt;
    }
    this._syncSplitButton();
  }

  _enterPlayingMotion() {
    this._isPlayLineMotion = true;
    const smooth = `${PLAY_LINE_MOTION_SMOOTH_SEC}s linear`;
    for (const el of [this._playLabelEl, this._playGripEl, this._playSliderEl]) {
      if (!el) continue;
      el.classList.add("is-playing-motion");
      el.style.transition = `left ${smooth}`;
    }
  }

  _exitPlayingMotion() {
    this._isPlayLineMotion = false;
    for (const el of [this._playLabelEl, this._playGripEl, this._playSliderEl]) {
      if (!el) continue;
      el.classList.remove("is-playing-motion");
      el.style.transition = "";
    }
  }

  /** @param {...(HTMLElement | null)} targets */
  _wirePlayLine(...targets) {
    const onPlayLineDown = (grip, e) => {
      if (!this.editRange) return;
      e.stopPropagation();
      e.preventDefault();
      const target = grip;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (this._isPlayLineMotion) this._exitPlayingMotion();
      this._playDragging = true;
      for (const el of [this._playGripEl, this._playSliderEl, this._playLabelEl]) {
        el?.classList.add("is-dragging");
      }

      const scrubTo = (clientX) => {
        const t = this._pointerToTimeOnStrip(clientX);
        const next = this._clampPlaySecToRange(t, { forDisplay: true });
        this.playSec = next;
        playSecByCueIndex.set(this.cueIndex, next);
        this._syncPlayLineDom({ fromDrag: true });
        this.deps.onSeek?.(next);
      };

      scrubTo(e.clientX);

      const move = (ev) => {
        scrubTo(ev.clientX);
      };

      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        this._playDragging = false;
        for (const el of [this._playGripEl, this._playSliderEl, this._playLabelEl]) {
          el?.classList.remove("is-dragging");
        }
        if (this.playSec != null) this.deps.onSeek?.(this.playSec);
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    };

    for (const grip of targets) {
      if (!(grip instanceof HTMLElement)) continue;
      grip.addEventListener("pointerdown", (e) => onPlayLineDown(grip, e));
    }
  }

  _wireActions() {
    this.root?.querySelector('[data-act="play"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      this._togglePlayFromPlayLine();
    });
    for (const sec of [0.3, 0.5]) {
      this.root?.querySelector(`[data-act="tail-${sec}"]`)?.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePlayTailOffset(sec);
      });
    }
    this._syncTailOffsetButtons();
    this._unsubTailOffset?.();
    this._unsubTailOffset = onPlayTailOffsetChange(() => this._syncTailOffsetButtons());
    this.root?.querySelector('[data-act="split"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      this._splitAtPlayLine();
    });
    this.root?.querySelector('[data-act="close"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.deps.onClose?.();
    });
  }

  _syncTailOffsetButtons() {
    const active = getPlayTailOffsetSec();
    for (const sec of [0.3, 0.5]) {
      const btn = this.root?.querySelector(`[data-act="tail-${sec}"]`);
      if (!(btn instanceof HTMLButtonElement)) continue;
      const on = active === sec;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  _syncSplitButton() {
    const btn = this.root?.querySelector('[data-act="split"]');
    if (!(btn instanceof HTMLButtonElement)) return;
    if (!this.editRange || this.playSec == null) {
      btn.disabled = true;
      return;
    }
    const s = Math.min(this.editRange.start, this.editRange.end);
    const e = Math.max(this.editRange.start, this.editRange.end);
    const margin = Math.max(CUT_EPS * 4, PLAY_LINE_SPLIT_MARGIN_SEC);
    btn.disabled = this.playSec <= s + margin || this.playSec >= e - margin;
  }

  _splitAtPlayLine() {
    if (this.playSec == null || !this.editRange) return;
    const s = Math.min(this.editRange.start, this.editRange.end);
    const e = Math.max(this.editRange.start, this.editRange.end);
    const margin = Math.max(CUT_EPS * 4, PLAY_LINE_SPLIT_MARGIN_SEC);
    const t = this.playSec;
    if (t <= s + margin || t >= e - margin) return;

    if (this.deps.isPlaying?.()) {
      this.deps.onPausePlayback?.();
    }
    this.finishRangePlay(false, { playheadEditSec: t });
    this.deps.onSplitCueAtPlayLine?.(this.cueIndex, t);
  }

  _pausePlaybackIfAllowed() {
    if (!this.deps.isPlaying?.()) return false;
    const elapsed = performance.now() - lastWaveformPlayStartMs;
    if (elapsed < WAVEFORM_PLAY_START_GUARD_MS) return true;
    this.deps.onPausePlayback?.();
    return true;
  }

  _togglePlayFromPlayLine() {
    if (!this.editRange || this.playSec == null) return;
    if (this.deps.isPlaying?.()) {
      this._pausePlaybackIfAllowed();
      return;
    }
    const s = Math.min(this.editRange.start, this.editRange.end);
    const e = Math.max(this.editRange.start, this.editRange.end);
    const playheadEdit = this.deps.getPlayheadEditSec?.() ?? this.deps.getPlayheadSec?.();
    const tailOffset = getPlayTailOffsetSec();
    let startT = resolveLineWaveformPlayStart(
      this.editRange,
      this.playSec,
      playheadEdit,
      tailOffset,
      CUT_EPS,
    );
    if (tailOffset != null) {
      this.playSec = startT;
      playSecByCueIndex.set(this.cueIndex, startT);
      this._syncPlayLineDom();
    } else if (
      Number.isFinite(playheadEdit) &&
      playheadEdit > s + CUT_EPS &&
      playheadEdit < e - CUT_EPS
    ) {
      startT = playheadEdit;
      this.playSec = playheadEdit;
      playSecByCueIndex.set(this.cueIndex, playheadEdit);
    }
    const clamped = this._clampPlaySecToRange(startT);
    lastWaveformPlayStartMs = performance.now();
    this._isPlayingRange = true;
    this.beginRangePlay(clamped);
    this.deps.onPlayEditRange?.(clamped, e);
  }

  _bindKeys() {
    this._unbindKeys();
    this._boundKeydown = (e) => {
      if (e.code !== "Space" && e.key !== " ") return;
      if (!this.deps.isWaveformPanelActive?.()) return;
      const tag = e.target instanceof Element ? e.target.tagName : "";
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      if (!this.root?.querySelector("[data-subwave-flow]")) return;
      if (shouldDeferWaveformSpaceToCaret()) return;
      e.preventDefault();
      e.stopPropagation();
      if (this._pausePlaybackIfAllowed()) return;
      this._togglePlayFromPlayLine();
    };
    document.addEventListener("keydown", this._boundKeydown, { capture: true });
  }

  _unbindKeys() {
    if (!this._boundKeydown) return;
    document.removeEventListener("keydown", this._boundKeydown, { capture: true });
    this._boundKeydown = null;
  }
}
