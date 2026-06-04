"""MSI(Program Files) engine 은 일반 사용자에게 쓰기 불가 — 툴별 %APPDATA% runtime pip 대상."""

from __future__ import annotations

import importlib.util
import os
import shutil
import sys
import sysconfig
from pathlib import Path

TOOL_SILENCE_REMOVER = "silence-remover"
TOOL_VOCAL_REMOVER = "vocal-remover"
TOOL_AUTO_SUBTITLE = "auto-subtitle"
TOOL_IMAGE_ENHANCER = "image-enhancer"
TOOL_CREATE_MUSIC = "create-music"

# MSI embeddable Python(3.14) — pip --target per tool
ENGINE_RUNTIME_TOOL_IDS: tuple[str, ...] = (
    TOOL_SILENCE_REMOVER,
    TOOL_VOCAL_REMOVER,
    TOOL_AUTO_SUBTITLE,
)

# Python 3.12 dedicated venv per tool (CodeFormer / ACE-Step)
VENV_RUNTIME_TOOL_IDS: tuple[str, ...] = (
    TOOL_IMAGE_ENHANCER,
    TOOL_CREATE_MUSIC,
)

ALL_RUNTIME_TOOL_IDS: tuple[str, ...] = ENGINE_RUNTIME_TOOL_IDS + VENV_RUNTIME_TOOL_IDS

_RUNTIME_ROOT_NAME = "engine-runtime"
_SITE_REL = Path("Lib") / "site-packages"
_DEFAULT_DATA_ROOT = Path(r"C:\ProgramData\itmatzip-agent")


def _appdata_root() -> Path:
    return Path(os.environ.get("APPDATA", Path.home() / ".itmatzip")) / "ItMatZip"


def _resolve_tool_id(tool_id: str | None = None) -> str:
    tid = (tool_id or os.environ.get("ITMATZIP_RUNTIME_TOOL", "")).strip()
    if not tid:
        raise ValueError(
            "runtime tool_id 가 필요합니다 (예: silence-remover, vocal-remover, auto-subtitle)"
        )
    return tid


def agent_data_root() -> Path:
    data = os.environ.get("ITMATZIP_AGENT_DATA", "").strip()
    if data:
        return Path(data)
    override = os.environ.get("ITMATZIP_DATA_ROOT", "").strip()
    if override:
        return Path(override)
    return _DEFAULT_DATA_ROOT


def tool_venv_data_root(tool_id: str) -> Path:
    """Python 3.12 venv 런타임 데이터 루트 (engine-runtime 과 분리)."""
    tid = _resolve_tool_id(tool_id)
    if tid == TOOL_IMAGE_ENHANCER:
        return _appdata_root() / TOOL_IMAGE_ENHANCER
    if tid == TOOL_CREATE_MUSIC:
        return agent_data_root() / TOOL_CREATE_MUSIC
    raise ValueError(f"venv runtime tool_id 가 아닙니다: {tid}")


def runtime_site_packages_dir(tool_id: str) -> Path:
    """툴별 pip --target 경로 (공유 금지)."""
    tid = _resolve_tool_id(tool_id)
    site = _appdata_root() / _RUNTIME_ROOT_NAME / tid / _SITE_REL
    site.mkdir(parents=True, exist_ok=True)
    return site


def ensure_runtime_directories() -> None:
    """모든 툴 runtime 디렉터리를 미리 생성 (MSI·첫 prepare 전)."""
    for tid in ENGINE_RUNTIME_TOOL_IDS:
        runtime_site_packages_dir(tid)
    for tid in VENV_RUNTIME_TOOL_IDS:
        root = tool_venv_data_root(tid)
        root.mkdir(parents=True, exist_ok=True)
        if tid == TOOL_IMAGE_ENHANCER:
            (root / ".venv-codeformer").mkdir(parents=True, exist_ok=True)
        elif tid == TOOL_CREATE_MUSIC:
            (root / ".venv-acestep").mkdir(parents=True, exist_ok=True)


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


def activate_runtime_site_packages(tool_id: str) -> None:
    if not use_runtime_site_packages():
        return
    path = str(runtime_site_packages_dir(tool_id))
    if path in sys.path:
        sys.path.remove(path)
    sys.path.insert(0, path)


def tool_has_module(tool_id: str, module_name: str) -> bool:
    """해당 툴 runtime 에만 설치된 모듈인지 확인 (다른 툴·engine 과 혼동 방지)."""
    if not use_runtime_site_packages():
        return importlib.util.find_spec(module_name) is not None
    site = runtime_site_packages_dir(tool_id).resolve()
    spec = importlib.util.find_spec(module_name)
    if spec is None or not spec.origin or spec.origin == "namespace":
        pkg_dir = site / module_name.replace(".", os.sep)
        if pkg_dir.is_dir():
            return True
        return any(site.glob(f"{module_name.replace('_', '-')}*.dist-info"))
    try:
        return Path(spec.origin).resolve().is_relative_to(site)
    except ValueError:
        return str(site).lower() in str(spec.origin).lower()


def engine_python_c_prefix(tool_id: str) -> str:
    """Embeddable Python 은 PYTHONPATH 를 무시하는 경우가 있어 -c 스크립트 앞에 붙입니다."""
    if not use_runtime_site_packages():
        return ""
    path = str(runtime_site_packages_dir(tool_id))
    return (
        f"import sys; _rt={path!r}; "
        "sys.path.insert(0, _rt) if _rt not in sys.path else None; "
    )


def verify_importable(tool_id: str, *module_names: str) -> None:
    """pip --target 설치 직후, 해당 툴 runtime 에서 import 가능한지 확인."""
    activate_runtime_site_packages(tool_id)
    missing = [name for name in module_names if not tool_has_module(tool_id, name)]
    if missing:
        raise RuntimeError(
            f"{', '.join(missing)} import 실패 — runtime site-packages: "
            f"{runtime_site_packages_dir(tool_id)}"
        )


def runtime_pythonpath_entry(tool_id: str | None = None) -> str:
    if not use_runtime_site_packages():
        return ""
    tid = (tool_id or os.environ.get("ITMATZIP_RUNTIME_TOOL", "")).strip()
    if not tid:
        return ""
    return str(runtime_site_packages_dir(tid))


def prepend_runtime_pythonpath(env: dict[str, str]) -> None:
    entry = runtime_pythonpath_entry(env.get("ITMATZIP_RUNTIME_TOOL", "").strip() or None)
    if not entry:
        return
    parts = [p for p in env.get("PYTHONPATH", "").split(os.pathsep) if p]
    if entry in parts:
        return
    env["PYTHONPATH"] = entry if not parts else f"{entry}{os.pathsep}{os.pathsep.join(parts)}"


def pip_target_args(tool_id: str) -> list[str]:
    if not use_runtime_site_packages():
        return []
    return [
        "--target",
        str(runtime_site_packages_dir(tool_id)),
        "--no-warn-script-location",
    ]


def pip_install_cmd(
    tool_id: str,
    *,
    upgrade: bool = False,
    force_reinstall: bool = False,
) -> list[str]:
    cmd = [sys.executable, "-m", "pip", "install"]
    if upgrade:
        cmd.append("--upgrade")
    if force_reinstall:
        cmd.append("--force-reinstall")
    cmd.extend(pip_target_args(tool_id))
    return cmd


def purge_runtime_site_entries(tool_id: str, *prefixes: str) -> None:
    """--target 설치분 제거 (pip uninstall 은 target 을 지원하지 않음)."""
    site = runtime_site_packages_dir(tool_id)
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
