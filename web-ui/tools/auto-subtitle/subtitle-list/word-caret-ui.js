/**
 * AutoSubtitle SubtitleVirtualList — 캐럿 UI·키보드·hover 정책.
 */

import { pickActiveCueIndex, pickActiveWordIndex } from "../playback.js?v=24";
import {
  nearestValidStorageCaret,
  renderableCaretToStorageCaret,
  stepStorageCaretByRenderable,
  storageCaretToRenderableCaret,
  visibleWordStorageIndices,
} from "../shared/subtitle-word-caret-map.js";
import { getCueWords } from "../subtitle-words.js";

/** @typedef {{
 *   storageCaret: number,
 *   caretVisible: boolean,
 *   caretBlink: boolean,
 *   rowHasFocus: boolean,
 *   focusedRenderable: number | null,
 *   hoveredRenderable: number | null,
 *   selectionAnchor: number | null,
 * }} RowCaretState */

let globalHoveredRowIndex = null;
let lastCardFocusIndex = null;
/** @type {'none' | 'caret' | 'wholeLine'} */
let spaceSeekIntent = "none";
/** 재생 중 화살표로 일시정지한 뒤 캐럿 네비 허용 (행 index) */
let keyboardPauseCaretIndex = -1;
/** 화살표 일시정지 직후 playhead→캐럿 동기화 1회 스킵 */
let skipPlayheadCaretSyncOnPause = false;

/** @type {Map<number, RowCaretState>} */
const rowCaretByIndex = new Map();

/** @type {((container: HTMLElement, cues: object[], opts: object) => void) | null} */
let rerenderHook = null;
/** 전체 카드 리렌더 중 focusout 으로 캐럿 상태가 지워지지 않게 */
let caretListRerenderInProgress = false;
/** 구조 변경 직후 focusout 1~2틱 무시 (Electron blurCapture 타이밍) */
let caretListStructuralGuardUntil = 0;
/** 오버레이 캐럿은 한 줄만 — 이중 캐럿·깜빡임 방지 */
let activeCaretCardIndex = null;
/** @type {number} */
let caretFocusGeneration = 0;
/** @type {{ container: HTMLElement, cues: object[], opts: object, cardIndex: number, storageCaret: number, detail?: object } | null} */
let pendingFocusCaret = null;
let documentFocusGuardInstalled = false;

/**
 * @param {object} opts
 */
function isPlaybackActive(opts) {
  return Boolean(opts.getIsPlaying?.() ?? opts.isPlaying);
}

/**
 * @param {object} opts
 */
function getPlayheadSec(opts) {
  const v = opts.getPlayheadSec?.() ?? opts.playheadSec;
  return Number(v) || 0;
}

/**
 * @param {(container: HTMLElement, cues: object[], opts: object) => void} fn
 */
export function setCaretRerenderHook(fn) {
  rerenderHook = fn;
  installCaretDocumentFocusGuard();
}

export function clearAllRowCaretState() {
  rowCaretByIndex.clear();
  globalHoveredRowIndex = null;
  lastCardFocusIndex = null;
  activeCaretCardIndex = null;
  spaceSeekIntent = "none";
  keyboardPauseCaretIndex = -1;
  skipPlayheadCaretSyncOnPause = false;
  pendingFocusCaret = null;
}

/**
 * 카드 리렌더·단어 삭제 직후 focusout 과 포커스 경쟁 방지.
 *
 * @param {number} [ms]
 */
export function markCaretListStructuralMutation(ms = 80) {
  caretListRerenderInProgress = true;
  caretListStructuralGuardUntil = performance.now() + Math.max(32, ms);
  window.setTimeout(() => {
    caretListRerenderInProgress = false;
  }, Math.max(32, ms));
}

/**
 * @param {readonly object[]} cues
 */
export function sanitizeRowCaretMapForCues(cues) {
  const maxIdx = (cues?.length ?? 0) - 1;
  for (const key of [...rowCaretByIndex.keys()]) {
    if (key < 0 || key > maxIdx) rowCaretByIndex.delete(key);
  }
  for (let i = 0; i <= maxIdx; i += 1) {
    const words = getCueWords(cues[i] ?? {});
    const st = rowCaretByIndex.get(i);
    if (!st) continue;
    st.storageCaret = nearestValidStorageCaret(words, st.storageCaret);
    if (st.selectionAnchor != null) {
      st.selectionAnchor = nearestValidStorageCaret(words, st.selectionAnchor);
    }
  }
  if (activeCaretCardIndex != null && activeCaretCardIndex > maxIdx) {
    activeCaretCardIndex = null;
  }
}

function isCaretStructuralGuardActive() {
  return caretListRerenderInProgress || performance.now() < caretListStructuralGuardUntil;
}

/**
 * @param {HTMLElement | null} container
 * @param {readonly object[]} cues
 * @param {object} opts
 * @param {number} exceptCardIndex
 */
function clearOtherRowCaretStateExcept(exceptCardIndex) {
  for (const [idx, st] of rowCaretByIndex) {
    if (idx === exceptCardIndex) continue;
    st.caretVisible = false;
    st.caretBlink = false;
    st.focusedRenderable = null;
    st.rowHasFocus = false;
    st.hoveredRenderable = null;
  }
  if (exceptCardIndex < 0) activeCaretCardIndex = null;
}

/**
 * @param {HTMLElement | null} container
 * @param {readonly object[]} cues
 * @param {object} opts
 * @param {number} exceptCardIndex
 */
function clearCaretUiOnOtherRows(container, cues, opts, exceptCardIndex) {
  clearOtherRowCaretStateExcept(exceptCardIndex);
  if (!container) return;
  const playing = isPlaybackActive(opts);
  for (const [idx] of rowCaretByIndex) {
    if (idx === exceptCardIndex) continue;
    if (cues[idx]) {
      patchCaretVisibility(container, idx, getCueWords(cues[idx]), playing);
    }
  }
}

function installCaretDocumentFocusGuard() {
  if (documentFocusGuardInstalled) return;
  documentFocusGuardInstalled = true;
  document.addEventListener("focusin", () => {
    if (isCaretStructuralGuardActive()) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    if (active.id?.startsWith("subtitle-caret-")) {
      const m = /^subtitle-caret-(\d+)-/.exec(active.id);
      if (m) activeCaretCardIndex = Number(m[1]);
      return;
    }
    if (active.closest(".subtitle-card-textarea")) {
      activeCaretCardIndex = null;
      const card = active.closest(".subtitle-card[data-cue-index]");
      if (card) {
        const idx = Number(card.dataset.cueIndex);
        const st = rowCaretByIndex.get(idx);
        if (st) {
          st.caretVisible = false;
          st.caretBlink = false;
          st.rowHasFocus = false;
          st.focusedRenderable = null;
          st.hoveredRenderable = null;
        }
      }
      return;
    }
    const card = active.closest(".subtitle-card[data-cue-index]");
    if (card) return;
    activeCaretCardIndex = null;
    globalHoveredRowIndex = null;
    for (const [idx, st] of rowCaretByIndex) {
      st.caretVisible = false;
      st.caretBlink = false;
      st.focusedRenderable = null;
      st.rowHasFocus = false;
    }
  });
}

