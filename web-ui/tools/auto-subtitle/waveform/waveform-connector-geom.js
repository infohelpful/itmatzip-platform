/**
 * AutoSubtitle SubtitleWaveformCanvas — connectorGeom / recomputeConnectorGeom
 */

/**
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 */
function clampPx(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * @param {{ start: number, end: number }} viewWin
 * @param {{ start: number, end: number }} editRange
 * @param {{ activeSpanSec: number, mediaSecToActiveSec: (t: number) => number } | null} skipMapping
 */
export function computeTrimHandlePct(viewWin, editRange, skipMapping) {
  if (!viewWin || !editRange || !skipMapping) return null;
  const span = Math.max(skipMapping.activeSpanSec, 1e-9);
  const s = Math.min(editRange.start, editRange.end);
  const e = Math.max(editRange.start, editRange.end);
  const sActive = skipMapping.mediaSecToActiveSec(s);
  const eActive = skipMapping.mediaSecToActiveSec(e);
  return {
    startPct: clampPx((sActive / span) * 100, 0, 100),
    endPct: clampPx((eActive / span) * 100, 0, 100),
    startSec: s,
    endSec: e,
  };
}

/**
 * @param {HTMLElement} articleEl 자막 카드 (article.subtitle-card)
 * @param {HTMLElement} waveBoxEl 흰 테두리 파형 박스 (.subwave-chrome)
 * @param {string | null} activeWordId block_* id
 * @param {{ startPct: number, endPct: number }} trimHandlePct
 * @returns {{
 *   svgW: number,
 *   svgH: number,
 *   fromL: { x: number, y: number },
 *   fromR: { x: number, y: number },
 *   toL: { x: number, y: number },
 *   toR: { x: number, y: number },
 * } | null}
 */
export function computeConnectorGeom(articleEl, waveBoxEl, activeWordId, trimHandlePct) {
  if (!articleEl || !waveBoxEl || !activeWordId || !trimHandlePct) return null;

  let chipEl = null;
  try {
    chipEl = articleEl.querySelector(`[data-word-id="${CSS.escape(activeWordId)}"]`);
  } catch {
    chipEl = null;
  }
  if (!(chipEl instanceof HTMLElement)) {
    chipEl = articleEl.querySelector('[data-waveform-active-word-chip="1"]');
  }
  if (!(chipEl instanceof HTMLElement)) return null;

  const articleRect = articleEl.getBoundingClientRect();
  const chipRect = chipEl.getBoundingClientRect();
  const waveRect = waveBoxEl.getBoundingClientRect();
  if (articleRect.width <= 0 || chipRect.width <= 0 || waveRect.width <= 0) return null;

  return {
    svgW: articleRect.width,
    svgH: articleRect.height,
    fromL: {
      x: chipRect.left - articleRect.left,
      y: chipRect.bottom - articleRect.top,
    },
    fromR: {
      x: chipRect.right - articleRect.left,
      y: chipRect.bottom - articleRect.top,
    },
    toL: {
      x:
        waveRect.left -
        articleRect.left +
        (waveRect.width * trimHandlePct.startPct) / 100,
      y: waveRect.top - articleRect.top,
    },
    toR: {
      x:
        waveRect.left -
        articleRect.left +
        (waveRect.width * trimHandlePct.endPct) / 100,
      y: waveRect.top - articleRect.top,
    },
  };
}

/**
 * @param {HTMLElement} overlayHost
 * @param {ReturnType<typeof computeConnectorGeom>} geom
 */
export function paintConnectorOverlay(overlayHost, geom) {
  if (!overlayHost || !geom) {
    if (overlayHost) overlayHost.hidden = true;
    return;
  }
  const svg = overlayHost.querySelector(".subwave-connector-svg");
  if (!(svg instanceof SVGSVGElement)) return;

  overlayHost.hidden = false;
  svg.setAttribute("viewBox", `0 0 ${geom.svgW} ${geom.svgH}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.innerHTML = "";

  const stroke = "rgba(180, 200, 220, 0.55)";
  const strokeWidth = "1.25";

  for (const [x1, y1, x2, y2] of [
    [geom.fromL.x, geom.fromL.y, geom.toL.x, geom.toL.y],
    [geom.fromR.x, geom.fromR.y, geom.toR.x, geom.toR.y],
  ]) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("stroke", stroke);
    line.setAttribute("stroke-width", strokeWidth);
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(line);
  }
}

/**
 * @param {HTMLElement} articleEl
 * @returns {HTMLElement}
 */
export function ensureConnectorOverlayHost(articleEl) {
  let host = articleEl.querySelector(".subwave-connector-overlay");
  if (host instanceof HTMLElement) return host;

  host = document.createElement("div");
  host.className = "subwave-connector-overlay";
  host.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("subwave-connector-svg");
  host.appendChild(svg);
  articleEl.insertBefore(host, articleEl.firstChild);
  return host;
}
