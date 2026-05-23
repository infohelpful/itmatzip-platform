/**
 * AutoSubtitle SubtitleWaveformCanvas — 펼친 줄 단어 파형 + 자르기 라인.
 */

import { WaveformContextEditor } from "./waveform-context-editor.js";
import {
  computeWordContextForCue,
  computeWordContextWindow,
  waveformContextWordEntries,
} from "./line-zoom-window.js";
import { resolvePeaksTimelineMetrics } from "./peaks-metrics.js";
import { applyCueWordEdgeDrag, getCueWords, visibleWords } from "./subtitle-words.js";
import { buildEdlSkipMapping } from "./waveform/edl-skip-mapping.js";
import { collectDeletedRangesSec } from "./word-waveform-draw.js";
import {
  cardBoundsDeltaForStrip,
  computeFirstBoxLayoutPx,
  computeRelockBoxLayoutPx,
  findActiveWordChip,
  scheduleSubwavePanelLeftPx,
} from "./waveform/subwave-panel-layout.js";
import {
  computeConnectorGeom,
  computeTrimHandlePct,
  ensureConnectorOverlayHost,
  paintConnectorOverlay,
} from "./waveform/waveform-connector-geom.js";
import { splitWordAtMediaSecInLines } from "./shared/split-word-actions.js";
import {
  shouldDeferWaveformSpaceToCaret,
} from "./subtitle-list/word-caret-ui.js";
import { registerWaveformPanel, unregisterWaveformPanel } from "./waveform-panel-registry.js";

const MIN_SPLIT_SEC = 0.02;
const MIN_TRIM_SPAN_SEC = 0.038;
const CUT_EPS = 1e-4;
const CUT_SNAP_MS = 220;

/** @type {Map<string, number>} activeWordId → 사용자가 잡은 cutSec */
const cutSecByWordId = new Map();

/**
 * @param {object | null | undefined} peaks
 * @param {number | null | undefined} durHint
 */
function peaksMetricsForPanel(peaks, durHint) {
  return resolvePeaksTimelineMetrics(peaks, durHint ?? undefined);
}

export class LineWaveformPanel {
  constructor(root, deps) {
    this.root = root;
    this.deps = deps;
    this.cueIndex = -1;
    this.focusWordIndex = -1;
    this.editor = null;
    this.viewWin = null;
    this.editRange = null;
    this.cutSec = null;
    this._connectorAnchorKey = null;
    this._connectorGeom = null;
    this._connectorRo = null;
    this._trimDragging = null;
    this._cutDragging = false;
    /** @type {'cut' | null} */
    this._draggingHandle = null;
    this._cutLineUserPositioned = false;
    this._playStartSec = null;
    this._isPlayingRange = false;
    this._isCutLinePlayingMotion = false;
    this._cutSecLastWordId = null;
    this._cutLabelEl = null;
    this._cutGripEl = null;
    this._cutSliderEl = null;
    this._boundKeydown = null;
    this.boxLayoutPx = null;
    this.lockedPpsWordId = null;
    this.pps = null;
    this.frozenViewWin = null;
    this.lastTrimEdge = null;
    this.viewWinAnchorKey = null;
    this._stage1WordId = null;
    this._cleanupPanelLeft = null;
    this._cardEl = null;
  }

  show(cueIndex, wordIndex) {
    registerWaveformPanel(this);
    this.cueIndex = cueIndex;
    this.focusWordIndex = wordIndex;
    this._connectorAnchorKey = null;
    this._connectorGeom = null;
    this.boxLayoutPx = null;
    this.lockedPpsWordId = null;
    this.pps = null;
    this.frozenViewWin = null;
    this.lastTrimEdge = null;
    this.viewWinAnchorKey = null;
    this._stage1WordId = null;
    void this._renderAsync();
  }

  hide() {
    unregisterWaveformPanel(this);
    this.finishRangePlay(false);
    this._unbindKeys();
    this._connectorRo?.disconnect();
    this._connectorRo = null;
    this._connectorAnchorKey = null;
    this._connectorGeom = null;
    this._cleanupPanelLeft?.();
    this._cleanupPanelLeft = null;
    this._stage1WordId = null;
    this.boxLayoutPx = null;
    this.lockedPpsWordId = null;
    this.pps = null;
    this.frozenViewWin = null;
    this.lastTrimEdge = null;
    this.viewWinAnchorKey = null;
    if (this.root instanceof HTMLElement) {
      this.root.style.removeProperty("--subwave-panel-left-px");
    }
    const card = this.deps.getCard?.();
    card?.querySelector(".subwave-connector-overlay")?.remove();
    this.editor?.destroy();
    if (this.root) this.root.innerHTML = "";
    this.editor = null;
    this.viewWin = null;
    this.editRange = null;
    this.cutSec = null;
    this._cutSecLastWordId = null;
    this._cutLabelEl = null;
    this._cutGripEl = null;
    this._cutSliderEl = null;
    this.cueIndex = -1;
    this.focusWordIndex = -1;
  }

