/**
 * AutoSubtitle SubtitleVirtualList.tsx ??????????? ???????????.
 */

import {
  ensureCueWords,
  getCueWords,
  markLineTextUserEdited,
  reconcileCueWordsToLineText,
} from "../subtitle-words.js?v=24";
import {
  pickActiveCueIndex,
  pickActiveWordIndex,
  pickActiveWordIndexForHighlight,
  WORD_ONSET_LEAD_SEC,
} from "../playback.js?v=32";
import { syncFindHighlightLayerToTextarea } from "../subtitle-find-replace-highlight.js?v=2";
import { LineWaveformPanel } from "../line-waveform-panel.js?v=14";
import { disposeAllWaveformPanels } from "../waveform-panel-registry.js";
import {
  applySubwavePanelLeftPx,
  findActiveWordChip,
} from "../waveform/subwave-panel-layout.js";
import { visibleWordStorageIndices } from "../shared/subtitle-word-caret-map.js";
import { subtitleLinesToVrewRows } from "../shared/vrew-subtitle-adapter.js";
import { wordIsDeleted } from "../shared/subtitles.js?v=20";
import { normalizePreviewSubtitleText } from "../shared/subtitle-box-chrome.js?v=25";
import { listableCueIndices } from "../shared/subtitle-list-indices.js?v=5";
import { LINE_MODE_ONLY } from "../shared/line-mode/config.js?v=1";
import { LineModeCueWaveformPanel } from "../line-mode/cue-waveform-panel.js?v=35";
import {
  firstSpokenStorageIndex,
  lastSpokenStorageIndex,
  nextSpokenCueIndex,
  prevSpokenCueIndex,
} from "../shared/cross-cue-boundary-sync.js?v=8";
import {
  buildWordChipsAndCarets,
  clearAllRowCaretState,
  markCaretListStructuralMutation,
  prepareRowCaretForRender,
  patchAllCaretRows,
  requestFocusCaret,
  sanitizeRowCaretMapForCues,
  setCaretRerenderHook,
  wireSubtitleCardCaretHost,
  wireTextareaCaretNavigation,
} from "./word-caret-ui.js?v=63";
import { buildSubtitleLineRail, wireSubtitleLineDrag } from "./subtitle-line-rail.js?v=5";
import { wireSubtitleListLineDrag } from "./subtitle-line-drag-ui.js?v=3";
import { formatVrewBlockTimecode } from "../shared/block-timeline-adapter.js?v=2";

export { listableCueIndices };

/**
 * @param {object} cue
 * @param {number} cueIndex
 * @param {object} opts
 * @param {(sec: number) => string} formatFull
 */
function buildCardTimeLabel(cue, cueIndex, opts, formatFull) {
  if (LINE_MODE_ONLY) {
    const start = Number(cue.start) || 0;
    const end = Math.max(start, Number(cue.end) || start);
    const dur = end - start;
    return `미디어 ${formatFull(start)} ~ ${formatFull(end)} · ${dur.toFixed(2)}초`;
  }
  const entry =
    typeof opts.getVirtualIndexForCue === "function" ? opts.getVirtualIndexForCue(cueIndex) : null;
  const duration =
    typeof opts.getBlockDurationForCue === "function" ? opts.getBlockDurationForCue(cueIndex) : null;
  if (entry && duration != null && Number.isFinite(duration)) {
    return formatVrewBlockTimecode(entry.virtualStart, duration);
  }
  return `${formatFull(cue.start)} ~ ${formatFull(cue.end)}`;
}

/** @type {Map<HTMLElement, LineWaveformPanel>} */
const panelByCard = new WeakMap();

