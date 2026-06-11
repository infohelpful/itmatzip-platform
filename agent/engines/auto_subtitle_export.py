"""FFmpeg 기반 자막·영상·오디오보내기."""

from __future__ import annotations

import json
import logging
import platform
import shutil
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

_log = logging.getLogger(__name__)

# V47a — awaiting_frames Idle Abandon guard (seconds)
AWAITING_FRAMES_IDLE_SEC = 1800.0

from common.bin_manager import get_ffmpeg_executable, get_ffprobe_executable, prepend_ffmpeg_bin_to_env
from common.subprocess_util import no_window_creationflags, run_hidden
from engines.auto_subtitle import RUNTIME_TOOL_ID, WORKSPACE_ROOT, ensure_workspace
from engines.auto_subtitle_formats import (
    SubtitleStyle,
    build_ass_text,
    build_text_export,
    cues_to_mapped,
    normalize_cut_ranges,
)

ExportProgressCallback = Callable[[float, str], None]

_export_lock = threading.RLock()
_export_thread: threading.Thread | None = None


@dataclass
class ExportJobStatus:
    phase: str
    progress: float
    message: str | None = None
    result_path: str | None = None
    format: str | None = None
    error: str | None = None
    burnin_media_path: str | None = None
    export_time_axis: str | None = None
    actual_duration: float | None = None
    video_encoder: str | None = None
    overlay_mode: str | None = None
    burn_in_media_contract: dict[str, Any] | None = None
    program_to_burnin_map: list[dict[str, Any]] | None = None


_export_job = ExportJobStatus(phase="idle", progress=0.0)

_idle_guard_lock = threading.RLock()
_idle_guard_timer: threading.Timer | None = None
_awaiting_hold_job_dir: Path | None = None


def get_export_job_status() -> ExportJobStatus:
    with _export_lock:
        return ExportJobStatus(
            phase=_export_job.phase,
            progress=_export_job.progress,
            message=_export_job.message,
            result_path=_export_job.result_path,
            format=_export_job.format,
            error=_export_job.error,
            burnin_media_path=_export_job.burnin_media_path,
            export_time_axis=_export_job.export_time_axis,
            actual_duration=_export_job.actual_duration,
            video_encoder=_export_job.video_encoder,
            overlay_mode=_export_job.overlay_mode,
            burn_in_media_contract=_export_job.burn_in_media_contract,
            program_to_burnin_map=_export_job.program_to_burnin_map,
        )


def get_active_burn_in_media_contract() -> dict[str, Any] | None:
    with _export_lock:
        return dict(_export_job.burn_in_media_contract) if _export_job.burn_in_media_contract else None


def is_video_export_hold_active() -> bool:
    """True when video export awaits PNG frames (Lock must stay held)."""
    with _export_lock:
        return _export_job.format == "video" and _export_job.phase == "awaiting_frames"


def _cancel_awaiting_idle_guard() -> None:
    global _idle_guard_timer
    with _idle_guard_lock:
        if _idle_guard_timer is not None:
            _idle_guard_timer.cancel()
            _idle_guard_timer = None


def _cleanup_awaiting_hold_resources() -> None:
    global _awaiting_hold_job_dir
    from engines import auto_subtitle_burn_in_session

    job_dir = _awaiting_hold_job_dir
    _awaiting_hold_job_dir = None
    auto_subtitle_burn_in_session.cleanup_hold_linked_sessions()
    if job_dir is not None and job_dir.is_dir():
        try:
            shutil.rmtree(job_dir, ignore_errors=True)
        except OSError as exc:
            _log.warning("awaiting_hold_cleanup_failed path=%s err=%s", job_dir, exc)


def _on_awaiting_idle_timeout() -> None:
    from engines import auto_subtitle_runtime

    _log.warning("video export awaiting_frames idle timeout (%.0fs)", AWAITING_FRAMES_IDLE_SEC)
    with _export_lock:
        if _export_job.phase != "awaiting_frames":
            return
        _export_job.phase = "failed"
        _export_job.progress = 0.0
        _export_job.message = "프레임 업로드 대기 시간이 초과되었습니다."
        _export_job.error = _export_job.message
        _export_job.burnin_media_path = None
        _export_job.export_time_axis = None
        _export_job.actual_duration = None
        _export_job.burn_in_media_contract = None
        _export_job.program_to_burnin_map = None
    _cancel_awaiting_idle_guard()
    _cleanup_awaiting_hold_resources()
    if auto_subtitle_runtime.get_active_job() == "export":
        auto_subtitle_runtime.end_job()


