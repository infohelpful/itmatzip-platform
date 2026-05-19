"""Windows에서 ffmpeg/ffprobe 등 콘솔 프로그램 실행 시 CMD 창 깜빡임 방지."""

from __future__ import annotations

import os
import subprocess
from typing import Any


def no_window_creationflags(extra: int = 0) -> int:
    flags = int(extra)
    if os.name == "nt":
        flags |= getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return flags


def run_hidden(*args: Any, creationflags: int = 0, **kwargs: Any) -> subprocess.CompletedProcess[Any]:
    if os.name == "nt":
        kwargs["creationflags"] = no_window_creationflags(creationflags)
    return subprocess.run(*args, **kwargs)
