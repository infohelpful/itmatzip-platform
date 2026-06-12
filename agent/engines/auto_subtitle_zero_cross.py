"""PCM zero-crossing refine — STT(RMS/VAD) 및 bake/export trim 경계 공용."""

from __future__ import annotations

import math
import subprocess
from pathlib import Path

import numpy as np

from common.bin_manager import get_ffmpeg_executable
from common.subprocess_util import no_window_creationflags

SR = 16_000
ZC_END_SEARCH_BEFORE_SEC = 0.012
ZC_END_SEARCH_AFTER_SEC = 0.004
ZC_START_SEARCH_BEFORE_SEC = 0.004
ZC_START_SEARCH_AFTER_SEC = 0.012
SEGMENT_MIN_SEC = 1e-4
ZC_MIN_REMAINING_WORD_SEC = 0.04
ZC_PAIR_EPS = 1e-4


def resolve_ffmpeg(explicit: str | None = None) -> str:
    if explicit and str(explicit).strip():
        p = Path(explicit)
        if p.is_file():
            return str(p.resolve())
    return str(get_ffmpeg_executable())


def decode_mono_f32_16k(media_path: str | Path, ffmpeg_exe: str | None = None) -> np.ndarray:
    ff = resolve_ffmpeg(ffmpeg_exe)
    cflags = no_window_creationflags()
    r = subprocess.run(
        [
            ff,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(media_path),
            "-ac",
            "1",
            "-ar",
            str(SR),
            "-f",
            "f32le",
            "-",
        ],
        capture_output=True,
        timeout=3 * 60 * 60,
        creationflags=cflags,
    )
    if r.returncode != 0:
        err = (r.stderr or b"").decode("utf-8", errors="replace")
        raise RuntimeError(err.strip() or f"ffmpeg decode exit {r.returncode}")
    raw = r.stdout or b""
    if len(raw) < 4:
        raise RuntimeError("ffmpeg produced empty audio")
    n = len(raw) // 4
    return np.frombuffer(raw[: n * 4], dtype=np.float32).copy()


def refine_time_to_zero_cross(
    samples: np.ndarray,
    sr: int,
    t_sec: float,
    search_before: float,
    search_after: float,
    *,
    dur_max: float,
) -> float:
    """t_sec ± search window — zero-cross 또는 |sample| 최소 지점."""
    t_sec = float(t_sec)
    t0 = max(0.0, t_sec - float(search_before))
    t1 = min(float(dur_max), t_sec + float(search_after))
    inv_sr = 1.0 / float(sr)
    if t1 <= t0 + inv_sr:
        return max(0.0, min(dur_max, t_sec))

    i0 = max(0, int(math.floor(t0 * sr)))
    i1 = min(len(samples) - 2, int(math.ceil(t1 * sr)))
    if i1 <= i0:
        return max(0.0, min(dur_max, t_sec))

    best_t = t_sec
    best_score = float("inf")

    for i in range(i0, i1 + 1):
        a = float(samples[i])
        if abs(a) <= 1e-7:
            t_cross = i * inv_sr
            score = abs(t_cross - t_sec)
            if score < best_score:
                best_score = score
                best_t = t_cross
        if i >= len(samples) - 1:
            continue
        b = float(samples[i + 1])
        if a * b < -1e-12:
            denom = b - a
            if abs(denom) > 1e-12:
                frac = max(0.0, min(1.0, -a / denom))
                t_cross = (i + frac) * inv_sr
                score = abs(t_cross - t_sec)
                if score < best_score:
                    best_score = score
                    best_t = t_cross

    seg = np.abs(samples[i0 : i1 + 1].astype(np.float64))
    if seg.size > 0:
        rel = int(np.argmin(seg))
        t_min = (i0 + rel) * inv_sr
        amp = float(seg[rel])
        score = abs(t_min - t_sec) + amp * 80.0
        if score < best_score:
            best_t = t_min

    return max(0.0, min(dur_max, best_t))