def _schedule_awaiting_idle_guard() -> None:
    global _idle_guard_timer

    def _fire() -> None:
        _on_awaiting_idle_timeout()

    _cancel_awaiting_idle_guard()
    with _idle_guard_lock:
        _idle_guard_timer = threading.Timer(AWAITING_FRAMES_IDLE_SEC, _fire)
        _idle_guard_timer.daemon = True
        _idle_guard_timer.start()


def touch_video_export_idle_activity() -> None:
    """Reset Idle Abandon timer on prepare / frame / finish activity."""
    if not is_video_export_hold_active():
        return
    _schedule_awaiting_idle_guard()


def enter_video_export_awaiting_hold(
    burnin_media_path: str,
    export_time_axis: str,
    *,
    job_dir: Path | None = None,
    progress: float = 45.0,
    message: str | None = None,
    actual_duration: float | None = None,
    burn_in_media_contract: dict[str, Any] | None = None,
    program_to_burnin_map: list[dict[str, Any]] | None = None,
) -> None:
    """V47b+ — transition to awaiting_frames while retaining export Lock."""
    global _awaiting_hold_job_dir
    axis = export_time_axis.strip() or "media"
    if axis not in {"stitched_program", "media", "filter_program", "program"}:
        axis = "media"
    with _export_lock:
        _export_job.phase = "awaiting_frames"
        _export_job.progress = progress
        _export_job.message = message or "자막 프레임 업로드 대기…"
        _export_job.format = "video"
        _export_job.error = None
        _export_job.burnin_media_path = burnin_media_path
        _export_job.export_time_axis = axis
        if actual_duration is not None and actual_duration > 0:
            _export_job.actual_duration = float(actual_duration)
        else:
            _export_job.actual_duration = None
        if burn_in_media_contract is not None:
            _export_job.burn_in_media_contract = dict(burn_in_media_contract)
        if program_to_burnin_map is not None:
            _export_job.program_to_burnin_map = list(program_to_burnin_map)
    _awaiting_hold_job_dir = job_dir.resolve() if job_dir is not None else None
    _schedule_awaiting_idle_guard()


def fail_video_export_hold_and_release_lock(
    error: str,
    *,
    message: str | None = None,
) -> None:
    """Mark export failed and release global Lock (pre-awaiting failure or finish validation)."""
    from engines import auto_subtitle_runtime

    _cancel_awaiting_idle_guard()
    with _export_lock:
        _export_job.phase = "failed"
        _export_job.progress = 0.0
        _export_job.message = message or error
        _export_job.error = error
        _export_job.burnin_media_path = None
        _export_job.export_time_axis = None
        _export_job.actual_duration = None
        _export_job.burn_in_media_contract = None
        _export_job.program_to_burnin_map = None
    _cleanup_awaiting_hold_resources()
    if auto_subtitle_runtime.get_active_job() == "export":
        auto_subtitle_runtime.end_job()


def complete_video_export_hold_cleanup() -> None:
    """Clear awaiting hold metadata after successful burn-in (Lock released separately)."""
    _cancel_awaiting_idle_guard()
    with _export_lock:
        _export_job.burnin_media_path = None
        _export_job.export_time_axis = None
        _export_job.actual_duration = None
        _export_job.burn_in_media_contract = None
        _export_job.program_to_burnin_map = None
    _cleanup_awaiting_hold_resources()


def export_worker_should_retain_lock() -> bool:
    """Non-video formats always release; video retains only during awaiting_frames Hold."""
    return is_video_export_hold_active()


