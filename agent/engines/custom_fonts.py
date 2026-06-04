"""Auto Subtitle — 사용자 글꼴(ProgramData/Font) 설치·목록·등록."""

from __future__ import annotations

import json
import os
import re
import shutil
import struct
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any

ALLOWED_FONT_SUFFIXES = {".ttf", ".otf", ".ttc"}
_MANIFEST_NAME = "manifest.json"
_REGISTERED: set[str] = set()


def _agent_data_root() -> Path:
    data = os.environ.get("ITMATZIP_AGENT_DATA", "").strip()
    if data:
        return Path(data)
    program_data = os.environ.get("ProgramData", r"C:\ProgramData").strip()
    if program_data:
        return Path(program_data) / "Itmatzip"
    appdata = os.environ.get("APPDATA", "").strip()
    if appdata:
        return Path(appdata) / "ItMatZip"
    return Path.home() / ".itmatzip"


def _legacy_program_data_font_dir() -> Path | None:
    program_data = os.environ.get("ProgramData", r"C:\ProgramData").strip()
    if not program_data:
        return None
    return Path(program_data) / "Itmatzip" / "Font"


def _dir_is_writable(fonts_dir: Path) -> bool:
    try:
        fonts_dir.mkdir(parents=True, exist_ok=True)
        probe = fonts_dir / ".write_probe"
        probe.write_bytes(b"1")
        probe.unlink(missing_ok=True)
        return True
    except OSError:
        return False


def get_fonts_dir() -> Path:
    """에이전트 데이터 `Font` 우선 — 쓰기 가능한 첫 경로 (구버전 ProgramData 경로는 이전만)."""
    candidates: list[Path] = []
    data = os.environ.get("ITMATZIP_AGENT_DATA", "").strip()
    if data:
        candidates.append(Path(data) / "Font")
    legacy = _legacy_program_data_font_dir()
    if legacy is not None:
        candidates.append(legacy)
    candidates.append(_agent_data_root() / "Font")

    chosen: Path | None = None
    for path in candidates:
        if _dir_is_writable(path):
            chosen = path.resolve()
            break
    if chosen is None:
        chosen = (candidates[0] if candidates else Path("Font")).resolve()
        chosen.mkdir(parents=True, exist_ok=True)

    _migrate_legacy_fonts_if_needed(chosen)
    return chosen


