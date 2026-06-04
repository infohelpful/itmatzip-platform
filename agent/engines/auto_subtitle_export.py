"""FFmpeg 기반 자막·영상·오디오보내기."""

from __future__ import annotations

import json
import platform
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

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


_export_job = ExportJobStatus(phase="idle", progress=0.0)


def get_export_job_status() -> ExportJobStatus:
    with _export_lock:
        return ExportJobStatus(
            phase=_export_job.phase,
            progress=_export_job.progress,
            message=_export_job.message,
            result_path=_export_job.result_path,
            format=_export_job.format,
            error=_export_job.error,
        )


def _set_export_job(
    phase: str,
    progress: float,
    message: str | None = None,
    *,
    result_path: str | None = None,
    fmt: str | None = None,
    error: str | None = None,
) -> None:
    with _export_lock:
        _export_job.phase = phase
        _export_job.progress = progress
        _export_job.message = message
        if result_path is not None or phase in {"idle", "failed", "completed"}:
            _export_job.result_path = result_path
        if fmt is not None:
            _export_job.format = fmt
        _export_job.error = error if phase == "failed" else None


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
) -> Path:
    ensure_workspace()
    job_dir = WORKSPACE_ROOT / f"video-{uuid.uuid4().hex[:10]}"
    job_dir.mkdir(parents=True, exist_ok=True)

    w, h, dur = probe_video_dimensions(media_path)
    st_dict = dict(style or {})
    st_dict.setdefault("videoWidth", w)
    st_dict.setdefault("videoHeight", h)
    mapped = cues_to_mapped(cues, cut_ranges=cut_ranges)
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


def _export_worker(
    export_kind: str,
    media_path: Path | None,
    cues: list[dict[str, Any]],
    *,
    cut_ranges: list[dict[str, Any]] | None,
    style: dict[str, Any] | None,
    text_format: str | None,
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
            if media_path is None:
                raise ValueError("video_path가 필요합니다.")
            _set_export_job("running", 5.0, "영상 자막 번인…", fmt="video")
            out = export_video_with_ass(
                media_path,
                cues,
                cut_ranges=cut_ranges,
                style=style,
                on_progress=report,
            )
            _set_export_job("completed", 100.0, "영상보내기 완료", result_path=str(out), fmt="video")
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
) -> ExportJobStatus:
    global _export_thread
    from engines import auto_subtitle_runtime

    kind = export_kind.lower().strip()
    valid = {"srt", "vtt", "ass", "txt", "video", "mp3", "wav"}
    if kind not in valid:
        raise ValueError(f"지원하지 않는 형식: {export_kind}")

    if kind in {"video", "mp3", "wav"} and media_path is None:
        raise ValueError("영상/오디오보내기에는 media_path가 필요합니다.")
    if not cues and kind not in {"mp3", "wav"}:
        raise ValueError("cues가 비어 있습니다.")

    auto_subtitle_runtime.try_begin_job("export")

    with _export_lock:
        if _export_thread is not None and _export_thread.is_alive():
            auto_subtitle_runtime.end_job()
            return get_export_job_status()

        _set_export_job("queued", 0.0, "보내기 대기 중…", fmt=kind)

        def _target() -> None:
            try:
                _export_worker(
                    kind,
                    media_path,
                    cues,
                    cut_ranges=cut_ranges,
                    style=style,
                    text_format=kind,
                )
            finally:
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
