"""A/V remux·VFR CFR 정규화 — transcribe/peaks/preview SSOT."""

from __future__ import annotations

import hashlib
import json
import logging
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from common.bin_manager import get_ffmpeg_executable
from common.subprocess_util import no_window_creationflags, run_hidden

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[float, str, str], None]

# A/V normalize pipeline version — bump to invalidate sidecar accept markers after deploy.
PIPELINE_VERSION = "v21_master"
WHISPER_FROM_PREVIEW_WAV = "whisper-from-preview.wav"
_AVSYNC_REPAIR_MIN_SEC = 0.01
_CACHE_RAW_TOLERANCE_SEC = 0.01
_AVDUR_EQUALIZE_MIN_SEC = 0.001
_NTSC_FPS = "30000/1001"


@dataclass
class TranscribeMediaPrepareResult:
    transcribe_path: Path
    preview_path: Path
    actions: list[str] = field(default_factory=list)
    normalized: bool = False


def _emit(cb: ProgressCallback | None, pct: float, step: str, detail: str = "") -> None:
    if cb is not None:
        cb(pct, step, detail)


def _av_start_skew_sec(timing: dict[str, Any] | None) -> float:
    """양수 = video start_time 이 audio 보다 늦음 (재생 시 video lag)."""
    if not timing:
        return 0.0
    try:
        v = float(timing.get("video_start_time_sec") or 0)
        a = float(timing.get("audio_start_time_sec") or 0)
    except (TypeError, ValueError):
        return 0.0
    return v - a


def _accept_json_for(output: Path) -> Path:
    return output.parent / f"{output.stem}.accept.json"


def _source_fingerprint(src: Path) -> tuple[str, int, float]:
    st = src.stat()
    return str(src.resolve()), st.st_size, st.st_mtime


