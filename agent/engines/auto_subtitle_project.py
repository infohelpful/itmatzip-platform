"""`.autosub` 프로젝트 파싱·정규화."""

from __future__ import annotations

from typing import Any

AUTOSUB_FILE_FORMAT = "autosubtitle-project"
AUTOSUB_VERSION = 1


def _is_record(x: Any) -> bool:
    return isinstance(x, dict)


def _parse_cut_ranges(raw: Any) -> list[dict[str, float]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, float]] = []
    for item in raw:
        if not _is_record(item):
            continue
        try:
            start = float(item.get("start", 0))
            end = float(item.get("end", 0))
        except (TypeError, ValueError):
            continue
        if end <= start:
            continue
        out.append({"start": max(0.0, start), "end": max(0.0, end)})
    return out


def _parse_word(w: dict[str, Any]) -> dict[str, Any]:
    piece = str(w.get("word") or w.get("text") or "").strip()
    return {
        "start": float(w.get("start", 0)),
        "end": float(w.get("end", 0)),
        "word": piece,
        "is_silence": bool(w.get("isSilence") or w.get("is_silence")),
        "is_deleted": bool(w.get("isDeleted") or w.get("is_deleted")),
    }


def _parse_words(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if _is_record(item):
            out.append(_parse_word(item))
    return out


def _norm_subtitle_text(s: str) -> str:
    return " ".join(str(s or "").split()).strip()


def _text_from_visible_words(words: list[dict[str, Any]]) -> str:
    vis = [w for w in words if not w.get("is_deleted") and str(w.get("word") or "").strip()]
    if not vis:
        return ""
    return " ".join(str(w["word"]) for w in vis).strip()


def _resolve_cue_text(saved_text: str, words: list[dict[str, Any]]) -> str:
    from_words = _text_from_visible_words(words)
    saved = str(saved_text or "").strip()
    if saved and from_words and _norm_subtitle_text(saved) != _norm_subtitle_text(from_words):
        return saved
    return from_words or saved


def _cue_from_line(line: dict[str, Any]) -> dict[str, Any] | None:
    if line.get("isDeleted") is True or line.get("is_deleted") is True:
        return None
    words = _parse_words(line.get("words"))
    saved_text = str(line.get("text") or "").strip()
    vis = [w for w in words if not w.get("is_deleted") and str(w.get("word") or "").strip()]
    if vis:
        starts = [float(w["start"]) for w in vis]
        ends = [float(w["end"]) for w in vis]
        text = _resolve_cue_text(saved_text, words)
        if not text:
            return None
        start = min(starts)
        end = max(ends)
    else:
        text = saved_text
        if not text:
            return None
        start = float(line.get("start", 0))
        end = float(line.get("end", start))
        words = []

    is_silence = line.get("isSilence") is True or line.get("is_silence") is True
    cue: dict[str, Any] = {
        "start": start,
        "end": end,
        "text": text,
        "is_silence": is_silence,
    }
    if words:
        cue["words"] = words
    return cue


def _parse_subtitles(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if not _is_record(item):
            continue
        cue = _cue_from_line(item)
        if cue:
            out.append(cue)
    return out


def _parse_style(raw: Any) -> dict[str, Any] | None:
    if not _is_record(raw):
        return None
    font_family = str(raw.get("fontFamily") or raw.get("font_family") or "").strip()
    if not font_family:
        return None
    try:
        return {
            "fontFamily": font_family,
            "fontSize": int(float(raw.get("fontSize", 26))),
            "textColor": str(raw.get("textColor") or "#f4f6fb"),
            "fontWeight": int(float(raw.get("fontWeight", 700))),
            "bgColor": str(raw.get("bgColor") or "#080a10"),
            "bgOpacity": int(float(raw.get("bgOpacity", 62))),
            "bgPaddingPct": int(float(raw.get("bgPaddingPct", 8))),
            "strokeColor": str(raw.get("strokeColor") or "#000000"),
            "strokeWidth": int(float(raw.get("strokeWidth", 2))),
            "x": float(raw.get("x", 50)),
            "y": float(raw.get("y", 10)),
        }
    except (TypeError, ValueError):
        return None


def _cuts_from_virtual_timeline(raw: Any) -> list[dict[str, float]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, float]] = []
    for block in raw:
        if not _is_record(block):
            continue
        if not (block.get("isDeleted") is True or block.get("is_deleted") is True):
            continue
        try:
            start = float(block.get("mediaStartSec", block.get("start", 0)))
            end = float(block.get("mediaEndSec", block.get("end", 0)))
        except (TypeError, ValueError):
            continue
        if end > start:
            out.append({"start": start, "end": end})
    return out


def parse_autosub_project(raw: Any) -> tuple[dict[str, Any] | None, str | None]:
    if not _is_record(raw):
        return None, "루트가 객체가 아닙니다."
    fmt = raw.get("format")
    if fmt not in (AUTOSUB_FILE_FORMAT, "autosub-project"):
        return None, f"지원하지 않는 format: {fmt!r}"
    version = raw.get("version")
    if version not in (AUTOSUB_VERSION, "1", 1):
        return None, f"지원하지 않는 버전: {version!r}"

    video_path = raw.get("videoPath") or raw.get("video_path")
    if video_path is not None and not isinstance(video_path, str):
        video_path = None

    cut_ranges = _parse_cut_ranges(raw.get("cutRanges") or raw.get("cut_ranges"))
    vt_cuts = _cuts_from_virtual_timeline(raw.get("virtualTimeline"))
    if vt_cuts:
        cut_ranges = cut_ranges + vt_cuts

    style = _parse_style(raw.get("subtitleStyle") or raw.get("subtitle_style"))
    cues = _parse_subtitles(raw.get("subtitles") or raw.get("cues"))

    normalized = {
        "format": AUTOSUB_FILE_FORMAT,
        "version": AUTOSUB_VERSION,
        "video_path": video_path.strip() if isinstance(video_path, str) and video_path.strip() else None,
        "cut_ranges": cut_ranges,
        "subtitle_style": style,
        "cues": cues,
    }
    return normalized, None
