/**
 * 찾기·바꾸기 — 자막 편집 textarea 줄 텍스트 노란 표시.
 */

/**
 * @param {string} s
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {string} text
 * @param {string} query
 * @param {{ pos: number, len: number } | null} activeRange
 */
export function buildLineFindHighlightHtml(text, query, activeRange = null) {
  const raw = String(text ?? "");
  const q = String(query ?? "").trim();
  if (!q) return escapeHtml(raw) || "&nbsp;";

  const qLower = q.toLowerCase();
  const tLower = raw.toLowerCase();
  let from = 0;
  let html = "";
  let hit = false;

  while (from < raw.length) {
    const pos = tLower.indexOf(qLower, from);
    if (pos < 0) {
      html += escapeHtml(raw.slice(from));
      break;
    }
    hit = true;
    if (pos > from) html += escapeHtml(raw.slice(from, pos));
    const slice = raw.slice(pos, pos + q.length);
    const isActive =
      activeRange != null && activeRange.pos === pos && activeRange.len === q.length;
    const cls = isActive
      ? "subtitle-find-text-mark subtitle-find-text-mark--active"
      : "subtitle-find-text-mark";
    html += `<mark class="${cls}">${escapeHtml(slice)}</mark>`;
    from = pos + q.length;
  }

  if (!hit) html = escapeHtml(raw);
  return html || "&nbsp;";
}

/**
 * @param {HTMLElement} layer
 * @param {HTMLTextAreaElement} ta
 */
export function syncFindHighlightLayerToTextarea(layer, ta) {
  const cs = getComputedStyle(ta);
  layer.style.font = cs.font;
  layer.style.fontSize = cs.fontSize;
  layer.style.fontFamily = cs.fontFamily;
  layer.style.fontWeight = cs.fontWeight;
  layer.style.lineHeight = cs.lineHeight;
  layer.style.letterSpacing = cs.letterSpacing;
  layer.style.padding = cs.padding;
  layer.style.border = "1px solid transparent";
  layer.style.boxSizing = cs.boxSizing;
  layer.style.whiteSpace = "pre-wrap";
  layer.style.wordWrap = "break-word";
  layer.scrollTop = ta.scrollTop;
  layer.scrollLeft = ta.scrollLeft;
}

/**
 * @param {HTMLElement | null} container
 * @param {{ query?: string, activeMatchIndex?: number, matches?: { cueIndex: number, pos: number, len: number }[] }} state
 */
export function applyFindReplaceHighlights(container, state) {
  if (!container) return;

  const query = String(state.query ?? "").trim();
  const activeIdx = Number(state.activeMatchIndex);
  const matches = state.matches ?? [];
  const activeMatch =
    activeIdx >= 0 && activeIdx < matches.length ? matches[activeIdx] : null;

  const hitsByCue = new Map();
  for (const m of matches) {
    if (!hitsByCue.has(m.cueIndex)) hitsByCue.set(m.cueIndex, []);
    hitsByCue.get(m.cueIndex).push(m);
  }

  container.querySelectorAll(".subtitle-card").forEach((card) => {
    const ci = Number(card.dataset.cueIndex);
    const ta = card.querySelector(".subtitle-card-textarea");
    const layer = card.querySelector(".subtitle-find-text-layer");
    const stack = card.querySelector(".subtitle-card-textarea-stack");

    card.classList.remove("subtitle-card--find-line-hit", "subtitle-card--find-line-active");

    if (!(ta instanceof HTMLTextAreaElement) || !(layer instanceof HTMLElement)) return;

    if (!query) {
      layer.innerHTML = "";
      stack?.classList.remove("is-find-open", "is-find-active");
      syncFindHighlightLayerToTextarea(layer, ta);
      return;
    }

    const hasHit = hitsByCue.has(ci);
    card.classList.toggle("subtitle-card--find-line-hit", hasHit);
    card.classList.toggle(
      "subtitle-card--find-line-active",
      activeMatch != null && activeMatch.cueIndex === ci,
    );
    stack?.classList.toggle("is-find-open", hasHit);
    stack?.classList.toggle("is-find-active", activeMatch != null && activeMatch.cueIndex === ci);

    const activeRange =
      activeMatch != null && activeMatch.cueIndex === ci
        ? { pos: activeMatch.pos, len: activeMatch.len }
        : null;

    layer.innerHTML = buildLineFindHighlightHtml(ta.value, query, activeRange);
    syncFindHighlightLayerToTextarea(layer, ta);
  });
}
