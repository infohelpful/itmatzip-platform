"""Python port of the desktop main-process media code.

- probe_media_timing        <- src/main/mediaTiming.ts
- prepare_source_media      <- src/main/preparedMedia.ts (common 48 kHz stereo WAV + zero-origin preview)
- read_prepared_pcm         <- src/main/pcmAudio.ts
- fingerprint_media         <- src/main/projectStorage.ts
- waveform_cache_json_path  <- src/main/waveformCache.ts

The browser has no file system access, so every path it may load is registered here first.
Only registered user media and this engine's own cache files are ever served.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import paths

PREPARED_MEDIA_VERSION = "video-epoch-v1-48k-stereo"
PCM_SAMPLE_RATE = 48000
PCM_BLOCK_SECONDS = 6  # shared/pcmAudio.ts PCM_BLOCK_SECONDS
PCM_MAX_RANGES = 256   # shared/pcmAudio.ts PCM_MAX_RANGES
_DISK_RESERVE_BYTES = 256 * 1024 * 1024
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


class MediaCancelled(RuntimeError):
    def __init__(self) -> None:
        super().__init__("미디어 준비가 취소됐습니다.")


# -- served-file allowlist ---------------------------------------------------------------
_allowed: set[str] = set()
_allowed_lock = threading.Lock()


def _key(path: str | Path) -> str:
    return os.path.normcase(os.path.abspath(str(path)))


def allow_path(path: str | Path) -> None:
    with _allowed_lock:
        _allowed.add(_key(path))


def is_servable(path: str | Path) -> bool:
    key = _key(path)
    with _allowed_lock:
        if key in _allowed:
            return True
    for root in (paths.prepared_media_dir(), paths.waveform_cache_dir()):
        try:
            if os.path.commonpath([key, _key(root)]) == _key(root):
                return True
        except ValueError:
            continue
    return False


def existing_media_file(raw: str, *, require_video: bool = True) -> Path:
    """Validate a user media path, then allow serving it."""
    text = str(raw or "").strip().strip('"')
    if not text:
        raise ValueError("유효한 영상 경로가 필요합니다.")
    path = Path(os.path.normpath(text))
    if not path.is_file():
        raise FileNotFoundError(f"파일을 찾을 수 없습니다: {path}")
    if require_video and not paths.is_video_path(path):
        raise ValueError("지원하지 않는 영상 형식입니다. (mp4, mkv, avi)")
    allow_path(path)
    return path


# -- timing ------------------------------------------------------------------------------
@dataclass
class MediaTiming:
    duration: float
    source_origin_sec: float
    width: int
    height: int
    has_audio: bool
    frame_rate: str
    needs_preview_normalization: bool


def _num(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return math.nan


def parse_media_timing(data: dict[str, Any]) -> MediaTiming:
    streams = data.get("streams") or []
    fmt = data.get("format") or {}
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if not video:
        raise ValueError("Video stream is missing")
    origin = _num(video.get("start_time", fmt.get("start_time", 0)))
    stream_duration = _num(video.get("duration"))
    format_start = _num(fmt.get("start_time", 0))
    format_end = format_start + _num(fmt.get("duration"))
    tagged = re.fullmatch(r"(\d+):(\d+):(\d+(?:\.\d+)?)", str((video.get("tags") or {}).get("DURATION", "")))
    tagged_end = int(tagged[1]) * 3600 + int(tagged[2]) * 60 + float(tagged[3]) if tagged else math.nan
    matroska = any(n in ("matroska", "webm") for n in str(fmt.get("format_name")).split(","))
    fallback_end = _num(fmt.get("duration")) if matroska else format_end
    if math.isfinite(stream_duration) and stream_duration > 0:
        duration = stream_duration
    elif math.isfinite(tagged_end):
        duration = tagged_end - origin
    else:
        duration = fallback_end - origin
    if not math.isfinite(origin) or not math.isfinite(duration) or duration <= 0:
        raise ValueError("Invalid media duration or origin")
    rotation = next((s.get("rotation") for s in video.get("side_data_list") or [] if s.get("rotation") is not None),
                    (video.get("tags") or {}).get("rotate", 0))
    rotated = abs(_num(rotation) % 180) == 90
    sar_parts = [_num(p) for p in str(video.get("sample_aspect_ratio") or "1:1").split(":")]
    sar = sar_parts[0] / sar_parts[1] if len(sar_parts) == 2 and sar_parts[0] > 0 and sar_parts[1] > 0 else 1.0
    display_w = _num(video.get("width")) * max(1.0, sar)
    display_h = _num(video.get("height")) / min(1.0, sar)

    def even(size: float) -> int:
        return max(2, int(round(size / 2)) * 2) if math.isfinite(size) else 2

    format_start_or_origin = _num(fmt.get("start_time", origin))
    return MediaTiming(
        duration=duration, source_origin_sec=origin,
        width=even(display_h if rotated else display_w), height=even(display_w if rotated else display_h),
        has_audio=any(s.get("codec_type") == "audio" for s in streams),
        frame_rate=str(video.get("avg_frame_rate") or video.get("r_frame_rate") or "30/1"),
        needs_preview_normalization=abs(origin) > 0.000001 or format_start_or_origin < origin - 0.001
        or fallback_end - origin > duration + 0.1)


def probe_media_timing(ffprobe: str, input_path: str | Path) -> MediaTiming:
    proc = subprocess.run([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(input_path)],
                          capture_output=True, timeout=30, creationflags=_NO_WINDOW)
    if proc.returncode != 0:
        raise RuntimeError(f"Media probe failed: {proc.stderr.decode('utf-8', 'replace')}")
    return parse_media_timing(json.loads(proc.stdout.decode("utf-8")))


# -- preparation -------------------------------------------------------------------------
@dataclass
class _Job:
    cancel: threading.Event = field(default_factory=threading.Event)
    done: threading.Event = field(default_factory=threading.Event)
    result: dict[str, Any] | None = None
    error: str | None = None


_jobs: dict[str, _Job] = {}
_jobs_lock = threading.Lock()


def _estimate_prepared_bytes(duration: float, source_size: int, audio: bool, preview: bool) -> int:
    return (int(duration * PCM_SAMPLE_RATE * 4) + 1024 if audio else 0) + (source_size if preview else 0)


def _require_disk(directory: Path, needed: int) -> None:
    free = shutil.disk_usage(directory).free
    if free < needed + _DISK_RESERVE_BYTES:
        raise RuntimeError(f"미디어 준비 공간이 부족합니다. 필요 {needed / 1024**3:.2f}GB + 여유 0.25GB, "
                           f"남은 공간 {free / 1024**3:.2f}GB")


def _run_ffmpeg(ffmpeg: str, args: list[str], cancel: threading.Event) -> None:
    proc = subprocess.Popen([ffmpeg, "-nostdin", "-v", "error", "-y", *args], stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, creationflags=_NO_WINDOW)
    try:
        while True:
            try:
                _, err = proc.communicate(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                if cancel.is_set():
                    proc.kill()
                    proc.wait()
                    raise MediaCancelled() from None
    finally:
        if proc.poll() is None:
            proc.kill()
    if proc.returncode != 0:
        raise RuntimeError(f"미디어 시간축 준비 실패: {err.decode('utf-8', 'replace')[-4000:]}")


def _usable(path: Path) -> bool:
    return path.is_file() and path.stat().st_size > 44


def _prepare(input_path: Path, cancel: threading.Event) -> dict[str, Any]:
    ff = paths.ffmpeg_paths()
    if not ff:
        raise RuntimeError("FFmpeg 준비가 필요합니다. 먼저 엔진 다운로드를 실행해 주세요.")
    ffmpeg, ffprobe = ff
    cache = paths.prepared_media_dir()
    cache.mkdir(parents=True, exist_ok=True)
    before = input_path.stat()
    # mtimeMs/ctimeMs as JavaScript formats them, so the cache key matches the desktop recipe.
    key_text = f"{PREPARED_MEDIA_VERSION}|{input_path}|{before.st_size}|{_js_ms(before.st_mtime_ns)}|{_js_ms(before.st_ctime_ns)}"
    key = cache / hashlib.sha256(key_text.encode("utf-8")).hexdigest()
    timing = probe_media_timing(ffprobe, input_path)
    audio_path = key.with_suffix(".wav")
    needs_preview = timing.needs_preview_normalization
    preview_path = key.with_suffix(".mp4") if needs_preview else input_path
    temps: list[Path] = []
    try:
        needs_audio = not _usable(audio_path)
        needs_preview_file = needs_preview and not _usable(preview_path)
        _require_disk(cache, _estimate_prepared_bytes(timing.duration, before.st_size, needs_audio, needs_preview_file))
        if cancel.is_set():
            raise MediaCancelled()
        if needs_audio:
            temp = cache / f"{key.name}.{uuid.uuid4()}.wav"
            temps.append(temp)
            filt = (f"asetpts=PTS-({_js_num(timing.source_origin_sec)})/TB,aresample=48000:async=1:first_pts=0,"
                    f"apad,atrim=duration={_js_num(timing.duration)}")
            args = (["-copyts", "-i", str(input_path), "-map", "0:a:0", "-vn", "-af", filt, "-ac", "2", "-ar", "48000",
                     "-c:a", "pcm_s16le", "-rf64", "auto", str(temp)] if timing.has_audio else
                    ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", _js_num(timing.duration),
                     "-c:a", "pcm_s16le", "-rf64", "auto", str(temp)])
            _run_ffmpeg(ffmpeg, args, cancel)
            os.replace(temp, audio_path)
        if needs_preview_file:
            _require_disk(cache, _estimate_prepared_bytes(timing.duration, before.st_size, False, True))
            temp = cache / f"{key.name}.{uuid.uuid4()}.mp4"
            temps.append(temp)
            # Stream-copy video only; audio always comes from the common WAV.
            _run_ffmpeg(ffmpeg, ["-copyts", "-itsoffset", _js_num(-timing.source_origin_sec), "-i", str(input_path),
                                 "-map", "0:v:0", "-an", "-c:v", "copy", "-avoid_negative_ts", "disabled",
                                 "-movflags", "+faststart", str(temp)], cancel)
            prepared = probe_media_timing(ffprobe, temp)
            if abs(prepared.source_origin_sec) > 0.001 or abs(prepared.duration - timing.duration) > 0.1:
                raise RuntimeError("미리보기 시간축을 원본 영상에 맞추지 못했습니다.")
            os.replace(temp, preview_path)
        after = input_path.stat()
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise RuntimeError("준비 중 원본 영상이 변경되었습니다. 다시 열어 주세요.")
        for path in [audio_path, *([preview_path] if needs_preview else [])]:
            info = path.stat()
            os.utime(path, ns=(_now_ns(), info.st_mtime_ns))  # LRU touch without invalidating peaks
        allow_path(audio_path)
        allow_path(preview_path)
        return {"audioPath": str(audio_path), "previewPath": str(preview_path), "duration": timing.duration,
                "sourceOriginSec": timing.source_origin_sec, "hasAudio": timing.has_audio}
    finally:
        for temp in temps:
            temp.unlink(missing_ok=True)


def _now_ns() -> int:
    import time
    return time.time_ns()


def _js_ms(ns: int) -> str:
    """Format like JavaScript's Number -> string for fs.Stats mtimeMs (fractional milliseconds)."""
    return _js_num(ns / 1_000_000)