export function setSkipPlayheadCaretSyncOnPause(skip) {
  skipPlayheadCaretSyncOnPause = Boolean(skip);
}

export function resetKeyboardPauseCaret() {
  keyboardPauseCaretIndex = -1;
}

export function resetSpaceSeekIntent() {
  spaceSeekIntent = "none";
}

/**
 * @param {number} cardIndex
 * @param {readonly object[]} words
 */
export function prepareRowCaretForRender(cardIndex, words) {
  const st = getRowCaret(cardIndex, words);
  st.storageCaret = nearestValidStorageCaret(words, st.storageCaret);
  if (st.selectionAnchor != null) {
    st.selectionAnchor = nearestValidStorageCaret(words, st.selectionAnchor);
  }
}

/**
 * @param {number} cardIndex
 * @param {readonly object[]} words
 */
function getRowCaret(cardIndex, words) {
  let s = rowCaretByIndex.get(cardIndex);
  if (!s) {
    s = {
      storageCaret: nearestValidStorageCaret(words, words.length),
      caretVisible: false,
      caretBlink: false,
      rowHasFocus: false,
      focusedRenderable: null,
      hoveredRenderable: null,
      selectionAnchor: null,
    };
    rowCaretByIndex.set(cardIndex, s);
  }
  return s;
}

/**
 * @param {HTMLElement} container
 * @param {readonly object[]} cues
 * @param {object} opts
 */
function requestRerender(container, cues, opts) {
  caretListRerenderInProgress = true;
  rerenderHook?.(container, cues, opts);
  queueMicrotask(() => {
    caretListRerenderInProgress = false;
  });
}

/**
 * 같은 줄 안에서 캐럿만 갱신 (전체 리스트 리렌더 없음).
 *
 * @param {HTMLElement | null} container
 * @param {number} cardIndex
 * @param {readonly object[]} words
 * @param {object} opts
 */
function refreshCaretRowUi(container, cardIndex, words, opts) {
  if (!container) return;
  const playing = isPlaybackActive(opts);
  patchCaretVisibility(container, cardIndex, words, playing);
  const st = getRowCaret(cardIndex, words);
  const ae = document.activeElement;
  if (ae instanceof HTMLElement && ae.closest(".subtitle-card-textarea")) {
    const card = ae.closest(".subtitle-card[data-cue-index]");
    if (card && Number(card.dataset.cueIndex) === cardIndex) return;
  }
  if (st.focusedRenderable != null && st.caretVisible) {
    focusRenderableCaretButton(cardIndex, st.focusedRenderable);
  }
}

/**
 * 줄 텍스트(textarea) 편집 — 단어 캐럿 UI 숨김·재생 중지.
 *
 * @param {number} cardIndex
 * @param {readonly object[]} words
 * @param {HTMLElement | null} container
 * @param {object} opts
 */
function enterTextareaEditMode(cardIndex, words, container, opts) {
  if (isPlaybackActive(opts)) opts.onPausePlayback?.();
  spaceSeekIntent = "none";
  activeCaretCardIndex = null;
  globalHoveredRowIndex = null;
  const st = getRowCaret(cardIndex, words);
  st.caretVisible = false;
  st.caretBlink = false;
  st.rowHasFocus = false;
  st.focusedRenderable = null;
  st.hoveredRenderable = null;
  patchCaretVisibility(container, cardIndex, words, isPlaybackActive(opts));
}

/**
 * @param {number} cardIndex
 * @param {readonly object[]} words
 * @param {number} storageCaret
 * @param {boolean} blink
 */
function activateCaretAt(cardIndex, words, storageCaret, blink, armSpaceSeek = true) {
  clearOtherRowCaretStateExcept(cardIndex);
  const st = getRowCaret(cardIndex, words);
  const safe = nearestValidStorageCaret(words, storageCaret);
  const rc = storageCaretToRenderableCaret(words, safe);
  activeCaretCardIndex = cardIndex;
  st.storageCaret = safe;
  st.caretVisible = true;
  st.caretBlink = blink;
  st.rowHasFocus = true;
  st.focusedRenderable = rc;
  st.hoveredRenderable = null;
  lastCardFocusIndex = cardIndex;
  if (armSpaceSeek) spaceSeekIntent = "caret";
  focusRenderableCaretButton(cardIndex, rc);
}

/**
 * @param {number} cardIndex
 * @param {number} renderableCi
 */
function focusRenderableCaretButton(cardIndex, renderableCi) {
  const gen = ++caretFocusGeneration;
  requestAnimationFrame(() => {
    if (gen !== caretFocusGeneration) return;
    const el = document.getElementById(`subtitle-caret-${cardIndex}-${renderableCi}`);
    const active = document.activeElement;
    if (el instanceof HTMLElement && active?.id !== el.id) {
      el.focus({ preventScroll: true });
    }
  });
}

function syncCaretFromFocus(cardIndex, words, renderableCaret) {
  const st = getRowCaret(cardIndex, words);
  const storage = renderableCaretToStorageCaret(words, renderableCaret);
  st.storageCaret = storage;
  st.caretVisible = true;
  st.caretBlink = true;
  st.rowHasFocus = true;
  st.focusedRenderable = renderableCaret;
  st.hoveredRenderable = null;
  lastCardFocusIndex = cardIndex;
  spaceSeekIntent = "caret";
}

/**
 * @param {RowCaretState} st
 * @param {number} cardIndex
 * @param {number} renderableCi
 * @param {boolean} playing
 */
function isCaretShownAt(st, cardIndex, renderableCi, playing) {
  const isHoverPos = st.hoveredRenderable === renderableCi;
  const isFocusPos =
    st.rowHasFocus && st.focusedRenderable === renderableCi && st.caretVisible;
  if (isHoverPos) return true;
  if (playing && keyboardPauseCaretIndex !== cardIndex) return false;
  return isFocusPos;
}

function clearHoverOnOtherRows(exceptCardIndex) {
  for (const [idx, st] of rowCaretByIndex) {
    if (idx === exceptCardIndex) continue;
    st.hoveredRenderable = null;
  }
}

/**
 * @param {HTMLElement} container
 * @param {readonly object[]} cues
 * @param {boolean} playing
 * @param {Iterable<number>} cardIndices
 */
function patchCaretRowsVisibility(container, cues, playing, cardIndices) {
  if (!container) return;
  const seen = new Set();
  for (const idx of cardIndices) {
    if (idx == null || idx < 0 || seen.has(idx)) continue;
    seen.add(idx);
    const words = getCueWords(cues[idx] ?? {});
    patchCaretVisibility(container, idx, words, playing);
  }
}

/**
 * @param {HTMLElement} container
 * @param {number} cardIndex
 * @param {readonly object[]} words
 * @param {boolean} playing
 */
