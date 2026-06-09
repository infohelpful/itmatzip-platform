"""`.autosub` 프로젝트 파싱·정규화."""

from __future__ import annotations

from typing import Any

AUTOSUB_FILE_FORMAT = "autosubtitle-project"
AUTOSUB_VERSION = 1
AUTOSUB_VERSION_V2 = 2
_SUPPORTED_VERSIONS = frozenset({1, 2, "1", "2"})


def _float_or(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


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


def _parse_word_block(raw: dict[str, Any]) -> dict[str, Any]:
    source_in = _float_or(raw.get("sourceIn", raw.get("source_in")))
    source_out = _float_or(raw.get("sourceOut", raw.get("source_out")), source_in)
    out: dict[str, Any] = {
        "id": str(raw.get("id") or ""),
        "text": str(raw.get("text") or raw.get("word") or ""),
        "duration": _float_or(raw.get("duration")),
        "sourceIn": source_in,
        "sourceOut": max(source_in, source_out),
    }
    if raw.get("isDeleted") is True or raw.get("is_deleted") is True:
        out["isDeleted"] = True
    if raw.get("isSilence") is True or raw.get("is_silence") is True:
        out["isSilence"] = True
    if raw.get("mergedByEdgeTrim") is True or raw.get("merged_by_edge_trim") is True:
        out["mergedByEdgeTrim"] = True
    split_chain = raw.get("splitChain") or raw.get("split_chain")
    if split_chain:
        out["splitChain"] = str(split_chain)
    return out


def _parse_block(raw: dict[str, Any]) -> dict[str, Any] | None:
    block_id = str(raw.get("id") or "").strip()
    if not block_id:
        return None
    source_in = _float_or(raw.get("sourceIn", raw.get("source_in")))
    source_out = _float_or(raw.get("sourceOut", raw.get("source_out")), source_in)
    block: dict[str, Any] = {
        "id": block_id,
        "text": str(raw.get("text") or ""),
        "duration": _float_or(raw.get("duration")),
        "sourceIn": source_in,
        "sourceOut": max(source_in, source_out),
    }
    if raw.get("isDeleted") is True or raw.get("is_deleted") is True:
        block["isDeleted"] = True
    if raw.get("isSilence") is True or raw.get("is_silence") is True:
        block["isSilence"] = True
    words_raw = raw.get("words")
    if isinstance(words_raw, list):
        words = [_parse_word_block(w) for w in words_raw if _is_record(w)]
        if words:
            block["words"] = words
    return block


def _parse_blocks(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if not _is_record(item):
            continue
        block = _parse_block(item)
        if block:
            out.append(block)
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
    if version not in _SUPPORTED_VERSIONS:
        return None, f"지원하지 않는 버전: {version!r}"
    version_num = AUTOSUB_VERSION_V2 if version in (AUTOSUB_VERSION_V2, "2") else AUTOSUB_VERSION

    video_path = raw.get("videoPath") or raw.get("video_path")
    if video_path is not None and not isinstance(video_path, str):
        video_path = None

    cut_ranges = _parse_cut_ranges(raw.get("cutRanges") or raw.get("cut_ranges"))
    hard_deleted_media_skips = _parse_cut_ranges(
        raw.get("hardDeletedMediaSkips") or raw.get("hard_deleted_media_skips")
    )
    blocks = _parse_blocks(raw.get("blocks"))
    vt_cuts = _cuts_from_virtual_timeline(raw.get("virtualTimeline"))
    if vt_cuts:
        cut_ranges = cut_ranges + vt_cuts

    style = _parse_style(raw.get("subtitleStyle") or raw.get("subtitle_style"))
    cues = _parse_subtitles(raw.get("subtitles") or raw.get("cues"))

    normalized = {
        "format": AUTOSUB_FILE_FORMAT,
        "version": version_num,
        "video_path": video_path.strip() if isinstance(video_path, str) and video_path.strip() else None,
        "cut_ranges": cut_ranges,
        "hard_deleted_media_skips": hard_deleted_media_skips,
        "blocks": blocks,
        "subtitle_style": style,
        "cues": cues,
    }
    return normalized, None
