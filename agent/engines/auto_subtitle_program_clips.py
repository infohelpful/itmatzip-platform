"""V5 — programClips optimization for filter_program bake (merge, dedupe, 2-tier chunk)."""

from __future__ import annotations

from typing import Any

from engines.auto_subtitle_burn_in import (
    MAX_FILTER_CONCAT_SEGMENTS,
    _build_filter_program_av_chain,
    _build_vmain_tail_chain,
    dedupe_overlapping_keep_segments,
)
from engines.auto_subtitle_filter_concat import EXPORT_AUDIO_CROSSFADE_SEC
from engines.auto_subtitle_filter_concat import build_trim_concat_filter_parts
from engines.auto_subtitle_program_clip_playback import clip_playback_source_end

PROGRAM_CLIP_EPS = 1e-5
CHUNK_SEGMENT_SIZE = 100
EXPORT_SCHEMA_VERSION = 5


def normalize_program_clips(raw: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        try:
            src_start = float(
                item.get("sourceStart", item.get("source_start", 0))
            )
            src_end = float(item.get("sourceEnd", item.get("source_end", 0)))
        except (TypeError, ValueError):
            continue
        if src_end <= src_start + PROGRAM_CLIP_EPS:
            continue
        raw_eff = item.get("effectiveSourceEnd", item.get("effective_source_end"))
        eff_end = src_end
        if raw_eff is not None:
            try:
                eff_end = min(src_end, float(raw_eff))
            except (TypeError, ValueError):
                eff_end = src_end
        if eff_end <= src_start + PROGRAM_CLIP_EPS:
            eff_end = src_end
        out.append(
            {
                "id": str(item.get("id") or ""),
                "blockIndex": int(item.get("blockIndex", item.get("block_index", 0)) or 0),
                "sourceStart": src_start,
                "sourceEnd": src_end,
                "effectiveSourceEnd": eff_end,
                "programStart": float(item.get("programStart", item.get("program_start", 0)) or 0),
                "programEnd": float(item.get("programEnd", item.get("program_end", 0)) or 0),
                "isSilence": bool(item.get("isSilence", item.get("is_silence", False))),
            }
        )
    return out


def merge_contiguous_program_clips(
    clips: list[dict[str, Any]],
) -> list[tuple[float, float]]:
    """Merge adjacent clips with contiguous source on media axis (video filter only)."""
    if not clips:
        return []
    merged: list[tuple[float, float, bool]] = []
    for clip in clips:
        s = float(clip["sourceStart"])
        e = float(clip["sourceEnd"])
        sil = bool(clip.get("isSilence"))
        if not merged:
            merged.append((s, e, sil))
            continue
        ps, pe, psil = merged[-1]
        if (
            not psil
            and not sil
            and abs(pe - s) <= PROGRAM_CLIP_EPS
        ):
            merged[-1] = (ps, max(pe, e), False)
        else:
            merged.append((s, e, sil))
    return [(s, e) for s, e, _ in merged if e > s + PROGRAM_CLIP_EPS]


def program_clips_to_literal_bake_segments(
    program_clips: list[dict[str, Any]] | None,
) -> list[tuple[float, float]]:
    """V5 literal queue — preview playback span per ProgramClip (effectiveSourceEnd)."""
    clips = normalize_program_clips(program_clips)
    segments: list[tuple[float, float]] = []
    for clip in clips:
        s = float(clip["sourceStart"])
        e = clip_playback_source_end(clip)
        if e <= s + PROGRAM_CLIP_EPS:
            bid = clip.get("blockIndex", clip.get("block_index", "?"))
            raise ValueError(
                f"ProgramClip blockIndex={bid} has zero source duration ({s:.6f}–{e:.6f})"
            )
        segments.append((s, e))
    return segments


def validate_literal_bake_segments(
    clips: list[dict[str, Any]],
    segments: list[tuple[float, float]],
    *,
    program_duration_sec: float | None = None,
) -> None:
    """Parity gate — clip count and summed source duration must match program axis."""
    if len(segments) != len(clips):
        raise ValueError(
            f"literal bake parity: clip_count={len(clips)} segment_count={len(segments)}"
        )
    seg_dur = sum(e - s for s, e in segments)
    expected = float(program_duration_sec or 0)
    if expected <= 0 and clips:
        expected = float(clips[-1].get("programEnd") or 0)
    if expected > 0 and abs(seg_dur - expected) > 0.08:
        raise ValueError(
            f"literal bake duration parity: segments={seg_dur:.3f} expected={expected:.3f}"
        )


def optimize_clips_for_filter(
    program_clips: list[dict[str, Any]] | None,
) -> list[tuple[float, float]]:
    """Legacy filter path — prefer program_clips_to_literal_bake_segments for V5 bake."""
    clips = normalize_program_clips(program_clips)
    merged = merge_contiguous_program_clips(clips)
    return dedupe_overlapping_keep_segments(merged)


def _build_trim_concat_chain_labeled(
    segments: list[tuple[float, float]],
    *,
    has_audio: bool,
    v_out: str,
    a_out: str | None,
    id_prefix: str,
    audio_crossfade_sec: float | None = None,
    program_slot_durations: list[float] | None = None,
) -> list[str]:
    return build_trim_concat_filter_parts(
        segments,
        has_audio=has_audio,
        v_out=v_out,
        a_out=a_out,
        id_prefix=id_prefix,
        audio_crossfade_sec=audio_crossfade_sec,
        program_slot_durations=program_slot_durations,
    )


def build_filter_program_av_chain_chunked(
    segments: list[tuple[float, float]],
    fps_expr: str,
    probe_data: dict[str, Any],
    *,
    has_audio: bool,
    force_fps: bool = False,
    audio_crossfade_sec: float | None = EXPORT_AUDIO_CROSSFADE_SEC,
    program_slot_durations: list[float] | None = None,
) -> tuple[str, str | None]:
    """Single filter_complex: optional 2-tier concat when segment count exceeds limit."""
    if not segments:
        raise ValueError("filter segments가 비어 있습니다.")
    if len(segments) <= MAX_FILTER_CONCAT_SEGMENTS:
        return _build_filter_program_av_chain(
            segments,
            fps_expr,
            probe_data,
            has_audio=has_audio,
            force_fps=force_fps,
            audio_crossfade_sec=audio_crossfade_sec,
            program_slot_durations=program_slot_durations,
        )

    parts: list[str] = []
    chunk_count = (len(segments) + CHUNK_SEGMENT_SIZE - 1) // CHUNK_SEGMENT_SIZE
    v_tier: list[str] = []
    a_tier: list[str] = []
    for ci in range(chunk_count):
        chunk = segments[ci * CHUNK_SEGMENT_SIZE : (ci + 1) * CHUNK_SEGMENT_SIZE]
        v_label = f"vchunk{ci}"
        a_label = f"achunk{ci}" if has_audio else None
        chunk_slots = None
        if program_slot_durations and len(program_slot_durations) == len(segments):
            chunk_slots = program_slot_durations[
                ci * CHUNK_SEGMENT_SIZE : (ci + 1) * CHUNK_SEGMENT_SIZE
            ]
        parts.extend(
            _build_trim_concat_chain_labeled(
                chunk,
                has_audio=has_audio,
                v_out=v_label,
                a_out=a_label,
                id_prefix=f"c{ci}_",
                audio_crossfade_sec=audio_crossfade_sec,
                program_slot_durations=chunk_slots,
            )
        )
        v_tier.append(f"[{v_label}]")
        if has_audio and a_label:
            a_tier.append(f"[{a_label}]")

    if chunk_count > 1:
        if has_audio:
            concat_in = "".join(
                label for i in range(chunk_count) for label in (v_tier[i], a_tier[i])
            )
            parts.append(f"{concat_in}concat=n={chunk_count}:v=1:a=1[v_edit][a_edit]")
        else:
            parts.append(f"{''.join(v_tier)}concat=n={chunk_count}:v=1:a=0[v_edit]")
        vmain_in = "[v_edit]"
        audio_out: str | None = "[a_edit]" if has_audio else None
    else:
        vmain_in = v_tier[0]
        audio_out = a_tier[0] if has_audio and a_tier else None

    parts.append(
        _build_vmain_tail_chain(fps_expr, probe_data, in_label=vmain_in, force_fps=force_fps)
    )
    return ";".join(parts), audio_out
