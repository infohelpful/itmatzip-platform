/**
 * Ctrl+F — 자막 편집 영역(textarea 줄 텍스트) 찾기·바꾸기.
 */

import { markLineTextUserEdited, rebuildWordsFromLineText } from "./subtitle-words.js?v=24";
import { normalizePreviewSubtitleText } from "./shared/subtitle-box-chrome.js?v=25";
import { applyFindReplaceHighlights } from "./subtitle-find-replace-highlight.js?v=2";

/**
 * @typedef {{ cueIndex: number, pos: number, len: number }} FindMatch
 */

/** @type {string} */
let findQuery = "";
/** @type {number} */
let activeMatchIndex = -1;
/** @type {FindMatch[]} */
let cachedMatches = [];

/**
 * @param {readonly import("./shared/subtitles.js").SubtitleLine[]} cues
 * @param {number} cueIndex
 * @param {HTMLElement | null | undefined} listContainer
 */
export function getSubtitleLineTextForFind(cues, cueIndex, listContainer) {
  const cue = cues?.[cueIndex];
  if (!cue) return "";

  const card = listContainer?.querySelector(`.subtitle-card[data-cue-index="${cueIndex}"]`);
  const ta = card?.querySelector(".subtitle-card-textarea");
  if (ta instanceof HTMLTextAreaElement) {
    return ta.value;
  }

  return normalizePreviewSubtitleText(cue.text ?? "");
}

/**
 * @param {string} query
 */
function escapeRegExp(query) {
  return query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} haystack
 * @param {string} query
 * @param {string} replacement
 */
function replaceAllOccurrences(haystack, query, replacement) {
  if (!query) return haystack;
  return haystack.replace(new RegExp(escapeRegExp(query), "gi"), replacement);
}

/**
 * @param {readonly import("./shared/subtitles.js").SubtitleLine[]} cues
 * @param {string} query
 * @param {HTMLElement | null | undefined} listContainer
 * @returns {FindMatch[]}
 */
export function collectSubtitleFindMatches(cues, query, listContainer = null) {
  const q = String(query ?? "").trim();
  if (!q) return [];
  const qLower = q.toLowerCase();
  /** @type {FindMatch[]} */
  const out = [];

  for (let ci = 0; ci < (cues || []).length; ci += 1) {
    const cue = cues[ci];
    if (!cue || cue.is_silence || cue.isSilence) continue;

    const lineText = getSubtitleLineTextForFind(cues, ci, listContainer);
    let from = 0;
    while (from < lineText.length) {
      const pos = lineText.toLowerCase().indexOf(qLower, from);
      if (pos < 0) break;
      out.push({ cueIndex: ci, pos, len: q.length });
      from = pos + Math.max(1, q.length);
    }
  }
  return out;
}

export function getFindReplaceHighlightState() {
  return {
    query: findQuery,
    activeMatchIndex,
    matches: cachedMatches,
  };
}

/**
 * @param {import("./shared/subtitles.js").SubtitleLine} cue
 * @param {string} lineText
 * @param {FindMatch} match
 * @param {string} replacement
 */
function applyFindMatchToLineText(cue, lineText, match, replacement) {
  const nextText =
    lineText.slice(0, match.pos) + replacement + lineText.slice(match.pos + match.len);
  let next = { ...cue, text: nextText };
  markLineTextUserEdited(next);
  return rebuildWordsFromLineText(next);
}

/**
 * @param {readonly import("./shared/subtitles.js").SubtitleLine[]} cues
 * @param {string} query
 * @param {string} replacement
 * @param {HTMLElement | null | undefined} listContainer
 */
export function replaceAllInSubtitleCues(cues, query, replacement, listContainer = null) {
  const q = String(query ?? "").trim();
  if (!q) return [...(cues || [])];

  return (cues || []).map((cue, ci) => {
    if (!cue || cue.is_silence || cue.isSilence) return cue;
    const lineText = getSubtitleLineTextForFind(cues, ci, listContainer);
    const newText = replaceAllOccurrences(lineText, q, replacement);
    if (newText === lineText) return cue;
    let next = { ...cue, text: newText };
    markLineTextUserEdited(next);
    return rebuildWordsFromLineText(next);
  });
}

