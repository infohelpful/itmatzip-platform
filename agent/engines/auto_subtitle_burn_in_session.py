"""웹에서 업로드한 자막 프레임 → 단일 패스 번인 작업."""

from __future__ import annotations

import json
import logging
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from common.bin_manager import get_ffmpeg_executable
from engines import auto_subtitle
from engines.auto_subtitle_burn_in import (
    estimate_burn_in_overlay_duration,
    exceeds_fast_path_segment_limit,
    get_subtitle_render_dimensions,
    normalize_keep_segments,
    run_single_pass_subtitle_burn_in,
    select_burn_in_h264_encoder,
    virtual_audio_map_needs_filter_program,
    MAX_FILTER_CONCAT_SEGMENTS,
)
from engines.auto_subtitle_export import (
    _set_export_job,
    get_active_burn_in_media_contract,
    probe_video_dimensions,
    update_burn_in_diagnostics,
)
from engines.auto_subtitle_burn_in_media_contract import contract_export_fps
from engines.auto_subtitle_formats import normalize_cut_ranges
from engines.auto_subtitle_burn_in_pipeline_diag import (
    burn_in_pipeline_diag,
    probe_summary_for_diag,
)
from engines.auto_subtitle_media_probe import parse_ntsc_fps_fraction, probe_media_timing

_log = logging.getLogger(__name__)

_BURN_IN_UI_PROGRESS_MIN = 45.0
_BURN_IN_UI_PROGRESS_MAX = 99.0


def map_burn_in_progress_to_export_ui(pct: float) -> float:
    """내부 burn-in 진행률(8–100) → export UI(45–99)."""
    p = float(pct)
    if p <= 8.0:
        return _BURN_IN_UI_PROGRESS_MIN
    if p >= 100.0:
        return 100.0
    if p <= 32.0:
        return _BURN_IN_UI_PROGRESS_MIN + (p - 8.0) * (8.0 / 24.0)
    if p <= 45.0:
        return 53.0 + (p - 32.0) * (7.0 / 13.0)
    if p <= 60.0:
        return 60.0 + (p - 45.0) * (15.0 / 15.0)
    return 75.0 + (p - 60.0) * (24.0 / 39.0)


_session_lock = threading.RLock()
_sessions: dict[str, "BurnInSession"] = {}
_hold_linked_session_ids: set[str] = set()


@dataclass
class BurnInSession:
    job_id: str
    job_dir: Path
    media_path: Path
    output_path: Path
    full_w: int
    full_h: int
    render_w: int
    render_h: int
    duration_sec: float
    export_fps: float = 30.0
    frame_meta: dict[int, dict[str, float]] = field(default_factory=dict)


def create_session(
    video_path: Path,
    *,
    burn_in_media_contract: dict[str, Any] | None = None,
) -> BurnInSession:
    auto_subtitle.ensure_workspace()
    media = video_path.resolve()
    if not media.is_file():
        raise FileNotFoundError(f"영상 파일을 찾을 수 없습니다: {media}")
    full_w, full_h, dur = probe_video_dimensions(media)
    render_w, render_h = get_subtitle_render_dimensions(full_w, full_h)
    probe = probe_media_timing(media)
    contract = burn_in_media_contract or get_active_burn_in_media_contract()
    if contract:
        export_fps = contract_export_fps(contract)
    else:
        export_fps = parse_ntsc_fps_fraction(
            str(probe.get("target_ntsc_fps") or "") if probe.get("ok") else None
        )
    job_id = uuid.uuid4().hex[:12]
    job_dir = auto_subtitle.WORKSPACE_ROOT / f"burn-{job_id}"
    job_dir.mkdir(parents=True, exist_ok=True)
    out = job_dir / f"{media.stem}_AutoSubtitle.mp4"
    sess = BurnInSession(
        job_id=job_id,
        job_dir=job_dir,
        media_path=media,
        output_path=out,
        full_w=full_w,
        full_h=full_h,
        render_w=render_w,
        render_h=render_h,
        duration_sec=dur,
        export_fps=export_fps,
    )
    with _session_lock:
        _sessions[job_id] = sess
    burn_in_pipeline_diag(
        "prepare_session",
        job_id=job_id,
        media_path=str(media),
        duration_sec=dur,
        export_fps=export_fps,
        render_w=render_w,
        render_h=render_h,
        probe=probe_summary_for_diag(probe),
    )
    return sess


def register_hold_linked_session(job_id: str) -> None:
    """Track burn-in session created during video export awaiting_frames Hold."""
    with _session_lock:
        _hold_linked_session_ids.add(job_id)


def cleanup_hold_linked_sessions() -> None:
    """Remove burn-in sessions registered under export Hold (Abandon / failure)."""
    with _session_lock:
        ids = list(_hold_linked_session_ids)
        _hold_linked_session_ids.clear()
    for job_id in ids:
        with _session_lock:
            sess = _sessions.pop(job_id, None)
        if sess is None:
            continue
        try:
            if sess.job_dir.is_dir():
                import shutil

                shutil.rmtree(sess.job_dir, ignore_errors=True)
        except OSError:
            pass


