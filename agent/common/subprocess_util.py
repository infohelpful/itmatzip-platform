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
    from common.runtime_site_packages import prepend_runtime_pythonpath

    env = os.environ.copy()
    env["PYTHONNOUSERSITE"] = "1"
    env.setdefault("PIP_DISABLE_PIP_VERSION_CHECK", "1")
    prepend_runtime_pythonpath(env)
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
    cmd = args[0] if args else kwargs.get("args")
    tool_id = None
    if isinstance(cmd, list):
        from common.runtime_site_packages import (
            ensure_runtime_tree_acl,
            finalize_runtime_pip,
            runtime_pip_tool_id_from_command,
        )

        tool_id = runtime_pip_tool_id_from_command(cmd, kwargs["env"])
        if tool_id:
            ensure_runtime_tree_acl(tool_id)
    proc = subprocess.run(*args, **kwargs)
    if tool_id:
        finalize_runtime_pip(tool_id)
    return proc