def _set_export_job(
    phase: str,
    progress: float,
    message: str | None = None,
    *,
    result_path: str | None = None,
    fmt: str | None = None,
    error: str | None = None,
    burnin_media_path: str | None = None,
    export_time_axis: str | None = None,
    clear_hold_fields: bool = False,
) -> None:
    with _export_lock:
        prev_phase = _export_job.phase
        _export_job.phase = phase
        _export_job.progress = progress
        _export_job.message = message
        if result_path is not None or phase in {"idle", "failed", "completed"}:
            _export_job.result_path = result_path
        if fmt is not None:
            _export_job.format = fmt
        _export_job.error = error if phase == "failed" else None
        if burnin_media_path is not None:
            _export_job.burnin_media_path = burnin_media_path
        if export_time_axis is not None:
            _export_job.export_time_axis = export_time_axis
        if clear_hold_fields or phase in {"idle", "failed", "completed"}:
            if phase != "awaiting_frames":
                _export_job.burnin_media_path = None
                _export_job.export_time_axis = None
                _export_job.actual_duration = None
                _export_job.video_encoder = None
                _export_job.overlay_mode = None
                _export_job.burn_in_media_contract = None
                _export_job.program_to_burnin_map = None
        if prev_phase == "awaiting_frames" and phase != "awaiting_frames":
            _cancel_awaiting_idle_guard()


def update_burn_in_diagnostics(
    *,
    video_encoder: str | None = None,
    overlay_mode: str | None = None,
) -> None:
    """V6 — 번인 인코더·overlay 모드 status 노출."""
    with _export_lock:
        if video_encoder is not None:
            _export_job.video_encoder = video_encoder
        if overlay_mode is not None:
            _export_job.overlay_mode = overlay_mode


def probe_video_dimensions(path: Path, *, timeout_sec: float = 30.0) -> tuple[int, int, float]:
    """(width, height, duration_sec) — 비디오 없으면 기본값."""
    ffprobe = get_ffprobe_executable()
    proc = run_hidden(
        [
            str(ffprobe),
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=timeout_sec,
    )
    if proc.returncode != 0:
        return 1920, 1080, 0.0
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return 1920, 1080, 0.0
    streams = data.get("streams") or []
    w, h = 1920, 1080
    if streams:
        try:
            w = int(streams[0].get("width") or w)
            h = int(streams[0].get("height") or h)
        except (TypeError, ValueError):
            pass
    dur = 0.0
    try:
        dur = float((data.get("format") or {}).get("duration") or 0)
    except (TypeError, ValueError):
        dur = 0.0
    return max(320, w), max(240, h), max(0.0, dur)


def write_text_export_file(
    fmt: str,
    cues: list[dict[str, Any]],
    *,
    cut_ranges: list[dict[str, Any]] | None = None,
    style: dict[str, Any] | None = None,
    stem: str = "subtitles",
) -> Path:
    ensure_workspace()
    job_dir = WORKSPACE_ROOT / f"export-{uuid.uuid4().hex[:10]}"
    job_dir.mkdir(parents=True, exist_ok=True)
    ext = {"srt": ".srt", "vtt": ".vtt", "ass": ".ass", "txt": ".txt"}.get(fmt.lower(), ".txt")
    out = job_dir / f"{stem}{ext}"
    content = build_text_export(fmt, cues, cut_ranges=cut_ranges, style=style)
    encoding = "utf-8-sig" if fmt.lower() in {"srt", "txt"} else "utf-8"
    out.write_text(content, encoding=encoding)
    return out.resolve()


def _escape_subtitles_filter_path(path: Path) -> str:
    """FFmpeg subtitles/ass 필터용 Windows 경로."""
    s = str(path.resolve()).replace("\\", "/")
    s = s.replace(":", "\\:")
    s = s.replace("'", "\\'")
    return s


def _emit_export_progress_stderr(value: float, phase: str) -> None:
    """AutoSubtitle sidecar — stderr `export_progress` JSON."""
    v = max(0.0, min(100.0, float(value)))
    line = json.dumps(
        {"type": "export_progress", "value": round(v, 2), "phase": phase},
        ensure_ascii=False,
    )
    print(line, file=sys.stderr, flush=True)


def _parse_stderr_progress_line(line: str, expected_sec: float) -> tuple[float | None, str | None]:
    stripped = line.strip()
    if stripped.startswith("{") and '"type"' in stripped:
        try:
            j = json.loads(stripped)
            if j.get("type") == "export_progress" and isinstance(j.get("value"), (int, float)):
                phase = j.get("phase") if isinstance(j.get("phase"), str) else None
                return float(j["value"]), phase
        except json.JSONDecodeError:
            pass
    if stripped.startswith("out_time_ms="):
        try:
            raw = int(stripped.split("=", 1)[1].strip())
            expected_ms = max(1, int(expected_sec * 1000))
            return max(0.0, min(99.0, (raw / expected_ms) * 100.0)), None
        except (ValueError, IndexError):
            pass
    return None, None


def show_result_in_folder(path: Path) -> None:
    """Electron shell.showItemInFolder — 결과 파일을 탐색기에서 선택."""
    resolved = path.resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"파일을 찾을 수 없습니다: {resolved}")
    system = platform.system()
    if system == "Windows":
        subprocess.run(["explorer", "/select,", str(resolved)], check=False)
        return
    if system == "Darwin":
        subprocess.run(["open", "-R", str(resolved)], check=False)
        return
    subprocess.run(["xdg-open", str(resolved.parent)], check=False)


