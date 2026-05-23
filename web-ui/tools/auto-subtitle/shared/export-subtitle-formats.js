/**
 * AutoSubtitle index.ts — SRT/VTT/ASS/TXT + 컷 반영 매핑 (웹 SSOT).
 */

import { mergeCutRanges } from "./timeline-collapse.js";

/** @typedef {{ start: number, end: number, text: string }} MappedCue */
/** @typedef {{ start: number, end: number }} CutRange */

/**
 * @param {readonly CutRange[]} ranges
 */
export function normalizeCutRangesForExport(ranges) {
  return mergeCutRanges(
    (ranges || [])
      .map((r) => ({
        start: Math.max(0, Number(r.start) || 0),
        end: Math.max(0, Number(r.end) || 0),
      }))
      .filter((r) => r.end > r.start),
  );
}

/**
 * @param {number} sec
 * @param {readonly CutRange[]} cuts
 */
export function remapTimeByCuts(sec, cuts) {
  let shift = 0;
  for (const c of cuts) {
    if (sec >= c.end) shift += c.end - c.start;
    else if (sec > c.start) shift += sec - c.start;
    else break;
  }
  return Math.max(0, sec - shift);
}

/**
 * @param {readonly { start: number, end: number, text?: string, is_silence?: boolean }[]} subtitles
 * @param {readonly CutRange[]} cuts
 * @returns {MappedCue[]}
 */
export function buildMappedSubtitles(subtitles, cuts) {
  const merged = normalizeCutRangesForExport(cuts);
  /** @type {MappedCue[]} */
  const out = [];
  for (const item of subtitles || []) {
    if (item.is_silence) continue;
    const text = String(item.text ?? "").trim();
    if (!text) continue;
    let start = Number(item.start);
    let end = Number(item.end);
    if (merged.length) {
      start = remapTimeByCuts(start, merged);
      end = remapTimeByCuts(end, merged);
    }
    if (!(end > start + 0.01)) continue;
    out.push({ start, end, text });
  }
  return normalizeMappedSubtitles(out);
}

/**
 * @param {MappedCue[]} subtitles
 */
export function normalizeMappedSubtitles(subtitles) {
  if (subtitles.length <= 1) return subtitles;
  const sorted = [...subtitles].sort((a, b) => a.start - b.start || a.end - b.end);
  /** @type {MappedCue[]} */
  const out = [];
  for (const cur of sorted) {
    const text = cur.text.trim();
    if (!text) continue;
    if (!out.length) {
      if (cur.end > cur.start + 0.02) out.push({ ...cur, text });
      continue;
    }
    const last = out[out.length - 1];
    const nextStart = Math.max(cur.start, last.end + 0.01);
    if (cur.end <= nextStart + 0.01) continue;
    out.push({ start: nextStart, end: cur.end, text });
  }
  return out;
}

