"""Join or clip local audio files via FFmpeg."""

from __future__ import annotations

import os
import shutil
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from common.bin_manager import (
    get_ffmpeg_executable,
    get_ffprobe_executable,
    prepend_ffmpeg_bin_to_env,
)
from common.subprocess_util import run_hidden

AUDIO_JOIN_ROOT = Path(os.environ.get("APPDATA", Path.home() / ".itmatzip")) / "ItMatZip" / "audio-join"
WORKSPACE_ROOT = AUDIO_JOIN_ROOT / "workspace"

ALLOWED_AUDIO_SUFFIXES = {
    ".wav",
    ".mp3",
    ".flac",
    ".m4a",
    ".aac",
    ".ogg",
    ".oga",
    ".wma",
    ".opus",
    ".aif",
    ".aiff",
}
SUPPORTED_FORMATS = {"mp3", "wav", "flac", "ogg"}
JOIN_MODES = {"sequential", "crossfade"}
MAX_TRACKS = 40
SAMPLE_RATES = {44100, 48000}


@dataclass
class TrackSpec:
    path: Path
    volume: float = 1.0
    start_sec: float = 0.0
    end_sec: float | None = None


@dataclass
class JoinJobStatus:
    phase: str = "idle"
    progress: float = 0.0
    message: str | None = None
    result_path: str | None = None
    duration_sec: float | None = None


_job = JoinJobStatus()
_job_lock = threading.RLock()
_job_thread: threading.Thread | None = None


def ensure_workspace() -> None:
    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)


def is_allowed_media_path(path: Path) -> bool:
    resolved = path.resolve()
    if WORKSPACE_ROOT in resolved.parents or resolved == WORKSPACE_ROOT:
        return True
    return resolved.is_file() and resolved.suffix.lower() in ALLOWED_AUDIO_SUFFIXES


def get_join_job_status() -> JoinJobStatus:
    with _job_lock:
        return JoinJobStatus(
            phase=_job.phase,
            progress=_job.progress,
            message=_job.message,
            result_path=_job.result_path,
            duration_sec=_job.duration_sec,
        )


def _set_job(**kwargs: object) -> None:
    with _job_lock:
        for key, value in kwargs.items():
            setattr(_job, key, value)


def _clamp_fade(duration: float, fade: float) -> float:
    dur = max(float(duration), 0.0)
    fd = max(0.0, float(fade))
    if dur <= 0.05:
        return 0.0
    return min(fd, dur * 0.45, max(dur - 0.05, 0.0))


def probe_duration_sec(path: Path, timeout_sec: float = 60.0) -> float:
    prepend_ffmpeg_bin_to_env()
    ffprobe = get_ffprobe_executable()
    cmd = [
        str(ffprobe),
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    proc = run_hidden(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout_sec,
        check=False,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"길이를 읽지 못했습니다: {err or proc.returncode}")
    text = (proc.stdout or "").strip()
    if not text or text.upper() == "N/A":
        raise RuntimeError(f"재생 시간이 없는 파일입니다: {path.name}")
    return float(text)


def resolve_audio_path(raw: str) -> Path:
    path = Path(raw).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"파일을 찾을 수 없습니다: {path}")
    if path.suffix.lower() not in ALLOWED_AUDIO_SUFFIXES:
        raise ValueError(f"지원하지 않는 오디오 형식입니다: {path.name}")
    return path


