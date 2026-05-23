/**
 * AutoSubtitle waveformCanvasDrawing.ts — 단어 컨텍스트 파형 실루엣.
 */

import { mediaSecToPeakPixelIndex } from "./peaks-metrics.js?v=16";
import { getCueWords } from "./subtitle-words.js";
import { wordIsDeleted } from "./shared/subtitles.js";

/** @typedef {'outside' | 'neighbor' | 'selection'} WaveformFillKind */
/** @typedef {{ start: number, end: number, kind: WaveformFillKind }} WaveformFillBand */

const FILL_COLOR = {
  selection: "rgba(255, 216, 77, 0.88)",
  neighbor: "rgba(255, 255, 255, 0.45)",
  active: "rgba(255, 255, 255, 0.72)",
  dim: "rgba(255, 255, 255, 0.28)",
  muted: "rgba(51, 65, 85, 0.32)",
};

const OUTLINE_COLOR = {
  selection: "rgba(255, 232, 132, 1)",
  neighbor: "rgba(255, 255, 255, 0.82)",
  active: "rgba(255, 255, 255, 1)",
  dim: "rgba(255, 255, 255, 0.55)",
  muted: "rgba(100, 116, 139, 0.55)",
};

/**
 * @param {readonly { start: number, end: number, is_deleted?: boolean, isDeleted?: boolean }[]} words
 * @param {number} winStart
 * @param {number} winEnd
 */
export function collectDeletedRangesSec(words, winStart, winEnd) {
  /** @type {Array<{ start: number, end: number }>} */
  const out = [];
  if (!(winEnd > winStart)) return out;
  for (const w of words) {
    if (!wordIsDeleted(w)) continue;
    const a = Math.min(w.start, w.end);
    const b = Math.max(w.start, w.end);
    const s = Math.max(winStart, a);
    const e = Math.min(winEnd, b);
    if (e > s + 1e-9) out.push({ start: s, end: e });
  }
  return out;
}

/**
 * @param {number} t
 * @param {readonly WaveformFillBand[]} bands
 */
function pickFillKind(t, bands) {
  let best = "outside";
  let pr = 0;
  for (const b of bands) {
    if (t < b.start || t > b.end) continue;
    const p = b.kind === "selection" ? 3 : b.kind === "neighbor" ? 2 : 1;
    if (p > pr) {
      pr = p;
      best = b.kind;
    }
  }
  return best;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ data: readonly number[], pixelCount: number, durationSec: number }} metrics
 * @param {number} winStart
 * @param {number} winEnd
 * @param {Array<{ start: number, end: number }>} deletedRanges
 * @param {readonly WaveformFillBand[] | null} fillBands
 * @param {{ heightCssPx?: number, topPaddingPx?: number, gain?: number, background?: string, meanVolumeDb?: number, skipMapping?: { pixelToMediaSec: (x: number, w: number) => number } | null }} [opts]
 */
