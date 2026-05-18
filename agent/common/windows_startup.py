"""Windows: 에이전트 설치 경로 복사 + 로그인 시 자동 실행(레지스트리 Run)."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

APP_NAME = "ItMatZip"
REGISTRY_VALUE_NAME = "ItMatZipAgent"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
HEALTH_URL = "http://127.0.0.1:8000/health"


def _appdata_root() -> Path:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise RuntimeError("APPDATA 환경 변수가 없습니다. Windows에서 실행해 주세요.")
    return Path(appdata) / APP_NAME


def installed_exe_path() -> Path:
    return _appdata_root() / "itmatzip-agent.exe"


def is_windows() -> bool:
    return sys.platform == "win32"


def is_installed() -> bool:
    """설치본이 있고 Run 키에 등록되어 있는지."""
    if not is_windows():
        return False
    exe = installed_exe_path()
    if not exe.is_file():
        return False
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            val, _ = winreg.QueryValueEx(key, REGISTRY_VALUE_NAME)
        return Path(str(val)).resolve() == exe.resolve()
    except OSError:
        return False


def _set_run_key(exe_path: Path) -> None:
    import winreg

    with winreg.OpenKey(
        winreg.HKEY_CURRENT_USER,
        RUN_KEY,
        0,
        winreg.KEY_SET_VALUE,
    ) as key:
        winreg.SetValueEx(key, REGISTRY_VALUE_NAME, 0, winreg.REG_SZ, str(exe_path))


def _clear_run_key() -> None:
    import winreg

    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            RUN_KEY,
            0,
            winreg.KEY_SET_VALUE,
        ) as key:
            winreg.DeleteValue(key, REGISTRY_VALUE_NAME)
    except FileNotFoundError:
        pass


def agent_health_ok(timeout_sec: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=timeout_sec) as resp:
            return resp.status == 200
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def start_installed_agent(detached: bool = True) -> None:
    exe = installed_exe_path()
    if not exe.is_file():
        raise FileNotFoundError(f"설치된 에이전트 없음: {exe}")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.Popen(
        [str(exe)],
        cwd=str(exe.parent),
        creationflags=flags,
        close_fds=True,
    )


def install_agent(
    *,
    source_exe: Path | None = None,
    start_if_down: bool = True,
) -> Path:
    """
    exe를 %APPDATA%\\ItMatZip\\ 에 복사하고 로그인 시 자동 실행 등록.
    Returns 설치된 exe 경로.
    """
    if not is_windows():
        raise RuntimeError("Windows 전용 기능입니다.")

    src = Path(source_exe or sys.executable).resolve()
    if not src.is_file():
        raise FileNotFoundError(f"설치 원본 없음: {src}")

    dest_dir = _appdata_root()
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = installed_exe_path()

    if src.resolve() != dest.resolve():
        shutil.copy2(src, dest)

    _set_run_key(dest)

    if start_if_down and not agent_health_ok():
        start_installed_agent()

    return dest


def ensure_installed_on_first_launch() -> None:
    """
    exe 최초 실행 시 자동 설치(복사 + 시작 프로그램 등록).
    다운로드 폴더에서 실행해도 설치본을 띄운 뒤 원본 프로세스는 종료합니다.
    """
    if not is_windows():
        return

    from runtime_paths import is_frozen

    if not is_frozen():
        return

    dest = installed_exe_path()
    current = Path(sys.executable).resolve()
    was_installed = is_installed()

    if not was_installed:
        try:
            install_agent(start_if_down=False)
            show_message_box(
                "ItMatZip Agent 설치 완료",
                f"설치 위치:\n{dest}\n\n"
                "Windows 로그인 시 백그라운드에서 자동 실행됩니다.\n"
                "이제 웹사이트에서 에이전트 연결을 확인해 주세요.",
            )
        except Exception as e:
            show_message_box("ItMatZip Agent 설치 실패", str(e))
            raise SystemExit(1) from e

    if current.resolve() != dest.resolve():
        avoid_duplicate_instance()
        if not agent_health_ok():
            start_installed_agent()
        raise SystemExit(0)

    avoid_duplicate_instance()


def uninstall_agent(*, remove_files: bool = True) -> None:
    if not is_windows():
        raise RuntimeError("Windows 전용 기능입니다.")
    _clear_run_key()
    if remove_files:
        exe = installed_exe_path()
        if exe.is_file():
            try:
                exe.unlink()
            except OSError:
                pass


def show_message_box(title: str, message: str) -> None:
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(0, message, title, 0x40)
    except Exception:
        print(f"{title}\n{message}")


def run_install_cli() -> int:
    from runtime_paths import is_frozen

    if not is_frozen():
        show_message_box(
            "ItMatZip Agent",
            "설치는 빌드된 itmatzip-agent.exe 에서만 가능합니다.\n\n"
            "agent\\dist\\itmatzip-agent.exe --install",
        )
        return 1
    try:
        dest = install_agent()
        show_message_box(
            "ItMatZip Agent 설치 완료",
            f"설치 위치:\n{dest}\n\n"
            "Windows 로그인 시 백그라운드에서 자동 실행됩니다.\n"
            "웹사이트에서 에이전트 연결을 확인해 주세요.",
        )
        if Path(sys.executable).resolve() != dest.resolve():
            return 0
    except Exception as e:
        show_message_box("ItMatZip Agent 설치 실패", str(e))
        return 1
    return 0


def run_uninstall_cli() -> int:
    try:
        uninstall_agent(remove_files=True)
        show_message_box(
            "ItMatZip Agent",
            "자동 실행 등록을 제거했습니다.\n(실행 중인 에이전트는 작업 관리자에서 종료할 수 있습니다.)",
        )
        return 0
    except Exception as e:
        show_message_box("ItMatZip Agent", f"제거 실패: {e}")
        return 1


def avoid_duplicate_instance() -> None:
    """이미 다른 인스턴스가 8000에서 응답하면 조용히 종료."""
    if agent_health_ok(timeout_sec=1.5):
        sys.exit(0)