def _run_ffmpeg_with_progress(
    args: list[str],
    *,
    expected_sec: float,
    on_progress: ExportProgressCallback | None,
    timeout_sec: float = 7200.0,
) -> None:
    import os
    import subprocess

    from common.subprocess_util import agent_subprocess_env

    env = agent_subprocess_env({"ITMATZIP_RUNTIME_TOOL": RUNTIME_TOOL_ID})
    prepend_ffmpeg_bin_to_env(env)
    proc = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=no_window_creationflags(),
        env=env,
    )
    stderr_chunks: list[str] = []
    last_pct = -1.0
    deadline = time.perf_counter() + timeout_sec
    while proc.poll() is None:
        if time.perf_counter() > deadline:
            proc.kill()
            raise TimeoutError("FFmpeg보내기 시간 초과")
        if proc.stderr:
            line = proc.stderr.readline()
            if line:
                stderr_chunks.append(line)
                pct, phase = _parse_stderr_progress_line(line, expected_sec)
                if pct is not None:
                    msg = phase or "FFmpeg 인코딩 중…"
                    if pct != last_pct:
                        last_pct = pct
                        _emit_export_progress_stderr(pct, msg)
                        if on_progress:
                            on_progress(pct, msg)
        else:
            time.sleep(0.2)
    rest = proc.stderr.read() if proc.stderr else ""
    if rest:
        stderr_chunks.append(rest)
    if proc.returncode != 0:
        err = "".join(stderr_chunks)[-4000:]
        raise RuntimeError(f"FFmpeg 실패 (exit {proc.returncode}): {err or 'unknown'}")


def export_video_with_ass(
    media_path: Path,
    cues: list[dict[str, Any]],
    *,
    cut_ranges: list[dict[str, Any]] | None = None,
    style: dict[str, Any] | None = None,
    on_progress: ExportProgressCallback | None = None,
    timeout_sec: float = 7200.0,
    apply_cut_ranges: bool = True,
) -> Path:
    ensure_workspace()
    job_dir = WORKSPACE_ROOT / f"video-{uuid.uuid4().hex[:10]}"
    job_dir.mkdir(parents=True, exist_ok=True)

    w, h, dur = probe_video_dimensions(media_path)
    st_dict = dict(style or {})
    st_dict.setdefault("videoWidth", w)
    st_dict.setdefault("videoHeight", h)
    cuts = cut_ranges if apply_cut_ranges else None
    mapped = cues_to_mapped(cues, cut_ranges=cuts)
    ass_text = build_ass_text(mapped, SubtitleStyle.from_dict(st_dict))
    ass_path = job_dir / "burnin.ass"
    ass_path.write_text(ass_text, encoding="utf-8-sig")

    out_path = job_dir / f"{media_path.stem}_subtitled.mp4"
    ffmpeg = get_ffmpeg_executable()
    ass_esc = _escape_subtitles_filter_path(ass_path)
    vf = f"ass='{ass_esc}'"

    args = [
        str(ffmpeg),
        "-y",
        "-hide_banner",
        "-i",
        str(media_path),
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "23",
        "-c:a",
        "copy",
        "-progress",
        "pipe:2",
        "-nostats",
        str(out_path),
    ]
    if on_progress:
        on_progress(5.0, "영상 자막 합성 준비…")
    _run_ffmpeg_with_progress(args, expected_sec=max(dur, 1.0), on_progress=on_progress, timeout_sec=timeout_sec)
    if on_progress:
        on_progress(100.0, "완료")
    return out_path.resolve()