def _migrate_legacy_fonts_if_needed(primary: Path) -> None:
    legacy = _legacy_program_data_font_dir()
    if legacy is None or not legacy.is_dir():
        return
    try:
        if legacy.resolve() == primary.resolve():
            return
    except OSError:
        return

    legacy_manifest = legacy / _MANIFEST_NAME
    if not legacy_manifest.is_file():
        return

    try:
        raw = json.loads(legacy_manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    items = raw.get("fonts") if isinstance(raw, dict) else raw
    if not isinstance(items, list) or not items:
        return

    primary.mkdir(parents=True, exist_ok=True)
    merged = _load_manifest_from_dir(primary)
    known_files = {str(x.get("file_name") or "") for x in merged}
    changed = False

    for item in items:
        if not isinstance(item, dict):
            continue
        file_name = str(item.get("file_name") or "").strip()
        if not file_name or file_name in known_files:
            continue
        src = legacy / file_name
        if not src.is_file():
            continue
        dest = primary / file_name
        if dest.is_file():
            known_files.add(file_name)
            continue
        try:
            shutil.copy2(src, dest)
        except OSError:
            continue
        merged.append(
            {
                "id": str(item.get("id") or file_name),
                "family": str(item.get("family") or "").strip() or file_name,
                "file_name": file_name,
                "installed_at": str(item.get("installed_at") or ""),
            }
        )
        known_files.add(file_name)
        changed = True
        try:
            _register_font_windows(dest)
        except (OSError, RuntimeError):
            pass

    if changed:
        _save_manifest_to_dir(primary, merged)


def _manifest_path_for(fonts_dir: Path) -> Path:
    return fonts_dir / _MANIFEST_NAME


def _manifest_path() -> Path:
    return _manifest_path_for(get_fonts_dir())


def _load_manifest_from_dir(fonts_dir: Path) -> list[dict[str, Any]]:
    path = _manifest_path_for(fonts_dir)
    if not path.is_file():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    items = raw.get("fonts") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        return []
    out: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        family = str(item.get("family") or "").strip()
        file_name = str(item.get("file_name") or "").strip()
        if not family or not file_name:
            continue
        out.append(
            {
                "id": str(item.get("id") or file_name),
                "family": family,
                "file_name": file_name,
                "installed_at": str(item.get("installed_at") or ""),
            }
        )
    return out


def _load_manifest() -> list[dict[str, Any]]:
    return _load_manifest_from_dir(get_fonts_dir())


def _save_manifest_to_dir(fonts_dir: Path, items: list[dict[str, Any]]) -> None:
    payload = {"fonts": items}
    _manifest_path_for(fonts_dir).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _save_manifest(items: list[dict[str, Any]]) -> None:
    _save_manifest_to_dir(get_fonts_dir(), items)


def _safe_file_name(name: str) -> str:
    base = Path(str(name or "")).name
    base = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", base).strip()
    if not base:
        base = "font.ttf"
    suffix = Path(base).suffix.lower()
    if suffix not in ALLOWED_FONT_SUFFIXES:
        base = f"{Path(base).stem or 'font'}.ttf"
    return base


def _decode_name_bytes(raw: bytes, platform_id: int, encoding_id: int) -> str:
    if not raw:
        return ""
    if platform_id == 3 and encoding_id in (1, 10):
        try:
            return raw.decode("utf-16-be").strip("\x00").strip()
        except UnicodeDecodeError:
            pass
    if platform_id == 1 and encoding_id in (0, 1, 2, 3, 4, 5):
        for enc in ("mac_roman", "latin-1"):
            try:
                return raw.decode(enc, errors="ignore").strip("\x00").strip()
            except LookupError:
                continue
    try:
        return raw.decode("utf-8", errors="ignore").strip("\x00").strip()
    except UnicodeDecodeError:
        return ""


def _read_name_table(data: bytes, offset: int) -> dict[int, str]:
    if offset + 6 > len(data):
        return {}
    count = int.from_bytes(data[offset + 2 : offset + 4], "big")
    string_offset = int.from_bytes(data[offset + 4 : offset + 6], "big")
    names: dict[int, list[tuple[int, str]]] = {}
    record_base = offset + 6
    for i in range(count):
        rec = record_base + i * 12
        if rec + 12 > len(data):
            break
        platform_id, encoding_id, _lang_id, name_id, length, rel_off = struct.unpack(">HHHHHH", data[rec : rec + 12])
        start = offset + string_offset + rel_off
        end = start + length
        if end > len(data):
            continue
        text = _decode_name_bytes(data[start:end], platform_id, encoding_id)
        if not text:
            continue
        names.setdefault(name_id, []).append((platform_id, text))
    picked: dict[int, str] = {}
    for name_id, entries in names.items():
        preferred = sorted(entries, key=lambda item: (0 if item[0] == 3 else 1, item[0]))
        picked[name_id] = preferred[0][1]
    return picked


def _sfnt_table_offset(data: bytes, tag: bytes) -> int | None:
    if len(data) < 12:
        return None
    if data[:4] == b"ttcf":
        if len(data) < 16:
            return None
        offset = struct.unpack(">I", data[12:16])[0]
        return _sfnt_table_offset(data[offset:], tag)
    num_tables = int.from_bytes(data[4:6], "big")
    for i in range(num_tables):
        base = 12 + i * 16
        if base + 16 > len(data):
            break
        if data[base : base + 4] != tag:
            continue
        return int.from_bytes(data[base + 8 : base + 12], "big")
    return None


def read_font_family_name(path: Path) -> str:
    try:
        data = path.read_bytes()
    except OSError:
        return path.stem
    name_off = _sfnt_table_offset(data, b"name")
    if name_off is None:
        return path.stem
    names = _read_name_table(data, name_off)
    for key in (16, 1):
        value = str(names.get(key) or "").strip()
        if value:
            return value
    return path.stem


def _unique_dest_name(fonts_dir: Path, preferred: str) -> str:
    safe = _safe_file_name(preferred)
    candidate = fonts_dir / safe
    if not candidate.exists():
        return safe
    stem = Path(safe).stem
    suffix = Path(safe).suffix
    for i in range(2, 1000):
        alt = f"{stem}-{i}{suffix}"
        if not (fonts_dir / alt).exists():
            return alt
    return f"{stem}-{int(time.time())}{suffix}"


def _unique_family_name(existing: set[str], preferred: str) -> str:
    base = str(preferred or "Custom Font").strip() or "Custom Font"
    if base.casefold() not in existing:
        return base
    for i in range(2, 1000):
        alt = f"{base} ({i})"
        if alt.casefold() not in existing:
            return alt
    return f"{base} ({int(time.time())})"


def _register_font_windows(path: Path) -> None:
    if sys.platform != "win32":
        return
    key = str(path.resolve()).casefold()
    if key in _REGISTERED:
        return
    import ctypes

    added = ctypes.windll.gdi32.AddFontResourceW(str(path.resolve()))
    if added <= 0 and key not in _REGISTERED:
        raise RuntimeError(
            f"Windows 글꼴 등록 실패: {path.name} (관리자 권한·손상된 파일·이미 등록된 글꼴 여부 확인)"
        )
    _REGISTERED.add(key)
    HWND_BROADCAST = 0xFFFF
    WM_FONTCHANGE = 0x001D
    ctypes.windll.user32.SendMessageW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0)


