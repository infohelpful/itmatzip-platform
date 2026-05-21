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


def agent_subprocess_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """MSI embeddable + Windows 서비스: user site-packages 분리 (Cython/torch 경로 꼬임 방지)."""
    env = os.environ.copy()
    env["PYTHONNOUSERSITE"] = "1"
    env.setdefault("PIP_DISABLE_PIP_VERSION_CHECK", "1")
    if extra:
        env.update(extra)
    return env


def run_hidden(*args: Any, creationflags: int = 0, **kwargs: Any) -> subprocess.CompletedProcess[Any]:
    if os.name == "nt":
        kwargs["creationflags"] = no_window_creationflags(creationflags)
    if "env" in kwargs:
        kwargs["env"] = agent_subprocess_env(kwargs["env"])
    else:
        kwargs["env"] = agent_subprocess_env()
    return subprocess.run(*args, **kwargs)
