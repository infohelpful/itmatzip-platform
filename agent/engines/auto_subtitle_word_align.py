"""Auto Subtitle — Kiwi(kiwipiepy) 기반 단어 칩 줄나눔 후보 (LGPL)."""

from __future__ import annotations

import logging
import os
import re
import subprocess
from pathlib import Path
from typing import Any

from common.runtime_site_packages import (
    TOOL_AUTO_SUBTITLE,
    activate_runtime_site_packages,
    ensure_runtime_tree_acl,
    runtime_site_packages_dir,
    tool_has_module,
)

_log = logging.getLogger(__name__)

DEFAULT_MIN_CHARS = 14
DEFAULT_MAX_CHARS = 22

_WIN_USERS_RX = "*S-1-5-32-545:(RX)"
_WIN_USERS_TREE_RX = "*S-1-5-32-545:(OI)(CI)(RX)"

# 조사·어미 계열 — 문장 경계에서 줄 나눔 후보
_MORPH_BREAK_TAGS = frozenset(
    {
        "JKS",
        "JKO",
        "JKC",
        "JKG",
        "JKV",
        "JX",
        "JC",
        "EC",
        "EF",
        "EP",
        "ETN",
        "ETM",
    }
)

_kiwi_instance: Any | None = None
_kiwi_dll_dirs_added: set[str] = set()


def _run_icacls_grant(args: list[str]) -> None:
    if os.name != "nt":
        return
    try:
        from common.subprocess_util import no_window_creationflags

        subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=120,
            creationflags=no_window_creationflags(),
        )
    except Exception as exc:
        _log.debug("kiwipiepy icacls skipped: %s", exc)


def _repair_kiwipiepy_native_acl(site: Path) -> None:
    """SYSTEM/관리자 pip 후 _kiwipiepy.pyd 실행 권한이 빠진 경우 복구."""
    if os.name != "nt":
        return
    pyd = site / "_kiwipiepy.pyd"
    kiwi_dir = site / "kiwipiepy"
    if pyd.is_file():
        _run_icacls_grant(["icacls", str(pyd), "/grant", _WIN_USERS_RX, "/Q"])
    if kiwi_dir.is_dir():
        _run_icacls_grant(["icacls", str(kiwi_dir), "/grant", _WIN_USERS_TREE_RX, "/T", "/Q"])


def _prepend_kiwi_dll_search_path(site: Path) -> None:
    if not hasattr(os, "add_dll_directory"):
        return
    for directory in (site / "kiwipiepy", site):
        if not directory.is_dir():
            continue
        key = str(directory.resolve())
        if key in _kiwi_dll_dirs_added:
            continue
        try:
            os.add_dll_directory(key)
            _kiwi_dll_dirs_added.add(key)
        except OSError:
            pass


def _kiwi_native_readable(site: Path) -> bool:
    pyd = site / "_kiwipiepy.pyd"
    if not pyd.is_file():
        return True
    try:
        with open(pyd, "rb") as fh:
            fh.read(1)
        return True
    except OSError:
        return False


def _prepare_kiwi_runtime() -> Path:
    activate_runtime_site_packages(TOOL_AUTO_SUBTITLE)
    ensure_runtime_tree_acl(TOOL_AUTO_SUBTITLE)
    site = runtime_site_packages_dir(TOOL_AUTO_SUBTITLE)
    _repair_kiwipiepy_native_acl(site)
    _prepend_kiwi_dll_search_path(site)
    return site


def _ensure_kiwipiepy() -> None:
    if not tool_has_module(TOOL_AUTO_SUBTITLE, "kiwipiepy"):
        raise RuntimeError(
            "kiwipiepy가 설치되어 있지 않습니다. Auto Subtitle 환경 준비(Prepare)를 먼저 실행해 주세요."
        )


