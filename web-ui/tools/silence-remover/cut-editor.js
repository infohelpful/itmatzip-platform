/**
 * 컷 편집 · 무음 건너뛰기 미리보기 재생 · MP4 내보내기.
 * 설계: docs/silence-remover-cut-editor-spec.md
 *
 * script.js 는 아래 훅만 호출한다.
 *   - syncFromDraw({ analyzed, previewColumnRanges }) → 그릴 컷 구간(초) 또는 undefined
 *   - drawOverlay(canvas, view)          파형을 그린 직후 재생 헤드·선택 표시
 *   - onPointerDown / onPointerMove / onPointerUp / onClick   파형 포인터 이벤트
 *
 * 편집 방식(다빈치 리졸브 컷 편집과 비슷하게):
 *   - 선택 도구(A): 구간 클릭 = 선택·재생 위치, 구간 경계 드래그 = 트림(컷 쪽으로 넓히면 복원)
 *   - 자르기 도구(B): 클릭한 곳에 자르기 선. 선으로 나뉜 구간을 골라 Delete 로 잘라내거나 복원
 *   - 구간 도구(R) 또는 Shift+드래그: 끈 범위를 컷으로 추가
 *   - 위 눈금자 드래그 = 재생 위치 이동, 스냅(N)은 재생 헤드·경계에 붙는다
 *   - setMedia(path | null)              파형이 로드되거나 미디어가 바뀔 때
 *   - confirmDiscardBeforeAnalyze()      다시 분석하기 전
 */

import {
  addSplit, buildSegments, cutFrameTotal, cutsEqual, cutsToSegments, editsEqual, findCutAtSec, formatClock,
  frameToSec, fpsString, hashString, keepsFromCuts, moveBoundary, normalizeCuts, normalizeSplits, parseFps,
  programFrameAt, secToFrame, segmentIndexAt, segmentsToCuts, setRangeCut,
} from "./cut-model.js?v=3";
import { columnRangesToTimeSegments } from "./waveform-canvas.js?v=7";
import { framesToTimecode, waveformUiScale } from "./waveform-renderer.js?v=7";

const EDGE_HIT_PX = 8;
const SNAP_PX = 8;
const SYNC_HARD_SEC = 0.15;
const UNDO_MAX = 100;
const STORAGE_KEY = "silenceRemover.cutEdits";
const SKIP_STORAGE_KEY = "silenceRemover.skipSilence";
const SNAP_STORAGE_KEY = "silenceRemover.cutSnap";
const REDRAW_INTERVAL_MS = 33;
const QUALITY_STORAGE_KEY = "silenceRemover.exportQuality";
/** 편집 화면 → 내보내기 페이지로 넘기는 요청 (export.js 와 같은 키) */
const EXPORT_REQUEST_KEY = "silenceRemover.exportRequest";
const EXPORT_PAGE = "export.html";

const COLOR_PLAYHEAD = "#ef4444";
const COLOR_SELECTED = "rgba(250, 204, 21, 0.95)";
const COLOR_SELECTED_FILL = "rgba(250, 204, 21, 0.14)";
const COLOR_CREATE_FILL = "rgba(244, 63, 94, 0.28)";
const COLOR_EDGE_HOVER = "rgba(250, 204, 21, 0.95)";
const COLOR_BLADE_LINE = "rgba(226, 232, 240, 0.8)";
const COLOR_BLADE_HOVER = "rgba(248, 250, 252, 0.95)";

/** @typedef {import("./cut-model.js").Range} Range */
/** @typedef {import("./cut-model.js").Fps} Fps */
/** @typedef {import("./cut-model.js").EditState} EditState */
/** @typedef {import("./cut-model.js").Segment} Segment */
/** @typedef {"select" | "blade" | "range"} Tool */

/**
 * @param {{
 *   scrollEl: HTMLElement,
 *   canvas: HTMLCanvasElement,
 *   getPeaks: () => { timeline_sec: number, column_count: number } | null,
 *   getVideoPath: () => string,
 *   getFpsRational: () => string | null,
 *   getFpsFloat: () => number,
 *   getDurationSec: () => number,
 *   canInteract: () => boolean,
 *   requestRedraw: () => void,
 *   mediaUrl: (path: string) => string,
 *   requestAgent: (opts: any) => Promise<any>,
 *   setLongOperation: (on: boolean) => void,
 *   onLeaveForExport?: () => void,
 *   t: (key: string, fallback: string) => string,
 *   tf: (key: string, fallback: string, vars: Record<string, unknown>) => string,
 * }} deps
 */
