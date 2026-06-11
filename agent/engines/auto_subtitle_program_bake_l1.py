"""Phase 2 — program-master L1 concat ladder (copy → reencode + dual gate)."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from engines.auto_subtitle_export import ExportProgressCallback
from engines.auto_subtitle_export_concat import (
    ConcatQualityGateError,
    _concat_ffmpeg,
    can_bypass_concat_gate,
    evaluate_dual_quality_gate,
    write_concat_demuxer_list,
)

_log = logging.getLogger(__name__)

L1_MAX_SEGMENTS = 128


def segments_to_concat_map(
    segments: list[tuple[float, float]],
    expected_program_end: float,
) -> list[dict[str, Any]]:
    """Filter segments → virtual_audio_map shape for concat demuxer."""
    out: list[dict[str, Any]] = []
    for start, end in segments:
        s = float(start)
        e = float(end)
        if e <= s + 1e-5:
            continue
        out.append(
            {
                "sourceStart": s,
                "sourceEnd": e,
                "editEnd": float(expected_program_end),
            }
        )
    return out


def try_bake_l1_concat_copy(
    preview_media: Path,
    segments: list[tuple[float, float]],
    job_dir: Path,
    expected_program_end: float,
    *,
    on_progress: ExportProgressCallback | None = None,
    timeout_sec: float = 7200.0,
) -> tuple[bool, Path | None, dict[str, Any]]:
    """L1a — concat demuxer stream copy + dual quality gate."""
    if len(segments) > L1_MAX_SEGMENTS:
        return False, None, {"skipped": True, "reason": "segment_count", "segment_count": len(segments)}

    segs = segments_to_concat_map(segments, expected_program_end)
    if not segs:
        return False, None, {"error": "no_valid_segments"}

    job_dir.mkdir(parents=True, exist_ok=True)
    concat_list = job_dir / "pm_concat_list.txt"
    segments_count = write_concat_demuxer_list(preview_media, segs, concat_list)

    tmp_copy = job_dir / "tmp_pmaster_l1_copy.mp4"
    if on_progress:
        on_progress(18.0, "Program master L1 copy…")
    _log.info(
        "[PROGRAM_MASTER] L1a copy segments=%s expected=%.3f",
        segments_count,
        expected_program_end,
    )
    _concat_ffmpeg(
        concat_list,
        tmp_copy,
        reencode=False,
        on_progress=on_progress,
        expected_sec=max(expected_program_end, 1.0),
        timeout_sec=timeout_sec,
    )

    ok, metrics = evaluate_dual_quality_gate(
        tmp_copy,
        expected_program_end,
        segments_count=segments_count,
    )
    metrics["bake_level"] = "l1_copy"
    metrics["export_phase"] = "concat_copy"
    if ok:
        return True, tmp_copy, metrics

    tmp_copy.unlink(missing_ok=True)
    metrics["gate_passed"] = False
    return False, None, metrics


def try_bake_l1_concat_reencode(
    preview_media: Path,
    segments: list[tuple[float, float]],
    job_dir: Path,
    expected_program_end: float,
    *,
    target_ntsc_fps: str = "30000/1001",
    on_progress: ExportProgressCallback | None = None,
    timeout_sec: float = 7200.0,
    first_pass_metrics: dict[str, Any] | None = None,
) -> tuple[bool, Path | None, dict[str, Any]]:
    """L1b — concat demuxer reencode + dual quality gate (optional bypass)."""
    if len(segments) > L1_MAX_SEGMENTS:
        return False, None, {"skipped": True, "reason": "segment_count", "segment_count": len(segments)}

    segs = segments_to_concat_map(segments, expected_program_end)
    if not segs:
        return False, None, {"error": "no_valid_segments"}

    job_dir.mkdir(parents=True, exist_ok=True)
    concat_list = job_dir / "pm_concat_list.txt"
    segments_count = write_concat_demuxer_list(preview_media, segs, concat_list)

    tmp_re = job_dir / "tmp_pmaster_l1_reencode.mp4"
    if on_progress:
        on_progress(32.0, "Program master L1 reencode…")
    _log.info(
        "[PROGRAM_MASTER] L1b reencode segments=%s expected=%.3f",
        segments_count,
        expected_program_end,
    )
    _concat_ffmpeg(
        concat_list,
        tmp_re,
        reencode=True,
        on_progress=on_progress,
        expected_sec=max(expected_program_end, 1.0),
        timeout_sec=timeout_sec,
        target_ntsc_fps=target_ntsc_fps,
    )

    ok, metrics = evaluate_dual_quality_gate(
        tmp_re,
        expected_program_end,
        segments_count=segments_count,
    )
    metrics["bake_level"] = "l1_reencode"
    metrics["export_phase"] = "concat_reencode"
    if first_pass_metrics:
        metrics["first_pass"] = first_pass_metrics

    if ok:
        return True, tmp_re, metrics

    if can_bypass_concat_gate(metrics, expected_program_end, tmp_re):
        metrics["gate_bypassed"] = True
        return True, tmp_re, metrics

    tmp_re.unlink(missing_ok=True)
    metrics["gate_passed"] = False
    return False, None, metrics


def try_bake_program_master_l1(
    preview_media: Path,
    segments: list[tuple[float, float]],
    out_path: Path,
    expected_program_end: float,
    *,
    target_ntsc_fps: str = "30000/1001",
    on_progress: ExportProgressCallback | None = None,
    timeout_sec: float = 7200.0,
) -> tuple[bool, str, dict[str, Any]]:
    """Run L1a → L1b; returns (ok, bake_level, metrics)."""
    job_dir = out_path.parent
    ok, tmp, metrics_a = try_bake_l1_concat_copy(
        preview_media,
        segments,
        job_dir,
        expected_program_end,
        on_progress=on_progress,
        timeout_sec=timeout_sec,
    )
    if ok and tmp:
        tmp.replace(out_path)
        return True, "l1_copy", metrics_a

    try:
        ok, tmp, metrics_b = try_bake_l1_concat_reencode(
            preview_media,
            segments,
            job_dir,
            expected_program_end,
            target_ntsc_fps=target_ntsc_fps,
            on_progress=on_progress,
            timeout_sec=timeout_sec,
            first_pass_metrics=metrics_a,
        )
    except ConcatQualityGateError as exc:
        return False, "filter", exc.metrics or metrics_a

    if ok and tmp:
        tmp.replace(out_path)
        return True, "l1_reencode", metrics_b

    return False, "filter", metrics_b
