/**
 * AutoSubtitle SubtitleVirtualList.tsx — 가상 스크롤·줄 줌 칩·캐럿·키보드.
 */

import {
  ensureCueWords,
  getCueWords,
} from "../subtitle-words.js";
import { pickActiveCueIndex, pickActiveWordIndex } from "../playback.js?v=24";
import { LineWaveformPanel } from "../line-waveform-panel.js";
import { disposeAllWaveformPanels } from "../waveform-panel-registry.js";
import {
  applySubwavePanelLeftPx,
  findActiveWordChip,
} from "../waveform/subwave-panel-layout.js";
import { visibleWordStorageIndices } from "../shared/subtitle-word-caret-map.js";
import { subtitleLinesToVrewRows } from "../shared/vrew-subtitle-adapter.js";
import { wordIsDeleted } from "../shared/subtitles.js";
import {
  buildWordChipsAndCarets,
  clearAllRowCaretState,
  markCaretListStructuralMutation,
  prepareRowCaretForRender,
  requestFocusCaret,
  sanitizeRowCaretMapForCues,
  setCaretRerenderHook,
  wireSubtitleCardCaretHost,
  wireTextareaCaretNavigation,
} from "./word-caret-ui.js?v=39";

/** @type {Map<HTMLElement, LineWaveformPanel>} */
const panelByCard = new WeakMap();

/** @type {{ cardIdx: number, chips: Array<{ el: HTMLElement, s: number, e: number }> }} */
let wordChipCache = { cardIdx: -1, chips: [] };
let lastPlayingCardIdx = -1;
let lastPlayingWordEl = null;
/** @type {number} is-playing 클래스가 붙은 카드 */
let lastIsPlayingCardIdx = -1;
/** @type {number} is-active (재생 줄) */
let lastActivePlayingIdx = -1;
/** @type {number} is-active (선택 줄) */
let lastActiveSelectedIdx = -1;
/** @type {number} */
let lastCardSyncPlayingIdx = -1;
/** @type {number} */
let lastCardSyncSelectedIdx = -1;

/**
 * @param {HTMLElement} container
 * @param {number} cueIndex
 * @returns {HTMLElement | null}
 */
function queryCardByCueIndex(container, cueIndex) {
  if (!container || cueIndex < 0) return null;
  return container.querySelector(`[data-cue-index="${cueIndex}"]`);
}

/**
 * @param {HTMLElement} container
 * @param {number} prevIdx
 * @param {number} nextIdx
 */
function setCardPlayingAt(container, prevIdx, nextIdx) {
  if (prevIdx === nextIdx) return;
  if (prevIdx >= 0) queryCardByCueIndex(container, prevIdx)?.classList.remove("is-playing");
  if (nextIdx >= 0) queryCardByCueIndex(container, nextIdx)?.classList.add("is-playing");
  lastIsPlayingCardIdx = nextIdx;
}

/**
 * @param {HTMLElement} container
 * @param {number} prevIdx
 * @param {number} nextIdx
 */
function setCardActiveAt(container, prevIdx, nextIdx) {
  if (prevIdx === nextIdx) return;
  if (prevIdx >= 0) queryCardByCueIndex(container, prevIdx)?.classList.remove("is-active");
  if (nextIdx >= 0) queryCardByCueIndex(container, nextIdx)?.classList.add("is-active");
}

/**
 * @param {HTMLElement} container
 * @param {number} playingIdx
 * @param {number} selectedIdx
 * @param {boolean} isPlaying
 */
function syncCardHighlightPointers(container, playingIdx, selectedIdx, isPlaying) {
  const playActive = isPlaying && playingIdx >= 0 ? playingIdx : -1;
  setCardActiveAt(container, lastActivePlayingIdx, playActive);
  lastActivePlayingIdx = playActive;

  const selActive = selectedIdx >= 0 ? selectedIdx : -1;
  setCardActiveAt(container, lastActiveSelectedIdx, selActive);
  lastActiveSelectedIdx = selActive;

  if (isPlaying) {
    setCardPlayingAt(container, lastIsPlayingCardIdx, playingIdx);
  } else if (lastIsPlayingCardIdx >= 0) {
    setCardPlayingAt(container, lastIsPlayingCardIdx, -1);
  }
}

/**
 * @param {HTMLElement} container
 * @param {HTMLElement} card
 */
function cardTopInScrollContainer(container, card) {
  const cRect = container.getBoundingClientRect();
  const rRect = card.getBoundingClientRect();
  return rRect.top - cRect.top + container.scrollTop;
}

/**
 * @param {HTMLElement} container
 * @param {number} scrollTop
 */