function toSrtTimestamp(sec) {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function toWebVttTimestamp(sec) {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const whole = Math.floor(s % 60);
  const ms = Math.floor((s - whole) * 1000);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function toAssTimestamp(sec) {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function hexToRgb(hex) {
  const clean = String(hex).replace("#", "").trim();
  const norm = clean.length === 3 ? [...clean].map((c) => c + c).join("") : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(norm)) return { r: 255, g: 255, b: 255 };
  const n = Number.parseInt(norm, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toAssColor(hex, opacityPct = 100) {
  const { r, g, b } = hexToRgb(hex);
  const alpha = Math.round(255 * (1 - Math.max(0, Math.min(1, opacityPct / 100))));
  const aa = alpha.toString(16).padStart(2, "0").toUpperCase();
  const bb = b.toString(16).padStart(2, "0").toUpperCase();
  const gg = g.toString(16).padStart(2, "0").toUpperCase();
  const rr = r.toString(16).padStart(2, "0").toUpperCase();
  return `&H${aa}${bb}${gg}${rr}`;
}

function escapeAssText(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\r\n/g, "\\N")
    .replace(/\n/g, "\\N");
}

function escapeWebVttText(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * @param {object | undefined} style
 */
function buildSrtSsaAlignmentPrefix(style) {
  const base = "{\\an2}";
  const w = style?.videoWidth;
  const h = style?.videoHeight;
  if (!w || !h || w < 160 || h < 120) return base;
  const xPct = Math.max(5, Math.min(95, Number(style?.x ?? 50)));
  const yPct = Math.max(2, Math.min(98, Number(style?.y ?? 10)));
  const cx = Math.round((w * xPct) / 100);
  const cy = Math.round(h * (1 - yPct / 100));
  return `{\\an2\\pos(${cx},${cy})}`;
}

/**
 * @param {MappedCue[]} subtitles
 * @param {object} [style]
 */
export function buildSrtText(subtitles, style) {
  const prefix = buildSrtSsaAlignmentPrefix(style);
  const lines = [];
  let cue = 1;
  for (const item of subtitles) {
    lines.push(String(cue));
    lines.push(`${toSrtTimestamp(item.start)} --> ${toSrtTimestamp(item.end)}`);
    const body = item.text.trim();
    lines.push(prefix ? `${prefix}${body}` : body);
    lines.push("");
    cue += 1;
  }
  return lines.join("\n");
}

/**
 * @param {MappedCue[]} subtitles
 * @param {object} [style]
 */
export function buildWebVttText(subtitles, style) {
  const xPct = Math.max(5, Math.min(95, Number(style?.x ?? 50)));
  const yFromBottom = Math.max(2, Math.min(98, Number(style?.y ?? 10)));
  const lineFromTop = Math.max(0, Math.min(100, 100 - yFromBottom));
  const cues = subtitles.map((item, i) => {
    const settings = `align:center position:${xPct}% line:${lineFromTop}%`;
    const body = escapeWebVttText(item.text.trim());
    return `${i + 1}\n${toWebVttTimestamp(item.start)} --> ${toWebVttTimestamp(item.end)} ${settings}\n${body}`;
  });
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

/**
 * @param {MappedCue[]} subtitles
 */
export function buildTxtText(subtitles) {
  const flatten = (s) => s.replace(/\r\n|\r|\n/g, " ").replace(/\s+/g, " ").trim();
  return subtitles
    .map((item) => flatten(item.text))
    .filter((t) => t.length > 0)
    .join(" ");
}

/**
 * @param {MappedCue[]} subtitles
 * @param {object} [style]
 */
export function buildAssText(subtitles, style) {
  const playResX = Math.max(320, Math.round(style?.videoWidth ?? 1920));
  const playResY = Math.max(240, Math.round(style?.videoHeight ?? 1080));
  const fontFamily = String(style?.fontFamily ?? "Malgun Gothic").replace(/,/g, " ");
  const fontSize = Math.max(8, Math.round(style?.fontSize ?? 26));
  const bold = (style?.fontWeight ?? 700) >= 600 ? -1 : 0;
  const outline = Math.max(0, Number(style?.strokeWidth ?? 2));
  const primary = toAssColor(style?.textColor ?? "#f4f6fb", 100);
  const strokeColor = toAssColor(style?.strokeColor ?? "#000000", 100);
  const bgOpacity = Math.max(0, Math.min(100, Number(style?.bgOpacity ?? 62)));
  const backColor = toAssColor(style?.bgColor ?? "#080a10", bgOpacity);
  const borderStyle = bgOpacity > 0 ? 3 : 1;
  const outlineColor = borderStyle === 3 ? backColor : strokeColor;
  const appliedOutline = borderStyle === 3 ? Math.max(1, Math.round(Math.max(1, outline))) : outline;
  const marginH = Math.round(playResX * 0.05);

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    `Style: Default,${fontFamily},${fontSize},${primary},${primary},${outlineColor},${backColor},${bold},0,0,0,100,100,0,0,${borderStyle},${appliedOutline},0,2,${marginH},${marginH},20,1`,
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
  ];
  const dialogues = subtitles.map(
    (item) =>
      `Dialogue: 0,${toAssTimestamp(item.start)},${toAssTimestamp(item.end)},Default,,0,0,0,,${escapeAssText(item.text)}`,
  );
  return [...header, ...dialogues, ""].join("\n");
}

export const TEXT_EXPORT_FORMATS = ["srt", "vtt", "ass", "txt"];

/**
 * @param {string} fmt
 * @param {readonly { start: number, end: number, text?: string, is_silence?: boolean }[]} cues
 * @param {readonly CutRange[]} cutRanges
 * @param {object} [style]
 */
export function buildTextExport(fmt, cues, cutRanges, style) {
  const mapped = buildMappedSubtitles(cues, cutRanges);
  const key = String(fmt).toLowerCase();
  if (key === "srt") return buildSrtText(mapped, style);
  if (key === "vtt") return buildWebVttText(mapped, style);
  if (key === "ass") return buildAssText(mapped, style);
  if (key === "txt") return buildTxtText(mapped);
  throw new Error(`unsupported text format: ${fmt}`);
}