def get_session(job_id: str) -> BurnInSession:
    with _session_lock:
        sess = _sessions.get(job_id)
    if sess is None:
        raise KeyError(f"burn-in 세션을 찾을 수 없습니다: {job_id}")
    return sess


def save_frame(job_id: str, index: int, start: float, end: float, payload: bytes) -> None:
    sess = get_session(job_id)
    if index < 0:
        raise ValueError("index must be >= 0")
    if payload[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("PNG 자막 프레임이 필요합니다.")
    frame_path = sess.job_dir / f"frame_{index:04d}.png"
    frame_path.write_bytes(payload)
    meta = {"start": float(start), "end": float(end)}
    (sess.job_dir / f"frame_{index:04d}.meta.json").write_text(
        json.dumps(meta, ensure_ascii=False),
        encoding="utf-8",
    )
    with _session_lock:
        sess.frame_meta[index] = meta
    from engines.auto_subtitle_export import touch_video_export_idle_activity

    touch_video_export_idle_activity()


def _ordered_frame_paths_and_timing(sess: BurnInSession) -> tuple[list[Path], list[dict[str, float]]]:
    indices = sorted(sess.frame_meta.keys())
    if not indices:
        raise ValueError("업로드된 자막 프레임이 없습니다.")
    paths: list[Path] = []
    timing: list[dict[str, float]] = []
    for i in indices:
        meta = sess.frame_meta[i]
        path_png = sess.job_dir / f"frame_{i:04d}.png"
        path_rgba = sess.job_dir / f"frame_{i:04d}.rgba"
        if path_png.is_file():
            path = path_png
        elif path_rgba.is_file():
            path = path_rgba
        else:
            raise FileNotFoundError(f"프레임 파일 없음: {path_png}")
        paths.append(path)
        timing.append({"start": meta["start"], "end": meta["end"]})
    return paths, timing


def _burn_in_worker(
    sess: BurnInSession,
    *,
    cut_ranges: list[dict[str, Any]] | None,
    virtual_audio_map: list[dict[str, Any]] | None = None,
    requires_concat: bool = False,
    export_time_axis: str | None = None,
    program_duration_sec: float | None = None,
    watermark_path: Path | None = None,
    watermark_position: str | None = None,
) -> None:
    try:
        def report(pct: float, msg: str) -> None:
            _set_export_job(
                "running",
                map_burn_in_progress_to_export_ui(pct),
                msg,
                fmt="video",
            )

        report(8.0, "자막 프레임 준비…")
        frame_paths, timing = _ordered_frame_paths_and_timing(sess)
        mapped_end = max((t["end"] for t in timing), default=1.0)
        expected_program_end = mapped_end
        export_time_axis_local = str(export_time_axis or "").strip()
        is_program_axis = export_time_axis_local == "program"
        requires_concat_flag = False if is_program_axis else bool(requires_concat)
        vmap = [] if is_program_axis else list(virtual_audio_map or [])
        cuts = normalize_cut_ranges(cut_ranges)
        overlay_mode: str | None = None

        if (
            not is_program_axis
            and not requires_concat_flag
            and vmap
            and exceeds_fast_path_segment_limit(vmap)
        ):
            seg_count = len(normalize_keep_segments(vmap))
            raise RuntimeError(
                f"failsafe_concat 비활성: keep_segments={seg_count} > {MAX_FILTER_CONCAT_SEGMENTS}. "
                "V5 program export를 사용하세요 (export_schema_version=5)."
            )

        use_filter_program = False
        if not is_program_axis:
            use_filter_program = (
                not requires_concat_flag
                and virtual_audio_map_needs_filter_program(vmap, float(sess.duration_sec or 0))
            )

        contract = get_active_burn_in_media_contract() or {}
        program_dur = 0.0
        if is_program_axis:
            try:
                program_dur = float(program_duration_sec or contract.get("program_duration_sec") or 0)
            except (TypeError, ValueError):
                program_dur = 0.0
            if program_dur <= 0:
                program_dur = float(sess.duration_sec or 0)
            overlay_dur = max(program_dur, mapped_end, 0.1)
        else:
            overlay_dur = estimate_burn_in_overlay_duration(
                sess.duration_sec,
                cuts,
                mapped_end,
                vmap,
                apply_filter_program=use_filter_program,
            )
        input_dur = float(sess.duration_sec or 0)
        if not is_program_axis:
            if input_dur > 0:
                overlay_dur = min(overlay_dur, mapped_end, input_dur)
            else:
                overlay_dur = min(overlay_dur, mapped_end)
        elif input_dur > 0:
            overlay_dur = min(overlay_dur, input_dur)
        ffmpeg_exe = str(get_ffmpeg_executable())
        encoder = select_burn_in_h264_encoder(ffmpeg_exe)
        update_burn_in_diagnostics(video_encoder=encoder, overlay_mode=overlay_mode)

        _log.info(
            "[BURN_IN] worker_start job_id=%s media=%s input_dur=%.3f overlay_dur=%.3f "
            "mapped_end=%.3f frames=%s encoder=%s render=%dx%d full=%dx%d "
            "requires_concat=%s export_time_axis=%s filter_program=%s map_segments=%s "
            "overlay_mode=%s",
            sess.job_id,
            sess.media_path.name,
            float(sess.duration_sec or 0),
            overlay_dur,
            mapped_end,
            len(frame_paths),
            encoder,
            sess.render_w,
            sess.render_h,
            sess.full_w,
            sess.full_h,
            requires_concat_flag,
            export_time_axis_local,
            use_filter_program,
            len(vmap),
            overlay_mode,
        )
        timing_end = max((float(t["end"]) for t in timing), default=0.0)
        timing_start = min((float(t["start"]) for t in timing), default=0.0)
        burn_in_pipeline_diag(
            "worker_handoff",
            job_id=sess.job_id,
            media_path=str(sess.media_path),
            input_duration_sec=float(sess.duration_sec or 0),
            export_fps=float(sess.export_fps or 0),
            overlay_dur=overlay_dur,
            mapped_end=mapped_end,
            timing_segments=len(timing),
            timing_start=timing_start,
            timing_end=timing_end,
            requires_concat=requires_concat_flag,
            export_time_axis=export_time_axis_local,
            filter_program=use_filter_program,
            virtual_map_segments=len(vmap),
            overlay_mode=overlay_mode,
            timing_scale_applied=False,
        )
        report(28.0, "FFmpeg 자막 번인 준비…")
        run_single_pass_subtitle_burn_in(
            ffmpeg_path=None,
            input_video_path=sess.media_path,
            output_path=sess.output_path,
            full_video_width=sess.full_w,
            full_video_height=sess.full_h,
            render_width=sess.render_w,
            render_height=sess.render_h,
            overlay_duration_sec=overlay_dur,
            frame_paths=frame_paths,
            timing=timing,
            h264_encoder=encoder,
            watermark_path=watermark_path,
            watermark_position=watermark_position,
            export_fps=sess.export_fps,
            on_progress=report,
            virtual_audio_map=vmap if use_filter_program else None,
            requires_concat=requires_concat_flag,
            burn_in_overlay_mode=overlay_mode,
        )
        _log.info(
            "[BURN_IN] worker_done job_id=%s output=%s",
            sess.job_id,
            sess.output_path,
        )
        _set_export_job(
            "completed",
            100.0,
            "영상보내기 완료",
            result_path=str(sess.output_path),
            fmt="video",
        )
    except Exception as exc:
        _log.error(
            "[BURN_IN] worker_failed job_id=%s error=%s",
            sess.job_id,
            exc,
            exc_info=True,
        )
        _set_export_job("failed", 0.0, str(exc), error=str(exc), fmt="video")
    finally:
        from engines import auto_subtitle_runtime
        from engines.auto_subtitle_export import complete_video_export_hold_cleanup

        with _session_lock:
            _sessions.pop(sess.job_id, None)
            _hold_linked_session_ids.discard(sess.job_id)
        complete_video_export_hold_cleanup()
        if auto_subtitle_runtime.get_active_job() == "export":
            auto_subtitle_runtime.end_job()


def finish_and_start_export(
    job_id: str,
    *,
    cut_ranges: list[dict[str, Any]] | None = None,
    virtual_audio_map: list[dict[str, Any]] | None = None,
    requires_concat: bool = False,
    export_time_axis: str | None = None,
    program_duration_sec: float | None = None,
    watermark: dict[str, Any] | None = None,
) -> None:
    from engines import auto_subtitle_runtime

    sess = get_session(job_id)
    if not sess.frame_meta:
        raise ValueError("업로드된 자막 프레임이 없습니다.")

    wm_path: Path | None = None
    wm_position: str | None = None
    if watermark and isinstance(watermark, dict):
        raw_path = str(watermark.get("path") or "").strip()
        if raw_path:
            norm = auto_subtitle.normalize_media_path(raw_path)
            resolved = auto_subtitle.resolve_existing_file(norm)
            if resolved is None:
                raise ValueError(f"워터마크 이미지를 찾을 수 없습니다: {norm}")
            if resolved.suffix.lower() not in auto_subtitle.ALLOWED_IMAGE_SUFFIXES:
                raise ValueError(f"지원하지 않는 워터마크 형식입니다: {resolved.suffix}")
            wm_path = resolved
            wm_position = str(watermark.get("position") or "top-right")

    # V47a — continuous export transaction: skip re-acquire when Lock already held.
    if auto_subtitle_runtime.get_active_job() != "export":
        auto_subtitle_runtime.try_begin_job("export")
    _set_export_job("queued", 0.0, "영상 번인 대기…", fmt="video")

    def _target() -> None:
        _burn_in_worker(
            sess,
            cut_ranges=cut_ranges,
            virtual_audio_map=virtual_audio_map,
            requires_concat=requires_concat,
            export_time_axis=export_time_axis,
            program_duration_sec=program_duration_sec,
            watermark_path=wm_path,
            watermark_position=wm_position,
        )

    import threading

    threading.Thread(target=_target, daemon=True).start()