def _run_ffmpeg(args: list[str], timeout_sec: float, label: str) -> None:
    prepend_ffmpeg_bin_to_env()
    ffmpeg = get_ffmpeg_executable()
    cmd = [str(ffmpeg), "-hide_banner", "-y", *args]
    proc = run_hidden(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout_sec,
        check=False,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        tail = err[-1200:] if err else str(proc.returncode)
        raise RuntimeError(f"{label} 실패: {tail}")


def _afade_filter(duration: float, fade_in: float, fade_out: float, sample_rate: int = 44100) -> str:
    parts = [f"aformat=sample_fmts=fltp:sample_rates={int(sample_rate)}:channel_layouts=stereo"]
    fi = _clamp_fade(duration, fade_in)
    fo = _clamp_fade(duration, fade_out)
    if fi > 0.001:
        parts.append(f"afade=t=in:st=0:d={fi:.4f}:curve=tri")
    if fo > 0.001:
        start = max(0.0, duration - fo)
        parts.append(f"afade=t=out:st={start:.4f}:d={fo:.4f}:curve=tri")
    return ",".join(parts)


def _pre_filter(
    spec: TrackSpec,
    *,
    src_duration: float,
    sample_rate: int,
    trim_silence: bool,
    silence_db: float,
) -> str:
    parts = [f"aformat=sample_fmts=fltp:sample_rates={int(sample_rate)}:channel_layouts=stereo"]
    start = max(0.0, float(spec.start_sec or 0.0))
    if src_duration > 0 and start >= src_duration - 0.01:
        raise ValueError(f"{spec.path.name}: 시작 시각이 파일 길이보다 깁니다.")
    end = spec.end_sec
    if end is not None and float(end) > 0:
        end = min(float(end), src_duration) if src_duration > 0 else float(end)
        if end <= start:
            raise ValueError(f"{spec.path.name}: 끝 시각이 시작보다 커야 합니다.")
        parts.append(f"atrim=start={start:.4f}:end={end:.4f}")
        parts.append("asetpts=PTS-STARTPTS")
    elif start > 0.001:
        parts.append(f"atrim=start={start:.4f}")
        parts.append("asetpts=PTS-STARTPTS")
    if trim_silence:
        th = min(-20.0, max(-70.0, float(silence_db)))
        parts.append(
            "silenceremove="
            f"start_periods=1:start_duration=0.08:start_threshold={th:.1f}dB:detection=rms:"
            f"stop_periods=1:stop_duration=0.08:stop_threshold={th:.1f}dB"
        )
    vol = max(0.0, min(4.0, float(spec.volume)))
    if abs(vol - 1.0) > 0.001:
        parts.append(f"volume={vol:.4f}")
    return ",".join(parts)


def _encode_args(fmt: str, sample_rate: int, normalize: bool) -> list[str]:
    af: list[str] = []
    if normalize:
        af.append("loudnorm=I=-16:TP=-1.5:LRA=11")
    args: list[str] = []
    if af:
        args.extend(["-af", ",".join(af)])
    args.extend(["-ar", str(sample_rate), "-ac", "2"])
    if fmt == "mp3":
        args.extend(["-c:a", "libmp3lame", "-q:a", "2"])
    elif fmt == "wav":
        args.extend(["-c:a", "pcm_s16le"])
    elif fmt == "flac":
        args.extend(["-c:a", "flac"])
    else:
        args.extend(["-c:a", "libvorbis", "-q:a", "5"])
    return args


def _preprocess_tracks(
    specs: list[TrackSpec],
    *,
    sample_rate: int,
    trim_silence: bool,
    silence_db: float,
    job_dir: Path,
    remain,
) -> tuple[list[Path], list[float]]:
    wavs: list[Path] = []
    durations: list[float] = []
    n = len(specs)
    for i, spec in enumerate(specs):
        _set_job(
            phase="running",
            progress=6.0 + (50.0 * i / max(n, 1)),
            message=f"트랙 준비 중 ({i + 1}/{n})",
        )
        src_dur = probe_duration_sec(spec.path, timeout_sec=min(60.0, remain()))
        filt = _pre_filter(
            spec,
            src_duration=src_dur,
            sample_rate=sample_rate,
            trim_silence=trim_silence,
            silence_db=silence_db,
        )
        wav_path = job_dir / f"p{i:02d}.wav"
        _run_ffmpeg(
            ["-i", str(spec.path), "-vn", "-af", filt, "-c:a", "pcm_s16le", "-ar", str(sample_rate), "-ac", "2", str(wav_path)],
            remain(),
            f"{spec.path.name} 준비",
        )
        dur = probe_duration_sec(wav_path, timeout_sec=min(60.0, remain()))
        if dur < 0.05:
            raise RuntimeError(f"{spec.path.name}: 처리 후 소리가 거의 없습니다. 구간이나 무음 자르기를 확인하세요.")
        wavs.append(wav_path)
        durations.append(dur)
    return wavs, durations


def _join_sequential(
    wavs: list[Path],
    durations: list[float],
    *,
    fade_in_sec: float,
    fade_out_sec: float,
    fade_first_in: bool,
    fade_last_out: bool,
    gap_sec: float,
    fmt: str,
    sample_rate: int,
    normalize: bool,
    job_dir: Path,
    remain,
    out_path: Path,
) -> float:
    n = len(wavs)
    concat_names: list[str] = []
    for i, src in enumerate(wavs):
        _set_job(
            phase="running",
            progress=58.0 + (22.0 * i / max(n, 1)),
            message=f"페이드 적용 중 ({i + 1}/{n})",
        )
        fade_in = fade_in_sec if (i > 0 or fade_first_in) else 0.0
        fade_out = fade_out_sec if (i < n - 1 or fade_last_out) else 0.0
        wav_name = f"t{i:02d}.wav"
        wav_path = job_dir / wav_name
        filt = _afade_filter(durations[i], fade_in, fade_out, sample_rate)
        _run_ffmpeg(
            ["-i", str(src), "-vn", "-af", filt, "-c:a", "pcm_s16le", "-ar", str(sample_rate), "-ac", "2", str(wav_path)],
            remain(),
            f"페이드 {i + 1}",
        )
        concat_names.append(wav_name)
        if gap_sec > 0.05 and i < n - 1:
            sil_name = f"g{i:02d}.wav"
            sil_path = job_dir / sil_name
            _run_ffmpeg(
                [
                    "-f",
                    "lavfi",
                    "-i",
                    f"anullsrc=r={sample_rate}:cl=stereo:d={gap_sec:.4f}",
                    "-c:a",
                    "pcm_s16le",
                    "-t",
                    f"{gap_sec:.4f}",
                    str(sil_path),
                ],
                remain(),
                "무음 간격",
            )
            concat_names.append(sil_name)

    list_path = job_dir / "concat.txt"
    list_path.write_text("".join(f"file '{name}'\n" for name in concat_names), encoding="utf-8")
    _set_job(phase="running", progress=84.0, message="파일을 만드는 중")
    _run_ffmpeg(
        [
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_path),
            *_encode_args(fmt, sample_rate, normalize),
            str(out_path),
        ],
        remain(),
        "인코드",
    )
    gap_total = gap_sec * max(0, n - 1)
    return sum(durations) + gap_total


