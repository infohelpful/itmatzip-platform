"""Preview-parity programClip playback — effectiveSourceEnd, list/source successor SSOT."""

from __future__ import annotations

from typing import Any

PROGRAM_CLIP_EPS = 1e-5


def clip_playback_source_end(clip: dict[str, Any]) -> float:
    """Preview `effectiveSourceEnd` — trim end (tail pad 제외)."""
    src_start = float(clip.get("sourceStart", clip.get("source_start", 0)) or 0)
    src_end = float(clip.get("sourceEnd", clip.get("source_end", 0)) or 0)
    raw_eff = clip.get("effectiveSourceEnd", clip.get("effective_source_end"))
    if raw_eff is not None:
        try:
            eff = float(raw_eff)
            if eff > src_start + PROGRAM_CLIP_EPS:
                return min(src_end, eff) if src_end > src_start else eff
        except (TypeError, ValueError):
            pass
    return src_end


def clip_program_slot_sec(clip: dict[str, Any]) -> float:
    """programEnd - programStart (자막·program 축 슬롯 길이)."""
    ps = float(clip.get("programStart", clip.get("program_start", 0)) or 0)
    pe = float(clip.get("programEnd", clip.get("program_end", 0)) or 0)
    return max(0.0, pe - ps)


def clip_block_key(clip: dict[str, Any] | None) -> str | None:
    if not clip:
        return None
    cid = clip.get("id")
    if cid is not None and str(cid).strip():
        return str(cid)
    bi = clip.get("blockIndex", clip.get("block_index"))
    if bi is not None:
        try:
            if int(bi) >= 0:
                return f"idx:{int(bi)}"
        except (TypeError, ValueError):
            pass
    return None


def build_clip_source_order_index(
    clips: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[int, int]]:
    """sourceStart 순 정렬 — preview `buildClipSourceOrderIndex` 동형."""
    entries: list[dict[str, Any]] = []
    for clip_pos, clip in enumerate(clips):
        if bool(clip.get("isSilence") or clip.get("is_silence")):
            continue
        block_key = clip_block_key(clip)
        if not block_key:
            continue
        entries.append(
            {
                "clipPos": clip_pos,
                "blockKey": block_key,
                "start": float(clip.get("sourceStart", clip.get("source_start", 0)) or 0),
            }
        )
    entries.sort(key=lambda e: (e["start"], e["clipPos"]))
    rank_by_clip_pos = {e["clipPos"]: rank for rank, e in enumerate(entries)}
    return entries, rank_by_clip_pos


def list_and_source_successors_match(
    clips: list[dict[str, Any]],
    cur_pos: int,
    next_pos: int,
) -> bool:
    """목록 다음 줄 == 소스 타임라인에서 바로 다음 줄 (preview pass-through SSOT)."""
    if next_pos != cur_pos + 1:
        return False
    if cur_pos < 0 or next_pos >= len(clips):
        return False
    cur = clips[cur_pos]
    nxt = clips[next_pos]
    list_key = clip_block_key(nxt)
    if not list_key:
        return False
    entries, rank_by_clip_pos = build_clip_source_order_index(clips)
    cur_rank = rank_by_clip_pos.get(cur_pos)
    if cur_rank is None or cur_rank + 1 >= len(entries):
        return False
    source_next = entries[cur_rank + 1]
    return source_next.get("blockKey") == list_key