/**
 * @param {number} cardIndex
 * @param {readonly object[]} words
 * @param {number} visibleIndex
 * @param {number} storageWi
 * @param {HTMLElement} container
 * @param {boolean} playing
 */
function setHoverCaretAt(cardIndex, words, visibleIndex, container, opts, cues) {
  const st = getRowCaret(cardIndex, words);
  if (st.hoveredRenderable === visibleIndex && globalHoveredRowIndex === cardIndex) return;
  clearHoverOnOtherRows(cardIndex);
  st.hoveredRenderable = visibleIndex;
  globalHoveredRowIndex = cardIndex;
  const playing = isPlaybackActive(opts);
  const rows = new Set([cardIndex]);
  if (activeCaretCardIndex != null) rows.add(activeCaretCardIndex);
  patchCaretRowsVisibility(container, cues, playing, rows);
}

/**
 * @param {HTMLElement} container
 * @param {number} cardIndex
 * @param {readonly object[]} words
 * @param {boolean} playing
 */
function dismissSpaceSeekIntent(container, cardIndex, words, opts, cues) {
  spaceSeekIntent = "none";
  dismissHoverCaretUi(container, cardIndex, words, opts, cues);
}

function dismissHoverCaretUi(container, cardIndex, words, opts, cues) {
  const st = getRowCaret(cardIndex, words);
  st.hoveredRenderable = null;
  globalHoveredRowIndex = null;
  const playing = isPlaybackActive(opts);
  const rows = new Set([cardIndex]);
  if (activeCaretCardIndex != null) rows.add(activeCaretCardIndex);
  patchCaretRowsVisibility(container, cues, playing, rows);
}

/**
 * @param {number} cardIndex
 * @param {readonly object[]} words
 * @param {boolean} [keepHoverVisible]
 */
function clearRowCaretState(cardIndex, words, keepHoverVisible = false) {
  const st = getRowCaret(cardIndex, words);
  if (!keepHoverVisible) {
    st.caretVisible = false;
    st.caretBlink = false;
    st.hoveredRenderable = null;
  }
  st.rowHasFocus = false;
  st.focusedRenderable = null;
  st.selectionAnchor = null;
  if (keyboardPauseCaretIndex === cardIndex) keyboardPauseCaretIndex = -1;
  if (lastCardFocusIndex === cardIndex && !keepHoverVisible) lastCardFocusIndex = null;
}

/**
 * @param {HTMLElement} container
 * @param {number} cardIndex
 * @param {readonly object[]} words
 * @param {boolean} playing
 */
function patchCaretVisibility(container, cardIndex, words, playing) {
  const card = container.querySelector(`.subtitle-card[data-cue-index="${cardIndex}"]`);
  if (!card) return;
  const st = getRowCaret(cardIndex, words);
  const n = visibleWordStorageIndices(words).length;
  const hasSelection =
    st.selectionAnchor !== null && st.selectionAnchor !== st.storageCaret;
  const selStart = hasSelection ? Math.min(st.selectionAnchor, st.storageCaret) : -1;
  const selEnd = hasSelection ? Math.max(st.selectionAnchor, st.storageCaret) : -1;

  card.querySelectorAll(".subtitle-word-caret--overlay").forEach((btn) => {
    const el = /** @type {HTMLButtonElement} */ (btn);
    const k = Number(el.id.split("-").pop());
    if (!Number.isFinite(k)) return;
    const shown = isCaretShownAt(st, cardIndex, k, playing);
    const isFocus = st.rowHasFocus && st.focusedRenderable === k;
    const isHover = st.hoveredRenderable === k && !isFocus;
    el.classList.toggle("subtitle-word-caret--visible", shown);
    el.classList.toggle("subtitle-word-caret--hover", shown && isHover);
    el.classList.toggle("subtitle-word-caret--active", shown && isFocus);
    el.classList.toggle(
      "subtitle-word-caret--blink",
      shown && st.caretBlink && isFocus,
    );
  });

  card.querySelectorAll(".subtitle-word-chip").forEach((chip) => {
    const wi = Number(/** @type {HTMLElement} */ (chip).dataset.wordIndex);
    const text = chip.querySelector(".subtitle-word-chip-text");
    if (!text || !Number.isFinite(wi)) return;
    const selected = hasSelection && wi >= selStart && wi < selEnd;
    text.classList.toggle("subtitle-word-chip-text--selected", selected);
  });
}

/**
 * @param {HTMLElement} inner
 * @param {number} cardIndex
 * @param {number[]} visibleStorageIndices
 */
function measureCaretEdgesFromDom(inner, cardIndex, visibleStorageIndices) {
  const innerRect = inner.getBoundingClientRect();
  const n = visibleStorageIndices.length;
  if (innerRect.width < 8 || n === 0) return null;

  const chipEl = (vi) => {
    const si = visibleStorageIndices[vi];
    if (si == null) return null;
    return document.getElementById(`subtitle-word-${cardIndex}-${si}`);
  };

  const centers = [];
  const innerW = innerRect.width;
  for (let k = 0; k <= n; k += 1) {
    if (k === 0) {
      const r0 = chipEl(0)?.getBoundingClientRect();
      centers[k] = r0 ? (r0.left - innerRect.left) * 0.5 : 4;
    } else if (k === n) {
      const rLast = chipEl(n - 1)?.getBoundingClientRect();
      const rightLast = rLast ? rLast.right - innerRect.left : innerW - 8;
      centers[k] = Math.min(rightLast + 8, innerW - 4);
    } else {
      const rPrev = chipEl(k - 1)?.getBoundingClientRect();
      const rCurr = chipEl(k)?.getBoundingClientRect();
      if (rPrev && rCurr) {
        const a = rPrev.right - innerRect.left;
        const b = rCurr.left - innerRect.left;
        centers[k] = (a + b) * 0.5;
      } else {
        centers[k] = (centers[k - 1] + innerW) * 0.5;
      }
    }
  }

  let maxChipH = 0;
  for (let vi = 0; vi < n; vi += 1) {
    const cr = chipEl(vi)?.getBoundingClientRect();
    if (cr) maxChipH = Math.max(maxChipH, cr.height);
  }
  const innerH = innerRect.height;
  const barPx =
    maxChipH > 4
      ? Math.round(Math.min(Math.max(maxChipH * 0.94, 18), Math.max(innerH, maxChipH)))
      : Math.round(Math.min(Math.max(innerH * 0.85, 20), 48));
  inner.style.setProperty("--subtitle-caret-bar-height", `${barPx}px`);

  const tops = [];
  const fallbackMid = innerH > 0.5 ? innerH * 0.5 : 22;
  for (let k = 0; k <= n; k += 1) {
    if (k === 0) {
      const r0 = chipEl(0)?.getBoundingClientRect();
      tops[k] = r0 ? r0.top + r0.height / 2 - innerRect.top : fallbackMid;
    } else if (k === n) {
      const rl = chipEl(n - 1)?.getBoundingClientRect();
      tops[k] = rl ? rl.top + rl.height / 2 - innerRect.top : fallbackMid;
    } else {
      const ra = chipEl(k - 1)?.getBoundingClientRect();
      const rb = chipEl(k)?.getBoundingClientRect();
      tops[k] = ra && rb ? (ra.bottom + rb.top) / 2 - innerRect.top : fallbackMid;
    }
  }

  return { leftPx: centers, topPx: tops };
}

