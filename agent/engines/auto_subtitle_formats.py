"""자막 파일 형식(SRT·VTT·ASS·TXT) 생성 — AutoSubtitle TS 로직 포팅."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


@dataclass
class CutRange:
    start: float
    end: float


@dataclass
class MappedCue:
    start: float
    end: float
    text: str


@dataclass
class SubtitleStyle:
    font_family: str = "Malgun Gothic"
    font_size: int = 26
    text_color: str = "#f4f6fb"
    font_weight: int = 700
    bg_color: str = "#080a10"
    bg_opacity: float = 62.0
    bg_padding_pct: float = 100.0
    stroke_color: str = "#000000"
    stroke_width: float = 2.0
    x: float = 50.0
    y: float = 10.0
    video_width: int | None = None
    video_height: int | None = None

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> SubtitleStyle:
        if not raw:
            return cls()
        return cls(
            font_family=str(raw.get("fontFamily") or raw.get("font_family") or "Malgun Gothic"),
            font_size=int(raw.get("fontSize") or raw.get("font_size") or 26),
            text_color=str(raw.get("textColor") or raw.get("text_color") or "#f4f6fb"),
            font_weight=int(raw.get("fontWeight") or raw.get("font_weight") or 700),
            bg_color=str(raw.get("bgColor") or raw.get("bg_color") or "#080a10"),
            bg_opacity=float(raw.get("bgOpacity") or raw.get("bg_opacity") or 62),
            stroke_color=str(raw.get("strokeColor") or raw.get("stroke_color") or "#000000"),
            stroke_width=float(raw.get("strokeWidth") or raw.get("stroke_width") or 2),
            x=float(raw.get("x") or 50),
            y=float(raw.get("y") or 10),
            video_width=_optional_int(raw.get("videoWidth") or raw.get("video_width")),
            video_height=_optional_int(raw.get("videoHeight") or raw.get("video_height")),
        )


def _optional_int(v: Any) -> int | None:
    try:
        n = int(v)
        return n if n > 0 else None
    except (TypeError, ValueError):
        return None


def normalize_cut_ranges(ranges: list[dict[str, Any]] | None) -> list[CutRange]:
    if not ranges:
        return []
    sorted_ranges: list[CutRange] = []
    for item in ranges:
        try:
            start = float(item.get("start", 0))
            end = float(item.get("end", 0))
        except (TypeError, ValueError):
            continue
        if end <= start:
            continue
        sorted_ranges.append(CutRange(start=max(0.0, start), end=max(0.0, end)))
    sorted_ranges.sort(key=lambda r: r.start)
    if len(sorted_ranges) <= 1:
        return sorted_ranges
    out = [sorted_ranges[0]]
    for cur in sorted_ranges[1:]:
        last = out[-1]
        if cur.start <= last.end + 0.001:
            last.end = max(last.end, cur.end)
        else:
            out.append(cur)
    return out


def remap_time_by_cuts(sec: float, cuts: list[CutRange]) -> float:
    shift = 0.0
    for c in cuts:
        if sec >= c.end:
            shift += c.end - c.start
        elif sec > c.start:
            shift += sec - c.start
        else:
            break
    return max(0.0, sec - shift)


def cues_to_mapped(
    cues: list[dict[str, Any]],
    *,
    cut_ranges: list[dict[str, Any]] | None = None,
) -> list[MappedCue]:
    cuts = normalize_cut_ranges(cut_ranges)
    out: list[MappedCue] = []
    for item in cues:
        if item.get("is_silence"):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        start = float(item.get("start", 0))
        end = float(item.get("end", start))
        if cuts:
            start = remap_time_by_cuts(start, cuts)
            end = remap_time_by_cuts(end, cuts)
        if end <= start + 0.01:
            continue
        out.append(MappedCue(start=start, end=end, text=text))
    return normalize_mapped(out)


def normalize_mapped(subtitles: list[MappedCue]) -> list[MappedCue]:
    if len(subtitles) <= 1:
        return subtitles
    sorted_subs = sorted(subtitles, key=lambda s: (s.start, s.end))
    out: list[MappedCue] = []
    for cur in sorted_subs:
        text = cur.text.strip()
        if not text:
            continue
        if not out:
            if cur.end > cur.start + 0.02:
                out.append(MappedCue(cur.start, cur.end, text))
            continue
        last = out[-1]
        next_start = max(cur.start, last.end + 0.01)
        if cur.end <= next_start + 0.01:
            continue
        out.append(MappedCue(next_start, cur.end, text))
    return out


def format_srt_timestamp(sec: float) -> str:
    s = max(0.0, float(sec) if sec == sec else 0.0)
    hh = int(s // 3600)
    mm = int((s % 3600) // 60)
    ss = int(s % 60)
    ms = int((s - int(s)) * 1000)
    return f"{hh:02d}:{mm:02d}:{ss:02d},{ms:03d}"


def format_webvtt_timestamp(sec: float) -> str:
    s = max(0.0, float(sec) if sec == sec else 0.0)
    hh = int(s // 3600)
    mm = int((s % 3600) // 60)
    whole = int(s % 60)
    frac = s - int(s)
    ms = int(frac * 1000)
    return f"{hh:02d}:{mm:02d}:{whole:02d}.{ms:03d}"


def format_ass_timestamp(sec: float) -> str:
    s = max(0.0, float(sec) if sec == sec else 0.0)
    hh = int(s // 3600)
    mm = int((s % 3600) // 60)
    ss = int(s % 60)
    cs = int((s - int(s)) * 100)
    return f"{hh}:{mm:02d}:{ss:02d}.{cs:02d}"


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    clean = hex_color.replace("#", "").strip()
    norm = clean if len(clean) != 3 else "".join(c * 2 for c in clean)
    if not re.fullmatch(r"[0-9a-fA-F]{6}", norm):
        return 255, 255, 255
    n = int(norm, 16)
    return (n >> 16) & 255, (n >> 8) & 255, n & 255


def to_ass_color(hex_color: str, opacity_pct: float = 100.0) -> str:
    r, g, b = _hex_to_rgb(hex_color)
    alpha = round(255 * (1 - max(0.0, min(1.0, opacity_pct / 100.0))))
    return f"&H{alpha:02X}{b:02X}{g:02X}{r:02X}"


def escape_ass_text(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace("{", "\\{")
        .replace("}", "\\}")
        .replace("\r\n", "\\N")
        .replace("\n", "\\N")
    )


def escape_webvtt_text(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_srt_ssa_alignment_prefix(style: SubtitleStyle | None) -> str:
    base = "{\\an2}"
    if not style or not style.video_width or not style.video_height:
        return base
    w, h = style.video_width, style.video_height
    if w < 160 or h < 120:
        return base
    x_pct = max(5.0, min(95.0, style.x))
    y_pct = max(2.0, min(98.0, style.y))
    cx = round((w * x_pct) / 100)
    cy = round(h * (1 - y_pct / 100))
    return f"{{\\an2\\pos({cx},{cy})}}"


def build_srt_text(subtitles: list[MappedCue], style: SubtitleStyle | None = None) -> str:
    prefix = build_srt_ssa_alignment_prefix(style)
    lines: list[str] = []
    for i, item in enumerate(subtitles, start=1):
        lines.append(str(i))
        lines.append(f"{format_srt_timestamp(item.start)} --> {format_srt_timestamp(item.end)}")
        body = item.text.strip()
        lines.append(f"{prefix}{body}" if prefix else body)
        lines.append("")
    return "\n".join(lines)


def build_webvtt_text(subtitles: list[MappedCue], style: SubtitleStyle | None = None) -> str:
    x_pct = max(5.0, min(95.0, (style.x if style else 50.0)))
    y_from_bottom = max(2.0, min(98.0, (style.y if style else 10.0)))
    line_from_top = max(0.0, min(100.0, 100.0 - y_from_bottom))
    cues: list[str] = []
    for i, item in enumerate(subtitles, start=1):
        settings = f"align:center position:{x_pct:.0f}% line:{line_from_top:.0f}%"
        body = escape_webvtt_text(item.text.strip())
        cues.append(
            f"{i}\n{format_webvtt_timestamp(item.start)} --> {format_webvtt_timestamp(item.end)} {settings}\n{body}"
        )
    return "WEBVTT\n\n" + "\n\n".join(cues) + "\n"


def build_txt_text(subtitles: list[MappedCue]) -> str:
    parts: list[str] = []
    for item in subtitles:
        flat = re.sub(r"\s+", " ", item.text.replace("\r\n", " ").replace("\n", " ")).strip()
        if flat:
            parts.append(flat)
    return " ".join(parts)


def build_ass_text(subtitles: list[MappedCue], style: SubtitleStyle | None = None) -> str:
    st = style or SubtitleStyle()
    play_res_x = max(320, int(st.video_width or 1920))
    play_res_y = max(240, int(st.video_height or 1080))
    font_family = st.font_family.replace(",", " ")
    font_size = max(8, int(st.font_size))
    bold = -1 if st.font_weight >= 600 else 0
    outline = max(0, int(st.stroke_width))
    primary = to_ass_color(st.text_color, 100)
    stroke_color = to_ass_color(st.stroke_color, 100)
    bg_opacity = max(0.0, min(100.0, st.bg_opacity))
    back_color = to_ass_color(st.bg_color, bg_opacity)
    border_style = 3 if bg_opacity > 0 else 1
    outline_color = back_color if border_style == 3 else stroke_color
    applied_outline = max(1, round(max(1, outline))) if border_style == 3 else outline
    margin_h = round(play_res_x * 0.05)

    header = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {play_res_x}",
        f"PlayResY: {play_res_y}",
        "ScaledBorderAndShadow: yes",
        "WrapStyle: 2",
        "",
        "[V4+ Styles]",
        "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,"
        "Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,"
        "Alignment,MarginL,MarginR,MarginV,Encoding",
        f"Style: Default,{font_family},{font_size},{primary},{primary},{outline_color},{back_color},"
        f"{bold},0,0,0,100,100,0,0,{border_style},{applied_outline},0,2,{margin_h},{margin_h},20,1",
        "",
        "[Events]",
        "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ]
    dialogues = [
        f"Dialogue: 0,{format_ass_timestamp(item.start)},{format_ass_timestamp(item.end)},"
        f"Default,,0,0,0,,{escape_ass_text(item.text)}"
        for item in subtitles
    ]
    return "\n".join(header + dialogues + [""])


TEXT_EXPORT_FORMATS = frozenset({"srt", "vtt", "ass", "txt"})


def build_text_export(
    fmt: str,
    cues: list[dict[str, Any]],
    *,
    cut_ranges: list[dict[str, Any]] | None = None,
    style: dict[str, Any] | None = None,
) -> str:
    mapped = cues_to_mapped(cues, cut_ranges=cut_ranges)
    st = SubtitleStyle.from_dict(style)
    key = fmt.lower().strip()
    if key == "srt":
        return build_srt_text(mapped, st)
    if key == "vtt":
        return build_webvtt_text(mapped, st)
    if key == "ass":
        return build_ass_text(mapped, st)
    if key == "txt":
        return build_txt_text(mapped)
    raise ValueError(f"unsupported text format: {fmt}")
