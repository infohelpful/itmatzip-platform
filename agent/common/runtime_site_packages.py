"""MSI(Program Files) engine 은 일반 사용자에게 쓰기 불가 — 툴별 %APPDATA% runtime pip 대상."""

from __future__ import annotations

import importlib
import importlib.util
import logging
import os
import shutil
import subprocess
import sys
import sysconfig
from pathlib import Path

_log = logging.getLogger(__name__)

# Users (BUILTIN\Users)
_WIN_USERS_SID = "*S-1-5-32-545"

TOOL_SILENCE_REMOVER = "silence-remover"
TOOL_VOCAL_REMOVER = "vocal-remover"
TOOL_AUTO_SUBTITLE = "auto-subtitle"
TOOL_IMAGE_ENHANCER = "image-enhancer"
TOOL_CREATE_MUSIC = "create-music"
TOOL_BACKGROUND_REMOVER = "background-remover"

# MSI embeddable Python(3.12) — pip --target per tool
ENGINE_RUNTIME_TOOL_IDS: tuple[str, ...] = (
    TOOL_SILENCE_REMOVER,
    TOOL_VOCAL_REMOVER,
    TOOL_AUTO_SUBTITLE,
    TOOL_IMAGE_ENHANCER,
    TOOL_CREATE_MUSIC,
    TOOL_BACKGROUND_REMOVER,
)

# Dedicated venv per tool — same 3.12 major, isolated env.
# 현재 사용하는 툴 없음. venv 가 필요한 툴을 추가하면 여기에 등록한다.
VENV_RUNTIME_TOOL_IDS: tuple[str, ...] = ()

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
    """Python 3.12 venv 런타임 데이터 루트 (engine-runtime 과 분리).

    venv 자체의 디렉터리 이름은 툴의 runtime 모듈이 정한다.
    """
    tid = _resolve_tool_id(tool_id)
    if tid not in VENV_RUNTIME_TOOL_IDS:
        raise ValueError(f"venv runtime tool_id 가 아닙니다: {tid}")
    return _appdata_root() / tid


def create_music_data_root() -> Path:
    """Create Music 데이터(소스·캐시·체크포인트) — packages는 engine-runtime."""
    return agent_data_root() / TOOL_CREATE_MUSIC


def runtime_site_packages_dir(tool_id: str) -> Path:
    """툴별 pip --target 경로 (공유 금지)."""
    tid = _resolve_tool_id(tool_id)
    site = _appdata_root() / _RUNTIME_ROOT_NAME / tid / _SITE_REL
    site.mkdir(parents=True, exist_ok=True)
    return site


def _runtime_tool_root(tool_id: str) -> Path:
    return _appdata_root() / _RUNTIME_ROOT_NAME / _resolve_tool_id(tool_id)


def _is_windows_admin() -> bool:
    if os.name != "nt":
        return False
    try:
        import ctypes

        return bool(ctypes.windll.shell32.IsUserAnAdmin())  # type: ignore[attr-defined]
    except Exception:
        return False


def _console_account_for_acl() -> str | None:
    """로그온 사용자(도메인\\user). 관리자 권한 pip 후 소유권 복구에 사용."""
    if os.name != "nt":
        return None
    try:
        from common.subprocess_util import no_window_creationflags

        out = subprocess.check_output(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_ComputerSystem).UserName",
            ],
            stderr=subprocess.DEVNULL,
            timeout=20,
            creationflags=no_window_creationflags(),
        )
        account = out.decode("utf-8", errors="replace").strip()
        return account if account and "\\" in account else None
    except Exception:
        user = os.environ.get("USERNAME", "").strip()
        domain = os.environ.get("USERDOMAIN", "").strip()
        if user and domain and domain.upper() not in ("", "NT AUTHORITY", "NT SERVICE"):
            return f"{domain}\\{user}"
        return user or None


def _run_icacls(args: list[str]) -> bool:
    if os.name != "nt":
        return True
    try:
        from common.subprocess_util import no_window_creationflags

        proc = subprocess.run(
            ["icacls", *args],
            capture_output=True,
            text=True,
            timeout=300,
            creationflags=no_window_creationflags(),
        )
        if proc.returncode != 0:
            tail = (proc.stderr or proc.stdout or "")[-400:]
            _log.warning("icacls %s failed (%s): %s", " ".join(args[:3]), proc.returncode, tail)
            return False
        return True
    except Exception as exc:
        _log.warning("icacls failed: %s", exc)
        return False


