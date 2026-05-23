"""Peaks.js 호환 JSON — BBC audiowaveform CLI (AutoSubtitle main.py 이식)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from common.bin_manager import get_ffmpeg_executable
from common.subprocess_util import no_window_creationflags

_PEAKS_PIXELS_PER_SECOND = 800
_PEAKS_BITS = 8
_PEAKS_MAX_SAMPLES_PER_PIXEL_STALE = 128
_DIRECT_AUDIO_EXTS = frozenset({".mp3", ".wav", ".flac", ".ogg", ".oga", ".opus"})


def _agent_data_root() -> Path:
    data = os.environ.get("ITMATZIP_AGENT_DATA", "").strip()
    if data:
        return Path(data)
    appdata = os.environ.get("APPDATA", "").strip()
    if appdata:
        return Path(appdata) / "ItMatZip"
    return Path.home() / ".itmatzip"


def resolve_audiowaveform_exe() -> Path | None:
    env = os.environ.get("ITMATZIP_AUDIOWAVEFORM_PATH", "").strip() or os.environ.get(
        "AUTOSUBTITLE_AUDIOWAVEFORM_PATH", ""
    ).strip()
    if env:
        ep = Path(env)
        if ep.is_file():
            return ep
    name = "audiowaveform.exe" if sys.platform == "win32" else "audiowaveform"
    candidates = [
        _agent_data_root() / "bin" / name,
        Path(__file__).resolve().parents[2] / "resources" / "bin" / name,
    ]
    for here in candidates:
        if here.is_file():
            return here
    return None


def _should_regenerate_peaks(media: Path, peaks_json: Path) -> bool:
    if not peaks_json.is_file():
        return True
    try:
        if media.stat().st_mtime > peaks_json.stat().st_mtime:
            return True
    except OSError:
        return True
    try:
        with open(peaks_json, encoding="utf-8") as f:
            d = json.load(f)
        spp = int(d.get("samples_per_pixel") or 0)
        if spp <= 0 or spp > _PEAKS_MAX_SAMPLES_PER_PIXEL_STALE:
            return True
    except (OSError, ValueError, TypeError):
        return True
    return False


def _media_uses_ffmpeg_to_wav(path: Path) -> bool:
    return path.suffix.lower() not in _DIRECT_AUDIO_EXTS


def run_audiowaveform_to_json(
    media_path: Path,
    out_json: Path,
    *,
    ffmpeg_exe: str | None = None,
    aw_exe: Path | None = None,
) -> dict[str, Any]:
    media = media_path.resolve()
    if not media.is_file():
        raise ValueError(f"not a file: {media}")
    aw = aw_exe or resolve_audiowaveform_exe()
    if aw is None:
        return {
            "ok": False,
            "path": None,
            "reason": "audiowaveform binary not found (ITMATZIP_AUDIOWAVEFORM_PATH)",
        }
    ff = ffmpeg_exe or str(get_ffmpeg_executable())
    out_json.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_json.with_suffix(out_json.suffix + ".part")
    try:
        if tmp.is_file():
            tmp.unlink()
    except OSError:
        pass
    cflags = no_window_creationflags()
    if _media_uses_ffmpeg_to_wav(media):
        ff_proc = subprocess.Popen(
            [
                ff,
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(media),
                "-f",
                "wav",
                "-",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=cflags,
        )
        try:
            r = subprocess.run(
                [
                    str(aw),
                    "-i",
                    "-",
                    "--input-format",
                    "wav",
                    "-o",
                    str(tmp),
                    "--output-format",
                    "json",
                    "-b",
                    str(_PEAKS_BITS),
                    "--pixels-per-second",
                    str(_PEAKS_PIXELS_PER_SECOND),
                ],
                stdin=ff_proc.stdout,
                capture_output=True,
                timeout=3 * 60 * 60,
                creationflags=cflags,
            )
        finally:
            if ff_proc.stdout:
                ff_proc.stdout.close()
            ff_proc.wait(timeout=120)
    else:
        r = subprocess.run(
            [
                str(aw),
                "-i",
                str(media),
                "-o",
                str(tmp),
                "--output-format",
                "json",
                "-b",
                str(_PEAKS_BITS),
                "--pixels-per-second",
                str(_PEAKS_PIXELS_PER_SECOND),
            ],
            capture_output=True,
            timeout=3 * 60 * 60,
            creationflags=cflags,
        )
    if r.returncode != 0:
        err = (r.stderr or b"").decode("utf-8", errors="replace")
        return {"ok": False, "path": None, "reason": err.strip() or f"audiowaveform exit {r.returncode}"}
    try:
        tmp.replace(out_json)
    except OSError as e:
        return {"ok": False, "path": None, "reason": str(e)}
    return {"ok": True, "path": str(out_json.resolve()), "reason": None}


def waveform_peaks_impl(
    media_path: Path,
    out_path: Path,
    *,
    ffmpeg_exe: str | None = None,
) -> dict[str, Any]:
    media = media_path.resolve()
    if not media.is_file():
        raise ValueError(f"not a file: {media_path}")
    aw = resolve_audiowaveform_exe()
    if aw is None:
        return {
            "ok": False,
            "path": None,
            "reason": "audiowaveform binary not found",
            "engine": "audiowaveform",
        }
    dest = out_path.resolve()
    if not _should_regenerate_peaks(media, dest):
        return {"ok": True, "path": str(dest), "reason": None, "cached": True, "engine": "audiowaveform"}
    result = run_audiowaveform_to_json(media, dest, ffmpeg_exe=ffmpeg_exe, aw_exe=aw)
    result["engine"] = "audiowaveform"
    return result