/**
 * @param {{
 *   getCues: () => import("./shared/subtitles.js").SubtitleLine[],
 *   captureEdits?: () => void,
 *   applyChange: (updater: (prev: import("./shared/subtitles.js").SubtitleLine[]) => import("./shared/subtitles.js").SubtitleLine[]) => void,
 *   focusMatch: (match: FindMatch) => void,
 *   getListContainer?: () => HTMLElement | null,
 *   hasCues?: () => boolean,
 * }} deps
 */
export function initSubtitleFindReplace(deps) {
  const root = document.getElementById("subtitle-find-replace");
  const panel = root?.querySelector(".as-find-replace__panel");
  const inputFind = /** @type {HTMLInputElement | null} */ (
    document.getElementById("find-replace-query")
  );
  const inputReplace = /** @type {HTMLInputElement | null} */ (
    document.getElementById("find-replace-with")
  );
  const btnPrev = document.getElementById("btn-find-replace-prev");
  const btnForward = document.getElementById("btn-find-replace-forward");
  const btnReplaceOne = document.getElementById("btn-find-replace-one");
  const btnAll = document.getElementById("btn-find-replace-all");
  const btnClose = document.getElementById("btn-find-replace-close");
  const metaEl = document.getElementById("find-replace-meta");

  if (
    !root ||
    !panel ||
    !inputFind ||
    !inputReplace ||
    !btnPrev ||
    !btnForward ||
    !btnReplaceOne ||
    !btnAll
  ) {
    return {
      open: () => {},
      close: () => {},
      toggle: () => {},
      isOpen: () => false,
      getHighlightState: getFindReplaceHighlightState,
    };
  }

  let open = false;
  let nextMatchIndex = 0;

  function listEl() {
    return deps.getListContainer?.() ?? null;
  }

  function syncHighlights() {
    const list = listEl();
    if (list) {
      applyFindReplaceHighlights(list, getFindReplaceHighlightState());
    }
  }

  function refreshMatches() {
    deps.captureEdits?.();
    const cues = deps.getCues();
    findQuery = inputFind.value.trim();
    cachedMatches = collectSubtitleFindMatches(cues, findQuery, listEl());
    if (cachedMatches.length === 0) {
      nextMatchIndex = 0;
      activeMatchIndex = -1;
    } else {
      if (nextMatchIndex >= cachedMatches.length) {
        nextMatchIndex = cachedMatches.length - 1;
      }
      if (activeMatchIndex >= cachedMatches.length) {
        activeMatchIndex = cachedMatches.length - 1;
        nextMatchIndex = activeMatchIndex;
      }
    }
  }

  function positionPanel() {
    const previewPane = document.querySelector(".as-pane-preview");
    const subtitlePane = document.querySelector(".as-pane-subtitles");
    const previewAd = document.getElementById("editor-ad-preview-pane");
    if (!previewPane) return;

    const pr = previewPane.getBoundingClientRect();
    const sr = subtitlePane?.getBoundingClientRect();
    const adR = previewAd?.getBoundingClientRect();
    const gap = 10;
    const width = panel.offsetWidth || 300;

    let left = sr ? sr.left - width - gap : pr.right - width - gap;
    left = Math.max(pr.left + gap, left);

    let top = pr.top + pr.height * 0.5;
    let bottomLimit = pr.bottom - gap;
    if (adR && adR.height > 20) {
      bottomLimit = Math.min(bottomLimit, adR.top - gap);
    }
    top = Math.min(Math.max(pr.top + 72, top), bottomLimit);

    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
  }

  function updateMetaAndButtons() {
    const n = cachedMatches.length;
    if (!findQuery) {
      metaEl.textContent = "찾을 단어를 입력하세요.";
    } else if (n === 0) {
      metaEl.textContent = "일치하는 내용이 없습니다.";
    } else if (activeMatchIndex < 0) {
      metaEl.textContent = `${n}개 찾음 · ← → 로 이동`;
    } else {
      const at = Math.min(activeMatchIndex + 1, n);
      metaEl.textContent = `${n}개 찾음 · 현재: ${at}/${n}`;
    }

    const navDisabled = n === 0;
    btnPrev.disabled = navDisabled;
    btnForward.disabled = navDisabled;
    btnReplaceOne.disabled = n === 0 || activeMatchIndex < 0;
    btnAll.disabled = n === 0 || !findQuery;
    syncHighlights();
  }

  function refreshMeta() {
    refreshMatches();
    updateMetaAndButtons();
  }

  /** @param {number} delta -1 이전, +1 다음 */
  function navigateMatch(delta) {
    refreshMatches();
    const n = cachedMatches.length;
    if (!n) {
      updateMetaAndButtons();
      return;
    }

    if (activeMatchIndex < 0) {
      nextMatchIndex = delta > 0 ? 0 : n - 1;
    } else {
      nextMatchIndex = (activeMatchIndex + delta + n) % n;
    }
    activeMatchIndex = nextMatchIndex;

    const match = cachedMatches[nextMatchIndex];
    updateMetaAndButtons();
    requestAnimationFrame(() => deps.focusMatch(match));
  }

  function openPanel() {
    if (deps.hasCues && !deps.hasCues()) {
      metaEl.textContent = "자막이 없습니다.";
      return;
    }
    open = true;
    root.hidden = false;
    root.setAttribute("aria-hidden", "false");
    positionPanel();
    refreshMeta();
    requestAnimationFrame(() => inputFind.focus());
  }

  function closePanel() {
    open = false;
    root.hidden = true;
    root.setAttribute("aria-hidden", "true");
    nextMatchIndex = 0;
    activeMatchIndex = -1;
    findQuery = "";
    cachedMatches = [];
    syncHighlights();
    listEl()
      ?.querySelectorAll(".subtitle-card-textarea-stack.is-find-active")
      .forEach((el) => el.classList.remove("is-find-active"));
  }

  function togglePanel() {
    if (open) closePanel();
    else openPanel();
  }

  function applyNextReplace() {
    const q = inputFind.value.trim();
    const replacement = inputReplace.value;
    if (!q) return;

    refreshMatches();
    if (!cachedMatches.length || activeMatchIndex < 0) {
      refreshMeta();
      return;
    }

    const match = cachedMatches[activeMatchIndex];

    deps.captureEdits?.();
    const cues = deps.getCues();
    const lineText = getSubtitleLineTextForFind(cues, match.cueIndex, listEl());
    deps.applyChange((prev) => {
      const next = [...prev];
      next[match.cueIndex] = applyFindMatchToLineText(
        prev[match.cueIndex],
        lineText,
        match,
        replacement,
      );
      return next;
    });

    refreshMatches();
    updateMetaAndButtons();
  }

  function applyReplaceAll() {
    const q = inputFind.value.trim();
    const replacement = inputReplace.value;
    if (!q) return;

    deps.captureEdits?.();
    deps.applyChange((prev) => replaceAllInSubtitleCues(prev, q, replacement, listEl()));
    nextMatchIndex = 0;
    activeMatchIndex = -1;
    refreshMeta();
  }

  inputFind.addEventListener("input", () => {
    nextMatchIndex = 0;
    activeMatchIndex = -1;
    refreshMeta();
  });
  inputReplace.addEventListener("input", refreshMeta);
  btnPrev.addEventListener("click", () => navigateMatch(-1));
  btnForward.addEventListener("click", () => navigateMatch(1));
  btnReplaceOne.addEventListener("click", () => applyNextReplace());
  btnAll.addEventListener("click", () => applyReplaceAll());
  btnClose?.addEventListener("click", () => closePanel());

  window.addEventListener("resize", () => {
    if (open) positionPanel();
  });

  return {
    open: openPanel,
    close: closePanel,
    toggle: togglePanel,
    isOpen: () => open,
    getHighlightState: getFindReplaceHighlightState,
    refreshHighlights: () => {
      refreshMatches();
      syncHighlights();
    },
    handleKeydown: (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
      if (e.key.toLowerCase() !== "f") return false;
      e.preventDefault();
      if (open && root.contains(document.activeElement)) {
        inputFind.focus();
      } else {
        togglePanel();
      }
      return true;
    },
    handleEscape: () => {
      if (!open) return false;
      closePanel();
      return true;
    },
  };
}
