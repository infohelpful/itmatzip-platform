"""
FFmpeg silencedetect(Auto_Cutter)로 무음·말소리 구간을 찾고 CMX 3600 EDL을 만듭니다.

프로브·파형 PNG는 기존 PCM/ffprobe 로직을 그대로 씁니다.
엔진은 `common.bin_manager`가 준비한 FFmpeg 경로만 사용합니다.
"""

from __future__ import annotations

import array
import base64
import hashlib
import json
import math
import os
import re
import struct
import subprocess
import tempfile
import threading
import time
from collections import OrderedDict
from urllib.parse import quote
from xml.sax.saxutils import escape as xml_escape
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

from engines.silence_remover_runtime import ensure_silence_remover_runtime
from common.runtime_site_packages import use_runtime_site_packages

_PIL_OK = False
_PIL_BOOT_ERROR: str | None = None
try:
    ensure_silence_remover_runtime(install=use_runtime_site_packages())
    from PIL import Image, ImageDraw, ImageFont

    _PIL_OK = True
except (PermissionError, OSError, ImportError, RuntimeError) as exc:
    Image = ImageDraw = ImageFont = None  # type: ignore[misc, assignment]
    _PIL_BOOT_ERROR = str(exc)


def require_pillow() -> None:
    """파형 PNG 등 Pillow 가 필요한 경로에서 호출."""
    if _PIL_OK:
        return
    detail = _PIL_BOOT_ERROR or "Pillow not installed"
    raise RuntimeError(
        f"Silence Remover Pillow를 사용할 수 없습니다 ({detail}). "
        "에이전트를 관리자 권한 없이 재시작하거나, 관리자 PowerShell에서 "
        "go-agent\\scripts\\fix-engine-runtime-permissions.ps1 실행 후 다시 시도하세요."
    )

from common.bin_manager import get_ffmpeg_executable, get_ffprobe_executable
from common.subprocess_util import run_hidden

# Premiere 오디오 트랙 스타일: 녹색 배경 + 흰색 대칭 채움 파형.
_WAVE_TRACK_BG_RGB = (61, 122, 90)
_WAVE_FILL_RGB = (255, 255, 255)
_WAVE_CENTER_LINE_RGB = (118, 142, 128)
_WAVE_SHADOW_RGB = (32, 64, 48)
_WAVE_RULER_BG_RGB = (15, 17, 21)
_WAVE_CANVAS_BG_RGB = _WAVE_RULER_BG_RGB  # 하단 시간 눈금 영역
# 녹색 트랙 위 무음 하이라이트(노랑 대비 마젠타·흰 경계선)
_SILENCE_OVERLAY_FILL_RGBA = (210, 58, 255, 92)
_SILENCE_BOUNDARY_OUTLINE_RGBA = (12, 28, 18, 240)
_SILENCE_BOUNDARY_LINE_RGBA = (255, 255, 255, 255)
_SILENCE_BOUNDARY_OUTLINE_WIDTH = 3
_SILENCE_BOUNDARY_LINE_WIDTH = 1
_DEFAULT_SILENCE_OVERLAY_BAND_FRACTION = 0.48
_SCOPE_SILENCE_REL_FLOOR = 0.04  # 트랙 최대 진폭 대비 이 비율 미만이면 무음(중앙선만)
DEFAULT_WAVEFORM_PIXELS_PER_SECOND = 36.0
DEFAULT_WAVEFORM_MAX_WIDTH = 34000
DEFAULT_WAVEFORM_MIN_WIDTH = 800
# Auto_Cutter 기본값: 말소리 구간 앞뒤 여백(ms)
DEFAULT_VOCAL_PADDING_MS = 18
_WAVEFORM_PEAKS_CACHE_MAX = 6
_CACHE_SCHEMA_VERSION = 5
DISK_CACHE_MAX_AGE_DAYS = 7
DISK_CACHE_MAX_AGE_SEC = DISK_CACHE_MAX_AGE_DAYS * 24 * 60 * 60
DISK_CACHE_PURGE_MIN_INTERVAL_SEC = 6 * 60 * 60
_APPDATA_DIR = os.environ.get("APPDATA", "")
CACHE_ROOT = (
    Path(_APPDATA_DIR) / "ItMatZip" / "cache"
    if _APPDATA_DIR
    else Path(tempfile.gettempdir()) / "ItMatZip_cache"
)


@dataclass
class WaveformPeaksCacheEntry:
    peaks: list[float]
    peaks_db: list[float]
    timeline_sec: float
    column_count: int
    mean_volume_db: float
    max_volume_db: float | None
    decode_sr: int
    pcm_decoded_sec: float = 0.0


_waveform_peaks_cache: OrderedDict[str, WaveformPeaksCacheEntry] = OrderedDict()
_waveform_peaks_cache_lock = threading.Lock()
_volume_detect_cache: OrderedDict[str, tuple[float, float | None]] = OrderedDict()
_volume_detect_cache_lock = threading.Lock()
_last_waveform_cache_hit = False
_disk_cache_purge_lock = threading.Lock()
_disk_cache_purge_last_monotonic = 0.0


def _disk_cache_path(cache_key: str) -> Path:
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    digest = hashlib.md5(cache_key.encode("utf-8")).hexdigest()
    return CACHE_ROOT / f"{digest}.json"


def _touch_disk_cache_file(path: Path) -> None:
    """디스크 캐시 '마지막 사용' 시각 갱신(Windows는 읽기만으로 atime이 안 바뀌는 경우가 많음)."""
    try:
        now = time.time()
        os.utime(path, (now, now))
    except OSError:
        pass


def _cache_file_last_used_ts(path: Path) -> float:
    st = path.stat()
    return max(float(st.st_atime), float(st.st_mtime))


def purge_stale_disk_cache(
    *,
    max_age_sec: float = DISK_CACHE_MAX_AGE_SEC,
    cache_root: Path | None = None,
) -> int:
    """
    max_age_sec 동안 한 번도 읽거나 쓰지 않은 .json / .json.tmp 캐시 파일을 삭제합니다.
    반환: 삭제한 파일 수.
    """
    root = cache_root if cache_root is not None else CACHE_ROOT
    if not root.is_dir():
        return 0
    cutoff = time.time() - max(0.0, float(max_age_sec))
    deleted = 0
    for entry in root.iterdir():
        if not entry.is_file():
            continue
        name = entry.name.lower()
        if not (name.endswith(".json") or name.endswith(".json.tmp")):
            continue
        try:
            if _cache_file_last_used_ts(entry) >= cutoff:
                continue
            entry.unlink(missing_ok=True)
            deleted += 1
        except OSError:
            continue
    return deleted


def maybe_purge_stale_disk_cache(
    *,
    max_age_sec: float = DISK_CACHE_MAX_AGE_SEC,
    min_interval_sec: float = DISK_CACHE_PURGE_MIN_INTERVAL_SEC,
) -> int:
    """짧은 간격으로 반복 호출되지 않도록 스로틀한 뒤 purge_stale_disk_cache 실행."""
    global _disk_cache_purge_last_monotonic
    with _disk_cache_purge_lock:
        now = time.monotonic()
        if now - _disk_cache_purge_last_monotonic < min_interval_sec:
            return 0
        _disk_cache_purge_last_monotonic = now
    return purge_stale_disk_cache(max_age_sec=max_age_sec)


def schedule_disk_cache_purge() -> None:
    """에이전트 시작 시 백그라운드에서 오래된 디스크 캐시를 정리합니다."""
    def _run() -> None:
        try:
            maybe_purge_stale_disk_cache()
        except OSError:
            pass

    threading.Thread(target=_run, name="itmatzip-cache-purge", daemon=True).start()


def _media_stat_cache_key(path: Path) -> str:
    try:
        st = path.stat()
        mtime = int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)))
        size = int(st.st_size)
    except OSError:
        mtime, size = 0, 0
    return f"{path.resolve()}|{mtime}|{size}"


def _store_waveform_peaks_memory(key: str, entry: WaveformPeaksCacheEntry) -> None:
    with _waveform_peaks_cache_lock:
        _waveform_peaks_cache[key] = entry
        _waveform_peaks_cache.move_to_end(key)
        while len(_waveform_peaks_cache) > _WAVEFORM_PEAKS_CACHE_MAX:
            _waveform_peaks_cache.popitem(last=False)


def _waveform_entry_from_disk(data: dict[str, object]) -> WaveformPeaksCacheEntry:
    peaks = data.get("peaks")
    peaks_db = data.get("peaks_db")
    if not isinstance(peaks, list) or not isinstance(peaks_db, list):
        raise ValueError("invalid peaks cache")
    max_db_raw = data.get("max_volume_db")
    max_db: float | None = None
    if max_db_raw is not None:
        max_db = float(max_db_raw)
    return WaveformPeaksCacheEntry(
        peaks=[float(p) for p in peaks],
        peaks_db=[float(p) for p in peaks_db],
        timeline_sec=float(data["timeline_sec"]),
        column_count=int(data["column_count"]),
        mean_volume_db=float(data["mean_volume_db"]),
        max_volume_db=max_db,
        decode_sr=int(data.get("decode_sr") or 48000),
        pcm_decoded_sec=float(data.get("pcm_decoded_sec") or data.get("timeline_sec") or 0),
    )


def _peaks_audio_coverage(peaks: list[float]) -> float:
    last = _last_nonempty_peak_column(peaks)
    n = len(peaks)
    if n < 1 or last < 0:
        return 0.0
    return float(last + 1) / float(n)


def _waveform_entry_is_complete(entry: WaveformPeaksCacheEntry) -> bool:
    """디코드가 재생 길이의 대부분을 커버하는지(무음 꼬리는 peaks_coverage로 판단하지 않음)."""
    if entry.timeline_sec <= 1e-6 or entry.column_count < 2:
        return False
    pcm = float(entry.pcm_decoded_sec)
    if pcm > 1e-6 and pcm < entry.timeline_sec * 0.92:
        return False
    if len(entry.peaks) < 2:
        return False
    return True


def _try_load_waveform_peaks_disk(key: str) -> WaveformPeaksCacheEntry | None:
    path = _disk_cache_path(f"peaks|v{_CACHE_SCHEMA_VERSION}|{key}")
    if not path.is_file():
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if int(data.get("schema_version", 0)) != _CACHE_SCHEMA_VERSION:
            return None
        entry = _waveform_entry_from_disk(data)
        if not _waveform_entry_is_complete(entry):
            return None
        _touch_disk_cache_file(path)
        return entry
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def _save_waveform_peaks_disk(key: str, entry: WaveformPeaksCacheEntry) -> None:
    path = _disk_cache_path(f"peaks|v{_CACHE_SCHEMA_VERSION}|{key}")
    payload = {
        "schema_version": _CACHE_SCHEMA_VERSION,
        "peaks": entry.peaks,
        "peaks_db": entry.peaks_db,
        "timeline_sec": entry.timeline_sec,
        "column_count": entry.column_count,
        "mean_volume_db": entry.mean_volume_db,
        "max_volume_db": entry.max_volume_db,
        "decode_sr": entry.decode_sr,
        "pcm_decoded_sec": entry.pcm_decoded_sec,
    }
    try:
        tmp = path.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, separators=(",", ":"))
        tmp.replace(path)
        maybe_purge_stale_disk_cache()
    except OSError:
        pass


def consume_waveform_cache_hit() -> bool:
    """직전 load_or_build_waveform_peaks_entry 가 캐시를 썼는지 반환 후 플래그를 초기화합니다."""
    global _last_waveform_cache_hit
    hit = _last_waveform_cache_hit
    _last_waveform_cache_hit = False
    return hit


def _waveform_peaks_cache_key(
    path: Path,
    *,
    pixels_per_second: float,
    max_waveform_width: int,
) -> str:
    try:
        st = path.stat()
        mtime = int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)))
        size = int(st.st_size)
    except OSError:
        mtime, size = 0, 0
    return f"{path.resolve()}|{mtime}|{size}|{pixels_per_second:.4f}|{int(max_waveform_width)}"


def load_or_build_waveform_peaks_entry(
    media_path: Path | str,
    *,
    timeout_sec: float = 600.0,
    pixels_per_second: float = DEFAULT_WAVEFORM_PIXELS_PER_SECOND,
    max_waveform_width: int = DEFAULT_WAVEFORM_MAX_WIDTH,
) -> tuple[WaveformPeaksCacheEntry, bool]:
    """
    파형 peaks를 반환합니다. 동일 파일·해상도면 메모리 캐시를 재사용해
    waveform-peaks 로드 후 analyze 시 FFmpeg 디코드를 생략합니다.
    """
    global _last_waveform_cache_hit
    path = Path(media_path)
    if not path.is_file():
        raise FileNotFoundError(f"미디어 파일을 찾을 수 없습니다: {path}")

    key = _waveform_peaks_cache_key(
        path,
        pixels_per_second=pixels_per_second,
        max_waveform_width=max_waveform_width,
    )
    with _waveform_peaks_cache_lock:
        cached = _waveform_peaks_cache.get(key)
        if cached is not None and _waveform_entry_is_complete(cached):
            _waveform_peaks_cache.move_to_end(key)
            _last_waveform_cache_hit = True
            return cached, True
        if cached is not None:
            _waveform_peaks_cache.pop(key, None)

    disk_entry = _try_load_waveform_peaks_disk(key)
    if disk_entry is not None:
        _store_waveform_peaks_memory(key, disk_entry)
        _last_waveform_cache_hit = True
        return disk_entry, True

    t_probe = min(120.0, timeout_sec)
    audio_dur, _sr = get_media_audio_timeline_sec(path, timeout_sec=t_probe)
    duration_sec = float(audio_dur) if audio_dur > 0 else 0.0
    if duration_sec <= 0:
        raise RuntimeError("오디오 타임라인 길이를 알 수 없습니다.")

    waveform_width = compute_waveform_column_count(
        duration_sec,
        pixels_per_second=pixels_per_second,
        max_width=max_waveform_width,
    )
    decode_sr = _waveform_decode_sample_rate(waveform_width, duration_sec)
    mean_db: float | None = None
    max_db: float | None = None

    try:
        mean_db, max_db = get_volume_detect_db(path, timeout_sec=t_probe)
    except (RuntimeError, OSError, subprocess.TimeoutExpired):
        mean_db = -24.0
        max_db = None

    peaks, pcm_decoded_sec, _ = _decode_mono_pcm_peak_per_column(
        path,
        duration_sec=duration_sec,
        n_columns=waveform_width,
        timeout_sec=timeout_sec,
        sample_rate=decode_sr,
    )
    pcm_sec = float(pcm_decoded_sec) if pcm_decoded_sec > 1e-6 else 0.0
    if pcm_sec < duration_sec * 0.97:
        peaks, pcm_decoded_sec, _ = _decode_mono_pcm_peak_per_column(
            path,
            duration_sec=duration_sec,
            n_columns=waveform_width,
            timeout_sec=timeout_sec,
            sample_rate=48000,
        )
        pcm_sec = float(pcm_decoded_sec) if pcm_decoded_sec > 1e-6 else pcm_sec

    timeline_sec = _reconcile_playback_timeline_sec(duration_sec, pcm_sec)
    if pcm_sec < timeline_sec * 0.95:
        raise RuntimeError(
            f"오디오 디코드가 {pcm_sec:.1f}초에서 끊겼습니다 (재생 길이 약 {timeline_sec:.1f}초). "
            "파일·FFmpeg 상태를 확인한 뒤 다시 시도하세요."
        )

    target_width = compute_waveform_column_count(
        timeline_sec,
        pixels_per_second=pixels_per_second,
        max_width=max_waveform_width,
    )
    if target_width != len(peaks) and len(peaks) > 1:
        peaks = _resample_peak_columns(peaks, target_width)

    m_db = float(mean_db) if mean_db is not None else -24.0
    peaks_db = peaks_to_column_dbfs(peaks, m_db)
    entry = WaveformPeaksCacheEntry(
        peaks=peaks,
        peaks_db=peaks_db,
        timeline_sec=float(timeline_sec),
        column_count=len(peaks),
        mean_volume_db=m_db,
        max_volume_db=float(max_db) if max_db is not None else None,
        decode_sr=decode_sr,
        pcm_decoded_sec=float(pcm_sec),
    )
    if not _waveform_entry_is_complete(entry):
        raise RuntimeError(
            f"파형 데이터가 전체 길이를 덮지 못했습니다 "
            f"(디코드 {pcm_sec:.1f}초 / 재생 {timeline_sec:.1f}초)."
        )

    _save_waveform_peaks_disk(key, entry)
    _store_waveform_peaks_memory(key, entry)
    _last_waveform_cache_hit = False
    return entry, False


def get_cached_waveform_peaks_entry(
    media_path: Path | str,
    *,
    pixels_per_second: float = DEFAULT_WAVEFORM_PIXELS_PER_SECOND,
    max_waveform_width: int = DEFAULT_WAVEFORM_MAX_WIDTH,
) -> WaveformPeaksCacheEntry | None:
    """메모리·디스크 캐시만 조회합니다(FFmpeg 디코드 없음)."""
    path = Path(media_path)
    if not path.is_file():
        return None
    key = _waveform_peaks_cache_key(
        path,
        pixels_per_second=pixels_per_second,
        max_waveform_width=max_waveform_width,
    )
    with _waveform_peaks_cache_lock:
        cached = _waveform_peaks_cache.get(key)
        if cached is not None and _waveform_entry_is_complete(cached):
            _waveform_peaks_cache.move_to_end(key)
            return cached
    disk_entry = _try_load_waveform_peaks_disk(key)
    if disk_entry is not None:
        _store_waveform_peaks_memory(key, disk_entry)
        return disk_entry
    return None


def load_or_build_waveform_peaks_for_analyze(
    media_path: Path | str,
    *,
    timeout_sec: float = 600.0,
    pixels_per_second: float = DEFAULT_WAVEFORM_PIXELS_PER_SECOND,
    max_waveform_width: int = DEFAULT_WAVEFORM_MAX_WIDTH,
    require_cached: bool = False,
) -> tuple[WaveformPeaksCacheEntry, bool]:
    """
    분석용 peaks. require_cached=True면 캐시가 없을 때 즉시 실패(재디코드 방지).
    """
    global _last_waveform_cache_hit
    cached = get_cached_waveform_peaks_entry(
        media_path,
        pixels_per_second=pixels_per_second,
        max_waveform_width=max_waveform_width,
    )
    if cached is not None:
        _last_waveform_cache_hit = True
        return cached, True
    if require_cached:
        raise RuntimeError(
            "파형이 아직 준비되지 않았습니다. 경로 입력 후 파형이 화면에 표시될 때까지 "
            "기다린 다음 무음 분석을 실행하세요."
        )
    entry, from_cache = load_or_build_waveform_peaks_entry(
        media_path,
        timeout_sec=timeout_sec,
        pixels_per_second=pixels_per_second,
        max_waveform_width=max_waveform_width,
    )
    return entry, from_cache


_RE_DURATION = re.compile(
    r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)",
    re.IGNORECASE,
)
_RE_SILENCE_START = re.compile(r"silence_start:\s*([\d.]+)")
_RE_SILENCE_END = re.compile(r"silence_end:\s*([\d.]+)")
_RE_MEAN_VOLUME_DB = re.compile(r"mean_volume:\s*([-\d.]+)\s*dB", re.IGNORECASE)
_RE_MAX_VOLUME_DB = re.compile(r"max_volume:\s*([-\d.]+)\s*dB", re.IGNORECASE)


@dataclass(frozen=True)
class SilenceSegment:
    start_sec: float
    end_sec: float


def _load_waveform_ruler_font() -> ImageFont.ImageFont:
    """가능하면 OS 기본 산세리프로 눈금 숫자 가독성을 올립니다."""
    require_pillow()
    candidates: list[Path] = []
    windir = os.environ.get("WINDIR", r"C:\Windows")
    candidates.extend(
        [
            Path(windir) / "Fonts" / "segoeui.ttf",
            Path(windir) / "Fonts" / "arial.ttf",
        ]
    )
    candidates.extend(
        [
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
            Path("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"),
            Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
        ]
    )
    for fp in candidates:
        if fp.is_file():
            try:
                return ImageFont.truetype(str(fp), 11)
            except OSError:
                continue
    return ImageFont.load_default()