  /** @param {boolean} [animate] @param {{ rewindToTrimStart?: boolean, playheadEditSec?: number }} [opts] */
  finishRangePlay(animate = true, opts = {}) {
    const shouldRewind = opts.rewindToTrimStart === true;
    const shouldSyncPlayhead = Number.isFinite(opts.playheadEditSec);
    if (
      !this._isPlayingRange &&
      !this._isCutLinePlayingMotion &&
      !shouldRewind &&
      !shouldSyncPlayhead
    ) {
      return;
    }
    this._isPlayingRange = false;
    this._playStartSec = null;
    this._exitPlayingMotion();

    if (!this.editRange) return;

    if (shouldRewind) {
      const s = Math.min(this.editRange.start, this.editRange.end);
      const e = Math.max(this.editRange.start, this.editRange.end);
      this.cutSec = Math.min(e - CUT_EPS, s + CUT_EPS);
      this._cutLineUserPositioned = false;
      const wid = this._activeWordId();
      if (wid) cutSecByWordId.set(wid, this.cutSec);
      this._rewindCutLineToTrimStart(animate);
      return;
    }

    if (shouldSyncPlayhead) {
      const s = Math.min(this.editRange.start, this.editRange.end);
      const e = Math.max(this.editRange.start, this.editRange.end);
      const clamped = Math.min(e - CUT_EPS, Math.max(s + CUT_EPS, opts.playheadEditSec));
      this.cutSec = clamped;
      this._cutLineUserPositioned = true;
      const wid = this._activeWordId();
      if (wid) cutSecByWordId.set(wid, clamped);
    }
    this._syncCutLineDom();
  }

  /** @param {number} startEditSec */
  beginRangePlay(startEditSec) {
    this._isPlayingRange = true;
    this._playStartSec = startEditSec;
    this._enterPlayingMotion();
    if (Number.isFinite(startEditSec)) {
      requestAnimationFrame(() => {
        if (this._isPlayingRange && this.deps.isPlaying?.()) {
          this.paintCutLine(startEditSec);
        }
      });
    }
  }

  /** @param {number} editSec */
  syncPlayheadFromEditSec(editSec) {
    if (this._cutDragging) return;
    if (!this._isPlayingRange || !this.deps.isPlaying?.()) {
      this.editor?._scheduleDraw?.();
      if (this._cardEl) this._syncConnector(this._cardEl);
      return;
    }
    if (!this._isCutLinePlayingMotion) this._enterPlayingMotion();
    this.paintCutLine(editSec);
  }

  /** @param {number} editT */
  paintCutLine(editT) {
    if (this._cutDragging || !this.editRange) return;
    const map = this._getSkipMapping();
    if (!map || !Number.isFinite(editT)) return;

    const s = Math.min(this.editRange.start, this.editRange.end);
    const e = Math.max(this.editRange.start, this.editRange.end);
    if (e - s <= CUT_EPS) return;

    const live = Math.min(e, Math.max(s, editT));
    const pct = this._cutLinePct(live)?.pct;
    if (pct == null) return;

    const left = `${pct}%`;
    const fmt = this.deps.formatTime || this._fmt.bind(this);
    if (this._cutLabelEl) {
      if (this._cutLabelEl.style.left !== left) this._cutLabelEl.style.left = left;
      const txt = fmt(live);
      if (this._cutLabelEl.textContent !== txt) this._cutLabelEl.textContent = txt;
    }
    if (this._cutGripEl && this._cutGripEl.style.left !== left) {
      this._cutGripEl.style.left = left;
    }
    if (this._cutSliderEl && this._cutSliderEl.style.left !== left) {
      this._cutSliderEl.style.left = left;
    }
  }

