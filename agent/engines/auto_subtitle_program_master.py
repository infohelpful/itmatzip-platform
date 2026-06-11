"""V5 — bake program-master.mp4 from media-cfr + programClips (preview/export SSOT)."""

from __future__ import annotations

import logging
import os
import shutil
import uuid
from pathlib import Path
from typing import Any, Callable

from common.bin_manager import get_ffmpeg_executable, prepend_ffmpeg_bin_to_env
from common.subprocess_util import no_window_creationflags
from engines.auto_subtitle import WORKSPACE_ROOT, ensure_workspace
from engines.auto_subtitle_burn_in import (
    _burn_in_audio_output_args,
    _probe_has_audio,
    select_burn_in_h264_encoder,
)
from engines.auto_subtitle_export import ExportProgressCallback, _run_ffmpeg_with_progress
from engines.auto_subtitle_media_probe import probe_media_timing
from engines.auto_subtitle_program_clips import (
    EXPORT_SCHEMA_VERSION,
    build_filter_program_av_chain_chunked,
    normalize_program_clips,
    program_clips_to_literal_bake_segments,
    validate_literal_bake_segments,
)

_log = logging.getLogger(__name__)

BAKE_OUTPUT_NAME = "program-master.mp4"
L0_START_EPS = 0.02
L0_END_EPS = 0.05
DURATION_PROBE_EPS = 0.08
L1_MAX_SEGMENTS = 128


def _duration_gate_ok(expected: float, actual: float) -> bool:
    if expected <= 0 or actual <= 0:
        return True
    return abs(actual - expected) <= DURATION_PROBE_EPS


def _finalize_bake_metrics(
    *,
    bake_level: str,
    raw_seg_count: int,
    filter_segment_count: int,
    expected: float,
    actual: float,
    probe_out: dict[str, Any],
    encoder: str,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "export_schema_version": EXPORT_SCHEMA_VERSION,
        "raw_clip_count": raw_seg_count,
        "filter_segment_count": filter_segment_count,
        "literal_bake_parity": raw_seg_count == filter_segment_count,
        "chunked": filter_segment_count > L1_MAX_SEGMENTS,
        "expected_program_sec": expected,
        "actual_duration_sec": actual,
        "encoder": encoder,
        "bake_level": bake_level,
        "probe_ok": bool(probe_out.get("ok")),
    }
    if extra:
        metrics.update(extra)
    return metrics


def _probe_playback_duration_sec(probe: dict[str, Any]) -> float:
    for key in (
        "playback_duration_sec",
        "video_duration_sec",
        "audio_duration_sec",
        "format_duration_sec",
    ):
        try:
            v = float(probe.get(key) or 0)
        except (TypeError, ValueError):
            continue
        if v > 0:
            return v
    return 0.0


def try_bake_program_master_l0_copy(
    preview_media: Path,
    out_path: Path,
    segments: list[tuple[float, float]],
    probe: dict[str, Any],
) -> bool:
    """L0 — full-span identity: hardlink or copy, no re-encode."""
    if len(segments) != 1:
        return False
    start, end = segments[0]
    input_dur = _probe_playback_duration_sec(probe)
    if start > L0_START_EPS:
        return False
    if input_dur > 0 and end < input_dur - L0_END_EPS:
        return False
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_name(f"{out_path.stem}.tmp{out_path.suffix}")
    if tmp.is_file():
        tmp.unlink(missing_ok=True)
    try:
        os.link(preview_media, tmp)
    except OSError:
        shutil.copy2(preview_media, tmp)
    tmp.replace(out_path)
    return out_path.is_file() and out_path.stat().st_size > 0


