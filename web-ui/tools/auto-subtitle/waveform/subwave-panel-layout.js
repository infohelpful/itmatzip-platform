/**
 * AutoSubtitle SubtitleVirtualList + SubtitleWaveformCanvas — 파형 패널 가로 정렬.
 */

import { computeWordContextWindow } from "../line-zoom-window.js";
import { buildEdlSkipMapping } from "./edl-skip-mapping.js";

export const PANEL_MAX_PX = 448;

/**
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 */
export function clampPx(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * @param {HTMLElement | null} card
 * @param {string | null} activeWordId
 */
export function findActiveWordChip(card, activeWordId) {
  if (!card) return null;
  if (activeWordId) {
    try {
      const el = card.querySelector(`[data-word-id="${CSS.escape(activeWordId)}"]`);
      if (el instanceof HTMLElement) return el;
    } catch {
      /* ignore */
    }
  }
  const fallback =
    card.querySelector('[data-waveform-active-word-chip="1"]') ||
    card.querySelector(".subtitle-word-chip.is-selected");
  return fallback instanceof HTMLElement ? fallback : null;
}

/**
 * 1단: 마운트에 --subwave-panel-left-px (활성 단어 바뀔 때만 재계산).
 *
 * @param {HTMLElement} mount subtitle-waveform-mount
 * @param {HTMLElement} card subtitle-card
 * @param {string | null} activeWordId
 */
export function applySubwavePanelLeftPx(mount, card, activeWordId) {
  const mountRect = mount.getBoundingClientRect();
  if (mountRect.width <= 0) return false;

  const chipEl = findActiveWordChip(card, activeWordId);
  if (!chipEl) {
    mount.style.removeProperty("--subwave-panel-left-px");
    return false;
  }

  const chipRect = chipEl.getBoundingClientRect();
  const chipCenterPx = (chipRect.left + chipRect.right) / 2 - mountRect.left;
  const panelWidth = Math.min(mountRect.width, PANEL_MAX_PX);
  const ideal = chipCenterPx - panelWidth / 2;
  const maxLeft = Math.max(0, mountRect.width - panelWidth);
  const clamped = Math.max(0, Math.min(maxLeft, ideal));
  mount.style.setProperty("--subwave-panel-left-px", `${Math.round(clamped)}px`);
  return true;
}

/**
 * @param {HTMLElement} mount
 * @param {HTMLElement} card
 * @param {string | null} activeWordId
 * @returns {() => void}
 */
export function scheduleSubwavePanelLeftPx(mount, card, activeWordId) {
  if (applySubwavePanelLeftPx(mount, card, activeWordId)) {
    return () => mount.style.removeProperty("--subwave-panel-left-px");
  }

  let settled = false;
  const ro = new ResizeObserver(() => {
    if (settled) return;
    if (applySubwavePanelLeftPx(mount, card, activeWordId)) {
      settled = true;
      ro.disconnect();
    }
  });
  ro.observe(mount);
  ro.observe(card);
  return () => {
    ro.disconnect();
    mount.style.removeProperty("--subwave-panel-left-px");
  };
}

/**
 * 2단: boxLayoutPx first lock — 칩 중앙 ↔ 활성 단어 시간 중앙.
 *
 * @param {{
 *   mount: HTMLElement,
 *   card: HTMLElement,
 *   chipEl: HTMLElement,
 *   activeWord: { start: number, end: number },
 *   ctxWin: { windowStart: number, windowEnd: number },
 *   skipRanges: { start: number, end: number }[],
 * }} params
 */
export function computeFirstBoxLayoutPx({ mount, card, chipEl, activeWord, ctxWin, skipRanges }) {
  const mountRect = mount.getBoundingClientRect();
  const mountW = mountRect.width;
  const mountLeft = mountRect.left;
  if (mountW <= 0) return null;

  const boxWidth0 = Math.max(1, Math.min(mountW, PANEL_MAX_PX));
  const futureMap = buildEdlSkipMapping(
    { start: ctxWin.windowStart, end: ctxWin.windowEnd },
    skipRanges,
  );
  const activeSpan = Math.max(futureMap.activeSpanSec, 1e-6);
  const pps = boxWidth0 / activeSpan;

  const wa = Math.min(activeWord.start, activeWord.end);
  const wb = Math.max(activeWord.start, activeWord.end);
  const wMid = (wa + wb) / 2;

  const chipRect = chipEl.getBoundingClientRect();
  const chipCenterFromMount = (chipRect.left + chipRect.right) / 2 - mountLeft;
  const wMidPxOnBox = futureMap.mediaSecToActiveSec(wMid) * pps;
  const idealLeft = chipCenterFromMount - wMidPxOnBox;
  const maxLeft = Math.max(0, mountW - boxWidth0);
  const left = clampPx(idealLeft, 0, maxLeft);

  return {
    left,
    width: boxWidth0,
    pps,
    viewWin: { start: ctxWin.windowStart, end: ctxWin.windowEnd },
  };
}

/**
 * 흡수 commit 후 re-lock.
 *
 * @param {{
 *   dir: 'start' | 'end',
 *   prevWin: { start: number, end: number },
 *   prevLayout: { left: number, width: number },
 *   pps: number,
 *   ctxWin: { windowStart: number, windowEnd: number },
 *   skipRanges: { start: number, end: number }[],
 * }} params
 */
export function computeRelockBoxLayoutPx({
  dir,
  prevWin,
  prevLayout,
  pps,
  ctxWin,
  skipRanges,
}) {
  let nextStart = prevWin.start;
  let nextEnd = prevWin.end;
  if (dir === "end") {
    nextEnd = Math.max(prevWin.end, ctxWin.windowEnd);
  } else {
    nextStart = Math.min(prevWin.start, ctxWin.windowStart);
  }
  const newMap = buildEdlSkipMapping({ start: nextStart, end: nextEnd }, skipRanges);
  const newWidth = pps * Math.max(newMap.activeSpanSec, 1e-6);
  const nextLeft =
    dir === "end" ? prevLayout.left : prevLayout.left + prevLayout.width - newWidth;
  return {
    left: nextLeft,
    width: newWidth,
    viewWin: { start: nextStart, end: nextEnd },
  };
}

/**
 * 카드 좌우 1% 패딩 안으로 스트립 marginLeft 미세 보정.
 *
 * @param {{ left: number, width: number }} boxLayoutPx
 * @param {HTMLElement} card
 * @param {HTMLElement} stripEl
 */
export function cardBoundsDeltaForStrip(boxLayoutPx, card, stripEl) {
  const ar = card.getBoundingClientRect();
  const sr = stripEl.getBoundingClientRect();
  const Wwave = sr.width;
  const Wcard = ar.width;
  if (!(Wcard > 1)) return 0;
  const pad = Wcard * 0.01;
  if (Wwave > Wcard - 2 * pad + 0.75) return 0;
  const lo = ar.left + pad - sr.left;
  const hi = ar.right - pad - sr.right;
  if (lo > hi + 0.5) return 0;
  const delta = Math.max(lo, Math.min(hi, 0));
  if (Math.abs(delta) < 0.25) return 0;
  return delta;
}