def _js_num(value: float) -> str:
    if math.isfinite(value) and value == int(value):
        return str(int(value))
    return repr(float(value))


def start_prepare(path: str, request_id: str) -> None:
    input_path = existing_media_file(path)
    job = _Job()
    with _jobs_lock:
        for other in _jobs.values():  # one preparation per viewer, like the desktop app
            other.cancel.set()
        _jobs[request_id] = job

    def work() -> None:
        try:
            job.result = _prepare(input_path, job.cancel)
        except MediaCancelled as error:
            job.error = str(error)
        except Exception as error:  # noqa: BLE001 - reported to the UI
            job.error = str(error)
        finally:
            job.done.set()

    threading.Thread(target=work, name=f"autosub-prepare-{request_id[:8]}", daemon=True).start()


def prepare_status(request_id: str, wait_sec: float = 0.0) -> dict[str, Any]:
    with _jobs_lock:
        job = _jobs.get(request_id)
    if job is None:
        return {"state": "unknown"}
    if wait_sec > 0:
        job.done.wait(wait_sec)
    if not job.done.is_set():
        return {"state": "running"}
    with _jobs_lock:
        _jobs.pop(request_id, None)
    if job.error is not None:
        return {"state": "done", "result": {"ok": False, "reason": job.error}}
    return {"state": "done", "result": {"ok": True, "media": job.result}}