def export_audio(
    media_path: Path,
    fmt: str,
    *,
    cut_ranges: list[dict[str, Any]] | None = None,
    on_progress: ExportProgressCallback | None = None,
    timeout_sec: float = 3600.0,
) -> Path:
    ensure_workspace()
    job_dir = WORKSPACE_ROOT / f"audio-{uuid.uuid4().hex[:10]}"
    job_dir.mkdir(parents=True, exist_ok=True)
    key = fmt.lower().strip()
    if key not in {"mp3", "wav"}:
        raise ValueError("audio format must be mp3 or wav")
    ext = ".mp3" if key == "mp3" else ".wav"
    out_path = job_dir / f"{media_path.stem}{ext}"
    ffmpeg = get_ffmpeg_executable()
    cuts = normalize_cut_ranges(cut_ranges)
    args = [str(ffmpeg), "-y", "-hide_banner", "-i", str(media_path)]
    if cuts:
        expr = "+".join(
            f"between(t,{c.start:.3f},{c.end:.3f})" for c in cuts
        )
        args.extend(["-af", f"aselect='not({expr})',asetpts=N/SR/TB"])
    args.extend(["-vn"])
    if key == "mp3":
        args.extend(["-c:a", "libmp3lame", "-q:a", "2"])
    else:
        args.extend(["-c:a", "pcm_s16le"])
    args.extend(["-progress", "pipe:2", "-nostats", str(out_path)])

    _, _, dur = probe_video_dimensions(media_path)
    if on_progress:
        on_progress(5.0, "오디오 인코딩…")
    _run_ffmpeg_with_progress(args, expected_sec=max(dur, 1.0), on_progress=on_progress, timeout_sec=timeout_sec)
    if on_progress:
        on_progress(100.0, "완료")
    return out_path.resolve()


