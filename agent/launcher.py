"""
PyInstaller 진입점 — 설치 스텁은 FastAPI/uvicorn 을 로드하지 않습니다.
개발 시: python main.py (기존과 동일)
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8", errors="replace")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8", errors="replace")

_AGENT_DIR = Path(__file__).resolve().parent
if str(_AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AGENT_DIR))


def _enable_frozen_serve_log() -> None:
    import tempfile

    log_path = Path(tempfile.gettempdir()) / "itmatzip-agent-serve.log"
    try:
        fh = log_path.open("a", encoding="utf-8", buffering=1)
        sys.stdout = fh
        sys.stderr = fh
        print(f"\n--- serve start pid={os.getpid()} argv={sys.argv!r} ---", flush=True)
    except OSError:
        pass


def _log_serve_exception() -> None:
    import traceback

    try:
        print("--- serve crashed ---", flush=True)
        traceback.print_exc()
    except Exception:
        pass


def _dispatch() -> None:
    from runtime_paths import is_frozen

    args = sys.argv[1:]

    if args and args[0] == "--pick-file":
        from scripts.pick_media_dialog import main as pick_main

        pick_main()
        return

    if args and args[0] == "--check-update":
        from common.auto_update import check_and_apply_update
        import json

        snap = check_and_apply_update(allow_apply="--apply" in args[1:])
        print(json.dumps(snap, indent=2, ensure_ascii=False))
        return

    if args and args[0] == "--install":
        from common.windows_startup import run_install_cli

        raise SystemExit(run_install_cli())

    if args and args[0] == "--uninstall":
        from common.windows_startup import run_uninstall_cli

        raise SystemExit(run_uninstall_cli())

    if "--serve" in args:
        import main as agent_main

        from common.windows_startup import prepare_server_instance

        if is_frozen():
            _enable_frozen_serve_log()
        try:
            prepare_server_instance()
            agent_main.main()
        except Exception:
            _log_serve_exception()
            raise
        return

    if is_frozen():
        from common.windows_startup import _install_log, installed_exe_path, run_installer_stub
        from runtime_paths import user_launch_exe

        launch = user_launch_exe()
        if launch == installed_exe_path() and "--serve" not in args:
            # AppData 설치본 더블클릭 → 이 프로세스에서 서버 실행
            _install_log(f"appdata launch serve argv={sys.argv!r}")
            import main as agent_main

            from common.windows_startup import prepare_server_instance

            if is_frozen():
                _enable_frozen_serve_log()
            prepare_server_instance()
            agent_main.main()
            return

        run_installer_stub()  # dist 설치 스텁 (필요 시 SystemExit)
        return

    import main as agent_main

    agent_main.main()


if __name__ == "__main__":
    import multiprocessing

    multiprocessing.freeze_support()
    _dispatch()