def cancel_prepare(request_id: str) -> None:
    with _jobs_lock:
        job = _jobs.get(request_id)
    if job:
        job.cancel.set()


def prepare_blocking(path: str) -> dict[str, Any]:
    """Used by transcription, which needs the prepared audio before it starts."""
    return _prepare(existing_media_file(path), threading.Event())


# -- PCM ---------------------------------------------------------------------------------
_EXTENSIBLE_PCM_GUID = bytes.fromhex("0100000000001000800000aa00389b71")


def _describe_pcm(f, size: int) -> tuple[int, int]:
    header = f.read(12)
    rf64 = header[:4] == b"RF64"
    if len(header) < 12 or (not rf64 and header[:4] != b"RIFF") or header[8:12] != b"WAVE":
        raise ValueError("WAV 형식이 아닙니다.")
    position, data64, valid = 12, None, False
    for _ in range(128):
        if position + 8 > size:
            break
        f.seek(position)
        chunk = f.read(8)
        name, length = chunk[:4], struct.unpack("<I", chunk[4:8])[0]
        position += 8
        if name == b"data":
            data_bytes = data64 if rf64 and length == 0xFFFFFFFF else length
            if not valid or data_bytes is None or data_bytes <= 0 or data_bytes % 4 or position + data_bytes > size:
                raise ValueError("유효하지 않은 PCM 데이터입니다.")
            return position, data_bytes // 4
        if position + length > size:
            raise ValueError("WAV 헤더가 잘렸습니다.")
        if name == b"ds64" and rf64:
            if length < 28:
                raise ValueError("유효하지 않은 RF64 헤더입니다.")
            f.seek(position)
            data64 = struct.unpack("<Q", f.read(28)[8:16])[0]
        if name == b"fmt ":
            if length < 16:
                raise ValueError("유효하지 않은 PCM 헤더입니다.")
            f.seek(position)
            fmt = f.read(min(length, 40))
            tag, channels, rate, byte_rate, align, bits = struct.unpack("<HHIIHH", fmt[:16])
            extensible = (tag == 0xFFFE and length >= 40 and struct.unpack("<H", fmt[16:18])[0] >= 22
                          and struct.unpack("<H", fmt[18:20])[0] == 16 and fmt[24:40] == _EXTENSIBLE_PCM_GUID)
            valid = ((tag == 1 or extensible) and channels == 2 and rate == 48000 and byte_rate == 192000
                     and align == 4 and bits == 16)
        position += length + (length % 2)
    raise ValueError("PCM 데이터 헤더를 찾지 못했습니다.")