function restoreListScrollTop(container, scrollTop) {
  const top = Math.max(0, Number(scrollTop) || 0);
  container.scrollTop = top;
  requestAnimationFrame(() => {
    container.scrollTop = top;
  });
}

/**
 * @param {HTMLElement} container
 * @param {readonly object[]} cues
 * @param {object} opts
 * @param {number} cueIndex
 * @param {{ behavior?: ScrollBehavior }} [scrollOpts]
 */
export function scrollCueIntoView(container, cues, _opts, cueIndex, scrollOpts = {}) {
  if (!container || cueIndex < 0) return;
  const card = container.querySelector(`[data-cue-index="${cueIndex}"]`);
  if (!card) return;
  const top = cardTopInScrollContainer(container, card);
  const bottom = top + card.offsetHeight;
  const viewTop = container.scrollTop;
  const viewBottom = viewTop + (container.clientHeight || 0);
  if (top >= viewTop + 24 && bottom <= viewBottom - 24) return;
  const behavior = scrollOpts.behavior ?? "auto";
  const target = Math.max(0, top - Math.min(96, (container.clientHeight || 0) * 0.12));
  container.scrollTo({ top: target, behavior });
}

function listableCueIndices(cues) {
  const out = [];
  for (let i = 0; i < (cues || []).length; i += 1) {
    const cue = cues[i];
    if (cue.is_deleted || cue.isDeleted) continue;
    const start = Number(cue.start) || 0;
    const end = Number(cue.end) || 0;
    const hasSpan = end > start + 1e-6;
    if (cue.is_silence || cue.isSilence) {
      if (hasSpan) out.push(i);
      continue;
    }
    if (!String(cue.text || "").trim() && !(cue.words?.length)) continue;
    out.push(i);
  }
  return out;
}

/**
 * @param {HTMLElement} container
 * @param {readonly object[]} cues
 * @param {object} opts
 */