function scheduleCaretLayout(inner, cardIndex, words, visibleStorageIndices, container, playing) {
  requestAnimationFrame(() => {
    const measured = measureCaretEdgesFromDom(inner, cardIndex, visibleStorageIndices);
    if (!measured) return;
    for (let k = 0; k < measured.leftPx.length; k += 1) {
      const btn = inner.querySelector(`#subtitle-caret-${cardIndex}-${k}`);
      if (!btn) continue;
      btn.style.left = `${measured.leftPx[k]}px`;
      if (Number.isFinite(measured.topPx[k])) {
        btn.style.top = `${measured.topPx[k]}px`;
        btn.style.transform = "translate(-50%, -50%)";
      }
    }
    patchCaretVisibility(container, cardIndex, words, playing);
  });
}

/**
 * @param {HTMLElement} container
 * @param {readonly object[]} cues
 * @param {object} opts
 * @param {number} cardIndex
 * @param {number} storageCaret
 */
/**
 * @param {HTMLElement | null} container
 * @param {readonly object[]} cues
 * @param {object} opts
 * @param {number} cardIndex
 * @param {number} storageCaret
 * @param {{ seek?: boolean }} [detail]
 */
export function requestFocusCaret(container, cues, opts, cardIndex, storageCaret, detail) {
  if (cardIndex < 0 || !container) return;
  const words = getCueWords(cues[cardIndex] ?? {});
  const crossed = lastCardFocusIndex != null && lastCardFocusIndex !== cardIndex;
  if (crossed && detail?.seek !== false && cues[cardIndex] && opts.onCardNavigate) {
    opts.onCardNavigate(cues[cardIndex].start);
  }
  clearCaretUiOnOtherRows(container, cues, opts, cardIndex);
  activateCaretAt(cardIndex, words, storageCaret, true);
  globalHoveredRowIndex = null;
  refreshCaretRowUi(container, cardIndex, words, opts);
}

/**
 * renderCuesTable 직후 — DOM 붙은 다음 틱에 캐럿 포커스 (focusout 경쟁 방지).
 */
export function requestFocusCaretDeferred(container, cues, opts, cardIndex, storageCaret, detail) {
  pendingFocusCaret = { container, cues, opts, cardIndex, storageCaret, detail };
  markCaretListStructuralMutation(96);
  queueMicrotask(() => {
    const p = pendingFocusCaret;
    pendingFocusCaret = null;
    if (!p || p.cardIndex < 0) return;
    requestFocusCaret(p.container, p.cues, p.opts, p.cardIndex, p.storageCaret, p.detail);
  });
}

/**
 * @param {HTMLElement} container
 * @param {readonly object[]} cues
 * @param {object} opts
 * @param {number} cardIndex
 * @param {number | "end"} caret
 */
/**
 * @param {KeyboardEvent} e
 * @param {HTMLElement | null} container
 * @param {readonly object[]} cues
 * @param {object} opts
 */
/**
 * @param {object} cue
 * @param {number} playheadSec
 */
function storageCaretForPlayhead(cue, playheadSec) {
  const words = getCueWords(cue);
  let wi = pickActiveWordIndex(cue, playheadSec);
  if (wi >= 0) return wi;
  const vis = visibleWordStorageIndices(words);
  for (const i of vis) {
    if ((words[i]?.start ?? 0) >= playheadSec - 1e-4) return i;
  }
  for (let j = vis.length - 1; j >= 0; j -= 1) {
    const i = vis[j];
    if ((words[i]?.start ?? 0) <= playheadSec + 1e-4) return i;
  }
  return vis.length ? vis[0] : nearestValidStorageCaret(words, 0);
}

/**
 * 일시정지 시 재생 헤드에 해당하는 단어 블록 앞에 깜박이는 캐럿.
 *
 * @param {HTMLElement | null} container
 * @param {readonly object[]} cues
 * @param {object} opts
 * @param {number} playheadSec
 */
/**
 * @param {number} cardIndex
 * @param {number} storageCaret
 * @param {object} opts
 */
function playAtCaret(cardIndex, storageCaret, opts) {
  const cue = opts.getCues?.()?.[cardIndex] ?? null;
  if (!cue) return;
  const words = getCueWords(cue);
  if (!words.length) {
    opts.onWaveformSeekAndPlay?.(cue.start ?? 0);
    return;
  }
  const vis = visibleWordStorageIndices(words);
  if (!vis.length) {
    opts.onWaveformSeekAndPlay?.(cue.start ?? 0);
    return;
  }
  const c = Math.max(0, Math.min(storageCaret, words.length));
  let pick = vis.find((i) => i >= c);
  if (pick == null) pick = vis[vis.length - 1];
  opts.onPlayAtCaret?.(cardIndex, pick);
}

/**
 * @param {object} cue
 * @param {number} playheadSec
 */
function caretIndexBeforePlayheadWord(cue, playheadSec) {
  const words = getCueWords(cue);
  if (!words.length) return 0;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w.is_deleted) continue;
    if (playheadSec >= w.start && playheadSec < w.end) return i;
  }
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w.is_deleted) continue;
    if (playheadSec < w.start) return i;
  }
  return words.length;
}

/**
 * @param {HTMLElement | null} container
 * @param {readonly object[]} cues
 * @param {object} opts
 * @param {number} activeCueIndex
 * @param {number} playheadSec
 */
export function syncCaretOnPlaybackPause(container, cues, opts, activeCueIndex, playheadSec) {
  if (skipPlayheadCaretSyncOnPause) {
    skipPlayheadCaretSyncOnPause = false;
    return;
  }
  if (activeCueIndex < 0 || !container) return;
  const cue = cues[activeCueIndex];
  if (!cue || cue.is_silence) return;
  const root = container.querySelector(`.subtitle-card[data-cue-index="${activeCueIndex}"]`);
  const ae = document.activeElement;
  if (ae instanceof HTMLElement && root?.contains(ae) && ae.closest(".subtitle-card-textarea")) {
    return;
  }
  const words = getCueWords(cue);
  if (!words.length) return;
  const snap = nearestValidStorageCaret(words, caretIndexBeforePlayheadWord(cue, playheadSec));
  keyboardPauseCaretIndex = -1;
  activateCaretAt(activeCueIndex, words, snap, true, false);
  refreshCaretRowUi(container, activeCueIndex, words, opts);
}

/**
 * @param {HTMLElement | null} container
 * @param {readonly object[]} cues
 * @param {object} opts
 * @param {number} cardIndex
 */
