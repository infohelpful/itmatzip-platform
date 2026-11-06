"""Vocal Remover runner 공통 부트스트랩 (numpy/torch import 전에 호출).

MSI embeddable Python 은 PYTHONPATH 를 무시하므로 agent 경로와 툴별 runtime
site-packages 를 sys.path 에 직접 넣습니다.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def bootstrap_import_paths() -> None:
    agent = os.environ.get("ITMATZIP_AGENT_DIR", "").strip()
    if not agent:
        install = os.environ.get("ITMATZIP_AGENT_INSTALL_ROOT", "").strip()
        if install:
            agent = str(Path(install) / "agent")
    if not agent:
        agent = str(Path(__file__).resolve().parent.parent)
    if agent not in sys.path:
        sys.path.insert(0, agent)
    try:
        from common.runtime_site_packages import TOOL_VOCAL_REMOVER, activate_runtime_site_packages

        os.environ.setdefault("ITMATZIP_RUNTIME_TOOL", TOOL_VOCAL_REMOVER)
        activate_runtime_site_packages(TOOL_VOCAL_REMOVER)
    except Exception as exc:  # 개발 환경·테스트에서는 없어도 됨
        print(f"warning: runtime site-packages bootstrap failed: {exc}", file=sys.stderr)
