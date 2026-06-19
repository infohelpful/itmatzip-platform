/**
 * 자막 카드 왼쪽 IDX + 체크박스 + 드래그 핸들.
 */

import {
  beginSubtitleLineDragSession,
  endSubtitleLineDragSession,
  hideSubtitleLineDropIndicator,
  isNoopLineInsert,
  resolveInsertBeforeListPos,
  updateSubtitleLineDropIndicatorAt,
} from "./subtitle-line-drag-ui.js?v=3";

const BODY_HOLD_MS = 320;
const MOVE_CANCEL_PX = 10;

/**
 * @param {object} opts
 * @param {number} cueIndex
 */
function lineDragAllowedFromBody(opts, cueIndex) {
  if (opts.isCueLineChecked?.(cueIndex)) return true;
  if (typeof opts.selectedCueIndex === "number" && opts.selectedCueIndex === cueIndex) {
    return true;
  }
  return false;
}

/**
 * @param {HTMLElement} card
 * @param {number} listPos
 * @param {HTMLElement} scrollContainer
 * @param {() => object} getOpts
 * @param {number} cueIndex
 */
function commitDragAtPointer(card, listPos, scrollContainer, getOpts, cueIndex, clientY) {
  const opts = getOpts();
  const root = scrollContainer.querySelector(".as-subtitle-cards-root");
  hideSubtitleLineDropIndicator(root);
  endSubtitleLineDragSession();
  card.classList.remove("is-drag-source", "is-drag-hold");
  scrollContainer.classList.remove("is-line-drag-active");
  const insertBefore = root ? resolveInsertBeforeListPos(root, clientY) : -1;
  if (root && !isNoopLineInsert(listPos, insertBefore)) {
    opts.onReorderCueByListInsert?.(listPos, insertBefore);
  } else {
    opts.onDragReorderEnd?.();
  }
}

/**
 * @param {object} params
 */
function wireSubtitleLineDragTargets({
  card,
  dragHandle,
  cueIndex,
  listPos,
  scrollContainer,
  getOpts,
}) {
  let dragging = false;
  /** @type {number | null} */
  let activePointerId = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let holdTimer = null;
  let holdStartX = 0;
  let holdStartY = 0;

  const listRoot = () => scrollContainer.querySelector(".as-subtitle-cards-root");

  const clearHold = () => {
    if (holdTimer != null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  };

  const beginDrag = (pointerId, clientY) => {
    dragging = true;
    activePointerId = pointerId;
    card.classList.add("is-drag-hold", "is-drag-source");
    scrollContainer.classList.add("is-line-drag-active");
    beginSubtitleLineDragSession(listPos);
    getOpts().onSubtitleLineDragStart?.();
    updateSubtitleLineDropIndicatorAt(listRoot(), clientY, listPos);
  };

  const onPointerMove = (e) => {
    if (!dragging || e.pointerId !== activePointerId) return;
    if (holdTimer != null) {
      const dx = e.clientX - holdStartX;
      const dy = e.clientY - holdStartY;
      if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) clearHold();
    }
    e.preventDefault();
    updateSubtitleLineDropIndicatorAt(listRoot(), e.clientY, listPos);
  };

  const onPointerUp = (e) => {
    if (dragging && e.pointerId === activePointerId) {
      e.preventDefault();
      commitDragAtPointer(card, listPos, scrollContainer, getOpts, cueIndex, e.clientY);
      dragging = false;
      activePointerId = null;
      clearHold();
      return;
    }
    clearHold();
  };

  const onPointerCancel = (e) => {
    if (!dragging) {
      clearHold();
      return;
    }
    hideSubtitleLineDropIndicator(listRoot());
    endSubtitleLineDragSession();
    getOpts().onDragReorderEnd?.();
    dragging = false;
    activePointerId = null;
    card.classList.remove("is-drag-source", "is-drag-hold");
    scrollContainer.classList.remove("is-line-drag-active");
    clearHold();
  };

  dragHandle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    clearHold();
    holdStartX = e.clientX;
    holdStartY = e.clientY;
    try {
      dragHandle.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    beginDrag(e.pointerId, e.clientY);
  });

  dragHandle.addEventListener("pointermove", onPointerMove);
  dragHandle.addEventListener("pointerup", onPointerUp);
  dragHandle.addEventListener("pointercancel", onPointerCancel);

  card.addEventListener(
    "pointerdown",
    (e) => {
      if (!lineDragAllowedFromBody(getOpts(), cueIndex)) return;
      if (e.button !== 0) return;
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      if (
        t.closest(
          "textarea, input, select, button, .subtitle-word-chip, .subtitle-word-caret-btn, .subtitle-card-line-rail",
        )
      ) {
        return;
      }
      clearHold();
      holdStartX = e.clientX;
      holdStartY = e.clientY;
      const pointerId = e.pointerId;
      holdTimer = setTimeout(() => {
        holdTimer = null;
        try {
          card.setPointerCapture(pointerId);
        } catch {
          /* ignore */
        }
        beginDrag(pointerId, e.clientY);
      }, BODY_HOLD_MS);
    },
    true,
  );

  card.addEventListener("pointermove", onPointerMove);
  card.addEventListener("pointerup", onPointerUp);
  card.addEventListener("pointercancel", onPointerCancel);
}