def _load_accept_marker(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _probe_raw_delta_skew(probe: dict[str, Any]) -> tuple[float, float]:
    vd = float(probe.get("video_duration_sec") or 0)
    ad = float(probe.get("audio_duration_sec") or 0)
    if vd > 0 and ad > 0:
        delta = abs(vd - ad)
    else:
        delta = abs(float(probe.get("av_duration_delta_sec") or 0))
    return delta, abs(_av_start_skew_sec(probe))


def _raw_exceeds_cache_tolerance(probe: dict[str, Any]) -> bool:
    delta, skew = _probe_raw_delta_skew(probe)
    return delta >= _CACHE_RAW_TOLERANCE_SEC or skew >= _CACHE_RAW_TOLERANCE_SEC


def _purge_job_waveform_peaks_json(job_dir: Path | None) -> None:
    """CFR 재생성 시 job 산출물 waveform-peaks.json 무효화."""
    if job_dir is None:
        return
    try:
        (job_dir / "waveform-peaks.json").unlink(missing_ok=True)
    except OSError:
        pass


def extract_whisper_wav_from_preview(
    preview: Path,
    dest: Path,
    *,
    duration_sec: float | None = None,
    ffmpeg_exe: str | None = None,
    timeout_sec: float = 3600.0,
) -> None:
    """prep.preview_path → 16k mono Whisper WAV (Go whisper-audio.wav와 격리)."""
    preview = preview.resolve()
    if not preview.is_file():
        raise RuntimeError(f"프리뷰 미디어 없음: {preview}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    ff = ffmpeg_exe or str(get_ffmpeg_executable())
    cmd: list[str] = [
        ff,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(preview),
    ]
    if duration_sec is not None and float(duration_sec) > 0:
        cmd.extend(["-t", f"{float(duration_sec):.6f}"])
    cmd.extend(["-ac", "1", "-ar", "16000", str(dest.resolve())])
    proc = run_hidden(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout_sec,
    )
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-800:]
        raise RuntimeError(f"Whisper WAV 추출 실패: {tail or proc.returncode}")
    if not dest.is_file() or dest.stat().st_size <= 0:
        raise RuntimeError("Whisper WAV 출력이 비어 있습니다.")


def _delete_media_pair(output: Path) -> None:
    try:
        output.unlink(missing_ok=True)
    except OSError:
        pass
    try:
        _accept_json_for(output).unlink(missing_ok=True)
    except OSError:
        pass


def _marker_matches(marker: dict[str, Any], src: Path, output: Path) -> bool:
    if marker.get("pipeline_version") != PIPELINE_VERSION:
        return False
    sp, sz, mt = _source_fingerprint(src)
    if str(marker.get("source_path") or "") != sp:
        return False
    try:
        if int(marker.get("source_size", -1)) != sz:
            return False
        if float(marker.get("source_mtime", -1)) != mt:
            return False
    except (TypeError, ValueError):
        return False
    return output.is_file() and output.stat().st_size > 0


def _write_accept_marker(
    output: Path,
    src: Path,
    probe: dict[str, Any],
    *,
    residual: bool,
) -> None:
    sp, sz, mt = _source_fingerprint(src)
    delta, skew = _probe_raw_delta_skew(probe)
    payload = {
        "pipeline_version": PIPELINE_VERSION,
        "source_path": sp,
        "source_size": sz,
        "source_mtime": mt,
        "raw_delta_sec": round(delta, 6),
        "raw_skew_sec": round(skew, 6),
        "av_raw_residual_accepted": bool(residual),
    }
    _accept_json_for(output).write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _log_raw_probe_verification(output: Path, probe: dict[str, Any], *, residual: bool) -> None:
    delta, skew = _probe_raw_delta_skew(probe)
    logger.info(
        "normalize raw verify path=%s delta_ms=%.1f skew_ms=%.1f residual=%s",
        output,
        delta * 1000,
        skew * 1000,
        residual,
    )


def _try_sidecar_cache_skip(
    output: Path, src: Path, actions: list[str], *, job_dir: Path | None = None
) -> bool:
    """Valid sidecar + mp4 → skip all encode/sync passes."""
    if output.is_file() and output.stat().st_size <= 0:
        _delete_media_pair(output)
        return False

    if not output.is_file():
        return False

    accept_path = _accept_json_for(output)
    if not accept_path.is_file() or accept_path.stat().st_size <= 0:
        _delete_media_pair(output)
        _purge_job_waveform_peaks_json(job_dir)
        return False

    marker = _load_accept_marker(accept_path)
    if not marker or not _marker_matches(marker, src, output):
        _delete_media_pair(output)
        _purge_job_waveform_peaks_json(job_dir)
        return False

    actions.append("sidecar_cache_hit")
    return True


def _resolve_video_master_duration(timing: dict[str, Any] | None, src: Path) -> float:
    vd = 0.0
    if timing:
        try:
            vd = float(timing.get("video_duration_sec") or 0)
        except (TypeError, ValueError):
            vd = 0.0
    if vd <= 0:
        from engines.auto_subtitle_media_probe import probe_media_timing

        probe = probe_media_timing(src)
        try:
            vd = float(probe.get("video_duration_sec") or 0)
        except (TypeError, ValueError):
            vd = 0.0
    if vd <= 0:
        raise RuntimeError("Video-Master 정규화: video_duration_sec 없음")
    return max(0.05, round(vd, 6))


def finalize_mp4_timestamps(src: Path, dest: Path, *, ffmpeg_exe: str | None = None, timeout_sec: float = 600.0) -> None:
    """PTS 0 정렬·genpts — 브라우저 A/V 상수 offset 완화."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    ff = ffmpeg_exe or str(get_ffmpeg_executable())
    proc = run_hidden(
        [
            ff,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(src.resolve()),
            "-map",
            "0:v:0?",
            "-map",
            "0:a:0?",
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            "-fflags",
            "+genpts",
            "-muxpreload",
            "0",
            "-muxdelay",
            "0",
            "-movflags",
            "+faststart",
            str(dest.resolve()),
        ],
        capture_output=True,
        text=True,
        timeout=timeout_sec,
    )
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-800:]
        raise RuntimeError(f"MP4 timestamp finalize 실패: {tail or proc.returncode}")
    if not dest.is_file() or dest.stat().st_size <= 0:
        raise RuntimeError("MP4 timestamp finalize 출력이 비어 있습니다.")


def repair_av_start_skew(
    src: Path,
    dest: Path,
    skew_sec: float,
    *,
    ffmpeg_exe: str | None = None,
    timeout_sec: float = 7200.0,
) -> None:
    """
    skew_sec > 0: video가 늦게 시작 → audio adelay.
    skew_sec < 0: audio가 늦게 시작 → video trim.
    """
    if abs(skew_sec) < _AVSYNC_REPAIR_MIN_SEC:
        if src.resolve() != dest.resolve():
            dest.write_bytes(src.read_bytes())
        return

    dest.parent.mkdir(parents=True, exist_ok=True)
    ff = ffmpeg_exe or str(get_ffmpeg_executable())

    if skew_sec > 0:
        delay_ms = max(0, int(round(skew_sec * 1000)))
        fc = f"[0:a]adelay={delay_ms}|{delay_ms},asetpts=PTS-STARTPTS[a];[0:v]setpts=PTS-STARTPTS[v]"
    else:
        trim_v = max(0.0, -skew_sec)
        fc = f"[0:v]trim=start={trim_v:.6f},setpts=PTS-STARTPTS[v];[0:a]asetpts=PTS-STARTPTS[a]"

    proc = run_hidden(
        [
            ff,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(src.resolve()),
            "-filter_complex",
            fc,
            "-map",
            "[v]",
            "-map",
            "[a]",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "18",
            "-r",
            _NTSC_FPS,
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-shortest",
            str(dest.resolve()),
        ],
        capture_output=True,
        text=True,
        timeout=timeout_sec,
    )
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-800:]
        raise RuntimeError(f"A/V start skew 보정 실패: {tail or proc.returncode}")
    if not dest.is_file() or dest.stat().st_size <= 0:
        raise RuntimeError("A/V start skew 보정 출력이 비어 있습니다.")


def remux_av_shortest(
    src: Path,
    dest: Path,
    *,
    ffmpeg_exe: str | None = None,
    timeout_sec: float = 3600.0,
) -> None:
    """A/V 중 짧은 축에 맞춰 stream copy remux."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    ff = ffmpeg_exe or str(get_ffmpeg_executable())
    proc = run_hidden(
        [
            ff,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(src.resolve()),
            "-map",
            "0:v:0?",
            "-map",
            "0:a:0?",
            "-c",
            "copy",
            "-shortest",
            str(dest.resolve()),
        ],
        capture_output=True,
        text=True,
        timeout=timeout_sec,
    )
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-800:]
        raise RuntimeError(f"A/V remux 실패: {tail or proc.returncode}")
    if not dest.is_file() or dest.stat().st_size <= 0:
        raise RuntimeError("A/V remux 출력 파일이 비어 있습니다.")


