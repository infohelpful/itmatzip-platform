"""Build initial programClips from transcribe cues (pre-block FE ingest)."""

from __future__ import annotations

from typing import Any

from engines.auto_subtitle_program_clips import PROGRAM_CLIP_EPS

CLIP_END_TAIL_PAD_SEC = 0.2
EPS = 1e-5


def _cue_is_silence(cue: dict[str, Any]) -> bool:
    return bool(cue.get("is_silence") or cue.get("isSilence"))


def _word_visible(w: dict[str, Any]) -> bool:
    if w.get("is_deleted") or w.get("isDeleted"):
        return False
    if w.get("is_silence") or w.get("isSilence"):
        return False
    text = str(w.get("word") or w.get("text") or "").strip()
    return bool(text) and text != "[--]"


def _num(v: Any, default: float = 0.0) -> float:
    try:
        n = float(v)
        return n if n == n else default
    except (TypeError, ValueError):
        return default


def _cue_source_start(cue: dict[str, Any]) -> float:
    for key in ("source_start", "sourceStart", "source_in", "sourceIn"):
        v = cue.get(key)
        if v is not None:
            return max(0.0, _num(v))
    words = cue.get("words")
    if isinstance(words, list) and words:
        for w in words:
            if not isinstance(w, dict) or not _word_visible(w):
                continue
            for key in ("source_start", "sourceStart", "source_in", "sourceIn", "start"):
                if w.get(key) is not None:
                    return max(0.0, _num(w[key]))
    return max(0.0, _num(cue.get("start")))


def _cue_source_end(cue: dict[str, Any], next_cue: dict[str, Any] | None) -> float:
    for key in ("source_end", "sourceEnd", "source_out", "sourceOut"):
        v = cue.get(key)
        if v is not None:
            end = max(_cue_source_start(cue), _num(v))
            break
    else:
        end = max(_cue_source_start(cue), _num(cue.get("end")))
    words = cue.get("words")
    if isinstance(words, list):
        for w in reversed(words):
            if not isinstance(w, dict) or not _word_visible(w):
                continue
            for key in ("source_end", "sourceEnd", "source_out", "sourceOut", "end"):
                if w.get(key) is not None:
                    end = max(end, _num(w[key]) + CLIP_END_TAIL_PAD_SEC)
                    break
            break
    if next_cue is not None:
        next_virtual = _num(next_cue.get("start"))
        if next_virtual <= end + EPS:
            return end
        next_src = _cue_source_start(next_cue)
        if next_src > end + EPS:
            end = next_src
    return end


def _listable_cue_indices(cues: list[dict[str, Any]]) -> list[int]:
    out: list[int] = []
    for i, cue in enumerate(cues):
        if not isinstance(cue, dict) or _cue_is_silence(cue):
            continue
        text = str(cue.get("text") or "").strip()
        words = cue.get("words")
        has_word = isinstance(words, list) and any(
            isinstance(w, dict) and _word_visible(w) for w in words
        )
        if text or has_word:
            out.append(i)
    return out


def _remove_adjacent_overlaps(
    segments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if len(segments) <= 1:
        return [dict(s) for s in segments]
    segs = [dict(s) for s in segments]
    for i in range(len(segs) - 1):
        a = segs[i]
        b = segs[i + 1]
        overlap_start = max(a["sourceStart"], b["sourceStart"])
        overlap_end = min(a["sourceEnd"], b["sourceEnd"])
        if overlap_end <= overlap_start + EPS:
            continue
        if b["sourceStart"] >= a["sourceStart"] - EPS:
            a["sourceEnd"] = min(a["sourceEnd"], b["sourceStart"])
        else:
            b["sourceStart"] = max(b["sourceStart"], a["sourceEnd"])
        if a["sourceEnd"] <= a["sourceStart"] + EPS:
            segs.pop(i)
            break
        if b["sourceEnd"] <= b["sourceStart"] + EPS:
            segs.pop(i + 1)
    return [s for s in segs if s["sourceEnd"] > s["sourceStart"] + EPS]


def _recalc_program_timeline(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cursor = 0.0
    out: list[dict[str, Any]] = []
    for seg in segments:
        dur = seg["sourceEnd"] - seg["sourceStart"]
        out.append(
            {
                **seg,
                "programStart": cursor,
                "programEnd": cursor + dur,
            }
        )
        cursor += dur
    return out


def build_program_clips_from_cues(
    cues: list[dict[str, Any]],
    *,
    media_duration_sec: float | None = None,
) -> list[dict[str, Any]]:
    """Virtual-audio-map equivalent → programClips for initial transcribe bake."""
    indices = _listable_cue_indices(cues)
    raw: list[dict[str, Any]] = []
    for pos, cue_index in enumerate(indices):
        cue = cues[cue_index]
        next_cue = cues[indices[pos + 1]] if pos + 1 < len(indices) else None
        src_start = _cue_source_start(cue)
        src_end = _cue_source_end(cue, next_cue)
        if src_end <= src_start + EPS:
            continue
        raw.append(
            {
                "id": str(cue.get("id") or cue_index),
                "blockIndex": cue_index,
                "sourceStart": src_start,
                "sourceEnd": src_end,
                "isSilence": False,
            }
        )
    deduped = _remove_adjacent_overlaps(raw)
    if not deduped:
        dur = float(media_duration_sec or 0)
        if dur > EPS:
            deduped = [
                {
                    "id": "0",
                    "blockIndex": 0,
                    "sourceStart": 0.0,
                    "sourceEnd": dur,
                    "isSilence": False,
                }
            ]
    timed = _recalc_program_timeline(deduped)
    return [
        {
            "id": s["id"],
            "blockIndex": s["blockIndex"],
            "sourceStart": s["sourceStart"],
            "sourceEnd": s["sourceEnd"],
            "programStart": s["programStart"],
            "programEnd": s["programEnd"],
            "isSilence": bool(s.get("isSilence")),
        }
        for s in timed
        if s["sourceEnd"] > s["sourceStart"] + PROGRAM_CLIP_EPS
    ]