def ensure_runtime_tree_acl(tool_id: str) -> None:
    """
    engine-runtime 트리 ACL 정리.

    관리자 PowerShell·MSI deferred(SYSTEM)·개발 스크립트가 %APPDATA%에 pip 하면
    일반 사용자(트레이 에이전트)가 import 할 수 없습니다. pip 직후·에이전트 기동 시 호출합니다.
    """
    if os.name != "nt" or not use_runtime_site_packages():
        return
    tid = _resolve_tool_id(tool_id)
    tool_root = _runtime_tool_root(tid)
    site = tool_root / _SITE_REL
    if not tool_root.exists():
        return

    grants = [f"{_WIN_USERS_SID}:(OI)(CI)M"]
    account = _console_account_for_acl()
    if account:
        grants.append(f"{account}:(OI)(CI)F")

    if _is_windows_admin() and account:
        for target in (tool_root, site):
            if target.exists():
                _run_icacls([str(target), "/setowner", account, "/T", "/Q"])

    for target in (tool_root, site):
        if not target.exists():
            continue
        for grant in grants:
            _run_icacls([str(target), "/grant", grant, "/T", "/Q"])


def ensure_data_tree_acl(root: Path) -> None:
    """ProgramData\\itmatzip-agent\\auto-subtitle 등 — SYSTEM/관리자 생성 파일 쓰기 허용."""
    if os.name != "nt":
        return
    try:
        resolved = root.resolve()
    except OSError:
        return
    if not resolved.exists():
        return

    grants = [f"{_WIN_USERS_SID}:(OI)(CI)M"]
    account = _console_account_for_acl()
    if account:
        grants.append(f"{account}:(OI)(CI)F")

    if _is_windows_admin() and account:
        _run_icacls([str(resolved), "/setowner", account, "/T", "/Q"])

    for grant in grants:
        _run_icacls([str(resolved), "/grant", grant, "/T", "/Q"])


def runtime_site_packages_readable(tool_id: str) -> bool:
    """다른 계정/관리자 pip 로 깨진 ACL 조기 감지."""
    if not use_runtime_site_packages():
        return True
    site = _appdata_root() / _RUNTIME_ROOT_NAME / _resolve_tool_id(tool_id) / _SITE_REL
    if not site.is_dir():
        return True
    try:
        for entry in site.iterdir():
            if entry.is_file():
                with open(entry, "rb") as fh:
                    fh.read(1)
                return True
            if entry.is_dir():
                for child in entry.iterdir():
                    if child.is_file():
                        with open(child, "rb") as fh:
                            fh.read(1)
                        return True
        return True
    except OSError:
        return False


def ensure_runtime_directories() -> None:
    """모든 툴 runtime 디렉터리를 미리 생성 (MSI·첫 prepare 전)."""
    if _is_windows_admin():
        # 매 호출마다 로그하면 sidecar 로그가 도배되어 장애 진단이 어려움
        if not getattr(ensure_runtime_directories, "_admin_warned", False):
            ensure_runtime_directories._admin_warned = True  # type: ignore[attr-defined]
            _log.warning(
                "에이전트가 관리자 권한으로 실행 중입니다. "
                "%APPDATA%\\ItMatZip\\engine-runtime pip/ACL 이 꼬일 수 있으니 "
                "트레이는 일반 사용자로 실행하세요."
            )
    for tid in ENGINE_RUNTIME_TOOL_IDS:
        runtime_site_packages_dir(tid)
        if not runtime_site_packages_readable(tid):
            ensure_runtime_tree_acl(tid)
    # Image Enhancer / Background Remover / Create Music data — packages live in engine-runtime
    (_appdata_root() / TOOL_IMAGE_ENHANCER).mkdir(parents=True, exist_ok=True)
    (_appdata_root() / TOOL_BACKGROUND_REMOVER).mkdir(parents=True, exist_ok=True)
    create_music_data_root().mkdir(parents=True, exist_ok=True)
    for tid in VENV_RUNTIME_TOOL_IDS:
        tool_venv_data_root(tid).mkdir(parents=True, exist_ok=True)


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
    if not _uses_runtime_site_packages(tool_id):
        return
    if not runtime_site_packages_readable(tool_id):
        ensure_runtime_tree_acl(tool_id)
    path = str(runtime_site_packages_dir(tool_id))
    if path in sys.path:
        sys.path.remove(path)
    sys.path.insert(0, path)


