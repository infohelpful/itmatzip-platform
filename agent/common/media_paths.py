"""Windows media path helpers shared by tools (moved from the removed engines/auto_subtitle.py)."""
from __future__ import annotations

import os
import re
import unicodedata
from pathlib import Path


def normalize_media_path(raw: str) -> str:
    """Undo common copy/paste damage: quotes, NFC, yen/won signs for backslash, bidi marks, `/C:/`."""
    p = unicodedata.normalize("NFC", raw).strip().strip('"').strip("'")
    p = p.replace("¥", "\\").replace("₩", "\\")
    p = re.sub(r"[\u200b-\u200f\u202a-\u202e\ufeff]", "", p)
    p = re.sub(r"^[\/]+([A-Za-z]:[\/])", r"\1", p)
    p = re.sub(r"^([A-Za-z])[\/](?![\/])", r"\1:\\", p)
    return os.path.normpath(p)


def resolve_existing_file(p: str) -> Path | None:
    """The file itself, or its \\?\ long-path form on Windows; None when missing."""
    if os.path.isfile(p):
        return Path(p)
    if os.name == "nt":
        ap = os.path.abspath(p)
        if not ap.startswith("\\?\\"):
            long_p = "\\?\\" + ap
            if os.path.isfile(long_p):
                return Path(long_p)
    return None
