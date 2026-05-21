"""Demucs vocal separation via agent/engines/vocal_remover (gRPC inference backend)."""
from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

LOG = logging.getLogger(__name__)

VOCAL_MODEL_IDS = frozenset({"mdx_extra_q", "vocal-remover", "vocal_remover"})


def is_vocal_model(model_id: str) -> bool:
    return (model_id or "").strip().lower() in {m.lower() for m in VOCAL_MODEL_IDS}


def resolve_agent_dir() -> Path | None:
    custom = os.environ.get("ITMATZIP_AGENT_DIR", "").strip()
    if custom:
        candidate = Path(custom)
        if (candidate / "main.py").is_file():
            return candidate

    install = os.environ.get("ITMATZIP_AGENT_INSTALL_ROOT", "").strip()
    if install:
        candidate = Path(install) / "agent"
        if (candidate / "main.py").is_file():
            return candidate

    here = Path(__file__).resolve()
    for candidate in (
        here.parent.parent / "agent",
        here.parent.parent.parent / "agent",
    ):
        if (candidate / "main.py").is_file():
            return candidate
    return None


def _ensure_agent_import_path(agent_dir: Path) -> None:
    agent_str = str(agent_dir)
    if agent_str not in sys.path:
        sys.path.insert(0, agent_str)


def demucs_available() -> bool:
    agent_dir = resolve_agent_dir()
    if agent_dir is None:
        return False
    try:
        _ensure_agent_import_path(agent_dir)
        from engines.vocal_remover import is_demucs_installed

        return bool(is_demucs_installed())
    except Exception as exc:
        LOG.debug("demucs availability check failed: %s", exc)
        return False


def parse_vocal_payload(input_payload: bytes) -> dict:
    if not input_payload:
        raise ValueError("input_payload is required for vocal separation")
    text = input_payload.decode("utf-8").strip()
    if not text:
        raise ValueError("input_payload is empty")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError("input_payload must be JSON for vocal separation") from exc
    if not isinstance(data, dict):
        raise ValueError("input_payload JSON must be an object")
    return data


def run_vocal_separation(model_id: str, input_payload: bytes) -> dict:
    agent_dir = resolve_agent_dir()
    if agent_dir is None:
        raise RuntimeError("agent directory not found (set ITMATZIP_AGENT_DIR)")

    data = parse_vocal_payload(input_payload)
    audio_path = Path(str(data.get("audio_path", "")).strip())
    output_format = str(data.get("output_format", "wav")).strip().lower() or "wav"
    device = data.get("device")
    timeout_sec = float(data.get("timeout_sec", 3600.0))

    if not audio_path.is_file():
        raise FileNotFoundError(f"audio file not found: {audio_path}")

    _ensure_agent_import_path(agent_dir)
    from engines.vocal_remover import MODEL_NAME, is_demucs_installed, separate_stems

    if not is_demucs_installed():
        raise RuntimeError("Demucs is not installed. Run /api/tools/vocal-remover/prepare first.")

    progress_log: list[dict] = []

    def on_progress(pct: float, message: str) -> None:
        progress_log.append({"progress": pct, "message": message})
        LOG.info("vocal separation %.1f%%: %s", pct, message)

    result = separate_stems(
        audio_path,
        output_format,
        timeout_sec=timeout_sec,
        device=device,
        on_progress=on_progress,
    )

    return {
        "status": "ok",
        "model_id": model_id or MODEL_NAME,
        "engine": "demucs",
        "instrumental_path": str(result.instrumental_path),
        "vocals_path": str(result.vocals_path),
        "export_path": str(result.export_path),
        "original_path": str(result.original_path),
        "duration_sec": result.duration_sec,
        "progress_tail": progress_log[-5:],
    }
