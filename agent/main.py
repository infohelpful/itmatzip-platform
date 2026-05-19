# 로컬 서버의 본체입니다. 툴별 라우터를 등록하고, 각 툴은 필요한 준비 로직만 탑니다.

from __future__ import annotations

import json
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from runtime_paths import agent_root, is_frozen  # noqa: E402

_AGENT_ROOT = agent_root()
if str(_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(_AGENT_ROOT))

from common.auto_update import get_update_status_snapshot, schedule_background_update_checks  # noqa: E402
from engines import silence_remover as silence_remover_engine  # noqa: E402
from routers import silence_remover as silence_remover_router  # noqa: E402
from version import AGENT_VERSION  # noqa: E402


@asynccontextmanager
async def _app_lifespan(_app: FastAPI):
    silence_remover_engine.schedule_disk_cache_purge()
    schedule_background_update_checks()
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        title="ItMatZip Local Agent",
        version=AGENT_VERSION,
        lifespan=_app_lifespan,
    )
    # allow_private_network: Chrome 등에서 localhost 웹 → 127.0.0.1:8000 호출 시 필수
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        allow_private_network=True,
    )

    @app.get("/health")
    async def health() -> dict:
        """에이전트 프로세스 생존 확인(가볍게). 툴별 바이너리 점검은 각 툴의 `/readiness`에서 수행합니다."""
        upd = get_update_status_snapshot()
        installed = False
        if is_frozen():
            try:
                from common.windows_startup import is_installed

                installed = is_installed()
            except Exception:
                installed = False
        return {
            "status": "ok",
            "agent_version": AGENT_VERSION,
            "update_available": bool(upd.get("update_available")),
            "remote_version": upd.get("remote_version"),
            "startup_installed": installed,
        }

    # 툴 추가 시: routers 아래에 모듈을 만들고 여기서 include_router 만 하면 됩니다.
    app.include_router(silence_remover_router.router)

    web_ui = _AGENT_ROOT.parent / "web-ui"
    if web_ui.is_dir():
        app.mount("/ui", StaticFiles(directory=str(web_ui), html=True), name="web-ui")

    return app


app = create_app()


def _ensure_stdio() -> None:
    """PyInstaller windowed 빌드(console=False)에서는 stdout/stderr 가 None 일 수 있음."""
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8", errors="replace")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8", errors="replace")


def main() -> None:
    if is_frozen():
        _ensure_stdio()

    import uvicorn

    host = "127.0.0.1"
    port = 8000
    if not is_frozen():
        print(f"ItMatZip Agent v{AGENT_VERSION} — http://{host}:{port}/health")
        print("웹 UI는 https://silence.itmatzip.com 등 호스팅 주소에서 이용하세요. (에이전트는 로컬 API만 제공)")
    uvicorn.run(app, host=host, port=port, log_level="warning" if is_frozen() else "info")


def run_pick_file_dialog() -> None:
    from scripts.pick_media_dialog import main as pick_main

    pick_main()


if __name__ == "__main__":
    import multiprocessing

    multiprocessing.freeze_support()
    if is_frozen():
        _ensure_stdio()
    if len(sys.argv) >= 2 and sys.argv[1] == "--pick-file":
        run_pick_file_dialog()
    elif len(sys.argv) >= 2 and sys.argv[1] == "--check-update":
        from common.auto_update import check_and_apply_update

        snap = check_and_apply_update(allow_apply="--apply" in sys.argv[2:])
        print(json.dumps(snap, indent=2, ensure_ascii=False))
    elif len(sys.argv) >= 2 and sys.argv[1] == "--install":
        from common.windows_startup import run_install_cli

        raise SystemExit(run_install_cli())
    elif len(sys.argv) >= 2 and sys.argv[1] == "--uninstall":
        from common.windows_startup import run_uninstall_cli

        raise SystemExit(run_uninstall_cli())
    else:
        if is_frozen():
            from common.windows_startup import ensure_installed_on_first_launch

            ensure_installed_on_first_launch()
        main()
