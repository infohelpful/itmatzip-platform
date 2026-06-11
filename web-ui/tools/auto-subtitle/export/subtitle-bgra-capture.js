/**
 * 프리뷰와 동일한 DOM 렌더링 → Canvas 캡처 (프리뷰 일치 보장).
 * text-stroke 포함 전체 CSS 렌더링을 그대로 캡처합니다.
 */

import {
  applySubtitleOverlayTextLayout,
  buildSubtitleOverlayInnerStyle,
  getSubtitleBoxChromeInline,
  normalizePreviewSubtitleText,
  PREVIEW_SUBTITLE_SIDE_MARGIN_PCT,
  subtitlePreviewTextAlign,
} from "../shared/subtitle-box-chrome.js?v=25";
import { computeExportOverlayScale } from "../shared/export-render-scale.js?v=1";

const CAPTURE_SCALE = 2;

let captureHostRoot = null;

function clampStylePercent(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function previewSubtitleTextAlign(xPct) {
  return subtitlePreviewTextAlign(xPct);
}

function parseBgRgba(style) {
  const bg = String(style.bgColor || "#000000").slice(0, 7);
  const alpha = Math.max(0, Math.min(1, (style.bgOpacity ?? 60) / 100));
  const h = bg.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padStart(6, "0").slice(0, 6);
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function hexWithAlpha(hex, alpha255) {
  const h = String(hex || "#ffffff").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padStart(6, "0").slice(0, 6);
  const a = Math.max(0, Math.min(255, Number(alpha255) || 255));
  return `#${full}${a.toString(16).padStart(2, "0")}`;
}

/**
 * @param {object} style
 * @param {number} renderW
 * @param {number} renderH
 */
function buildExportSubtitleInnerStyle(style, renderW, renderH) {
  const fullH = style.videoHeight || renderH;
  const scale = computeExportOverlayScale(renderH, fullH);
  const { fontSize, strokeWidth, chrome, position } = buildSubtitleOverlayInnerStyle(style, scale);
  return {
    fontSize,
    strokeWidth,
    chrome,
    position,
    x: clampStylePercent(style.x ?? 50, 5, 95),
    y: clampStylePercent(style.y ?? 90, 2, 98),
    align: position.textAlign,
    fontFamily: style.fontFamily || "Malgun Gothic",
    fontWeight: style.fontWeight || 700,
    textColor: style.textColor || "#ffffff",
    strokeColor: style.strokeColor || "#000000",
    background: parseBgRgba(style),
    marginPct: PREVIEW_SUBTITLE_SIDE_MARGIN_PCT,
  };
}

function ensureCaptureHost(w, h) {
  if (!captureHostRoot) {
    captureHostRoot = document.createElement("div");
    captureHostRoot.id = "as-export-capture-host";
    captureHostRoot.setAttribute("aria-hidden", "true");
    captureHostRoot.style.cssText =
      "position:fixed;left:-32000px;top:0;overflow:hidden;pointer-events:none;visibility:visible;z-index:-1;";
    document.body.appendChild(captureHostRoot);
  }
  captureHostRoot.style.width = `${w}px`;
  captureHostRoot.style.height = `${h}px`;
  captureHostRoot.replaceChildren();
  return captureHostRoot;
}

function parsePaddingBox(cs) {
  return {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
}

function formatPaddingBox(pad) {
  return `${pad.top}px ${pad.right}px ${pad.bottom}px ${pad.left}px`;
}

/**
 * foreignObject는 flex 세로 중앙이 깨지므로, 프리뷰 박스 기준 텍스트 블록을 패딩으로 중앙 맞춤.
 * @param {HTMLElement} inner
 * @param {DOMRect} hostRect
 * @param {DOMRect} box
 */
function computeCenteredPaddingBox(inner, hostRect, box) {
  const pad = parsePaddingBox(getComputedStyle(inner));
  const relY = box.top - hostRect.top;
  const lines = collectTextLines(inner, hostRect);
  if (!lines.length) return pad;

  const textTop = lines[0].top - hostRect.top;
  const textBottom =
    lines[lines.length - 1].top + lines[lines.length - 1].height - hostRect.top;
  const textCenter = (textTop + textBottom) / 2;
  const boxCenter = relY + box.height / 2;
  const shift = boxCenter - textCenter;

  return {
    top: Math.max(0, pad.top + shift),
    right: pad.right,
    bottom: Math.max(0, pad.bottom - shift),
    left: pad.left,
  };
}

function escapeExportMarkupText(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Export 전용 — 프리뷰 layout 스냅샷을 foreignObject에 반영 (flex 금지: SVG에서 세로 중앙 깨짐).
 * @param {HTMLElement} inner
 * @param {DOMRect} hostRect
 */
function buildExportCaptureInnerMarkup(inner, hostRect) {
  const box = inner.getBoundingClientRect();
  const relX = box.left - hostRect.left;
  const relY = box.top - hostRect.top;
  const cs = getComputedStyle(inner);
  const stroke =
    inner.style.webkitTextStroke ||
    `${cs.webkitTextStrokeWidth || "0px"} ${cs.webkitTextStrokeColor || "transparent"}`.trim();
  const bg = inner.style.background || cs.background;
  const padding = formatPaddingBox(computeCenteredPaddingBox(inner, hostRect, box));
  const display = cs.display === "inline-flex" || cs.display === "flex" ? "inline-block" : cs.display;

  return `<div style="
      position:absolute;
      left:${relX}px;
      top:${relY}px;
      width:${box.width}px;
      height:${box.height}px;
      display:${display};
      box-sizing:${cs.boxSizing};
      text-align:${cs.textAlign};
      font-family:${cs.fontFamily};
      font-size:${cs.fontSize};
      font-weight:${cs.fontWeight};
      color:${cs.color};
      -webkit-text-stroke:${stroke};
      paint-order:${cs.paintOrder || "stroke fill"};
      background:${bg};
      padding:${padding};
      line-height:${cs.lineHeight};
      border-radius:${cs.borderRadius};
      border:${inner.style.border || cs.border};
      word-break:${cs.wordBreak};
      overflow-wrap:${cs.overflowWrap};
      white-space:${cs.whiteSpace};
      max-width:${cs.maxWidth};
    ">${escapeExportMarkupText(inner.textContent)}</div>`;
}

/**
 * 프리뷰 updatePreviewOverlay()와 동일한 인라인 스타일로 export 캡처용 DOM 생성.
 */
function mountSubtitleOnHost(host, text, st) {
  const inner = document.createElement("div");
  inner.className = "as-preview-overlay-inner";
  inner.textContent = normalizePreviewSubtitleText(text);
  const pos = st.position;
  inner.style.cssText = `
    position: absolute;
    top: ${pos.top};
    left: ${pos.left};
    right: ${pos.right};
    transform: ${pos.transform};
    text-align: ${pos.textAlign};
    display: inline-block;
    font-family: ${JSON.stringify(st.fontFamily)}, "Malgun Gothic", sans-serif;
    font-size: ${st.fontSize}px;
    font-weight: ${st.fontWeight};
    color: ${st.textColor};
    -webkit-text-stroke: ${st.strokeWidth}px ${st.strokeColor};
    paint-order: stroke fill;
    background: ${st.background};
    padding: ${st.chrome.padding};
    line-height: ${st.chrome.lineHeight};
    border-radius: ${st.chrome.borderRadius}px;
    border: ${st.chrome.border};
    box-sizing: ${st.chrome.boxSizing};
    word-break: keep-all;
    overflow-wrap: normal;
  `;
  host.appendChild(inner);
  applySubtitleOverlayTextLayout(inner, host, st.marginPct);
  return inner;
}

/**
 * SVG foreignObject — layout된 inner computed style 스냅샷 + 배경 박스 내 세로 중앙.
 */
async function captureViaForeignObject(host, inner, st, w, h) {
  const sw = w * CAPTURE_SCALE;
  const sh = h * CAPTURE_SCALE;

  const hostRect = host.getBoundingClientRect();
  const innerMarkup = buildExportCaptureInnerMarkup(inner, hostRect);

  const wrapperHtml = `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;position:relative;overflow:hidden;">${innerMarkup}</div>`;

  const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="${sw}" height="${sh}" viewBox="0 0 ${w} ${h}">
    <foreignObject width="100%" height="100%">${wrapperHtml}</foreignObject>
  </svg>`;

  const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const img = new Image();
  img.width = sw;
  img.height = sh;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("SVG foreignObject 렌더 실패"));
    img.src = url;
  });
  URL.revokeObjectURL(url);

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) throw new Error("canvas 2d unavailable");
  ctx.clearRect(0, 0, sw, sh);
  ctx.drawImage(img, 0, 0, sw, sh);

  const outCanvas = document.createElement("canvas");
  outCanvas.width = w;
  outCanvas.height = h;
  const octx = outCanvas.getContext("2d", { alpha: true });
  if (!octx) throw new Error("canvas 2d unavailable");
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(canvas, 0, 0, w, h);
  return outCanvas;
}

function collectTextLines(inner, hostRect) {
  const textNode = inner.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    const t = String(inner.textContent || "").trim();
    if (!t) return [];
    const box = inner.getBoundingClientRect();
    return [
      {
        text: t,
        left: box.left - hostRect.left,
        top: box.top - hostRect.top,
        height: box.height,
      },
    ];
  }

  const text = textNode.textContent || "";
  if (!text) return [];

  const range = document.createRange();
  const lineMap = new Map();

  for (let i = 0; i < text.length; i += 1) {
    range.setStart(textNode, i);
    range.setEnd(textNode, i + 1);
    const rects = range.getClientRects();
    if (!rects.length) continue;
    const r = rects[0];
    const key = Math.round(r.top * 10);
    if (!lineMap.has(key)) {
      lineMap.set(key, { top: r.top, left: r.left, bottom: r.bottom, chars: [] });
    }
    const line = lineMap.get(key);
    line.chars.push(text[i]);
    line.left = Math.min(line.left, r.left);
    line.bottom = Math.max(line.bottom, r.bottom);
  }

  return Array.from(lineMap.values())
    .sort((a, b) => a.top - b.top)
    .map((line) => ({
      text: line.chars.join(""),
      left: line.left - hostRect.left,
      top: line.top - hostRect.top,
      height: line.bottom - line.top,
    }));
}

/**
 * Canvas 직접 그리기 (foreignObject 실패 시 fallback).
 * 프리뷰와 동일한 스타일 속성으로 그립니다.
 */
function drawSubtitleOnCanvas(inner, st, hostRect, ctx) {
  const box = inner.getBoundingClientRect();
  const relX = box.left - hostRect.left;
  const relY = box.top - hostRect.top;
  const radius = st.chrome.borderRadius || 0;

  ctx.save();
  ctx.fillStyle = st.background;
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(relX, relY, box.width, box.height, radius);
    ctx.fill();
  } else {
    ctx.fillRect(relX, relY, box.width, box.height);
  }

  const font = `${st.fontWeight} ${st.fontSize}px ${JSON.stringify(st.fontFamily)}, "Malgun Gothic", sans-serif`;
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const lines = collectTextLines(inner, hostRect);
  if (!lines.length) {
    ctx.restore();
    return;
  }

  const textTop = lines[0].top;
  const last = lines[lines.length - 1];
  const textBottom = last.top + last.height;
  const textBlockH = textBottom - textTop;
  const yOffset = relY + box.height / 2 - (textTop + textBlockH / 2);

  for (const line of lines) {
    const metrics = ctx.measureText(line.text);
    const ascent = metrics.actualBoundingBoxAscent || st.fontSize * 0.82;
    const x = line.left;
    const y = line.top + ascent + yOffset;

    if (st.strokeWidth > 0) {
      ctx.lineWidth = st.strokeWidth * 2;
      ctx.strokeStyle = st.strokeColor;
      ctx.strokeText(line.text, x, y);
    }
    ctx.fillStyle = st.textColor;
    ctx.fillText(line.text, x, y);
  }

  ctx.restore();
}

async function captureViaCanvasFallback(host, inner, st, w, h) {
  const ss = CAPTURE_SCALE;
  const sw = w * ss;
  const sh = h * ss;
  const hostRect = host.getBoundingClientRect();

  const hi = document.createElement("canvas");
  hi.width = sw;
  hi.height = sh;
  const hctx = hi.getContext("2d", { alpha: true });
  if (!hctx) throw new Error("canvas 2d unavailable");
  hctx.clearRect(0, 0, sw, sh);
  hctx.scale(ss, ss);
  drawSubtitleOnCanvas(inner, st, hostRect, hctx);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) throw new Error("canvas 2d unavailable");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(hi, 0, 0, w, h);
  return canvas;
}

/**
 * @param {string} text
 * @param {object} style
 * @param {number} renderW
 * @param {number} renderH
 */
export async function captureSubtitleFramePng(text, style, renderW, renderH) {
  const st = buildExportSubtitleInnerStyle(style, renderW, renderH);
  const families = [st.fontFamily, "Malgun Gothic", "sans-serif"].filter(Boolean);
  for (const fam of families) {
    try {
      await document.fonts.load(`${st.fontWeight} ${st.fontSize}px "${fam}"`);
    } catch {
      /* ignore */
    }
  }
  await document.fonts.ready;
  const host = ensureCaptureHost(renderW, renderH);
  const inner = mountSubtitleOnHost(host, text, st);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  let canvas;
  try {
    canvas = await captureViaForeignObject(host, inner, st, renderW, renderH);
  } catch {
    canvas = await captureViaCanvasFallback(host, inner, st, renderW, renderH);
  }

  const pngBlob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG 변환 실패"))), "image/png");
  });
  return new Uint8Array(await /** @type {Blob} */ (pngBlob).arrayBuffer());
}

/**
 * @param {readonly { start: number, end: number, text: string }[]} schedule
 * @param {object} style
 * @param {number} renderW
 * @param {number} renderH
 * @param {(done: number, total: number) => void} [onProgress]
 */
export async function captureSubtitleFrameSequence(schedule, style, renderW, renderH, onProgress) {
  const frames = [];
  const total = schedule.length;
  if (!total) return frames;
  for (let i = 0; i < total; i += 1) {
    const seg = schedule[i];
    const png = await captureSubtitleFramePng(String(seg.text || ""), style, renderW, renderH);
    frames.push({
      index: i,
      start: seg.start,
      end: seg.end,
      png,
    });
    onProgress?.(i + 1, total);
  }
  return frames;
}
