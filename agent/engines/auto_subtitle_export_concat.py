"""V41 concat demuxer + dual quality gate + hybrid re-encode fallback."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Callable

from common.bin_manager import get_ffmpeg_executable, get_ffprobe_executable, prepend_ffmpeg_bin_to_env
from common.subprocess_util import no_window_creationflags, run_hidden
from engines.auto_subtitle_export import ExportProgressCallback, _run_ffmpeg_with_progress

_log = logging.getLogger(__name__)

BYPASS_ABSOLUTE_MAX_SEC = 2.0
BYPASS_MIN_DURATION_RATIO = 0.5


class ConcatQualityGateError(RuntimeError):
    """Re-encode 후에도 품질 게이트를 통과하지 못한 경우."""

    def __init__(self, message: str, *, metrics: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.metrics = metrics or {}


def _parse_frame_rate(raw: str | None) -> float:
    if not raw:
        return 30.0
    s = str(raw).strip()
    if "/" in s:
        num, den = s.split("/", 1)
        try:
            n = float(num)
            d = float(den)
            if d > 0:
                return max(1.0, n / d)
        except (TypeError, ValueError):
            pass
    try:
        return max(1.0, float(s))
    except (TypeError, ValueError):
        return 30.0


def probe_stream_durations(path: Path, *, timeout_sec: float = 60.0) -> tuple[float, float, float]:
    """(video_duration, audio_duration, frame_tolerance_sec)."""
    ffprobe = get_ffprobe_executable()
    proc = run_hidden(
        [
            str(ffprobe),
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=duration,r_frame_rate",
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
    video_dur = 0.0
    frame_rate = 30.0
    if proc.returncode == 0:
        try:
            data = json.loads(proc.stdout or "{}")
            streams = data.get("streams") or []
            if streams:
                stream = streams[0]
                try:
                    video_dur = float(stream.get("duration") or 0)
                except (TypeError, ValueError):
                    video_dur = 0.0
                frame_rate = _parse_frame_rate(stream.get("r_frame_rate"))
            if video_dur <= 0:
                video_dur = float((data.get("format") or {}).get("duration") or 0)
        except (json.JSONDecodeError, TypeError, ValueError):
            pass

    proc_a = run_hidden(
        [
            str(ffprobe),
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=duration",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=timeout_sec,
    )
    audio_dur = 0.0
    if proc_a.returncode == 0:
        try:
            data = json.loads(proc_a.stdout or "{}")
            streams = data.get("streams") or []
            if streams:
                audio_dur = float(streams[0].get("duration") or 0)
        except (json.JSONDecodeError, TypeError, ValueError):
            pass

    if video_dur <= 0:
        video_dur = audio_dur
    if audio_dur <= 0:
        audio_dur = video_dur

    frame_tol = 1.0 / frame_rate
    return max(0.0, video_dur), max(0.0, audio_dur), frame_tol


def compute_gate_threshold_sec(
    segments_count: int,
    expected_program_end: float,
    frame_tolerance_sec: float,
) -> tuple[float, float]:
    """Returns (threshold_sec, r_frame_rate)."""
    base_tolerance = max(frame_tolerance_sec, 1e-9)
    n = max(1, int(segments_count))
    threshold_sec = max(base_tolerance * 2.0, 0.045 * n)
    expected = max(float(expected_program_end), 1e-6)
    threshold_sec = min(threshold_sec, BYPASS_ABSOLUTE_MAX_SEC, expected * 0.05)
    r_frame_rate = 1.0 / base_tolerance
    return threshold_sec, r_frame_rate


def evaluate_dual_quality_gate(
    path: Path,
    expected_program_end: float,
    *,
    segments_count: int,
) -> tuple[bool, dict[str, Any]]:
    video_dur, audio_dur, frame_tol = probe_stream_durations(path)
    threshold_sec, r_frame_rate = compute_gate_threshold_sec(
        segments_count,
        expected_program_end,
        frame_tol,
    )
    av_delta_sec = abs(video_dur - audio_dur)
    program_delta_sec = abs(video_dur - float(expected_program_end))
    metrics = {
        "probed_duration": video_dur,
        "video_duration": video_dur,
        "audio_duration": audio_dur,
        "expected_program_end": float(expected_program_end),
        "av_delta": av_delta_sec,
        "program_delta": program_delta_sec,
        "av_delta_sec": av_delta_sec,
        "program_delta_sec": program_delta_sec,
        "threshold_sec": threshold_sec,
        "segments_count": int(segments_count),
        "r_frame_rate": r_frame_rate,
        "gate_bypassed": False,
    }
    ok = av_delta_sec <= threshold_sec and program_delta_sec <= threshold_sec
    return ok, metrics


def can_bypass_concat_gate(
    metrics: dict[str, Any],
    expected_program_end: float,
    path: Path,
) -> bool:
    if not path.is_file():
        return False
    probed = float(metrics.get("probed_duration") or 0)
    if probed <= 0:
        return False
    expected = float(expected_program_end)
    if expected > 0 and probed < expected * BYPASS_MIN_DURATION_RATIO:
        return False
    av_delta_sec = float(metrics.get("av_delta_sec") or metrics.get("av_delta") or 0)
    program_delta_sec = float(metrics.get("program_delta_sec") or metrics.get("program_delta") or 0)
    if av_delta_sec > BYPASS_ABSOLUTE_MAX_SEC or program_delta_sec > BYPASS_ABSOLUTE_MAX_SEC:
        return False
    return True


def _log_gate_metrics(metrics: dict[str, Any]) -> None:
    _log.info(
        "[GATE_METRICS] segments_count=%s, r_frame_rate=%s, av_delta_sec=%s, "
        "program_delta_sec=%s, expected=%s, actual=%s, gate_bypassed=%s",
        metrics.get("segments_count"),
        metrics.get("r_frame_rate"),
        metrics.get("av_delta_sec", metrics.get("av_delta")),
        metrics.get("program_delta_sec", metrics.get("program_delta")),
        metrics.get("expected_program_end"),
        metrics.get("probed_duration"),
        metrics.get("gate_bypassed", False),
    )


def posix_ffmpeg_path(path: Path) -> str:
    resolved = path.resolve()
    s = str(resolved).replace("\\", "/")
    return s.replace("'", "'\\''")


def write_concat_demuxer_list(
    master_media: Path,
    segments: list[dict[str, Any]],
    out_txt: Path,
) -> int:
    """Write concat demuxer list; returns count of valid segments written."""
    lines: list[str] = []
    media_posix = posix_ffmpeg_path(master_media)
    valid_count = 0
    for seg in segments:
        src_start = float(seg.get("sourceStart") or seg.get("source_start") or 0)
        src_end = float(seg.get("sourceEnd") or seg.get("source_end") or 0)
        if src_end <= src_start + 1e-5:
            continue
        valid_count += 1
        lines.append(f"file '{media_posix}'")
        lines.append(f"inpoint {src_start:.6f}")
        lines.append(f"outpoint {src_end:.6f}")
    if not lines:
        raise ValueError("virtual_audio_map에 유효한 segment가 없습니다.")
    out_txt.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return valid_count


def _concat_ffmpeg(
    concat_list: Path,
    out_path: Path,
    *,
    reencode: bool,
    on_progress: ExportProgressCallback | None,
    expected_sec: float,
    timeout_sec: float,
) -> None:
    ffmpeg = get_ffmpeg_executable()
    args = [
        str(ffmpeg),
        "-y",
        "-hide_banner",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(concat_list),
    ]
    if reencode:
        args.extend(["-c:v", "libx264", "-preset", "fast", "-crf", "23", "-c:a", "aac", "-b:a", "192k"])
    else:
        args.extend(["-c", "copy"])
    args.extend(["-progress", "pipe:2", "-nostats", str(out_path)])
    _run_ffmpeg_with_progress(
        args,
        expected_sec=max(expected_sec, 1.0),
        on_progress=on_progress,
        timeout_sec=timeout_sec,
    )


def build_concat_master(
    preview_media: Path,
    virtual_audio_map: list[dict[str, Any]],
    job_dir: Path,
    *,
    on_progress: ExportProgressCallback | None = None,
    timeout_sec: float = 7200.0,
) -> tuple[Path, str, dict[str, Any]]:
    """Returns (master_path, export_phase, gate_metrics)."""
    if not preview_media.is_file():
        raise FileNotFoundError(f"preview_media_path를 찾을 수 없습니다: {preview_media}")

    segs = [s for s in virtual_audio_map if isinstance(s, dict)]
    if not segs:
        raise ValueError("virtual_audio_map이 비어 있습니다.")

    expected_end = float(segs[-1].get("editEnd") or segs[-1].get("edit_end") or 0)
    if expected_end <= 0:
        expected_end = sum(
            float(s.get("sourceEnd", 0)) - float(s.get("sourceStart", 0)) for s in segs
        )

    concat_list = job_dir / "concat_list.txt"
    segments_count = write_concat_demuxer_list(preview_media, segs, concat_list)

    tmp_copy = job_dir / "tmp_master_copy.mp4"
    if on_progress:
        on_progress(12.0, "concat_copy 시도…")
    _log.info("export_phase=concat_copy expected_end=%.3f segments=%s", expected_end, segments_count)
    _concat_ffmpeg(
        concat_list,
        tmp_copy,
        reencode=False,
        on_progress=on_progress,
        expected_sec=expected_end,
        timeout_sec=timeout_sec,
    )

    ok, metrics = evaluate_dual_quality_gate(
        tmp_copy,
        expected_end,
        segments_count=segments_count,
    )
    _log_gate_metrics(metrics)
    if ok:
        master = job_dir / "concat_master.mp4"
        tmp_copy.replace(master)
        metrics["export_phase"] = "concat_copy"
        return master, "concat_copy", metrics

    tmp_copy.unlink(missing_ok=True)
    if on_progress:
        on_progress(28.0, "concat_reencode 폴백…")
    _log.warning(
        "concat_copy gate failed av_delta=%.4f program_delta=%.4f; reencode",
        metrics.get("av_delta_sec"),
        metrics.get("program_delta_sec"),
    )

    tmp_re = job_dir / "tmp_master_reencode.mp4"
    _concat_ffmpeg(
        concat_list,
        tmp_re,
        reencode=True,
        on_progress=on_progress,
        expected_sec=expected_end,
        timeout_sec=timeout_sec,
    )

    ok2, metrics2 = evaluate_dual_quality_gate(
        tmp_re,
        expected_end,
        segments_count=segments_count,
    )
    metrics2["export_phase"] = "concat_reencode"
    metrics2["first_pass"] = metrics
    if not ok2:
        if can_bypass_concat_gate(metrics2, expected_end, tmp_re):
            metrics2["gate_bypassed"] = True
            _log_gate_metrics(metrics2)
            master = job_dir / "concat_master.mp4"
            tmp_re.replace(master)
            _log.info(
                "export_phase=concat_reencode bypass expected=%.3f actual=%.3f",
                expected_end,
                metrics2.get("probed_duration"),
            )
            return master, "concat_reencode", metrics2
        _log_gate_metrics(metrics2)
        tmp_re.unlink(missing_ok=True)
        raise ConcatQualityGateError(
            "concat 품질 검증 게이트 실패 (re-encode 후에도 허용 오차 초과)",
            metrics=metrics2,
        )

    _log_gate_metrics(metrics2)
    master = job_dir / "concat_master.mp4"
    tmp_re.replace(master)
    _log.info(
        "export_phase=concat_reencode expected=%.3f actual=%.3f",
        expected_end,
        metrics2.get("probed_duration"),
    )
    return master, "concat_reencode", metrics2
