"""Burn-in Media Contract — program→burnin PTS map, CFR finalize orchestration."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Callable

_log = logging.getLogger(__name__)

ExportProgressCallback = Callable[[float, str], None]

DEFAULT_TARGET_NTSC_FPS = "30000/1001"


def normalize_contract(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Merge FE contract with defaults."""
    data = dict(raw or {})
    fps = str(data.get("target_ntsc_fps") or DEFAULT_TARGET_NTSC_FPS).strip()
    if not fps:
        fps = DEFAULT_TARGET_NTSC_FPS
    out: dict[str, Any] = {
        "target_ntsc_fps": fps,
        "preview_duration_sec": data.get("preview_duration_sec"),
        "timeline_axis": str(data.get("timeline_axis") or "preview_cfr"),
    }
    if data.get("program_to_burnin_map") is not None:
        out["program_to_burnin_map"] = data["program_to_burnin_map"]
    return out


def extract_valid_program_segments(
    virtual_audio_map: list[dict[str, Any]] | None,
) -> list[dict[str, float]]:
    """Segments aligned with concat demuxer list (source inpoint/outpoint valid)."""
    out: list[dict[str, float]] = []
    for raw in virtual_audio_map or []:
        if not isinstance(raw, dict):
            continue
        try:
            src_start = float(raw.get("sourceStart", raw.get("source_start", 0)))
            src_end = float(raw.get("sourceEnd", raw.get("source_end", 0)))
            edit_start = float(raw.get("editStart", raw.get("edit_start", 0)))
            edit_end = float(raw.get("editEnd", raw.get("edit_end", 0)))
        except (TypeError, ValueError):
            continue
        if src_end <= src_start + 1e-5:
            continue
        if edit_end <= edit_start + 1e-6:
            continue
        out.append(
            {
                "edit_start": edit_start,
                "edit_end": edit_end,
                "length": edit_end - edit_start,
            }
        )
    return out


def build_program_to_burnin_map(
    virtual_audio_map: list[dict[str, Any]] | None,
    actual_duration_normalized: float,
) -> list[dict[str, float]]:
    """Length-proportional drift distribution on program axis."""
    segments = extract_valid_program_segments(virtual_audio_map)
    if not segments:
        dur = max(float(actual_duration_normalized or 0), 0.1)
        return build_identity_program_to_burnin_map(dur)

    expected_total = float(segments[-1]["edit_end"])
    if expected_total <= 0:
        expected_total = sum(float(s["length"]) for s in segments)
    if expected_total <= 0:
        dur = max(float(actual_duration_normalized or 0), 0.1)
        return build_identity_program_to_burnin_map(dur)

    actual = float(actual_duration_normalized)
    drift_total = actual - expected_total
    cumulative_drift = 0.0
    rows: list[dict[str, float]] = []

    for i, seg in enumerate(segments):
        length = float(seg["length"])
        edit_start = float(seg["edit_start"])
        edit_end = float(seg["edit_end"])
        drift_i = drift_total * (length / expected_total) if expected_total > 0 else 0.0
        pts_start_theo = edit_start
        pts_start_actual = pts_start_theo + cumulative_drift
        pts_end_actual = pts_start_actual + length + drift_i
        rows.append(
            {
                "index": float(i),
                "editStart": edit_start,
                "editEnd": edit_end,
                "ptsStartTheoretical": pts_start_theo,
                "ptsStartActual": pts_start_actual,
                "ptsEndActual": pts_end_actual,
                "driftSegment": drift_i,
            }
        )
        cumulative_drift += drift_i

    if rows:
        last_end = rows[-1]["ptsEndActual"]
        delta = actual - last_end
        if abs(delta) > 1e-4:
            rows[-1]["ptsEndActual"] = last_end + delta
            rows[-1]["driftSegment"] = float(rows[-1]["driftSegment"]) + delta

    return rows


def build_identity_program_to_burnin_map(duration_sec: float) -> list[dict[str, float]]:
    dur = max(float(duration_sec or 0), 0.1)
    return [
        {
            "index": 0.0,
            "editStart": 0.0,
            "editEnd": dur,
            "ptsStartTheoretical": 0.0,
            "ptsStartActual": 0.0,
            "ptsEndActual": dur,
            "driftSegment": 0.0,
        }
    ]