def register_all_custom_fonts() -> None:
    fonts_dir = get_fonts_dir()
    for item in _load_manifest():
        file_name = str(item.get("file_name") or "").strip()
        if not file_name:
            continue
        path = fonts_dir / file_name
        if not path.is_file():
            continue
        try:
            _register_font_windows(path)
        except OSError:
            continue


def list_custom_fonts() -> list[dict[str, Any]]:
    fonts_dir = get_fonts_dir()
    items = _load_manifest()
    out: list[dict[str, Any]] = []
    for item in items:
        file_name = str(item.get("file_name") or "").strip()
        family = str(item.get("family") or "").strip()
        if not file_name or not family:
            continue
        if not (fonts_dir / file_name).is_file():
            continue
        out.append(
            {
                "id": str(item.get("id") or file_name),
                "family": family,
                "file_name": file_name,
                "url": f"/api/tools/auto-subtitle/custom-fonts/file/{file_name}",
            }
        )
    return out


def list_custom_font_families() -> list[str]:
    families: list[str] = []
    seen: set[str] = set()
    for item in list_custom_fonts():
        family = str(item.get("family") or "").strip()
        key = family.casefold()
        if not family or key in seen:
            continue
        seen.add(key)
        families.append(family)
    return sorted(families, key=str.casefold)


def resolve_custom_font_file(file_name: str) -> Path:
    safe = _safe_file_name(file_name)
    path = (get_fonts_dir() / safe).resolve()
    fonts_dir = get_fonts_dir().resolve()
    if fonts_dir not in path.parents and path != fonts_dir:
        raise ValueError("invalid font path")
    if not path.is_file():
        raise FileNotFoundError(safe)
    return path


def install_custom_font_from_path(source_path: str) -> dict[str, Any]:
    src = Path(str(source_path or "").strip())
    if not src.is_file():
        raise FileNotFoundError(f"글꼴 파일을 찾을 수 없습니다: {src}")
    suffix = src.suffix.lower()
    if suffix not in ALLOWED_FONT_SUFFIXES:
        allowed = ", ".join(sorted(ALLOWED_FONT_SUFFIXES))
        raise ValueError(f"지원하지 않는 글꼴 형식입니다. ({allowed})")

    fonts_dir = get_fonts_dir()
    family_hint = read_font_family_name(src)
    manifest = _load_manifest()
    existing_families = {str(x.get("family") or "").casefold() for x in manifest}
    family = _unique_family_name(existing_families, family_hint)

    dest_name = _unique_dest_name(fonts_dir, src.name)
    dest = fonts_dir / dest_name
    shutil.copy2(src, dest)

    try:
        _register_font_windows(dest)
    except Exception as exc:
        dest.unlink(missing_ok=True)
        raise RuntimeError(str(exc)) from exc

    entry = {
        "id": unicodedata.normalize("NFKD", dest_name).encode("ascii", "ignore").decode("ascii") or dest_name,
        "family": family,
        "file_name": dest_name,
        "installed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    manifest = [x for x in manifest if str(x.get("file_name") or "") != dest_name]
    manifest.append(entry)
    _save_manifest(manifest)

    return {
        "ok": True,
        "family": family,
        "file_name": dest_name,
        "fonts_dir": str(fonts_dir),
        "custom_fonts": list_custom_fonts(),
    }