def _pcm_decode_ffmpeg_cmd(
    media_path: Path,
    duration_sec: float,
    sample_rate: int,
    *,
    limit_duration: bool = True,
) -> list[str]:
    sr = max(8000, int(sample_rate))
    cmd = [
        str(ffmpeg_path()),
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "error",
        "-vn",
        "-threads",
        "0",
        "-i",
        str(media_path),
    ]
    if limit_duration and duration_sec > 1e-6:
        cmd.extend(["-t", f"{float(duration_sec):.6f}"])
    cmd.extend(
        [
            "-af",
            f"aresample={sr},aformat=sample_fmts=flt:channel_layouts=mono",
            "-f",
            "f32le",
            "-",
        ]
    )
    return cmd


def _last_nonempty_peak_column(peaks: list[float]) -> int:
    for i in range(len(peaks) - 1, -1, -1):
        if peaks[i] > 1e-9:
            return i
    return -1


def _resample_peak_columns(peaks: list[float], new_count: int) -> list[float]:
    """열 수를 바꿀 때 구간 최대 피크를 유지합니다."""
    old_n = len(peaks)
    new_n = int(new_count)
    if new_n < 2 or old_n < 1:
        return peaks if old_n > 0 else [0.0] * max(2, new_n)
    if new_n == old_n:
        return peaks
    out = [0.0] * new_n
    for i in range(new_n):
        c0 = int(i * old_n / new_n)
        c1 = max(c0, int((i + 1) * old_n / new_n) - 1)
        out[i] = max(peaks[c0 : c1 + 1])
    return out


def _resample_peaks_fill_timeline(peaks: list[float], source_cols: int) -> list[float]:
    """
    왼쪽 source_cols 구간의 피크를 전체 열에 max-pool 리샘플.

    stretch(보간 복제) 대신 구간별 최댓값을 유지해 파형 형태가 망가지지 않습니다.
    """
    n = len(peaks)
    src = max(1, min(n, int(source_cols)))
    if src >= n * 0.95:
        return peaks
    out = [0.0] * n
    for i in range(n):
        s0 = int(i * src / n)
        s1 = max(s0, int((i + 1) * src / n) - 1)
        out[i] = max(peaks[s0 : s1 + 1])
    return out


def _reconcile_playback_timeline_sec(probe_sec: float, pcm_sec: float) -> float:
    """
    UI·파형·EDL 공통 재생 길이(초).

    ffprobe 후보(probe)와 PCM 디코드 길이(pcm)를 합칩니다.
    파형·룰러는 PCM 디코드 길이를 우선합니다(컨테이너 format duration 보다 긴 경우).
    """
    probe = float(probe_sec) if probe_sec > 1e-6 else 0.0
    pcm = float(pcm_sec) if pcm_sec > 1e-6 else 0.0
    if probe <= 0 and pcm <= 0:
        return 0.0
    if probe <= 0:
        return pcm
    if pcm <= 0:
        return probe
    if probe > pcm * 8.0:
        return pcm
    if pcm > probe * 8.0:
        return probe
    return max(probe, pcm)


def _pad_peaks_for_shorter_pcm(
    peaks: list[float],
    pcm_timeline_sec: float,
    playback_timeline_sec: float,
) -> list[float]:
    """PCM이 재생 길이보다 짧을 때 앞 구간만 피크를 두고 나머지 열은 무음으로 둡니다."""
    n = len(peaks)
    if n < 2 or playback_timeline_sec <= pcm_timeline_sec * 1.015:
        return peaks
    if pcm_timeline_sec <= 1e-6:
        return [0.0] * n
    ratio = float(pcm_timeline_sec) / float(playback_timeline_sec)
    end_col = max(1, min(n - 1, int(round(n * ratio))))
    compact = _resample_peak_columns(peaks, end_col)
    out = [0.0] * n
    for i in range(end_col):
        out[i] = compact[i]
    return out


def _postprocess_decoded_peaks(
    peaks: list[float],
    *,
    pcm_timeline_sec: float,
    probe_duration_sec: float,
) -> list[float]:
    """디코드 직후 peaks 후처리 — stretch/fill 은 실제 오디오 길이를 왜곡하므로 사용하지 않습니다."""
    _ = pcm_timeline_sec
    _ = probe_duration_sec
    return peaks


def _waveform_decode_sample_rate(n_columns: int, duration_sec: float) -> int:
    """
    파형 열 수에 맞춘 FFmpeg 디코드 샘플레이트.

    전체 48kHz 디코드(수억 샘플)를 피하고 열당 소수 샘플만 추출합니다.
    """
    if duration_sec <= 1e-6 or n_columns < 2:
        return 8000
    per_col = float(n_columns) / float(duration_sec)
    need = per_col * 6.0
    return int(max(200.0, min(16000.0, math.ceil(need))))


def sec_to_waveform_column(t_sec: float, timeline_sec: float, n_columns: int) -> int:
    """PCM 열·무음 오버레이가 공유하는 초→열 매핑 (동일 int 나눗셈)."""
    if timeline_sec <= 1e-12 or n_columns < 1:
        return 0
    t = max(0.0, min(float(t_sec), float(timeline_sec)))
    ncol_m1 = max(0, n_columns - 1)
    col = int(t * float(n_columns) / float(timeline_sec))
    if col > ncol_m1:
        col = ncol_m1
    return col


def sec_to_waveform_column_end_inclusive(
    t_sec: float, timeline_sec: float, n_columns: int
) -> int:
    """구간 끝 시각이 포함되는 마지막 열 (floor-only 매핑보다 오른쪽 경계가 덜 당겨짐)."""
    if timeline_sec <= 1e-12 or n_columns < 1:
        return 0
    ncol_m1 = max(0, n_columns - 1)
    t = max(0.0, min(float(t_sec), float(timeline_sec)))
    if t >= float(timeline_sec) - 1e-12:
        return ncol_m1
    col = int(math.ceil(t * float(n_columns) / float(timeline_sec))) - 1
    return max(0, min(col, ncol_m1))


def silence_segments_to_column_ranges(
    segments: list[SilenceSegment],
    timeline_sec: float,
    n_columns: int,
) -> list[tuple[int, int]]:
    """silencedetect(또는 EDL 무음) 구간 → 파형 열 범위 [시작, 끝] (양끝 포함)."""
    if timeline_sec <= 1e-12 or n_columns < 1 or not segments:
        return []
    ranges: list[tuple[int, int]] = []
    for seg in segments:
        t0 = max(0.0, min(float(seg.start_sec), timeline_sec))
        t1 = max(0.0, min(float(seg.end_sec), timeline_sec))
        if t1 <= t0 + 1e-9:
            continue
        c0 = sec_to_waveform_column(t0, timeline_sec, n_columns)
        c1 = sec_to_waveform_column_end_inclusive(t1, timeline_sec, n_columns)
        if c1 < c0:
            c1 = c0
        ranges.append((c0, c1))
    return ranges


def _merge_adjacent_column_ranges(
    ranges: list[tuple[int, int]],
) -> list[tuple[int, int]]:
    if not ranges:
        return []
    ordered = sorted(ranges, key=lambda r: r[0])
    merged: list[tuple[int, int]] = [ordered[0]]
    for c0, c1 in ordered[1:]:
        p0, p1 = merged[-1]
        if c0 <= p1 + 1:
            merged[-1] = (p0, max(p1, c1))
        else:
            merged.append((c0, c1))
    return merged


def column_ranges_to_silence_segments(
    col_ranges: list[tuple[int, int]],
    timeline_sec: float,
    n_columns: int,
) -> list[SilenceSegment]:
    """파형 열 무음 범위 → 초 단위 SilenceSegment (오버레이·EDL 공통)."""
    if timeline_sec <= 1e-12 or n_columns < 1 or not col_ranges:
        return []
    out: list[SilenceSegment] = []
    for c0, c1 in col_ranges:
        lo = max(0, min(int(c0), n_columns - 1))
        hi = max(0, min(int(c1), n_columns - 1))
        if hi < lo:
            continue
        t0 = lo * float(timeline_sec) / float(n_columns)
        t1 = min(
            float(timeline_sec),
            (hi + 1) * float(timeline_sec) / float(n_columns),
        )
        if t1 > t0 + 1e-9:
            out.append(SilenceSegment(t0, t1))
    return out


