"""Folders and executables used by the AutoSubtitle web engine."""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

TOOL_ID = "auto-subtitle"
SIDECAR_DIR = Path(__file__).resolve().parent / "sidecar"
# Same list as the desktop app (src/main/index.ts VIDEO_EXTENSIONS).
VIDEO_EXTENSIONS = (".mp4", ".mkv", ".avi")


def data_root() -> Path:
    """Same root the agent uses for every tool (ProgramData when installed, %APPDATA% in dev)."""
    data = os.environ.get("ITMATZIP_AGENT_DATA", "").strip()
    if data:
        return Path(data) / TOOL_ID
    appdata = os.environ.get("APPDATA", "").strip()
    return (Path(appdata) / "ItMatZip" if appdata else Path.home() / ".itmatzip") / TOOL_ID


def models_dir() -> Path:
    override = os.environ.get("ITMATZIP_AUTOSUB_MODELS_DIR", "").strip()
    return Path(override) if override else data_root() / "models"


def prepared_media_dir() -> Path:
    return data_root() / "PreparedMedia"


def waveform_cache_dir() -> Path:
    return data_root() / "WaveformCache"


def align_cache_dir() -> Path:
    """Where the sidecar keeps the WhisperX alignment model (its default: <models>/hf-align-cache)."""
    return models_dir() / "hf-align-cache"


def align_runtime_dir() -> Path:
    """Private Python for WhisperX/torch, kept apart from the agent's own packages."""
    override = os.environ.get("ITMATZIP_AUTOSUB_ALIGN_RUNTIME", "").strip()
    if override:
        return Path(override)
    appdata = os.environ.get("APPDATA", "").strip()
    base = Path(appdata) / "ItMatZip" if appdata else Path.home() / ".itmatzip"
    return base / "engine-runtime" / "auto-subtitle-align"


def tool_bin_dir() -> Path:
    """Agent-wide bin folder (FFmpeg lives here too); audiowaveform.exe is installed into it."""
    return data_root().parent / "bin"


def sidecar_python() -> str:
    """Interpreter for the sidecar subprocess; packages come from the tool runtime folder."""
    return os.environ.get("ITMATZIP_AUTOSUB_PYTHON", "").strip() or sys.executable


def ffmpeg_paths() -> tuple[str, str] | None:
    """(ffmpeg, ffprobe) when both exist; agent-managed FFmpeg first, then PATH."""
    try:
        from common.bin_manager import get_ffmpeg_exe, get_ffprobe_exe

        ff, fp = get_ffmpeg_exe(), get_ffprobe_exe()
        if ff.is_file() and fp.is_file():
            return str(ff), str(fp)
    except Exception:  # noqa: BLE001 - fall back to PATH below
        pass
    ff, fp = shutil.which("ffmpeg"), shutil.which("ffprobe")
    return (ff, fp) if ff and fp else None


def audiowaveform_exe() -> str | None:
    override = os.environ.get("AUTOSUBTITLE_AUDIOWAVEFORM_PATH", "").strip()
    candidates = [Path(override)] if override else []
    candidates += [tool_bin_dir() / "audiowaveform.exe",
                   Path(__file__).resolve().parent / "bin" / "audiowaveform.exe"]
    for path in candidates:
        if path.is_file():
            return str(path)
    return None


def is_video_path(path: str | Path) -> bool:
    return Path(path).suffix.lower() in VIDEO_EXTENSIONS
