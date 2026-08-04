# 로컬 서버의 본체입니다. 툴별 라우터를 등록하고, 각 툴은 필요한 준비 로직만 탑니다.

from __future__ import annotations

import json
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

# PyInstaller windowed(console=False): import 시점부터 stdout/stderr 가 None 일 수 있음
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8", errors="replace")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8", errors="replace")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import RedirectResponse, Response

from agent_config import AGENT_HOST, AGENT_PORT, agent_base_url  # noqa: E402
from common.runtime_site_packages import ensure_runtime_directories  # noqa: E402
from runtime_paths import agent_root, is_frozen  # noqa: E402

_AGENT_ROOT = agent_root()
if str(_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(_AGENT_ROOT))

from common.load_env import load_local_env_files  # noqa: E402

load_local_env_files()

from common.auto_update import get_update_status_snapshot, schedule_background_update_checks  # noqa: E402
from engines import silence_remover as silence_remover_engine  # noqa: E402
from routers import auto_subtitle as auto_subtitle_router  # noqa: E402
from routers import create_music as create_music_router  # noqa: E402
from routers import silence_remover as silence_remover_router  # noqa: E402
from routers import background_remover as background_remover_router  # noqa: E402
from routers import image_enhancer as image_enhancer_router  # noqa: E402
from routers import magic_eraser as magic_eraser_router  # noqa: E402
from routers import vocal_remover as vocal_remover_router  # noqa: E402
from version import AGENT_VERSION  # noqa: E402


def _warmup_background() -> None:
    """기동 직후 /health 가 먼저 응답하도록 무거운 초기화는 백그라운드에서."""
    import threading

    def _run() -> None:
        try:
            ensure_runtime_directories()
        except Exception:
            pass
        silence_remover_engine.schedule_disk_cache_purge()
        schedule_background_update_checks()
        _schedule_ffmpeg_bootstrap()
        try:
            from engines import custom_fonts

            custom_fonts.register_all_custom_fonts()
        except Exception:
            pass

    threading.Thread(target=_run, daemon=True, name="agent-warmup").start()


@asynccontextmanager
async def _app_lifespan(_app: FastAPI):
    _warmup_background()
    yield


def _schedule_ffmpeg_bootstrap() -> None:
    """MSI vendor 번들 → ProgramData 복사만 (네트워크 다운로드는 /prepare 요청 시)."""
    import logging
    import threading

    def _run() -> None:
        try:
            from common.bin_manager import bootstrap_ffmpeg_from_install_bundle, is_ffmpeg_ready

            if is_ffmpeg_ready():
                return
            bootstrap_ffmpeg_from_install_bundle()
        except Exception as exc:
            logging.getLogger(__name__).warning("background ffmpeg bootstrap: %s", exc)

    threading.Thread(target=_run, daemon=True, name="ffmpeg-bootstrap").start()


class _PrivateNetworkAccessMiddleware(BaseHTTPMiddleware):
    """Chrome LNA — CORS 응답에 private-network 허용 헤더를 보강."""

    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers["Access-Control-Allow-Private-Network"] = "true"
        return response


def create_app() -> FastAPI:
    app = FastAPI(
        title="ItMatZip Local Agent",
        version=AGENT_VERSION,
        lifespan=_app_lifespan,
    )
    # Go 컨트롤러(19876) 뒤에서 프록시될 때는 CORS를 Go가 한 번만 처리 (중복 시 브라우저 Failed to fetch)
    behind_go = os.environ.get("ITMATZIP_BEHIND_GO_PROXY", "").strip().lower() in ("1", "true", "yes")
    if not behind_go:
        app.add_middleware(_PrivateNetworkAccessMiddleware)
        app.add_middleware(
            CORSMiddleware,
            allow_origins=[
                "https://tools.itmatzip.com",
                "https://silence.itmatzip.com",
                "http://localhost:5173",
                "http://localhost:5500",
                "http://127.0.0.1:5500",
            ],
            allow_origin_regex=r"^https://([\w-]+\.)*itmatzip\.com$|^http://(localhost|127\.0\.0\.1)(:\d+)?$",
            allow_credentials=False,
            allow_methods=["*"],
            allow_headers=["*"],
            expose_headers=["*"],
            allow_private_network=True,
        )

    @app.get("/")
    async def root() -> RedirectResponse:
        """루트 접속 시 웹 UI 허브로 이동 (19876 단독 접속 404 방지)."""
        return RedirectResponse(url="/ui/tools/", status_code=302)

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
    app.include_router(vocal_remover_router.router)
    app.include_router(auto_subtitle_router.router)
    app.include_router(create_music_router.router)
    app.include_router(image_enhancer_router.router)
    app.include_router(background_remover_router.router)
    app.include_router(magic_eraser_router.router)

    web_ui = _AGENT_ROOT.parent / "web-ui"
    if web_ui.is_dir():
        app.mount("/ui", StaticFiles(directory=str(web_ui), html=True), name="web-ui")

    return app


app = create_app()


# uvicorn.logging.*Formatter 는 windowed exe 에서 isatty() 크래시 → 표준 Formatter 만 사용
_UVICORN_LOG_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "default": {
            "format": "%(levelname)s %(name)s: %(message)s",
            "class": "logging.Formatter",
        },
        "access": {
            "format": '%(levelname)s %(client_addr)s - "%(request_line)s" %(status_code)s',
            "class": "logging.Formatter",
        },
    },
    "handlers": {
        "default": {
            "formatter": "default",
            "class": "logging.StreamHandler",
            "stream": "ext://sys.stderr",
        },
        "access": {
            "formatter": "access",
            "class": "logging.StreamHandler",
            "stream": "ext://sys.stdout",
        },
    },
    "loggers": {
        "uvicorn": {"handlers": ["default"], "level": "INFO", "propagate": False},
        "uvicorn.error": {"level": "INFO"},
        "uvicorn.access": {"handlers": ["access"], "level": "INFO", "propagate": False},
    },
}


def main() -> None:
    import uvicorn

    host = AGENT_HOST
    port = AGENT_PORT
    frozen = is_frozen()
    if not frozen:
        print(f"ItMatZip Agent v{AGENT_VERSION} — {agent_base_url()}/health")
        print(f"웹 UI(로컬): {agent_base_url()}/ui/tools/")
        print("또는 프로젝트 루트에서 .\\serve-tools.ps1 → http://localhost:29180/")
    # exe·stdio 없음 환경 모두 plain 로그 (DefaultFormatter 가 isatty 호출하지 않음)
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="warning" if frozen else "info",
        log_config=_UVICORN_LOG_CONFIG,
    )


def run_pick_file_dialog() -> None:
    from scripts.pick_media_dialog import main as pick_main

    pick_main()


def run_pick_audio_file_dialog() -> None:
    from scripts.pick_audio_dialog import main as pick_main

    pick_main()


if __name__ == "__main__":
    import multiprocessing

    multiprocessing.freeze_support()
    if len(sys.argv) >= 2 and sys.argv[1] == "--pick-file":
        run_pick_file_dialog()
    elif len(sys.argv) >= 2 and sys.argv[1] == "--pick-audio-file":
        run_pick_audio_file_dialog()
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
            from common.windows_startup import bootstrap_frozen_agent_entry

            bootstrap_frozen_agent_entry()  # 설치 스텁이면 SystemExit, --serve 면 main() 계속
        main()
