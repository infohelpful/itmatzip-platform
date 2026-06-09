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

/**
 * 프리뷰와 동일한 인라인 스타일로 자막 요소를 생성합니다.
 * updatePreviewOverlay()와 완전히 동일한 CSS 속성을 사용합니다.
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
 * SVG foreignObject를 사용하여 DOM을 Canvas로 캡처합니다.
 * -webkit-text-stroke가 foreignObject에서 작동하지 않으므로,
 * Canvas에서 stroke를 별도로 그립니다.
 */
async function captureViaForeignObject(host, inner, st, w, h) {
  const sw = w * CAPTURE_SCALE;
  const sh = h * CAPTURE_SCALE;

  const innerBox = inner.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  const relX = innerBox.left - hostRect.left;
  const relY = innerBox.top - hostRect.top;

  const wrapperHtml = `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;position:relative;overflow:hidden;">
    <div style="
      position:absolute;
      left:${relX}px;
      top:${relY}px;
      width:${innerBox.width}px;
      text-align:${st.align};
      font-family:${JSON.stringify(st.fontFamily)}, 'Malgun Gothic', sans-serif;
      font-size:${st.fontSize}px;
      font-weight:${st.fontWeight};
      color:${st.textColor};
      background:${st.background};
      padding:${st.chrome.padding};
      line-height:${st.chrome.lineHeight};
      border-radius:${st.chrome.borderRadius}px;
      border:${st.chrome.border};
      box-sizing:${st.chrome.boxSizing};
      word-break:keep-all;
      overflow-wrap:normal;
      white-space:normal;
    ">${inner.textContent.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
  </div>`;

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

  if (st.strokeWidth > 0) {
    drawStrokeLayer(inner, st, hostRect, ctx, CAPTURE_SCALE);
  }

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

/**
 * stroke 레이어만 Canvas에 직접 그리기 (foreignObject에서 text-stroke 비호환 우회).
 */
function drawStrokeLayer(inner, st, hostRect, ctx, scale) {
  const lines = collectTextLines(inner, hostRect);
  const font = `${st.fontWeight} ${st.fontSize * scale}px ${JSON.stringify(st.fontFamily)}, "Malgun Gothic", sans-serif`;
  ctx.save();
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = st.strokeWidth * scale * 2;
  ctx.strokeStyle = st.strokeColor;
  ctx.globalCompositeOperation = "destination-over";

  for (const line of lines) {
    const metrics = ctx.measureText(line.text);
    const ascent = metrics.actualBoundingBoxAscent || st.fontSize * scale * 0.82;
    const x = line.left * scale;
    const y = line.top * scale + ascent;
    ctx.strokeText(line.text, x, y);
  }
  ctx.restore();
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
  for (const line of lines) {
    const metrics = ctx.measureText(line.text);
    const ascent = metrics.actualBoundingBoxAscent || st.fontSize * 0.82;
    const x = line.left;
    const y = line.top + ascent;

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