def equalize_av_stream_durations(
    src: Path,
    dest: Path,
    *,
    timing: dict[str, Any] | None = None,
    duration_sec: float | None = None,
    ffmpeg_exe: str | None = None,
    timeout_sec: float = 3600.0,
) -> float:
    """video/audio stream을 동일 duration(초)으로 trim — ffprobe delta 제거."""
    from engines.auto_subtitle_media_probe import probe_media_timing

    probe = timing if isinstance(timing, dict) and timing.get("ok") else probe_media_timing(src)
    if duration_sec is not None and float(duration_sec) > 0:
        dur = float(duration_sec)
    else:
        vd = float(probe.get("video_duration_sec") or 0)
        ad = float(probe.get("audio_duration_sec") or 0)
        if vd > 0 and ad > 0:
            dur = min(vd, ad)
        elif vd > 0:
            dur = vd
        elif ad > 0:
            dur = ad
        else:
            raise RuntimeError("A/V 길이 동기화: stream duration 없음")
    dur = max(0.05, round(float(dur), 6))

    dest.parent.mkdir(parents=True, exist_ok=True)
    ff = ffmpeg_exe or str(get_ffmpeg_executable())
    fc = (
        f"[0:v]trim=duration={dur:.6f},setpts=PTS-STARTPTS,fps={_NTSC_FPS}[vout];"
        f"[0:a]atrim=duration={dur:.6f},asetpts=PTS-STARTPTS[aout]"
    )
    proc = run_hidden(
        [
            ff,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(src.resolve()),
            "-filter_complex",
            fc,
            "-map",
            "[vout]",
            "-map",
            "[aout]",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-t",
            f"{dur:.6f}",
            str(dest.resolve()),
        ],
        capture_output=True,
        text=True,
        timeout=timeout_sec,
    )
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-800:]
        raise RuntimeError(f"A/V 길이 동기화 실패: {tail or proc.returncode}")
    if not dest.is_file() or dest.stat().st_size <= 0:
        raise RuntimeError("A/V 길이 동기화 출력이 비어 있습니다.")
    return dur