function renderAllCards(container, cues, opts) {
  const indices = listableCueIndices(cues);
  const formatFull =
    opts.formatTimeFull ||
    ((sec) => {
      const s = Math.max(0, Number(sec) || 0);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const r = s % 60;
      const pad = (n, w = 2) => String(n).padStart(w, "0");
      return `${pad(h)}:${pad(m)}:${pad(r, 2)}.${pad(Math.floor((r % 1) * 1000), 3)}`;
    });

  const playhead = Number(opts.playheadSec) || 0;
  const playing = Boolean(opts.isPlaying);
  const activeCue =
    playing && typeof opts.activeCueIndex === "number" && opts.activeCueIndex >= 0
      ? opts.activeCueIndex
      : opts.selectedCueIndex;

  const mediaDur =
    opts.mediaDurationSec ??
    (opts.video?.duration && Number.isFinite(opts.video.duration) ? opts.video.duration : null);

  const listRoot = document.createElement("div");
  listRoot.className = "as-subtitle-cards-root";

  for (const i of indices) {
    const cue = cues[i];
    ensureCueWords(cue);

    const card = document.createElement("article");
    card.className = "subtitle-card";
    card.dataset.cueIndex = String(i);

    const isExpanded =
      opts.expandedCueIndex === i && opts.expandedWordIndex != null && opts.expandedWordIndex >= 0;
    const isCardActive = activeCue === i || opts.selectedCueIndex === i;
    if (isCardActive) card.classList.add("is-active");
    if (playing && activeCue === i) card.classList.add("is-playing");
    if (isExpanded) card.classList.add("has-waveform-open");

    const times = document.createElement("div");
    times.className = "subtitle-card-times";
    times.textContent = `${formatFull(cue.start)} → ${formatFull(cue.end)}`;
    card.appendChild(times);

    ensureCueWords(cue);
    const words = getCueWords(cue);
    prepareRowCaretForRender(i, words);
    const visibleStorageIndices = visibleWordStorageIndices(words);
    const visibleWords = visibleStorageIndices.map((si) => words[si]);

    const vrewRow = subtitleLinesToVrewRows([cue], { gapFill: false })[0];
    const vrewWords = vrewRow?.words ?? [];

    let expandedVisibleIndex = -1;
    if (isExpanded && opts.expandedWordIndex != null && opts.expandedWordIndex >= 0) {
      expandedVisibleIndex = visibleStorageIndices.indexOf(opts.expandedWordIndex);
    }

    const rail = document.createElement("div");
    rail.className = "subtitle-word-rail subtitle-word-row--wave-seamless";
    rail.setAttribute("role", "group");
    rail.setAttribute("aria-label", "단어 타임라인");

    const inner = document.createElement("div");
    inner.className = "subtitle-word-row-inner subtitle-word-row-inner--compact";

    const tracks = document.createElement("div");
    tracks.className = "subtitle-word-row-tracks subtitle-word-row-tracks--compact";

    const activeWord = playing && activeCue === i ? pickActiveWordIndex(cue, playhead) : -1;

    buildWordChipsAndCarets(tracks, inner, i, words, visibleWords, visibleStorageIndices, {
      rail,
      isExpanded,
      expandedWordIndex: opts.expandedWordIndex,
      expandedVisibleIndex,
      playing,
      activeWord,
      vrewWords,
      opts,
      cues,
      listContainer: container,
      onSelectCue: opts.onSelectCue,
      openWordRail: (ci, storageWi, visIdx) => openWordRail(card, ci, storageWi, cues, opts),
    });

    inner.appendChild(tracks);
    rail.appendChild(inner);
    card.appendChild(rail);

    const accordion = document.createElement("div");
    accordion.className = "subtitle-waveform-accordion";
    if (isExpanded) accordion.classList.add("is-open");
    const mount = document.createElement("div");
    mount.className = "subtitle-card-media-rail subtitle-waveform-mount";
    mount.setAttribute("data-waveform-mount-for-open-line", isExpanded ? "1" : "");
    accordion.appendChild(mount);
    card.appendChild(accordion);

    const ta = document.createElement("textarea");
    ta.className = "subtitle-card-textarea";
    ta.rows = 2;
    // 프리뷰용 줄 텍스트 — 단어 블록(words)과 분리 (Electron updateSubtitleAt)
    ta.value = String(cue.text ?? "");
    ta.setAttribute("aria-label", "자막 편집");
    ta.dataset.subtitleEdit = "1";
    ta.addEventListener("click", (e) => e.stopPropagation());
    ta.addEventListener("mousedown", (e) => e.stopPropagation());
    ta.addEventListener("input", () => {
      opts.onPreviewLineTextInput?.(i, ta.value);
    });
    ta.addEventListener("blur", () => {
      const cur = ta.value;
      const prev = String(cue.text ?? "");
      if (cur !== prev) {
        cue.text = cur;
        opts.onSubtitleTextCommit?.(i, cur);
      }
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && opts.onSplitSubtitleAt) {
        e.preventDefault();
        opts.onSplitSubtitleAt(i, ta.selectionStart);
        return;
      }
      if (e.key === "Backspace" && ta.selectionStart === 0 && ta.selectionEnd === 0) {
        if (ta.value.length === 0 && opts.onMergeEmptySubtitleAt) {
          e.preventDefault();
          opts.onMergeEmptySubtitleAt(i);
        }
      }
    });
    wireTextareaCaretNavigation(ta, i, cues, container, opts);
    ta.dataset.waveformNoDismiss = "1";
    card.appendChild(ta);

    card.addEventListener("click", () => opts.onSelectCue?.(i));
    wireSubtitleCardCaretHost(card, i, words, cues, container, opts);

    if (isExpanded) mountWordRail(mount, card, i, opts.expandedWordIndex, cues, opts);

    listRoot.appendChild(card);
  }

  container.appendChild(listRoot);
}

export function renderSubtitleCards(container, cues, opts = {}) {
  if (!container) return;

  setCaretRerenderHook((c, cu, o) => {
    const saved = c.scrollTop;
    renderSubtitleCards(c, cu, o);
    restoreListScrollTop(c, saved);
  });

  markCaretListStructuralMutation(96);
  sanitizeRowCaretMapForCues(cues);

  disposeAllWaveformPanels();

  const savedScrollTop = container.scrollTop;
  resetPlaybackHighlightCache();
  container.innerHTML = "";

  const indices = listableCueIndices(cues);
  if (indices.length === 0) {
    clearAllRowCaretState();
    return;
  }

  renderAllCards(container, cues, opts);
  restoreListScrollTop(container, savedScrollTop);
}

export { requestFocusCaret };

export function resetPlaybackHighlightCache() {
  wordChipCache = { cardIdx: -1, chips: [] };
  lastPlayingCardIdx = -1;
  lastPlayingWordEl = null;
  lastIsPlayingCardIdx = -1;
  lastActivePlayingIdx = -1;
  lastActiveSelectedIdx = -1;
  lastCardSyncPlayingIdx = -1;
  lastCardSyncSelectedIdx = -1;
}