def _join_crossfade(
    wavs: list[Path],
    durations: list[float],
    *,
    fade_in_sec: float,
    fade_out_sec: float,
    fade_first_in: bool,
    fade_last_out: bool,
    crossfade_sec: float,
    fmt: str,
    sample_rate: int,
    normalize: bool,
    remain,
    out_path: Path,
) -> float:
    n = len(wavs)
    parts: list[str] = []
    labels: list[str] = []
    for i in range(n):
        fade_in = fade_in_sec if (i == 0 and fade_first_in) else 0.0
        fade_out = fade_out_sec if (i == n - 1 and fade_last_out) else 0.0
        filt = _afade_filter(durations[i], fade_in, fade_out, sample_rate)
        parts.append(f"[{i}:a]{filt}[a{i}]")
        labels.append(f"[a{i}]")

    cur = labels[0]
    overlap_total = 0.0
    for i in range(1, n):
        d = min(_clamp_fade(durations[i - 1], crossfade_sec), _clamp_fade(durations[i], crossfade_sec))
        d = max(d, 0.02) if crossfade_sec > 0 else 0.02
        overlap_total += d
        nxt = labels[i]
        dst = "[outa]" if i == n - 1 else f"[x{i}]"
        parts.append(f"{cur}{nxt}acrossfade=d={d:.4f}:c1=tri:c2=tri{dst}")
        cur = dst

    filter_complex = ";".join(parts)
    args: list[str] = []
    for src in wavs:
        args.extend(["-i", str(src)])
    args.extend(["-filter_complex", filter_complex, "-map", "[outa]", *_encode_args(fmt, sample_rate, normalize)])
    _set_job(phase="running", progress=78.0, message="크로스페이드로 이어 붙이는 중")
    _run_ffmpeg(args, remain(), "크로스페이드")
    return max(0.1, sum(durations) - overlap_total)


def _parse_specs(raw_tracks: list[dict]) -> list[TrackSpec]:
    specs: list[TrackSpec] = []
    for item in raw_tracks:
        if isinstance(item, str):
            path = resolve_audio_path(item)
            specs.append(TrackSpec(path=path))
            continue
        if not isinstance(item, dict):
            raise ValueError("트랙 정보가 올바르지 않습니다.")
        path = resolve_audio_path(str(item.get("path") or ""))
        vol = float(item.get("volume", 1.0))
        start = float(item.get("start_sec") or 0.0)
        end_raw = item.get("end_sec")
        end = float(end_raw) if end_raw not in (None, "", 0, 0.0) else None
        specs.append(TrackSpec(path=path, volume=vol, start_sec=start, end_sec=end))
    return specs