export function restoreCaretFocusAfterWaveform(container, cues, opts, cardIndex) {
  if (cardIndex < 0 || !container) return;
  const words = cues[cardIndex]?.words ?? [];
  const st = getRowCaret(cardIndex, words);
  if (!st.rowHasFocus || st.focusedRenderable == null) return;
  const ae = document.activeElement;
  if (ae instanceof HTMLElement && ae.id?.startsWith("subtitle-caret-")) return;
  if (ae instanceof HTMLElement && ae.closest(".subtitle-card-textarea")) return;
  st.caretVisible = true;
  st.caretBlink = true;
  refreshCaretRowUi(container, cardIndex, words, opts);
}

/**
 * @param {KeyboardEvent} e
 * @param {HTMLElement | null} container
 * @param {readonly object[]} cues
 * @param {object} opts
 */
export function handleGlobalArrowKey(e, container, cues, opts) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
  const target = e.target;
  if (target instanceof HTMLElement) {
    if (target.closest("input,textarea,[contenteditable='true']")) return;
    if (target.closest(".subtitle-card")) return;
  }
  if (!cues.length || !container) return;
  e.preventDefault();
  if (isPlaybackActive(opts)) opts.onPausePlayback?.();
  const ai =
    typeof opts.activeCueIndex === "number" && opts.activeCueIndex >= 0
      ? opts.activeCueIndex
      : opts.selectedCueIndex ?? -1;
  const ph = Number(opts.playheadSec) || 0;
  if (ai >= 0 && ai < cues.length) {
    const cue = cues[ai];
    const wi = caretIndexBeforePlayheadWord(cue, ph);
    requestFocusCaret(container, cues, opts, ai, wi);
    return;
  }
  requestFocusCaret(container, cues, opts, 0, 0);
}

export function placeCaretAtPlayhead(container, cues, opts, playheadSec) {
  const ci = pickActiveCueIndex(cues, playheadSec);
  if (ci < 0 || !container) return;
  const cue = cues[ci];
  if (!cue || cue.is_silence) return;
  const words = getCueWords(cue);
  const wi = storageCaretForPlayhead(cue, playheadSec);
  opts.onSelectCue?.(ci, { seek: false, scroll: false });
  activateCaretAt(ci, words, wi, true, false);
  globalHoveredRowIndex = null;
  refreshCaretRowUi(container, ci, words, opts);
}

/**
 * 포커스된 줄의 storage 캐럿 위치에서 재생 (정지 후 Space 재개).
 *
 * @param {HTMLElement | null} container
 * @param {readonly object[]} cues
 * @param {object} opts
 */
export function resumePlaybackFromFocusedCaret(container, cues, opts) {
  const cardIndex =
    lastCardFocusIndex >= 0
      ? lastCardFocusIndex
      : typeof opts.selectedCueIndex === "number"
        ? opts.selectedCueIndex
        : -1;
  if (cardIndex < 0) return false;
  const cue = cues[cardIndex];
  if (!cue || cue.is_silence) return false;
  const words = getCueWords(cue);
  const st = getRowCaret(cardIndex, words);
  if (!st.caretVisible && st.focusedRenderable == null) return false;
  playAtCaret(cardIndex, st.storageCaret, opts);
  return true;
}

export function tryHandleCaretSpaceKey(e, container, cues, opts) {
  if (e.key !== " " && e.code !== "Space") return false;
  if (e.isComposing) return false;
  const target = e.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return false;
  if (target instanceof HTMLTextAreaElement) return false;

  if (isPlaybackActive(opts)) {
    opts.onTogglePlayback?.(true);
    return true;
  }

  const cardIndex = lastCardFocusIndex ?? -1;
  if (spaceSeekIntent === "wholeLine" && cardIndex >= 0) {
    const cue = cues[cardIndex];
    opts.onWaveformSeekAndPlay?.(cue?.start ?? 0);
    spaceSeekIntent = "none";
    return true;
  }

  /* 정지 상태: Space = 재생/일시정지 토글 (playAtCaret 으로 다음 단어로 점프하지 않음) */
  opts.onTogglePlayback?.(true);
  return true;
}

export function requestFocusRow(container, cues, opts, cardIndex, caret) {
  if (cardIndex < 0) return;
  if (isPlaybackActive(opts)) opts.onPausePlayback?.();
  const crossed = lastCardFocusIndex !== cardIndex;
  if (crossed && cues[cardIndex] && opts.onCardNavigate) {
    opts.onCardNavigate(cues[cardIndex].start);
  }
  lastCardFocusIndex = cardIndex;
  activeCaretCardIndex = null;
  clearCaretUiOnOtherRows(container, cues, opts, -1);
  const st = getRowCaret(cardIndex, getCueWords(cues[cardIndex] ?? {}));
  st.caretVisible = false;
  st.caretBlink = false;
  st.rowHasFocus = false;
  st.focusedRenderable = null;
  requestRerender(container, cues, opts);
  requestAnimationFrame(() => {
    const ta = document.querySelector(
      `.subtitle-card[data-cue-index="${cardIndex}"] .subtitle-card-textarea`,
    );
    if (!(ta instanceof HTMLTextAreaElement)) return;
    ta.focus({ preventScroll: true });
    if (caret === "end") {
      const len = ta.value.length;
      ta.setSelectionRange(len, len);
    } else {
      const c = Math.max(0, Math.min(caret, ta.value.length));
      ta.setSelectionRange(c, c);
    }
  });
}

/**
 * @param {KeyboardEvent} e
 * @param {number} renderableCi
 * @param {number} cardIndex
 * @param {readonly object[]} words
 * @param {readonly object[]} cues
 * @param {HTMLElement} container
 * @param {object} opts
 */
function pauseForCaretArrowNav(cardIndex, opts) {
  skipPlayheadCaretSyncOnPause = true;
  keyboardPauseCaretIndex = cardIndex;
  opts.onPausePlayback?.();
}

