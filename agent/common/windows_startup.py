"""Windows: 에이전트 설치 경로 복사 + 로그인 시 자동 실행(레지스트리 Run)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from agent_config import health_url

_AGENT_IMAGE = "itmatzip-agent.exe"
SERVE_ARG = "--serve"

APP_NAME = "ItMatZip"
REGISTRY_VALUE_NAME = "ItMatZipAgent"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
HEALTH_URL = health_url()


def _appdata_root() -> Path:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise RuntimeError("APPDATA 환경 변수가 없습니다. Windows에서 실행해 주세요.")
    return Path(appdata) / APP_NAME


def installed_exe_path() -> Path:
    return _appdata_root() / "itmatzip-agent.exe"


def run_registry_command(exe_path: Path | None = None) -> str:
    """로그인 시 자동 실행 명령 (--serve 포함)."""
    exe = (exe_path or installed_exe_path()).resolve()
    return f'"{exe}" {SERVE_ARG}'


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
        raw = str(val).strip()
        if raw == run_registry_command(exe):
            return True
        try:
            return Path(raw.strip('"').split()[0]).resolve() == exe.resolve()
        except (OSError, IndexError, ValueError):
            return False
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
        winreg.SetValueEx(key, REGISTRY_VALUE_NAME, 0, winreg.REG_SZ, run_registry_command(exe_path))


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
    """로컬 에이전트 /health 가 ItMatZip 응답인지 확인 (다른 프로그램과 구분)."""
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=timeout_sec) as resp:
            if resp.status != 200:
                return False
            body = resp.read().decode("utf-8", errors="replace")
            data = json.loads(body)
            return data.get("status") == "ok" and bool(data.get("agent_version"))
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError, ValueError):
        return False


def _no_window_flags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _detached_child_flags() -> int:
    """설치 스텁이 종료돼도 자식 --serve 프로세스가 Windows Job 과 함께 죽지 않게."""
    flags = _no_window_flags()
    flags |= getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
    flags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
    flags |= getattr(subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0x01000000)
    return flags


def _list_agent_pids() -> list[int]:
    """실행 중인 itmatzip-agent.exe PID 목록."""
    if not is_windows():
        return []
    try:
        out = subprocess.check_output(
            ["tasklist", "/FI", f"IMAGENAME eq {_AGENT_IMAGE}", "/FO", "CSV", "/NH"],
            creationflags=_no_window_flags(),
            text=True,
            errors="replace",
        )
    except (subprocess.CalledProcessError, OSError):
        return []
    pids: list[int] = []
    for line in out.strip().splitlines():
        line = line.strip()
        if not line or "INFO:" in line:
            continue
        parts = line.split(",")
        if len(parts) < 2:
            continue
        try:
            pids.append(int(parts[1].strip().strip('"')))
        except ValueError:
            continue
    return pids


def stop_running_agent_processes(*, exclude_current_process: bool = True) -> int:
    """
    itmatzip-agent.exe 프로세스를 종료합니다 (설치·업데이트 전).
    exclude_current_process: True 면 지금 실행 중인 설치 프로그램 PID 는 남깁니다.
    Returns 종료 시도한 프로세스 수.
    """
    if not is_windows():
        return 0
    skip = os.getpid() if exclude_current_process else None

    stopped = 0
    for pid in _list_agent_pids():
        if skip is not None and pid == skip:
            continue
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/F", "/T"],
            capture_output=True,
            creationflags=_no_window_flags(),
            check=False,
        )
        stopped += 1
    if stopped:
        time.sleep(1.2)
    return stopped


def wait_for_agent_down(timeout_sec: float = 10.0) -> None:
    """에이전트 health 가 내려갈 때까지 대기."""
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        if not agent_health_ok(timeout_sec=0.4):
            return
        time.sleep(0.2)


def start_server_process(exe: Path | None = None) -> None:
    """백그라운드 API 서버 프로세스 기동 (--serve)."""
    target = (exe or installed_exe_path()).resolve()
    if not target.is_file():
        raise FileNotFoundError(f"에이전트 없음: {target}")
    subprocess.Popen(
        [str(target), SERVE_ARG],
        cwd=str(target.parent),
        creationflags=_detached_child_flags(),
        close_fds=False,
    )


def ensure_installed_agent_running(*, wait_sec: float = 15.0) -> bool:
    """서버가 떠 있을 때까지 기동·대기."""
    if agent_health_ok(timeout_sec=0.5):
        return True
    start_server_process()
    deadline = time.monotonic() + wait_sec
    while time.monotonic() < deadline:
        if agent_health_ok(timeout_sec=0.5):
            return True
        time.sleep(0.35)
    return False


_SERVER_MUTEX_NAME = "Global\\ItMatZipAgentServer_v1"
_server_mutex = None


def try_acquire_server_lock() -> bool:
    """서버(uvicorn) 단일 인스턴스 잠금."""
    global _server_mutex
    if not is_windows():
        return True
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        ERROR_ALREADY_EXISTS = 183
        _server_mutex = kernel32.CreateMutexW(None, True, _SERVER_MUTEX_NAME)
        if kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
            if _server_mutex:
                kernel32.CloseHandle(_server_mutex)
            _server_mutex = None
            return False
        return True
    except Exception:
        return True


def prepare_server_instance() -> None:
    """--serve 모드 진입: 단일 인스턴스 확보, 이미 떠 있으면 종료."""
    if try_acquire_server_lock():
        return
    if agent_health_ok(timeout_sec=1.0):
        sys.exit(0)
    for _ in range(20):
        time.sleep(0.25)
        if agent_health_ok(timeout_sec=0.4):
            sys.exit(0)
        if try_acquire_server_lock():
            return
    show_message_box(
        "ItMatZip Agent",
        "다른 에이전트 인스턴스가 실행 중이거나 이전 실행이 정리되지 않았습니다.\n"
        "작업 관리자에서 itmatzip-agent.exe 를 모두 종료한 뒤 다시 실행해 주세요.",
    )
    sys.exit(1)


def _deploy_installed_exe(source: Path, *, exclude_current_process: bool = True) -> Path:
    """기존 에이전트 종료 → 설치 경로에 exe 복사 → 시작 프로그램 등록."""
    src = source.resolve()
    if not src.is_file():
        raise FileNotFoundError(f"설치 원본 없음: {src}")

    stop_running_agent_processes(exclude_current_process=exclude_current_process)
    wait_for_agent_down()

    dest_dir = _appdata_root()
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = installed_exe_path()

    if src != dest.resolve():
        shutil.copy2(src, dest)

    _set_run_key(dest)
    return dest


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
    dest = _deploy_installed_exe(src)

    if start_if_down:
        if src != dest.resolve():
            start_server_process(dest)
            time.sleep(0.5)
        else:
            ensure_installed_agent_running()

    return dest


def _install_log(msg: str) -> None:
    try:
        import tempfile

        log_path = Path(tempfile.gettempdir()) / "itmatzip-agent-install.log"
        with log_path.open("a", encoding="utf-8") as f:
            f.write(msg.rstrip() + "\n")
    except OSError:
        pass


def run_installer_stub() -> None:
    """
    dist/다운로드 exe 더블클릭 — AppData 에 복사·등록·서버 기동 (가벼운 경로, FastAPI 미로드).
    설치본 exe 더블클릭(--serve 없음) — 이 프로세스에서 서버 실행.
    """
    if not is_windows():
        _install_log("not windows")
        return

    from runtime_paths import is_frozen

    if not is_frozen():
        return

    current = Path(sys.executable).resolve()
    dest = installed_exe_path()
    _install_log(f"installer current={current} dest={dest}")

    if current.resolve() == dest.resolve():
        import main as agent_main

        prepare_server_instance()
        agent_main.main()
        return

    was_new = not dest.is_file()
    try:
        if not was_new:
            stop_running_agent_processes(exclude_current_process=True)
            wait_for_agent_down()

        dest.parent.mkdir(parents=True, exist_ok=True)
        _install_log(f"mkdir ok {dest.parent}")
        shutil.copy2(current, dest)
        _install_log(f"copy ok -> {dest}")
        _set_run_key(dest)

        start_server_process(dest)
        if not ensure_installed_agent_running(wait_sec=25):
            show_message_box(
                "ItMatZip Agent 시작 실패",
                f"설치 폴더는 만들었지만 서버가 응답하지 않습니다.\n\n"
                f"{dest}\n\n"
                "위 파일을 직접 실행하거나, 백신·방화벽을 확인해 주세요.\n"
                f"(로그: %TEMP%\\itmatzip-agent-install.log)",
            )
            raise SystemExit(1)

        if was_new:
            show_message_box(
                "ItMatZip Agent 설치 완료",
                f"설치 위치:\n{dest}\n\n"
                "에이전트가 백그라운드에서 실행 중입니다.",
            )
        else:
            show_message_box("ItMatZip Agent 업데이트 완료", f"설치 위치:\n{dest}")
    except Exception as e:
        _install_log(f"error: {e!r}")
        title = "ItMatZip Agent 설치 실패" if was_new else "ItMatZip Agent 업데이트 실패"
        show_message_box(title, f"{e}\n\n(로그: %TEMP%\\itmatzip-agent-install.log)")
        raise SystemExit(1) from e

    raise SystemExit(0)


def bootstrap_frozen_agent_entry() -> None:
    """하위 호환 — launcher.py 가 설치를 담당합니다."""
    run_installer_stub()


# 하위 호환
ensure_installed_on_first_launch = run_installer_stub
start_installed_agent = lambda **_: start_server_process()


def uninstall_agent(*, remove_files: bool = True) -> None:
    if not is_windows():
        raise RuntimeError("Windows 전용 기능입니다.")
    stop_running_agent_processes(exclude_current_process=True)
    wait_for_agent_down()
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
        if not ensure_installed_agent_running():
            show_message_box(
                "ItMatZip Agent",
                "설치했지만 서버가 응답하지 않습니다.\n"
                f"{dest} 를 다시 실행해 주세요.",
            )
            return 1
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
    """이미 다른 인스턴스가 에이전트 포트에서 응답하면 조용히 종료."""
    if agent_health_ok(timeout_sec=1.5):
        sys.exit(0)
