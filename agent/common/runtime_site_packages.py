"""MSI(Program Files) engine 은 일반 사용자에게 쓰기 불가 — 런타임 pip 대상을 %APPDATA% 로 분리."""

from __future__ import annotations

import importlib.util
import os
import shutil
import sys
import sysconfig
from pathlib import Path


def runtime_site_packages_dir() -> Path:
    base = (
        Path(os.environ.get("APPDATA", Path.home() / ".itmatzip"))
        / "ItMatZip"
        / "engine-runtime"
    )
    site = base / "Lib" / "site-packages"
    site.mkdir(parents=True, exist_ok=True)
    return site


def engine_site_packages_dir() -> Path:
    try:
        return Path(sysconfig.get_paths()["purelib"]).resolve()
    except Exception:
        return Path(sys.executable).resolve().parent / "Lib" / "site-packages"


def _is_program_files_path(path: Path) -> bool:
    resolved = path.resolve()
    for key in ("ProgramFiles", "ProgramFiles(x86)"):
        root = os.environ.get(key, "").strip()
        if not root:
            continue
        try:
            base = Path(root).resolve()
            if resolved == base or base in resolved.parents:
                return True
        except OSError:
            continue
    return False


def engine_site_packages_writable() -> bool:
    site = engine_site_packages_dir()
    if not site.is_dir():
        return True
    probe = site / ".itz_write_probe"
    try:
        probe.write_text("1", encoding="ascii")
        probe.unlink(missing_ok=True)
        return True
    except OSError:
        return False


def use_runtime_site_packages() -> bool:
    """Program Files MSI 또는 engine site-packages 비쓰기 시 %APPDATA% 대상 사용."""
    override = os.environ.get("ITMATZIP_RUNTIME_SITE_PACKAGES", "").strip().lower()
    if override in ("0", "false", "no"):
        return False
    if override in ("1", "true", "yes"):
        return True
    install = os.environ.get("ITMATZIP_AGENT_INSTALL_ROOT", "").strip()
    if install and _is_program_files_path(Path(install)):
        return True
    return not engine_site_packages_writable()


def activate_runtime_site_packages() -> None:
    if not use_runtime_site_packages():
        return
    path = str(runtime_site_packages_dir())
    if path not in sys.path:
        sys.path.insert(0, path)


def engine_python_c_prefix() -> str:
    """Embeddable Python 은 PYTHONPATH 를 무시하는 경우가 있어 -c 스크립트 앞에 붙입니다."""
    if not use_runtime_site_packages():
        return ""
    path = str(runtime_site_packages_dir())
    return (
        f"import sys; _rt={path!r}; "
        "sys.path.insert(0, _rt) if _rt not in sys.path else None; "
    )


def verify_importable(*module_names: str) -> None:
    """pip --target 설치 직후, 현재 프로세스에서 import 가능한지 확인."""
    activate_runtime_site_packages()
    missing: list[str] = []
    for name in module_names:
        if importlib.util.find_spec(name) is None:
            missing.append(name)
    if missing:
        site = runtime_site_packages_dir() if use_runtime_site_packages() else engine_site_packages_dir()
        raise RuntimeError(
            f"{', '.join(missing)} import 실패 — runtime site-packages: {site}"
        )


def runtime_pythonpath_entry() -> str:
    if not use_runtime_site_packages():
        return ""
    return str(runtime_site_packages_dir())


def prepend_runtime_pythonpath(env: dict[str, str]) -> None:
    entry = runtime_pythonpath_entry()
    if not entry:
        return
    parts = [p for p in env.get("PYTHONPATH", "").split(os.pathsep) if p]
    if entry in parts:
        return
    env["PYTHONPATH"] = entry if not parts else f"{entry}{os.pathsep}{os.pathsep.join(parts)}"


def pip_target_args() -> list[str]:
    if not use_runtime_site_packages():
        return []
    return [
        "--target",
        str(runtime_site_packages_dir()),
        "--no-warn-script-location",
    ]


def pip_install_cmd(*, upgrade: bool = False, force_reinstall: bool = False) -> list[str]:
    cmd = [sys.executable, "-m", "pip", "install"]
    if upgrade:
        cmd.append("--upgrade")
    if force_reinstall:
        cmd.append("--force-reinstall")
    cmd.extend(pip_target_args())
    return cmd


def purge_runtime_site_entries(*prefixes: str) -> None:
    """--target 설치분 제거 (pip uninstall 은 target 을 지원하지 않음)."""
    site = runtime_site_packages_dir()
    if not site.is_dir():
        return
    lowered = tuple(p.lower() for p in prefixes)
    for entry in list(site.iterdir()):
        name = entry.name.lower()
        if not any(name == p or name.startswith(f"{p}-") or name.startswith(f"{p}.") for p in lowered):
            continue
        if entry.is_dir():
            shutil.rmtree(entry, ignore_errors=True)
        else:
            try:
                entry.unlink(missing_ok=True)
            except OSError:
                pass
