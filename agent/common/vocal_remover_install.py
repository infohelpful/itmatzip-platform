from __future__ import annotations

import os
from pathlib import Path

VOCAL_REMOVER_ROOT = Path(os.environ.get("APPDATA", Path.home() / ".itmatzip")) / "ItMatZip" / "vocal-remover"
MODEL_ROOT = VOCAL_REMOVER_ROOT / "models"
CACHE_ROOT = VOCAL_REMOVER_ROOT / "cache"


def ensure_directories() -> None:
    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)


def model_cache_path(model_name: str) -> Path:
    ensure_directories()
    return MODEL_ROOT / model_name


def is_model_cached(model_name: str) -> bool:
    return model_cache_path(model_name).exists()
