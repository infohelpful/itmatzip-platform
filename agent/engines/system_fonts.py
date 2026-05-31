"""OS에 설치된 글꼴 패밀리 목록."""

from __future__ import annotations

import re
import subprocess
import sys

_FONT_SUFFIX_RE = re.compile(
    r"\s+(Bold Italic|Bold|Italic|Regular|Light|Medium|SemiBold|Black|Thin|ExtraBold|Heavy)$",
    re.IGNORECASE,
)
_REGISTRY_TRAILER_RE = re.compile(r"\s+\((TrueType|OpenType|All res(?:olutions)?)\)$", re.IGNORECASE)

_FALLBACK_FONTS = (
    "Malgun Gothic",
    "맑은 고딕",
    "Apple SD Gothic Neo",
    "Noto Sans KR",
    "Nanum Gothic",
    "Arial",
    "Helvetica Neue",
    "sans-serif",
)


def _normalize_family_name(display: str) -> str:
    name = str(display or "").strip()
    if not name:
        return ""
    name = _REGISTRY_TRAILER_RE.sub("", name).strip()
    name = _FONT_SUFFIX_RE.sub("", name).strip()
    return name


def _list_windows_fonts() -> list[str]:
    import winreg

    families: set[str] = set()
    keys = (
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"),
    )
    for hive, subkey in keys:
        try:
            with winreg.OpenKey(hive, subkey) as key:
                index = 0
                while True:
                    try:
                        display, _, _ = winreg.EnumValue(key, index)
                        index += 1
                    except OSError:
                        break
                    family = _normalize_family_name(display)
                    if family:
                        families.add(family)
        except OSError:
            continue
    return sorted(families, key=str.casefold)


def _list_fc_match_fonts() -> list[str]:
    try:
        proc = subprocess.run(
            ["fc-list", "--format=%{family}\n"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (FileNotFoundError, OSError, subprocess.SubprocessError):
        return []
    if proc.returncode != 0:
        return []
    families: set[str] = set()
    for line in proc.stdout.splitlines():
        chunk = line.split(",", 1)[0].strip()
        if chunk:
            families.add(chunk)
    return sorted(families, key=str.casefold)


def list_installed_font_families() -> list[str]:
    """설치된 글꼴 패밀리 이름 (정렬·중복 제거)."""
    if sys.platform == "win32":
        fonts = _list_windows_fonts()
    elif sys.platform == "darwin":
        fonts = _list_fc_match_fonts()
    else:
        fonts = _list_fc_match_fonts()

    if not fonts:
        fonts = list(_FALLBACK_FONTS)

    merged: list[str] = []
    seen: set[str] = set()
    for name in fonts:
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        merged.append(name)

    try:
        from engines import custom_fonts

        custom_fonts.register_all_custom_fonts()
        for name in custom_fonts.list_custom_font_families():
            key = name.casefold()
            if key in seen:
                continue
            seen.add(key)
            merged.append(name)
    except Exception:
        pass

    if not merged:
        return list(_FALLBACK_FONTS)
    return sorted(merged, key=str.casefold)