export function createCutEditor(deps) {
  const $ = (id) => document.getElementById(id);
  const panel = $("cut-preview-panel");
  const video = /** @type {HTMLVideoElement} */ ($("cut-preview-video"));
  const audio = /** @type {HTMLAudioElement} */ ($("cut-preview-audio"));
  const videoMsg = $("cut-preview-video-msg");
  const playBtn = /** @type {HTMLButtonElement} */ ($("cut-play"));
  const timeSrc = $("cut-time-src");
  const timeOut = $("cut-time-out");
  const skipBox = /** @type {HTMLInputElement} */ ($("cut-skip"));
  const statsEl = $("cut-stats");
  const hintEl = $("cut-hint");
  const exportBtn = /** @type {HTMLButtonElement} */ ($("cut-export"));
  /** 툴바 왼쪽 타임코드 = 제거 구간을 뺀 결과 영상 길이 */
  const tcEl = $("cut-tc");
  const toolbar = $("cut-toolbar");
  const btn = (id) => /** @type {HTMLButtonElement | null} */ ($(id));
  const tb = {
    select: btn("cut-tool-select"),
    blade: btn("cut-tool-blade"),
    range: btn("cut-tool-range"),
    split: btn("cut-split"),
    lift: btn("cut-lift"),
    restore: btn("cut-restore"),
    snap: btn("cut-snap"),
    undo: btn("cut-undo"),
    redo: btn("cut-redo"),
    reset: btn("cut-reset"),
  };

  const st = {
    mediaPath: "",
    /** @type {Fps | null} */ fps: null,
    totalFrames: 0,
    baseKey: "",
    /** @type {Range[]} */ baseCuts: [],
    /** @type {Range[]} */ cuts: [],
    /** 자르기 선 (화면 전용, 결과에 영향 없음) @type {number[]} */ splits: [],
    /** @type {Segment[]} */ segs: [],
    /** @type {EditState[]} */ undo: [],
    /** @type {EditState[]} */ redo: [],
    /** 선택한 구간의 시작 프레임 (-1 = 없음) */
    selStart: -1,
    /** @type {Tool} */ tool: "select",
    snap: true,
    active: false,
    /** 편집기 비활성일 때 재생 건너뛰기에 쓰는 미리보기 컷 */
    /** @type {Range[]} */ previewCuts: [],
    /** @type {null
     *   | { type: "trim", boundary: number, target: number, before: EditState, beforeSegs: Segment[], pointerId: number }
     *   | { type: "create", anchor: number, current: number, pointerId: number }
     *   | { type: "scrub", pointerId: number }} */
    drag: null,
    /** @type {null | { kind: "boundary" | "blade", frame: number }} */ hover: null,
    /** @type {{ startTimeSec: number, pxPerSec: number, width: number, waveH: number, waveTop: number } | null} */ view: null,
    playing: false,
    raf: 0,
    timer: 0,
    lastRedrawAt: 0,
    audioOk: false,
    videoOk: false,
    exporting: false,
  };

  try {
    if (sessionStorage.getItem(SKIP_STORAGE_KEY) === "false" && skipBox) skipBox.checked = false;
    if (sessionStorage.getItem(SNAP_STORAGE_KEY) === "false") st.snap = false;
  } catch {
    /* ignore */
  }

  // -- 기준(분석) 동기화 ---------------------------------------------------------------
  /** 분석 응답의 분수형 FPS 를 쓰되, 현재 입력 FPS 와 다르면(이전 분석의 값) 입력값을 따른다. */
  function resolveFps() {
    const typed = deps.getFpsFloat();
    const fromRational = parseFps(deps.getFpsRational(), typed);
    if (fromRational && Number.isFinite(typed) && typed > 0
        && Math.abs(fromRational.num / fromRational.den - typed) > 0.01) {
      return parseFps(null, typed);
    }
    return fromRational;
  }

  function analyzedKey(path, fps, segments) {
    let acc = 0;
    for (let i = 0; i < segments.length; i += 1) {
      const s = segments[i];
      acc = (acc * 31 + Math.round(s.start_sec * 1000) * 7 + Math.round(s.end_sec * 1000)) % 2147483647;
    }
    return hashString(`${path}|${fpsString(fps)}|${segments.length}|${acc}`);
  }

  /** @returns {EditState} */
  function current() {
    return { cuts: st.cuts, splits: st.splits };
  }

  /** @param {EditState} state */
  function setEdit(state) {
    st.cuts = state.cuts;
    st.splits = state.splits;
    st.segs = buildSegments(st.cuts, st.splits, st.totalFrames);
  }

  function isDirty() {
    return st.active && (!cutsEqual(st.cuts, st.baseCuts) || st.splits.length > 0);
  }

  function persist() {
    try {
      if (!st.baseKey) return;
      if (!isDirty()) {
        sessionStorage.removeItem(STORAGE_KEY);
        return;
      }
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ baseKey: st.baseKey, cuts: st.cuts, splits: st.splits }));
    } catch {
      /* quota / private mode */
    }
  }

  /** @returns {EditState | null} */
  function restoreSaved(baseKey) {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (data && data.baseKey === baseKey && Array.isArray(data.cuts)) {
        return {
          cuts: normalizeCuts(data.cuts.filter((c) => Array.isArray(c) && c.length === 2), st.totalFrames),
          splits: normalizeSplits(Array.isArray(data.splits) ? data.splits : [], st.totalFrames),
        };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /**
   * 파형을 그릴 때마다 호출. 분석 결과가 유효하면 편집 컷을, 아니면 undefined 를 돌려준다.
   * @param {{ analyzed?: Array<{ start_sec: number, end_sec: number }>, previewColumnRanges?: Array<[number, number]> }} input
   */
  function syncFromDraw(input) {
    const fps = resolveFps();
    const duration = deps.getDurationSec();
    const path = deps.getVideoPath();
    if (!fps || !(duration > 0) || !path) {
      setActive(false);
      st.previewCuts = [];
      return undefined;
    }
    st.fps = fps;
    st.totalFrames = Math.max(1, secToFrame(duration, fps));
    if (!Array.isArray(input.analyzed)) {
      setActive(false);
      const peaks = deps.getPeaks();
      st.previewCuts = Array.isArray(input.previewColumnRanges) && peaks
        ? segmentsToCuts(
          columnRangesToTimeSegments(input.previewColumnRanges, peaks.timeline_sec, peaks.column_count),
          fps, st.totalFrames,
        )
        : [];
      return undefined;
    }
    const key = analyzedKey(path, fps, input.analyzed);
    if (key !== st.baseKey) {
      st.baseKey = key;
      st.baseCuts = segmentsToCuts(input.analyzed, fps, st.totalFrames);
      setEdit(restoreSaved(key) ?? { cuts: st.baseCuts.map((c) => /** @type {Range} */ ([c[0], c[1]])), splits: [] });
      st.undo = [];
      st.redo = [];
      st.selStart = -1;
    }
    setActive(true);
    return cutsToSegments(st.cuts, fps);
  }

  function setActive(on) {
    if (st.active === on) return;
    st.active = on;
    if (!on) {
      st.selStart = -1;
      st.hover = null;
      setHoverCursor();
    }
    updateUi();
  }

  /** 재생이 건너뛸 컷 */
  function skipCuts() {
    return st.active ? st.cuts : st.previewCuts;
  }

  /** @returns {Segment | null} */
  function selectedSeg() {
    if (!st.active || st.selStart < 0) return null;
    const seg = st.segs[segmentIndexAt(st.segs, st.selStart)];
    return seg && seg.start === st.selStart ? seg : null;
  }

  // -- 편집 동작 ------------------------------------------------------------------------
  /** @param {EditState} next */
  function applyEdit(next, { selStart = st.selStart } = {}) {
    if (editsEqual(next, current())) return;
    st.undo.push(current());
    if (st.undo.length > UNDO_MAX) st.undo.shift();
    st.redo = [];
    setEdit(next);
    st.selStart = selStart;
    afterEdit();
  }

  function afterEdit() {
    persist();
    updateUi();
    deps.requestRedraw();
  }

  function undo() {
    const prev = st.undo.pop();
    if (!prev) return;
    st.redo.push(current());
    setEdit(prev);
    afterEdit();
  }

  function redo() {
    const next = st.redo.pop();
    if (!next) return;
    st.undo.push(current());
    setEdit(next);
    afterEdit();
  }

  function playheadFrame() {
    return st.fps ? Math.max(0, Math.min(st.totalFrames, secToFrame(currentTime(), st.fps))) : 0;
  }

  /** 재생 위치에 자르기 선 (Ctrl+B) */
  function splitAtPlayhead() {
    if (!st.active || !st.fps) return;
    applyEdit(addSplit(current(), playheadFrame(), st.totalFrames));
  }

  /** 선택 구간을 잘라낸다 (유지 → 컷) */
  function liftSelected() {
    const seg = selectedSeg();
    if (!seg || seg.cut) return;
    applyEdit(setRangeCut(current(), seg.start, seg.end, true, st.totalFrames), { selStart: seg.start });
  }

  /** 선택 구간을 복원한다 (컷 → 유지) */
  function restoreSelected() {
    const seg = selectedSeg();
    if (!seg || !seg.cut) return;
    applyEdit(setRangeCut(current(), seg.start, seg.end, false, st.totalFrames), { selStart: seg.start });
  }

  function toggleSelected() {
    const seg = selectedSeg();
    if (!seg) return;
    if (seg.cut) restoreSelected();
    else liftSelected();
  }

  function resetEdits() {
    if (!isDirty()) return;
    applyEdit({ cuts: st.baseCuts.map((c) => /** @type {Range} */ ([c[0], c[1]])), splits: [] }, { selStart: -1 });
  }

  /** @param {Tool} tool */
  function setTool(tool) {
    st.tool = tool;
    st.hover = null;
    setHoverCursor();
    updateUi();
    deps.requestRedraw();
  }

  function toggleSnap() {
    st.snap = !st.snap;
    try {
      sessionStorage.setItem(SNAP_STORAGE_KEY, st.snap ? "true" : "false");
    } catch {
      /* ignore */
    }
    updateUi();
  }

  /** 이전/다음 편집점(구간 경계)으로 재생 위치 이동 @param {-1 | 1} dir */
  function jumpEditPoint(dir) {
    if (!st.fps || !st.segs.length) return;
    const f = playheadFrame();
    let target = dir < 0 ? 0 : st.totalFrames;
    for (const seg of st.segs) {
      if (dir < 0 && seg.start < f) target = seg.start;
      if (dir > 0 && seg.start > f) {
        target = seg.start;
        break;
      }
    }
    seek(frameToSec(target, st.fps));
  }

  /** 다시 분석하면 편집 내용이 사라진다. 진행해도 되면 true. */
  function confirmDiscardBeforeAnalyze() {
    if (!isDirty()) return true;
    const ok = window.confirm(deps.t(
      "cut.confirmReanalyze",
      "직접 편집한 컷이 있습니다. 다시 분석하면 편집 내용이 분석 결과로 바뀝니다. 계속할까요?",
    ));
    if (ok) {
      try {
        sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
    }
    return ok;
  }

  // -- 좌표 ------------------------------------------------------------------------------
  function timeAtClientX(clientX) {
    const v = st.view;
    if (!v) return 0;
    const rect = deps.canvas.getBoundingClientRect();
    return Math.max(0, v.startTimeSec + (clientX - rect.left) / v.pxPerSec);
  }

  function frameAtClientX(clientX) {
    return st.fps ? Math.max(0, Math.min(st.totalFrames, secToFrame(timeAtClientX(clientX), st.fps))) : 0;
  }

  function xAtTime(t) {
    const v = st.view;
    return v ? (t - v.startTimeSec) * v.pxPerSec : 0;
  }

  function xAtFrame(f) {
    return st.fps ? xAtTime(frameToSec(f, st.fps)) : 0;
  }

  /** 포인터 근처(±EDGE_HIT_PX)의 구간 경계 프레임 (0 과 끝 제외), 없으면 -1 */
  function boundaryNear(clientX) {
    if (!st.active || !st.fps || !st.view || st.segs.length < 2) return -1;
    const x = clientX - deps.canvas.getBoundingClientRect().left;
    const i = segmentIndexAt(st.segs, frameAtClientX(clientX));
    let best = -1;
    let bestDist = EDGE_HIT_PX + 1;
    for (let k = Math.max(1, i - 1); k <= Math.min(st.segs.length - 1, i + 2); k += 1) {
      const f = st.segs[k].start;
      const bx = xAtFrame(f);
      const dist = Math.abs(bx - x);
      // 짧은 구간은 잡는 폭을 줄여서 가운데를 누르면 구간 선택이 되게 한다
      const narrow = Math.min(bx - xAtFrame(st.segs[k - 1].start), xAtFrame(st.segs[k].end) - bx);
      const radius = Math.min(EDGE_HIT_PX, Math.max(2, narrow / 3));
      if (dist <= radius && dist < bestDist) {
        best = f;
        bestDist = dist;
      }
    }
    return best;
  }

  /**
   * 스냅: 재생 헤드·다른 경계에 가까우면(±SNAP_PX) 그 위치로 붙인다.
   * exclude = 지금 끄는 경계, segs = 기준 구간(트림 중에는 끌기 전 구간 — 끌리는 경계 자신에 붙지 않게)
   */
  function snapFrame(frame, exclude = -1, segs = st.segs) {
    if (!st.snap || !st.fps || !st.view) return frame;
    const x = xAtFrame(frame);
    let best = frame;
    let bestDist = SNAP_PX + 1;
    const consider = (f) => {
      if (f === exclude) return;
      const dist = Math.abs(xAtFrame(f) - x);
      if (dist <= SNAP_PX && dist < bestDist) {
        best = f;
        bestDist = dist;
      }
    };
    consider(playheadFrame());
    const i = segmentIndexAt(segs, frame);
    for (let k = Math.max(0, i - 2); k <= Math.min(segs.length - 1, i + 2); k += 1) {
      consider(segs[k].start);
      consider(segs[k].end);
    }
    return best;
  }

  function setHoverCursor() {
    const el = deps.scrollEl;
    const edit = st.active;
    el.classList.toggle("is-cut-edge-hover", edit && st.hover?.kind === "boundary");
    el.classList.toggle("is-cut-blade-tool", edit && st.tool === "blade");
    el.classList.toggle("is-cut-range-tool", edit && st.tool === "range");
  }

  function inRuler(clientY) {
    const v = st.view;
    if (!v) return false;
    const y = clientY - deps.canvas.getBoundingClientRect().top;
    // 위쪽 눈금자(waveTop>0)면 그 위, 아니면 파형 아래
    return v.waveTop > 0 ? y < v.waveTop : y > v.waveH;
  }

  function capture(e) {
    try {
      deps.scrollEl.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  // -- 포인터 ---------------------------------------------------------------------------
  /** @param {PointerEvent} e @returns {boolean} 처리했으면 true (팬 하지 않음) */
  function onPointerDown(e) {
    if (e.button !== 0 || !deps.canInteract() || !st.view) return false;
    // 눈금자: 재생 위치 끌기(스크럽)
    if (inRuler(e.clientY) && canPlay()) {
      st.drag = { type: "scrub", pointerId: e.pointerId };
      if (st.playing) pause();
      seek(timeAtClientX(e.clientX));
    } else {
      if (!st.active || !st.fps) return false;
      const boundary = st.tool === "select" && !e.shiftKey ? boundaryNear(e.clientX) : -1;
      if (boundary >= 0) {
        st.drag = {
          type: "trim", boundary, target: boundary, before: current(), beforeSegs: st.segs, pointerId: e.pointerId,
        };
        st.hover = { kind: "boundary", frame: boundary };
      } else if (st.tool === "range" || e.shiftKey) {
        const f = snapFrame(frameAtClientX(e.clientX));
        st.drag = { type: "create", anchor: f, current: f, pointerId: e.pointerId };
      } else {
        return false; // 빈 곳 = 화면 이동, 끌지 않고 놓으면 onClick
      }
    }
    capture(e);
    e.preventDefault();
    deps.requestRedraw();
    return true;
  }

  /** @param {PointerEvent} e @returns {boolean} */
  function onPointerMove(e) {
    const d = st.drag;
    if (d && e.pointerId === d.pointerId) {
      if (d.type === "scrub") {
        seek(timeAtClientX(e.clientX));
      } else if (d.type === "trim") {
        d.target = snapFrame(frameAtClientX(e.clientX), d.boundary, d.beforeSegs);
        const next = moveBoundary(d.before, d.boundary, d.target, st.totalFrames);
        setEdit(next);
        st.hover = { kind: "boundary", frame: Math.max(0, Math.min(st.totalFrames, d.target)) };
        updateStats();
      } else {
        d.current = snapFrame(frameAtClientX(e.clientX));
      }
      deps.requestRedraw();
      e.preventDefault();
      return true;
    }
    if (!d && e.buttons === 0) {
      /** @type {typeof st.hover} */
      let hover = null;
      if (st.active && st.view && !inRuler(e.clientY)) {
        if (st.tool === "select") {
          const b = boundaryNear(e.clientX);
          if (b >= 0) hover = { kind: "boundary", frame: b };
        } else if (st.tool === "blade") {
          hover = { kind: "blade", frame: snapFrame(frameAtClientX(e.clientX)) };
        }
      }
      const changed = hover?.kind !== st.hover?.kind || hover?.frame !== st.hover?.frame;
      st.hover = hover;
      setHoverCursor();
      if (changed) deps.requestRedraw();
    }
    return false;
  }

  /** @param {PointerEvent} e @returns {boolean} */
  function onPointerUp(e) {
    const d = st.drag;
    if (!d || e.pointerId !== d.pointerId) return false;
    st.drag = null;
    try {
      deps.scrollEl.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (d.type === "trim") {
      const edited = current();
      setEdit(d.before);
      // 선택한 구간이 이 경계에 붙어 있었으면, 옮겨진 뒤에도 같은 구간을 가리키게 한다
      const sel = st.selStart === d.boundary ? Math.min(d.target, st.totalFrames) : st.selStart;
      applyEdit(edited, { selStart: sel });
      st.hover = null;
    } else if (d.type === "create") {
      const a = Math.min(d.anchor, d.current);
      const b = Math.max(d.anchor, d.current);
      if (b > a) applyEdit(setRangeCut(current(), a, b, true, st.totalFrames), { selStart: a });
    }
    updateUi();
    deps.requestRedraw();
    return true;
  }

  /** 끌지 않고 클릭: 자르기 도구면 자르기 선, 아니면 구간 선택 + 재생 위치 이동 @param {MouseEvent} e */
  function onClick(e) {
    if (!deps.canInteract() || !st.view) return;
    if (st.active && st.fps && st.tool === "blade") {
      applyEdit(addSplit(current(), snapFrame(frameAtClientX(e.clientX)), st.totalFrames));
      return;
    }
    const t = timeAtClientX(e.clientX);
    if (st.active && st.fps) {
      // 반올림이 아니라 내림: 눌린 위치를 실제로 포함하는 구간을 고른다
      const f = Math.min(st.totalFrames - 1, Math.floor((t * st.fps.num) / st.fps.den));
      const seg = st.segs[segmentIndexAt(st.segs, f)];
      st.selStart = seg ? seg.start : -1;
      updateUi();
    }
    seek(t);
  }

  // -- 그리기 ---------------------------------------------------------------------------
  /** @param {CanvasRenderingContext2D} ctx */
  function vline(ctx, x, top, bottom, color, width, dash) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ startTimeSec: number, pxPerSec: number }} viewResult
   */
  function drawOverlay(canvas, viewResult) {
    const ctx = canvas.getContext("2d");
    if (!ctx || !viewResult) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    // 눈금자 위치는 렌더러가 알려 준다 (위쪽 눈금자 = 파형이 waveTop 부터)
    const top = Number.isFinite(viewResult.waveTop) ? viewResult.waveTop : 0;
    const waveH = Number.isFinite(viewResult.waveH)
      ? viewResult.waveH
      : Math.max(1, height - Math.round(36 * waveformUiScale()));
    const bottom = top + waveH;
    st.view = { startTimeSec: viewResult.startTimeSec, pxPerSec: viewResult.pxPerSec, width, waveH, waveTop: top };
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (st.active && st.fps) {
      const fps = st.fps;
      // 같은 상태끼리 맞닿은 경계 = 자르기 선
      const f0 = secToFrame(Math.max(0, viewResult.startTimeSec), fps);
      const f1 = secToFrame(viewResult.startTimeSec + width / viewResult.pxPerSec, fps);
      for (let k = Math.max(1, segmentIndexAt(st.segs, f0)); k < st.segs.length; k += 1) {
        const seg = st.segs[k];
        if (seg.start > f1) break;
        if (st.segs[k - 1].cut !== seg.cut) continue;
        const x = Math.round(xAtFrame(seg.start)) + 0.5;
        vline(ctx, x, top, bottom, COLOR_BLADE_LINE, 1.5);
        ctx.fillStyle = COLOR_BLADE_LINE;
        ctx.beginPath();
        ctx.moveTo(x - 4, top);
        ctx.lineTo(x + 4, top);
        ctx.lineTo(x, top + 5);
        ctx.closePath();
        ctx.fill();
      }

      const sel = selectedSeg();
      if (sel) {
        const x0 = xAtFrame(sel.start);
        const x1 = xAtFrame(sel.end);
        if (x1 >= 0 && x0 <= width) {
          ctx.fillStyle = COLOR_SELECTED_FILL;
          ctx.fillRect(x0, top, Math.max(1, x1 - x0), waveH);
          ctx.strokeStyle = COLOR_SELECTED;
          ctx.lineWidth = 2;
          ctx.strokeRect(x0 + 1, top + 1, Math.max(1, x1 - x0 - 2), waveH - 2);
        }
      }
      const d = st.drag;
      if (d && d.type === "create") {
        const x0 = xAtFrame(Math.min(d.anchor, d.current));
        const x1 = xAtFrame(Math.max(d.anchor, d.current));
        ctx.fillStyle = COLOR_CREATE_FILL;
        ctx.fillRect(x0, top, Math.max(1, x1 - x0), waveH);
      }
      const h = st.hover;
      if (h) {
        const x = Math.round(xAtFrame(h.frame)) + 0.5;
        if (h.kind === "boundary") vline(ctx, x, top, bottom, COLOR_EDGE_HOVER, 3);
        else vline(ctx, x, top, bottom, COLOR_BLADE_HOVER, 1.5, [5, 4]);
      }
      if (d && d.type === "trim") {
        const delta = frameToSec(d.target - d.boundary, fps);
        const label = `${delta >= 0 ? "+" : "−"}${formatClock(Math.abs(delta))}`;
        const x = xAtFrame(d.target);
        ctx.font = `600 ${Math.round(12 * waveformUiScale())}px Consolas, monospace`;
        const w = ctx.measureText(label).width + 10;
        const lx = Math.max(2, Math.min(width - w - 2, x + 6));
        ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
        ctx.fillRect(lx, top + 8, w, 20);
        ctx.fillStyle = "#facc15";
        ctx.fillText(label, lx + 5, top + 22);
      }
    }

    const tNow = currentTime();
    const px = Math.round(xAtTime(tNow)) + 0.5;
    if (deps.getPeaks() && px >= 0 && px <= width) {
      // 다빈치식 재생 헤드: 눈금자 안의 빨간 표식 + 아래로 빨간 선
      const ui = waveformUiScale();
      const hw = Math.round(6 * ui);
      const mh = Math.max(Math.round(14 * ui), Math.round(top * 0.45));
      ctx.strokeStyle = COLOR_PLAYHEAD;
      ctx.lineWidth = Math.max(1.5, 1.5 * ui);
      ctx.beginPath();
      ctx.moveTo(px, top > 0 ? mh : 0);
      ctx.lineTo(px, height);
      ctx.stroke();
      ctx.fillStyle = COLOR_PLAYHEAD;
      ctx.beginPath();
      ctx.moveTo(px - hw, 0);
      ctx.lineTo(px + hw, 0);
      ctx.lineTo(px + hw, mh - hw * 0.8);
      ctx.lineTo(px, mh);
      ctx.lineTo(px - hw, mh - hw * 0.8);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // -- 재생 엔진 -------------------------------------------------------------------------
  /** 기준 시계: 오디오가 재생 가능하면 오디오, 아니면 영상 */
  function master() {
    return st.audioOk || !st.videoOk ? audio : video;
  }

  function currentTime() {
    const m = master();
    return Number.isFinite(m.currentTime) ? m.currentTime : 0;
  }

  function setMedia(path) {
    const next = String(path || "").trim();
    if (next === st.mediaPath) return;
    pause();
    st.mediaPath = next;
    st.audioOk = false;
    st.videoOk = false;
    for (const el of [video, audio]) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    if (videoMsg) videoMsg.hidden = true;
    panel.classList.remove("is-audio-only", "is-video-error");
    if (!next) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const url = deps.mediaUrl(next);
    audio.src = url;
    video.src = url;
    audio.load();
    video.load();
    updateUi();
  }

  function onMediaReady() {
    st.audioOk = audio.readyState >= HTMLMediaElement.HAVE_METADATA && !audio.error;
    st.videoOk = video.readyState >= HTMLMediaElement.HAVE_METADATA && !video.error && video.videoWidth > 0;
    panel.classList.toggle("is-audio-only", !st.videoOk && !video.error);
    video.muted = st.audioOk;
    updateUi();
  }

  audio.addEventListener("loadedmetadata", onMediaReady);
  video.addEventListener("loadedmetadata", onMediaReady);
  audio.addEventListener("error", () => {
    st.audioOk = false;
    video.muted = false;
    updateUi();
  });
  video.addEventListener("error", () => {
    st.videoOk = false;
    if (!st.mediaPath) return;
    panel.classList.add("is-video-error");
    const src = video.currentSrc || video.src;
    const show = (text) => {
      if (!videoMsg) return;
      videoMsg.hidden = false;
      videoMsg.textContent = text;
    };
    show(deps.t(
      "cut.videoUnsupported",
      "브라우저가 이 영상 코덱을 재생하지 못해 소리만 재생합니다. MP4 내보내기는 그대로 됩니다.",
    ));
    updateUi();
    // 같은 오류 코드가 "파일을 못 받음"에도 나오므로 주소를 직접 확인해 안내를 구분한다.
    if (!src) return;
    fetch(src, { headers: { Range: "bytes=0-1" }, cache: "no-store" })
      .then((res) => {
        if (!res.ok) {
          show(deps.tf(
            "cut.videoFetchFailed",
            "에이전트에서 영상을 받지 못했습니다 (HTTP {status}). 에이전트를 최신 버전으로 업데이트한 뒤 다시 불러오세요.",
            { status: res.status },
          ));
        }
      })
      .catch(() => {
        show(deps.t(
          "cut.videoFetchError",
          "에이전트에 연결하지 못해 영상을 불러오지 못했습니다. 연결 상태를 확인한 뒤 다시 불러오세요.",
        ));
      });
  });
  audio.addEventListener("ended", () => pause());
  video.addEventListener("ended", () => {
    if (master() === video) pause();
  });

  function canPlay() {
    return Boolean(st.mediaPath) && (st.audioOk || st.videoOk);
  }

  function seek(t) {
    const dur = deps.getDurationSec() || master().duration || 0;
    const target = Math.max(0, Math.min(dur > 0 ? dur : t, t));
    for (const el of [audio, video]) {
      if (el.readyState >= HTMLMediaElement.HAVE_METADATA) {
        try {
          el.currentTime = target;
        } catch {
          /* ignore */
        }
      }
    }
    updateTime();
    deps.requestRedraw();
  }

  /** 건너뛰기 켜짐이고 t 가 컷 안이면 컷 끝 시각 (없으면 null) */
  function skipTarget(t) {
    if (!skipBox?.checked || !st.fps) return null;
    const cuts = skipCuts();
    const i = findCutAtSec(cuts, st.fps, t);
    return i >= 0 ? frameToSec(cuts[i][1], st.fps) : null;
  }

  async function play() {
    if (!canPlay() || st.playing) return;
    const m = master();
    const dur = deps.getDurationSec() || m.duration || 0;
    if (dur > 0 && m.currentTime >= dur - 0.05) seek(0);
    const jump = skipTarget(m.currentTime);
    if (jump != null) {
      if (dur > 0 && jump >= dur - 0.01) {
        seek(0);
      } else {
        seek(jump);
      }
    }
    st.playing = true;
    updateUi();
    try {
      await m.play();
      if (st.videoOk && m !== video) {
        video.currentTime = m.currentTime;
        void video.play().catch(() => {});
      }
    } catch {
      st.playing = false;
      updateUi();
      return;
    }
    scheduleTick();
  }

  /**
   * 화면이 보이면 rAF, 탭이 숨겨지면(rAF 정지) 타이머로 루프를 돌린다.
   * 소리가 나는 탭은 백그라운드 타이머 제한을 받지 않으므로 다른 탭에 있어도 건너뛰기가 계속된다.
   */
  function scheduleTick() {
    cancelTick();
    if (!st.playing) return;
    if (document.hidden) st.timer = window.setTimeout(() => tick(performance.now()), 15);
    else st.raf = requestAnimationFrame(tick);
  }

  function cancelTick() {
    cancelAnimationFrame(st.raf);
    window.clearTimeout(st.timer);
    st.raf = 0;
    st.timer = 0;
  }

  document.addEventListener("visibilitychange", () => {
    if (st.playing) scheduleTick();
  });

  function pause() {
    st.playing = false;
    cancelTick();
    audio.pause();
    video.pause();
    updateUi();
    deps.requestRedraw();
  }

  function togglePlay() {
    if (st.playing) pause();
    else void play();
  }

  function tick(now) {
    if (!st.playing) return;
    const m = master();
    const t = m.currentTime;
    const dur = deps.getDurationSec() || m.duration || 0;
    const jump = skipTarget(t);
    if (jump != null) {
      if (dur > 0 && jump >= dur - 0.01) {
        pause();
        return;
      }
      if (!m.seeking) m.currentTime = jump;
      if (st.videoOk && m !== video && !video.seeking) video.currentTime = jump;
    } else if (st.videoOk && m !== video) {
      if (m.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        if (!video.paused) video.pause();
      } else {
        if (video.paused && !video.seeking) void video.play().catch(() => {});
        if (!video.seeking && Math.abs(video.currentTime - t) > SYNC_HARD_SEC) video.currentTime = t;
      }
    }
    if (now - st.lastRedrawAt >= REDRAW_INTERVAL_MS && !document.hidden) {
      st.lastRedrawAt = now;
      followPlayhead(t);
      updateTime();
      deps.requestRedraw();
    }
    scheduleTick();
  }

  /** 재생 헤드가 화면을 벗어나면 화면이 따라간다 */
  function followPlayhead(t) {
    const v = st.view;
    if (!v || st.drag) return;
    const x = xAtTime(t);
    if (x > v.width * 0.92 || x < 0) {
      deps.scrollEl.scrollLeft = Math.max(0, t * v.pxPerSec - v.width * 0.08);
    }
  }

  // -- UI 상태 ---------------------------------------------------------------------------
  function updateTime() {
    const t = currentTime();
    if (timeSrc) timeSrc.textContent = formatClock(t);
    if (timeOut) {
      const out = st.fps ? frameToSec(programFrameAt(skipCuts(), secToFrame(t, st.fps)), st.fps) : t;
      timeOut.textContent = deps.tf("cut.timeOut", "결과 {t}", { t: formatClock(out) });
    }
  }

  function updateStats() {
    if (!st.fps || !st.totalFrames) {
      if (statsEl) statsEl.textContent = "";
      if (tcEl) tcEl.textContent = "00:00:00:00";
      return;
    }
    const cuts = skipCuts();
    if (tcEl) tcEl.textContent = framesToTimecode(st.totalFrames - cutFrameTotal(cuts), st.fps.num / st.fps.den);
    if (!statsEl) return;
    const total = frameToSec(st.totalFrames, st.fps);
    const result = frameToSec(st.totalFrames - cutFrameTotal(cuts), st.fps);
    statsEl.textContent = deps.tf("cut.stats", "컷 {n}개 · 결과 {out} / 원본 {src}", {
      n: cuts.length, out: formatClock(result), src: formatClock(total),
    });
    if (isDirty() || (st.drag && st.drag.type === "trim")) {
      const dirty = document.createElement("span");
      dirty.className = "cut-stats-dirty";
      dirty.textContent = ` · ${deps.t("cut.edited", "편집됨")}`;
      statsEl.append(dirty);
    }
  }

  function updateUi() {
    if (!panel) return;
    if (playBtn) {
      playBtn.disabled = !canPlay();
      playBtn.textContent = st.playing ? "❚❚" : "▶";
      playBtn.setAttribute("aria-label", st.playing ? deps.t("cut.pause", "일시정지") : deps.t("cut.play", "재생"));
      playBtn.classList.toggle("is-playing", st.playing);
    }
    updateToolbar();
    if (exportBtn) exportBtn.disabled = !st.active || st.exporting;
    panel.classList.toggle("is-edit-active", st.active);
    panel.classList.toggle("is-dirty", isDirty());
    if (hintEl) {
      hintEl.textContent = st.active
        ? toolHint()
        : deps.getPeaks() && st.previewCuts.length
          ? deps.t("cut.hintStale", "설정이 바뀌었습니다. 다시 분석하면 컷을 편집하고 MP4로 내보낼 수 있습니다.")
          : deps.t("cut.hintIdle", "무음 구간을 분석하면 컷을 편집하고 MP4로 내보낼 수 있습니다.");
    }
    updateStats();
    updateTime();
  }

  function toolHint() {
    if (st.tool === "blade") {
      return deps.t("cut.hintBlade", "클릭한 곳에 자르기 선을 넣습니다. 선 사이 구간을 선택 도구(A)로 골라 Delete로 잘라내거나 복원하세요.");
    }
    if (st.tool === "range") {
      return deps.t("cut.hintRange", "드래그한 범위를 잘라냅니다. 빈 곳 클릭 = 재생 위치.");
    }
    return deps.t(
      "cut.hintActive",
      "구간 클릭 = 선택 · 경계 드래그 = 트림(빨간 쪽으로 끌면 복원) · Delete = 잘라내기/복원 · Ctrl+B = 재생 위치 자르기 · 위 눈금자 드래그 = 재생 위치",
    );
  }

  /** @param {HTMLButtonElement | null} el @param {string} label @param {string} [key] */
  function setTip(el, label, key) {
    if (!el) return;
    const text = key ? `${label} (${key})` : label;
    el.title = text;
    el.setAttribute("aria-label", text);
  }

  function updateToolbar() {
    if (!toolbar) return;
    const on = st.active;
    const seg = selectedSeg();
    toolbar.classList.toggle("is-edit-active", on);
    for (const tool of /** @type {Tool[]} */ (["select", "blade", "range"])) {
      const el = tb[tool];
      if (!el) continue;
      el.disabled = !on;
      el.classList.toggle("is-active", on && st.tool === tool);
      el.setAttribute("aria-pressed", String(on && st.tool === tool));
    }
    if (tb.split) tb.split.disabled = !on || !canPlay();
    if (tb.lift) tb.lift.disabled = !seg || seg.cut;
    if (tb.restore) tb.restore.disabled = !seg || !seg.cut;
    if (tb.snap) {
      tb.snap.disabled = !on;
      tb.snap.classList.toggle("is-active", on && st.snap);
      tb.snap.setAttribute("aria-pressed", String(st.snap));
    }
    if (tb.undo) tb.undo.disabled = !on || st.undo.length === 0;
    if (tb.redo) tb.redo.disabled = !on || st.redo.length === 0;
    if (tb.reset) tb.reset.disabled = !isDirty();
    setTip(tb.select, deps.t("cut.toolSelect", "선택 모드"), "A");
    setTip(tb.blade, deps.t("cut.toolBlade", "자르기 모드"), "B");
    setTip(tb.range, deps.t("cut.toolRange", "구간 잘라내기 모드"), "R");
    setTip(tb.split, deps.t("cut.splitAtPlayhead", "재생 위치에서 자르기"), "Ctrl+B");
    setTip(tb.lift, deps.t("cut.lift", "선택 구간 잘라내기"), "Delete");
    setTip(tb.restore, deps.t("cut.restore", "선택 구간 복원"), "Delete");
    setTip(tb.snap, deps.t("cut.snap", "스냅"), "N");
    setTip(tb.undo, deps.t("cut.undo", "실행 취소"), "Ctrl+Z");
    setTip(tb.redo, deps.t("cut.redo", "다시 실행"), "Ctrl+Y");
    setTip(tb.reset, deps.t("cut.reset", "편집 초기화"));
  }

  // -- 내보내기: 내보내기 페이지(export.html)로 넘겨 거기서 인코딩한다 -------------------------
  const qualitySel = /** @type {HTMLSelectElement | null} */ ($("cut-quality"));
  try {
    const q = sessionStorage.getItem(QUALITY_STORAGE_KEY);
    if (qualitySel && q && [...qualitySel.options].some((o) => o.value === q)) qualitySel.value = q;
  } catch {
    /* ignore */
  }

  function baseName(p) {
    const name = String(p || "").split(/[\\/]/).pop() || "";
    return name.replace(/\.[^.]+$/, "");
  }

  function openExport() {
    if (!st.active || !st.fps || st.exporting) return;
    pause();
    const keeps = keepsFromCuts(st.cuts, st.totalFrames);
    if (!keeps.length) {
      window.alert(deps.t("cut.nothingLeft", "남는 구간이 없습니다. 컷을 줄인 뒤 다시 시도하세요."));
      return;
    }
    persist();
    const request = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      video_path: st.mediaPath,
      fps_rational: fpsString(st.fps),
      keeps: keeps.map(([a, b]) => ({ start_frame: a, end_frame: b })),
      quality: qualitySel?.value || "standard",
      cut_count: st.cuts.length,
      out_sec: frameToSec(st.totalFrames - cutFrameTotal(st.cuts), st.fps),
      name: baseName(st.mediaPath),
    };
    try {
      sessionStorage.setItem(EXPORT_REQUEST_KEY, JSON.stringify(request));
    } catch {
      window.alert(deps.t("cut.exportFailed", "내보내기에 실패했습니다."));
      return;
    }
    st.exporting = true;
    updateUi();
    deps.onLeaveForExport?.();
    window.location.assign(new URL(EXPORT_PAGE, window.location.href).href);
  }

  // -- 이벤트 연결 -----------------------------------------------------------------------
  playBtn?.addEventListener("click", togglePlay);
  tb.select?.addEventListener("click", () => setTool("select"));
  tb.blade?.addEventListener("click", () => setTool("blade"));
  tb.range?.addEventListener("click", () => setTool("range"));
  tb.split?.addEventListener("click", splitAtPlayhead);
  tb.lift?.addEventListener("click", liftSelected);
  tb.restore?.addEventListener("click", restoreSelected);
  tb.snap?.addEventListener("click", toggleSnap);
  tb.undo?.addEventListener("click", undo);
  tb.redo?.addEventListener("click", redo);
  tb.reset?.addEventListener("click", resetEdits);
  exportBtn?.addEventListener("click", openExport);
  skipBox?.addEventListener("change", () => {
    try {
      sessionStorage.setItem(SKIP_STORAGE_KEY, skipBox.checked ? "true" : "false");
    } catch {
      /* ignore */
    }
    updateUi();
  });
  qualitySel?.addEventListener("change", () => {
    try {
      sessionStorage.setItem(QUALITY_STORAGE_KEY, qualitySel.value);
    } catch {
      /* ignore */
    }
  });
  // 뒤로 가기(bfcache)로 돌아왔을 때 내보내기 버튼이 잠긴 채로 남지 않게
  window.addEventListener("pageshow", () => {
    if (st.exporting) {
      st.exporting = false;
      updateUi();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (panel.hidden || e.defaultPrevented || e.altKey) return;
    const target = /** @type {HTMLElement | null} */ (e.target instanceof HTMLElement ? e.target : null);
    if (target && (target.closest("input, textarea, select, [contenteditable='true']") || target.closest("dialog"))) {
      return;
    }
    if (document.querySelector("dialog[open]")) return;
    const key = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (key === " " && !mod) {
      if (target && target.closest("button, a")) return;
      e.preventDefault();
      togglePlay();
    } else if ((key === "Delete" || key === "Backspace") && !mod && selectedSeg()) {
      e.preventDefault();
      toggleSelected();
    } else if (key === "Escape" && st.selStart >= 0) {
      st.selStart = -1;
      updateUi();
      deps.requestRedraw();
    } else if (mod && (key === "b" || key === "B" || key === "\\") && st.active) {
      e.preventDefault();
      splitAtPlayhead();
    } else if (!mod && !e.shiftKey && st.active && /^[abrnABRN]$/.test(key)) {
      e.preventDefault();
      const k = key.toLowerCase();
      if (k === "a") setTool("select");
      else if (k === "b") setTool("blade");
      else if (k === "r") setTool("range");
      else toggleSnap();
    } else if ((key === "ArrowUp" || key === "ArrowDown") && !mod && st.active && canPlay()) {
      e.preventDefault();
      jumpEditPoint(key === "ArrowUp" ? -1 : 1);
    } else if (mod && (key === "z" || key === "Z") && !e.shiftKey) {
      if (!st.active) return;
      e.preventDefault();
      undo();
    } else if (mod && (key === "y" || key === "Y" || ((key === "z" || key === "Z") && e.shiftKey))) {
      if (!st.active) return;
      e.preventDefault();
      redo();
    } else if ((key === "ArrowLeft" || key === "ArrowRight") && !mod && !st.playing && canPlay() && st.fps) {
      e.preventDefault();
      const dir = key === "ArrowLeft" ? -1 : 1;
      const step = e.shiftKey ? 1 : frameToSec(1, st.fps);
      seek(currentTime() + dir * step);
    }
  });

  updateUi();

  return {
    syncFromDraw,
    drawOverlay,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onClick,
    setMedia,
    pause,
    confirmDiscardBeforeAnalyze,
    refreshLabels: updateUi,
  };
}