function onCaretKeyDown(e, renderableCi, cardIndex, words, cues, container, opts) {
  const isUndoRedo =
    (e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y");
  if (!isUndoRedo) e.stopPropagation();

  const st = getRowCaret(cardIndex, words);
  const ci = renderableCaretToStorageCaret(words, renderableCi);
  const visN = visibleWordStorageIndices(words).length;
  const hasSelection = st.selectionAnchor !== null && st.selectionAnchor !== ci;
  const selStart = hasSelection ? Math.min(st.selectionAnchor, ci) : -1;
  const selEnd = hasSelection ? Math.max(st.selectionAnchor, ci) : -1;
  const wasPlaying = isPlaybackActive(opts);
  const cue = cues[cardIndex];

  const clearSelection = () => {
    st.selectionAnchor = null;
  };

  if (e.key === " " || e.code === "Space") {
    if (e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    opts.onTogglePlayback?.(true);
    return;
  }

  if (
    ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key) &&
    wasPlaying
  ) {
    st.hoveredRenderable = null;
    pauseForCaretArrowNav(cardIndex, opts);
  }

  if (e.key === "ArrowDown") {
    e.preventDefault();
    clearSelection();
    requestFocusRow(container, cues, opts, cardIndex, 0);
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    clearSelection();
    if (cardIndex > 0) {
      requestFocusRow(container, cues, opts, cardIndex - 1, 0);
    }
    return;
  }
  if (e.key === "Home") {
    e.preventDefault();
    clearSelection();
    activateCaretAt(cardIndex, words, 0, true);
    refreshCaretRowUi(container, cardIndex, words, opts);
    return;
  }
  if (e.key === "End") {
    e.preventDefault();
    clearSelection();
    activateCaretAt(cardIndex, words, words.length, true);
    refreshCaretRowUi(container, cardIndex, words, opts);
    return;
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    if (wasPlaying && cue) {
      clearSelection();
      const snapStorage = caretIndexBeforePlayheadWord(cue, getPlayheadSec(opts));
      const snapRc = storageCaretToRenderableCaret(words, snapStorage);
      if (snapRc < visN) {
        activateCaretAt(cardIndex, words, snapStorage, true);
        refreshCaretRowUi(container, cardIndex, words, opts);
      } else {
        requestFocusRow(container, cues, opts, cardIndex, 0);
      }
      return;
    }
    if (e.shiftKey) {
      st.selectionAnchor = st.selectionAnchor ?? ci;
    } else {
      clearSelection();
    }
    if (renderableCi < visN) {
      const next = stepStorageCaretByRenderable(words, ci, 1);
      activateCaretAt(cardIndex, words, next, true);
      refreshCaretRowUi(container, cardIndex, words, opts);
    } else {
      requestFocusRow(container, cues, opts, cardIndex, 0);
    }
    return;
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    if (wasPlaying && cue) {
      clearSelection();
      const snapStorage = stepStorageCaretByRenderable(
        words,
        caretIndexBeforePlayheadWord(cue, getPlayheadSec(opts)),
        -1,
      );
      activateCaretAt(cardIndex, words, snapStorage, true);
      refreshCaretRowUi(container, cardIndex, words, opts);
      return;
    }
    if (e.shiftKey) {
      st.selectionAnchor = st.selectionAnchor ?? ci;
    } else {
      clearSelection();
    }
    if (renderableCi > 0) {
      const prev = stepStorageCaretByRenderable(words, ci, -1);
      activateCaretAt(cardIndex, words, prev, true);
      refreshCaretRowUi(container, cardIndex, words, opts);
    } else if (cardIndex > 0) {
      const prevWords = cues[cardIndex - 1]?.words ?? [];
      const prevVis = visibleWordStorageIndices(prevWords).length;
      requestFocusCaret(container, cues, opts, cardIndex - 1, prevVis, { seek: false });
    }
    return;
  }
  if (e.key === "Enter" && opts.onSplitSubtitleAtWord) {
    e.preventDefault();
    clearSelection();
    opts.onSplitSubtitleAtWord(cardIndex, ci);
    requestFocusCaret(container, cues, opts, cardIndex + 1, 0);
    return;
  }
  if (e.key === "Backspace") {
    e.preventDefault();
    if (hasSelection && opts.onDeleteWordRangeAt) {
      opts.onDeleteWordRangeAt(cardIndex, selStart, selEnd);
      clearSelection();
      requestFocusCaret(container, cues, opts, cardIndex, selStart);
      return;
    }
    clearSelection();
    let leftIdx = ci - 1;
    while (leftIdx >= 0 && words[leftIdx]?.is_deleted) leftIdx -= 1;
    if (leftIdx >= 0 && opts.onBackspaceWordAt) {
      opts.onBackspaceWordAt(cardIndex, leftIdx + 1);
      requestFocusCaret(container, cues, opts, cardIndex, leftIdx);
    } else if (cardIndex > 0) {
      const prevLen = cues[cardIndex - 1]?.words?.length ?? 0;
      opts.onBackspaceWordAt?.(cardIndex, ci);
      requestFocusCaret(container, cues, opts, cardIndex - 1, prevLen);
    }
    return;
  }
  if (e.key === "Delete") {
    e.preventDefault();
    if (hasSelection && opts.onDeleteWordRangeAt) {
      opts.onDeleteWordRangeAt(cardIndex, selStart, selEnd);
      clearSelection();
      requestFocusCaret(container, cues, opts, cardIndex, selStart);
      return;
    }
    clearSelection();
    let rightIdx = ci;
    while (rightIdx < words.length && words[rightIdx]?.is_deleted) rightIdx += 1;
    if (rightIdx < words.length && opts.onDeleteWordAt) {
      opts.onDeleteWordAt(cardIndex, rightIdx);
      requestFocusCaret(container, cues, opts, cardIndex, rightIdx);
    } else if (cardIndex + 1 < cues.length) {
      opts.onDeleteWordAt(cardIndex, ci);
      requestFocusCaret(container, cues, opts, cardIndex + 1, 0);
    }
  }
}

/**
 * @param {HTMLElement} rail
 * @param {HTMLElement} inner
 * @param {HTMLElement} tracks
 * @param {number} cardIndex
 * @param {readonly object[]} words
 * @param {number[]} visibleStorageIndices
 * @param {boolean} isExpanded
 * @param {boolean} playing
 * @param {object} opts
 * @param {readonly object[]} cues
 * @param {HTMLElement} listContainer
 */
function appendCaretsOverlay(
  rail,
  inner,
  tracks,
  cardIndex,
  words,
  visibleStorageIndices,
  isExpanded,
  playing,
  opts,
  cues,
  listContainer,
) {
  if (isExpanded) return;
  const st = getRowCaret(cardIndex, words);

  const overlay = document.createElement("div");
  overlay.className = "subtitle-word-carets-overlay";
  const n = visibleStorageIndices.length;

  for (let k = 0; k <= n; k += 1) {
    const storageK = renderableCaretToStorageCaret(words, k);
    const shown = isCaretShownAt(st, cardIndex, k, playing);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = `subtitle-caret-${cardIndex}-${k}`;
    btn.className = "subtitle-word-caret subtitle-word-caret--overlay";
    const isHover = st.hoveredRenderable === k && !(st.rowHasFocus && st.focusedRenderable === k);
    const isFocus = st.rowHasFocus && st.focusedRenderable === k;
    if (shown) btn.classList.add("subtitle-word-caret--visible");
    if (shown && isHover) btn.classList.add("subtitle-word-caret--hover");
    if (shown && isFocus) btn.classList.add("subtitle-word-caret--active");
    if (shown && st.caretBlink && isFocus) {
      btn.classList.add("subtitle-word-caret--blink");
    }
    btn.setAttribute("aria-label", `단어 사이 커서 ${k}`);
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (k > 0) st.selectionAnchor = null;
      activateCaretAt(cardIndex, words, storageK, true);
      globalHoveredRowIndex = cardIndex;
      patchCaretVisibility(listContainer, cardIndex, words, playing);
      btn.focus({ preventScroll: true });
    });
    btn.addEventListener("focus", () => syncCaretFromFocus(cardIndex, words, k));
    btn.addEventListener("mouseenter", () => {
      setHoverCaretAt(cardIndex, words, k, listContainer, opts, cues);
    });
    btn.addEventListener("keydown", (ev) =>
      onCaretKeyDown(ev, k, cardIndex, words, cues, listContainer, opts),
    );
    overlay.appendChild(btn);
  }

  inner.appendChild(overlay);

  rail.addEventListener("pointermove", (e) => {
    const chip =
      e.target instanceof Element ? e.target.closest(".subtitle-word-chip") : null;
    if (!chip || !tracks.contains(chip)) return;
    const vi = Number(chip.dataset.visibleIndex);
    const storageWi = Number(chip.dataset.wordIndex);
    if (!Number.isFinite(vi) || !Number.isFinite(storageWi)) return;
    setHoverCaretAt(cardIndex, words, vi, listContainer, opts, cues);
  });

  rail.addEventListener("mouseleave", () => {
    if (globalHoveredRowIndex !== cardIndex) return;
    dismissHoverCaretUi(listContainer, cardIndex, words, opts, cues);
  });

  scheduleCaretLayout(inner, cardIndex, words, visibleStorageIndices, listContainer, playing);
}