def peaks_to_column_dbfs(peaks: list[float], mean_volume_db: float) -> list[float]:
    """파형 열 피크 → volumedetect mean 스케일 dBFS (클라이언트·서버 공통)."""
    if not peaks:
        return []
    sorted_p = sorted(peaks)
    mid = sorted_p[len(sorted_p) // 2]
    if mid < 1e-18:
        return [float(mean_volume_db)] * len(peaks)
    offset = float(mean_volume_db) - 20.0 * math.log10(mid)
    return [20.0 * math.log10(max(float(p), 1e-18)) + offset for p in peaks]


def build_waveform_peaks_payload(
    video_path: Path | str,
    *,
    timeout_sec: float = 600.0,
    pixels_per_second: float = DEFAULT_WAVEFORM_PIXELS_PER_SECOND,
    max_waveform_width: int = DEFAULT_WAVEFORM_MAX_WIDTH,
) -> dict[str, object]:
    """
    Canvas 파형용 경량 데이터: 열당 피크·dB 배열(JSON).

    FFmpeg PCM 디코드 1회만 수행하며 PNG는 만들지 않습니다.
    """
    entry, from_cache = load_or_build_waveform_peaks_entry(
        video_path,
        timeout_sec=timeout_sec,
        pixels_per_second=pixels_per_second,
        max_waveform_width=max_waveform_width,
    )
    return {
        "duration_sec": entry.timeline_sec,
        "timeline_sec": entry.timeline_sec,
        "column_count": entry.column_count,
        "peaks": entry.peaks,
        "peaks_db": entry.peaks_db,
        "mean_volume_db": entry.mean_volume_db,
        "max_volume_db": entry.max_volume_db,
        "sample_rate_hz": entry.decode_sr,
        "pixels_per_second": float(pixels_per_second),
        "from_cache": from_cache,
        "pcm_decoded_sec": entry.pcm_decoded_sec,
        "peaks_coverage": round(_peaks_audio_coverage(entry.peaks), 4),
    }


def silent_column_ranges_from_peaks_db(
    peaks_db: list[float],
    *,
    timeline_sec: float,
    noise_db: float,
    mean_volume_db: float | None = None,
    max_volume_db: float | None = None,
    min_silence_sec: float = 0.1,
    bridge_hole_columns: int = 2,
) -> list[tuple[int, int]]:
    """peaks_db 열 기준 무음 구간(화면 오버레이·분석 동일, O(n))."""
    n = len(peaks_db)
    if n < 1 or timeline_sec <= 1e-9:
        return []
    if mean_volume_db is not None:
        thresh_db = _resolve_silence_threshold_db(
            float(noise_db),
            float(mean_volume_db),
            max_volume_db,
        )
    else:
        thresh_db = float(noise_db)
    silent = [float(db) <= thresh_db for db in peaks_db]
    if bridge_hole_columns > 0:
        silent = _bridge_silent_column_mask(silent, bridge_hole_columns)
    min_cols = max(1, int(round(float(min_silence_sec) / float(timeline_sec) * float(n))))
    ranges: list[tuple[int, int]] = []
    i = 0
    while i < n:
        if not silent[i]:
            i += 1
            continue
        j = i
        while j < n and silent[j]:
            j += 1
        if j - i >= min_cols:
            ranges.append((i, j - 1))
        i = j
    return ranges


def pcm_column_silence_col_ranges(
    peaks: list[float],
    *,
    timeline_sec: float,
    mean_volume_db: float | None,
    noise_db: float,
    max_volume_db: float | None,
    min_silence_sec: float,
    peaks_db: list[float] | None = None,
) -> list[tuple[int, int]]:
    """미리보기·EDL 공통: dB 임계값으로 무음 열 범위를 계산합니다."""
    col_dt = timeline_sec / float(len(peaks)) if peaks else 0.0
    bridge_holes = max(0, min(8, int(round(0.04 / col_dt)))) if col_dt > 1e-9 else 2
    if peaks_db is not None and len(peaks_db) == len(peaks):
        return silent_column_ranges_from_peaks_db(
            peaks_db,
            timeline_sec=timeline_sec,
            noise_db=noise_db,
            mean_volume_db=mean_volume_db,
            max_volume_db=max_volume_db,
            min_silence_sec=min_silence_sec,
            bridge_hole_columns=bridge_holes,
        )
    return silent_column_ranges_from_peaks(
        peaks,
        timeline_sec=timeline_sec,
        mean_volume_db=mean_volume_db,
        noise_db=noise_db,
        max_volume_db=max_volume_db,
        min_silence_sec=min_silence_sec,
        bridge_hole_columns=bridge_holes,
    )


def detect_silence_pcm_column_pipeline(
    video_path: Path | str,
    *,
    noise_db: float,
    min_silence_sec: float,
    padding_ms: float,
    timeout_sec: float = 3600.0,
    pixels_per_second: float = DEFAULT_WAVEFORM_PIXELS_PER_SECOND,
    max_waveform_width: int = DEFAULT_WAVEFORM_MAX_WIDTH,
    mean_volume_db: float | None = None,
    max_volume_db: float | None = None,
    require_cached_peaks: bool = False,
    fps_rational: str | None = None,
) -> tuple[
    list[SilenceSegment],
    float,
    Fraction,
    int,
    list[tuple[float, float]],
    list[SilenceSegment],
    list[SilenceSegment],
    float,
]:
    """
    파형 PCM 열 + dB 임계값으로 무음·말소리·EDL 구간을 만듭니다.

    미리보기 하이라이트와 분석(EDL)이 동일한 기준을 씁니다.
    """
    path = Path(video_path)
    if not path.is_file():
        raise FileNotFoundError(f"영상 파일을 찾을 수 없습니다: {path}")

    applied_noise_db = float(int(round(float(noise_db))))

    entry, _from_cache = load_or_build_waveform_peaks_for_analyze(
        path,
        timeout_sec=timeout_sec,
        pixels_per_second=pixels_per_second,
        max_waveform_width=max_waveform_width,
        require_cached=require_cached_peaks,
    )
    peaks = entry.peaks
    peaks_db = entry.peaks_db
    duration_sec = float(entry.timeline_sec)
    waveform_width = int(entry.column_count)
    if mean_volume_db is None:
        mean_volume_db = entry.mean_volume_db
    if max_volume_db is None:
        max_volume_db = entry.max_volume_db

    col_ranges = pcm_column_silence_col_ranges(
        peaks,
        timeline_sec=duration_sec,
        mean_volume_db=mean_volume_db,
        noise_db=applied_noise_db,
        max_volume_db=max_volume_db,
        min_silence_sec=min_silence_sec,
        peaks_db=peaks_db,
    )
    raw_silences = column_ranges_to_silence_segments(
        col_ranges, duration_sec, waveform_width
    )
    vocal_ms = _vocal_intervals_for_edl(
        raw_silences,
        duration_sec,
        padding_ms=padding_ms,
        min_silence_sec=min_silence_sec,
    )
    silence_segments = _silence_segments_from_vocal_ms(vocal_ms, duration_sec)
    coalesced = _coalesce_silence_segments(
        raw_silences,
        duration_sec,
        min_silence_sec=min_silence_sec,
        padding_ms=padding_ms,
    )

    fps_probe = _parse_rate_string(fps_rational) if fps_rational else None
    if fps_probe is None or fps_probe <= 0:
        t_probe = min(120.0, timeout_sec)
        try:
            fps_probe = get_video_fps_ffprobe(path, timeout_sec=t_probe)
        except (RuntimeError, FileNotFoundError, OSError):
            fps_probe = Fraction(25, 1)

    return (
        silence_segments,
        duration_sec,
        fps_probe,
        waveform_width,
        vocal_ms,
        raw_silences,
        coalesced,
        applied_noise_db,
    )


def intersect_column_ranges_with_pcm_silence(
    col_ranges: list[tuple[int, int]],
    peaks: list[float],
    *,
    mean_volume_db: float | None = None,
    noise_db: float | None = None,
    max_volume_db: float | None = None,
    min_run_columns: int = 2,
) -> list[tuple[int, int]]:
    """
    EDL/silencedetect 무음 구간(열)과 파형 PCM 무음 열의 교집합만 남깁니다.

    silencedetect 시각과 파형 피크가 어긋나 보라 밴드가 말소리(흰 파형)를 덮는
    표시 오류를 줄입니다. EDL·컷 위치는 변경하지 않습니다.
    """
    if not col_ranges or not peaks:
        return []
    silent = _peaks_silent_column_mask(
        peaks,
        mean_volume_db=mean_volume_db,
        noise_db=noise_db,
        max_volume_db=max_volume_db,
    )
    n = len(silent)
    min_run = max(1, int(min_run_columns))
    out: list[tuple[int, int]] = []
    for c0, c1 in col_ranges:
        lo = max(0, min(int(c0), n - 1))
        hi = max(0, min(int(c1), n - 1))
        if hi < lo:
            continue
        i = lo
        while i <= hi:
            while i <= hi and not silent[i]:
                i += 1
            if i > hi:
                break
            j = i
            while j <= hi and silent[j]:
                j += 1
            if j - i >= min_run:
                out.append((i, j - 1))
            i = j
    return _merge_adjacent_column_ranges(out)


def align_silence_segments_to_pcm_timeline(
    segments: list[SilenceSegment],
    detect_timeline_sec: float,
    pcm_timeline_sec: float,
) -> list[SilenceSegment]:
    """silencedetect 타임라인(초) → PCM 실제 길이(초)로 선형 정렬."""
    if pcm_timeline_sec <= 0:
        return []
    if detect_timeline_sec <= 1e-6:
        return clamp_segments_to_axis(segments, pcm_timeline_sec)
    rel = abs(pcm_timeline_sec - detect_timeline_sec) / detect_timeline_sec
    if rel < 0.004:
        return clamp_segments_to_axis(segments, pcm_timeline_sec)
    ratio = float(pcm_timeline_sec) / float(detect_timeline_sec)
    scaled = [
        SilenceSegment(seg.start_sec * ratio, seg.end_sec * ratio) for seg in segments
    ]
    return clamp_segments_to_axis(scaled, pcm_timeline_sec)


def _ffmpeg_decode_pcm_to_file(
    media_path: Path,
    out_path: Path,
    *,
    sample_rate: int,
    timeout_sec: float,
    duration_sec: float | None = None,
) -> None:
    """stdout 파이프 없이 임시 f32le 파일로 디코드(Windows 장시간 파형 절단 방지)."""
    sr = max(8000, int(sample_rate))
    cmd = [
        str(ffmpeg_path()),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-vn",
        "-sn",
        "-dn",
        "-threads",
        "0",
        "-i",
        str(media_path),
    ]
    if duration_sec is not None and float(duration_sec) > 1e-3:
        cmd.extend(["-t", f"{float(duration_sec):.6f}"])
    cmd.extend(
        [
            "-af",
            f"aresample={sr},aformat=sample_fmts=flt:channel_layouts=mono",
            "-f",
            "f32le",
            str(out_path),
        ]
    )
    proc = run_hidden(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=timeout_sec,
        check=False,
    )
    if proc.returncode not in (0, 255):
        raise RuntimeError(f"PCM 디코드 실패 (exit {proc.returncode})")
    if not out_path.is_file() or out_path.stat().st_size < 8:
        raise RuntimeError("PCM 디코드 결과 파일이 비어 있습니다.")


def _peaks_from_pcm_file(
    pcm_path: Path,
    *,
    n_columns: int,
    sample_rate: int,
    probe_duration_sec: float,
) -> tuple[list[float], float, int]:
    """완성된 f32le PCM 파일에서 열당 피크를 추출합니다."""
    sr = max(8000, int(sample_rate))
    file_bytes = pcm_path.stat().st_size
    total_samples = file_bytes // 4
    if total_samples < 2:
        raise RuntimeError("PCM 샘플이 너무 적습니다.")

    axis_sec = max(float(probe_duration_sec), 1e-6)
    expected_samples = max(1, int(axis_sec * sr))
    if total_samples < int(expected_samples * 0.88):
        pcm_sec = float(total_samples) / float(sr)
        pct = int((total_samples / expected_samples) * 100) if expected_samples else 0
        raise RuntimeError(
            f"오디오 디코딩이 불완전합니다 (추출률 {pct}%, "
            f"{pcm_sec:.1f}s / 약 {axis_sec:.1f}s)."
        )

    peaks = [0.0] * n_columns
    ncol_m1 = max(0, n_columns - 1)
    sample_m1 = max(1, total_samples - 1)
    idx = 0
    chunk_bytes = 524_288

    with open(pcm_path, "rb") as pcm_file:
        while True:
            piece = pcm_file.read(chunk_bytes)
            if not piece:
                break
            nfloat = len(piece) // 4
            if nfloat == 0:
                continue
            floats = array.array("f")
            floats.frombytes(piece[: nfloat * 4])
            for s in floats:
                col = (idx * ncol_m1) // sample_m1 if ncol_m1 > 0 else 0
                if col > ncol_m1:
                    col = ncol_m1
                av = abs(s)
                if av > peaks[col]:
                    peaks[col] = av
                idx += 1

    if idx != total_samples:
        raise RuntimeError(
            f"PCM 파일 읽기 불일치 (기대 {total_samples} 샘플, 읽음 {idx})."
        )

    pcm_timeline_sec = float(total_samples) / float(sr)
    return peaks, pcm_timeline_sec, total_samples


def _decode_mono_pcm_peak_per_column(
    media_path: Path,
    *,
    duration_sec: float,
    n_columns: int,
    timeout_sec: float,
    sample_rate: int | None = None,
) -> tuple[list[float], float, int]:
    """
    FFmpeg → 임시 f32le 파일 → 열당 피크.

    stdout 파이프 스트리밍은 Windows에서 장시간 디코드가 중간에 끊기므로 사용하지 않습니다.
    반환: (peaks, 실제 PCM 길이(초), 샘플 수).
    """
    if duration_sec <= 0 or n_columns < 2:
        return [0.0] * max(2, n_columns), max(0.0, float(duration_sec)), 0

    sr = (
        int(sample_rate)
        if sample_rate and sample_rate > 0
        else _waveform_decode_sample_rate(n_columns, duration_sec)
    )
    tmp_path = Path(tempfile.gettempdir()) / f"itmatzip_wf_{os.getpid()}_{time.time_ns()}.f32le"
    try:
        _ffmpeg_decode_pcm_to_file(
            media_path,
            tmp_path,
            sample_rate=sr,
            timeout_sec=timeout_sec,
            duration_sec=float(duration_sec),
        )
        peaks, pcm_timeline_sec, sample_count = _peaks_from_pcm_file(
            tmp_path,
            n_columns=n_columns,
            sample_rate=sr,
            probe_duration_sec=float(duration_sec),
        )
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass

    peaks = _postprocess_decoded_peaks(
        peaks,
        pcm_timeline_sec=pcm_timeline_sec,
        probe_duration_sec=float(duration_sec),
    )
    return peaks, pcm_timeline_sec, sample_count


def _render_scope_waveform_png(
    media_path: Path,
    out_path: Path,
    *,
    waveform_width: int,
    waveform_height: int,
    wave_vertical_fraction: float,
    duration_sec: float,
    timeout_sec: float,
    sample_rate: int | None = None,
    mean_volume_db: float | None = None,
    noise_db: float | None = None,
    max_volume_db: float | None = None,
) -> float:
    """파형 PNG 저장. 반환값은 X축·오버레이에 쓸 **실효 타임라인(초)**."""
    require_pillow()
    canvas_w = waveform_width
    canvas_h = waveform_height
    frac = max(0.5, min(0.98, float(wave_vertical_fraction)))
    wave_h = max(48, int(round(canvas_h * frac)))
    if wave_h >= canvas_h:
        wave_h = max(32, canvas_h - 4)
    peaks, actual_sec, _ = _decode_mono_pcm_peak_per_column(
        media_path,
        duration_sec=duration_sec,
        n_columns=canvas_w,
        timeout_sec=timeout_sec,
        sample_rate=sample_rate,
    )
    effective_dur = actual_sec if actual_sec > 1e-6 else float(duration_sec)
    _draw_scope_waveform_from_peaks(
        peaks,
        out_path,
        waveform_width=canvas_w,
        waveform_height=canvas_h,
        wave_vertical_fraction=wave_vertical_fraction,
        mean_volume_db=mean_volume_db,
        noise_db=noise_db,
        max_volume_db=max_volume_db,
    )
    return effective_dur


def _smooth_peaks_for_display(peaks: list[float], radius: int = 1) -> list[float]:
    """열 단위 피크를 살짝 스무딩해 Premiere처럼 연속된 채움 형태로 보이게 합니다."""
    n = len(peaks)
    if n < 3 or radius < 1:
        return peaks
    out = [0.0] * n
    for i in range(n):
        lo = max(0, i - radius)
        hi = min(n, i + radius + 1)
        out[i] = max(peaks[lo:hi])
    return out


def _draw_scope_waveform_from_peaks(
    peaks: list[float],
    out_path: Path,
    *,
    waveform_width: int,
    waveform_height: int,
    wave_vertical_fraction: float,
    mean_volume_db: float | None = None,
    noise_db: float | None = None,
    max_volume_db: float | None = None,
) -> None:
    """디코드된 열 피크로 Premiere 스타일(녹색 트랙·흰색 대칭 채움) 파형 PNG를 그립니다."""
    require_pillow()
    canvas_w = waveform_width
    canvas_h = waveform_height
    frac = max(0.5, min(0.98, float(wave_vertical_fraction)))
    wave_h = max(48, int(round(canvas_h * frac)))
    if wave_h >= canvas_h:
        wave_h = max(32, canvas_h - 4)
    tr, tg, tb = _WAVE_TRACK_BG_RGB
    im = Image.new("RGB", (canvas_w, canvas_h), (tr, tg, tb))
    dr = ImageDraw.Draw(im)
    pad_top = (canvas_h - wave_h) // 2
    cy = pad_top + wave_h // 2
    vert_pad = 4
    half_max = max(2, wave_h // 2 - vert_pad)
    display_peaks = _smooth_peaks_for_display(peaks, radius=1)
    mx = max(display_peaks) if display_peaks else 0.0
    if mx < 1e-18:
        mx = 1.0
    use_db = mean_volume_db is not None and noise_db is not None
    if use_db:
        thresh_db = _resolve_silence_threshold_db(
            float(noise_db),
            float(mean_volume_db),
            max_volume_db,
        )
    else:
        silence_floor = mx * _SCOPE_SILENCE_REL_FLOOR
    fr, fg, fb = _WAVE_FILL_RGB
    sr, sg, sb = _WAVE_SHADOW_RGB
    use_shadow = canvas_w <= 10000
    for x in range(canvas_w):
        p = display_peaks[x] if x < len(display_peaks) else 0.0
        p_raw = peaks[x] if x < len(peaks) else 0.0
        is_silent = (
            _peak_column_db_calibrated(p_raw, peaks, float(mean_volume_db)) <= thresh_db
            if use_db
            else p < silence_floor
        )
        if is_silent:
            continue
        nn = math.sqrt(max(0.0, min(1.0, p / mx)))
        hh = max(1, int(round(nn * half_max)))
        hh = min(hh, half_max)
        y0 = cy - hh
        y1 = cy + hh
        if use_shadow:
            dr.rectangle([(x, y0 + 1), (x, y1 + 1)], fill=(sr, sg, sb))
        dr.rectangle([(x, y0), (x, y1)], fill=(fr, fg, fb))
    cr, cg, cb = _WAVE_CENTER_LINE_RGB
    dr.line([(0, cy), (canvas_w - 1, cy)], fill=(cr, cg, cb), width=1)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    im.save(out_path, format="PNG")


def ffmpeg_path() -> Path:
    """무음 탐지 등 FFmpeg 호출 시 반드시 공통 설치 경로를 사용합니다."""
    return get_ffmpeg_executable()


def get_video_fps_ffprobe(
    video_path: Path | str,
    *,
    timeout_sec: float = 120.0,
) -> Fraction:
    """
    ffprobe로 첫 번째 비디오 스트림의 프레임레이트를 가져옵니다.

    컨테이너/코덱에 따라 `r_frame_rate`는 30/1처럼 **명목값**만 주고,
    실제 재생에 가까운 값은 패킷 타임스탬프 기반 `avg_frame_rate`(예: NTSC 30000/1001)인 경우가 많습니다.
    그래서 유효하면 `avg_frame_rate`를 우선하고, 없으면 `r_frame_rate`를 씁니다.
    """
    path = Path(video_path)
    if not path.is_file():
        raise FileNotFoundError(f"영상 파일을 찾을 수 없습니다: {path}")

    ffprobe = get_ffprobe_executable()
    cmd = [
        str(ffprobe),
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=r_frame_rate,avg_frame_rate",
        "-of",
        "json",
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
        raise RuntimeError(f"ffprobe 실행 실패: {err or proc.returncode}")

    data = json.loads(proc.stdout or "{}")
    streams = data.get("streams") or []
    if not streams:
        raise RuntimeError("ffprobe 결과에 비디오 스트림(v:0)이 없습니다.")

    st0 = streams[0]
    r_fr = _parse_rate_string(st0.get("r_frame_rate"))
    a_fr = _parse_rate_string(st0.get("avg_frame_rate"))

    if a_fr is not None and a_fr > 0:
        return a_fr
    if r_fr is not None and r_fr > 0:
        return r_fr
    raise RuntimeError("ffprobe에서 유효한 프레임레이트를 읽지 못했습니다.")


def get_video_dimensions_ffprobe(
    video_path: Path | str,
    *,
    timeout_sec: float = 30.0,
) -> tuple[int, int]:
    """ffprobe v:0 width/height — FCP7 XML format용."""
    path = Path(video_path)
    if not path.is_file():
        return 1920, 1080
    ffprobe = get_ffprobe_executable()
    cmd = [
        str(ffprobe),
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "json",
        str(path),
    ]
    try:
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
            return 1920, 1080
        data = json.loads(proc.stdout or "{}")
        streams = data.get("streams") or []
        if not streams:
            return 1920, 1080
        st0 = streams[0]
        w = int(st0.get("width") or 1920)
        h = int(st0.get("height") or 1080)
        return max(1, w), max(1, h)
    except (OSError, subprocess.TimeoutExpired, ValueError, TypeError):
        return 1920, 1080


def _parse_rate_string(s: object) -> Fraction | None:
    if not isinstance(s, str) or not s.strip():
        return None
    if "/" in s:
        a, b = s.split("/", 1)
        try:
            num, den = int(a.strip()), int(b.strip())
        except ValueError:
            return None
        if den == 0:
            return None
        return Fraction(num, den)
    try:
        v = float(s)
    except ValueError:
        return None
    if v <= 0 or not math.isfinite(v):
        return None
    return Fraction(v).limit_denominator(1001)


def get_format_duration_seconds_ffprobe(
    media_path: Path | str,
    *,
    timeout_sec: float = 120.0,
) -> float:
    """ffprobe로 컨테이너 전체 재생 시간(초)을 가져옵니다."""
    path = Path(media_path)
    if not path.is_file():
        raise FileNotFoundError(f"미디어 파일을 찾을 수 없습니다: {path}")

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
        raise RuntimeError(f"ffprobe(duration) 실행 실패: {err or proc.returncode}")

    text = (proc.stdout or "").strip()
    if not text:
        raise RuntimeError("ffprobe에서 duration을 읽지 못했습니다.")
    return float(text)


def get_audio_stream_info_ffprobe(
    media_path: Path | str,
    *,
    timeout_sec: float = 120.0,
) -> tuple[float | None, int | None]:
    """
    첫 오디오 스트림의 duration(초)·sample_rate(Hz).
    없거나 N/A면 (None, None).
    """
    path = Path(media_path)
    ffprobe = get_ffprobe_executable()
    cmd = [
        str(ffprobe),
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=duration,sample_rate",
        "-of",
        "json",
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
        return None, None
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return None, None
    streams = data.get("streams") or []
    if not streams:
        return None, None
    st = streams[0]
    dur_raw = st.get("duration")
    dur: float | None = None
    if dur_raw is not None:
        try:
            d = float(dur_raw)
            if math.isfinite(d) and d > 0:
                dur = d
        except (TypeError, ValueError):
            pass
    sr_raw = st.get("sample_rate")
    sr: int | None = None
    if sr_raw is not None:
        try:
            s = int(float(sr_raw))
            if s > 0:
                sr = s
        except (TypeError, ValueError):
            pass
    return dur, sr


def get_video_stream_duration_ffprobe(
    media_path: Path | str,
    *,
    timeout_sec: float = 120.0,
) -> float | None:
    """첫 비디오 스트림 duration(초). 없거나 N/A면 None."""
    path = Path(media_path)
    if not path.is_file():
        return None
    ffprobe = get_ffprobe_executable()
    cmd = [
        str(ffprobe),
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    try:
        proc = run_hidden(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_sec,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if proc.returncode != 0:
        return None
    text = (proc.stdout or "").strip()
    if not text or text.upper() == "N/A":
        return None
    try:
        d = float(text)
    except ValueError:
        return None
    if math.isfinite(d) and d > 0:
        return d
    return None


def compute_waveform_column_count(
    duration_sec: float,
    *,
    pixels_per_second: float = DEFAULT_WAVEFORM_PIXELS_PER_SECOND,
    max_width: int = DEFAULT_WAVEFORM_MAX_WIDTH,
    min_width: int = DEFAULT_WAVEFORM_MIN_WIDTH,
) -> int:
    """파형 PNG·무음 탐지가 공유하는 가로 열(픽셀) 수."""
    if duration_sec <= 0:
        return min_width
    return int(
        max(
            min_width,
            min(max_width, duration_sec * float(pixels_per_second)),
        )
    )


def _reconcile_duration_candidates(candidates: list[float]) -> float:
    """
    format / 비디오 / 오디오 duration 후보를 하나로 합칩니다.

    한 스트림만 10시간 등으로 잘못 잡힌 경우 blind max 는 파형·룰러를 망가뜨리므로,
    중앙값 근처로 수렴하는 값(대개 실제 재생 길이)을 고릅니다.
    """
    vals = sorted({float(x) for x in candidates if x is not None and float(x) > 1e-3})
    if not vals:
        return 0.0
    if len(vals) == 1:
        return vals[0]
    if len(vals) == 2:
        lo, hi = vals[0], vals[1]
        if hi > lo * 1.12 + 5.0:
            return lo
        return hi
    lo, med, hi = vals[0], vals[len(vals) // 2], vals[-1]
    if hi <= lo * 1.12 + 5.0:
        return hi
    cap = med * 1.12 + 5.0
    trimmed = [v for v in vals if v <= cap]
    return max(trimmed) if trimmed else med


def _playback_timeline_from_probe_candidates(candidates: list[float]) -> float:
    """
    format / video / audio ffprobe 후보에서 실제 재생 길이(초).

    컨테이너 format duration 보다 오디오·비디오 스트림이 길게 잡히는 파일이 있어
    보수적 reconcile 은 파형·PCM 디코드보다 짧을 수 있습니다.
    8배 이상 벗어난 극단값만 제외하고는 가장 긴 후보를 씁니다.
    """
    vals = sorted({float(x) for x in candidates if x is not None and float(x) > 1e-3})
    if not vals:
        return 0.0
    if len(vals) == 1:
        return vals[0]
    lo, hi = vals[0], vals[-1]
    if hi > lo * 8.0:
        return _reconcile_duration_candidates(vals)
    return hi


def get_media_audio_timeline_sec(
    media_path: Path | str,
    *,
    timeout_sec: float = 120.0,
) -> tuple[float, int]:
    """
    파형·silencedetect·UI 공통 재생 타임라인(초)과 샘플레이트.

    format / 비디오 / 오디오 스트림 duration 후보 중 실제 재생에 가까운 값을 씁니다.
    """
    path = Path(media_path)
    t = min(120.0, timeout_sec)
    candidates: list[float] = []
    a_dur, sr = get_audio_stream_info_ffprobe(path, timeout_sec=t)
    if a_dur is not None and a_dur > 0:
        candidates.append(float(a_dur))
    try:
        fmt = get_format_duration_seconds_ffprobe(path, timeout_sec=t)
        if fmt > 0:
            candidates.append(float(fmt))
    except (RuntimeError, FileNotFoundError, OSError, ValueError):
        pass
    v_dur = get_video_stream_duration_ffprobe(path, timeout_sec=t)
    if v_dur is not None and v_dur > 0:
        candidates.append(float(v_dur))
    if not candidates:
        return 0.0, sr or 48000
    return _playback_timeline_from_probe_candidates(candidates), sr or 48000


def clamp_segments_to_axis(
    segments: list[SilenceSegment],
    axis_sec: float,
) -> list[SilenceSegment]:
    """무음 구간을 파형·오버레이 타임라인 길이 안으로 자릅니다."""
    if axis_sec <= 0:
        return []
    out: list[SilenceSegment] = []
    for seg in segments:
        t0 = max(0.0, min(float(seg.start_sec), axis_sec))
        t1 = max(0.0, min(float(seg.end_sec), axis_sec))
        if t1 > t0:
            out.append(SilenceSegment(t0, t1))
    return out


def _timeline_sec_to_x_px(t: float, duration_sec: float, width_px: int) -> int:
    """sec_to_waveform_column 과 동일(픽셀 폭 = 열 수)."""
    return sec_to_waveform_column(t, duration_sec, width_px)


def _peak_column_db_calibrated(peak: float, peaks: list[float], mean_volume_db: float) -> float:
    """
    열 피크(dBFS)를 volumedetect `mean_volume` 스케일에 맞춥니다.

    중앙값 열이 평균 볼륨 근처가 되도록 오프셋을 두어, UI 민감도·평균 대비 해석이 맞게 합니다.
    """
    if not peaks:
        return float("-inf")
    sorted_p = sorted(peaks)
    mid = sorted_p[len(sorted_p) // 2]
    if mid < 1e-18:
        return float(mean_volume_db)
    offset = float(mean_volume_db) - 20.0 * math.log10(mid)
    return 20.0 * math.log10(max(float(peak), 1e-18)) + offset


def _resolve_silence_relative_fraction(noise_db: float) -> float:
    """
    UI 무음 민감도(dB) → 트랙 최대 피크 대비 선형 무음 비율.

    파형 PNG의 짧은 막대/점 표시(`_SCOPE_SILENCE_REL_FLOOR`)와 같은 체계로,
    화면에서 빈 구간으로 보이는 열이 탐지에도 무음으로 잡히게 합니다.
    """
    n = float(noise_db)
    base = _SCOPE_SILENCE_REL_FLOOR
    if n <= -30.0:
        t = max(0.0, min(1.0, (-30.0 - n) / 30.0))
        return base * (1.0 - 0.55 * t)
    t = max(0.0, min(1.0, (n + 30.0) / 20.0))
    return base * (1.0 + 1.4 * t)


def _resolve_silence_threshold_db(
    noise_db: float,
    mean_volume_db: float,
    max_volume_db: float | None = None,
) -> float:
    """
    UI 무음 민감도(noise_db)와 평균 볼륨을 결합한 무음 임계값(dB).

    - noise_db가 클수록(덜 음수) 더 많은 구간을 무음으로 봅니다.
    - 평균·최대 볼륨 대비 상한을 두어 말소리 전체가 무음으로 잡히는 것을 막습니다.
    """
    user = float(noise_db)
    mean_db = float(mean_volume_db)
    cap = mean_db - 3.0
    if max_volume_db is not None and math.isfinite(max_volume_db):
        cap = min(cap, float(max_volume_db) - 8.0)
    thresh = min(user, cap)
    thresh = max(thresh, mean_db - 28.0)
    return max(-70.0, min(-12.0, thresh))


def _bridge_silent_column_mask(silent: list[bool], max_hole: int) -> list[bool]:
    """무음 열 사이 짧은 소리 열을 메워 파형상 끊긴 무음을 이어 줍니다."""
    if max_hole < 1 or len(silent) < 3:
        return silent
    out = list(silent)
    n = len(out)
    i = 0
    while i < n:
        if out[i]:
            i += 1
            continue
        j = i
        while j < n and not out[j]:
            j += 1
        hole = j - i
        if 0 < hole <= max_hole and i > 0 and j < n and out[i - 1] and out[j]:
            for k in range(i, j):
                out[k] = True
        i = j if j > i else i + 1
    return out


def _peaks_silent_column_mask(
    peaks: list[float],
    *,
    mean_volume_db: float | None,
    noise_db: float | None,
    max_volume_db: float | None,
) -> list[bool]:
    """`_draw_scope_waveform_from_peaks`와 동일한 기준으로 열별 무음 여부."""
    n = len(peaks)
    if n < 1:
        return []
    mx = max(peaks) if peaks else 0.0
    if mx < 1e-18:
        mx = 1.0
    use_db = mean_volume_db is not None and noise_db is not None
    if use_db:
        thresh_db = _resolve_silence_threshold_db(
            float(noise_db),
            float(mean_volume_db),
            max_volume_db,
        )
        return [
            _peak_column_db_calibrated(p, peaks, float(mean_volume_db)) <= thresh_db
            for p in peaks
        ]
    silence_floor = mx * _SCOPE_SILENCE_REL_FLOOR
    return [p < silence_floor for p in peaks]


def silent_column_ranges_from_peaks(
    peaks: list[float],
    *,
    timeline_sec: float,
    mean_volume_db: float | None = None,
    noise_db: float | None = None,
    max_volume_db: float | None = None,
    min_silence_sec: float = 0.1,
    bridge_hole_columns: int = 2,
) -> list[tuple[int, int]]:
    """
    파형 PNG에 그려진 것과 같은 열 단위 무음 구간 [시작열, 끝열] (양끝 포함).

    silencedetect 시각 변환 없이 화면과 1:1로 맞춥니다.
    """
    n = len(peaks)
    if n < 1 or timeline_sec <= 1e-9:
        return []
    silent = _peaks_silent_column_mask(
        peaks,
        mean_volume_db=mean_volume_db,
        noise_db=noise_db,
        max_volume_db=max_volume_db,
    )
    if bridge_hole_columns > 0:
        silent = _bridge_silent_column_mask(silent, bridge_hole_columns)
    min_cols = max(1, int(round(float(min_silence_sec) / float(timeline_sec) * float(n))))
    ranges: list[tuple[int, int]] = []
    i = 0
    while i < n:
        if not silent[i]:
            i += 1
            continue
        j = i
        while j < n and silent[j]:
            j += 1
        if j - i >= min_cols:
            ranges.append((i, j - 1))
        i = j
    return ranges


def _run_volume_detect_ffmpeg(
    path: Path,
    *,
    timeout_sec: float,
) -> tuple[float, float | None]:
    """volumedetect 1회 실행(-vn으로 비디오 디코드 제외)."""
    ffmpeg = ffmpeg_path()
    cmd = [
        str(ffmpeg),
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "info",
        "-vn",
        "-threads",
        "0",
        "-i",
        str(path),
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
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
    merged = (proc.stderr or "") + (proc.stdout or "")
    m_mean = _RE_MEAN_VOLUME_DB.search(merged)
    if not m_mean:
        raise RuntimeError("volumedetect 출력에서 mean_volume을 찾지 못했습니다. 오디오 스트림이 있는지 확인하세요.")
    m_max = _RE_MAX_VOLUME_DB.search(merged)
    max_db = float(m_max.group(1)) if m_max else None
    return float(m_mean.group(1)), max_db


def _try_load_volume_detect_disk(vol_key: str) -> tuple[float, float | None] | None:
    path = _disk_cache_path(f"vol|v{_CACHE_SCHEMA_VERSION}|{vol_key}")
    if not path.is_file():
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if int(data.get("schema_version", 0)) != _CACHE_SCHEMA_VERSION:
            return None
        vol = (
            float(data["mean_volume_db"]),
            float(data["max_volume_db"]) if data.get("max_volume_db") is not None else None,
        )
        _touch_disk_cache_file(path)
        return vol
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def _save_volume_detect_disk(vol_key: str, mean_db: float, max_db: float | None) -> None:
    path = _disk_cache_path(f"vol|v{_CACHE_SCHEMA_VERSION}|{vol_key}")
    payload: dict[str, object] = {
        "schema_version": _CACHE_SCHEMA_VERSION,
        "mean_volume_db": mean_db,
        "max_volume_db": max_db,
    }
    try:
        tmp = path.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, separators=(",", ":"))
        tmp.replace(path)
        maybe_purge_stale_disk_cache()
    except OSError:
        pass


def get_volume_detect_db(
    media_path: Path | str,
    *,
    timeout_sec: float = 3600.0,
) -> tuple[float, float | None]:
    """
    ffmpeg `volumedetect`로 평균·최대 레벨(dB)을 반환합니다.

    메모리·디스크 캐시를 사용하며 `-vn`으로 비디오 트랙 디코드를 생략합니다.
    """
    path = Path(media_path)
    if not path.is_file():
        raise FileNotFoundError(f"미디어 파일을 찾을 수 없습니다: {path}")

    vol_key = _media_stat_cache_key(path)
    with _volume_detect_cache_lock:
        cached = _volume_detect_cache.get(vol_key)
        if cached is not None:
            _volume_detect_cache.move_to_end(vol_key)
            return cached

    disk_vol = _try_load_volume_detect_disk(vol_key)
    if disk_vol is not None:
        with _volume_detect_cache_lock:
            _volume_detect_cache[vol_key] = disk_vol
            _volume_detect_cache.move_to_end(vol_key)
            while len(_volume_detect_cache) > _WAVEFORM_PEAKS_CACHE_MAX:
                _volume_detect_cache.popitem(last=False)
        return disk_vol

    mean_db, max_db = _run_volume_detect_ffmpeg(path, timeout_sec=timeout_sec)
    _save_volume_detect_disk(vol_key, mean_db, max_db)
    with _volume_detect_cache_lock:
        _volume_detect_cache[vol_key] = (mean_db, max_db)
        _volume_detect_cache.move_to_end(vol_key)
        while len(_volume_detect_cache) > _WAVEFORM_PEAKS_CACHE_MAX:
            _volume_detect_cache.popitem(last=False)
    return mean_db, max_db


def get_mean_volume_db(
    media_path: Path | str,
    *,
    timeout_sec: float = 3600.0,
) -> float:
    """ffmpeg `volumedetect` 필터로 첫 오디오 스트림의 평균 레벨(mean_volume)을 dB로 반환합니다."""
    mean_db, _ = get_volume_detect_db(media_path, timeout_sec=timeout_sec)
    return mean_db


def _percentile_sorted(sorted_vals: list[float], frac: float) -> float:
    """sorted_vals는 비내림차순. frac in [0,1]."""
    if not sorted_vals:
        return float("-inf")
    frac = max(0.0, min(1.0, frac))
    idx = int(round((len(sorted_vals) - 1) * frac))
    return sorted_vals[idx]


def _peak_columns_to_sorted_dbfs(peaks: list[float], *, eps: float = 1e-10) -> list[float]:
    out = [20.0 * math.log10(max(float(p), eps)) for p in peaks if p > eps]
    out.sort()
    return out


def recommend_silence_noise_db_from_pcm_peaks(
    peaks: list[float],
    *,
    floor_frac: float = 0.12,
    body_frac: float = 0.38,
    gap_min_db: float = 4.0,
    blend: float = 0.58,
    headroom_below_body_db: float = 3.5,
) -> float | None:
    """
    파형 열 피크 dBFS 분포에서 silencedetect용 임계값 후보를 추정합니다.

    silencedetect `noise`는 **이 값보다 조용한** 구간을 무음으로 봅니다.
    값이 덜 음수(예: -15)일수록 무음 판정이 넓어집니다.
    """
    dbs = _peak_columns_to_sorted_dbfs(peaks)
    if len(dbs) < 48:
        return None
    p_lo = _percentile_sorted(dbs, floor_frac)
    p_hi = _percentile_sorted(dbs, body_frac)
    gap = p_hi - p_lo
    if gap < gap_min_db:
        return None
    # 무음 바닥~말소리 하단 사이, 편집용으로는 본체 쪽(덜 음수)에 가깝게
    cand = p_lo + blend * gap
    cap = p_hi - headroom_below_body_db
    if math.isfinite(cap):
        cand = min(cand, cap)
    return cand


def resolve_silencedetect_noise_db(
    user_noise_db: float,
    mean_volume_db: float | None = None,
    max_volume_db: float | None = None,
    *,
    peak_columns: list[float] | None = None,
) -> float:
    """
    silencedetect `noise` 값. 사용자 설정과 추천값 중 더 민감한 쪽(더 음수)을 씁니다.

    UI에서 -30dB만 주면 긴 무음·잡음 구간이 통째로 빠지는 경우가 많아,
    volumedetect 기반 추천값으로 보정합니다.
    """
    noise = float(user_noise_db)
    if mean_volume_db is not None and math.isfinite(float(mean_volume_db)):
        rec = recommend_silence_noise_db(
            float(mean_volume_db),
            max_volume_db,
            peak_columns=peak_columns,
        )
        noise = min(noise, rec)
    return max(-70.0, min(-12.0, noise))


def _dynamic_range_db(
    mean_volume_db: float,
    max_volume_db: float | None,
) -> float:
    if max_volume_db is not None and math.isfinite(max_volume_db):
        return max(1.0, float(max_volume_db) - float(mean_volume_db))
    return 18.0


def recommend_silence_noise_db_with_basis(
    mean_volume_db: float,
    max_volume_db: float | None = None,
    *,
    peak_columns: list[float] | None = None,
    floor_db: float = -55.0,
    ceiling_db: float = -12.0,
    peak_cap_margin_db: float = 10.0,
) -> tuple[float, dict[str, float]]:
    """
    평균 볼륨(mean_volume) · 최대 볼륨 · DR 기반 silencedetect `noise`(dB) 추천.

    silencedetect: **이 dB보다 조용한** 구간을 무음으로 봅니다.
    값이 덜 음수일수록(0dB에 가까울수록) 무음 판정이 **공격적**이고 말이 잘리기 쉽습니다.

    - **메인**: `mean_volume + offset_from_mean` (평균·DR 기준)
    - **안전장치**: `max_volume - offset_from_peak` (피크 대비, 보통 더 음수)
    - **최종 선택**: 후보 중 **min**(가장 음수) → 말소리 over-cut 방지
    - **상한**: `max_volume - 10dB` — 피크 3dB만 살리는 위험 방지
    - **하한**: `mean - (8~20dB)` — 무음이 거의 안 잡히는 것 방지
    """
    if not math.isfinite(mean_volume_db):
        raise ValueError("mean_volume_db가 유효한 숫자가 아닙니다.")

    mean_db = float(mean_volume_db)
    dr = _dynamic_range_db(mean_db, max_volume_db)

    offset_from_mean_db = 3.5 + 0.24 * min(dr, 40.0)
    from_mean_db = mean_db + offset_from_mean_db

    candidates: list[float] = [from_mean_db]
    from_peak_db: float | None = None
    from_pcm_db: float | None = None

    if max_volume_db is not None and math.isfinite(max_volume_db):
        max_db = float(max_volume_db)
        offset_from_peak_db = 7.0 + 0.30 * min(dr, 40.0)
        from_peak_db = max_db - offset_from_peak_db
        candidates.append(from_peak_db)

    if peak_columns:
        pcm_raw = recommend_silence_noise_db_from_pcm_peaks(peak_columns)
        if pcm_raw is not None and math.isfinite(pcm_raw):
            # PCM은 메인보다 음수(보수) 쪽이고, 피크 안전선 이상일 때만 후보
            pcm_floor = mean_db - min(18.0, 8.0 + 0.30 * dr)
            from_pcm_db = pcm_raw
            if from_peak_db is not None:
                from_pcm_db = max(from_pcm_db, from_peak_db)
            from_pcm_db = max(from_pcm_db, pcm_floor)
            if from_pcm_db <= from_mean_db + 0.5:
                candidates.append(from_pcm_db)

    # 보수적 선택: 가장 음수(덜 공격적) — 숨소리·말끝 보존
    pre_cap_db = min(candidates)
    raw = pre_cap_db

    cap_db = mean_db + 2.0
    if max_volume_db is not None and math.isfinite(max_volume_db):
        cap_db = min(cap_db, float(max_volume_db) - peak_cap_margin_db)
    raw = min(raw, cap_db)

    floor_thresh_db = mean_db - min(20.0, 8.0 + 0.35 * dr)
    raw = max(raw, floor_thresh_db)

    final = max(floor_db, min(ceiling_db, raw))
    basis = {
        "mean_volume_db": mean_db,
        "dynamic_range_db": dr,
        "offset_from_mean_db": offset_from_mean_db,
        "from_mean_db": from_mean_db,
        "pre_cap_db": pre_cap_db,
        "cap_db": cap_db,
        "floor_thresh_db": floor_thresh_db,
        "peak_cap_margin_db": peak_cap_margin_db,
    }
    if max_volume_db is not None and math.isfinite(max_volume_db):
        basis["max_volume_db"] = float(max_volume_db)
    if from_peak_db is not None:
        basis["from_peak_db"] = from_peak_db
    if from_pcm_db is not None:
        basis["from_pcm_db"] = from_pcm_db
    basis["chosen_db"] = final
    return final, basis


def recommend_silence_noise_db(
    mean_volume_db: float,
    max_volume_db: float | None = None,
    *,
    peak_columns: list[float] | None = None,
    floor_db: float = -55.0,
    ceiling_db: float = -12.0,
) -> float:
    """`recommend_silence_noise_db_with_basis`의 추천 dB만 반환."""
    rec, _ = recommend_silence_noise_db_with_basis(
        mean_volume_db,
        max_volume_db,
        peak_columns=peak_columns,
        floor_db=floor_db,
        ceiling_db=ceiling_db,
    )
    return rec


def _truncate_decimal_places(x: float, places: int = 2) -> float:
    """소수 places+1자리는 버리고(0 방향 절단) places자리까지만 남깁니다."""
    if not math.isfinite(x):
        return x
    factor = 10**places
    return math.trunc(x * factor) / factor


def compute_recommended_noise_db_for_media(
    media_path: Path | str,
    *,
    timeout_sec: float = 120.0,
) -> tuple[float, float, float | None, dict[str, float]]:
    """
    volumedetect + 파형 PCM 분포로 영상별 추천 silencedetect noise(dB)를 계산합니다.

    반환: (recommended_db, mean_volume_db, max_volume_db|None, 계산 근거)
    """
    path = Path(media_path)
    if not path.is_file():
        raise FileNotFoundError(f"미디어 파일을 찾을 수 없습니다: {path}")

    t = min(120.0, timeout_sec)
    mean_db, max_db = get_volume_detect_db(path, timeout_sec=t)
    dur, sr = get_media_audio_timeline_sec(path, timeout_sec=t)
    peak_cols = min(1200, max(400, int(max(1.0, dur) * 2)))
    peaks, _, _ = _decode_mono_pcm_peak_per_column(
        path,
        duration_sec=dur,
        n_columns=peak_cols,
        timeout_sec=timeout_sec,
        sample_rate=sr,
    )
    rec, basis = recommend_silence_noise_db_with_basis(
        mean_db,
        max_db,
        peak_columns=peaks,
    )
    return rec, mean_db, max_db, basis


def resolve_autocutter_noise_db(
    media_path: Path | str,
    user_noise_db: float,
    *,
    use_recommended_noise: bool,
    timeout_sec: float = 3600.0,
) -> tuple[float, float | None]:
    """
    Auto_Cutter 파이프라인용 silencedetect threshold.

    use_recommended_noise=True면 영상별 추천값(정수 dB), False면 슬라이더 값.
    """
    if use_recommended_noise:
        rec, _, _, _ = compute_recommended_noise_db_for_media(
            media_path,
            timeout_sec=timeout_sec,
        )
        return float(int(round(rec))), float(rec)
    return float(int(round(float(user_noise_db)))), None


def _probe_pcm_peaks_sample(
    media_path: Path,
    *,
    duration_sec: float,
    sample_rate: int,
    timeout_sec: float,
) -> list[float] | None:
    """프로브용: 앞부분만 빠르게 PCM 피크를 샘플링합니다(전체 디코드 방지)."""
    probe_dur = min(max(1.0, float(duration_sec)), 120.0)
    n_columns = min(400, max(160, int(probe_dur * 3)))
    try:
        peaks, _, _ = _decode_mono_pcm_peak_per_column(
            media_path,
            duration_sec=probe_dur,
            n_columns=n_columns,
            timeout_sec=min(90.0, timeout_sec),
            sample_rate=sample_rate,
        )
        return peaks if peaks else None
    except (RuntimeError, OSError, subprocess.TimeoutExpired, ValueError):
        return None


def probe_media_for_silence_ui(
    media_path: Path | str,
    *,
    timeout_sec: float = 300.0,
) -> dict[str, object]:
    """
    UI용: FPS(비디오 스트림이 있으면 ffprobe), 평균 볼륨(volumedetect), 추천 silencedetect noise(dB)를 한 번에 반환합니다.
    비디오 스트림이 없으면 fps는 25로 두고 has_video_stream=False 입니다.
    """
    path = Path(media_path)
    if not path.is_file():
        raise FileNotFoundError(f"미디어 파일을 찾을 수 없습니다: {path}")

    t = min(120.0, timeout_sec)
    has_video = True
    try:
        fps_frac = get_video_fps_ffprobe(path, timeout_sec=t)
        fps_rational = f"{fps_frac.numerator}/{fps_frac.denominator}"
        fps_float = float(fps_frac)
    except (RuntimeError, FileNotFoundError, OSError):
        has_video = False
        fps_rational = "25/1"
        fps_float = 25.0

    mean_db, max_db = get_volume_detect_db(path, timeout_sec=t)
    dur, sr = get_media_audio_timeline_sec(path, timeout_sec=t)
    peaks = _probe_pcm_peaks_sample(
        path,
        duration_sec=dur,
        sample_rate=sr,
        timeout_sec=timeout_sec,
    )
    rec_noise, rec_basis = recommend_silence_noise_db_with_basis(
        mean_db,
        max_db,
        peak_columns=peaks,
    )

    out: dict[str, object] = {
        "fps": _truncate_decimal_places(fps_float, 2),
        "fps_rational": fps_rational,
        "has_video_stream": has_video,
        "mean_volume_db": _truncate_decimal_places(mean_db, 2),
        "recommended_noise_db": _truncate_decimal_places(rec_noise, 2),
        "recommendation_basis": {
            k: _truncate_decimal_places(float(v), 2) for k, v in rec_basis.items()
        },
        "duration_sec": _truncate_decimal_places(dur, 2),
        "sample_rate_hz": int(sr),
    }
    if max_db is not None and math.isfinite(max_db):
        out["max_volume_db"] = _truncate_decimal_places(float(max_db), 2)
    if "dynamic_range_db" in rec_basis:
        out["dynamic_range_db"] = _truncate_decimal_places(
            float(rec_basis["dynamic_range_db"]),
            2,
        )
    return out


def render_waveform_preview_png(
    media_path: Path | str,
    output_path: Path | str,
    *,
    waveform_width: int = 4000,
    waveform_height: int = 200,
    wave_vertical_fraction: float = 0.72,
    timeout_sec: float = 600.0,
    duration_sec: float | None = None,
    mean_volume_db: float | None = None,
    noise_db: float | None = None,
    max_volume_db: float | None = None,
) -> tuple[Path, float]:
    """
    무음 마커 없이 전체 타임라인 파형 PNG를 만듭니다.

    반환: (출력 경로, X축·눈금에 쓸 실효 길이 초).
    """
    require_pillow()
    path = Path(media_path)
    out = Path(output_path)
    if not path.is_file():
        raise FileNotFoundError(f"미디어 파일을 찾을 수 없습니다: {path}")
    if waveform_width < 400:
        raise ValueError("waveform_width는 400 이상이어야 합니다.")
    canvas_h = waveform_height
    if canvas_h < 80:
        raise ValueError("waveform_height(캔버스 세로)는 80 이상이어야 합니다.")

    if duration_sec is not None and duration_sec > 0:
        dur = float(duration_sec)
        _, sr = get_audio_stream_info_ffprobe(path, timeout_sec=min(120.0, timeout_sec))
        sample_rate = sr or 48000
    else:
        dur, sample_rate = get_media_audio_timeline_sec(path, timeout_sec=min(120.0, timeout_sec))
    if dur <= 0:
        raise RuntimeError("유효한 재생 시간(duration)이 없습니다.")

    try:
        effective_dur = _render_scope_waveform_png(
            path,
            out,
            waveform_width=waveform_width,
            waveform_height=canvas_h,
            wave_vertical_fraction=wave_vertical_fraction,
            duration_sec=dur,
            timeout_sec=timeout_sec,
            sample_rate=sample_rate,
            mean_volume_db=mean_volume_db,
            noise_db=noise_db,
            max_volume_db=max_volume_db,
        )
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"파형 PCM 디코드 시간 초과: {e}") from e
    if not out.is_file():
        raise RuntimeError("파형 PNG 파일이 생성되지 않았습니다.")
    return out, effective_dur


def append_waveform_guides_and_ruler(
    im: Image.Image,
    duration_sec: float,
    *,
    playhead_sec: float | None = None,
    ruler_h: int = 36,
) -> Image.Image:
    """
    0dB 기준 수평선·선택 재생 위치 세로선·하단 시간 눈금을 추가합니다.
    """
    im = im.convert("RGBA")
    w_px, h_body = im.size
    if duration_sec <= 0 or w_px < 2:
        return im

    draw = ImageDraw.Draw(im)
    cy = h_body // 2
    cr, cg, cb = _WAVE_CENTER_LINE_RGB
    draw.line([(0, cy), (w_px - 1, cy)], fill=(cr, cg, cb, 200), width=1)

    x_max = max(0, w_px - 1)

    def sec_to_x(t: float) -> int:
        return _timeline_sec_to_x_px(t, duration_sec, w_px)

    if playhead_sec is not None and math.isfinite(playhead_sec):
        px = sec_to_x(playhead_sec)
        draw.line([(px, 0), (px, h_body - 1)], fill=(96, 180, 255, 250), width=1)

    out = Image.new("RGBA", (w_px, h_body + ruler_h), (*_WAVE_CANVAS_BG_RGB, 255))
    out.paste(im, (0, 0))
    dr = ImageDraw.Draw(out)
    # 파형과 눈금 사이 구분 (매우 얇은 하이라이트)
    dr.line([(0, h_body - 1), (w_px - 1, h_body - 1)], fill=(55, 55, 55, 255), width=1)

    font = _load_waveform_ruler_font()

    minor = 5.0
    if duration_sec <= 120.0:
        major = 10.0
    elif duration_sec <= 600.0:
        major = 15.0
    elif duration_sec <= 3600.0:
        major = 30.0
    else:
        major = 60.0

    steps = int(math.ceil(duration_sec / minor)) + 1
    by = h_body + ruler_h - 1
    last_label_x = -999
    for i in range(steps + 1):
        t = min(duration_sec, i * minor)
        x = sec_to_x(t)
        if major > 1e-6:
            k_round = round(t / major)
            is_major = abs(t - k_round * major) < minor * 0.46 or t < 1e-6
        else:
            is_major = True
        tick_h = 12 if is_major else 5
        tick_rgb = (150, 150, 150, 255) if is_major else (85, 85, 85, 255)
        dr.line([(x, by), (x, by - tick_h)], fill=tick_rgb, width=1)
        if (
            is_major
            and w_px / max(duration_sec, 1e-6) > 2.5
            and abs(x - last_label_x) >= 26
        ):
            label = f"{int(round(t))}s"
            dr.text(
                (min(x + 3, w_px - 34), h_body + 5),
                label,
                fill=(200, 200, 200, 255),
                font=font,
            )
            last_label_x = x

    return out


def finalize_preview_png_file(
    path_png: Path,
    duration_sec: float,
    *,
    playhead_sec: float | None = None,
) -> None:
    """파형 PNG 파일을 열어 눈금·가이드를 합성한 뒤 같은 경로에 덮어씁니다."""
    im = Image.open(path_png).convert("RGBA")
    out = append_waveform_guides_and_ruler(im, duration_sec, playhead_sec=playhead_sec)
    out.save(path_png, format="PNG")


def _silence_overlay_band_y(
    height_px: int,
    *,
    silence_overlay_band_fraction: float,
) -> tuple[int, int]:
    """무음 밴드·경계선이 그려질 세로 범위 (양끝 포함)."""
    band_frac = max(0.12, min(1.0, float(silence_overlay_band_fraction)))
    vm = (1.0 - band_frac) * 0.5
    y0 = int(round(height_px * vm))
    y1 = int(round(height_px * (1.0 - vm))) - 1
    if y1 <= y0:
        y1 = min(height_px - 1, y0 + 1)
    return y0, y1


def _draw_silence_highlight_region(
    dr: ImageDraw.ImageDraw,
    x0: int,
    x1: int,
    y_band0: int,
    y_band1: int,
    *,
    cover_rgba: tuple[int, int, int, int],
) -> None:
    """무음 구간 채움 + 시작·끝 경계선(어두운 외곽 + 밝은 안쪽)."""
    dr.rectangle([x0, y_band0, x1, y_band1], fill=cover_rgba)
    ow = max(1, int(_SILENCE_BOUNDARY_OUTLINE_WIDTH))
    iw = max(1, int(_SILENCE_BOUNDARY_LINE_WIDTH))
    for x in (x0, x1):
        dr.line(
            [(x, y_band0), (x, y_band1)],
            fill=_SILENCE_BOUNDARY_OUTLINE_RGBA,
            width=ow,
        )
        dr.line(
            [(x, y_band0), (x, y_band1)],
            fill=_SILENCE_BOUNDARY_LINE_RGBA,
            width=iw,
        )


def apply_silence_highlight_by_columns(
    waveform_png_in: Path | str,
    column_ranges: list[tuple[int, int]],
    *,
    duration_sec: float,
    output_path: Path | str,
    cover_rgba: tuple[int, int, int, int] = _SILENCE_OVERLAY_FILL_RGBA,
    gold_rgb: tuple[int, int, int] | None = None,
    gold_line_width: int = _SILENCE_BOUNDARY_LINE_WIDTH,
    silence_overlay_band_fraction: float = _DEFAULT_SILENCE_OVERLAY_BAND_FRACTION,
    gold_line_rgba: tuple[int, int, int, int] | None = None,
    playhead_sec: float | None = None,
) -> Path:
    """파형과 동일한 PCM 열 범위에 무음 하이라이트를 그립니다 (픽셀 1:1)."""
    _ = gold_rgb, gold_line_width, gold_line_rgba
    src = Path(waveform_png_in)
    out = Path(output_path)
    if not src.is_file():
        raise FileNotFoundError(f"파형 이미지를 찾을 수 없습니다: {src}")
    if duration_sec <= 0:
        raise ValueError("duration_sec는 0보다 커야 합니다.")

    base = Image.open(src).convert("RGBA")
    w_px, h_px = base.size
    overlay = Image.new("RGBA", (w_px, h_px), (0, 0, 0, 0))
    dr = ImageDraw.Draw(overlay)
    x_max = max(0, w_px - 1)
    y_band0, y_band1 = _silence_overlay_band_y(
        h_px, silence_overlay_band_fraction=silence_overlay_band_fraction
    )

    for c0, c1 in column_ranges:
        x0 = max(0, min(int(c0), x_max))
        x1 = max(0, min(int(c1), x_max))
        if x1 < x0:
            x0, x1 = x1, x0
        if x1 < x0:
            continue
        _draw_silence_highlight_region(
            dr, x0, x1, y_band0, y_band1, cover_rgba=cover_rgba
        )

    composed = Image.alpha_composite(base, overlay)
    final_im = append_waveform_guides_and_ruler(composed, duration_sec, playhead_sec=playhead_sec)
    out.parent.mkdir(parents=True, exist_ok=True)
    final_im.save(out, format="PNG")
    return out


def apply_silence_highlight_overlay(
    waveform_png_in: Path | str,
    segments: list[SilenceSegment],
    *,
    duration_sec: float,
    output_path: Path | str,
    cover_rgba: tuple[int, int, int, int] = _SILENCE_OVERLAY_FILL_RGBA,
    gold_rgb: tuple[int, int, int] | None = None,
    gold_line_width: int = _SILENCE_BOUNDARY_LINE_WIDTH,
    silence_overlay_band_fraction: float = _DEFAULT_SILENCE_OVERLAY_BAND_FRACTION,
    gold_line_rgba: tuple[int, int, int, int] | None = None,
    playhead_sec: float | None = None,
) -> Path:
    """
    무음 구간에 반투명 마젠타 밴드와 시작·끝 경계선(어두운 외곽 + 흰 안쪽)을 얹습니다.
    """
    _ = gold_rgb, gold_line_width, gold_line_rgba
    src = Path(waveform_png_in)
    out = Path(output_path)
    if not src.is_file():
        raise FileNotFoundError(f"파형 이미지를 찾을 수 없습니다: {src}")
    if duration_sec <= 0:
        raise ValueError("duration_sec는 0보다 커야 합니다.")

    base = Image.open(src).convert("RGBA")
    w_px, h_px = base.size
    overlay = Image.new("RGBA", (w_px, h_px), (0, 0, 0, 0))
    dr = ImageDraw.Draw(overlay)
    x_max = max(0, w_px - 1)
    y_band0, y_band1 = _silence_overlay_band_y(
        h_px, silence_overlay_band_fraction=silence_overlay_band_fraction
    )

    def sec_to_x(t: float) -> int:
        return _timeline_sec_to_x_px(t, duration_sec, w_px)

    for seg in segments:
        t0 = max(0.0, min(seg.start_sec, duration_sec))
        t1 = max(0.0, min(seg.end_sec, duration_sec))
        if t1 < t0:
            t0, t1 = t1, t0
        if t1 - t0 <= 1e-6:
            continue
        x0 = sec_to_x(t0)
        x1 = sec_to_x(t1)
        if x1 < x0:
            x0, x1 = x1, x0
        if x1 == x0:
            x1 = min(x0 + 1, x_max)
        _draw_silence_highlight_region(
            dr, x0, x1, y_band0, y_band1, cover_rgba=cover_rgba
        )

    composed = Image.alpha_composite(base, overlay)
    final_im = append_waveform_guides_and_ruler(composed, duration_sec, playhead_sec=playhead_sec)
    out.parent.mkdir(parents=True, exist_ok=True)
    final_im.save(out, format="PNG")
    return out


def render_waveform_preview_png_with_silence_highlights(
    media_path: Path | str,
    segments: list[SilenceSegment],
    output_path: Path | str,
    *,
    duration_sec: float,
    waveform_width: int,
    waveform_height: int = 280,
    wave_vertical_fraction: float = 0.72,
    timeout_sec: float = 600.0,
    mean_volume_db: float | None = None,
    noise_db: float | None = None,
    max_volume_db: float | None = None,
    min_silence_sec: float = 0.3,
    cover_rgba: tuple[int, int, int, int] = _SILENCE_OVERLAY_FILL_RGBA,
    gold_rgb: tuple[int, int, int] | None = None,
    gold_line_width: int = _SILENCE_BOUNDARY_LINE_WIDTH,
    silence_overlay_band_fraction: float = _DEFAULT_SILENCE_OVERLAY_BAND_FRACTION,
    gold_line_rgba: tuple[int, int, int, int] | None = None,
    playhead_sec: float | None = None,
    highlight_mode: str = "pcm",
) -> tuple[Path, float]:
    """
    전체 타임라인 파형 PNG + 무음 하이라이트.

    `highlight_mode="pcm"`(기본): noise_db·min_silence로 파형 열을 계산해 표시(슬라이더 미리보기).
    `highlight_mode="segments"`: segments 시각을 PCM 타임라인에 맞춰 표시(분석 결과 고정).
    """
    out = Path(output_path)
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()
    path = Path(media_path)
    if not path.is_file():
        raise FileNotFoundError(f"미디어 파일을 찾을 수 없습니다: {path}")
    try:
        audio_dur, sr = get_media_audio_timeline_sec(path, timeout_sec=min(120.0, timeout_sec))
        sample_rate = sr or 48000
        detect_timeline = float(duration_sec)
        decode_timeline = (
            float(audio_dur)
            if audio_dur > 0
            else detect_timeline
        )
        peaks, pcm_timeline, _ = _decode_mono_pcm_peak_per_column(
            path,
            duration_sec=decode_timeline,
            n_columns=waveform_width,
            timeout_sec=timeout_sec,
            sample_rate=sample_rate,
        )
        if pcm_timeline <= 1e-6:
            pcm_timeline = decode_timeline if decode_timeline > 0 else detect_timeline
        _draw_scope_waveform_from_peaks(
            peaks,
            tmp_path,
            waveform_width=waveform_width,
            waveform_height=waveform_height,
            wave_vertical_fraction=wave_vertical_fraction,
            mean_volume_db=mean_volume_db,
            noise_db=noise_db,
            max_volume_db=max_volume_db,
        )
        use_pcm = highlight_mode == "pcm" or not segments
        if use_pcm:
            if noise_db is None:
                raise ValueError("highlight_mode=pcm 일 때 noise_db가 필요합니다.")
            col_ranges = pcm_column_silence_col_ranges(
                peaks,
                timeline_sec=pcm_timeline,
                mean_volume_db=mean_volume_db,
                noise_db=float(noise_db),
                max_volume_db=max_volume_db,
                min_silence_sec=min_silence_sec,
            )
        else:
            aligned = align_silence_segments_to_pcm_timeline(
                segments,
                detect_timeline_sec=detect_timeline,
                pcm_timeline_sec=pcm_timeline,
            )
            col_ranges = silence_segments_to_column_ranges(
                aligned,
                pcm_timeline,
                waveform_width,
            )
        apply_silence_highlight_by_columns(
            tmp_path,
            col_ranges,
            duration_sec=pcm_timeline,
            output_path=out,
            cover_rgba=cover_rgba,
            gold_rgb=gold_rgb,
            gold_line_width=gold_line_width,
            silence_overlay_band_fraction=silence_overlay_band_fraction,
            gold_line_rgba=gold_line_rgba,
            playhead_sec=playhead_sec,
        )
        return out, pcm_timeline
    finally:
        tmp_path.unlink(missing_ok=True)


def _run_ffmpeg_silencedetect_autocutter(
    path: Path,
    *,
    noise_db: float,
    min_silence_sec: float,
    timeout_sec: float,
) -> tuple[str, float]:
    """
    Auto_Cutter `audio_processor.get_nonsilent_intervals`와 동일한 FFmpeg 호출.

    `-vn`·volumedetect 보정 없이 사용자 threshold·min_len만 사용합니다.
    """
    ffmpeg = get_ffmpeg_executable()
    min_len_sec = max(0.01, float(min_silence_sec))
    cmd = [
        str(ffmpeg),
        "-hide_banner",
        "-vn",
        "-threads",
        "0",
        "-i",
        str(path),
        "-af",
        f"silencedetect=noise={float(noise_db)}dB:d={min_len_sec}",
        "-f",
        "null",
        "-",
    ]
    proc = run_hidden(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=min(timeout_sec, 3600.0),
        check=False,
    )
    text = (proc.stderr or "") + (proc.stdout or "")
    if proc.returncode not in (0, 255) and "silence_" not in text:
        tail = text.strip()[-800:] if text.strip() else "(출력 없음)"
        raise RuntimeError(f"FFmpeg silencedetect 실패 (code={proc.returncode}): {tail}")

    dur_m = _RE_DURATION.search(text)
    if dur_m:
        duration_sec = int(dur_m.group(1)) * 3600 + int(dur_m.group(2)) * 60 + float(
            dur_m.group(3)
        )
    else:
        duration_sec = 0.0
    return text, max(0.0, duration_sec)


def _parse_silencedetect_autocutter(
    log: str,
    duration_sec: float,
) -> list[SilenceSegment]:
    """Auto_Cutter와 동일: silence_start/end를 순서대로 짝지어 무음 구간을 만듭니다."""
    starts = [float(x) for x in _RE_SILENCE_START.findall(log)]
    ends = [float(x) for x in _RE_SILENCE_END.findall(log)]
    dur = max(0.0, float(duration_sec))
    segments: list[SilenceSegment] = []
    for i, start in enumerate(starts):
        end = ends[i] if i < len(ends) else dur
        if end > start:
            segments.append(SilenceSegment(start, end))
    return segments


def get_nonsilent_intervals_ms_autocutter(
    video_path: Path | str,
    *,
    threshold_db: float,
    min_len_ms: float,
    padding_ms: float,
    timeout_sec: float = 3600.0,
) -> tuple[list[tuple[float, float]], float, list[SilenceSegment]]:
    """
    Auto_Cutter `get_nonsilent_intervals` 1:1 포트.

    반환: (말소리 ms 구간, duration 초, silencedetect 무음 구간)
    """
    path = Path(video_path)
    if not path.is_file():
        raise FileNotFoundError(f"영상 파일을 찾을 수 없습니다: {path}")

    threshold = int(round(float(threshold_db)))
    min_len_sec = max(0.01, float(min_len_ms) / 1000.0)
    log_text, duration_sec = _run_ffmpeg_silencedetect_autocutter(
        path,
        noise_db=float(threshold),
        min_silence_sec=min_len_sec,
        timeout_sec=timeout_sec,
    )
    raw_silences = _parse_silencedetect_autocutter(log_text, duration_sec)
    vocal_ms = _vocal_intervals_for_edl(
        raw_silences,
        duration_sec,
        padding_ms=padding_ms,
        min_silence_sec=min_len_sec,
    )
    return vocal_ms, duration_sec, raw_silences


def _run_ffmpeg_silencedetect(
    path: Path,
    *,
    noise_db: float,
    min_silence_sec: float,
    timeout_sec: float,
    sample_rate: int = 48000,
) -> tuple[str, float]:
    """FFmpeg silencedetect stderr/stdout 텍스트와 duration(초)을 반환합니다."""
    _ = sample_rate
    ffmpeg = get_ffmpeg_executable()
    min_len = max(0.01, float(min_silence_sec))
    cmd = [
        str(ffmpeg),
        "-hide_banner",
        "-nostdin",
        "-vn",
        "-sn",
        "-dn",
        "-threads",
        "0",
        "-i",
        str(path),
        "-af",
        f"silencedetect=noise={float(noise_db)}dB:d={min_len}",
        "-f",
        "null",
        "-",
    ]
    proc = run_hidden(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=min(timeout_sec, 3600.0),
        check=False,
    )
    text = (proc.stderr or "") + (proc.stdout or "")
    if proc.returncode not in (0, 255) and "silence_" not in text:
        tail = text.strip()[-800:] if text.strip() else "(출력 없음)"
        raise RuntimeError(f"FFmpeg silencedetect 실패 (code={proc.returncode}): {tail}")

    dur_m = _RE_DURATION.search(text)
    if dur_m:
        duration_sec = int(dur_m.group(1)) * 3600 + int(dur_m.group(2)) * 60 + float(dur_m.group(3))
    else:
        duration_sec = 0.0
    return text, max(0.0, duration_sec)


def _coalesce_silence_segments(
    silences: list[SilenceSegment],
    duration_sec: float,
    *,
    min_silence_sec: float,
    padding_ms: float,
) -> list[SilenceSegment]:
    """
    silencedetect가 긴 무음 안 잡음을 여러 무음으로 쪼개는 것을 합칩니다.

    - 무음 사이 말소리가 `min_silence_sec`보다 짧으면 한 덩어리 무음으로 병합
    - 병합 후에도 `min_silence_sec` 미만 무음은 제거(말소리로 간주)
    """
    dur = max(0.0, float(duration_sec))
    if dur <= 0 or not silences:
        return []

    min_len = max(0.05, float(min_silence_sec))
    pad_sec = max(0.0, float(padding_ms)) / 1000.0
    # 무음 사이 짧은 잡음·숨소리(≤ bridge)는 한 덩어리 무음으로 이음
    bridge = max(min_len * 3.0, 0.75, pad_sec * 2.0)

    ordered = sorted(silences, key=lambda s: s.start_sec)
    merged: list[SilenceSegment] = []
    cur_start = max(0.0, float(ordered[0].start_sec))
    cur_end = min(dur, float(ordered[0].end_sec))

    for seg in ordered[1:]:
        s0 = max(0.0, float(seg.start_sec))
        s1 = min(dur, float(seg.end_sec))
        if s1 <= s0:
            continue
        gap_vocal = s0 - cur_end
        if gap_vocal <= bridge + 1e-4:
            cur_end = max(cur_end, s1)
        else:
            if cur_end > cur_start + 1e-6:
                merged.append(SilenceSegment(cur_start, cur_end))
            cur_start, cur_end = s0, s1

    if cur_end > cur_start + 1e-6:
        merged.append(SilenceSegment(cur_start, cur_end))

    return [s for s in merged if (s.end_sec - s.start_sec) >= min_len - 1e-6]


def _merge_vocal_intervals_by_min_gap(
    vocal_ms: list[tuple[float, float]],
    *,
    min_gap_sec: float,
) -> list[tuple[float, float]]:
    """
    말소리 사이 간격이 min_gap_sec 미만이면 한 덩어리 말소리로 병합.
    파형 오버레이(최소 무음 길이)와 EDL 점프컷이 동일한 기준을 쓰도록 합니다.
    """
    min_gap_ms = max(0.0, float(min_gap_sec)) * 1000.0
    if min_gap_ms <= 1e-3 or len(vocal_ms) <= 1:
        return vocal_ms

    ordered = sorted(vocal_ms, key=lambda x: x[0])
    merged: list[list[float]] = [[float(ordered[0][0]), float(ordered[0][1])]]
    for start_ms, end_ms in ordered[1:]:
        gap = float(start_ms) - merged[-1][1]
        if gap < min_gap_ms - 1e-3:
            merged[-1][1] = max(merged[-1][1], float(end_ms))
        else:
            merged.append([float(start_ms), float(end_ms)])
    return [(a, b) for a, b in merged if b > a + 1e-3]


def _vocal_intervals_for_edl(
    silences: list[SilenceSegment],
    duration_sec: float,
    *,
    padding_ms: float,
    min_silence_sec: float,
) -> list[tuple[float, float]]:
    """raw 무음 → 여백 → 최소 무음 길이 병합까지 적용한 말소리(ms)."""
    vocal_ms = _vocal_intervals_ms_with_padding(
        silences,
        duration_sec,
        padding_ms=padding_ms,
    )
    return _merge_vocal_intervals_by_min_gap(
        vocal_ms,
        min_gap_sec=min_silence_sec,
    )


def _vocal_intervals_ms_with_padding(
    silences: list[SilenceSegment],
    duration_sec: float,
    *,
    padding_ms: float,
) -> list[tuple[float, float]]:
    """
    Auto_Cutter `get_nonsilent_intervals`와 동일: silencedetect 무음 사이 말소리 구간 + padding·병합.
    반환: [(start_ms, end_ms), ...]
    """
    duration_ms = max(0.0, float(duration_sec)) * 1000.0
    if duration_ms <= 0:
        return []

    raw: list[list[float]] = []
    current_time = 0.0
    for seg in sorted(silences, key=lambda s: s.start_sec):
        sil_start = float(seg.start_sec)
        sil_end = float(seg.end_sec)
        if sil_start > current_time:
            raw.append([current_time * 1000.0, sil_start * 1000.0])
        current_time = max(current_time, sil_end)

    if current_time * 1000.0 < duration_ms:
        raw.append([current_time * 1000.0, duration_ms])

    pad = max(0.0, float(padding_ms))
    adjusted: list[list[float]] = []
    for start_ms, end_ms in raw:
        pad_start = max(0.0, start_ms - pad)
        pad_end = min(duration_ms, end_ms + pad)
        if not adjusted:
            adjusted.append([pad_start, pad_end])
            continue
        prev_start, prev_end = adjusted[-1]
        if prev_end >= pad_start:
            adjusted[-1][1] = max(prev_end, pad_end)
        else:
            adjusted.append([pad_start, pad_end])

    return [(a, b) for a, b in adjusted if b > a]


def clip_ms_from_stored_silences(
    silences: list[SilenceSegment],
    duration_sec: float,
    *,
    drop_silent: bool,
) -> list[tuple[float, float]]:
    """
    분석에 저장된 무음(시작·끝 초) → EDL용 클립 구간(ms).

    drop_silent=True: 말소리만 (무음 제거 조립).
    drop_silent=False: 말소리+무음 전부, 원본 길이 그대로 구간만 나눔(컷만).
    """
    dur_ms = max(0.0, float(duration_sec)) * 1000.0
    if dur_ms <= 0:
        return []
    if not silences:
        return [(0.0, dur_ms)]

    clips: list[tuple[float, float]] = []
    cursor_ms = 0.0
    for seg in sorted(silences, key=lambda s: s.start_sec):
        s_ms = max(0.0, min(dur_ms, float(seg.start_sec) * 1000.0))
        e_ms = max(s_ms, min(dur_ms, float(seg.end_sec) * 1000.0))
        if s_ms > cursor_ms + 1e-3:
            clips.append((cursor_ms, s_ms))
        if not drop_silent and e_ms > s_ms + 1e-3:
            clips.append((s_ms, e_ms))
        cursor_ms = max(cursor_ms, e_ms)
    if cursor_ms < dur_ms - 1e-3:
        clips.append((cursor_ms, dur_ms))
    return [(a, b) for a, b in clips if b > a + 1e-3]


def vocal_ms_from_final_silence_segments(
    silences: list[SilenceSegment],
    duration_sec: float,
) -> list[tuple[float, float]]:
    """말소리만 (drop_silent=True 와 동일)."""
    return clip_ms_from_stored_silences(silences, duration_sec, drop_silent=True)


def _frames_to_timecode_autocutter_edl(total_frames: int, tc_fps: int) -> str:
    """Auto_Cutter `edl_generator.frames_to_timecode` 와 동일."""
    tc = max(1, int(tc_fps))
    frames = total_frames % tc
    seconds = (total_frames // tc) % 60
    minutes = (total_frames // (tc * 60)) % 60
    hours = total_frames // (tc * 3600)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}:{frames:02d}"


FCP7_XML_EXPORT_REV = 2


def _autocutter_final_clips(
    intervals_ms: list[tuple[float, float]],
    *,
    remove_silent: bool,
    duration_sec: float | None = None,
) -> list[dict[str, object]]:
    """Auto_Cutter edl_generator — VOCAL(+SILENT) 클립 ms 목록."""
    sorted_iv = sorted(intervals_ms, key=lambda x: x[0])
    if not sorted_iv:
        return []

    all_clips: list[dict[str, object]] = [
        {"start": float(s), "end": float(e), "type": "VOCAL"}
        for s, e in sorted_iv
        if float(e) > float(s) + 1e-3
    ]
    if not all_clips:
        return []

    if remove_silent:
        return all_clips

    silent_intervals: list[dict[str, object]] = []
    current_time = 0.0
    max_duration = float(all_clips[-1]["end"])  # type: ignore[index]
    if duration_sec is not None and float(duration_sec) > 0:
        max_duration = max(max_duration, float(duration_sec) * 1000.0)
    for part in all_clips:
        p_start = float(part["start"])  # type: ignore[arg-type]
        p_end = float(part["end"])  # type: ignore[arg-type]
        if p_start > current_time + 1e-3:
            silent_intervals.append(
                {"start": current_time, "end": p_start, "type": "SILENT"}
            )
        current_time = p_end
    if current_time < max_duration - 1e-3:
        silent_intervals.append(
            {"start": current_time, "end": max_duration, "type": "SILENT"}
        )
    return sorted(all_clips + silent_intervals, key=lambda x: float(x["start"]))  # type: ignore[arg-type]


def _resolve_edl_export_frame_cap(
    total_frames: int | None,
    *,
    intervals_ms: list[tuple[float, float]],
    fps_f: float,
    source_tc_offset_sec: float = 0.0,
    analysis_duration_sec: float | None = None,
) -> int | None:
    """
    ffprobe nb_frames 가 실제 말소리 타임라인보다 짧을 때 EDL src 를 1프레임으로 깎지 않도록
    캡을 끕니다. 신뢰할 수 있을 때만 cap 을 반환합니다.
    """
    cap = int(total_frames) if total_frames is not None and total_frames > 0 else 0
    if cap <= 0:
        return None
    fps_f = _edl_fps_float(fps_f)
    tc_offset_ms = max(0.0, float(source_tc_offset_sec)) * 1000.0
    need_frame = 0
    for start_ms, end_ms in intervals_ms:
        end_fr = int(round(((float(end_ms) + tc_offset_ms) / 1000.0) * fps_f))
        need_frame = max(need_frame, end_fr)
    if analysis_duration_sec is not None and float(analysis_duration_sec) > 0:
        need_from_dur = int(
            round(
                (float(analysis_duration_sec) + float(source_tc_offset_sec)) * fps_f
            )
        )
        need_frame = max(need_frame, need_from_dur)
    slack = max(3, int(round(fps_f * 0.25)))
    if need_frame > cap + slack:
        return None
    return cap


def _autocutter_src_frame_pairs(
    intervals_ms: list[tuple[float, float]],
    *,
    fps: float,
    remove_silent: bool,
    source_tc_offset_sec: float = 0.0,
    total_frames: int | None = None,
    analysis_duration_sec: float | None = None,
) -> list[tuple[int, int]]:
    """
    Auto_Cutter / 1d527a9 EDL 과 동일 — ms→frame round, (src_in, src_out exclusive).
    """
    fps_f = float(fps)
    if fps_f <= 0 or not math.isfinite(fps_f):
        fps_f = 29.97
    final_clips = _autocutter_final_clips(
        intervals_ms,
        remove_silent=remove_silent,
        duration_sec=analysis_duration_sec,
    )
    if not final_clips:
        return []

    tc_offset_ms = max(0.0, float(source_tc_offset_sec)) * 1000.0
    frame_cap = _resolve_edl_export_frame_cap(
        total_frames,
        intervals_ms=intervals_ms,
        fps_f=fps_f,
        source_tc_offset_sec=source_tc_offset_sec,
        analysis_duration_sec=analysis_duration_sec,
    )
    frame_cap = int(frame_cap) if frame_cap is not None and frame_cap > 0 else 0
    pairs: list[tuple[int, int]] = []
    for clip in final_clips:
        start_ms = float(clip["start"]) + tc_offset_ms  # type: ignore[arg-type]
        end_ms = float(clip["end"]) + tc_offset_ms  # type: ignore[arg-type]
        src_in = int(round((start_ms / 1000.0) * fps_f))
        src_out = int(round((end_ms / 1000.0) * fps_f))
        if frame_cap > 0:
            src_in = max(0, min(src_in, frame_cap - 1))
            src_out = max(src_in + 1, min(src_out, frame_cap))
        if src_out > src_in:
            pairs.append((src_in, src_out))
    return pairs


def _fcp7_rate_from_fps(fps_f: float) -> tuple[int, bool]:
    if abs(fps_f - 30) < 0.01:
        return 30, False
    if abs(fps_f - 24000 / 1001) < 0.002 or abs(fps_f - 23.976) < 0.03:
        return 24, True
    if abs(fps_f - 30000 / 1001) < 0.002 or abs(fps_f - 29.97) < 0.03:
        return 30, True
    if abs(fps_f - 60000 / 1001) < 0.002 or abs(fps_f - 59.94) < 0.03:
        return 60, True
    if abs(fps_f - 60) < 0.01:
        return 60, False
    if abs(fps_f - 24) < 0.01:
        return 24, False
    if abs(fps_f - 25) < 0.01:
        return 25, False
    timebase = int(round(fps_f))
    if timebase <= 0:
        timebase = 30
    ntsc = abs(fps_f - float(timebase)) > 0.01
    return timebase, ntsc


def _fcp7_pathurl_from_local_path(path: str) -> str:
    p = Path(path).resolve().as_posix()
    return f"file:///{quote(p, safe='/:')}"


def _fcp7_rate_xml(timebase: int, ntsc: bool, indent: str) -> list[str]:
    return [
        f"{indent}<rate>",
        f"{indent}  <timebase>{timebase}</timebase>",
        f"{indent}  <ntsc>{'TRUE' if ntsc else 'FALSE'}</ntsc>",
        f"{indent}</rate>",
    ]


def create_fcp7_xml(
    intervals_ms: list[tuple[float, float]],
    *,
    fps: float,
    remove_silent: bool = True,
    title: str = "AutoCut_Option",
    clip_filename: str | None = None,
    source_file_path: str | None = None,
    duration_sec: float | None = None,
    silences: list[SilenceSegment] | None = None,
) -> str:
    """
    FCP7 XMEML — EDL(1d527a9)과 동일한 ms→frame round.
    Resolve 풀 링크용 src in/out 은 파일 00:00:00:00 기준(source_tc_offset=0).

    remove_silent=False: 무음·말소리 구간을 원본 타임라인 위치에 두고 컷만 (길이 유지).
    remove_silent=True: 말소리만 이어 붙인 조립 타임라인.
    """
    fps_f = float(fps)
    if fps_f <= 0:
        fps_f = 29.97
    export_iv = list(intervals_ms)
    pair_remove_silent = remove_silent
    if not remove_silent:
        if silences and duration_sec is not None and float(duration_sec) > 0:
            export_iv = clip_ms_from_stored_silences(
                silences,
                float(duration_sec),
                drop_silent=False,
            )
            pair_remove_silent = True
        elif duration_sec is not None and float(duration_sec) > 0:
            export_iv = list(intervals_ms)
    frame_pairs = _autocutter_src_frame_pairs(
        export_iv,
        fps=fps_f,
        remove_silent=pair_remove_silent,
        source_tc_offset_sec=0.0,
        analysis_duration_sec=duration_sec,
    )
    if not frame_pairs:
        return ""

    media_label = (clip_filename or "").strip() or "clip.mp4"
    custom_title = (title or "").strip()
    if custom_title and custom_title != "AutoCut_Option":
        safe_title = xml_escape(custom_title[:79])
    else:
        stem = Path(media_label).stem.strip() or "silence"
        suffix = "silence" if remove_silent else "cuts"
        safe_title = xml_escape(f"{stem}_{suffix}")
    safe_name = xml_escape(media_label)

    timebase, ntsc = _fcp7_rate_from_fps(fps_f)
    tl_cursor = 0
    clip_max_out = max(out for _, out in frame_pairs)
    auth_out = (
        int(round(float(duration_sec) * fps_f))
        if duration_sec is not None and float(duration_sec) > 0
        else 0
    )
    file_duration = max(clip_max_out, auth_out)
    timeline_end = sum(out - inn for inn, out in frame_pairs)

    pathurl = ""
    vid_w, vid_h = 1920, 1080
    probe_path = (source_file_path or "").strip()
    if probe_path:
        pathurl = _fcp7_pathurl_from_local_path(probe_path)
        vid_w, vid_h = get_video_dimensions_ffprobe(probe_path)

    lines: list[str] = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<!DOCTYPE xmeml>",
        '<xmeml version="4">',
        f"<!-- itmatzip-fcp7 rev={FCP7_XML_EXPORT_REV} rs={1 if remove_silent else 0} -->",
        '  <sequence id="sequence-1">',
        f"    <name>{safe_title}</name>",
        f"    <duration>{timeline_end}</duration>",
    ]
    lines.extend(_fcp7_rate_xml(timebase, ntsc, "    "))
    lines.extend(
        [
            "    <media>",
            "      <video>",
            "        <format>",
            "          <samplecharacteristics>",
            f"            <width>{vid_w}</width>",
            f"            <height>{vid_h}</height>",
            "          </samplecharacteristics>",
            "        </format>",
            '        <track TL.SQTrackType="Video" TL.SQTrackDisabled="False">',
        ]
    )

    for idx, (src_in, src_out) in enumerate(frame_pairs):
        dur = src_out - src_in
        tl_end = tl_cursor + dur
        cid = f"clipitem-v-{idx + 1}"
        lines.extend(
            [
                f'          <clipitem id="{cid}">',
                f"            <name>{safe_name}</name>",
                f"            <duration>{dur}</duration>",
            ]
        )
        lines.extend(_fcp7_rate_xml(timebase, ntsc, "            "))
        lines.extend(
            [
                f"            <start>{tl_cursor}</start>",
                f"            <end>{tl_end}</end>",
                f"            <in>{src_in}</in>",
                f"            <out>{src_out}</out>",
            ]
        )
        if idx == 0:
            lines.append('            <file id="file-1">')
            lines.append(f"              <name>{safe_name}</name>")
            if pathurl:
                lines.append(f"              <pathurl>{xml_escape(pathurl)}</pathurl>")
            lines.extend(_fcp7_rate_xml(timebase, ntsc, "              "))
            lines.append(f"              <duration>{file_duration}</duration>")
            lines.append("            </file>")
        else:
            lines.append('            <file id="file-1"/>')
        lines.extend(
            [
                '            <link>',
                f'              <linkclipref>{cid}</linkclipref>',
                "              <mediatype>video</mediatype>",
                "              <trackindex>1</trackindex>",
                f"              <clipindex>{idx + 1}</clipindex>",
                "            </link>",
                "          </clipitem>",
            ]
        )
        tl_cursor = tl_end

    lines.extend(["        </track>", "      </video>", "      <audio>"])
    lines.append('        <track TL.SQTrackType="Audio" TL.SQTrackDisabled="False">')

    tl_cursor = 0
    for idx, (src_in, src_out) in enumerate(frame_pairs):
        dur = src_out - src_in
        tl_end = tl_cursor + dur
        cid = f"clipitem-a-{idx + 1}"
        vref = f"clipitem-v-{idx + 1}"
        lines.extend(
            [
                f'          <clipitem id="{cid}">',
                f"            <name>{safe_name}</name>",
                f"            <duration>{dur}</duration>",
            ]
        )
        lines.extend(_fcp7_rate_xml(timebase, ntsc, "            "))
        lines.extend(
            [
                f"            <start>{tl_cursor}</start>",
                f"            <end>{tl_end}</end>",
                f"            <in>{src_in}</in>",
                f"            <out>{src_out}</out>",
            ]
        )
        if idx == 0:
            lines.append('            <file id="file-1"/>')
        else:
            lines.append('            <file id="file-1"/>')
        lines.extend(
            [
                '            <sourcetrack>',
                "              <mediatype>audio</mediatype>",
                "              <trackindex>1</trackindex>",
                "            </sourcetrack>",
                '            <link>',
                f'              <linkclipref>{vref}</linkclipref>',
                "              <mediatype>video</mediatype>",
                "              <trackindex>1</trackindex>",
                f"              <clipindex>{idx + 1}</clipindex>",
                "            </link>",
                "          </clipitem>",
            ]
        )
        tl_cursor = tl_end

    lines.extend(
        [
            "        </track>",
            "      </audio>",
            "    </media>",
            "  </sequence>",
            "</xmeml>",
            "",
        ]
    )
    return "\n".join(lines)


def create_edl_autocutter(
    intervals_ms: list[tuple[float, float]],
    *,
    fps: float,
    remove_silent: bool = True,
    title: str = "AutoCut_Option",
    clip_filename: str | None = None,
    reel: str | None = None,
    source_tc_offset_sec: float = 0.0,
    total_frames: int | None = None,
    analysis_duration_sec: float | None = None,
) -> str:
    """
    Auto_Cutter `edl_generator.create_edl` 1:1 포트.

    - 말소리(ms) 구간 → silencedetect+padding 결과
    - remove_silent=True: VOCAL만, 레코드 01:00:00:00부터 이어 붙임
    - remove_silent=False: VOCAL+SILENT 전체, 레코드 동일하게 이어 붙임
    - 프레임: float(fps)로 계산, 타임코드 FF 필드는 int(round(fps))
    - source_tc_offset_sec: DaVinci 미디어 풀 src in/out 오프셋(초)
    """
    fps_f = float(fps)
    if fps_f <= 0 or not math.isfinite(fps_f):
        fps_f = 29.97
    tc_fps = int(round(fps_f))
    if tc_fps <= 0:
        tc_fps = 30

    reel_label = (reel or "").strip()
    if not reel_label and clip_filename:
        reel_label = reel_name_from_clip_filename(clip_filename)
    if not reel_label:
        reel_label = "AX"
    reel_field = reel_label[:8].ljust(8)

    use_media_name = bool((clip_filename or "").strip())
    media_name = (clip_filename or "").strip()

    lines: list[str] = []
    safe_title = (title or "AutoCut_Option").strip()[:79] or "AutoCut_Option"
    lines.append(f"TITLE: {safe_title}")
    lines.append("FCM: NON-DROP FRAME")
    lines.append("")

    sorted_iv = sorted(intervals_ms, key=lambda x: x[0])
    if not sorted_iv:
        lines.append("* 말소리 구간이 없습니다.")
        lines.append("")
        return "\n".join(lines) + "\n"

    frame_pairs = _autocutter_src_frame_pairs(
        intervals_ms,
        fps=fps_f,
        remove_silent=remove_silent,
        source_tc_offset_sec=source_tc_offset_sec,
        total_frames=total_frames,
        analysis_duration_sec=analysis_duration_sec,
    )
    if not frame_pairs:
        lines.append("* 말소리 구간이 없습니다.")
        lines.append("")
        return "\n".join(lines) + "\n"

    lines.append("* itmatzip-edl rev=2")
    lines.append("")

    current_rec_frame = 3600 * tc_fps
    event_num = 1

    for src_in_frame, src_out_frame in frame_pairs:
        duration_frames = src_out_frame - src_in_frame
        if duration_frames <= 0:
            continue

        src_in_tc = _frames_to_timecode_autocutter_edl(src_in_frame, tc_fps)
        src_out_tc = _frames_to_timecode_autocutter_edl(src_out_frame, tc_fps)
        rec_in_tc = _frames_to_timecode_autocutter_edl(current_rec_frame, tc_fps)
        rec_out_tc = _frames_to_timecode_autocutter_edl(
            current_rec_frame + duration_frames, tc_fps
        )

        from_name = media_name if use_media_name else "VOCAL"

        lines.append(
            f"{event_num:03d}  {reel_field} V     C        "
            f"{src_in_tc} {src_out_tc} {rec_in_tc} {rec_out_tc}"
        )
        lines.append(f"* FROM CLIP NAME: {from_name}")
        lines.append("")
        current_rec_frame += duration_frames
        event_num += 1

    return "\n".join(lines) + "\n"


def create_edl_from_stored_silences(
    silences: list[SilenceSegment],
    *,
    duration_sec: float,
    fps: float,
    remove_silent: bool = False,
    title: str = "AutoCut_Option",
    clip_filename: str | None = None,
    source_tc_offset_sec: float = 0.0,
) -> str:
    """저장된 무음(초) → 말소리(ms) → Auto_Cutter EDL."""
    vocal_ms = _vocal_ms_from_silence_segments(silences, duration_sec)
    return create_edl_autocutter(
        vocal_ms,
        fps=fps,
        remove_silent=remove_silent,
        title=title,
        clip_filename=clip_filename,
        source_tc_offset_sec=source_tc_offset_sec,
    )


def _silence_segments_from_vocal_ms(
    vocal_ms: list[tuple[float, float]],
    duration_sec: float,
) -> list[SilenceSegment]:
    """패딩 적용된 말소리 구간 사이 = 파형 오버레이·요약용 무음 구간(초)."""
    dur = max(0.0, float(duration_sec))
    if dur <= 0:
        return []
    if not vocal_ms:
        return [SilenceSegment(0.0, dur)]

    out: list[SilenceSegment] = []
    cursor = 0.0
    for start_ms, end_ms in sorted(vocal_ms, key=lambda x: x[0]):
        start_s = max(0.0, start_ms / 1000.0)
        end_s = min(dur, end_ms / 1000.0)
        if start_s > cursor + 1e-6:
            out.append(SilenceSegment(cursor, start_s))
        cursor = max(cursor, end_s)
    if cursor < dur - 1e-6:
        out.append(SilenceSegment(cursor, dur))
    return out


def _vocal_ms_from_silence_segments(
    silences: list[SilenceSegment],
    duration_sec: float,
) -> list[tuple[float, float]]:
    """저장된 무음 구간 → 말소리(ms) (EDL 재생성용)."""
    dur_ms = max(0.0, float(duration_sec)) * 1000.0
    if dur_ms <= 0:
        return []
    vocal: list[tuple[float, float]] = []
    cursor_ms = 0.0
    for seg in sorted(silences, key=lambda s: s.start_sec):
        s0 = max(0.0, float(seg.start_sec)) * 1000.0
        s1 = max(s0, float(seg.end_sec)) * 1000.0
        if s0 > cursor_ms + 1e-3:
            vocal.append((cursor_ms, s0))
        cursor_ms = max(cursor_ms, s1)
    if cursor_ms < dur_ms - 1e-3:
        vocal.append((cursor_ms, dur_ms))
    return vocal


# CMX/Auto_Cutter 조립 타임라인 레코드 시작 (01:00:00:00)
EDL_RECORD_TC_OFFSET_SEC = 3600.0


def resolve_source_tc_offset_for_edl(probed_offset_sec: float) -> float:
    """
    DaVinci Resolve 미디어 풀 src TC.
    파일에 TC 태그가 없으면 ffprobe=0 이지만 풀 클립은 01:00:00:00 부터인 경우가 많음.
    """
    off = max(0.0, float(probed_offset_sec))
    if off > 1e-6:
        return off
    return EDL_RECORD_TC_OFFSET_SEC


def _edl_fps_float(fps: Fraction | float | None, *, default: float = 29.97) -> float:
    """EDL·타임코드용 FPS — UI 입력 그대로(float). NTSC 30000/1001 환산 없음."""
    if fps is None:
        return default
    if isinstance(fps, (int, float)):
        f = float(fps)
    else:
        f = float(fps)
    if f > 0 and math.isfinite(f):
        return f
    return default


def _ms_to_frame(ms: float, fps_f: float) -> int:
    """밀리초 → 편집 프레임 (입력 FPS 그대로, 예: 29.97)."""
    if fps_f <= 0 or not math.isfinite(fps_f):
        return 0
    return int(round(float(ms) * fps_f / 1000.0))


def _frames_to_timecode_autocutter(total_frames: int, fps_f: float) -> str:
    """프레임 인덱스 → CMX 타임코드 (입력 FPS 그대로)."""
    fps_f = _edl_fps_float(fps_f)
    if total_frames < 0:
        total_frames = 0
    total_sec = float(total_frames) / fps_f
    hours = int(total_sec // 3600)
    total_sec -= hours * 3600
    minutes = int(total_sec // 60)
    total_sec -= minutes * 60
    seconds = int(total_sec)
    frames = int(round((total_sec - seconds) * fps_f))
    fps_cap = max(1, int(math.ceil(fps_f - 1e-9)))
    if frames >= fps_cap:
        frames = 0
        seconds += 1
        if seconds >= 60:
            seconds = 0
            minutes += 1
            if minutes >= 60:
                minutes = 0
                hours += 1
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}:{frames:02d}"


def _silent_clips_from_vocal_ms(
    vocal_intervals_ms: list[tuple[float, float]],
    duration_sec: float,
) -> list[dict[str, object]]:
    """말소리(ms) 사이·앞뒤 = 파형 보라색(무음) 구간."""
    duration_ms = max(0.0, float(duration_sec)) * 1000.0
    if duration_ms <= 0:
        return []
    vocal = sorted(vocal_intervals_ms, key=lambda x: x[0])
    silent: list[dict[str, object]] = []
    cursor_ms = 0.0
    for start_ms, end_ms in vocal:
        s = max(0.0, float(start_ms))
        e = min(duration_ms, float(end_ms))
        if s > cursor_ms + 1e-3:
            silent.append({"start": cursor_ms, "end": s, "type": "SILENT"})
        cursor_ms = max(cursor_ms, e)
    if cursor_ms < duration_ms - 1e-3:
        silent.append({"start": cursor_ms, "end": duration_ms, "type": "SILENT"})
    return silent


def create_edl_autocutter_from_vocal_ms(
    vocal_intervals_ms: list[tuple[float, float]],
    *,
    fps: float | None = None,
    fps_fraction: Fraction | None = None,
    title: str = "AutoCut_Option",
    remove_silent: bool = True,
    duration_sec: float | None = None,
    clip_filename: str | None = None,
    source_tc_offset_sec: float = 0.0,
    total_frames: int | None = None,
) -> str:
    """
    EDL 생성 — 말소리(유지) 구간만, 반드시 실제 미디어 파일명으로 링크.

    remove_silent=True:
      레코드 01:00:00:00부터 말소리 클립만 이어 붙임(무음 제거).

    remove_silent=False:
      (레거시) src=rec 원본 위치 — 신규 EDL은 create_edl_from_stored_silences 사용.

    source_tc_offset_sec: 미디어 풀 클립 시작 타임코드(예: 01:00:00:00 → 3600).
    """
    clip_label = (clip_filename or "").strip() or "clip.mp4"
    reel = reel_name_from_clip_filename(clip_label)
    if fps is not None and float(fps) > 0 and math.isfinite(float(fps)):
        fps_f = float(fps)
    elif fps_fraction is not None and fps_fraction > 0:
        fps_f = _edl_fps_float(fps_fraction)
    else:
        fps_f = 29.97

    lines: list[str] = []
    safe_title = (title or "AutoCut_Option").strip()[:79] or "AutoCut_Option"
    lines.append(f"TITLE: {safe_title}")
    lines.append("FCM: NON-DROP FRAME")
    lines.append("")

    dur_sec = float(duration_sec) if duration_sec is not None and duration_sec > 0 else 0.0
    vocal_sorted = _clamp_vocal_intervals_ms(
        sorted(vocal_intervals_ms, key=lambda x: x[0]),
        dur_sec if dur_sec > 0 else float(vocal_intervals_ms[-1][1]) / 1000.0,
    )
    if not vocal_sorted:
        lines.append("* 말소리 구간이 없습니다.")
        lines.append("")
        return "\n".join(lines) + "\n"

    if dur_sec <= 0:
        dur_sec = float(vocal_sorted[-1][1]) / 1000.0

    frame_cap = int(total_frames) if total_frames is not None and total_frames > 0 else 0
    final_clips: list[dict[str, object]] = [
        {"start": s, "end": e} for s, e in vocal_sorted
    ]
    use_sequential_record = bool(remove_silent)

    tc_offset_ms = max(0.0, float(source_tc_offset_sec)) * 1000.0
    max_src_frame = (
        frame_cap
        if frame_cap > 0
        else _ms_to_frame(tc_offset_ms + dur_sec * 1000.0, fps_f)
    )
    if use_sequential_record:
        current_rec_frame = _ms_to_frame(EDL_RECORD_TC_OFFSET_SEC * 1000.0, fps_f)
    else:
        current_rec_frame = 0
    event_num = 1

    for clip in final_clips:
        start_ms = float(clip["start"]) + tc_offset_ms  # type: ignore[arg-type]
        end_ms = float(clip["end"]) + tc_offset_ms  # type: ignore[arg-type]
        src_in_frame = _ms_to_frame(start_ms, fps_f)
        src_out_excl = _ms_to_frame(end_ms, fps_f)
        src_in_frame = max(0, min(src_in_frame, max(0, max_src_frame - 1)))
        src_out_excl = max(src_in_frame + 1, min(src_out_excl, max_src_frame))
        src_out_incl = src_out_excl - 1
        duration_frames = src_out_excl - src_in_frame
        if duration_frames <= 0:
            continue

        src_in_tc = _frames_to_timecode_autocutter(src_in_frame, fps_f)
        src_out_tc = _frames_to_timecode_autocutter(src_out_incl, fps_f)
        if use_sequential_record:
            rec_in_frame = current_rec_frame
            rec_out_frame = current_rec_frame + duration_frames
            current_rec_frame = rec_out_frame
        else:
            rec_in_frame = src_in_frame
            rec_out_frame = src_out_frame

        rec_in_tc = _frames_to_timecode_autocutter(rec_in_frame, fps_f)
        rec_out_tc = _frames_to_timecode_autocutter(rec_out_frame, fps_f)

        lines.append(
            f"{event_num:03d}  {reel} V     C        "
            f"{src_in_tc} {src_out_tc} {rec_in_tc} {rec_out_tc}"
        )
        lines.append(f"* FROM CLIP NAME: {clip_label}")
        event_num += 1
        lines.append(
            f"{event_num:03d}  {reel} A     C        "
            f"{src_in_tc} {src_out_tc} {rec_in_tc} {rec_out_tc}"
        )
        lines.append(f"* FROM CLIP NAME: {clip_label}")
        lines.append("")
        event_num += 1

    return "\n".join(lines) + "\n"


def detect_silence_segments_silencedetect(
    video_path: Path | str,
    *,
    noise_db: float = -50.0,
    min_silence_sec: float = 0.5,
    padding_ms: float = DEFAULT_VOCAL_PADDING_MS,
    timeout_sec: float = 3600.0,
    pixels_per_second: float = DEFAULT_WAVEFORM_PIXELS_PER_SECOND,
    max_waveform_width: int = DEFAULT_WAVEFORM_MAX_WIDTH,
    fps_rational: str | None = None,
    use_autocutter_pipeline: bool = True,
    use_recommended_noise: bool = True,
    use_pcm_preview: bool = False,
    require_cached_peaks: bool = False,
) -> tuple[
    list[SilenceSegment],
    float,
    Fraction,
    int,
    list[tuple[float, float]],
    list[SilenceSegment],
    list[SilenceSegment],
    float,
]:
    """
    무음·말소리 구간 탐지.

    `use_pcm_preview=True`면 파형 열+dB(미리보기와 동일)로 EDL·무음 구간을 만듭니다.
    아니면 Auto_Cutter FFmpeg silencedetect + padding.

    반환: (UI 무음 구간, 길이 초, FPS, 파형 폭, EDL 말소리 ms, raw 무음, coalesced 무음)
    """
    path = Path(video_path)
    if not path.is_file():
        raise FileNotFoundError(f"영상 파일을 찾을 수 없습니다: {path}")

    if use_pcm_preview:
        (
            silence_segments,
            duration_sec,
            fps_probe,
            waveform_width,
            vocal_ms_edl,
            raw_silences,
            coalesced_silences,
            applied_noise_db,
        ) = detect_silence_pcm_column_pipeline(
            path,
            noise_db=noise_db,
            min_silence_sec=min_silence_sec,
            padding_ms=padding_ms,
            timeout_sec=timeout_sec,
            pixels_per_second=pixels_per_second,
            max_waveform_width=max_waveform_width,
            require_cached_peaks=require_cached_peaks,
            fps_rational=fps_rational,
        )
        return (
            silence_segments,
            duration_sec,
            fps_probe,
            waveform_width,
            vocal_ms_edl,
            raw_silences,
            coalesced_silences,
            applied_noise_db,
        )

    t_probe = min(120.0, timeout_sec)
    audio_dur, _sr_audio = get_media_audio_timeline_sec(path, timeout_sec=t_probe)

    applied_noise_db = float(int(round(float(noise_db))))
    if use_autocutter_pipeline:
        min_len_ms = max(1.0, float(min_silence_sec) * 1000.0)
        threshold_db, _rec = resolve_autocutter_noise_db(
            path,
            noise_db,
            use_recommended_noise=use_recommended_noise,
            timeout_sec=timeout_sec,
        )
        applied_noise_db = threshold_db
        vocal_ms_edl, duration_ff, raw_silences = get_nonsilent_intervals_ms_autocutter(
            path,
            threshold_db=threshold_db,
            min_len_ms=min_len_ms,
            padding_ms=padding_ms,
            timeout_sec=timeout_sec,
        )
        if duration_ff > 0:
            duration_sec = duration_ff
        elif audio_dur > 0:
            duration_sec = audio_dur
        else:
            duration_sec = 0.0
    else:
        mean_db: float | None = None
        max_db: float | None = None
        try:
            mean_db, max_db = get_volume_detect_db(path, timeout_sec=t_probe)
        except (RuntimeError, OSError, subprocess.TimeoutExpired):
            pass
        if use_recommended_noise:
            detect_noise, _rec = resolve_autocutter_noise_db(
                path,
                noise_db,
                use_recommended_noise=True,
                timeout_sec=timeout_sec,
            )
        else:
            detect_noise = resolve_silencedetect_noise_db(
                noise_db,
                mean_db,
                max_db,
            )
        applied_noise_db = float(detect_noise)
        log_text, duration_ff = _run_ffmpeg_silencedetect(
            path,
            noise_db=detect_noise,
            min_silence_sec=min_silence_sec,
            timeout_sec=timeout_sec,
            sample_rate=48000,
        )
        if duration_ff > 0:
            duration_sec = duration_ff
        elif audio_dur > 0:
            duration_sec = audio_dur
        else:
            duration_sec = 0.0
        raw_silences = _parse_silencedetect_log(log_text, duration_sec)
        vocal_ms_edl = _vocal_intervals_ms_with_padding(
            raw_silences,
            duration_sec,
            padding_ms=padding_ms,
        )

    vocal_ms_edl = _merge_vocal_intervals_by_min_gap(
        vocal_ms_edl,
        min_gap_sec=min_silence_sec,
    )

    try:
        fps_probe = get_video_fps_ffprobe(path, timeout_sec=t_probe)
    except (RuntimeError, FileNotFoundError, OSError):
        fps_probe = Fraction(25, 1)
    fps_frac = resolve_fps_fraction(fps_rational, fallback=fps_probe)
    silence_segments = _silence_segments_from_vocal_ms(vocal_ms_edl, duration_sec)
    coalesced_silences = _coalesce_silence_segments(
        raw_silences,
        duration_sec,
        min_silence_sec=min_silence_sec,
        padding_ms=padding_ms,
    )

    waveform_width = compute_waveform_column_count(
        duration_sec,
        pixels_per_second=pixels_per_second,
        max_width=max_waveform_width,
    )
    return (
        silence_segments,
        duration_sec,
        fps_frac,
        waveform_width,
        vocal_ms_edl,
        raw_silences,
        coalesced_silences,
        applied_noise_db,
    )


def resolve_fps_fraction(
    fps_rational: str | None,
    *,
    fallback: Fraction | None = None,
) -> Fraction:
    """ffprobe·메타데이터 fps_rational(예: 30000/1001)을 Fraction으로 해석합니다."""
    parsed = _parse_rate_string(fps_rational) if fps_rational else None
    if parsed is not None and parsed > 0:
        return parsed
    if fallback is not None and fallback > 0:
        return fallback
    return Fraction(25, 1)


def _canonical_broadcast_fps(fps: Fraction) -> Fraction:
    """29.97·23.976 등 표시 FPS → NTSC 유리수(다빈치·프로브와 동일)."""
    f = float(fps)
    if not math.isfinite(f) or f <= 0:
        return fps
    for nominal, frac in (
        (29.97, Fraction(30000, 1001)),
        (29.96, Fraction(30000, 1001)),
        (29.92, Fraction(30000, 1001)),
        (23.98, Fraction(24000, 1001)),
        (23.976, Fraction(24000, 1001)),
        (59.94, Fraction(60000, 1001)),
        (47.95, Fraction(48000, 1001)),
    ):
        if abs(f - nominal) < 0.05:
            return frac
    return fps.limit_denominator(100_000)


def resolve_edl_fps_fraction(
    fps_float: float | None,
    fps_rational: str | None = None,
    *,
    fallback: Fraction | None = None,
) -> Fraction:
    """
    EDL·프레임 스냅용 FPS. 편집기 UI 입력(fps_float)을 최우선하고,
    없을 때만 fps_rational·프로브 fallback을 씁니다.
  파형(PCM) 탐지는 초 단위라 여기 FPS는 EDL 타임코드·컷 스냅에만 쓰입니다.
    """
    if fps_float is not None:
        f = float(fps_float)
        if f > 0 and math.isfinite(f):
            return Fraction(str(f)).limit_denominator(1_000_000)
    parsed = _parse_rate_string(fps_rational) if fps_rational else None
    if parsed is not None and parsed > 0:
        return parsed.limit_denominator(1_000_000)
    if fallback is not None and fallback > 0:
        return fallback.limit_denominator(1_000_000)
    return Fraction(25, 1)


_RE_TIMECODE = re.compile(r"^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{1,3})$")


def timecode_string_to_sec(tc: str, fps: Fraction | float) -> float | None:
    """HH:MM:SS:FF → 초(미디어 풀 시작 타임코드)."""
    m = _RE_TIMECODE.match((tc or "").strip())
    if not m:
        return None
    fps_f = _edl_fps_float(fps)
    return (
        int(m.group(1)) * 3600.0
        + int(m.group(2)) * 60.0
        + int(m.group(3))
        + int(m.group(4)) / fps_f
    )


@dataclass
class MediaEdlTiming:
    """DaVinci 미디어 풀 링크용."""

    source_tc_offset_sec: float
    content_duration_sec: float
    total_frames: int = 0


def get_video_frame_count_ffprobe(
    media_path: Path | str,
    *,
    timeout_sec: float = 120.0,
) -> int | None:
    """첫 비디오 스트림 프레임 수(nb_read_frames). 다빈치 Total Frames와 맞춤."""
    path = Path(media_path)
    if not path.is_file():
        return None
    ffprobe = get_ffprobe_executable()
    cmd = [
        str(ffprobe),
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=nb_read_frames,nb_frames",
        "-of",
        "json",
        str(path),
    ]
    try:
        proc = run_hidden(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=min(120.0, timeout_sec),
            check=False,
        )
        if proc.returncode != 0 or not proc.stdout:
            return None
        data = json.loads(proc.stdout)
        streams = data.get("streams") or []
        if not streams:
            return None
        st0 = streams[0]
        for key in ("nb_read_frames", "nb_frames"):
            raw = st0.get(key)
            if raw is None:
                continue
            try:
                n = int(str(raw).strip())
            except ValueError:
                continue
            if n > 0:
                return n
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, ValueError):
        return None
    return None


def probe_media_edl_timing(
    media_path: Path | str,
    *,
    fps: Fraction,
    timeout_sec: float = 120.0,
) -> MediaEdlTiming:
    """EDL src TC가 미디어 풀 클립 범위 안에 들어가도록 오프셋·길이를 읽습니다."""
    path = Path(media_path)
    t = min(120.0, timeout_sec)
    fps_f = _edl_fps_float(fps)
    offset_sec = 0.0

    ffprobe = get_ffprobe_executable()
    tc_cmd = [
        str(ffprobe),
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "format_tags=timecode:stream_tags=timecode",
        "-show_entries",
        "stream=start_time",
        "-of",
        "json",
        str(path),
    ]
    try:
        proc = run_hidden(
            tc_cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=t,
            check=False,
        )
        if proc.returncode == 0 and proc.stdout:
            data = json.loads(proc.stdout)
            for key in ("timecode", "TIMECODE", "TimeCode"):
                fmt_tags = data.get("format", {}).get("tags") or {}
                if isinstance(fmt_tags, dict) and key in fmt_tags:
                    parsed = timecode_string_to_sec(str(fmt_tags[key]), fps_f)
                    if parsed is not None:
                        offset_sec = parsed
                        break
            if offset_sec <= 1e-6:
                for st in data.get("streams") or []:
                    tags = st.get("tags") or {}
                    if isinstance(tags, dict):
                        for key in ("timecode", "TIMECODE", "TimeCode"):
                            if key in tags:
                                parsed = timecode_string_to_sec(str(tags[key]), fps_f)
                                if parsed is not None:
                                    offset_sec = parsed
                                    break
                    if offset_sec > 1e-6:
                        break
                    st_start = st.get("start_time")
                    if st_start is not None:
                        try:
                            offset_sec = max(0.0, float(st_start))
                        except (TypeError, ValueError):
                            pass
                        break
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, ValueError):
        pass

    dur_candidates: list[float] = []
    try:
        fmt_dur = float(get_format_duration_seconds_ffprobe(path, timeout_sec=t))
        if fmt_dur > 0:
            dur_candidates.append(fmt_dur)
    except (RuntimeError, OSError, ValueError):
        pass
    a_dur, _sr = get_audio_stream_info_ffprobe(path, timeout_sec=t)
    if a_dur is not None and a_dur > 0:
        dur_candidates.append(float(a_dur))
    v_dur = get_video_stream_duration_ffprobe(path, timeout_sec=t)
    if v_dur is not None and v_dur > 0:
        dur_candidates.append(float(v_dur))
    pool_dur = _playback_timeline_from_probe_candidates(dur_candidates)

    nb_frames = get_video_frame_count_ffprobe(path, timeout_sec=t)
    dur_frames = (
        max(0, _ms_to_frame(pool_dur * 1000.0, fps_f)) if pool_dur > 0 else 0
    )
    if nb_frames is not None and nb_frames > 0:
        if dur_frames > 0 and int(nb_frames) < dur_frames - max(3, int(round(fps_f * 0.5))):
            total_frames = dur_frames
        else:
            total_frames = int(nb_frames)
    else:
        total_frames = dur_frames
    content_dur = (
        float(total_frames) / fps_f
        if total_frames > 0
        else max(0.0, pool_dur)
    )

    return MediaEdlTiming(
        source_tc_offset_sec=max(0.0, offset_sec),
        content_duration_sec=max(0.0, content_dur),
        total_frames=int(total_frames or 0),
    )


def _frame_to_ms(frame: int, fps_f: float) -> float:
    if fps_f <= 0 or not math.isfinite(fps_f):
        return 0.0
    return float(frame) * 1000.0 / fps_f


def _snap_vocal_intervals_to_edl_frames(
    vocal_ms: list[tuple[float, float]],
    fps_f: float,
    total_frames: int,
) -> list[tuple[float, float]]:
    """말소리 in/out을 편집 FPS 프레임 격자 + 클립 총 프레임 안으로 맞춤."""
    if not vocal_ms or fps_f <= 0:
        return vocal_ms
    cap = max(1, int(total_frames))
    fps_f = _edl_fps_float(fps_f)
    snapped: list[tuple[float, float]] = []
    for start_ms, end_ms in vocal_ms:
        s_fr = _ms_to_frame(float(start_ms), fps_f)
        e_fr = _ms_to_frame(float(end_ms), fps_f)
        s_fr = max(0, min(s_fr, cap - 1))
        e_fr = max(s_fr + 1, min(e_fr, cap))
        if e_fr > s_fr:
            snapped.append((_frame_to_ms(s_fr, fps_f), _frame_to_ms(e_fr, fps_f)))
    return snapped


def fcm_for_fps(fps: Fraction) -> str:
    """DaVinci 등 대부분의 NLE는 NON-DROP FCM으로 가져오는 것이 안전합니다."""
    _ = fps
    return "NON-DROP FRAME"


def clip_name_from_media_path(media_path: Path | str) -> str:
    """미디어 풀·DaVinci 링크용 파일명(확장자 포함)."""
    name = Path(media_path).name.strip()
    return name if name else "clip.mp4"


def reel_name_from_clip_filename(filename: str) -> str:
    """CMX 릴 필드(8자). 클립 파일명 stem 앞 8자."""
    stem = Path(filename).stem.strip() if filename else ""
    if not stem:
        return "AX      "[:8]
    return stem[:8].ljust(8)


def _clamp_vocal_intervals_ms(
    vocal_ms: list[tuple[float, float]],
    duration_sec: float,
) -> list[tuple[float, float]]:
    dur_ms = max(0.0, float(duration_sec)) * 1000.0
    if dur_ms <= 0:
        return []
    out: list[tuple[float, float]] = []
    for start_ms, end_ms in vocal_ms:
        s = max(0.0, min(float(start_ms), dur_ms))
        e = max(0.0, min(float(end_ms), dur_ms))
        if e > s + 1e-3:
            out.append((s, e))
    return out


def build_edl_from_silence_segments(
    segments: list[SilenceSegment],
    *,
    duration_sec: float,
    padding_ms: float = DEFAULT_VOCAL_PADDING_MS,
    fps_rational: str | None = None,
    fps: Fraction | None = None,
    fps_float: float | None = None,
    title: str = "AutoCut_Option",
    reel: str = "SILENCE",
    fcm: str | None = None,
    clip_comment: str | None = None,
    remove_silent: bool = True,
    vocal_intervals_ms: list[tuple[float, float]] | None = None,
    min_silence_sec: float = 0.0,
    media_path: Path | str | None = None,
    source_tc_offset_sec: float | None = None,
) -> str:
    """
    EDL 재생성. vocal_intervals_ms가 있으면 그대로 쓰고,
    없으면 raw silencedetect 무음 구간 + padding으로 말소리 구간을 만듭니다.
    """
    _ = reel, fcm
    fps_frac = resolve_edl_fps_fraction(fps_float, fps_rational, fallback=fps)
    fps_f = _edl_fps_float(fps_frac)
    tc_offset = float(source_tc_offset_sec or 0.0)
    edl_dur = float(duration_sec)
    if media_path:
        timing = probe_media_edl_timing(Path(media_path), fps=fps_frac)
        if source_tc_offset_sec is None:
            tc_offset = timing.source_tc_offset_sec
        if timing.content_duration_sec > 0:
            edl_dur = timing.content_duration_sec
    if vocal_intervals_ms:
        vocal_ms = _merge_vocal_intervals_by_min_gap(
            list(vocal_intervals_ms),
            min_gap_sec=min_silence_sec,
        )
    else:
        vocal_ms = _vocal_intervals_for_edl(
            segments,
            duration_sec,
            padding_ms=padding_ms,
            min_silence_sec=min_silence_sec,
        )
    frame_cap: int | None = None
    analysis_dur = float(duration_sec)
    if media_path:
        timing = probe_media_edl_timing(Path(media_path), fps=fps_frac)
        if timing.total_frames > 0:
            frame_cap = timing.total_frames
        if timing.content_duration_sec > 0:
            edl_dur = timing.content_duration_sec
        if analysis_dur <= 0 and edl_dur > 0:
            analysis_dur = edl_dur
    clamp_dur = max(analysis_dur, edl_dur if edl_dur > 0 else analysis_dur)
    if vocal_ms:
        clamp_dur = max(clamp_dur, float(vocal_ms[-1][1]) / 1000.0)
    vocal_ms = _clamp_vocal_intervals_ms(vocal_ms, clamp_dur)
    resolved_cap = _resolve_edl_export_frame_cap(
        frame_cap,
        intervals_ms=vocal_ms,
        fps_f=fps_f,
        source_tc_offset_sec=resolve_source_tc_offset_for_edl(tc_offset),
        analysis_duration_sec=analysis_dur,
    )
    return create_edl_autocutter(
        vocal_ms,
        fps=float(fps_f),
        remove_silent=remove_silent,
        title=title,
        clip_filename=clip_comment,
        source_tc_offset_sec=resolve_source_tc_offset_for_edl(tc_offset),
        total_frames=resolved_cap,
        analysis_duration_sec=analysis_dur,
    )


def analyze_video_to_edl_with_metadata(
    video_path: Path | str,
    *,
    noise_db: float = -50.0,
    min_silence_sec: float = 0.5,
    padding_ms: float = DEFAULT_VOCAL_PADDING_MS,
    remove_silent: bool = True,
    timeout_sec: float = 3600.0,
    pixels_per_second: float = DEFAULT_WAVEFORM_PIXELS_PER_SECOND,
    max_waveform_width: int = DEFAULT_WAVEFORM_MAX_WIDTH,
    title: str | None = None,
    reel: str = "SILENCE",
    fcm: str | None = None,
    fps_rational: str | None = None,
    fps_float: float | None = None,
    use_autocutter_pipeline: bool = True,
    use_recommended_noise: bool = True,
    use_pcm_preview: bool = False,
    require_cached_peaks: bool = False,
    on_progress: Callable[[float, str], None] | None = None,
) -> tuple[
    str,
    list[SilenceSegment],
    float,
    int,
    Fraction,
    Fraction,
    list[SilenceSegment],
    list[tuple[float, float]],
    float,
    float,
    float,
    float,
    list[tuple[int, int]],
]:
    """분석해 EDL·무음 구간을 반환합니다 (Auto_Cutter silencedetect + EDL)."""
    _ = reel, fcm, use_autocutter_pipeline, use_recommended_noise, use_pcm_preview
    path = Path(video_path)
    applied_noise_db = float(int(round(float(noise_db))))

    def _prog(pct: float, msg: str) -> None:
        if on_progress is not None:
            on_progress(pct, msg)

    _prog(12.0, "무음 구간 탐지 중…")
    vocal_ms, duration_sec, raw_silences = get_nonsilent_intervals_ms_autocutter(
        path,
        threshold_db=noise_db,
        min_len_ms=max(1.0, float(min_silence_sec) * 1000.0),
        padding_ms=padding_ms,
        timeout_sec=timeout_sec,
    )
    segments = _silence_segments_from_vocal_ms(vocal_ms, duration_sec)
    _prog(58.0, "오디오 파형 확인 중…")
    waveform_timeline_sec = float(duration_sec)
    waveform_pcm_decoded_sec = 0.0
    try:
        entry, _from_cache = load_or_build_waveform_peaks_for_analyze(
            path,
            timeout_sec=timeout_sec,
            pixels_per_second=pixels_per_second,
            max_waveform_width=max_waveform_width,
            require_cached=require_cached_peaks,
        )
        waveform_width = int(entry.column_count)
        waveform_timeline_sec = float(entry.timeline_sec)
        waveform_pcm_decoded_sec = float(entry.pcm_decoded_sec or 0.0)
        _ = _from_cache
        _prog(78.0, "파형 준비 완료")
    except (FileNotFoundError, RuntimeError, OSError):
        waveform_width = compute_waveform_column_count(
            duration_sec,
            pixels_per_second=pixels_per_second,
            max_width=max_waveform_width,
        )
        _prog(72.0, "파형 메타 계산 중…")
    t_probe = min(120.0, timeout_sec)
    try:
        fps_probe = get_video_fps_ffprobe(path, timeout_sec=t_probe)
    except (RuntimeError, FileNotFoundError, OSError):
        fps_probe = Fraction(25, 1)
    native_fps = fps_probe
    fps_edl = resolve_edl_fps_fraction(
        fps_float,
        fps_rational,
        fallback=native_fps,
    )
    fps_f = float(fps_float) if fps_float is not None and fps_float > 0 else float(fps_edl)
    ttl = (title or "AutoCut_Option").strip()[:79] or "AutoCut_Option"
    clip_fn = clip_name_from_media_path(path)
    _prog(88.0, "XML 생성 중…")
    edl_timing = probe_media_edl_timing(path, fps=fps_edl, timeout_sec=t_probe)
    src_tc = resolve_source_tc_offset_for_edl(edl_timing.source_tc_offset_sec)
    edl_frame_cap = _resolve_edl_export_frame_cap(
        edl_timing.total_frames if edl_timing.total_frames > 0 else None,
        intervals_ms=vocal_ms,
        fps_f=fps_f,
        source_tc_offset_sec=src_tc,
        analysis_duration_sec=float(duration_sec),
    )
    edl = create_edl_autocutter(
        vocal_ms,
        fps=fps_f,
        remove_silent=remove_silent,
        title=ttl,
        clip_filename=clip_fn,
        source_tc_offset_sec=src_tc,
        total_frames=edl_frame_cap,
        analysis_duration_sec=float(duration_sec),
    )

    silence_column_ranges: list[tuple[int, int]] = []
    if waveform_width > 0 and waveform_timeline_sec > 1e-9 and segments:
        silence_column_ranges = _merge_adjacent_column_ranges(
            silence_segments_to_column_ranges(
                segments,
                waveform_timeline_sec,
                waveform_width,
            )
        )

    _prog(96.0, "결과 정리 중…")
    return (
        edl,
        segments,
        duration_sec,
        waveform_width,
        fps_edl,
        native_fps,
        raw_silences,
        vocal_ms,
        applied_noise_db,
        waveform_timeline_sec,
        waveform_pcm_decoded_sec,
        float(pixels_per_second),
        silence_column_ranges,
    )


def _parse_silencedetect_log(log: str, duration_sec: float) -> list[SilenceSegment]:
    segments: list[SilenceSegment] = []
    pending_start: float | None = None

    for line in log.splitlines():
        sm = _RE_SILENCE_START.search(line)
        if sm:
            pending_start = float(sm.group(1))
            continue
        em = _RE_SILENCE_END.search(line)
        if em and pending_start is not None:
            end = float(em.group(1))
            if end > pending_start:
                segments.append(SilenceSegment(pending_start, end))
            pending_start = None

    if pending_start is not None:
        end = max(pending_start, duration_sec)
        if end > pending_start:
            segments.append(SilenceSegment(pending_start, end))

    segments.sort(key=lambda s: s.start_sec)
    return segments


@dataclass
class AnalyzeJobStatus:
    phase: str
    progress: float
    message: str | None
    result: dict[str, object] | None = None


_analyze_lock = threading.RLock()
_analyze_job = AnalyzeJobStatus(phase="idle", progress=0.0, message=None)
_analyze_thread: threading.Thread | None = None


def get_analyze_job_status() -> AnalyzeJobStatus:
    with _analyze_lock:
        return AnalyzeJobStatus(
            phase=_analyze_job.phase,
            progress=_analyze_job.progress,
            message=_analyze_job.message,
            result=_analyze_job.result,
        )


def _set_analyze_job(
    phase: str,
    progress: float,
    message: str | None,
    result: dict[str, object] | None = None,
) -> None:
    with _analyze_lock:
        pct = float(progress)
        if phase == "running" and _analyze_job.phase == "running":
            pct = max(_analyze_job.progress, pct)
        elif phase == "ready":
            pct = 100.0
        elif phase == "failed":
            pct = 0.0
        _analyze_job.phase = phase
        _analyze_job.progress = min(100.0, max(0.0, pct))
        _analyze_job.message = message
        if result is not None or phase in ("ready", "failed", "idle"):
            _analyze_job.result = result


def report_analyze_progress(progress: float, message: str | None = None) -> None:
    """백그라운드 무음 분석 중 UI 폴링용 진행률(단조 증가)."""
    _set_analyze_job("running", progress, message)


def _run_analyze_job(payload_fn: Callable[[], dict[str, object]]) -> None:
    try:
        _set_analyze_job("running", 10.0, "무음 구간 분석 중…")
        result = payload_fn()
        _set_analyze_job("ready", 100.0, "분석 완료", result)
    except subprocess.TimeoutExpired as exc:
        _set_analyze_job("failed", 0.0, f"FFmpeg 실행이 시간 초과되었습니다: {exc}", None)
    except FileNotFoundError as exc:
        _set_analyze_job("failed", 0.0, str(exc), None)
    except RuntimeError as exc:
        _set_analyze_job("failed", 0.0, str(exc), None)
    except Exception as exc:
        _set_analyze_job("failed", 0.0, f"분석 중 오류: {exc}", None)


def start_analyze_job(payload_fn: Callable[[], dict[str, object]]) -> AnalyzeJobStatus:
    global _analyze_thread

    with _analyze_lock:
        if _analyze_thread is not None and _analyze_thread.is_alive():
            return get_analyze_job_status()

        _analyze_job.result = None
        _analyze_job.phase = "running"
        _analyze_job.progress = 3.0
        _analyze_job.message = "분석 작업을 시작합니다…"
        _analyze_thread = threading.Thread(
            target=_run_analyze_job,
            args=(payload_fn,),
            daemon=True,
        )
        _analyze_thread.start()

    return get_analyze_job_status()
