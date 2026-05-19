"""
배포용 단일 exe 진입점 — FastAPI/uvicorn 을 로드하지 않습니다.
실행 시 번들(zip)을 %APPDATA%\\ItMatZip 에 풀고 서버만 기동합니다.
"""

from __future__ import annotations

import os
import sys

if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8", errors="replace")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8", errors="replace")


def main() -> None:
    from common.windows_startup import run_embedded_installer

    raise SystemExit(run_embedded_installer())


if __name__ == "__main__":
    import multiprocessing

    multiprocessing.freeze_support()
    main()