/** @type {{ cardIdx: number, chips: Array<{ el: HTMLElement, s: number, e: number }> }} */
let wordChipCache = { cardIdx: -1, chips: [] };
let lastPlayingCardIdx = -1;
let lastPlayingWordEl = null;
/** @type {number} is-playing ??????? ??? ?? */
let lastIsPlayingCardIdx = -1;
/** @type {number} is-active (??? ?? */
let lastActivePlayingIdx = -1;
/** @type {number} is-active (??? ?? */
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

  indices.forEach((i, listPos) => {
    const cue = cues[i];
    ensureCueWords(cue);

    const card = document.createElement("article");
    card.className = "subtitle-card";
    card.dataset.cueIndex = String(i);
    card.dataset.listPos = String(listPos);

    const isExpanded = LINE_MODE_ONLY
      ? opts.expandedCueIndex === i && opts.expandedCueIndex >= 0 && opts.expandedWordIndex === -1
      : opts.expandedCueIndex === i && opts.expandedWordIndex != null && opts.expandedWordIndex >= 0;
    const isCardActive = activeCue === i || opts.selectedCueIndex === i;
    if (isCardActive) card.classList.add("is-active");
    if (opts.isCueLineChecked?.(i)) card.classList.add("is-line-checked");
    if (playing && activeCue === i) card.classList.add("is-playing");
    if (isExpanded) card.classList.add("has-waveform-open");

    const getOpts = () => opts;
    const railParts = buildSubtitleLineRail(i, listPos + 1, getOpts);
    card.appendChild(railParts.rail);
    wireSubtitleLineDrag(card, i, listPos, container, getOpts, railParts);

    const body = document.createElement("div");
    body.className = "subtitle-card-body";

    const times = document.createElement("div");
    times.className = "subtitle-card-times";
    times.textContent = buildCardTimeLabel(cue, i, opts, formatFull);
    body.appendChild(times);

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
    rail.className = LINE_MODE_ONLY
      ? "subtitle-word-rail subtitle-word-row--wave-seamless subtitle-word-row--line-mode-hint"
      : "subtitle-word-rail subtitle-word-row--wave-seamless";
    rail.setAttribute("role", "group");
    rail.setAttribute("aria-label", "\uB2E8\uC5B4 \uD0C0\uC784\uB77C\uC778");

    const inner = document.createElement("div");
    inner.className = "subtitle-word-row-inner subtitle-word-row-inner--compact";

    const tracks = document.createElement("div");
    tracks.className = "subtitle-word-row-tracks subtitle-word-row-tracks--compact";

    const cueLineWaveOpen =
      LINE_MODE_ONLY && isExpanded && opts.expandedWordIndex === -1;
    const activeWord = cueLineWaveOpen
      ? -1
      : playing && activeCue === i
        ? typeof opts.activeWordIndex === "number" && opts.activeWordIndex >= 0
          ? opts.activeWordIndex
          : pickActiveWordIndexForHighlight(
              cue,
              Number(opts.highlightLookupT ?? playhead) || 0,
            )
        : -1;

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
      onWordExpand: opts.onWordExpand,
    });

    inner.appendChild(tracks);
    rail.appendChild(inner);
    body.appendChild(rail);

    if (LINE_MODE_ONLY) {
      rail.title = "빈 곳 더블클릭: 줄 싱크 파형";
      rail.addEventListener("dblclick", (e) => {
        if (
          e.target instanceof Element &&
          e.target.closest(".subtitle-word-chip, .subtitle-word-caret, .subtitle-word-caret--overlay")
        ) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        opts.onCueWaveformToggle?.(i);
      });
    }

    const accordion = document.createElement("div");
    accordion.className = "subtitle-waveform-accordion";
    if (isExpanded) accordion.classList.add("is-open");
    const mount = document.createElement("div");
    mount.className = "subtitle-card-media-rail subtitle-waveform-mount";
    mount.setAttribute("data-waveform-mount-for-open-line", isExpanded ? "1" : "");
    accordion.appendChild(mount);
    body.appendChild(accordion);

    const stack = document.createElement("div");
    stack.className = "subtitle-card-textarea-stack";

    const findLayer = document.createElement("div");
    findLayer.className = "subtitle-find-text-layer";
    findLayer.setAttribute("aria-hidden", "true");

    const ta = document.createElement("textarea");
    ta.className = "subtitle-card-textarea";
    ta.name = `subtitle-cue-${i}`;
    ta.rows = 2;
    ta.value = normalizePreviewSubtitleText(cue.text ?? "");
    ta.setAttribute("aria-label", "\uC790\uB9C9 \uD3B8\uC9D1");
    ta.dataset.subtitleEdit = "1";
    if (cue.lineTextUserEdited || cue.line_text_user_edited) {
      ta.dataset.lineTextUserEdited = "1";
    }

    const syncFindLayer = () => syncFindHighlightLayerToTextarea(findLayer, ta);
    ta.addEventListener("scroll", syncFindLayer);

    ta.addEventListener("click", (e) => e.stopPropagation());
    ta.addEventListener("mousedown", (e) => e.stopPropagation());
    ta.addEventListener("input", () => {
      ta.dataset.lineTextUserEdited = "1";
      markLineTextUserEdited(cue);
      opts.onPreviewLineTextInput?.(i, ta.value);
      opts.onFindReplaceTextInput?.();
    });
    ta.addEventListener("blur", () => {
      const cur = ta.value;
      const prev = String(cue.text ?? "");
      if (cur !== prev) {
        cue.text = cur;
        markLineTextUserEdited(cue);
        ta.dataset.lineTextUserEdited = "1";
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
    stack.appendChild(findLayer);
    stack.appendChild(ta);
    body.appendChild(stack);
    card.appendChild(body);

    card.addEventListener("click", (e) => {
      if (e.target instanceof HTMLElement && e.target.closest(".subtitle-cue-timing")) return;
      opts.onSelectCue?.(i, { scroll: false, rerender: false });
    });
    wireSubtitleCardCaretHost(card, i, words, cues, container, opts);

    if (isExpanded) {
      if (LINE_MODE_ONLY) {
        mountCueWaveformRail(mount, card, i, cues, opts);
      } else {
        mountWordRail(mount, card, i, opts.expandedWordIndex, cues, opts);
      }
    }

    listRoot.appendChild(card);
  });

  container.appendChild(listRoot);
  wireSubtitleListLineDrag(container, () => opts);
}

