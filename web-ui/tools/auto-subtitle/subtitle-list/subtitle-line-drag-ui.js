/**
 * 자막 줄 드래그 — 카드 사이 노란 삽입선(갭) UI.
 */

const DROP_INDICATOR_CLASS = "subtitle-line-drop-indicator";

/** @type {{ fromListPos: number, active: boolean }} */
let dragSession = { fromListPos: -1, active: false };

export function isSubtitleLineDragSessionActive() {
  return dragSession.active;
}

/**
 * @param {number} fromListPos
 */
export function beginSubtitleLineDragSession(fromListPos) {
  dragSession = { fromListPos, active: true };
}

export function endSubtitleLineDragSession() {
  dragSession = { fromListPos: -1, active: false };
}

/**
 * @param {HTMLElement} listRoot
 * @param {number} clientY
 */
export function resolveInsertBeforeListPos(listRoot, clientY) {
  const cards = [...listRoot.querySelectorAll(".subtitle-card")];
  if (!cards.length) return 0;
  for (let i = 0; i < cards.length; i += 1) {
    const rect = cards[i].getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if (clientY < mid) return i;
  }
  return cards.length;
}

/**
 * @param {HTMLElement} listRoot
 * @param {number} insertBeforePos
 * @param {number} fromListPos
 */
function dropIndicatorTopPx(listRoot, insertBeforePos) {
  const cards = [...listRoot.querySelectorAll(".subtitle-card")];
  if (!cards.length) return 0;
  if (insertBeforePos <= 0) {
    return Math.max(0, cards[0].offsetTop - 5);
  }
  if (insertBeforePos >= cards.length) {
    const last = cards[cards.length - 1];
    return last.offsetTop + last.offsetHeight + 5;
  }
  const prev = cards[insertBeforePos - 1];
  const next = cards[insertBeforePos];
  const prevBottom = prev.offsetTop + prev.offsetHeight;
  const nextTop = next.offsetTop;
  return (prevBottom + nextTop) / 2;
}

/**
 * @param {HTMLElement} listRoot
 */
function ensureDropIndicator(listRoot) {
  let el = listRoot.querySelector(`.${DROP_INDICATOR_CLASS}`);
  if (el instanceof HTMLElement) return el;
  el = document.createElement("div");
  el.className = DROP_INDICATOR_CLASS;
  el.setAttribute("aria-hidden", "true");
  listRoot.appendChild(el);
  return el;
}

/**
 * @param {HTMLElement | null} listRoot
 * @param {number} insertBeforePos
 * @param {number} fromListPos
 */
export function showSubtitleLineDropIndicator(listRoot, insertBeforePos, fromListPos) {
  if (!listRoot) return;
  const noop =
    Number.isFinite(fromListPos) &&
    (insertBeforePos === fromListPos || insertBeforePos === fromListPos + 1);
  const indicator = ensureDropIndicator(listRoot);
  if (noop) {
    indicator.classList.remove("is-visible");
    return;
  }
  indicator.style.top = `${dropIndicatorTopPx(listRoot, insertBeforePos)}px`;
  indicator.classList.add("is-visible");
}

/** @param {HTMLElement | null} listRoot */
export function hideSubtitleLineDropIndicator(listRoot) {
  listRoot?.querySelector(`.${DROP_INDICATOR_CLASS}`)?.classList.remove("is-visible");
}

/**
 * @param {number} fromListPos
 * @param {number} insertBeforePos
 */
export function isNoopLineInsert(fromListPos, insertBeforePos) {
  return insertBeforePos === fromListPos || insertBeforePos === fromListPos + 1;
}

/**
 * @param {HTMLElement} listRoot
 * @param {number} clientY
 * @param {number} fromListPos
 */
export function updateSubtitleLineDropIndicatorAt(listRoot, clientY, fromListPos) {
  const insertBefore = resolveInsertBeforeListPos(listRoot, clientY);
  showSubtitleLineDropIndicator(listRoot, insertBefore, fromListPos);
  return insertBefore;
}

/**
 * @param {HTMLElement} scrollContainer
 * @param {() => object} getOpts
 */
export function wireSubtitleListLineDrag(scrollContainer, getOpts) {
  if (!scrollContainer) return;

  scrollContainer.addEventListener(
    "pointermove",
    (e) => {
      if (!dragSession.active) return;
      const opts = getOpts();
      const listRoot = scrollContainer.querySelector(".as-subtitle-cards-root");
      if (!listRoot) return;
      updateSubtitleLineDropIndicatorAt(listRoot, e.clientY, dragSession.fromListPos);
    },
    { passive: true },
  );

  scrollContainer.addEventListener("pointercancel", () => {
    if (!dragSession.active) return;
    hideSubtitleLineDropIndicator(scrollContainer.querySelector(".as-subtitle-cards-root"));
    endSubtitleLineDragSession();
    getOpts().onDragReorderEnd?.();
  });
}
