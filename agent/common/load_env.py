"""로컬 .env 로드 — git 제외, 기존 os.environ 은 덮어쓰지 않음."""

from __future__ import annotations

import os
from pathlib import Path


def _parse_env_file(path: Path) -> None:
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not key or key in os.environ:
            continue
        val = value.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        os.environ[key] = val


def load_local_env_files() -> list[Path]:
    """agent/.env, 저장소 루트 .env, MSI 설치 경로 .env 순으로 탐색."""
    agent_dir = Path(__file__).resolve().parents[1]
    candidates: list[Path] = [
        agent_dir / ".env",
        agent_dir.parent / ".env",
    ]
    install = os.environ.get("ITMATZIP_AGENT_INSTALL_ROOT", "").strip()
    if install:
        candidates.append(Path(install) / ".env")

    loaded: list[Path] = []
    seen: set[Path] = set()
    for path in candidates:
        resolved = path.resolve()
        if resolved in seen or not resolved.is_file():
            continue
        seen.add(resolved)
        _parse_env_file(resolved)
        loaded.append(resolved)
    return loaded