  syncPlayhead() {
    if (this.deps.isPlaying?.() && this._isPlayingRange) return;
    if (
      this.editRange &&
      this.cutSec != null &&
      !this._isCutLinePlayingMotion &&
      !this._cutDragging
    ) {
      this._syncCutLineDom();
    }
    this.editor?._scheduleDraw?.();
    if (this._cardEl) this._syncConnector(this._cardEl);
  }

  refreshPlaybackSkipRanges() {
    const skips = this.deps.getPlaybackSkipRanges?.() || [];
    this.editor?.setPlaybackSkipRanges(skips);
    this.editor?.drawImmediate?.();
  }

  async _renderAsync() {
    if (!this.root) return;
    const cues = this.deps.getCues();
    const cue = cues[this.cueIndex];
    if (!cue) return;

    const words = getCueWords(cue);
    const w = words[this.focusWordIndex];
    if (!w || w.is_deleted) {
      this.root.innerHTML = `<p class="subwave-meta">단어를 찾을 수 없습니다.</p>`;
      return;
    }

    this.root.innerHTML = `<p class="subwave-meta">오디오 파형 준비 중…</p>`;

    const durHint = this.deps.getMediaDurationSec?.() ?? null;
    let peaks = this.deps.getPeaksData();
    let metrics = peaksMetricsForPanel(peaks, durHint);
    if (!metrics && this.deps.ensurePeaksLoad) {
      await this.deps.ensurePeaksLoad();
      peaks = this.deps.getPeaksData();
      metrics = peaksMetricsForPanel(peaks, durHint);
    }

    if (!metrics) {
      this.root.innerHTML = `<p class="subwave-meta">파형 데이터가 없습니다. 영상을 선택한 뒤 잠시 기다렸다가 다시 더블클릭하세요.</p>`;
      return;
    }

    const dur = metrics.durationSec;
    const ctxWin = computeWordContextForCue(cue, this.focusWordIndex, dur);
    if (!ctxWin) {
      this.root.innerHTML = `<p class="subwave-meta">줌 구간을 계산할 수 없습니다.</p>`;
      return;
    }

    const keepFrozenWin =
      this.lockedPpsWordId != null && !this.lastTrimEdge && this.frozenViewWin != null;
    this.viewWin = keepFrozenWin
      ? { ...this.frozenViewWin }
      : { start: ctxWin.windowStart, end: ctxWin.windowEnd };

    const es = Math.min(w.start, w.end);
    const ee = Math.max(w.start, w.end);
    this.editRange = { start: es, end: ee };
    this._syncCutSecFromEditRange();
    this._panelMediaDurHint = dur;
    this._renderPanel(cue, peaks, w);
  }