/**
 * @param {HTMLElement} tracks compact 칩 flex 컨테이너
 * @param {HTMLElement} inner 캐럿 오버레이 부모
 * @param {number} cardIndex
 * @param {readonly object[]} words
 * @param {readonly object[]} visibleWords
 * @param {number[]} visibleStorageIndices
 * @param {object} chipOpts
 */
export function buildWordChipsAndCarets(
  tracks,
  inner,
  cardIndex,
  words,
  visibleWords,
  visibleStorageIndices,
  chipOpts,
) {
  const {
    rail,
    isExpanded,
    expandedWordIndex,
    expandedVisibleIndex,
    playing,
    activeWord,
    vrewWords,
    opts,
    cues,
    listContainer,
    openWordRail,
    onSelectCue,
  } = chipOpts;

  const rowSt = getRowCaret(cardIndex, words);
  const hasSelection =
    rowSt.selectionAnchor !== null && rowSt.selectionAnchor !== rowSt.storageCaret;
  const selStart = hasSelection ? Math.min(rowSt.selectionAnchor, rowSt.storageCaret) : -1;
  const selEnd = hasSelection ? Math.max(rowSt.selectionAnchor, rowSt.storageCaret) : -1;

  visibleStorageIndices.forEach((storageWi, vi) => {
    const w = words[storageWi];
    const slot = document.createElement("div");
    slot.className = "subtitle-word-slot subtitle-word-slot--compact";

    const pill = document.createElement("button");
    pill.type = "button";
    pill.tabIndex = -1;
    pill.id = `subtitle-word-${cardIndex}-${storageWi}`;
    pill.className = "subtitle-word-chip subtitle-word-chip--proportional";
    if (w.is_silence || w.isSilence) pill.classList.add("subtitle-word-chip--silence");
    pill.dataset.wordIndex = String(storageWi);
    pill.dataset.visibleIndex = String(vi);
    pill.dataset.wordStart = String(w.start);
    pill.dataset.wordEnd = String(w.end);
    const blockId = vrewWords?.[vi]?.id;
    if (blockId) {
      pill.dataset.wordId = blockId;
      pill.setAttribute("data-word-id", blockId);
    }
    if (isExpanded && expandedVisibleIndex === vi) {
      pill.dataset.waveformActiveWordChip = "1";
    }

    const span = document.createElement("span");
    span.className = "subtitle-word-chip-text";
    if (hasSelection && storageWi >= selStart && storageWi < selEnd) {
      span.classList.add("subtitle-word-chip-text--selected");
    }
    span.textContent = w.word || " ";
    pill.appendChild(span);
    slot.appendChild(pill);
    tracks.appendChild(slot);

    if (isExpanded && expandedWordIndex === storageWi) pill.classList.add("is-selected");
    if (playing && activeWord === storageWi) pill.classList.add("subtitle-word-chip--active");

    pill.addEventListener("mouseenter", () => {
      setHoverCaretAt(cardIndex, words, vi, listContainer, opts, cues);
    });
    pill.addEventListener("mousedown", (e) => {
      if (e.detail > 1) return;
      e.preventDefault();
    });
    pill.addEventListener("click", (e) => {
      e.stopPropagation();
      const st = getRowCaret(cardIndex, words);
      st.selectionAnchor = null;
      if (isExpanded && opts.onWaveformChipClick) {
        const isActiveChip = expandedWordIndex === storageWi;
        opts.onWaveformChipClick(cardIndex, vi, storageWi, isActiveChip, e.detail);
        if (isPlaybackActive(opts)) opts.onPausePlayback?.();
        activateCaretAt(cardIndex, words, storageWi, true);
        onSelectCue?.(cardIndex);
        refreshCaretRowUi(listContainer, cardIndex, words, opts);
        return;
      }
      if (isPlaybackActive(opts)) opts.onPausePlayback?.();
      activateCaretAt(cardIndex, words, storageWi, true);
      onSelectCue?.(cardIndex);
      opts.onSeek?.(w.start);
      requestFocusCaret(listContainer, cues, opts, cardIndex, storageWi, { seek: false });
    });
    pill.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      e.preventDefault();
      activateCaretAt(cardIndex, words, storageWi, true);
      onSelectCue?.(cardIndex);
      openWordRail?.(cardIndex, storageWi, vi);
    });
  });

  appendCaretsOverlay(
    rail,
    inner,
    tracks,
    cardIndex,
    words,
    visibleStorageIndices,
    isExpanded,
    playing,
    opts,
    cues,
    listContainer,
  );

  const st = getRowCaret(cardIndex, words);
  return st.storageCaret;
}

/**
 * @param {HTMLElement} card
 * @param {number} cardIndex
 * @param {readonly object[]} words
 * @param {readonly object[]} cues
 * @param {HTMLElement} container
 * @param {object} opts
 */
