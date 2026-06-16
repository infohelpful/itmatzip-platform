/**
 * Line Mode v4 — cue timing bar (zoomed window, drag threshold, relative block move).
 */

import { applyCueTimingDrag } from "../shared/line-mode/cue-ops.js?v=7";

const DRAG_THRESHOLD_PX = 4;

/**
 * @param {import("../shared/subtitles.js").SubtitleLine} cue
 * @param {number} mediaDur
 */
function computeViewWindow(cue, mediaDur) {
  const start = Number(cue.start) || 0;
  const end = Math.max(start, Number(cue.end) || start);
  const span = Math.max(end - start, 0.08);
  const pad = Math.max(1.5, span * 1.5);
  let viewStart = Math.max(0, start - pad);
  let viewEnd = Math.min(mediaDur > 0 ? mediaDur : end + pad, end + pad);
  if (viewEnd - viewStart < 3) {
    const mid = (start + end) / 2;
    viewStart = Math.max(0, mid - 1.5);
    viewEnd = Math.min(mediaDur > 0 ? mediaDur : mid + 1.5, mid + 1.5);
  }
  if (viewEnd <= viewStart) viewEnd = viewStart + 3;
  return { viewStart, viewEnd };
}

/**
 * @param {HTMLElement} container
 * @param {number} cueIndex
 * @param {import("../shared/subtitles.js").SubtitleLine} cue
 * @param {{
 *   mediaDurationSec?: number | null,
 *   snapGrid?: object | null,
 *   formatTime?: (sec: number) => string,
 *   getCue?: () => import("../shared/subtitles.js").SubtitleLine | undefined,
 *   onPreviewCueTiming?: (cueIndex: number, nextCue: import("../shared/subtitles.js").SubtitleLine) => void,
 *   onCommitCueTiming?: (cueIndex: number, nextCue: import("../shared/subtitles.js").SubtitleLine) => void,
 *   onSeekPreview?: (sec: number) => void,
 * }} opts
 */
export function mountCueTimingBar(container, cueIndex, cue, opts) {
  container.innerHTML = "";
  const mediaDur = Number(opts.mediaDurationSec) || Math.max(Number(cue.end) || 0, 1);
  const fmt = opts.formatTime || ((s) => `${s.toFixed(2)}s`);

  const root = document.createElement("div");
  root.className = "subtitle-cue-timing";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "줄 시간 조절");

  const hint = document.createElement("div");
  hint.className = "subtitle-cue-timing-hint";
  hint.textContent = "파란 막대를 끌어 이동 · 양끝 원=시작/끝 · Alt=스냅 끔";

  const track = document.createElement("div");
  track.className = "subtitle-cue-timing-track";

  const block = document.createElement("div");
  block.className = "subtitle-cue-timing-block";
  const handleStart = document.createElement("button");
  handleStart.type = "button";
  handleStart.className = "subtitle-cue-timing-handle subtitle-cue-timing-handle--start";
  handleStart.title = "시작 시간 — 끌어 조절";
  const handleEnd = document.createElement("button");
  handleEnd.type = "button";
  handleEnd.className = "subtitle-cue-timing-handle subtitle-cue-timing-handle--end";
  handleEnd.title = "끝 시간 — 끌어 조절";
  const body = document.createElement("div");
  body.className = "subtitle-cue-timing-body";
  body.title = "줄 전체 이동 — 끌어 조절";
  block.append(handleStart, body, handleEnd);
  track.appendChild(block);

  const label = document.createElement("div");
  label.className = "subtitle-cue-timing-label";

  root.append(hint, track, label);
  container.appendChild(root);

  const stopBubble = (ev) => {
    ev.stopPropagation();
  };
  root.addEventListener("mousedown", stopBubble);
  root.addEventListener("click", stopBubble);

  /** @type {{ start: number, end: number, viewStart: number, viewEnd: number } | null} */
  let live = null;

  const readCue = () => opts.getCue?.() ?? cue;

  const syncLiveFromCue = () => {
    const c = readCue();
    const start = Number(c.start) || 0;
    const end = Math.max(start, Number(c.end) || start);
    const { viewStart, viewEnd } = computeViewWindow(c, mediaDur);
    live = { start, end, viewStart, viewEnd };
  };

  const layout = () => {
    if (!live) syncLiveFromCue();
    const { start, end, viewStart, viewEnd } = live;
    const w = track.clientWidth || 240;
    const span = Math.max(viewEnd - viewStart, 0.001);
    const x0 = ((start - viewStart) / span) * w;
    const x1 = ((end - viewStart) / span) * w;
    block.style.left = `${Math.max(0, x0)}px`;
    block.style.width = `${Math.max(16, x1 - x0)}px`;
    const dur = end - start;
    label.textContent = `${fmt(start)} ~ ${fmt(end)}  (${dur.toFixed(2)}초)`;
  };

  /**
   * @param {number} clientX
   */
  const pointerToSec = (clientX) => {
    if (!live) syncLiveFromCue();
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(rect.width, 1)));
    const span = live.viewEnd - live.viewStart;
    return live.viewStart + ratio * span;
  };

  /**
   * @param {MouseEvent} ev
   * @param {"block" | "start" | "end"} handle
   */
  const beginDrag = (ev, handle) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    syncLiveFromCue();
    const originCue = readCue();
    let lastCue = originCue;
    const grabOffsetSec = handle === "block" ? pointerToSec(ev.clientX) - live.start : 0;
    const startX = ev.clientX;
    const startY = ev.clientY;
    let dragged = false;

    const onMove = (moveEv) => {
      const dx = moveEv.clientX - startX;
      const dy = moveEv.clientY - startY;
      if (!dragged) {
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
        dragged = true;
      }
      let t = pointerToSec(moveEv.clientX);
      if (handle === "block") t -= grabOffsetSec;
      const next = applyCueTimingDrag(
        originCue,
        handle,
        t,
        { ...opts.snapGrid, alt: moveEv.altKey },
        mediaDur,
      );
      lastCue = next;
      live.start = Number(next.start) || 0;
      live.end = Math.max(live.start, Number(next.end) || live.start);
      layout();
      opts.onPreviewCueTiming?.(cueIndex, next);
      opts.onSeekPreview?.(handle === "end" ? live.end : live.start);
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (!dragged) {
        syncLiveFromCue();
        layout();
        return;
      }
      opts.onCommitCueTiming?.(cueIndex, lastCue);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  body.addEventListener("mousedown", (ev) => beginDrag(ev, "block"));
  handleStart.addEventListener("mousedown", (ev) => beginDrag(ev, "start"));
  handleEnd.addEventListener("mousedown", (ev) => beginDrag(ev, "end"));

  syncLiveFromCue();
  layout();

  return {
    relayout: () => {
      syncLiveFromCue();
      layout();
    },
  };
}
