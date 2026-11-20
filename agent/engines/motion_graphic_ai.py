"""모션그래픽도구 — 내 PC 의 AI CLI(Claude Code · Codex · Antigravity) 찾기·상태·실행 옵션.

설계 작업 자체는 engines/motion_graphic_design.py. CLI 찾기·실행 옵션은 AutoSubtitle(engines/mcp_chat.py)과
같은 방식이지만, AutoSubtitle 코드를 건드리지 않도록 이 파일에 따로 둔다.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any
from urllib.request import urlopen


CLIENTS = ("claude", "codex", "antigravity")
LABELS = {"claude": "Claude Code", "codex": "Codex", "antigravity": "Antigravity"}
_FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_EFFORT = "medium"

_lock = threading.Lock()

# ── 설치된 AI CLI ─────────────────────────────────────────────────────

_STATUS_FRESH_SEC = 120
_status_cache: tuple[float, list[dict[str, Any]] | None] = (0.0, None)
_status_refreshing = False


def _executable(client: str) -> str:
    name = "agy" if client == "antigravity" else client
    path = shutil.which(name)
    if path:
        return path
    # MSI 트레이 프로세스는 로그인 사용자의 PATH 를 못 받을 수 있다.
    profile = Path(os.environ.get("USERPROFILE", ""))
    appdata = Path(os.environ.get("APPDATA", ""))
    local = Path(os.environ.get("LOCALAPPDATA", ""))
    candidates = [profile / ".local" / "bin" / f"{name}.exe", appdata / "npm" / f"{name}.cmd",
                  local / "agy" / "bin" / f"{name}.exe"]
    if client == "codex":
        candidates.extend(sorted((local / "OpenAI" / "Codex" / "bin").glob("*/codex.exe"),
                                 key=lambda item: item.stat().st_mtime, reverse=True))
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    raise ValueError(f"{LABELS.get(client, client)} CLI 를 찾지 못했습니다. 트레이의 AI MCP 설정에서 설치해 주세요.")


def _fetch_status() -> list[dict[str, Any]] | None:
    """Go 에이전트의 AI CLI 상태(설치·로그인). `claude mcp list` 를 돌려서 20초 넘게 걸릴 수 있다."""
    try:
        with urlopen("http://127.0.0.1:19876/api/agent/ai-mcp", timeout=90) as response:
            data = json.load(response)
        out = []
        for item in data.get("clients", []):
            if item.get("id") in CLIENTS:
                out.append({"id": item["id"], "installed": bool(item.get("installed")),
                            "logged_in": item.get("loggedIn") if item.get("loginKnown") else None})
        return out
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _local_status() -> list[dict[str, Any]]:
    out = []
    for client in CLIENTS:
        try:
            _executable(client)
            installed = True
        except ValueError:
            installed = False
        out.append({"id": client, "installed": installed, "logged_in": None})
    return out


def _refresh_status() -> None:
    global _status_cache, _status_refreshing
    try:
        status = _fetch_status() or _local_status()
        with _lock:
            _status_cache = (time.monotonic(), status)
    finally:
        with _lock:
            _status_refreshing = False


def clients_status() -> list[dict[str, Any]]:
    """AI CLI 목록. 처음 한 번은 빠른 로컬 검사로 답하고, 정확한 상태는 뒤에서 갱신한다."""
    global _status_refreshing
    with _lock:
        stamp, cached = _status_cache
        start = time.monotonic() - stamp >= _STATUS_FRESH_SEC and not _status_refreshing
        if start:
            _status_refreshing = True
    if start:
        threading.Thread(target=_refresh_status, daemon=True).start()
    status = cached if cached is not None else _local_status()
    status = sorted(status, key=lambda s: CLIENTS.index(s["id"]))
    return [{**s, "name": LABELS[s["id"]]} for s in status]


def _command(client: str, executable: str) -> list[str]:
    if client == "codex":
        return [executable, "exec", "--skip-git-repo-check", "--ephemeral",
                "-c", f'model_reasoning_effort="{_EFFORT}"', "-c", "mcp_servers={}",
                "--sandbox", "read-only", "-"]
    if client == "claude":
        return [executable, "-p", "--effort", _EFFORT, "--no-session-persistence", "--disable-slash-commands",
                "--tools", "", "--strict-mcp-config", "--output-format", "text"]
    return [executable, "--mode", "plan", "--effort", _EFFORT, "--disable-slash-commands", "--sandbox",
            "--input-format", "stream-json", "--output-format", "stream-json"]


def _environment(client: str, executable: str) -> dict[str, str]:
    env = os.environ.copy()
    env["PATH"] = str(Path(executable).parent) + os.pathsep + env.get("PATH", "")
    if client == "codex" and env.get("USERPROFILE"):
        env["HOME"] = env["USERPROFILE"]
        env["CODEX_HOME"] = str(Path(env["USERPROFILE"]) / ".codex")
    return env