export function updatePlaybackHighlights(container, cues, opts) {
  if (!container) return;
  const t = Number(opts.playheadSec) || 0;
  const playing = Boolean(opts.isPlaying);
  const selectedIdx =
    typeof opts.selectedCueIndex === "number" ? opts.selectedCueIndex : -1;
  const playingIdx = playing
    ? typeof opts.activeCueIndex === "number"
      ? opts.activeCueIndex
      : pickActiveCueIndex(cues, t)
    : -1;

  const cardsUnchanged =
    playingIdx === lastCardSyncPlayingIdx && selectedIdx === lastCardSyncSelectedIdx;
  if (!cardsUnchanged) {
    syncCardHighlightPointers(container, playingIdx, selectedIdx, playing);
    lastCardSyncPlayingIdx = playingIdx;
    lastCardSyncSelectedIdx = selectedIdx;
  }

  if (lastPlayingCardIdx >= 0 && lastPlayingCardIdx !== playingIdx) {
    const prev = queryCardByCueIndex(container, lastPlayingCardIdx);
    prev?.querySelectorAll(".subtitle-word-chip--active").forEach((el) => {
      el.classList.remove("subtitle-word-chip--active");
    });
    lastPlayingWordEl = null;
    wordChipCache = { cardIdx: -1, chips: [] };
  }
  lastPlayingCardIdx = playingIdx;

  if (!playing || playingIdx < 0) {
    lastPlayingWordEl?.classList.remove("subtitle-word-chip--active");
    lastPlayingWordEl = null;
    return;
  }

  if (wordChipCache.cardIdx !== playingIdx) {
    const cardEl = queryCardByCueIndex(container, playingIdx);
    const collected = [];
    cardEl?.querySelectorAll(".subtitle-word-chip").forEach((el) => {
      const s = parseFloat(el.dataset.wordStart ?? "NaN");
      const e = parseFloat(el.dataset.wordEnd ?? "NaN");
      if (Number.isFinite(s) && Number.isFinite(e)) collected.push({ el, s, e });
    });
    wordChipCache = { cardIdx: playingIdx, chips: collected };
  }

  let nextChip = null;
  for (const c of wordChipCache.chips) {
    if (t >= c.s && t < c.e) {
      nextChip = c.el;
      break;
    }
  }

  if (lastPlayingWordEl !== nextChip) {
    lastPlayingWordEl?.classList.remove("subtitle-word-chip--active");
    nextChip?.classList.add("subtitle-word-chip--active");
    lastPlayingWordEl = nextChip;
  }

  /* 재생 중 자동 스크롤 없음 — scrollCueIntoView 는 scrollActiveCard 일 때만 script 쪽에서 */
}

/**
 * @param {HTMLElement} container
 * @param {{ expandedCueIndex?: number, expandedWordIndex?: number }} [opts]
 */
export function refreshExpandedPanelSkipRanges(container) {
  if (!container) return;
  for (const mount of container.querySelectorAll(".subtitle-card-media-rail")) {
    panelByCard.get(mount)?.refreshPlaybackSkipRanges?.();
  }
}

export function syncExpandedPanelPlayhead(container, opts = {}) {
  if (!container) return;
  const expandedCue = opts.expandedCueIndex ?? -1;
  const expandedWord = opts.expandedWordIndex ?? -1;
  if (expandedCue < 0 || expandedWord < 0) return;

  const card = queryCardByCueIndex(container, expandedCue);
  const mount = card?.querySelector(".subtitle-card-media-rail");
  if (!mount) return;
  const panel = panelByCard.get(mount);
  if (!panel) return;

  if (
    opts.playheadEditSec != null &&
    Number.isFinite(opts.playheadEditSec) &&
    opts.mediaPlaying
  ) {
    panel.syncPlayheadFromEditSec?.(opts.playheadEditSec);
    return;
  }
  panel.syncPlayhead?.();
}

export function finishExpandedPanelRangePlay(container, opts = {}) {
  if (!container) return;
  const expandedCue = opts.expandedCueIndex ?? -1;
  const expandedWord = opts.expandedWordIndex ?? -1;
  if (expandedCue < 0 || expandedWord < 0) return;
  const card = queryCardByCueIndex(container, expandedCue);
  const mount = card?.querySelector(".subtitle-card-media-rail");
  panelByCard.get(mount)?.finishRangePlay?.(true, {
    rewindToTrimStart: opts.rewindToTrimStart === true,
    playheadEditSec: opts.playheadEditSec,
  });
}

/** @param {HTMLElement | null} container @param {number} expandedCue */
export function getExpandedPanelCutEditSec(container, expandedCue) {
  if (!container || expandedCue < 0) return null;
  const card = queryCardByCueIndex(container, expandedCue);
  const mount = card?.querySelector(".subtitle-card-media-rail");
  const panel = mount ? panelByCard.get(mount) : null;
  const cut = panel?.cutSec;
  return Number.isFinite(cut) ? cut : null;
}