def _runtime_site_has_package_tree(site: Path, module_name: str) -> bool:
    """find_spec 이 engine·다른 경로를 가리켜도 runtime site 실제 설치를 인정."""
    pkg_dir = site / module_name.replace(".", os.sep)
    if pkg_dir.is_dir():
        return True
    slug = module_name.replace("_", "-").lower()
    return any(
        p.is_dir() and slug in p.name.lower()
        for p in site.glob("*.dist-info")
    )


def assert_runtime_packages_on_disk(tool_id: str, *module_names: str) -> None:
    """pip 직후 import 프로브 없이 runtime site 에 패키지 트리·dist-info 존재만 확인."""
    site = runtime_site_packages_dir(tool_id).resolve()
    missing: list[str] = []
    for name in module_names:
        if not _runtime_site_has_package_tree(site, name):
            missing.append(name)
    if missing:
        raise RuntimeError(
            f"{', '.join(missing)} 패키지가 runtime에 없습니다 — site-packages: {site}"
        )


def tool_has_module(tool_id: str, module_name: str) -> bool:
    """해당 툴 runtime 에만 설치된 모듈인지 확인 (다른 툴·engine 과 혼동 방지)."""
    if not _uses_runtime_site_packages(tool_id):
        return importlib.util.find_spec(module_name) is not None
    activate_runtime_site_packages(tool_id)
    site = runtime_site_packages_dir(tool_id).resolve()
    if _runtime_site_has_package_tree(site, module_name):
        return True
    spec = importlib.util.find_spec(module_name)
    if spec is None or not spec.origin or spec.origin == "namespace":
        return False
    try:
        return Path(spec.origin).resolve().is_relative_to(site)
    except ValueError:
        return str(site).lower() in str(spec.origin).lower()


def _uses_runtime_site_packages(tool_id: str | None = None) -> bool:
    tid = (tool_id or os.environ.get("ITMATZIP_RUNTIME_TOOL", "")).strip()
    if tid in ENGINE_RUNTIME_TOOL_IDS:
        return True
    return use_runtime_site_packages()


def engine_python_c_prefix(tool_id: str) -> str:
    """Embeddable Python 은 PYTHONPATH 를 무시하는 경우가 있어 -c 스크립트 앞에 붙입니다."""
    if not _uses_runtime_site_packages(tool_id):
        return ""
    path = str(runtime_site_packages_dir(tool_id))
    return (
        f"import sys; _rt={path!r}; "
        "sys.path.insert(0, _rt) if _rt not in sys.path else None; "
    )


def probe_runtime_import(
    tool_id: str,
    import_name: str,
    smoke: tuple[str, ...] = (),
) -> bool:
    """별도 Python 프로세스에서 import 검증 (PyO3/numpy 이중 로드 방지)."""
    from common.subprocess_util import no_window_creationflags

    lines = [
        "import importlib",
        f"m = importlib.import_module({import_name!r})",
    ]
    if import_name == "numpy":
        lines.append("assert getattr(m, '__version__', None)")
    for sub in smoke:
        lines.append(f"importlib.import_module({sub!r})")
    script = engine_python_c_prefix(tool_id) + "\n".join(lines) + "\n"

    proc = subprocess.run(
        [sys.executable, "-c", script],
        env=pip_subprocess_env({"ITMATZIP_RUNTIME_TOOL": tool_id}),
        capture_output=True,
        creationflags=no_window_creationflags(),
    )
    return proc.returncode == 0


def verify_importable(
    tool_id: str,
    *module_names: str,
    smoke_by_module: dict[str, tuple[str, ...]] | None = None,
) -> None:
    """pip --target 설치 직후, 해당 툴 runtime 에서 import 가능한지 확인."""
    import time

    smoke_map = smoke_by_module or {}
    missing: list[str] = []
    for name in module_names:
        smoke = smoke_map.get(name, ())
        ok = False
        for attempt in range(3):
            if probe_runtime_import(tool_id, name, smoke):
                ok = True
                break
            if attempt < 2:
                time.sleep(0.4)
        if not ok:
            missing.append(name)
    if missing:
        raise RuntimeError(
            f"{', '.join(missing)} import 실패 — runtime site-packages: "
            f"{runtime_site_packages_dir(tool_id)}"
        )