def read_prepared_pcm(audio_path: str, ranges: list[dict[str, Any]]) -> tuple[int, bytes]:
    """Return (totalFrames, interleaved s16le stereo bytes) for the requested frame ranges."""
    if not isinstance(ranges, list) or len(ranges) > PCM_MAX_RANGES:
        raise ValueError("잘못된 오디오 요청입니다.")
    path = Path(audio_path).resolve()
    root = paths.prepared_media_dir().resolve()
    if path.parent != root or not re.fullmatch(r"[a-f0-9]{64}\.wav", path.name):
        raise ValueError("준비된 오디오 캐시만 읽을 수 있습니다.")
    count = 0
    for item in ranges:
        start, frames = item.get("startFrame") if isinstance(item, dict) else None, item.get("frameCount") if isinstance(item, dict) else None
        if not isinstance(start, int) or isinstance(start, bool) or start < 0 or not isinstance(frames, int) or isinstance(frames, bool) or frames <= 0:
            raise ValueError("잘못된 오디오 구간입니다.")
        count += frames
        if count > PCM_SAMPLE_RATE * PCM_BLOCK_SECONDS:
            raise ValueError("오디오 요청 구간이 너무 큽니다.")
    with open(path, "rb") as f:
        offset, total = _describe_pcm(f, path.stat().st_size)
        if any(r["startFrame"] + r["frameCount"] > total for r in ranges):
            raise ValueError("오디오 범위를 벗어났습니다.")
        out = bytearray()
        for r in ranges:
            f.seek(offset + r["startFrame"] * 4)
            data = f.read(r["frameCount"] * 4)
            if len(data) != r["frameCount"] * 4:
                raise ValueError("준비된 오디오가 잘렸습니다. 영상을 다시 열어 주세요.")
            out += data
    return total, bytes(out)


# -- fingerprint & waveform cache --------------------------------------------------------
def fingerprint_media(path: str) -> dict[str, Any]:
    media = existing_media_file(path)
    before = media.stat()
    digest = hashlib.sha256()
    with open(media, "rb") as f:
        for chunk in iter(lambda: f.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    after = media.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise RuntimeError("확인 중 영상 파일이 변경되었습니다. 다시 시도해 주세요.")
    return {"algorithm": "sha256", "size": before.st_size, "digest": digest.hexdigest()}


def waveform_cache_json_path(path: str) -> dict[str, Any]:
    media = existing_media_file(path)
    st = media.stat()
    key = f"video-epoch-v1|{media}|{st.st_size}|{st.st_mtime_ns // 1_000_000}"
    digest = hashlib.md5(key.encode("utf-8")).hexdigest()  # noqa: S324 - cache key, not security
    cache = paths.waveform_cache_dir()
    cache.mkdir(parents=True, exist_ok=True)
    return {"ok": True, "cachePath": str(cache / f"{digest}.autosub-peaks.json"), "hash": digest}


def read_peaks_json(path: str) -> dict[str, Any]:
    target = Path(path)
    if not is_servable(target) or not target.is_file():
        return {"ok": False, "reason": "not_found"}
    try:
        parsed = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return {"ok": False, "reason": str(error)}
    if not isinstance(parsed, dict) or not isinstance(parsed.get("data"), list):
        return {"ok": False, "reason": "invalid_peaks_json"}
    try:
        os.utime(target, None)
    except OSError:
        pass
    return {"ok": True, "json": parsed}
