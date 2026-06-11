"""ffprobe — A/V duration·fps·VFR 진단 (Whisper word timeline SSOT = audio)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from common.bin_manager import get_ffprobe_executable
from common.subprocess_util import run_hidden

_VFR_FPS_DELTA_RATIO = 0.002
_AV_DELTA_REMUX_SEC = 0.05


def target_ntsc_fps_from_rate(fps: float) -> str:
    if fps >= 50:
        return "60000/1001"
    if fps <= 25:
        return "24000/1001"
    return "30000/1001"


def parse_ntsc_fps_fraction(raw: str | None) -> float:
    """NTSC fraction string → float fps (e.g. 30000/1001 → 29.97)."""
    if not raw:
        return 30.0
    text = str(raw).strip()
    if "/" in text:
        num_s, den_s = text.split("/", 1)
        try:
            num = float(num_s)
            den = float(den_s)
            if den > 0:
                return num / den
        except ValueError:
            pass
    try:
        val = float(text)
        return val if val > 0 else 30.0
    except ValueError:
        return 30.0


def parse_frame_rate(value: str | None) -> float | None:
    if not value or value in {"0/0", "0", "0/1"}:
        return None
    text = str(value).strip()
    if "/" in text:
        num_s, den_s = text.split("/", 1)
        try:
            num = float(num_s)
            den = float(den_s)
        except ValueError:
            return None
        if den <= 0:
            return None
        return num / den
    try:
        fps = float(text)
    except ValueError:
        return None
    return fps if fps > 0 else None


def probe_media_timing(
    path: Path,
    *,
    timeout_sec: float = 45.0,
    unify_ssot: bool = False,
) -> dict[str, Any]:
    """미디어 컨테이너 타임라인 — unify_ssot=True 시 API/UI용 video-master SSOT."""
    media = path.resolve()
    out: dict[str, Any] = {
        "ok": False,
        "source_path": str(media),
        "video_duration_sec": None,
        "audio_duration_sec": None,
        "format_duration_sec": None,
        "playback_duration_sec": None,
        "word_timeline_duration_sec": None,
        "av_duration_delta_sec": None,
        "video_start_time_sec": None,
        "audio_start_time_sec": None,
        "av_start_skew_sec": None,
        "video_r_frame_rate": None,
        "video_avg_frame_rate": None,
        "video_r_frame_rate_fps": None,
        "video_avg_frame_rate_fps": None,
        "vfr_suspected": False,
        "needs_av_remux": False,
        "needs_vfr_normalize": False,
    }
    if not media.is_file():
        out["error"] = "file_not_found"
        return out

    from common.bin_manager import ensure_ffmpeg

    try:
        ensure_ffmpeg(download_timeout_sec=900.0)
    except Exception as exc:
        out["error"] = f"ffmpeg_not_ready: {exc}"
        return out

    try:
        ffprobe = get_ffprobe_executable()
    except FileNotFoundError as exc:
        out["error"] = f"ffprobe_not_ready: {exc}"
        return out

    proc = run_hidden(
        [
            str(ffprobe),
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=index,codec_type,codec_name,r_frame_rate,avg_frame_rate,duration,start_time",
            "-of",
            "json",
            str(media),
        ],
        capture_output=True,
        text=True,
        timeout=timeout_sec,
    )
    if proc.returncode != 0:
        out["error"] = (proc.stderr or proc.stdout or "ffprobe failed").strip()[:500]
        return out

    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        out["error"] = f"ffprobe_json: {exc}"
        return out

    video_dur: float | None = None
    audio_dur: float | None = None
    for stream in data.get("streams") or []:
        if not isinstance(stream, dict):
            continue
        codec_type = str(stream.get("codec_type") or "")
        try:
            dur = float(stream.get("duration") or 0)
        except (TypeError, ValueError):
            dur = 0.0
        try:
            start = float(stream.get("start_time") or 0)
        except (TypeError, ValueError):
            start = 0.0
        if codec_type == "video" and video_dur is None:
            video_dur = dur if dur > 0 else None
            out["video_start_time_sec"] = start
            out["video_r_frame_rate"] = stream.get("r_frame_rate")
            out["video_avg_frame_rate"] = stream.get("avg_frame_rate")
            out["video_r_frame_rate_fps"] = parse_frame_rate(out["video_r_frame_rate"])
            out["video_avg_frame_rate_fps"] = parse_frame_rate(out["video_avg_frame_rate"])
        elif codec_type == "audio" and audio_dur is None:
            audio_dur = dur if dur > 0 else None
            out["audio_start_time_sec"] = start

    fmt_dur: float | None = None
    try:
        fmt_val = float((data.get("format") or {}).get("duration") or 0)
        fmt_dur = fmt_val if fmt_val > 0 else None
    except (TypeError, ValueError):
        fmt_dur = None

    out["video_duration_sec"] = video_dur
    out["audio_duration_sec"] = audio_dur
    out["format_duration_sec"] = fmt_dur

    raw_delta: float | None = None
    if video_dur is not None and audio_dur is not None:
        raw_delta = video_dur - audio_dur
        out["av_duration_delta_sec"] = round(raw_delta, 6)

    v_st = out.get("video_start_time_sec")
    a_st = out.get("audio_start_time_sec")
    raw_skew: float | None = None
    if v_st is not None and a_st is not None:
        raw_skew = float(v_st) - float(a_st)
        out["av_start_skew_sec"] = round(raw_skew, 6)

    r_fps = out["video_r_frame_rate_fps"]
    avg_fps = out["video_avg_frame_rate_fps"]
    vfr = False
    if r_fps and avg_fps and max(r_fps, avg_fps) > 0:
        vfr = abs(r_fps - avg_fps) / max(r_fps, avg_fps) > _VFR_FPS_DELTA_RATIO
    out["vfr_suspected"] = vfr

    av_delta = abs(float(raw_delta or 0))
    out["needs_av_remux"] = av_delta >= _AV_DELTA_REMUX_SEC
    out["needs_vfr_normalize"] = vfr

    if unify_ssot and video_dur is not None and audio_dur is not None and abs(raw_delta or 0) <= 0.05:
        unified = video_dur
        out["video_duration_sec"] = unified
        out["audio_duration_sec"] = unified
        out["av_duration_delta_sec"] = 0.0
        video_dur = unified
        audio_dur = unified

    if unify_ssot and raw_skew is not None and abs(raw_skew) <= 0.05:
        out["av_start_skew_sec"] = 0.0

    content_fps = avg_fps or r_fps or 30.0
    if vfr and avg_fps:
        content_fps = avg_fps
    out["target_ntsc_fps"] = target_ntsc_fps_from_rate(float(content_fps or 30.0))

    if unify_ssot and video_dur is not None and video_dur > 0:
        playback = video_dur
    else:
        playback = audio_dur or video_dur or fmt_dur
    out["playback_duration_sec"] = playback
    out["word_timeline_duration_sec"] = playback
    out["ok"] = playback is not None and playback > 0
    return out


def patch_peaks_json_duration(peaks: dict[str, Any], duration_sec: float) -> dict[str, Any]:
    """파형 JSON 축을 audio SSOT duration에 맞춤."""
    if not isinstance(peaks, dict) or not (duration_sec > 0):
        return peaks
    patched = dict(peaks)
    patched["duration_sec"] = duration_sec
    patched["timeline_sec"] = duration_sec
    return patched