def run_join(
    raw_tracks: list[dict] | list[str],
    *,
    fade_in_sec: float,
    fade_out_sec: float,
    fade_first_in: bool,
    fade_last_out: bool,
    gap_sec: float,
    join_mode: str,
    crossfade_sec: float,
    fmt: str,
    sample_rate: int,
    normalize: bool,
    trim_silence: bool,
    silence_db: float,
    timeout_sec: float,
) -> tuple[Path, float]:
    ensure_workspace()
    specs = _parse_specs(list(raw_tracks))
    if not specs:
        raise ValueError("음원을 하나 이상 추가하세요.")
    if len(specs) > MAX_TRACKS:
        raise ValueError(f"한 번에 {MAX_TRACKS}개까지 처리할 수 있습니다.")
    fmt = fmt.lower().strip()
    if fmt not in SUPPORTED_FORMATS:
        raise ValueError("지원하지 않는 출력 포맷입니다.")
    mode = join_mode.lower().strip()
    if mode not in JOIN_MODES:
        raise ValueError("연결 방식이 올바르지 않습니다.")
    if len(specs) < 2:
        mode = "sequential"
    if sample_rate not in SAMPLE_RATES:
        sample_rate = 44100

    job_dir = WORKSPACE_ROOT / uuid.uuid4().hex[:12]
    job_dir.mkdir(parents=True, exist_ok=True)
    out_name = "clip" if len(specs) == 1 else "joined"
    out_path = job_dir / f"{out_name}.{fmt}"
    deadline = time.monotonic() + timeout_sec

    def remain() -> float:
        return max(30.0, deadline - time.monotonic())

    try:
        wavs, durations = _preprocess_tracks(
            specs,
            sample_rate=sample_rate,
            trim_silence=trim_silence,
            silence_db=silence_db,
            job_dir=job_dir,
            remain=remain,
        )
        if mode == "crossfade" and len(wavs) >= 2:
            total = _join_crossfade(
                wavs,
                durations,
                fade_in_sec=fade_in_sec,
                fade_out_sec=fade_out_sec,
                fade_first_in=fade_first_in,
                fade_last_out=fade_last_out,
                crossfade_sec=crossfade_sec,
                fmt=fmt,
                sample_rate=sample_rate,
                normalize=normalize,
                remain=remain,
                out_path=out_path,
            )
        else:
            total = _join_sequential(
                wavs,
                durations,
                fade_in_sec=fade_in_sec,
                fade_out_sec=fade_out_sec,
                fade_first_in=fade_first_in,
                fade_last_out=fade_last_out,
                gap_sec=gap_sec if len(wavs) >= 2 else 0.0,
                fmt=fmt,
                sample_rate=sample_rate,
                normalize=normalize,
                job_dir=job_dir,
                remain=remain,
                out_path=out_path,
            )
    except Exception:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise

    for child in list(job_dir.iterdir()):
        if child != out_path:
            try:
                child.unlink()
            except OSError:
                pass

    return out_path, total


def start_join_job(
    raw_tracks: list[dict] | list[str],
    *,
    fade_in_sec: float,
    fade_out_sec: float,
    fade_first_in: bool,
    fade_last_out: bool,
    gap_sec: float,
    join_mode: str,
    crossfade_sec: float,
    fmt: str,
    sample_rate: int,
    normalize: bool,
    trim_silence: bool,
    silence_db: float,
    timeout_sec: float,
) -> None:
    global _job_thread
    with _job_lock:
        if _job_thread is not None and _job_thread.is_alive():
            raise RuntimeError("이미 작업이 진행 중입니다.")
        _job.phase = "running"
        _job.progress = 2.0
        _job.message = "작업을 시작합니다."
        _job.result_path = None
        _job.duration_sec = None

    def worker() -> None:
        try:
            result, duration = run_join(
                raw_tracks,
                fade_in_sec=fade_in_sec,
                fade_out_sec=fade_out_sec,
                fade_first_in=fade_first_in,
                fade_last_out=fade_last_out,
                gap_sec=gap_sec,
                join_mode=join_mode,
                crossfade_sec=crossfade_sec,
                fmt=fmt,
                sample_rate=sample_rate,
                normalize=normalize,
                trim_silence=trim_silence,
                silence_db=silence_db,
                timeout_sec=timeout_sec,
            )
            _set_job(
                phase="ready",
                progress=100.0,
                message="작업이 끝났습니다.",
                result_path=str(result),
                duration_sec=duration,
            )
        except Exception as exc:
            _set_job(
                phase="failed",
                progress=0.0,
                message=str(exc),
                result_path=None,
                duration_sec=None,
            )

    thread = threading.Thread(target=worker, name="audio-join", daemon=True)
    with _job_lock:
        _job_thread = thread
    thread.start()