def validate_map_segment_alignment(
    virtual_audio_map: list[dict[str, Any]] | None,
    program_map: list[dict[str, Any]],
) -> None:
    """Raise when concat-valid segment count diverges from map."""
    valid = extract_valid_program_segments(virtual_audio_map)
    if not valid:
        return
    if len(valid) != len(program_map):
        raise ValueError(
            f"program_to_burnin_map segment count mismatch: map={len(program_map)} "
            f"virtual_valid={len(valid)}"
        )


def finalize_burnin_media_for_export(
    burn_input: Path,
    job_dir: Path,
    *,
    concat_phase: str | None,
    target_ntsc_fps: str,
    virtual_audio_map: list[dict[str, Any]] | None,
    requires_concat: bool,
    on_progress: ExportProgressCallback | None = None,
    timeout_sec: float = 7200.0,
) -> tuple[Path, float, list[dict[str, float]], dict[str, Any]]:
    """Normalize (if needed), re-probe, build program_to_burnin_map."""
    from engines.auto_subtitle_export import probe_video_dimensions
    from engines.auto_subtitle_media_normalize import normalize_burnin_media
    from engines.auto_subtitle_media_probe import probe_media_timing

    target_fps = str(target_ntsc_fps or DEFAULT_TARGET_NTSC_FPS).strip() or DEFAULT_TARGET_NTSC_FPS
    out_path = burn_input.resolve()
    job_dir.mkdir(parents=True, exist_ok=True)

    if concat_phase == "concat_copy":
        if on_progress:
            on_progress(38.0, "CFR 정규화…")
        normalized = job_dir / "burnin_cfr_normalized.mp4"
        normalize_burnin_media(
            out_path,
            normalized,
            target_ntsc_fps=target_fps,
            on_progress=on_progress,
            timeout_sec=timeout_sec,
        )
        out_path = normalized.resolve()
    elif concat_phase == "concat_reencode":
        pass
    else:
        probe_pre = probe_media_timing(out_path)
        if probe_pre.get("needs_vfr_normalize") or probe_pre.get("vfr_suspected"):
            if on_progress:
                on_progress(35.0, "Fast-Path CFR 정규화…")
            normalized = job_dir / "burnin_cfr_normalized.mp4"
            normalize_burnin_media(
                out_path,
                normalized,
                target_ntsc_fps=target_fps,
                on_progress=on_progress,
                timeout_sec=timeout_sec,
            )
            out_path = normalized.resolve()

    probe = probe_media_timing(out_path, unify_ssot=True)
    actual = 0.0
    if probe.get("ok"):
        try:
            actual = float(probe.get("playback_duration_sec") or probe.get("video_duration_sec") or 0)
        except (TypeError, ValueError):
            actual = 0.0
    if actual <= 0:
        _, _, probed = probe_video_dimensions(out_path)
        actual = float(probed or 0)
    if actual <= 0:
        raise RuntimeError("burn-in 미디어 duration probe 실패")

    valid_segs = extract_valid_program_segments(virtual_audio_map)
    if valid_segs:
        pmap = build_program_to_burnin_map(virtual_audio_map, actual)
        validate_map_segment_alignment(virtual_audio_map, pmap)
    else:
        pmap = build_identity_program_to_burnin_map(actual)

    _log.info(
        "[BURN_IN_CONTRACT] finalize path=%s concat_phase=%s actual=%.3f map_segments=%s vfr=%s",
        out_path.name,
        concat_phase,
        actual,
        len(pmap),
        probe.get("vfr_suspected"),
    )
    return out_path, actual, pmap, probe


def contract_export_fps(contract: dict[str, Any] | None) -> float:
    from engines.auto_subtitle_media_probe import parse_ntsc_fps_fraction

    fps_raw = str((contract or {}).get("target_ntsc_fps") or DEFAULT_TARGET_NTSC_FPS)
    return parse_ntsc_fps_fraction(fps_raw)