def _get_kiwi() -> Any:
    global _kiwi_instance
    _ensure_kiwipiepy()
    if _kiwi_instance is None:
        site = _prepare_kiwi_runtime()
        if not _kiwi_native_readable(site):
            raise RuntimeError(
                "kiwipiepy 네이티브 모듈(_kiwipiepy.pyd)에 접근할 수 없습니다. "
                "관리자 권한으로 설치된 패키지 권한 문제일 수 있습니다. "
                "환경 준비(Prepare)를 다시 실행하거나 에이전트를 재시작해 주세요."
            )
        try:
            from kiwipiepy import Kiwi

            _kiwi_instance = Kiwi()
        except (ImportError, OSError) as exc:
            _repair_kiwipiepy_native_acl(site)
            _prepend_kiwi_dll_search_path(site)
            try:
                from kiwipiepy import Kiwi

                _kiwi_instance = Kiwi()
            except (ImportError, OSError) as retry_exc:
                raise RuntimeError(
                    "Kiwi(kiwipiepy) 엔진을 불러올 수 없습니다. "
                    "환경 준비(Prepare)를 다시 실행한 뒤 에이전트를 재시작해 주세요. "
                    f"({retry_exc or exc})"
                ) from retry_exc
    return _kiwi_instance


def _scrub_piece(text: str) -> str:
    t = str(text or "").strip()
    if not t or t == "--":
        return ""
    return re.sub(r"\s+", "", t)


def _is_skipped_word(w: dict[str, Any]) -> bool:
    if w.get("is_deleted") or w.get("isDeleted"):
        return True
    if w.get("is_silence") or w.get("isSilence"):
        return True
    if _scrub_piece(str(w.get("word") or w.get("text") or "")) == "":
        return True
    return False


def _chip_display_piece(w: dict[str, Any]) -> str:
    raw = str(w.get("word") or w.get("text") or "")
    t = raw.strip()
    if not t or t == "--":
        return ""
    return t


def _visible_storage_indices(words: list[dict[str, Any]]) -> list[int]:
    return [i for i, w in enumerate(words) if not _is_skipped_word(w)]


def _segment_display_len(words: list[dict[str, Any]], vis_indices: list[int], start_pos: int, end_pos: int) -> int:
    """vis_indices[start_pos:end_pos+1] 구간의 표시 길이(칩 사이 공백 1)."""
    total = 0
    first = True
    for pos in range(start_pos, end_pos + 1):
        wi = vis_indices[pos]
        piece = _chip_display_piece(words[wi])
        if not piece:
            continue
        total += len(piece) + (0 if first else 1)
        first = False
    return total


def _morph_breakable_at_word(word_text: str) -> bool:
    text = _scrub_piece(word_text)
    if not text:
        return False
    kiwi = _get_kiwi()
    analyzed = kiwi.analyze(text)
    if not analyzed:
        return False
    for token in reversed(analyzed):
        form = str(token[0] or "").strip()
        tag = str(token[1] or "").strip()
        if not form:
            continue
        if tag in _MORPH_BREAK_TAGS:
            return True
        if tag.startswith("J") or tag.startswith("E"):
            return True
        return False
    return False


def compute_break_after_storage_indices(
    words: list[dict[str, Any]],
    *,
    min_chars: int = DEFAULT_MIN_CHARS,
    max_chars: int = DEFAULT_MAX_CHARS,
) -> list[int]:
    """
    단어 칩 storage index 기준 '이 인덱스까지 한 줄' break_after 목록.
    칩 내부 문자는 분할하지 않음.
    """
    if not words:
        return []
    min_c = max(4, int(min_chars))
    max_c = max(min_c + 1, int(max_chars))

    vis = _visible_storage_indices(words)
    if len(vis) <= 1:
        return []

    breaks: list[int] = []
    line_start_pos = 0

    for pos in range(len(vis)):
        line_len = _segment_display_len(words, vis, line_start_pos, pos)
        if line_len < min_c and pos < len(vis) - 1:
            continue

        wi = vis[pos]
        piece = _chip_display_piece(words[wi])
        morph_ok = _morph_breakable_at_word(piece) if piece else False
        force = line_len >= max_c
        is_last = pos == len(vis) - 1

        if not is_last and (force or (line_len >= min_c and morph_ok)):
            breaks.append(wi)
            line_start_pos = pos + 1

    return breaks


def align_words_breakpoints(
    words: list[dict[str, Any]],
    *,
    min_chars: int = DEFAULT_MIN_CHARS,
    max_chars: int = DEFAULT_MAX_CHARS,
) -> dict[str, Any]:
    breaks = compute_break_after_storage_indices(
        words, min_chars=min_chars, max_chars=max_chars
    )
    return {
        "break_after_storage_indices": breaks,
        "line_count": len(breaks) + 1 if breaks else (1 if _visible_storage_indices(words) else 0),
    }