def _finalize_equal_av_duration(
    path: Path,
    *,
    actions: list[str],
    on_progress: ProgressCallback | None = None,
) -> None:
    """preview 출력 — video_duration_sec == audio_duration_sec."""
    from engines.auto_subtitle_media_probe import probe_media_timing

    probe = probe_media_timing(path)
    if not probe.get("ok"):
        return
    delta = abs(float(probe.get("av_duration_delta_sec") or 0))
    if delta < _AVDUR_EQUALIZE_MIN_SEC:
        return

    _emit(
        on_progress,
        98.0,
        "미디어 정규화",
        f"A/V 길이 동기화 ({delta * 1000:.0f}ms → 0ms)…",
    )
    tmp = path.with_suffix(".av-dur-eq.mp4")
    dur = equalize_av_stream_durations(path, tmp, timing=probe)
    tmp_pts = path.with_suffix(".av-dur-eq-pts.mp4")
    finalize_mp4_timestamps(tmp, tmp_pts)
    tmp_pts.replace(path)
    try:
        tmp.unlink(missing_ok=True)
    except OSError:
        pass
    actions.append(f"av_duration_equalize_{dur:.3f}s")


def normalize_vfr_cfr(
    src: Path,
    dest: Path,
    *,
    timing: dict[str, Any] | None = None,
    ffmpeg_exe: str | None = None,
    timeout_sec: float = 7200.0,
    on_progress: ProgressCallback | None = None,
) -> None:
    """VFR/비표준 fps → 29.97 NTSC CFR + AAC, Video-Master A/V sync."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    ff = ffmpeg_exe or str(get_ffmpeg_executable())
    _emit(on_progress, 1.0, "미디어 정규화", "VFR → 29.97 CFR 인코딩…")

    video_duration = _resolve_video_master_duration(timing, src)
    skew = _av_start_skew_sec(timing)
    vf_parts: list[str] = []
    if skew > _AVSYNC_REPAIR_MIN_SEC:
        vf_parts.append(f"trim=start={skew:.6f}")
    vf_parts.extend(["setpts=PTS-STARTPTS", f"fps={_NTSC_FPS}"])
    vf = ",".join(vf_parts)

    af_parts: list[str] = []
    if skew < -_AVSYNC_REPAIR_MIN_SEC:
        af_parts.append(f"atrim=start={-skew:.6f}")
    af_parts.extend(
        [
            "aresample=async=1",
            "asetpts=PTS-STARTPTS",
            f"apad=whole_dur={video_duration:.6f}",
            f"atrim=duration={video_duration:.6f}",
        ]
    )
    af = ",".join(af_parts)

    filter_complex = f"[0:v]{vf}[vout];[0:a]{af}[aout]"
    tmp = dest.with_suffix(".cfr-encoding.mp4")
    cmd = [
        ff,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(src.resolve()),
        "-filter_complex",
        filter_complex,
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "18",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-t",
        f"{video_duration:.6f}",
        str(tmp.resolve()),
    ]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=no_window_creationflags(),
    )
    tail = ""
    assert proc.stdout is not None
    for line in proc.stdout:
        stripped = line.strip()
        if stripped:
            tail = stripped
    code = proc.wait(timeout=timeout_sec)
    if code != 0:
        raise RuntimeError(f"VFR 정규화 실패: {tail or code}")
    if not tmp.is_file() or tmp.stat().st_size <= 0:
        raise RuntimeError("VFR 정규화 출력 파일이 비어 있습니다.")

    pre_probe: dict[str, Any] | None = None
    try:
        from engines.auto_subtitle_media_probe import probe_media_timing

        pre_probe = probe_media_timing(tmp)
        d, s = _probe_raw_delta_skew(pre_probe)
        logger.info(
            "normalize pre-finalize raw verify path=%s delta_ms=%.1f skew_ms=%.1f",
            tmp,
            d * 1000,
            s * 1000,
        )
    except Exception:
        logger.debug("pre-finalize probe skipped", exc_info=True)

    finalize_mp4_timestamps(tmp, dest, ffmpeg_exe=ff, timeout_sec=min(timeout_sec, 600.0))
    try:
        tmp.unlink(missing_ok=True)
    except OSError:
        pass

    try:
        from engines.auto_subtitle_media_probe import probe_media_timing

        post_probe = probe_media_timing(dest)
        d, s = _probe_raw_delta_skew(post_probe)
        logger.info(
            "normalize post-finalize raw verify path=%s delta_ms=%.1f skew_ms=%.1f",
            dest,
            d * 1000,
            s * 1000,
        )
    except Exception:
        logger.debug("post-finalize probe skipped", exc_info=True)

    _emit(on_progress, 100.0, "미디어 정규화", "VFR 정규화 완료")


def _post_normalize_av_sync(path: Path, *, actions: list[str], on_progress: ProgressCallback | None = None) -> None:
    """CFR 출력 probe — 잔여 start skew 있으면 adelay/trim 2-pass."""
    from engines.auto_subtitle_media_probe import probe_media_timing

    probe = probe_media_timing(path)
    if not probe.get("ok"):
        return
    skew = _av_start_skew_sec(probe)
    if abs(skew) < _AVSYNC_REPAIR_MIN_SEC:
        return

    _emit(on_progress, 95.0, "미디어 정규화", f"A/V start skew 보정 ({skew * 1000:.0f}ms)…")
    tmp = path.with_suffix(".av-sync.mp4")
    repair_av_start_skew(path, tmp, skew)
    tmp_pts = path.with_suffix(".av-sync-pts.mp4")
    finalize_mp4_timestamps(tmp, tmp_pts)
    tmp_pts.replace(path)
    try:
        tmp.unlink(missing_ok=True)
    except OSError:
        pass
    actions.append("av_start_skew_repair")


def _finalize_cached_output(
    output: Path,
    src: Path,
    *,
    actions: list[str],
    on_progress: ProgressCallback | None,
    did_reencode: bool,
) -> None:
    """재인코딩 후 Raw 검증, fallback, sidecar accept 기록."""
    from engines.auto_subtitle_media_probe import probe_media_timing

    probe = probe_media_timing(output)
    residual = False

    if did_reencode and _raw_exceeds_cache_tolerance(probe):
        _post_normalize_av_sync(output, actions=actions, on_progress=on_progress)
        _finalize_equal_av_duration(output, actions=actions, on_progress=on_progress)
        probe = probe_media_timing(output)
        if _raw_exceeds_cache_tolerance(probe):
            residual = True
            delta, skew = _probe_raw_delta_skew(probe)
            logger.warning(
                "av_raw_residual accepted path=%s delta_ms=%.1f skew_ms=%.1f",
                output,
                delta * 1000,
                skew * 1000,
            )
            actions.append("av_raw_residual_accepted")

    _write_accept_marker(output, src, probe, residual=residual)
    _log_raw_probe_verification(output, probe, residual=residual)


def _ensure_cached_media_output(
    output: Path,
    src: Path,
    *,
    job_dir: Path | None = None,
    actions: list[str],
    on_progress: ProgressCallback | None,
    encode_once: Callable[[], None],
) -> bool:
    """
    Sidecar·Raw 캐시 정책으로 output 확보.
    Returns True if sidecar skip (no encode/sync).
    """
    if _try_sidecar_cache_skip(output, src, actions, job_dir=job_dir):
        return True

    did_reencode = False
    if not output.is_file() or output.stat().st_size <= 0:
        _purge_job_waveform_peaks_json(job_dir)
        encode_once()
        did_reencode = True
    else:
        from engines.auto_subtitle_media_probe import probe_media_timing

        probe = probe_media_timing(output)
        if _raw_exceeds_cache_tolerance(probe):
            _delete_media_pair(output)
            _purge_job_waveform_peaks_json(job_dir)
            encode_once()
            did_reencode = True
        else:
            _write_accept_marker(output, src, probe, residual=False)
            _log_raw_probe_verification(output, probe, residual=False)
            actions.append("cache_pass_raw_ok")
            return False

    if did_reencode:
        _finalize_cached_output(
            output,
            src,
            actions=actions,
            on_progress=on_progress,
            did_reencode=True,
        )
    return False


def _run_remux_pipeline(
    output: Path,
    input_media: Path,
    src: Path,
    timing: dict[str, Any],
    *,
    job_dir: Path,
    actions: list[str],
    on_progress: ProgressCallback | None,
) -> bool:
    """media-av-sync remux + sidecar. Returns True on sidecar skip."""

    def _encode() -> None:
        _emit(on_progress, 1.0, "미디어 정규화", "A/V 길이 remux (-shortest)…")
        remux_av_shortest(input_media, output)
        tmp_ts = output.with_suffix(".av-sync-pts.mp4")
        finalize_mp4_timestamps(output, tmp_ts)
        tmp_ts.replace(output)
        skew = _av_start_skew_sec(timing)
        if abs(skew) >= _AVSYNC_REPAIR_MIN_SEC:
            tmp = output.with_suffix(".av-sync-skew.mp4")
            repair_av_start_skew(output, tmp, skew)
            tmp_pts = output.with_suffix(".av-sync-skew-pts.mp4")
            finalize_mp4_timestamps(tmp, tmp_pts)
            tmp_pts.replace(output)
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            actions.append("av_start_skew_repair")
        _emit(on_progress, 100.0, "미디어 정규화", "A/V remux 완료")

    skipped = _ensure_cached_media_output(
        output,
        src,
        job_dir=job_dir,
        actions=actions,
        on_progress=on_progress,
        encode_once=_encode,
    )
    return skipped


def prepare_transcribe_media(
    src: Path,
    job_dir: Path,
    timing: dict[str, Any],
    *,
    on_progress: ProgressCallback | None = None,
) -> TranscribeMediaPrepareResult:
    """
    transcribe/peaks/preview 공통 입력 선택.
    VFR → CFR re-encode, A/V mismatch → remux -shortest.
    """
    src = src.resolve()
    job_dir.mkdir(parents=True, exist_ok=True)
    actions: list[str] = []
    current = src

    needs_vfr = bool(timing.get("needs_vfr_normalize"))
    needs_remux = bool(timing.get("needs_av_remux"))

    if needs_vfr:
        out = job_dir / "media-cfr.mp4"

        def _encode_cfr() -> None:
            normalize_vfr_cfr(current, out, timing=timing, on_progress=on_progress)

        skipped = _ensure_cached_media_output(
            out,
            src,
            job_dir=job_dir,
            actions=actions,
            on_progress=on_progress,
            encode_once=_encode_cfr,
        )
        if skipped:
            actions.append("sidecar_skip")
        actions.append("vfr_cfr_normalize")
        current = out

    if needs_remux and not needs_vfr:
        out = job_dir / "media-av-sync.mp4"
        skipped = _run_remux_pipeline(
            out,
            current,
            src,
            timing,
            job_dir=job_dir,
            actions=actions,
            on_progress=on_progress,
        )
        if skipped:
            actions.append("sidecar_skip")
        actions.append("av_remux_shortest")
        current = out

    normalized = current != src
    return TranscribeMediaPrepareResult(
        transcribe_path=current,
        preview_path=current,
        actions=actions,
        normalized=normalized,
    )


def preview_cache_job_dir(src: Path) -> Path:
    """원본 fingerprint 기준 CFR 캐시 job_dir — 프로젝트 불러오기·export 재사용."""
    from engines.auto_subtitle import ensure_workspace

    sp, sz, mt = _source_fingerprint(src.resolve())
    key = hashlib.sha256(f"{sp}|{sz}|{mt}|{PIPELINE_VERSION}".encode("utf-8")).hexdigest()[:20]
    job_dir = ensure_workspace() / f"preview-{key}"
    job_dir.mkdir(parents=True, exist_ok=True)
    return job_dir


def prepare_preview_media_bundle(
    src: Path,
    *,
    on_progress: ProgressCallback | None = None,
) -> tuple[TranscribeMediaPrepareResult, dict[str, Any], dict[str, Any]]:
    """probe → prepare_transcribe_media → preview probe (transcribe 없이 CFR SSOT)."""
    from engines.auto_subtitle_media_probe import probe_media_timing

    src = src.resolve()
    if not src.is_file():
        raise FileNotFoundError(f"미디어 파일을 찾을 수 없습니다: {src}")

    source_probe = probe_media_timing(src)
    if not source_probe.get("ok"):
        raise RuntimeError(str(source_probe.get("error") or "media probe failed"))

    job_dir = preview_cache_job_dir(src)
    prep = prepare_transcribe_media(src, job_dir, source_probe, on_progress=on_progress)
    preview_probe = probe_media_timing(prep.preview_path, unify_ssot=True)
    if not preview_probe.get("ok"):
        raise RuntimeError(str(preview_probe.get("error") or "preview probe failed"))
    return prep, source_probe, preview_probe