def export_video_stitched_pipeline(
    preview_media_path: Path,
    *,
    virtual_audio_map: list[dict[str, Any]] | None = None,
    requires_concat: bool = True,
    burn_in_media_contract: dict[str, Any] | None = None,
    on_progress: ExportProgressCallback | None = None,
    timeout_sec: float = 7200.0,
) -> None:
    """V47b — V41 concat master (optional) then Hold for PNG/DOM burn-in (no ASS)."""
    from engines.auto_subtitle_burn_in_media_contract import (
        finalize_burnin_media_for_export,
        normalize_contract,
    )
    from engines.auto_subtitle_export_concat import build_concat_master

    ensure_workspace()
    contract = normalize_contract(burn_in_media_contract)
    target_fps = str(contract.get("target_ntsc_fps") or "30000/1001")
    job_dir = WORKSPACE_ROOT / f"video-{uuid.uuid4().hex[:10]}"
    job_dir.mkdir(parents=True, exist_ok=True)

    if not preview_media_path.is_file():
        raise FileNotFoundError(f"preview_media_path를 찾을 수 없습니다: {preview_media_path}")

    from engines.auto_subtitle_burn_in import (
        exceeds_fast_path_segment_limit,
        normalize_keep_segments,
        MAX_FILTER_CONCAT_SEGMENTS,
    )

    if (
        not bool(requires_concat)
        and virtual_audio_map
        and exceeds_fast_path_segment_limit(virtual_audio_map)
    ):
        seg_count = len(normalize_keep_segments(virtual_audio_map))
        _log.warning(
            "export_override slow-path: requires_concat=false keep_segments=%s > %s",
            seg_count,
            MAX_FILTER_CONCAT_SEGMENTS,
        )
        requires_concat = True

    use_concat = bool(requires_concat)
    burn_input = preview_media_path.resolve()
    hold_job_dir: Path | None = job_dir
    actual_duration: float | None = None
    concat_metrics: dict[str, Any] | None = None
    concat_phase: str | None = None
    program_map: list[dict[str, Any]] | None = None

    if use_concat:
        if not virtual_audio_map:
            raise ValueError("requires_concat=true 인데 virtual_audio_map이 없습니다.")
        _set_export_job("concat_copy", 8.0, "목록 순 미디어 합성…", fmt="video")
        if on_progress:
            on_progress(8.0, "목록 순 미디어 합성…")
        burn_input, concat_phase, metrics = build_concat_master(
            preview_media_path,
            virtual_audio_map,
            job_dir,
            on_progress=on_progress,
            timeout_sec=timeout_sec,
            target_ntsc_fps=target_fps,
        )
        concat_metrics = metrics
        _log_export_metrics(concat_phase, metrics)
        export_time_axis = "stitched_program"
    else:
        if on_progress:
            on_progress(12.0, "Fast-Path 미디어 준비…")
        hold_job_dir = job_dir
        from engines.auto_subtitle_burn_in import virtual_audio_map_needs_filter_program

        _, _, probed_dur = probe_video_dimensions(preview_media_path)
        if virtual_audio_map and virtual_audio_map_needs_filter_program(
            virtual_audio_map, probed_dur
        ):
            export_time_axis = "filter_program"
        else:
            export_time_axis = "media"

    def _normalize_progress(pct: float, msg: str, detail: str = "") -> None:
        label = f"{msg} — {detail}" if detail else msg
        with _export_lock:
            _export_job.phase = "concat_normalize"
            _export_job.progress = float(pct)
            _export_job.message = label
            _export_job.format = "video"

    burn_input, actual_duration, program_map, _probe = finalize_burnin_media_for_export(
        burn_input,
        job_dir,
        concat_phase=concat_phase,
        target_ntsc_fps=target_fps,
        virtual_audio_map=virtual_audio_map,
        requires_concat=use_concat,
        on_progress=_normalize_progress,
        timeout_sec=timeout_sec,
    )
    contract = dict(contract)
    contract["program_to_burnin_map"] = program_map

    enter_video_export_awaiting_hold(
        str(burn_input),
        export_time_axis,
        job_dir=hold_job_dir,
        progress=45.0,
        message="자막 프레임 업로드 대기…",
        actual_duration=actual_duration,
        burn_in_media_contract=contract,
        program_to_burnin_map=program_map,
    )
    from engines.auto_subtitle_burn_in_pipeline_diag import burn_in_pipeline_diag

    burn_in_pipeline_diag(
        "export_awaiting_frames",
        burnin_media_path=str(burn_input),
        export_time_axis=export_time_axis,
        requires_concat=use_concat,
        actual_duration=actual_duration,
        virtual_map_segments=len(virtual_audio_map or []),
        concat_metrics=concat_metrics,
        program_map_segments=len(program_map or []),
        target_ntsc_fps=target_fps,
    )
    # on_progress(report)는 phase=running 으로 덮어써 awaiting_frames 진입을 깨뜨리므로 호출하지 않음.


