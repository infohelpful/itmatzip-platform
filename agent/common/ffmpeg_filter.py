"""FFmpeg filter_complex CLI helpers — file vs inline, version-tolerant."""

from __future__ import annotations

import subprocess
from pathlib import Path

from common.subprocess_util import no_window_creationflags

_FILTER_FROM_FILE_FLAG: str | None = None


def resolve_filter_complex_from_file_flag(ffmpeg_exe: str) -> str | None:
    """Return ``-/filter_complex``, ``-filter_complex_script``, or ``None`` (inline only)."""
    global _FILTER_FROM_FILE_FLAG
    if _FILTER_FROM_FILE_FLAG is not None:
        return _FILTER_FROM_FILE_FLAG or None
    try:
        p = subprocess.run(
            [ffmpeg_exe, "-hide_banner", "-h", "full"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            creationflags=no_window_creationflags(),
        )
        text = (p.stdout or "") + (p.stderr or "")
    except Exception:
        text = ""
    if "-/filter_complex" in text:
        flag = "-/filter_complex"
    elif "filter_complex_script" in text:
        flag = "-filter_complex_script"
    else:
        flag = ""
    _FILTER_FROM_FILE_FLAG = flag
    return flag or None


def filter_complex_argv(
    ffmpeg_exe: str,
    script_body: str,
    *,
    script_path: Path | None = None,
) -> list[str]:
    """Build filter argv; writes ``script_path`` when a file-based flag is available."""
    from_file = resolve_filter_complex_from_file_flag(ffmpeg_exe)
    if script_path is not None and from_file:
        script_path.parent.mkdir(parents=True, exist_ok=True)
        script_path.write_text(script_body, encoding="utf-8")
        return [from_file, str(script_path)]
    return ["-filter_complex", script_body]