export function toggleExpandedPanelPlayFromCut(container, opts = {}) {
  if (!container) return false;
  const expandedCue = opts.expandedCueIndex ?? -1;
  const expandedWord = opts.expandedWordIndex ?? -1;
  if (expandedCue < 0 || expandedWord < 0) return false;
  const card = queryCardByCueIndex(container, expandedCue);
  const mount = card?.querySelector(".subtitle-card-media-rail");
  const panel = panelByCard.get(mount);
  if (!panel) return false;
  panel.togglePlayFromCut?.();
  return true;
}

function openWordRail(card, cueIndex, storageWordIndex, cues, opts) {
  const mount = card.querySelector(".subtitle-card-media-rail");
  const accordion = card.querySelector(".subtitle-waveform-accordion");
  if (!mount || !accordion) return;
  mountWordRail(mount, card, cueIndex, storageWordIndex, cues, opts);
  accordion.classList.add("is-open");
  card.classList.add("has-waveform-open");
  opts.onWordExpand?.(cueIndex, storageWordIndex);
}

function mountWordRail(mount, card, cueIndex, wordIndex, cues, opts) {
  const getCues = opts.getCues || (() => cues);

  let panel = panelByCard.get(mount);
  if (
    panel &&
    panel.cueIndex === cueIndex &&
    panel.focusWordIndex === wordIndex &&
    panel.root?.querySelector("[data-subwave-flow]")
  ) {
    const chip = findActiveWordChip(card, null);
    const wordId = chip?.getAttribute("data-word-id") ?? null;
    applySubwavePanelLeftPx(mount, card, wordId);
    return;
  }

  mount.innerHTML = "";
  if (panel) {
    panel.hide();
    panelByCard.delete(mount);
  }
  panel = new LineWaveformPanel(mount, {
      getCues,
      getCard: () => card,
      getPeaksData: opts.getPeaksData || (() => opts.peaksData ?? null),
      getMediaDurationSec: opts.getMediaDurationSec || (() => opts.mediaDurationSec ?? null),
      getVideo: () => opts.video,
      getPlaybackSkipRanges: opts.getPlaybackSkipRanges,
      mapEditToMediaSec: opts.mapEditToMediaSec,
      mapMediaToEditSec: opts.mapMediaToEditSec,
      formatTime: opts.formatTimeFull || opts.formatTime,
      onApplySubtitleChange: (updater, meta) => opts.onApplySubtitleChange?.(updater, meta),
      onBeforeWordSplit: () => opts.onBeforeWordSplit?.(),
      onPlayEditRange: (s, e) => opts.onPlayEditRange?.(s, e),
      onPausePlayback: () => opts.onPausePlayback?.(),
      isPlaying: () => opts.getIsPlaying?.() ?? Boolean(opts.isPlaying),
      getPlayheadEditSec: () =>
        typeof opts.getPlayheadSec === "function" ? opts.getPlayheadSec() : opts.playheadSec,
      isWaveformPanelActive: () => {
        const ci = typeof opts.getExpandedCueIndex === "function" ? opts.getExpandedCueIndex() : -1;
        const wi = typeof opts.getExpandedWordIndex === "function" ? opts.getExpandedWordIndex() : -1;
        return ci >= 0 && wi >= 0;
      },
      onUndo: () => opts.onWaveformUndo?.(),
      onSeek: (sec) => opts.onSeek?.(sec),
      onFocusWordAfterSplit: (ci, wi, wordId) => opts.onWaveformFocusWord?.(ci, wi, wordId),
      onClose: () => opts.onCloseWaveform?.(),
      ensurePeaksLoad: opts.ensurePeaksLoad,
  });
  panelByCard.set(mount, panel);

  const cue = getCues()[cueIndex];
  if (cue) {
    const chip = findActiveWordChip(card, null);
    const wordId = chip?.getAttribute("data-word-id") ?? null;
    applySubwavePanelLeftPx(mount, card, wordId);
    panel.show(cueIndex, wordIndex);
  }
}

export function readCuesFromCards(container, cues) {
  if (!container) return cues;
  container.querySelectorAll(".subtitle-card").forEach((card) => {
    const idx = Number(card.dataset.cueIndex);
    if (!Number.isFinite(idx) || !cues[idx]) return;
    const ta = card.querySelector(".subtitle-card-textarea");
    if (ta) {
      cues[idx].text = ta.value;
    }
  });
  return cues;
}