/**
 * @param {number} cueIndex
 * @param {number} displayIdx
 * @param {() => object} getOpts
 */
export function buildSubtitleLineRail(cueIndex, displayIdx, getOpts) {
  const opts = getOpts();
  const rail = document.createElement("div");
  rail.className = "subtitle-card-line-rail";
  rail.setAttribute("role", "group");
  rail.setAttribute("aria-label", "자막 줄 선택");

  const idxEl = document.createElement("span");
  idxEl.className = "subtitle-card-line-idx";
  idxEl.textContent = String(displayIdx);
  idxEl.setAttribute("aria-hidden", "true");

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "subtitle-card-line-checkbox";
  cb.checked = Boolean(opts.isCueLineChecked?.(cueIndex));
  cb.setAttribute("aria-label", `자막 ${displayIdx}번 줄 선택`);
  cb.title = "선택 후 Delete 키로 줄 삭제";
  cb.addEventListener("change", (e) => {
    e.stopPropagation();
    getOpts().onToggleCueLineCheck?.(cueIndex, cb.checked);
  });
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.addEventListener("mousedown", (e) => e.stopPropagation());

  const dragHandle = document.createElement("button");
  dragHandle.type = "button";
  dragHandle.className = "subtitle-card-line-drag-handle";
  dragHandle.title = "끌어서 줄 순서 변경";
  dragHandle.setAttribute("aria-label", "줄 순서 변경");
  dragHandle.innerHTML = "<span aria-hidden=\"true\">⋮⋮</span>";
  dragHandle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  rail.appendChild(idxEl);
  rail.appendChild(cb);
  rail.appendChild(dragHandle);

  rail.addEventListener("click", (e) => {
    if (e.target === cb || e.target === dragHandle || dragHandle.contains(e.target)) return;
    e.stopPropagation();
    getOpts().onSelectCue?.(cueIndex, { scroll: false, rerender: false, lineRail: true });
    if (!cb.checked) {
      cb.checked = true;
      getOpts().onToggleCueLineCheck?.(cueIndex, true);
    }
  });

  return { rail, dragHandle };
}

/**
 * @param {HTMLElement} card
 * @param {number} cueIndex
 * @param {number} listPos
 * @param {HTMLElement} scrollContainer
 * @param {() => object} getOpts
 * @param {{ rail: HTMLElement, dragHandle: HTMLButtonElement }} railParts
 */
export function wireSubtitleLineDrag(card, cueIndex, listPos, scrollContainer, getOpts, railParts) {
  wireSubtitleLineDragTargets({
    card,
    dragHandle: railParts.dragHandle,
    cueIndex,
    listPos,
    scrollContainer,
    getOpts,
  });
}
