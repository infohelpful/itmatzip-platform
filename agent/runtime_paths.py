"""개발 모드 / PyInstaller exe 공통 경로·서브프로세스 헬퍼."""

from __future__ import annotations

import sys
from pathlib import Path


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def user_launch_exe() -> Path:
    """
    사용자가 실행한 exe 경로.
    PyInstaller onefile 에서도 dist/AppData 원본 경로를 가리키도록 argv[0] 우선.
    """
    if is_frozen() and sys.argv:
        return Path(sys.argv[0]).resolve()
    return Path(sys.executable).resolve()


def frozen_bundle_dir(exe: Path | None = None) -> Path | None:
    """
    PyInstaller onedir 설치 묶음 폴더 (exe + _internal).
    onefile 이면 None.
    """
    if not is_frozen():
        return None
    root = (exe or user_launch_exe()).resolve().parent
    if (root / "_internal").is_dir():
        return root
    return None


def agent_root() -> Path:
    """에이전트 소스(또는 exe에 번들된 _MEIPASS) 루트."""
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    return Path(__file__).resolve().parent


def pick_script_path() -> Path:
    return agent_root() / "scripts" / "pick_media_dialog.py"


def pick_file_command() -> list[str]:
    """파일 선택 대화상자용 subprocess argv (exe는 --pick-file 모드)."""
    if is_frozen():
        from common.windows_startup import installed_exe_path

        exe = installed_exe_path()
        if exe.is_file():
            return [str(exe), "--pick-file"]
        return [str(user_launch_exe()), "--pick-file"]
    return [sys.executable, str(pick_script_path())]


def pick_file_available() -> bool:
    if is_frozen():
        return True
    return pick_script_path().is_file()
