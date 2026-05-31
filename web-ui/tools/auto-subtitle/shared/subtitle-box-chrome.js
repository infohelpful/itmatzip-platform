/**
 * AutoSubtitle subtitleBoxChrome.ts — 미리보기·내보내기 자막 박스 스타일.
 */

export const PREVIEW_SUBTITLE_SIDE_MARGIN_PCT = 3;

export function clampSubtitleStylePercent(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

export function subtitlePreviewTextAlign(xPct) {
  const x = clampSubtitleStylePercent(xPct, 0, 100);
  if (x <= 33) return "left";
  if (x >= 67) return "right";
  return "center";
}

/**
 * 텍스트 길이에 맞게 줄어드는 자막 박스 위치(프리뷰·번인 공통).
 * @param {number} xPct
 * @param {number} yPct
 * @param {number} [marginPct]
 */
export function buildSubtitleOverlayPositionStyle(xPct, yPct, marginPct = PREVIEW_SUBTITLE_SIDE_MARGIN_PCT) {
  const x = clampSubtitleStylePercent(xPct, 5, 95);
  const y = clampSubtitleStylePercent(yPct, 2, 98);
  const margin = clampSubtitleStylePercent(marginPct, 0, 20);
  const align = subtitlePreviewTextAlign(x);
  const maxWidth = `calc(100% - ${margin * 2}%)`;

  if (align === "center") {
    return {
      top: `${y}%`,
      left: `${x}%`,
      right: "auto",
      transform: "translate(-50%, -50%)",
      textAlign: "center",
      maxWidth,
    };
  }
  if (align === "left") {
    return {
      top: `${y}%`,
      left: `${margin}%`,
      right: "auto",
      transform: "translateY(-50%)",
      textAlign: "left",
      maxWidth,
    };
  }
  return {
    top: `${y}%`,
    left: "auto",
    right: `${margin}%`,
    transform: "translateY(-50%)",
    textAlign: "right",
    maxWidth,
  };
}

export function getSubtitleBoxChromeInline(fontSizePx, paddingPct = 100) {
  const scale = Math.max(30, Math.min(150, paddingPct)) / 100;
  const baseY = Math.max(4, Math.round((fontSizePx * 5) / 16));
  const baseX = Math.max(8, Math.round((fontSizePx * 9.5) / 16));
  const scaledY = Math.round(baseY * scale);
  const scaledX = Math.round(baseX * scale);
  const padY = Math.max(scaledY, Math.ceil(fontSizePx * 0.13));
  const padX = Math.max(scaledX, Math.ceil(fontSizePx * 0.2));
  return {
    padding: `${padY}px ${padX}px`,
    lineHeight: 1.38,
    borderRadius: 8,
    border: "1px solid rgba(255, 255, 255, 0.1)",
    boxSizing: "border-box",
  };
}

/**
 * @param {object} style
 * @param {number} [scale]
 */
export function buildSubtitleOverlayInnerStyle(style, scale = 1) {
  const fontSize = Math.max(8, Math.round((style.fontSize || 47) * scale));
  const strokeWidth = Math.max(0, (style.strokeWidth || 0) * scale);
  const chrome = getSubtitleBoxChromeInline(fontSize, style.bgSize ?? 50);
  const position = buildSubtitleOverlayPositionStyle(style.x ?? 50, style.y ?? 90);
  return { fontSize, strokeWidth, chrome, position };
}

export function normalizePreviewSubtitleText(text) {
  return String(text ?? "")
    .replace(/[\u2028\u2029\u000B\u000C\u0085\r\n]/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[^\S ]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** @param {HTMLElement} innerEl */
function measureSubtitleOverlayNowrapWidth(innerEl) {
  innerEl.style.display = "inline-block";
  innerEl.style.boxSizing = "border-box";
  innerEl.style.whiteSpace = "nowrap";
  innerEl.style.wordBreak = "keep-all";
  innerEl.style.overflowWrap = "normal";
  innerEl.style.width = "max-content";
  innerEl.style.maxWidth = "none";
  void innerEl.offsetWidth;
  return innerEl.getBoundingClientRect().width;
}

/** @param {HTMLElement} innerEl @param {number} maxPx */
function shrinkWrappedSubtitleOverlayWidth(innerEl, maxPx) {
  innerEl.style.whiteSpace = "normal";
  innerEl.style.wordBreak = "keep-all";
  innerEl.style.overflowWrap = "normal";
  innerEl.style.width = `${maxPx}px`;
  innerEl.style.maxWidth = `${maxPx}px`;
  void innerEl.offsetHeight;

  const rects = innerEl.getClientRects();
  let maxLineW = 0;
  for (let i = 0; i < rects.length; i += 1) {
    maxLineW = Math.max(maxLineW, rects[i].width);
  }

  const cs = getComputedStyle(innerEl);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const targetW = Math.min(maxPx, Math.max(1, Math.ceil(maxLineW + padX + 0.5)));
  innerEl.style.width = `${targetW}px`;
  innerEl.style.maxWidth = `${maxPx}px`;
}

/** @param {HTMLElement} innerEl @param {HTMLElement} containerEl @param {number} [marginPct] */
export function applySubtitleOverlayTextLayout(innerEl, containerEl, marginPct = PREVIEW_SUBTITLE_SIDE_MARGIN_PCT) {
  if (!innerEl || !containerEl) return;
  const cw = containerEl.clientWidth;
  if (!(cw > 0)) return;
  const margin = clampSubtitleStylePercent(marginPct, 0, 20);
  const maxPx = Math.max(48, Math.floor(cw * (1 - (margin * 2) / 100)));

  const normalized = normalizePreviewSubtitleText(innerEl.textContent);
  if (innerEl.textContent !== normalized) {
    innerEl.textContent = normalized;
  }
  if (!normalized) return;

  const naturalW = measureSubtitleOverlayNowrapWidth(innerEl);

  if (naturalW <= maxPx + 0.5) {
    innerEl.style.whiteSpace = "nowrap";
    innerEl.style.width = "max-content";
    innerEl.style.maxWidth = `${maxPx}px`;
    return;
  }

  shrinkWrappedSubtitleOverlayWidth(innerEl, maxPx);
}