def runtime_pythonpath_entry(tool_id: str | None = None) -> str:
    if not _uses_runtime_site_packages(tool_id):
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
    """툴별 runtime pip 는 항상 %APPDATA% --target (Program Files 쓰기 방지)."""
    if not _uses_runtime_site_packages(tool_id):
        return []
    return [
        "--target",
        str(runtime_site_packages_dir(tool_id)),
        "--no-warn-script-location",
    ]


def pip_cache_dir() -> Path:
    """pip wheel cache — %LOCALAPPDATA% 권한 이슈(관리자 pip) 회피."""
    cache = _appdata_root() / "pip-cache"
    cache.mkdir(parents=True, exist_ok=True)
    return cache


def pip_subprocess_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    from common.subprocess_util import agent_subprocess_env

    env = agent_subprocess_env(extra)
    env["PIP_CACHE_DIR"] = str(pip_cache_dir())
    return env


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
    cmd.append("--no-cache-dir")
    cmd.append("--prefer-binary")
    cmd.extend(pip_target_args(tool_id))
    return cmd


def runtime_pip_tool_id_from_command(cmd: list[str], env: dict[str, str] | None = None) -> str | None:
    """`pip install --target` + ITMATZIP_RUNTIME_TOOL 이면 툴 id 반환."""
    if len(cmd) < 4 or "-m" not in cmd or "pip" not in cmd:
        return None
    if "--target" not in cmd:
        return None
    merged = env if env is not None else os.environ
    tid = (merged.get("ITMATZIP_RUNTIME_TOOL") or "").strip()
    return tid if tid in ENGINE_RUNTIME_TOOL_IDS else None


def finalize_runtime_pip(tool_id: str) -> None:
    """pip subprocess 종료 직후 호출 (Popen 스트리밍 설치 포함)."""
    ensure_runtime_tree_acl(tool_id)


def run_runtime_pip(
    tool_id: str,
    *specs: str,
    upgrade: bool = False,
    force_reinstall: bool = False,
    timeout: float | None = 600,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """툴별 runtime pip + Windows ACL 정리 (모든 사이트·PC 공통)."""
    from common.runtime_site_packages import finalize_runtime_pip, pip_subprocess_env
    from common.subprocess_util import agent_subprocess_env, run_hidden

    ensure_runtime_tree_acl(tool_id)
    extra = {"ITMATZIP_RUNTIME_TOOL": tool_id}
    if env:
        extra.update(env)
    cmd = pip_install_cmd(tool_id, upgrade=upgrade, force_reinstall=force_reinstall)
    cmd.extend(specs)
    proc = run_hidden(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=pip_subprocess_env(extra),
    )
    finalize_runtime_pip(tool_id)
    return proc


def _rm_rf(path: Path) -> None:
    if not path.exists():
        return

    def _onerror(func, p, exc_info) -> None:  # noqa: ARG001
        import stat

        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass

    if path.is_dir():
        shutil.rmtree(path, onerror=_onerror)
    else:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            try:
                import stat

                os.chmod(path, stat.S_IWRITE)
                path.unlink(missing_ok=True)
            except OSError:
                pass


def purge_runtime_site_all(tool_id: str) -> None:
    """툴 runtime site-packages 전체 비우기 (손상·반쯤 설치 복구)."""
    import uuid

    site = runtime_site_packages_dir(tool_id)
    if not site.is_dir():
        site.mkdir(parents=True, exist_ok=True)
        return
    if not any(site.iterdir()):
        return

    trash = site.parent / f"_purged_{uuid.uuid4().hex[:8]}"
    try:
        site.rename(trash)
        site.mkdir(parents=True, exist_ok=True)
        ensure_runtime_tree_acl(tool_id)
        shutil.rmtree(trash, ignore_errors=True)
        return
    except OSError as exc:
        _log.warning("runtime site rename purge failed (%s), falling back to entry delete", exc)

    for entry in list(site.iterdir()):
        _rm_rf(entry)
    remaining = list(site.iterdir())
    if remaining:
        raise RuntimeError(
            "runtime Python 패키지 폴더를 비울 수 없습니다. "
            "itmatzip-agent 트레이를 완전히 종료한 뒤 「환경 준비」를 다시 시도하세요."
        )


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
        _rm_rf(entry)