export function drawWordContextWaveform(
  canvas,
  metrics,
  winStart,
  winEnd,
  deletedRanges,
  fillBands,
  opts = {},
) {
  const { data } = metrics;
  const dpr = window.devicePixelRatio || 1;
  const heightCssPx = opts.heightCssPx ?? (canvas.clientHeight || 88);
  const wPx = Math.max(1, Math.floor((canvas.clientWidth || 320) * dpr));
  const hPx = Math.max(1, Math.floor(heightCssPx * dpr));
  if (canvas.width !== wPx) canvas.width = wPx;
  if (canvas.height !== hPx) canvas.height = hPx;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = opts.background || "#0b0e15";
  ctx.fillRect(0, 0, wPx, hPx);

  const span = Math.max(winEnd - winStart, 1e-9);
  const skipMapping = opts.skipMapping ?? null;
  const topPadPx = Math.max(0, Math.floor((opts.topPaddingPx ?? 4) * dpr));
  const drawTop = topPadPx;
  const drawBottom = hPx;
  const drawH = Math.max(2, drawBottom - drawTop);
  const midY = drawTop + drawH * 0.5;
  const halfH = drawH * 0.5;
  const gain = Math.max(0.1, opts.gain ?? 1.15);
  const ampScale = halfH * 0.92 * gain;
  const minBarPx = Math.max(1, Math.round(dpr));
  const useBands = Array.isArray(fillBands) && fillBands.length > 0;

  const topY = new Float32Array(wPx);
  const botY = new Float32Array(wPx);
  /** @type {Array<keyof typeof FILL_COLOR>} */
  const kindAt = new Array(wPx);

  for (let x = 0; x < wPx; x += 1) {
    const t = skipMapping
      ? skipMapping.pixelToMediaSec(x + 0.5, wPx)
      : winStart + ((x + 0.5) / wPx) * span;
    const pi = mediaSecToPeakPixelIndex(metrics, t);
    const i = pi * 2;
    const mn = (data[i] ?? 0) / 127;
    const mx = (data[i + 1] ?? 0) / 127;
    let y1 = midY + Math.min(mn, mx) * ampScale;
    let y2 = midY + Math.max(mn, mx) * ampScale;
    if (y2 - y1 < minBarPx) {
      const cy = (y1 + y2) * 0.5;
      y1 = cy - minBarPx * 0.5;
      y2 = cy + minBarPx * 0.5;
    }
    topY[x] = Math.min(drawBottom, Math.max(drawTop, y1));
    botY[x] = Math.min(drawBottom, Math.max(drawTop, y2));

    let muted = false;
    if (!skipMapping) {
      for (const r of deletedRanges) {
        if (t >= r.start && t < r.end) {
          muted = true;
          break;
        }
      }
    }
    let k;
    if (muted) {
      k = "muted";
    } else if (useBands && fillBands) {
      const bk = pickFillKind(t, fillBands);
      k = bk === "selection" ? "selection" : bk === "neighbor" ? "neighbor" : "dim";
    } else {
      k = "active";
    }
    kindAt[x] = k;
  }

  /** @type {Array<{ x0: number, x1: number, kind: keyof typeof FILL_COLOR }>} */
  const regions = [];
  let curKind = kindAt[0];
  let curX0 = 0;
  for (let x = 1; x < wPx; x += 1) {
    if (kindAt[x] !== curKind) {
      regions.push({ x0: curX0, x1: x, kind: curKind });
      curKind = kindAt[x];
      curX0 = x;
    }
  }
  regions.push({ x0: curX0, x1: wPx, kind: curKind });

  const envelope = new Path2D();
  envelope.moveTo(0.5, topY[0]);
  for (let x = 1; x < wPx; x += 1) envelope.lineTo(x + 0.5, topY[x]);
  for (let x = wPx - 1; x >= 0; x -= 1) envelope.lineTo(x + 0.5, botY[x]);
  envelope.closePath();

  for (const r of regions) {
    if (r.x1 <= r.x0) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x0, 0, r.x1 - r.x0, hPx);
    ctx.clip();
    ctx.fillStyle = FILL_COLOR[r.kind];
    ctx.fill(envelope);
    ctx.restore();
  }

  ctx.lineWidth = Math.max(1, dpr);
  ctx.lineJoin = "round";
  for (const r of regions) {
    if (r.x1 <= r.x0) continue;
    ctx.strokeStyle = OUTLINE_COLOR[r.kind];
    ctx.beginPath();
    ctx.moveTo(r.x0 + 0.5, topY[r.x0]);
    for (let x = r.x0 + 1; x < r.x1; x += 1) ctx.lineTo(x + 0.5, topY[x]);
    ctx.stroke();
  }
}

/**
 * @param {import("./subtitle-words.js").SubtitleCue} cue
 * @param {number} centerVisibleIndex visible words 배열 기준
 * @param {number} winStart
 * @param {number} winEnd
 * @returns {WaveformFillBand[] | null}
 */
export function buildWordFillBands(cue, centerVisibleIndex, winStart, winEnd) {
  const all = getCueWords(cue);
  const activeWords = [];
  for (const w of all) {
    if (wordIsDeleted(w)) continue;
    activeWords.push(w);
  }
  if (centerVisibleIndex < 0 || centerVisibleIndex >= activeWords.length) return null;

  const ws = Math.min(winStart, winEnd);
  const we = Math.max(winStart, winEnd);
  /** @type {WaveformFillBand[]} */
  const bands = [];

  if (centerVisibleIndex > 0) {
    const nw = activeWords[centerVisibleIndex - 1];
    const a = Math.min(nw.start, nw.end);
    const b = Math.max(nw.start, nw.end);
    if (b > ws + 1e-9 && a < we - 1e-9) {
      bands.push({ start: Math.max(ws, a), end: Math.min(we, b), kind: "neighbor" });
    }
  }
  if (centerVisibleIndex < activeWords.length - 1) {
    const nw = activeWords[centerVisibleIndex + 1];
    const a = Math.min(nw.start, nw.end);
    const b = Math.max(nw.start, nw.end);
    if (b > ws + 1e-9 && a < we - 1e-9) {
      bands.push({ start: Math.max(ws, a), end: Math.min(we, b), kind: "neighbor" });
    }
  }
  const cw = activeWords[centerVisibleIndex];
  const es = Math.min(cw.start, cw.end);
  const ee = Math.max(cw.start, cw.end);
  bands.push({
    start: Math.max(ws, es),
    end: Math.min(we, ee),
    kind: "selection",
  });
  return bands;
}

/**
 * 트림 미리보기 — selection 밴드는 `editRange` 기준.
 *
 * @param {import("./subtitle-words.js").SubtitleCue} cue
 * @param {number} centerVisibleIndex
 * @param {{ start: number, end: number }} editRange
 * @param {number} winStart
 * @param {number} winEnd
 */
export function buildWordFillBandsFromEditRange(
  cue,
  centerVisibleIndex,
  editRange,
  winStart,
  winEnd,
) {
  const base = buildWordFillBands(cue, centerVisibleIndex, winStart, winEnd);
  if (!base) return null;
  const ws = Math.min(winStart, winEnd);
  const we = Math.max(winStart, winEnd);
  const es = Math.min(editRange.start, editRange.end);
  const ee = Math.max(editRange.start, editRange.end);
  const filtered = base.filter((b) => b.kind !== "selection");
  filtered.push({
    start: Math.max(ws, es),
    end: Math.min(we, ee),
    kind: "selection",
  });
  return filtered;
}
