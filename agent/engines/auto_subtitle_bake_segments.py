"""Bake/export segment prepare — merge contiguous, zero-cross trim, crossfade constants."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from engines.auto_subtitle_program_clip_playback import (
    clip_program_slot_sec,
    list_and_source_successors_match,
)
from engines.auto_subtitle_zero_cross import (
    SEGMENT_MIN_SEC,
    ZC_END_SEARCH_AFTER_SEC,
    ZC_END_SEARCH_BEFORE_SEC,
    ZC_START_SEARCH_AFTER_SEC,
    ZC_START_SEARCH_BEFORE_SEC,
    decode_mono_f32_16k,
    refine_time_to_zero_cross,
)

_log = logging.getLogger(__name__)

BAKE_SEGMENT_EPS = 1e-5
BAKE_DURATION_PARITY_EPS = 0.08
# STT 줄 사이 breath — preview pass-through와 동일 run (삭제 구간만 split)
BAKE_MERGE_NATURAL_GAP_SEC = 2.0


def merge_contiguous_segments(
    segments: list[tuple[float, float]],
    *,
    eps: float = BAKE_SEGMENT_EPS,
) -> list[tuple[float, float]]:
    if not segments:
        return []
    merged: list[tuple[float, float]] = []
    for s, e in segments:
        s, e = float(s), float(e)
        if e <= s + eps:
            continue
        if not merged:
            merged.append((s, e))
            continue
        ps, pe = merged[-1]
        if abs(pe - s) <= eps:
            merged[-1] = (ps, max(pe, e))
        else:
            merged.append((s, e))
    return merged


def _program_clips_contiguous_on_axis(
    clip_a: dict[str, Any],
    clip_b: dict[str, Any],
) -> bool:
    pe = float(clip_a.get("programEnd", clip_a.get("program_end", 0)) or 0)
    ps = float(clip_b.get("programStart", clip_b.get("program_start", 0)) or 0)
    return abs(ps - pe) <= BAKE_SEGMENT_EPS


def _program_slots_for_clip_run(
    program_clips: list[dict[str, Any]],
    start_idx: int,
    end_idx: int,
) -> float:
    total = 0.0
    for k in range(start_idx, end_idx + 1):
        total += clip_program_slot_sec(program_clips[k])
    return total


def merge_literal_segments_for_bake(
    program_clips: list[dict[str, Any]],
    segments: list[tuple[float, float]],
    *,
    max_gap_sec: float = BAKE_MERGE_NATURAL_GAP_SEC,
) -> tuple[list[tuple[float, float]], list[float], dict[str, Any]]:
    """
    List-order programClips + preview playback spans → bake runs.
    merge 조건: program 축 연속 + list/source successor 일치 + source gap 허용.
    """
    if not segments:
        return [], [], {"runs": 0, "bridged_gaps": 0}
    if len(program_clips) != len(segments):
        merged = merge_contiguous_segments(segments)
        slots = [e - s for s, e in merged]
        return merged, slots, {
            "runs": len(merged),
            "bridged_gaps": 0,
            "clip_parity_skipped": True,
        }

    merged: list[tuple[float, float]] = []
    program_slots: list[float] = []
    bridged_gaps = 0
    runs = 0
    i = 0
    n = len(segments)
    while i < n:
        clip = program_clips[i]
        s0, e0 = float(segments[i][0]), float(segments[i][1])
        if bool(clip.get("isSilence") or clip.get("is_silence")):
            if e0 > s0 + BAKE_SEGMENT_EPS:
                merged.append((s0, e0))
                program_slots.append(_program_slots_for_clip_run(program_clips, i, i))
                runs += 1
            i += 1
            continue

        run_s, run_e = s0, e0
        j = i
        while j + 1 < n:
            nclip = program_clips[j + 1]
            ns, ne = float(segments[j + 1][0]), float(segments[j + 1][1])
            if bool(nclip.get("isSilence") or nclip.get("is_silence")):
                break
            if not list_and_source_successors_match(program_clips, j, j + 1):
                break
            gap = ns - run_e
            if gap < -0.05:
                break
            if not _program_clips_contiguous_on_axis(program_clips[j], nclip):
                break
            if gap > float(max_gap_sec):
                break
            if ne <= ns + BAKE_SEGMENT_EPS:
                j += 1
                continue
            if gap > BAKE_SEGMENT_EPS:
                bridged_gaps += 1
            run_e = max(run_e, ne)
            j += 1

        if run_e > run_s + BAKE_SEGMENT_EPS:
            merged.append((run_s, run_e))
            program_slots.append(_program_slots_for_clip_run(program_clips, i, j))
            runs += 1
        i = j + 1

    if len(merged) > 1:
        merged = merge_contiguous_segments(merged)
        if len(program_slots) != len(merged):
            program_slots = [e - s for s, e in merged]
    return merged, program_slots, {
        "runs": len(merged),
        "bridged_gaps": bridged_gaps,
        "raw_literal_count": n,
    }


def refine_segments_zero_cross(
    segments: list[tuple[float, float]],
    samples,
    *,
    dur_max: float,
    sr: int = 16_000,
) -> list[tuple[float, float]]:
    if not segments or samples is None or len(samples) < 8:
        return list(segments)

    out: list[tuple[float, float]] = []
    for i, (s, e) in enumerate(segments):
        ns = refine_time_to_zero_cross(
            samples,
            sr,
            float(s),
            ZC_START_SEARCH_BEFORE_SEC,
            ZC_START_SEARCH_AFTER_SEC,
            dur_max=dur_max,
        )
        ne = refine_time_to_zero_cross(
            samples,
            sr,
            float(e),
            ZC_END_SEARCH_BEFORE_SEC,
            ZC_END_SEARCH_AFTER_SEC,
            dur_max=dur_max,
        )
        if ne <= ns + SEGMENT_MIN_SEC:
            ne = min(dur_max, ns + max(SEGMENT_MIN_SEC, float(e) - float(s)))
        out.append((ns, ne))

    for i in range(len(out) - 1):
        s0, e0 = out[i]
        s1, e1 = out[i + 1]
        if e0 > s1 + BAKE_SEGMENT_EPS:
            mid = (e0 + s1) * 0.5
            out[i] = (s0, mid)
            out[i + 1] = (mid, e1)
        elif s1 < e0 - BAKE_SEGMENT_EPS:
            out[i + 1] = (e0, e1)

    fixed: list[tuple[float, float]] = []
    for s, e in out:
        s = max(0.0, min(dur_max, s))
        e = max(s + SEGMENT_MIN_SEC, min(dur_max, e))
        fixed.append((s, e))
    return fixed


def _align_program_clips_and_segments(
    program_clips: list[dict[str, Any]],
    segments: list[tuple[float, float]],
) -> tuple[list[dict[str, Any]], list[tuple[float, float]]]:
    out_c: list[dict[str, Any]] = []
    out_s: list[tuple[float, float]] = []
    for clip, (s, e) in zip(program_clips, segments, strict=False):
        s, e = float(s), float(e)
        if e <= s + BAKE_SEGMENT_EPS:
            continue
        out_c.append(clip)
        out_s.append((s, e))
    return out_c, out_s


def prepare_bake_segments(
    media_path: Path,
    segments: list[tuple[float, float]],
    *,
    merge_contiguous: bool = True,
    zero_cross: bool = True,
    ffmpeg_exe: str | None = None,
    program_clips: list[dict[str, Any]] | None = None,
) -> tuple[list[tuple[float, float]], list[float] | None, dict[str, Any]]:
    """Merge + ZC refine for ffmpeg trim/concat (program 자막 축과 독립)."""
    raw_count = len(segments)
    prepared = [(float(s), float(e)) for s, e in segments if float(e) > float(s) + BAKE_SEGMENT_EPS]
    clips_for_merge: list[dict[str, Any]] | None = None
    if program_clips and len(program_clips) == raw_count:
        clips_for_merge, prepared = _align_program_clips_and_segments(program_clips, segments)
        if not clips_for_merge:
            clips_for_merge = None
    program_slots: list[float] | None = None
    if clips_for_merge:
        program_slots = [clip_program_slot_sec(c) for c in clips_for_merge]
    meta: dict[str, Any] = {
        "raw_segment_count": raw_count,
        "merged": False,
        "zero_cross": False,
    }

    if merge_contiguous and len(prepared) > 1:
        before = len(prepared)
        if clips_for_merge and len(clips_for_merge) == len(prepared):
            prepared, program_slots, run_meta = merge_literal_segments_for_bake(
                clips_for_merge, prepared
            )
            meta["clip_run_merge"] = run_meta
        else:
            prepared = merge_contiguous_segments(prepared)
            program_slots = [e - s for s, e in prepared]
        meta["merged"] = len(prepared) < before
    elif merge_contiguous and len(prepared) == 1 and clips_for_merge:
        meta["clip_run_merge"] = {"runs": 1, "bridged_gaps": 0, "raw_literal_count": raw_count}
    meta["segment_count"] = len(prepared)

    if zero_cross and len(prepared) == 1 and prepared and media_path.is_file():
        try:
            samples = decode_mono_f32_16k(media_path, ffmpeg_exe)
            dur_max = len(samples) / float(16_000)
            prepared = refine_segments_zero_cross(prepared, samples, dur_max=dur_max)
            meta["zero_cross"] = True
        except (RuntimeError, OSError, ValueError) as exc:
            _log.warning("bake ZC refine skipped: %s", exc)
    elif zero_cross and len(prepared) > 1 and media_path.is_file():
        meta["zero_cross"] = False
        meta["zero_cross_skipped"] = "multi_run_outer_only_deferred"

    if program_slots and len(program_slots) != len(prepared):
        program_slots = [e - s for s, e in prepared]
    meta["program_slot_sum"] = sum(program_slots) if program_slots else None
    return prepared, program_slots, meta


def segments_from_virtual_audio_map(
    virtual_audio_map: list[dict[str, Any]] | None,
) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for raw in virtual_audio_map or []:
        if not isinstance(raw, dict):
            continue
        try:
            s = float(raw.get("sourceStart", raw.get("source_start", 0)))
            e = float(raw.get("sourceEnd", raw.get("source_end", 0)))
        except (TypeError, ValueError):
            continue
        if e > s + BAKE_SEGMENT_EPS:
            out.append((s, e))
    return out


def validate_bake_segments_duration(
    segments: list[tuple[float, float]],
    *,
    program_duration_sec: float | None = None,
    expected_from_clips: float | None = None,
    raw_clip_count: int | None = None,
    program_slot_durations: list[float] | None = None,
) -> None:
    if not segments:
        raise ValueError("bake segments가 비어 있습니다.")
    seg_dur = sum(e - s for s, e in segments)
    slot_dur = sum(program_slot_durations) if program_slot_durations else seg_dur
    expected = float(program_duration_sec or 0)
    if expected <= 0:
        expected = float(expected_from_clips or 0)
    if expected > 0:
        if slot_dur + BAKE_DURATION_PARITY_EPS < expected:
            raise ValueError(
                f"bake duration parity: program_slots={slot_dur:.3f} shorter than expected={expected:.3f}"
            )
        n = max(1, int(raw_clip_count or 0))
        max_overshoot = BAKE_MERGE_NATURAL_GAP_SEC * max(n - 1, 1) + 2.0
        if seg_dur > expected + max_overshoot:
            raise ValueError(
                f"bake duration parity: source_spans={seg_dur:.3f} expected={expected:.3f}"
            )
