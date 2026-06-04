"""Silence Remover — Pillow 등 engine pip 대상 (툴 전용 runtime)."""

from __future__ import annotations

from common.runtime_site_packages import (
    TOOL_SILENCE_REMOVER,
    activate_runtime_site_packages,
    pip_install_cmd,
    tool_has_module,
    use_runtime_site_packages,
    verify_importable,
)
from common.subprocess_util import agent_subprocess_env, run_hidden

RUNTIME_TOOL_ID = TOOL_SILENCE_REMOVER
_ready = False


def ensure_silence_remover_runtime(*, install: bool = True) -> None:
    """MSI engine 에서 Pillow 를 silence-remover 전용 site-packages 에만 설치."""
    global _ready
    if _ready:
        activate_runtime_site_packages(RUNTIME_TOOL_ID)
        return
    if not use_runtime_site_packages():
        _ready = True
        return
    activate_runtime_site_packages(RUNTIME_TOOL_ID)
    if tool_has_module(RUNTIME_TOOL_ID, "PIL"):
        _ready = True
        return
    if not install:
        return
    proc = run_hidden(
        pip_install_cmd(RUNTIME_TOOL_ID, upgrade=True) + ["Pillow>=10.0.0"],
        capture_output=True,
        text=True,
        timeout=600,
        env=agent_subprocess_env({"ITMATZIP_RUNTIME_TOOL": RUNTIME_TOOL_ID}),
    )
    if proc.returncode != 0:
        detail = proc.stderr or proc.stdout or "unknown"
        raise RuntimeError(f"Silence Remover Pillow 설치 실패: {detail[-1200:]}")
    activate_runtime_site_packages(RUNTIME_TOOL_ID)
    verify_importable(RUNTIME_TOOL_ID, "PIL")
    _ready = True