export function renderSubtitleCards(container, cues, opts = {}) {
  if (!container) return;

  setCaretRerenderHook((c, cu, o) => {
    const saved = c.scrollTop;
    renderSubtitleCards(c, cu, o);
    restoreListScrollTop(c, saved);
  });

  markCaretListStructuralMutation(48);
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
  patchAllCaretRows(container, cues, opts);
}

export function patchSelectedCueHighlight(container, prevIdx, nextIdx) {
  if (!container || prevIdx === nextIdx) return;
  setCardActiveAt(container, prevIdx, nextIdx);
  lastActiveSelectedIdx = nextIdx >= 0 ? nextIdx : -1;
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
  /** 재생 하이라이트 SSOT — script.js playbackTick에서 전달한 lookupT */
  const t =
    Number(
      opts.lookupT ??
        (opts.isPlaying ? opts.playheadSec : null) ??
        opts.playheadMediaSec ??
        opts.playheadSec,
    ) || 0;
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

  if (opts.skipWordChipHighlight) {
    lastPlayingWordEl?.classList.remove("subtitle-word-chip--active");
    lastPlayingWordEl = null;
    return;
  }

  const storageWi =
    typeof opts.activeWordIndex === "number" ? opts.activeWordIndex : -1;
  if (storageWi >= 0) {
    const cardEl = queryCardByCueIndex(container, playingIdx);
    const target = cardEl?.querySelector(
      `.subtitle-word-chip[data-word-index="${storageWi}"]`,
    );
    if (target && lastPlayingWordEl !== target) {
      lastPlayingWordEl?.classList.remove("subtitle-word-chip--active");
      target.classList.add("subtitle-word-chip--active");
      lastPlayingWordEl = target;
    }
    if (target) return;
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
  const timeEps = 1e-4;
  for (const c of wordChipCache.chips) {
    if (t >= c.s - WORD_ONSET_LEAD_SEC && t < c.e + timeEps) {
      nextChip = c.el;
      break;
    }
  }

  if (lastPlayingWordEl !== nextChip) {
    lastPlayingWordEl?.classList.remove("subtitle-word-chip--active");
    nextChip?.classList.add("subtitle-word-chip--active");
    lastPlayingWordEl = nextChip;
  }

  /* ??? ????? ???????? ??scrollCueIntoView ??scrollActiveCard ????? script ????*/
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
  if (expandedCue < 0) return;

  const card = queryCardByCueIndex(container, expandedCue);
  const mount = card?.querySelector(".subtitle-card-media-rail");
  if (!mount) return;
  const panel = panelByCard.get(mount);
  if (!panel) return;

  if (LINE_MODE_ONLY && expandedWord === -1) {
    if (
      opts.playheadEditSec != null &&
      Number.isFinite(opts.playheadEditSec) &&
      opts.mediaPlaying
    ) {
      panel.syncPlayheadFromEditSec?.(opts.playheadEditSec);
      return;
    }
    panel.syncPlayhead?.();
    return;
  }

  if (expandedWord < 0) return;

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
  if (expandedCue < 0) return;
  if (!LINE_MODE_ONLY && expandedWord < 0) return;
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
  const cut = panel?.cutSec ?? panel?.playSec;
  return Number.isFinite(cut) ? cut : null;
}

export function toggleExpandedPanelPlayFromCut(container, opts = {}) {
  if (!container) return false;
  const expandedCue = opts.expandedCueIndex ?? -1;
  const expandedWord = opts.expandedWordIndex ?? -1;
  if (expandedCue < 0) return false;
  if (!LINE_MODE_ONLY && expandedWord < 0) return false;
  const card = queryCardByCueIndex(container, expandedCue);
  const mount = card?.querySelector(".subtitle-card-media-rail");
  const panel = panelByCard.get(mount);
  if (!panel) return false;
  panel.togglePlayFromCut?.();
  return true;
}

function openWordRail(card, cueIndex, storageWordIndex, cues, opts) {
  if (LINE_MODE_ONLY) return;
  const mount = card.querySelector(".subtitle-card-media-rail");
  const accordion = card.querySelector(".subtitle-waveform-accordion");
  if (!mount || !accordion) return;
  mountWordRail(mount, card, cueIndex, storageWordIndex, cues, opts);
  accordion.classList.add("is-open");
  card.classList.add("has-waveform-open");
  opts.onWordExpand?.(cueIndex, storageWordIndex);
}

function mountCueWaveformRail(mount, card, cueIndex, cues, opts) {
  const getCues = opts.getCues || (() => cues);
  card?.querySelectorAll(".subtitle-word-chip--active").forEach((el) => {
    el.classList.remove("subtitle-word-chip--active");
  });
  let panel = panelByCard.get(mount);
  if (panel && panel.cueIndex === cueIndex && panel.root?.querySelector("[data-subwave-flow]")) {
    panel.sync?.();
    return;
  }
  mount.innerHTML = "";
  if (panel) {
    panel.hide?.();
    panel.destroy?.();
    panelByCard.delete(mount);
  }
  panel = new LineModeCueWaveformPanel(mount, {
    getCues,
    getCard: () => card,
    getPeaksData: opts.getPeaksData || (() => opts.peaksData ?? null),
    getMediaDurationSec: opts.getMediaDurationSec || (() => opts.mediaDurationSec ?? null),
    getSnapGrid: opts.getSnapGrid || (() => opts.snapGrid ?? null),
    getPlaybackSkipRanges: () => opts.getPlaybackSkipRanges?.() ?? [],
    formatTime: opts.formatTimeFull || opts.formatTime,
    getPlayheadSec: () =>
      typeof opts.getPlayheadSec === "function" ? opts.getPlayheadSec() : opts.playheadSec,
    getPlayheadEditSec: () =>
      typeof opts.getPlayheadSec === "function" ? opts.getPlayheadSec() : opts.playheadSec,
    onPreviewCueTiming: (ci, nextCue) => opts.onPreviewCueTiming?.(ci, nextCue),
    onPreviewCueLineEndTrim: (ci, lines) => opts.onPreviewCueLineEndTrim?.(ci, lines),
    onCommitCueTiming: (ci, nextCue) => opts.onCommitCueTiming?.(ci, nextCue),
    onCommitCueLineEndTrim: (ci, lines) => opts.onCommitCueLineEndTrim?.(ci, lines),
    onSeek: (sec) => opts.onSeek?.(sec),
    onPlayEditRange: (s, e) => opts.onPlayEditRange?.(s, e),
    onPausePlayback: () => opts.onPausePlayback?.(),
    isPlaying: () => opts.getIsPlaying?.() ?? Boolean(opts.isPlaying),
    isWaveformPanelActive: () => {
      const ci =
        typeof opts.getExpandedCueIndex === "function"
          ? opts.getExpandedCueIndex()
          : (opts.expandedCueIndex ?? -1);
      const wi =
        typeof opts.getExpandedWordIndex === "function"
          ? opts.getExpandedWordIndex()
          : (opts.expandedWordIndex ?? -1);
      return ci >= 0 && wi === -1;
    },
    onClose: () => opts.onCloseWaveform?.(),
    onSplitCueAtPlayLine: (ci, sec) => opts.onSplitCueAtPlayLine?.(ci, sec),
    ensurePeaksLoad: opts.ensurePeaksLoad,
  });
  panelByCard.set(mount, panel);
  panel.show(cueIndex);
}

function mountWordRail(mount, card, cueIndex, wordIndex, cues, opts) {
  if (LINE_MODE_ONLY) return;
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
      onMicroRealign: (ci, wi) => opts.onMicroRealign?.(ci, wi),
      onToast: (msg, level) => opts.onToast?.(msg, level),
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

/**
 * 파형 트림 commit — 카드·패널만 갱신 (전체 리스트 리렌더 생략).
 *
 * @param {HTMLElement | null} container
 * @param {import("../shared/subtitles.js").SubtitleLine[]} cues
 * @param {{ cueIndex: number, focusWordIndex: number, trimEdge?: 'start' | 'end' }} meta
 */
export function syncOpenCueWaveformPanel(container, opts = {}) {
  if (!LINE_MODE_ONLY || !container) return;
  const expandedCue = opts.expandedCueIndex ?? -1;
  if (expandedCue < 0 || (opts.expandedWordIndex ?? -1) !== -1) return;
  const card = queryCardByCueIndex(container, expandedCue);
  const mount = card?.querySelector(".subtitle-card-media-rail");
  const panel = mount ? panelByCard.get(mount) : null;
  if (!panel) return;
  if (opts.mediaPlaying && Number.isFinite(opts.playheadEditSec)) {
    panel.syncPlayheadFromEditSec?.(opts.playheadEditSec);
    return;
  }
  panel.sync?.();
}

export function refreshCueWaveformPanelAfterLineEndTrim(container, cues, cueIndex) {
  if (!LINE_MODE_ONLY || !container || !cues?.length || cueIndex < 0) return;

  /** @param {number} ci @param {number[]} indices */
  const patchWordTimes = (ci, indices) => {
    const card = queryCardByCueIndex(container, ci);
    const cue = cues[ci];
    if (!card || !cue?.words) return;
    for (const wi of indices) {
      if (wi < 0) continue;
      const w = cue.words[wi];
      if (!w) continue;
      const pill = card.querySelector(`.subtitle-word-chip[data-word-index="${wi}"]`);
      if (!pill) continue;
      pill.dataset.wordStart = String(w.start);
      pill.dataset.wordEnd = String(w.end);
    }
  };

  const lwi = lastSpokenStorageIndex(cues[cueIndex]);
  if (lwi >= 0) patchWordTimes(cueIndex, [lwi]);

  const nextCi = nextSpokenCueIndex(cues, cueIndex);
  if (nextCi >= 0) {
    const rwi = firstSpokenStorageIndex(cues[nextCi]);
    if (rwi >= 0) patchWordTimes(nextCi, [rwi]);
  }

  const card = queryCardByCueIndex(container, cueIndex);
  const mount = card?.querySelector(".subtitle-card-media-rail");
  const panel = mount ? panelByCard.get(mount) : null;
  panel?.syncFromLineEndTrim?.(cues);
  refreshExpandedPanelSkipRanges(container);
}

export function refreshWaveformPanelAfterTrim(container, cues, meta) {
  if (!container || !cues?.length || !meta) return;
  const { cueIndex, focusWordIndex, trimEdge } = meta;
  if (cueIndex < 0 || focusWordIndex < 0) return;

  /** @param {HTMLElement | null} card @param {import("../shared/subtitles.js").SubtitleLine} line @param {number[]} indices */
  const patchIndices = (card, line, indices) => {
    if (!card || !line?.words) return;
    for (const wi of indices) {
      if (wi < 0) continue;
      const w = line.words[wi];
      if (!w) continue;
      const pill = card.querySelector(`.subtitle-word-chip[data-word-index="${wi}"]`);
      if (!pill) continue;
      pill.dataset.wordStart = String(w.start);
      pill.dataset.wordEnd = String(w.end);
    }
  };

  /** @param {number} cueIdx @param {number} wordIdx */
  const refreshOpenPanelAt = (cueIdx, wordIdx) => {
    if (cueIdx < 0 || wordIdx < 0) return;
    const card = queryCardByCueIndex(container, cueIdx);
    if (!card?.classList.contains("has-waveform-open")) return;
    const mount = card.querySelector(".subtitle-card-media-rail");
    const panel = mount ? panelByCard.get(mount) : null;
    panel?.syncFromCuesAfterTrim?.(cueIdx, wordIdx);
  };

  const card = queryCardByCueIndex(container, cueIndex);
  const cue = cues[cueIndex];
  if (card && cue) {
    patchIndices(card, cue, [focusWordIndex]);
    if (trimEdge === "end") {
      const nextCi = nextSpokenCueIndex(cues, cueIndex);
      const nextCue = nextCi >= 0 ? cues[nextCi] : null;
      const rwi = firstSpokenStorageIndex(nextCue);
      const nextCard = nextCi >= 0 ? queryCardByCueIndex(container, nextCi) : null;
      if (nextCard && nextCue && rwi >= 0) {
        patchIndices(nextCard, nextCue, [rwi]);
        refreshOpenPanelAt(nextCi, rwi);
      }
    } else if (trimEdge === "start") {
      const prevCi = prevSpokenCueIndex(cues, cueIndex);
      const prevCue = prevCi >= 0 ? cues[prevCi] : null;
      const lwi = lastSpokenStorageIndex(prevCue);
      const prevCard = prevCi >= 0 ? queryCardByCueIndex(container, prevCi) : null;
      if (prevCard && prevCue && lwi >= 0) {
        patchIndices(prevCard, prevCue, [lwi]);
        refreshOpenPanelAt(prevCi, lwi);
      }
    }
  }

  refreshOpenPanelAt(cueIndex, focusWordIndex);
  refreshExpandedPanelSkipRanges(container);
}

export function captureTextareaEditsIntoCues(container, cues) {
  if (!container || !cues?.length) return cues;
  container.querySelectorAll(".subtitle-card").forEach((card) => {
    const idx = Number(card.dataset.cueIndex);
    if (!Number.isFinite(idx) || !cues[idx]) return;
    const ta = card.querySelector(".subtitle-card-textarea");
    if (ta instanceof HTMLTextAreaElement) {
      cues[idx].text = ta.value;
      if (ta.dataset.lineTextUserEdited === "1") {
        markLineTextUserEdited(cues[idx]);
      }
    }
  });
  return cues;
}

/**
 * 구조 변경(분할·삭제) 직전 — 해당 줄 textarea 만 SSOT에 반영.
 *
 * @param {HTMLElement | null} container
 * @param {import("../shared/subtitles.js").SubtitleLine[]} cues
 * @param {number} cueIndex
 */
export function captureTextareaForCue(container, cues, cueIndex) {
  if (!container || !cues?.length || cueIndex < 0 || cueIndex >= cues.length) return cues;
  const card = container.querySelector(`.subtitle-card[data-cue-index="${cueIndex}"]`);
  if (!card) return cues;
  const ta = card.querySelector(".subtitle-card-textarea");
  if (!(ta instanceof HTMLTextAreaElement)) return cues;
  cues[cueIndex].text = ta.value;
  if (ta.dataset.lineTextUserEdited === "1") {
    markLineTextUserEdited(cues[cueIndex]);
  }
  return cues;
}

export function readCuesFromCards(container, cues) {
  if (!container) return cues;
  captureTextareaEditsIntoCues(container, cues);
  container.querySelectorAll(".subtitle-card").forEach((card) => {
    const idx = Number(card.dataset.cueIndex);
    if (!Number.isFinite(idx) || !cues[idx]) return;
    cues[idx] = reconcileCueWordsToLineText(cues[idx]);
  });
  return cues;
}