  _renderPanel(cue, peaks, w) {
    if (!this.root || !this.viewWin || !this.editRange) return;

    const fmt = this.deps.formatTime || this._fmt.bind(this);
    const spanSec = Math.max(this.editRange.end - this.editRange.start, MIN_SPLIT_SEC);
    const card = this.deps.getCard?.() ?? null;
    const cacheHint = peaks.from_cache ? " · 캐시" : "";

    this.root.innerHTML = `
      <div class="subwave-flow-root" tabindex="0" data-subwave-flow>
        <div class="subwave-stage">
          <div class="subwave-box" data-wave-strip>
            <div class="subwave-cut-rail" data-cut-rail>
              <span class="subwave-cut-label" data-cut-label hidden></span>
              <div class="subwave-cut-grip" data-cut-grip hidden title="자르기 위치 (드래그)"></div>
            </div>
            <div class="subwave-chrome">
              <div class="subwave-canvas-wrap">
                <canvas class="subwave-canvas" aria-label="단어 파형"></canvas>
              </div>
              <div class="subwave-trim-handles" aria-hidden="false">
                <div class="subwave-trim-handle subwave-trim-handle--start" data-trim="start" title="시작 조절"></div>
                <div class="subwave-trim-handle subwave-trim-handle--end" data-trim="end" title="끝 조절"></div>
              </div>
              <div class="subwave-cut-line" data-cut-slider hidden aria-hidden="true"></div>
            </div>
            <p class="subwave-duration-badge">${spanSec.toFixed(1)}초</p>
            <div class="subwave-actions">
              <button type="button" class="subwave-btn" data-act="play" title="자르기 위치부터 재생 (Space)">▶</button>
              <button type="button" class="subwave-btn" data-act="split" title="자르기로 단어 분할" disabled aria-label="자르기 라인 위치에서 단어 분할">✂</button>
              <button type="button" class="subwave-btn" data-act="undo" title="되돌리기 (Ctrl+Z)">↩</button>
              <button type="button" class="subwave-btn subwave-btn--close" data-act="close" title="닫기">✕</button>
            </div>
            <p class="subwave-meta">${fmt(w.start)} – ${fmt(w.end)}${cacheHint}</p>
          </div>
        </div>
      </div>
    `;

    const flow = this.root.querySelector("[data-subwave-flow]");
    const canvas = this.root.querySelector(".subwave-canvas");
    const canvasWrap = this.root.querySelector(".subwave-canvas-wrap");
    const trimStart = this.root.querySelector('[data-trim="start"]');
    const trimEnd = this.root.querySelector('[data-trim="end"]');
    this._cutLabelEl = this.root.querySelector("[data-cut-label]");
    this._cutGripEl = this.root.querySelector("[data-cut-grip]");
    this._cutSliderEl = this.root.querySelector("[data-cut-slider]");
    const badge = this.root.querySelector(".subwave-duration-badge");

    if (!(canvas instanceof HTMLCanvasElement) || !(canvasWrap instanceof HTMLElement)) return;

    this.editor = new WaveformContextEditor(canvas);
    this.editor.setMediaDurationHint(
      this._panelMediaDurHint ?? this.deps.getMediaDurationSec?.() ?? null,
    );
    this.editor.setPeaks(peaks);
    this.editor.setViewWindow(this.viewWin);
    this.editor.setEditRange(this.editRange);
    this.editor.setPlaybackSkipRanges(this.deps.getPlaybackSkipRanges?.() || []);
    this.editor.setFocus(this.cueIndex, this.focusWordIndex, cue);

    this._applyBoxLayoutLock(cue, w, peaks);
    this._applyBoxLayoutToDom();
    this._syncOverlays(trimStart, trimEnd, badge);
    this._syncCutLineDom();
    this._syncSplitButton();
    this._syncConnector(card);

    this._wireTrim(trimStart, trimEnd, badge);
    this._wireCutLine(this._cutGripEl);
    this._wireActions(cue);

    flow?.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (e.code === "Space" || e.key === " ") {
        if (!this.deps.isWaveformPanelActive?.()) return;
        if (shouldDeferWaveformSpaceToCaret()) return;
        e.preventDefault();
        if (this.deps.isPlaying?.()) {
          this.deps.onPausePlayback?.();
          return;
        }
        this._togglePlayFromCut();
      }
    });

    this._bindKeys();

    requestAnimationFrame(() => {
      this._applyBoxLayoutLock(cue, w, peaks, 1);
      this._applyBoxLayoutToDom();
      this._nudgeBoxInsideCard(card);
      this.editor?._scheduleDraw?.();
      this._syncOverlays(trimStart, trimEnd, badge);
      this._syncCutLineDom();
      this._syncConnector(card);
    });

    this._cardEl = card;
    this._scheduleConnectorMeasure(card);
  }

  /** @param {HTMLElement | null} card */
  _getActiveWordId(card) {
    const chip = findActiveWordChip(card, null);
    const id = chip?.getAttribute("data-word-id");
    if (id) return id;
    return `${this.cueIndex}:${this.focusWordIndex}`;
  }

  /** @param {HTMLElement | null} card */
  _activeWordId(card = null) {
    const c = card ?? this.deps.getCard?.() ?? null;
    return this._getActiveWordId(c);
  }

  _syncCutSecFromEditRange() {
    if (!this.editRange) {
      this.cutSec = null;
      this._cutSecLastWordId = null;
      return;
    }
    const wordId = this._activeWordId();
    const s = Math.min(this.editRange.start, this.editRange.end);
    const e = Math.max(this.editRange.start, this.editRange.end);
    const startCut = Math.min(e - CUT_EPS, s + CUT_EPS);
    const wordChanged = Boolean(wordId) && this._cutSecLastWordId !== wordId;
    this._cutSecLastWordId = wordId;
    const stored = wordId ? cutSecByWordId.get(wordId) : undefined;
    if (wordChanged || this.cutSec == null || !Number.isFinite(this.cutSec)) {
      this.cutSec = stored ?? startCut;
    } else if (stored != null && Number.isFinite(stored)) {
      this.cutSec = stored;
    }
    if (this.cutSec <= s + CUT_EPS) this.cutSec = s + CUT_EPS;
    else if (this.cutSec >= e - CUT_EPS) this.cutSec = e - CUT_EPS;
    if (wordId) cutSecByWordId.set(wordId, this.cutSec);
    if (Math.abs(this.cutSec - startCut) > CUT_EPS) {
      this._cutLineUserPositioned = true;
    } else if (wordChanged) {
      this._cutLineUserPositioned = false;
    }
  }

  /** @param {number} sec */
  _cutLinePct(sec) {
    const map = this._getSkipMapping();
    if (!map || sec == null || !Number.isFinite(sec)) return null;
    const span = Math.max(map.activeSpanSec, 1e-9);
    const activeSec = map.mediaSecToActiveSec(sec);
    const pct = Math.max(0, Math.min(100, (activeSec / span) * 100));
    return { pct, sec };
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
    if (map && map.activeSpanSec > 0) {
      return map.pixelToMediaSec(xPx, width);
    }
    const a = Math.min(vw.start, vw.end);
    const b = Math.max(vw.start, vw.end);
    return a + (xPx / width) * (b - a);
  }

  /** @param {number} t */
  _clampCutSecToEditRange(t) {
    const er = this.editRange;
    if (!er) return null;
    const s = Math.min(er.start, er.end);
    const eEnd = Math.max(er.start, er.end);
    return Math.min(eEnd - CUT_EPS, Math.max(s + CUT_EPS, t));
  }

  /** @param {number} nextSec */
  _setCutSecFromDrag(nextSec) {
    if (!Number.isFinite(nextSec)) return;
    this.cutSec = nextSec;
    this._cutLineUserPositioned = true;
    const wid = this._activeWordId();
    if (wid) cutSecByWordId.set(wid, nextSec);
    this._syncCutLineDom({ fromDrag: true });
  }

  _enterPlayingMotion() {
    this._isCutLinePlayingMotion = true;
    for (const el of [this._cutLabelEl, this._cutGripEl, this._cutSliderEl]) {
      if (!el) continue;
      el.classList.add("is-playing-motion");
      el.style.willChange = "left";
    }
  }

  _exitPlayingMotion() {
    this._isCutLinePlayingMotion = false;
    for (const el of [this._cutLabelEl, this._cutGripEl, this._cutSliderEl]) {
      if (!el) continue;
      el.classList.remove("is-playing-motion");
      el.style.willChange = "";
    }
  }

  /** @param {boolean} [animate] */
  _rewindCutLineToTrimStart(animate) {
    const targets = [this._cutLabelEl, this._cutGripEl, this._cutSliderEl].filter(
      (el) => el instanceof HTMLElement,
    );
    if (animate && targets.length) {
      for (const el of targets) {
        el.classList.add("is-snapping-home");
        el.style.willChange = "left";
      }
      requestAnimationFrame(() => {
        this._syncCutLineDom({ fromRewind: true });
      });
      window.setTimeout(() => {
        for (const el of targets) {
          el.classList.remove("is-snapping-home");
          el.style.willChange = "";
        }
      }, CUT_SNAP_MS + 40);
      return;
    }
    this._syncCutLineDom({ fromRewind: true });
  }

  /** @param {boolean} [animate] */
  _snapCutLineHome(animate) {
    this._rewindCutLineToTrimStart(animate);
  }

  /** @param {{ fromDrag?: boolean, fromRewind?: boolean }} [opts] */
  _syncCutLineDom(opts = {}) {
    if (!this.editRange || this.cutSec == null) return;
    if (this._isCutLinePlayingMotion && !opts.fromDrag && !opts.fromRewind && !this._cutDragging) {
      return;
    }
    const pct = this._cutLinePct(this.cutSec)?.pct;
    if (pct == null) return;
    const left = `${pct}%`;
    const fmt = this.deps.formatTime || this._fmt.bind(this);
    if (!this._cutLabelEl || !this._cutGripEl || !this._cutSliderEl) return;
    this._cutLabelEl.hidden = false;
    this._cutGripEl.hidden = false;
    this._cutSliderEl.hidden = false;
    this._cutLabelEl.style.left = left;
    this._cutGripEl.style.left = left;
    this._cutSliderEl.style.left = left;
    this._cutLabelEl.textContent = fmt(this.cutSec);
    this._syncSplitButton();
  }

  _applyBoxLayoutLock(cue, w, peaks, retry = 0) {
    const card = this.deps.getCard?.();
    const mount = this.root;
    if (!(mount instanceof HTMLElement) || !card) return false;

    const activeWordId = this._getActiveWordId(card);
    const chip = findActiveWordChip(card, activeWordId);
    if (!chip) {
      if (retry < 12) {
        requestAnimationFrame(() => {
          this._applyBoxLayoutLock(cue, w, peaks, retry + 1);
          this._applyBoxLayoutToDom();
        });
      }
      return false;
    }

    if (this._stage1WordId !== activeWordId) {
      this._cleanupPanelLeft?.();
      this._cleanupPanelLeft = scheduleSubwavePanelLeftPx(mount, card, activeWordId);
      this._stage1WordId = activeWordId;
    }

    const { visible, storageIdx } = waveformContextWordEntries(cue);
    const visIdx = storageIdx.indexOf(this.focusWordIndex);
    if (visIdx < 0) return false;

    const durHint = this.deps.getMediaDurationSec?.() ?? null;
    const metrics = peaksMetricsForPanel(peaks, durHint);
    const dur = metrics?.durationSec ?? durHint ?? 0;
    if (!(dur > 0)) return false;

    const ctxWin = computeWordContextWindow(visible, visIdx, 0, 0, {
      mediaDurationSec: dur,
    });
    if (!ctxWin) return false;

    const skips = this.deps.getPlaybackSkipRanges?.() || [];
    const es = Math.min(w.start, w.end);
    const ee = Math.max(w.start, w.end);
    const anchorKey = `${activeWordId}|${es}:${ee}`;
    const isFirstLock = this.lockedPpsWordId !== activeWordId;

    if (isFirstLock) {
      const layout = computeFirstBoxLayoutPx({
        mount,
        card,
        chipEl: chip,
        activeWord: { start: es, end: ee },
        ctxWin,
        skipRanges: skips,
      });
      if (!layout) {
        if (retry < 12) {
          requestAnimationFrame(() => {
            this._applyBoxLayoutLock(cue, w, peaks, retry + 1);
            this._applyBoxLayoutToDom();
          });
        }
        return false;
      }
      this.boxLayoutPx = { left: layout.left, width: layout.width };
      this.pps = layout.pps;
      this.frozenViewWin = { ...layout.viewWin };
      this.viewWin = { ...layout.viewWin };
      this.lockedPpsWordId = activeWordId;
      this.viewWinAnchorKey = anchorKey;
      this.editor?.setViewWindow(this.viewWin);
    } else if (
      this.lastTrimEdge &&
      this.viewWinAnchorKey !== anchorKey &&
      this.pps != null &&
      this.boxLayoutPx &&
      this.frozenViewWin
    ) {
      const re = computeRelockBoxLayoutPx({
        dir: this.lastTrimEdge,
        prevWin: this.frozenViewWin,
        prevLayout: this.boxLayoutPx,
        pps: this.pps,
        ctxWin,
        skipRanges: skips,
      });
      this.boxLayoutPx = { left: re.left, width: re.width };
      this.frozenViewWin = { ...re.viewWin };
      this.viewWin = { ...re.viewWin };
      this.viewWinAnchorKey = anchorKey;
      this.lastTrimEdge = null;
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

  _nudgeBoxInsideCard(card) {
    if (!this.boxLayoutPx || !card) return;
    const box = this.root?.querySelector("[data-wave-strip]");
    if (!(box instanceof HTMLElement)) return;
    const delta = cardBoundsDeltaForStrip(this.boxLayoutPx, card, box);
    if (Math.abs(delta) < 0.25) return;
    this.boxLayoutPx = { ...this.boxLayoutPx, left: this.boxLayoutPx.left + delta };
    this._applyBoxLayoutToDom();
  }

  _getSkipMapping() {
    if (!this.viewWin) return null;
    const v0 = Math.min(this.viewWin.start, this.viewWin.end);
    const v1 = Math.max(this.viewWin.start, this.viewWin.end);
    const skips = [...(this.deps.getPlaybackSkipRanges?.() || [])];
    const cues = this.deps.getCues?.();
    const cue = cues?.[this.cueIndex];
    if (cue) {
      skips.push(...collectDeletedRangesSec(getCueWords(cue), v0, v1));
    }
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

  _syncConnector(card, force = false) {
    if (!card || !this.root || !this.editRange) return;

    const chip =
      card.querySelector('[data-waveform-active-word-chip="1"]') ||
      card.querySelector(".subtitle-word-chip.is-selected");
    const activeWordId = chip?.dataset?.wordId ?? "";
    const waveBox = this.root.querySelector(".subwave-chrome");
    if (!activeWordId || !(waveBox instanceof HTMLElement)) {
      paintConnectorOverlay(ensureConnectorOverlayHost(card), null);
      return;
    }

    const trimPct = this._getTrimHandlePct();
    if (!trimPct) return;

    const anchorKey = `${this.cueIndex}|${activeWordId}`;
    if (!force && this._connectorAnchorKey === anchorKey && this._connectorGeom) {
      paintConnectorOverlay(ensureConnectorOverlayHost(card), this._connectorGeom);
      return;
    }

    const geom = computeConnectorGeom(card, waveBox, activeWordId, trimPct);
    if (!geom) {
      paintConnectorOverlay(ensureConnectorOverlayHost(card), null);
      return;
    }
    this._connectorAnchorKey = anchorKey;
    this._connectorGeom = geom;
    paintConnectorOverlay(ensureConnectorOverlayHost(card), geom);
  }

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
    requestAnimationFrame(() => this._syncConnector(card, true));
  }

  /** @param {'start' | 'end'} edge @param {number} newSec */
  _previewTrimEditRange(edge, newSec) {
    if (!this.viewWin || !Number.isFinite(newSec)) return null;
    const cues = this.deps.getCues();
    const preview = applyCueWordEdgeDrag(
      cues,
      this.cueIndex,
      this.focusWordIndex,
      edge,
      newSec,
      false,
    );
    const cue = preview[this.cueIndex];
    const words = getCueWords(cue);
    const w = words[this.focusWordIndex];
    if (!w || w.is_deleted) return null;
    const lo = Math.min(w.start, w.end);
    const hi = Math.max(w.start, w.end);
    const ws = Math.min(this.viewWin.start, this.viewWin.end);
    const we = Math.max(this.viewWin.start, this.viewWin.end);
    return {
      start: Math.max(ws, lo),
      end: Math.min(we, hi),
    };
  }

  _wireTrim(handleStart, handleEnd, badge) {
    const onTrim = (edge, e) => {
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

      const move = (ev) => {
        const t = this._pointerToTimeOnStrip(ev.clientX);
        const er = this._previewTrimEditRange(edge, t);
        if (!er) return;
        if (er.end - er.start < MIN_TRIM_SPAN_SEC) return;
        this.editRange = er;
        this.editor.setEditRange(er);
        this.editor.drawImmediate();
        if (this.cutSec != null) {
          this.cutSec = Math.max(er.start + CUT_EPS, Math.min(er.end - CUT_EPS, this.cutSec));
          const wid = this._activeWordId();
          if (wid) cutSecByWordId.set(wid, this.cutSec);
        }
        this._trimDragging = edge;
        this._syncOverlays(handleStart, handleEnd, badge);
        this._syncCutLineDom();
      };

      const up = (ev) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        try {
          target.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        if (!this.editRange || !this._trimDragging) {
          this._trimDragging = null;
          return;
        }
        const edgeNow = this._trimDragging;
        this._trimDragging = null;
        this.lastTrimEdge = edgeNow;
        const newSec = edgeNow === "start" ? this.editRange.start : this.editRange.end;
        const cues = this.deps.getCues();
        const result = applyCueWordEdgeDrag(
          cues,
          this.cueIndex,
          this.focusWordIndex,
          edgeNow,
          newSec,
          true,
        );
        const updated = result[this.cueIndex];
        if (updated && this.deps.onApplySubtitleChange) {
          this.deps.onApplySubtitleChange(() => result, {
            cueIndex: this.cueIndex,
            focusWordIndex: this.focusWordIndex,
          });
        }
        this._connectorAnchorKey = null;
        this._connectorGeom = null;
        void this._renderAsync();
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    };

    handleStart?.addEventListener("pointerdown", (e) => onTrim("start", e));
    handleEnd?.addEventListener("pointerdown", (e) => onTrim("end", e));
  }

  /** @param {HTMLElement | null} cutGrip */
  _wireCutLine(cutGrip) {
    if (!(cutGrip instanceof HTMLElement)) return;
    cutGrip.addEventListener("pointerdown", (e) => {
      if (!this.editRange) return;
      e.stopPropagation();
      e.preventDefault();

      const target = e.currentTarget;
      if (!(target instanceof HTMLElement)) return;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }

      if (this._isCutLinePlayingMotion) this._exitPlayingMotion();
      this._draggingHandle = "cut";
      this._cutDragging = true;
      target.classList.add("is-dragging");
      this._cutSliderEl?.classList.add("is-dragging");

      const move = (ev) => {
        const er = this.editRange;
        if (!er) return;
        const t = this._pointerToTimeOnStrip(ev.clientX);
        const next = this._clampCutSecToEditRange(t);
        if (next == null) return;
        this._setCutSecFromDrag(next);
      };

      const up = (ev) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        try {
          target.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        this._draggingHandle = null;
        this._cutDragging = false;
        target.classList.remove("is-dragging");
        this._cutSliderEl?.classList.remove("is-dragging");
        this._syncCutLineDom({ fromDrag: true });
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
  }

  _syncSplitButton() {
    const btn = this.root?.querySelector('[data-act="split"]');
    if (!(btn instanceof HTMLButtonElement)) return;
    const disabled = !this.editRange || this.cutSec == null || this.focusWordIndex < 0;
    btn.disabled = disabled;
  }

  _wireActions(cue) {
    this.root?.querySelector('[data-act="play"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      this._togglePlayFromCut();
    });
    const splitBtn = this.root?.querySelector('[data-act="split"]');
    splitBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this._splitAtCut();
    });
    this.root?.querySelector('[data-act="undo"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.deps.onUndo?.();
    });
    this.root?.querySelector('[data-act="close"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.deps.onClose?.();
    });
  }

  togglePlayFromCut() {
    this._togglePlayFromCut();
  }

  _togglePlayFromCut() {
    if (!this.editRange || this.cutSec == null) return;
    if (this.deps.isPlaying?.()) {
      this.deps.onPausePlayback?.();
      return;
    }
    const s = Math.min(this.editRange.start, this.editRange.end);
    const e = Math.max(this.editRange.start, this.editRange.end);
    let startT = this.cutSec;
    const playheadEdit = this.deps.getPlayheadEditSec?.();
    if (
      Number.isFinite(playheadEdit) &&
      playheadEdit > s + CUT_EPS &&
      playheadEdit < e - CUT_EPS &&
      playheadEdit > startT + 0.02
    ) {
      startT = playheadEdit;
      this.cutSec = playheadEdit;
      this._cutLineUserPositioned = true;
      const wid = this._activeWordId();
      if (wid) cutSecByWordId.set(wid, playheadEdit);
    }
    if (startT >= e - 0.05) startT = s;
    const clamped = Math.min(e - CUT_EPS, Math.max(s + CUT_EPS, startT));
    this.beginRangePlay(clamped);
    this.deps.onPlayEditRange?.(clamped, e);
  }

  _splitAtCut() {
    if (this.cutSec == null || !this.editRange || this.focusWordIndex < 0) return;

    const cues = this.deps.getCues();
    const cue = cues[this.cueIndex];
    if (!cue) return;

    const { storageIdx } = waveformContextWordEntries(cue);
    const visIdx = storageIdx.indexOf(this.focusWordIndex);
    if (visIdx < 0) return;

    this.deps.onBeforeWordSplit?.();

    const result = splitWordAtMediaSecInLines(
      cues,
      this.cueIndex,
      visIdx,
      this.cutSec,
    );
    if (!result.ok) return;

    if (this.deps.onApplySubtitleChange) {
      this.deps.onApplySubtitleChange(() => result.lines, {
        cueIndex: this.cueIndex,
        focusWordIndex: result.storageIdx,
      });
    }

    this.focusWordIndex = result.storageIdx;
    this._cutLineUserPositioned = false;
    this._cutSecLastWordId = null;
    this.lockedPpsWordId = null;
    this.frozenViewWin = null;
    this.boxLayoutPx = null;
    this.lastTrimEdge = null;
    this.viewWinAnchorKey = null;
    this._connectorAnchorKey = null;
    this._connectorGeom = null;

    this.deps.onFocusWordAfterSplit?.(this.cueIndex, result.storageIdx, result.newLeftWordId);
    void this._renderAsync();
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
      if (this.deps.isPlaying?.()) {
        this.deps.onPausePlayback?.();
        return;
      }
      this._togglePlayFromCut();
    };
    document.addEventListener("keydown", this._boundKeydown, { capture: true });
  }

  _unbindKeys() {
    if (this._boundKeydown) {
      document.removeEventListener("keydown", this._boundKeydown, { capture: true });
      this._boundKeydown = null;
    }
  }

  _fmt(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return `${pad(h)}:${pad(m)}:${pad(r, 2)}.${pad(Math.floor((r % 1) * 1000), 3)}`;
  }
}