def export_video_program_ssot_pipeline(
    preview_media_path: Path,
    *,
    program_clips: list[dict[str, Any]] | None = None,
    program_duration_sec: float | None = None,
    program_master_path: Path | None = None,
    target_ntsc_fps: str = "30000/1001",
    on_progress: ExportProgressCallback | None = None,
    timeout_sec: float = 7200.0,
) -> None:
    """V5 — bake program-master (if needed) then PNG burn-in hold on program axis."""
    import uuid

    from engines.auto_subtitle_program_master import bake_program_master

    ensure_workspace()
    job_dir = WORKSPACE_ROOT / f"video-{uuid.uuid4().hex[:10]}"
    job_dir.mkdir(parents=True, exist_ok=True)

    preview = preview_media_path.resolve()
    if not preview.is_file():
        raise FileNotFoundError(f"preview_media_path를 찾을 수 없습니다: {preview}")

    clips = list(program_clips or [])
    if not clips:
        raise ValueError("export_schema_version=5 에는 program_clips가 필요합니다.")

    master_path: Path | None = None
    actual_duration: float | None = None
    metrics: dict[str, Any] | None = None

    # Deferred master baking: transcribe does not bake; export is the default bake point.
    if program_master_path is not None:
        candidate = program_master_path.resolve()
        if candidate.is_file():
            master_path = candidate
            from engines.auto_subtitle_media_probe import probe_media_timing

            probe = probe_media_timing(master_path, unify_ssot=True)
            if probe.get("ok"):
                try:
                    actual_duration = float(
                        probe.get("playback_duration_sec")
                        or probe.get("video_duration_sec")
                        or 0
                    )
                except (TypeError, ValueError):
                    actual_duration = None

    if master_path is None:
        _set_export_job("bake_master", 8.0, "Program master 생성…", fmt="video")
        if on_progress:
            on_progress(8.0, "Program master 생성…")

        def _bake_progress(pct: float, msg: str) -> None:
            with _export_lock:
                _export_job.phase = "bake_master"
                _export_job.progress = float(pct)
                _export_job.message = msg
                _export_job.format = "video"

        master_path, actual_duration, metrics = bake_program_master(
            preview,
            clips,
            job_dir,
            target_ntsc_fps=target_ntsc_fps,
            program_duration_sec=program_duration_sec,
            on_progress=_bake_progress,
            timeout_sec=timeout_sec,
        )
        _log.info(
            "export_v5_bake_master segments=%s actual=%.3f",
            metrics.get("filter_segment_count"),
            actual_duration,
        )

    prog_dur = float(program_duration_sec or 0)
    if prog_dur <= 0 and actual_duration:
        prog_dur = float(actual_duration)
    contract = {
        "target_ntsc_fps": str(target_ntsc_fps or "30000/1001"),
        "program_duration_sec": prog_dur,
        "timeline_axis": "program",
        "export_schema_version": 5,
    }

    enter_video_export_awaiting_hold(
        str(master_path),
        "program",
        job_dir=job_dir,
        progress=45.0,
        message="자막 프레임 업로드 대기…",
        actual_duration=actual_duration or prog_dur,
        burn_in_media_contract=contract,
        program_to_burnin_map=None,
    )


def _log_export_metrics(phase: str, metrics: dict[str, Any]) -> None:
    import logging

    logging.getLogger(__name__).info(
        "export_phase=%s expected=%s actual=%s av_delta=%s program_delta=%s",
        phase,
        metrics.get("expected_program_end"),
        metrics.get("probed_duration"),
        metrics.get("av_delta"),
        metrics.get("program_delta"),
    )


def _export_worker(
    export_kind: str,
    media_path: Path | None,
    cues: list[dict[str, Any]],
    *,
    cut_ranges: list[dict[str, Any]] | None,
    style: dict[str, Any] | None,
    text_format: str | None,
    preview_media_path: Path | None = None,
    virtual_audio_map: list[dict[str, Any]] | None = None,
    requires_concat: bool | None = None,
    burn_in_media_contract: dict[str, Any] | None = None,
    export_schema_version: int | None = None,
    program_clips: list[dict[str, Any]] | None = None,
    program_duration_sec: float | None = None,
    program_master_path: Path | None = None,
) -> None:
    try:
        def report(pct: float, msg: str) -> None:
            _set_export_job("running", pct, msg, fmt=export_kind)

        if export_kind in {"srt", "vtt", "ass", "txt"}:
            _set_export_job("running", 10.0, f"{export_kind.upper()} 생성 중…", fmt=export_kind)
            out = write_text_export_file(
                export_kind,
                cues,
                cut_ranges=cut_ranges,
                style=style,
            )
            _set_export_job("completed", 100.0, "보내기 완료", result_path=str(out), fmt=export_kind)
            return

        if export_kind == "video":
            preview = preview_media_path or media_path
            if preview is None:
                raise ValueError("preview_media_path(CFR)가 필요합니다.")
            if not preview.is_file():
                raise FileNotFoundError(
                    "CFR 미디어 재생성 필요: preview_media_path 파일을 찾을 수 없습니다."
                )
            _set_export_job("running", 5.0, "영상 자막 번인…", fmt="video")
            schema_v = int(export_schema_version or 0)
            if schema_v >= 5 and program_clips:
                fps = "30000/1001"
                if burn_in_media_contract and burn_in_media_contract.get("target_ntsc_fps"):
                    fps = str(burn_in_media_contract["target_ntsc_fps"])
                export_video_program_ssot_pipeline(
                    preview.resolve(),
                    program_clips=program_clips,
                    program_duration_sec=program_duration_sec,
                    program_master_path=program_master_path,
                    target_ntsc_fps=fps,
                    on_progress=report,
                )
                return
            use_concat = bool(requires_concat)
            export_video_stitched_pipeline(
                preview.resolve(),
                virtual_audio_map=virtual_audio_map,
                requires_concat=use_concat,
                burn_in_media_contract=burn_in_media_contract,
                on_progress=report,
            )
            return

        if export_kind in {"mp3", "wav"}:
            if media_path is None:
                raise ValueError("video_path가 필요합니다.")
            _set_export_job("running", 5.0, f"{export_kind.upper()} 인코딩…", fmt=export_kind)
            out = export_audio(
                media_path,
                export_kind,
                cut_ranges=cut_ranges,
                on_progress=report,
            )
            _set_export_job("completed", 100.0, "오디오보내기 완료", result_path=str(out), fmt=export_kind)
            return

        raise ValueError(f"unsupported export: {export_kind}")
    except Exception as exc:
        _set_export_job("failed", 0.0, str(exc), error=str(exc), fmt=export_kind)


