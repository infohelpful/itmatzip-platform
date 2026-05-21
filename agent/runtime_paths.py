"""개발 모드 / PyInstaller exe 공통 경로·서브프로세스 헬퍼."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def _behind_go_proxy() -> bool:
    return os.environ.get("ITMATZIP_BEHIND_GO_PROXY", "").strip().lower() in ("1", "true", "yes")


def _msi_engine_python() -> Path | None:
    """Go MSI 설치 시 engine venv Python (서비스에서 pick 대화상자 실행용)."""
    root = os.environ.get("ITMATZIP_AGENT_INSTALL_ROOT", "").strip()
    if not root:
        return None
    candidate = Path(root) / "engine" / "python.exe"
    return candidate if candidate.is_file() else None


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


def agent_package_root() -> Path:
    """
    FastAPI agent/ 디렉터리 (main.py, engines/ 포함).
    MSI engine venv에서 Demucs subprocess가 engines.* 를 찾도록 cwd/PYTHONPATH에 사용.
    """
    install = os.environ.get("ITMATZIP_AGENT_INSTALL_ROOT", "").strip()
    if install:
        candidate = Path(install) / "agent"
        if (candidate / "engines" / "demucs_runner.py").is_file():
            return candidate.resolve()

    agent_dir = os.environ.get("ITMATZIP_AGENT_DIR", "").strip()
    if agent_dir:
        candidate = Path(agent_dir)
        if (candidate / "engines" / "demucs_runner.py").is_file():
            return candidate.resolve()

    root = agent_root()
    if (root / "engines" / "demucs_runner.py").is_file():
        return root.resolve()

    raise RuntimeError(
        "agent package root not found (engines/demucs_runner.py). "
        "Check ITMATZIP_AGENT_INSTALL_ROOT or ITMATZIP_AGENT_DIR."
    )


def demucs_runner_script() -> Path:
    return agent_package_root() / "engines" / "demucs_runner.py"


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
    engine_py = _msi_engine_python()
    if engine_py is not None:
        return [str(engine_py), str(pick_script_path())]
    return [sys.executable, str(pick_script_path())]


def pick_file_available() -> bool:
    if _behind_go_proxy():
        return True
    if is_frozen():
        return True
    return pick_script_path().is_file()


def pick_audio_script_path() -> Path:
    return agent_root() / "scripts" / "pick_audio_dialog.py"


def pick_audio_command() -> list[str]:
    """오디오 전용 파일 선택 대화상자 subprocess argv."""
    if is_frozen():
        from common.windows_startup import installed_exe_path

        exe = installed_exe_path()
        if exe.is_file():
            return [str(exe), "--pick-audio-file"]
        return [str(user_launch_exe()), "--pick-audio-file"]
    engine_py = _msi_engine_python()
    if engine_py is not None:
        return [str(engine_py), str(pick_audio_script_path())]
    return [sys.executable, str(pick_audio_script_path())]


def pick_audio_available() -> bool:
    if _behind_go_proxy():
        return True
    if is_frozen():
        return True
    return pick_audio_script_path().is_file()
