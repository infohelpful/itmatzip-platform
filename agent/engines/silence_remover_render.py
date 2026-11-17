"""Silence Remover 전용 컷 렌더러: 유지 구간만 이어 붙여 MP4(H.264 + AAC)로 다시 인코딩한다.

설계: docs/silence-remover-cut-editor-spec.md §8.
- 경계는 편집 FPS 프레임 정수로 받는다.
- 영상: `fps` 필터로 CFR 정규화 → `select` 한 개로 프레임 번호를 골라 이어 붙인다. 컷 수와 상관없이 필터 수가
  일정하다(컷마다 trim 필터를 두면 libavfilter 스케줄러 비용이 컷 수에 비례해 수백 개부터 급격히 느려진다).
- 오디오: PCM 을 한 번 디코드해 Python 에서 샘플 단위로 잘라 붙이고(접합부 4ms 페이드) 임시 WAV 로 만든다.
  결과 타임라인 기준으로 샘플을 반올림해 클립 수와 상관없이 영상과 누적 오차가 없다.
- 이 모듈은 다른 도구(AutoSubtitle 등) 코드를 import 하지 않는다.
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import wave
from array import array
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, BinaryIO, Callable

from common.ffmpeg_filter import filter_complex_argv

AUDIO_RATE = 48000
FADE_FRAMES = round(AUDIO_RATE * 0.004)
QUALITIES = ("high", "standard", "fast")
RENDER_TIMEOUT_SEC = 6 * 60 * 60
AUDIO_PHASE_WEIGHT = 8  # 진행률에서 오디오 준비 단계가 차지하는 비율(%)
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
_HW_ENCODERS = ("h264_nvenc", "h264_qsv", "h264_amf")
ENCODER_NAMES = {
    "h264_nvenc": "NVIDIA NVENC",
    "h264_qsv": "Intel Quick Sync",
    "h264_amf": "AMD AMF",
    "libx264": "x264 (CPU)",
    "aac": "AAC (오디오)",
}
_ENCODER_ARGS: dict[str, dict[str, list[str]]] = {
    "libx264": {
        "high": ["-preset", "medium", "-crf", "18"],
        "standard": ["-preset", "veryfast", "-crf", "21"],
        "fast": ["-preset", "ultrafast", "-crf", "23"],
    },
    "h264_nvenc": {
        "high": ["-preset", "p5", "-rc", "vbr", "-cq", "19", "-b:v", "0"],
        "standard": ["-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0"],
        "fast": ["-preset", "p1", "-rc", "vbr", "-cq", "26", "-b:v", "0"],
    },
    "h264_qsv": {
        "high": ["-preset", "medium", "-global_quality", "20"],
        "standard": ["-preset", "fast", "-global_quality", "23"],
        "fast": ["-preset", "veryfast", "-global_quality", "26"],
    },
    "h264_amf": {
        "high": ["-quality", "quality", "-rc", "cqp", "-qp_i", "18", "-qp_p", "20"],
        "standard": ["-quality", "balanced", "-rc", "cqp", "-qp_i", "21", "-qp_p", "23"],
        "fast": ["-quality", "speed", "-rc", "cqp", "-qp_i", "24", "-qp_p", "26"],
    },
}


class RenderCanceled(RuntimeError):
    pass


# -- source probe ------------------------------------------------------------------------
@dataclass(frozen=True)
class SourceInfo:
    duration: float
    origin: float
    has_video: bool
    has_audio: bool
    width: int
    height: int
    audio_channels: int = 2


def _num(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return math.nan


def parse_source_info(data: dict[str, Any]) -> SourceInfo:
    streams = data.get("streams") or []
    fmt = data.get("format") or {}
    video = next(
        (s for s in streams if s.get("codec_type") == "video"
         and not (s.get("disposition") or {}).get("attached_pic")),
        None,
    )
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if video is None and audio is None:
        raise ValueError("영상·오디오 스트림을 찾지 못했습니다.")
    main = video or audio
    origin = _num(main.get("start_time"))
    if not math.isfinite(origin):
        origin = _num(fmt.get("start_time"))
    if not math.isfinite(origin):
        origin = 0.0
    duration = _num(main.get("duration"))
    if not math.isfinite(duration) or duration <= 0:
        fmt_start = _num(fmt.get("start_time"))
        fmt_dur = _num(fmt.get("duration"))
        if math.isfinite(fmt_dur) and fmt_dur > 0:
            duration = fmt_dur - (origin - fmt_start if math.isfinite(fmt_start) else 0.0)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("미디어 길이를 알 수 없습니다.")
    width = _num(video.get("width")) if video else math.nan
    height = _num(video.get("height")) if video else math.nan
    channels = _num(audio.get("channels")) if audio else math.nan
    return SourceInfo(
        duration=duration,
        origin=origin,
        has_video=video is not None,
        has_audio=audio is not None,
        width=int(width) if math.isfinite(width) else 0,
        height=int(height) if math.isfinite(height) else 0,
        audio_channels=1 if math.isfinite(channels) and int(channels) == 1 else 2,
    )


def probe_source(ffprobe: str, path: Path) -> SourceInfo:
    proc = subprocess.run(
        [ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True, timeout=60, creationflags=_NO_WINDOW,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"미디어 정보를 읽지 못했습니다: {proc.stderr.decode('utf-8', 'replace')[-1000:]}")
    return parse_source_info(json.loads(proc.stdout.decode("utf-8", "replace")))


# -- keep plan ---------------------------------------------------------------------------
def parse_fps(value: str | float | None) -> Fraction:
    if value is None or (isinstance(value, str) and not value.strip()):
        raise ValueError("FPS 가 필요합니다.")
    try:
        if isinstance(value, str) and "/" in value:
            num, den = value.split("/", 1)
            fps = Fraction(int(num.strip()), int(den.strip()))
        else:
            fps = Fraction(str(value)).limit_denominator(1001)
        # 29.97(2997/100) · 23.976 · 59.94 는 NTSC 분수(×1000/1001)로 본다.
        for base in (24, 30, 48, 60, 120):
            ntsc = Fraction(base * 1000, 1001)
            if fps != base and abs(float(fps) - float(ntsc)) < 0.006:
                fps = ntsc
                break
    except (ValueError, ZeroDivisionError) as error:
        raise ValueError(f"FPS 형식이 올바르지 않습니다: {value}") from error
    if fps <= 0 or fps > 240:
        raise ValueError(f"FPS 범위가 올바르지 않습니다: {value}")
    return fps


def available_frames(duration_sec: float, fps: Fraction) -> int:
    return max(1, math.floor(Fraction(duration_sec) * fps + Fraction(1, 1000)))


def normalize_keeps(keeps: list[tuple[int, int]], max_frames: int) -> list[tuple[int, int]]:
    """정렬·겹침 없음·1프레임 이상 검증. `max_frames` 를 넘는 꼬리는 잘라낸다."""
    out: list[tuple[int, int]] = []
    prev_end = 0
    for raw_a, raw_b in keeps:
        a, b = int(raw_a), int(raw_b)
        if a != raw_a or b != raw_b:
            raise ValueError("유지 구간은 프레임 정수여야 합니다.")
        if a < 0 or b <= a:
            raise ValueError(f"유지 구간이 올바르지 않습니다: {a}-{b}")
        if a < prev_end:
            raise ValueError("유지 구간이 정렬되어 있지 않거나 겹칩니다.")
        prev_end = b
        b = min(b, max_frames)
        if b > a:
            out.append((a, b))
    if not out:
        raise ValueError("남는 구간이 없습니다. 컷을 줄인 뒤 다시 시도하세요.")
    return out


def total_frames(keeps: list[tuple[int, int]]) -> int:
    return sum(b - a for a, b in keeps)


def audio_sample_plan(keeps: list[tuple[int, int]], fps: Fraction, rate: int = AUDIO_RATE) -> list[tuple[int, int]]:
    """(원본 시작 샘플, 길이) — 결과 타임라인 기준으로 반올림해 클립 길이 합이 정확히 전체 길이가 된다."""
    plan: list[tuple[int, int]] = []
    program = 0
    for a, b in keeps:
        start = round(Fraction(a) * rate / fps)
        out0 = round(Fraction(program) * rate / fps)
        program += b - a
        out1 = round(Fraction(program) * rate / fps)
        plan.append((start, out1 - out0))
    return plan


# -- video filter ------------------------------------------------------------------------
def _f(value: float) -> str:
    return f"{value:.6f}"


def build_select_expr(keeps: list[tuple[int, int]]) -> str:
    """정렬된 유지 구간에 대한 이진 탐색 수식. `if` 는 고른 쪽만 계산하므로 프레임당 O(log K),
    중첩 깊이도 log K 라 ffmpeg 수식 파서의 깊이 제한(긴 `+` 사슬은 ~100항에서 실패)에 걸리지 않는다."""

    def node(lo: int, hi: int) -> str:
        if hi - lo == 1:
            a, b = keeps[lo]
            return f"between(n,{a},{b - 1})"
        mid = (lo + hi) // 2
        return f"if(lt(n,{keeps[mid][0]}),{node(lo, mid)},{node(mid, hi)})"

    return node(0, len(keeps))


def build_video_filter(keeps: list[tuple[int, int]], fps: Fraction, source: SourceInfo) -> str:
    fps_s = f"{fps.numerator}/{fps.denominator}"
    return (
        f"[0:v:0]setpts=PTS-{_f(source.origin)}/TB,fps=fps={fps_s}:start_time=0,"
        f"scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,"
        f"select='{build_select_expr(keeps)}',setpts=N/({fps_s})/TB,format=yuv420p[vout]"
    )


# -- audio cutter ------------------------------------------------------------------------
def _fade(chunk: bytes, channels: int, fade_in: bool) -> bytes:
    samples = array("h")
    samples.frombytes(chunk)
    frames = len(samples) // channels
    if frames <= 0:
        return chunk
    for i in range(frames):
        gain = (i + 1) / frames if fade_in else (frames - i) / frames
        base = i * channels
        for c in range(channels):
            samples[base + c] = int(samples[base + c] * gain)
    return samples.tobytes()


class _PcmReader:
    """s16le 인터리브 PCM 을 순차로 읽는다. 끝을 넘으면 0(무음)으로 채운다."""

    def __init__(self, stream: BinaryIO, channels: int) -> None:
        self.stream = stream
        self.frame_bytes = 2 * channels
        self.pos = 0
        self.real_bytes = 0
        self.eof = False

    def _read(self, n_frames: int) -> bytes:
        want = n_frames * self.frame_bytes
        parts: list[bytes] = []
        got = 0
        while got < want and not self.eof:
            data = self.stream.read(min(want - got, 1 << 22))
            if not data:
                self.eof = True
                break
            parts.append(data)
            got += len(data)
        self.real_bytes += got
        out = b"".join(parts)
        if len(out) < want:
            out += bytes(want - len(out))
        self.pos += n_frames
        return out

    def skip_to(self, frame: int, step: Callable[[], None]) -> None:
        while self.pos < frame:
            self._read(min(frame - self.pos, 1 << 20))
            step()

    def take(self, n_frames: int) -> bytes:
        return self._read(n_frames)


def cut_audio_to_wav(
    ffmpeg: str,
    source_path: Path,
    source: SourceInfo,
    keeps: list[tuple[int, int]],
    fps: Fraction,
    out_wav: Path,
    *,
    cancel: threading.Event,
    on_progress: Callable[[float], None] = lambda _p: None,
) -> None:
    channels = source.audio_channels
    argv = [ffmpeg, "-nostdin", "-v", "error", "-copyts", "-i", str(source_path), "-map", "0:a:0", "-vn",
            "-af", f"asetpts=PTS-{_f(source.origin)}/TB,aresample={AUDIO_RATE}:async=1:first_pts=0",
            "-ac", str(channels), "-ar", str(AUDIO_RATE), "-f", "s16le", "-"]
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            creationflags=_NO_WINDOW)
    assert proc.stdout is not None and proc.stderr is not None
    err_tail: list[bytes] = []
    threading.Thread(target=lambda: err_tail.append(proc.stderr.read()[-4000:]), daemon=True).start()
    plan = audio_sample_plan(keeps, fps)
    last_frame = max(1, plan[-1][0] + plan[-1][1])
    reader = _PcmReader(proc.stdout, channels)

    def step() -> None:
        if cancel.is_set():
            raise RenderCanceled("취소했습니다.")
        on_progress(min(1.0, reader.pos / last_frame))

    try:
        with wave.open(str(out_wav), "wb") as out:
            out.setnchannels(channels)
            out.setsampwidth(2)
            out.setframerate(AUDIO_RATE)
            for start, length in plan:
                reader.skip_to(start, step)
                if length >= FADE_FRAMES * 4:
                    out.writeframes(_fade(reader.take(FADE_FRAMES), channels, True))
                    remaining = length - 2 * FADE_FRAMES
                    while remaining > 0:
                        n = min(remaining, 1 << 20)
                        out.writeframes(reader.take(n))
                        remaining -= n
                        step()
                    out.writeframes(_fade(reader.take(FADE_FRAMES), channels, False))
                else:
                    out.writeframes(reader.take(length))
                step()
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        proc.stdout.close()
    # 필요한 만큼 읽은 뒤 디코더를 끝내는 것은 정상이다. 실제 데이터를 하나도 못 읽었다면 디코드 실패.
    if reader.real_bytes == 0:
        detail = err_tail[0].decode("utf-8", "replace").strip() if err_tail else ""
        raise RuntimeError(f"오디오를 디코드하지 못했습니다. {detail}".strip())


# -- encoders ----------------------------------------------------------------------------
_encoder_cache: dict[str, list[str]] = {}


def list_h264_encoders(ffmpeg: str) -> list[str]:
    """사용할 순서대로: 하드웨어 → libx264."""
    if ffmpeg in _encoder_cache:
        return _encoder_cache[ffmpeg]
    try:
        out = subprocess.run(
            [ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=30, creationflags=_NO_WINDOW,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        out = ""
    found = [name for name in _HW_ENCODERS if re.search(rf"\b{name}\b", out)]
    result = [*found, "libx264"]
    _encoder_cache[ffmpeg] = result
    return result


def video_encode_args(encoder: str, quality: str) -> list[str]:
    if quality not in QUALITIES:
        raise ValueError(f"지원하지 않는 화질: {quality}")
    return ["-c:v", encoder, *_ENCODER_ARGS[encoder][quality]]


def build_ffmpeg_argv(
    ffmpeg: str,
    source_path: Path,
    graph_argv: list[str],
    source: SourceInfo,
    fps: Fraction,
    encoder: str | None,
    quality: str,
    expected_sec: float,
    output: Path,
    audio_wav: Path | None,
) -> list[str]:
    argv = [ffmpeg, "-nostdin", "-hide_banner", "-y"]
    if source.has_video:
        argv += ["-copyts", "-i", str(source_path)]
    if audio_wav is not None:
        argv += ["-i", str(audio_wav)]
    if source.has_video:
        argv += [*graph_argv, "-map", "[vout]", *video_encode_args(encoder or "libx264", quality),
                 "-pix_fmt", "yuv420p", "-r", f"{fps.numerator}/{fps.denominator}"]
    if audio_wav is not None:
        argv += ["-map", f"{1 if source.has_video else 0}:a:0", "-c:a", "aac", "-b:a", "192k"]
    argv += ["-dn", "-sn", "-map_metadata", "-1", "-t", _f(expected_sec + 0.5),
             "-movflags", "+faststart", "-progress", "pipe:2", "-nostats", str(output)]
    return argv


# -- output location ---------------------------------------------------------------------
_FOLDERID_DOWNLOADS = "{374DE290-123F-4565-9164-39C4925E467B}"


def downloads_dir() -> Path:
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            class _GUID(ctypes.Structure):
                _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD), ("Data3", wintypes.WORD),
                            ("Data4", ctypes.c_ubyte * 8)]

            guid = _GUID()
            ctypes.oledll.ole32.CLSIDFromString(_FOLDERID_DOWNLOADS, ctypes.byref(guid))
            out = ctypes.c_wchar_p()
            ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(out))
            try:
                if out.value and Path(out.value).is_dir():
                    return Path(out.value)
            finally:
                ctypes.windll.ole32.CoTaskMemFree(out)
        except (OSError, AttributeError, ValueError):
            pass
    fallback = Path.home() / "Downloads"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


def resolve_output_path(source_path: Path, ext: str, *, temp_root: Path | None = None) -> Path:
    """원본 폴더에 `<이름>_cut.mp4`. 임시 업로드 폴더이거나 쓰기 불가면 다운로드 폴더."""
    folder = source_path.parent
    try:
        if temp_root is not None and temp_root.resolve() in source_path.resolve().parents:
            folder = downloads_dir()
    except OSError:
        folder = downloads_dir()
    if not os.access(folder, os.W_OK):
        folder = downloads_dir()
    stem = f"{source_path.stem}_cut"
    candidate = folder / f"{stem}{ext}"
    n = 2
    while candidate.exists():
        candidate = folder / f"{stem} ({n}){ext}"
        n += 1
    return candidate


# -- jobs --------------------------------------------------------------------------------
@dataclass
class RenderJob:
    id: str
    output: Path
    expected_sec: float
    state: str = "running"
    percent: int = 0
    label: str = "준비 중…"
    encoder: str | None = None
    error: str | None = None
    cancel: threading.Event | None = None

    def snapshot(self) -> dict[str, Any]:
        return {
            "job_id": self.id,
            "state": self.state,
            "percent": self.percent,
            "label": self.label,
            "encoder_name": ENCODER_NAMES.get(self.encoder or "", self.encoder),
            "error": self.error,
            "output_path": str(self.output) if self.state == "done" else None,
            "expected_sec": self.expected_sec,
        }


_jobs: dict[str, RenderJob] = {}
_jobs_lock = threading.Lock()
_exported: set[str] = set()


def get_job(job_id: str) -> RenderJob:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None:
        raise KeyError("내보내기 작업을 찾을 수 없습니다.")
    return job


def cancel_job(job_id: str) -> bool:
    try:
        job = get_job(job_id)
    except KeyError:
        return False
    if job.cancel:
        job.cancel.set()
    return True


def was_exported(path: str) -> bool:
    return os.path.normcase(os.path.abspath(path)) in _exported


def reveal_in_folder(path: str) -> bool:
    if not was_exported(path) or not Path(path).is_file():
        return False
    if sys.platform == "win32":
        subprocess.Popen(["explorer", "/select,", os.path.abspath(path)], creationflags=_NO_WINDOW)
        return True
    return False


_PROGRESS_RE = re.compile(r"out_time_(?:us|ms)=(-?\d+)")


def progress_percent(line: str, expected_sec: float) -> int | None:
    m = _PROGRESS_RE.fullmatch(line.strip())
    if not m or expected_sec <= 0:
        return None
    raw = int(m.group(1))
    if raw < 0:
        return None
    return max(0, min(99, math.floor(raw / (expected_sec * 1e6) * 100)))


def _run_ffmpeg(argv: list[str], job: RenderJob, on_percent: Callable[[int], None]) -> None:
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, creationflags=_NO_WINDOW)
    assert proc.stderr is not None
    started = time.monotonic()

    def watchdog() -> None:
        while proc.poll() is None:
            assert job.cancel is not None
            if job.cancel.wait(0.25) or time.monotonic() - started > RENDER_TIMEOUT_SEC:
                proc.kill()
                return

    threading.Thread(target=watchdog, name="silence-render-watchdog", daemon=True).start()
    tail = b""
    with proc.stderr:
        for raw in proc.stderr:
            tail = (tail + raw)[-8000:]
            pct = progress_percent(raw.decode("utf-8", "replace"), job.expected_sec)
            if pct is not None:
                on_percent(pct)
    code = proc.wait()
    if job.cancel is not None and job.cancel.is_set():
        raise RenderCanceled("취소했습니다.")
    if code != 0:
        text = tail.decode("utf-8", "replace")
        lines = [ln for ln in text.splitlines() if ln and "=" not in ln[:24]]
        raise RuntimeError(f"ffmpeg 실패 (exit {code}): " + "\n".join(lines[-12:]))


def _verify_output(ffprobe: str, path: Path, source: SourceInfo, expected_sec: float, fps: Fraction) -> None:
    out = probe_source(ffprobe, path)
    tolerance = 0.1 + float(1 / fps)
    if abs(out.duration - expected_sec) > tolerance:
        raise RuntimeError(f"출력 길이가 예상과 다릅니다 (예상 {expected_sec:.2f}초, 결과 {out.duration:.2f}초).")
    if source.has_audio and not out.has_audio:
        raise RuntimeError("출력 파일에 오디오가 없습니다.")
    if source.has_video and not out.has_video:
        raise RuntimeError("출력 파일에 영상이 없습니다.")


def start_render(
    *,
    ffmpeg: str,
    ffprobe: str,
    source_path: Path,
    fps_value: str | float,
    keeps: list[tuple[int, int]],
    quality: str = "standard",
    temp_root: Path | None = None,
    output_path: Path | None = None,
    wait: bool = False,
) -> RenderJob:
    """백그라운드 렌더 시작. `wait=True` 면 끝날 때까지 기다린다(테스트용)."""
    if quality not in QUALITIES:
        raise ValueError(f"지원하지 않는 화질: {quality}")
    fps = parse_fps(fps_value)
    source = probe_source(ffprobe, source_path)
    plan = normalize_keeps(keeps, available_frames(source.duration, fps))
    expected_sec = float(Fraction(total_frames(plan)) / fps)
    ext = ".mp4" if source.has_video else ".m4a"
    encoders = list_h264_encoders(ffmpeg) if source.has_video else ["aac"]
    with _jobs_lock:
        if any(j.state == "running" for j in _jobs.values()):
            raise RuntimeError("이미 내보내기가 진행 중입니다.")
        output = output_path or resolve_output_path(source_path, ext, temp_root=temp_root)
        job = RenderJob(id=str(uuid.uuid4()), output=output, expected_sec=expected_sec,
                        encoder=encoders[0], cancel=threading.Event())
        _jobs[job.id] = job

    def work() -> None:
        assert job.cancel is not None
        tmp_dir = Path(tempfile.mkdtemp(prefix="silence-render-"))
        pending = output.with_name(f"{output.stem}.{job.id[:8]}.partial{output.suffix}")
        try:
            audio_wav: Path | None = None
            if source.has_audio:
                job.label = "오디오 자르는 중…"
                audio_wav = tmp_dir / "audio.wav"
                cut_audio_to_wav(
                    ffmpeg, source_path, source, plan, fps, audio_wav, cancel=job.cancel,
                    on_progress=lambda p: setattr(job, "percent", max(job.percent, int(p * AUDIO_PHASE_WEIGHT))),
                )
            graph_argv: list[str] = []
            if source.has_video:
                graph_argv = filter_complex_argv(ffmpeg, build_video_filter(plan, fps, source),
                                                 script_path=tmp_dir / "graph.txt")
            # 하드웨어 인코더는 첫 번째 것만 시도하고, 실패하면 CPU(libx264)로 한 번 더.
            candidates = [encoders[0]] + (["libx264"] if source.has_video and encoders[0] != "libx264" else [])
            last_error: Exception | None = None
            for encoder in candidates:
                job.encoder = encoder
                job.label = f"인코딩 중… ({ENCODER_NAMES.get(encoder, encoder)})"
                base = job.percent
                argv = build_ffmpeg_argv(ffmpeg, source_path, graph_argv, source, fps,
                                         encoder if source.has_video else None, quality, expected_sec,
                                         pending, audio_wav)

                def on_percent(p: int, base: int = base) -> None:
                    job.percent = max(job.percent, min(99, base + round(p * (100 - base) / 100)))

                try:
                    _run_ffmpeg(argv, job, on_percent)
                    last_error = None
                    break
                except RenderCanceled:
                    raise
                except Exception as error:  # noqa: BLE001 - next encoder
                    last_error = error
                    pending.unlink(missing_ok=True)
                    job.percent = base
                    job.label = "CPU 인코더로 다시 시도 중…"
            if last_error is not None:
                raise last_error
            job.label = "결과 확인 중…"
            _verify_output(ffprobe, pending, source, expected_sec, fps)
            os.replace(pending, output)
            _exported.add(os.path.normcase(os.path.abspath(output)))
            job.percent = 100
            job.label = "완료"
            job.state = "done"
        except RenderCanceled:
            job.state = "canceled"
            job.label = "취소됨"
        except Exception as error:  # noqa: BLE001 - surfaced via status
            job.state = "error"
            job.error = str(error)
            job.label = "실패"
        finally:
            pending.unlink(missing_ok=True)
            shutil.rmtree(tmp_dir, ignore_errors=True)

    thread = threading.Thread(target=work, name="silence-render", daemon=True)
    thread.start()
    if wait:
        thread.join()
    return job
