"""FastAPI 이벤트 루프 보호 — sync CPU/IO 작업을 스레드풀로 넘깁니다."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")


async def run_sync(func: Callable[..., T], /, *args, **kwargs) -> T:
    """blocking callable을 thread pool에서 실행하고 await 합니다."""
    return await asyncio.to_thread(func, *args, **kwargs)