def start_export_job(
    export_kind: str,
    cues: list[dict[str, Any]],
    *,
    media_path: Path | None = None,
    cut_ranges: list[dict[str, Any]] | None = None,
    style: dict[str, Any] | None = None,
    preview_media_path: Path | None = None,
    virtual_audio_map: list[dict[str, Any]] | None = None,
    requires_concat: bool | None = None,
    burn_in_media_contract: dict[str, Any] | None = None,
    export_schema_version: int | None = None,
    program_clips: list[dict[str, Any]] | None = None,
    program_duration_sec: float | None = None,
    program_master_path: Path | None = None,
) -> ExportJobStatus:
    global _export_thread
    from engines import auto_subtitle_runtime
    from engines.auto_subtitle_burn_in_media_contract import normalize_contract

    kind = export_kind.lower().strip()
    valid = {"srt", "vtt", "ass", "txt", "video", "mp3", "wav"}
    if kind not in valid:
        raise ValueError(f"지원하지 않는 형식: {export_kind}")

    if kind == "video" and preview_media_path is None and media_path is None:
        raise ValueError("영상보내기에는 preview_media_path(CFR)가 필요합니다.")
    if kind in {"mp3", "wav"} and media_path is None:
        raise ValueError("오디오보내기에는 media_path가 필요합니다.")
    if not cues and kind not in {"mp3", "wav"}:
        raise ValueError("cues가 비어 있습니다.")

    auto_subtitle_runtime.try_begin_job("export")

    with _export_lock:
        if _export_thread is not None and _export_thread.is_alive():
            auto_subtitle_runtime.end_job()
            return get_export_job_status()

        _set_export_job("queued", 0.0, "보내기 대기 중…", fmt=kind)
        if kind == "video" and burn_in_media_contract:
            with _export_lock:
                _export_job.burn_in_media_contract = normalize_contract(burn_in_media_contract)

        def _target() -> None:
            try:
                _export_worker(
                    kind,
                    media_path,
                    cues,
                    cut_ranges=cut_ranges,
                    style=style,
                    text_format=kind,
                    preview_media_path=preview_media_path,
                    virtual_audio_map=virtual_audio_map,
                    requires_concat=requires_concat,
                    burn_in_media_contract=burn_in_media_contract,
                    export_schema_version=export_schema_version,
                    program_clips=program_clips,
                    program_duration_sec=program_duration_sec,
                    program_master_path=program_master_path,
                )
            finally:
                # V47a — video Hold (awaiting_frames) retains Lock until burn-in completes.
                if not export_worker_should_retain_lock():
                    auto_subtitle_runtime.end_job()

        _export_thread = threading.Thread(target=_target, daemon=True)
        _export_thread.start()

    return get_export_job_status()


def sync_export_text(
    fmt: str,
    cues: list[dict[str, Any]],
    *,
    cut_ranges: list[dict[str, Any]] | None = None,
    style: dict[str, Any] | None = None,
) -> Path:
    """즉시 텍스트 파일 생성 (HTTP 동기 응답용)."""
    from engines import auto_subtitle_runtime

    auto_subtitle_runtime.try_begin_job("export")
    try:
        return write_text_export_file(fmt, cues, cut_ranges=cut_ranges, style=style)
    finally:
        auto_subtitle_runtime.end_job()