function onCardKeyDown(e, cardIndex, words, cues, container, opts) {
  const target = e.target;
  if (target instanceof HTMLElement) {
    if (target.closest("textarea,input,[contenteditable='true']")) return;
    if (target.closest(".subtitle-word-caret")) return;
  }
  const isUndoRedo = (e.ctrlKey || e.metaKey) && /^[zy]$/i.test(e.key);
  if (!isUndoRedo) e.stopPropagation();

  const st = getRowCaret(cardIndex, words);
  const visN = visibleWordStorageIndices(words).length;
  const ci = st.storageCaret;
  const wasPlaying = isPlaybackActive(opts);

  if (e.key === " " || e.code === "Space") {
    if (e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    if (wasPlaying) {
      opts.onTogglePlayback?.(true);
      return;
    }
    if (spaceSeekIntent === "wholeLine") {
      opts.onWaveformSeekAndPlay?.(cues[cardIndex]?.start ?? 0);
      spaceSeekIntent = "none";
      return;
    }
    opts.onTogglePlayback?.(true);
    return;
  }

  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
    if (wasPlaying) pauseForCaretArrowNav(cardIndex, opts);
  }

  if (e.key === "ArrowDown") {
    e.preventDefault();
    st.selectionAnchor = null;
    requestFocusRow(container, cues, opts, cardIndex, 0);
    return;
  }
  if (e.key === "ArrowUp" && cardIndex > 0) {
    e.preventDefault();
    st.selectionAnchor = null;
    requestFocusRow(container, cues, opts, cardIndex - 1, 0);
    return;
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    const rc = storageCaretToRenderableCaret(words, ci);
    if (rc < visN) {
      const next = stepStorageCaretByRenderable(words, ci, 1);
      activateCaretAt(cardIndex, words, next, true);
      refreshCaretRowUi(container, cardIndex, words, opts);
    } else {
      requestFocusRow(container, cues, opts, cardIndex, 0);
    }
    return;
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    const rc = storageCaretToRenderableCaret(words, ci);
    if (rc > 0) {
      const prev = stepStorageCaretByRenderable(words, ci, -1);
      activateCaretAt(cardIndex, words, prev, true);
      refreshCaretRowUi(container, cardIndex, words, opts);
    } else if (cardIndex > 0) {
      const prevWords = cues[cardIndex - 1]?.words ?? [];
      const prevVis = visibleWordStorageIndices(prevWords).length;
      requestFocusCaret(container, cues, opts, cardIndex - 1, prevVis, { seek: false });
    }
  }
}

/**
 * @param {HTMLElement} card
 * @param {number} cardIndex
 * @param {readonly object[]} words
 * @param {readonly object[]} cues
 * @param {HTMLElement} container
 * @param {object} opts
 */
export function wireSubtitleCardCaretHost(card, cardIndex, words, cues, container, opts) {
  card.tabIndex = 0;

  card.addEventListener("mousedown", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest("textarea,.subtitle-card-textarea")) return;
    if (t.closest(".subtitle-waveform-mount,.subtitle-waveform-accordion")) return;
    if (t.closest(".subtitle-word-chip,.subtitle-word-caret")) return;

    const tryFirstCaret = () => {
      if (visibleWordStorageIndices(words).length === 0) return false;
      e.preventDefault();
      if (isPlaybackActive(opts)) opts.onPausePlayback?.();
      const st = getRowCaret(cardIndex, words);
      st.selectionAnchor = null;
      activateCaretAt(cardIndex, words, 0, true);
      refreshCaretRowUi(container, cardIndex, words, opts);
      return true;
    };

    if (t.closest(".subtitle-card-times") && tryFirstCaret()) return;
    if (t.closest(".subtitle-word-rail") && tryFirstCaret()) return;

    spaceSeekIntent = "wholeLine";
    card.querySelectorAll(`[id^="subtitle-caret-${cardIndex}-"]`).forEach((el) => {
      if (el instanceof HTMLElement) el.blur();
    });
    clearRowCaretState(cardIndex, words, false);
    requestAnimationFrame(() => card.focus({ preventScroll: true }));
  }, true);

  card.addEventListener("keydown", (e) => onCardKeyDown(e, cardIndex, words, cues, container, opts));

  card.addEventListener("focusin", (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && t.closest(".subtitle-card-textarea")) {
      enterTextareaEditMode(cardIndex, words, container, opts);
      return;
    }
    const st = getRowCaret(cardIndex, words);
    st.rowHasFocus = true;
    st.hoveredRenderable = null;
    if (st.focusedRenderable != null) st.caretVisible = true;
    refreshCaretRowUi(container, cardIndex, words, opts);
  });

  card.addEventListener("focusout", () => {
    const root = card;
    const capturedGen = caretFocusGeneration;
    window.setTimeout(() => {
      if (isCaretStructuralGuardActive()) return;
      if (capturedGen !== caretFocusGeneration) return;
      const active = document.activeElement;
      if (active && root.contains(active)) return;
      if (active instanceof HTMLElement) {
        if (active.id?.startsWith("subtitle-caret-")) return;
        if (active.closest(".subtitle-card-textarea")) {
          enterTextareaEditMode(cardIndex, words, container, opts);
          return;
        }
        const otherCard = active.closest(".subtitle-card[data-cue-index]");
        if (otherCard && otherCard !== root) {
          clearRowCaretState(cardIndex, words, false);
          if (activeCaretCardIndex === cardIndex) activeCaretCardIndex = null;
          patchCaretVisibility(container, cardIndex, words, isPlaybackActive(opts));
          return;
        }
      }
      clearRowCaretState(cardIndex, words, false);
      if (activeCaretCardIndex === cardIndex) activeCaretCardIndex = null;
      spaceSeekIntent = "none";
      patchCaretVisibility(container, cardIndex, words, isPlaybackActive(opts));
    }, 32);
  });
}

/**
 * @param {HTMLTextAreaElement} ta
 * @param {number} cardIndex
 * @param {readonly object[]} cues
 * @param {HTMLElement} container
 * @param {object} opts
 */
export function wireTextareaCaretNavigation(ta, cardIndex, cues, container, opts) {
  const wordsForRow = () => getCueWords(cues[cardIndex] ?? {});

  ta.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    enterTextareaEditMode(cardIndex, wordsForRow(), container, opts);
  });
  ta.addEventListener("focus", () => {
    enterTextareaEditMode(cardIndex, wordsForRow(), container, opts);
  });

  ta.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === "z" || k === "y") return;
      if (k === "c" || k === "v" || k === "x" || k === "a") {
        e.stopPropagation();
        return;
      }
    }
    const words = cues[cardIndex]?.words ?? [];
    if (e.key === "ArrowLeft" && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      e.preventDefault();
      e.stopPropagation();
      if (cardIndex > 0) {
        const prevWords = cues[cardIndex - 1]?.words ?? [];
        const prevVis = visibleWordStorageIndices(prevWords).length;
        requestFocusCaret(container, cues, opts, cardIndex - 1, prevVis);
      } else {
        requestFocusCaret(container, cues, opts, cardIndex, 0);
      }
      return;
    }
    if (
      e.key === "ArrowRight" &&
      ta.selectionStart === ta.value.length &&
      ta.selectionEnd === ta.value.length
    ) {
      e.preventDefault();
      e.stopPropagation();
      const visN = visibleWordStorageIndices(words).length;
      requestFocusCaret(container, cues, opts, cardIndex, visN);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      const to = Math.min(cardIndex + 1, cues.length - 1);
      requestFocusCaret(container, cues, opts, to, 0);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      requestFocusCaret(container, cues, opts, cardIndex, 0);
    }
  });
}