def bake_program_master(
    preview_media: Path,
    program_clips: list[dict[str, Any]],
    job_dir: Path,
    *,
    target_ntsc_fps: str = "30000/1001",
    program_duration_sec: float | None = None,
    on_progress: ExportProgressCallback | None = None,
    timeout_sec: float = 7200.0,
) -> tuple[Path, float, dict[str, Any]]:
    """Returns (master_path, actual_duration_sec, metrics)."""
    preview_media = preview_media.resolve()
    if not preview_media.is_file():
        raise FileNotFoundError(f"preview_media_path를 찾을 수 없습니다: {preview_media}")

    job_dir.mkdir(parents=True, exist_ok=True)
    out_path = job_dir / BAKE_OUTPUT_NAME
    fps_expr = str(target_ntsc_fps or "30000/1001").strip() or "30000/1001"

    clips = normalize_program_clips(program_clips)
    if not clips:
        raise ValueError("program_clips가 비어 있습니다.")

    raw_seg_count = len(clips)
    segments = program_clips_to_literal_bake_segments(clips)
    validate_literal_bake_segments(
        clips,
        segments,
        program_duration_sec=program_duration_sec,
    )
    if not segments:
        raise ValueError("유효한 program clip segment가 없습니다.")

    probe = probe_media_timing(preview_media, unify_ssot=True)
    has_audio = _probe_has_audio(probe)

    expected = float(program_duration_sec or 0)
    if expected <= 0 and clips:
        expected = float(clips[-1].get("programEnd") or 0)
    if expected <= 0:
        expected = sum(e - s for s, e in segments)

    bake_level = "filter"
    encoder = "copy"

    if try_bake_program_master_l0_copy(preview_media, out_path, segments, probe):
        bake_level = "l0_copy"
        if on_progress:
            on_progress(100.0, "Program master (L0 copy)")
        probe_out = probe_media_timing(out_path, unify_ssot=True)
        actual = _probe_playback_duration_sec(probe_out) or expected
        if _duration_gate_ok(expected, actual):
            metrics = _finalize_bake_metrics(
                bake_level=bake_level,
                raw_seg_count=raw_seg_count,
                filter_segment_count=len(segments),
                expected=expected,
                actual=actual,
                probe_out=probe_out,
                encoder=encoder,
            )
            _log.info("[PROGRAM_MASTER] L0 done path=%s actual=%.3f", out_path.name, actual)
            return out_path.resolve(), actual, metrics
        _log.warning(
            "[PROGRAM_MASTER] L0 duration mismatch expected=%.3f actual=%.3f — L1 fallback",
            expected,
            actual,
        )
        out_path.unlink(missing_ok=True)
        bake_level = "filter"

    if len(segments) <= L1_MAX_SEGMENTS:
        from engines.auto_subtitle_program_bake_l1 import try_bake_program_master_l1

        l1_ok, l1_level, l1_metrics = try_bake_program_master_l1(
            preview_media,
            segments,
            out_path,
            expected,
            target_ntsc_fps=fps_expr,
            on_progress=on_progress,
            timeout_sec=timeout_sec,
        )
        if l1_ok and out_path.is_file():
            bake_level = l1_level
            encoder = "copy" if l1_level == "l1_copy" else "libx264"
            if on_progress:
                on_progress(88.0, f"Program master ({l1_level})")
            probe_out = probe_media_timing(out_path, unify_ssot=True)
            actual = _probe_playback_duration_sec(probe_out) or expected
            if _duration_gate_ok(expected, actual):
                metrics = _finalize_bake_metrics(
                    bake_level=bake_level,
                    raw_seg_count=raw_seg_count,
                    filter_segment_count=len(segments),
                    expected=expected,
                    actual=actual,
                    probe_out=probe_out,
                    encoder=encoder,
                    extra={"l1": l1_metrics},
                )
                _log.info(
                    "[PROGRAM_MASTER] %s done path=%s actual=%.3f",
                    bake_level,
                    out_path.name,
                    actual,
                )
                return out_path.resolve(), actual, metrics
            _log.warning(
                "[PROGRAM_MASTER] %s duration mismatch expected=%.3f actual=%.3f — filter fallback",
                bake_level,
                expected,
                actual,
            )
            out_path.unlink(missing_ok=True)
            bake_level = "filter"
        elif l1_metrics.get("skipped"):
            _log.info(
                "[PROGRAM_MASTER] L1 skipped reason=%s count=%s",
                l1_metrics.get("reason"),
                l1_metrics.get("segment_count", len(segments)),
            )

    chain, audio_label = build_filter_program_av_chain_chunked(
        segments,
        fps_expr,
        probe,
        has_audio=has_audio,
        force_fps=True,
    )

    ffmpeg = get_ffmpeg_executable()
    prepend_ffmpeg_bin_to_env(os.environ)
    encoder = select_burn_in_h264_encoder(str(ffmpeg))

    if on_progress:
        on_progress(12.0, f"Program master 굽기… (segments={len(segments)})")

    cmd = [
        str(ffmpeg),
        "-y",
        "-hide_banner",
        "-i",
        str(preview_media),
        "-filter_complex",
        chain,
        "-map",
        "[vmain]",
    ]
    if audio_label:
        cmd.extend(["-map", audio_label])
    else:
        cmd.extend(["-map", "0:a?"])
    cmd.extend(
        [
            "-c:v",
            encoder,
            "-preset",
            "p4" if "nvenc" in encoder else "fast",
        ]
    )
    if "nvenc" in encoder:
        cmd.extend(["-rc", "vbr", "-cq", "19", "-b:v", "0"])
    else:
        cmd.extend(["-crf", "20"])
    if audio_label:
        cmd.extend(["-c:a", "aac", "-b:a", "192k"])
    else:
        cmd.extend(["-c:a", "copy"])
    if expected > 0:
        cmd.extend(["-t", f"{expected:.6f}"])
    cmd.extend(["-progress", "pipe:2", "-nostats", str(out_path)])

    _log.info(
        "[PROGRAM_MASTER] bake input=%s segments=%s raw_clips=%s encoder=%s expected=%.3f",
        preview_media.name,
        len(segments),
        raw_seg_count,
        encoder,
        expected,
    )
    _run_ffmpeg_with_progress(
        cmd,
        expected_sec=max(expected, 1.0),
        on_progress=on_progress,
        timeout_sec=timeout_sec,
    )

    probe_out = probe_media_timing(out_path, unify_ssot=True)
    actual = 0.0
    if probe_out.get("ok"):
        try:
            actual = float(
                probe_out.get("playback_duration_sec")
                or probe_out.get("video_duration_sec")
                or 0
            )
        except (TypeError, ValueError):
            actual = 0.0
    if actual <= 0:
        actual = expected

    probe_ok = bool(probe_out.get("ok"))
    if expected > 0 and actual > 0 and abs(actual - expected) > DURATION_PROBE_EPS:
        _log.warning(
            "[PROGRAM_MASTER] duration mismatch expected=%.3f actual=%.3f",
            expected,
            actual,
        )
    metrics = _finalize_bake_metrics(
        bake_level=bake_level,
        raw_seg_count=raw_seg_count,
        filter_segment_count=len(segments),
        expected=expected,
        actual=actual,
        probe_out=probe_out,
        encoder=encoder,
    )
    _log.info("[PROGRAM_MASTER] done path=%s actual=%.3f level=%s", out_path.name, actual, bake_level)
    return out_path.resolve(), actual, metrics


def bake_program_master_workspace(
    preview_media: Path,
    program_clips: list[dict[str, Any]],
    *,
    target_ntsc_fps: str = "30000/1001",
    program_duration_sec: float | None = None,
    on_progress: ExportProgressCallback | None = None,
    timeout_sec: float = 7200.0,
) -> tuple[Path, float, dict[str, Any]]:
    ensure_workspace()
    job_dir = WORKSPACE_ROOT / f"pmaster-{uuid.uuid4().hex[:10]}"
    return bake_program_master(
        preview_media,
        program_clips,
        job_dir,
        target_ntsc_fps=target_ntsc_fps,
        program_duration_sec=program_duration_sec,
        on_progress=on_progress,
        timeout_sec=timeout_sec,
    )
