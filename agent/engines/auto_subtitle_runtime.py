"""Auto Subtitle — 작업 큐(단일 슬롯)·Whisper 모델 유휴 언로드."""

from __future__ import annotations

import os
import threading
from typing import Any

_job_lock = threading.RLock()
_active_job: str | None = None
_unload_timer: threading.Timer | None = None
_unload_timer_lock = threading.Lock()

# Hugging Face CT2 turbo — UI·manifest 안내용 (실제 크기는 디스크 사용량 기준)
WHISPER_MODEL_DOWNLOAD_HINT_MB = 1650
DEFAULT_MODEL_UNLOAD_IDLE_SEC = 300.0


def model_unload_idle_sec() -> float:
    raw = os.environ.get("ITMATZIP_WHISPER_UNLOAD_IDLE_SEC", "").strip()
    if not raw:
        return DEFAULT_MODEL_UNLOAD_IDLE_SEC
    try:
        sec = float(raw)
        return max(60.0, min(sec, 86400.0))
    except ValueError:
        return DEFAULT_MODEL_UNLOAD_IDLE_SEC


def get_active_job() -> str | None:
    with _job_lock:
        return _active_job


def is_job_busy() -> bool:
    return get_active_job() is not None


def try_begin_job(name: str) -> None:
    """transcribe / export 등 장시간 작업 시작 전 호출."""
    global _active_job
    with _job_lock:
        if _active_job:
            raise RuntimeError(
                f"다른 작업이 진행 중입니다 ({_active_job}). "
                "완료 후 다시 시도해 주세요."
            )
        _active_job = name
    cancel_scheduled_unload()


def end_job() -> None:
    """작업 스레드 finally에서 호출."""
    global _active_job
    with _job_lock:
        _active_job = None
    schedule_unload_after_idle()


def cancel_scheduled_unload() -> None:
    global _unload_timer
    with _unload_timer_lock:
        if _unload_timer is not None:
            _unload_timer.cancel()
            _unload_timer = None


def schedule_unload_after_idle(idle_sec: float | None = None) -> None:
    """유휴 idle_sec 후 Whisper 메모리 해제 예약."""
    from engines import auto_subtitle

    if not auto_subtitle.is_model_loaded():
        return
    if is_job_busy():
        return

    sec = model_unload_idle_sec() if idle_sec is None else max(60.0, float(idle_sec))

    def _fire() -> None:
        if is_job_busy():
            return
        if not auto_subtitle.is_model_loaded():
            return
        unload_whisper_model(reason="idle_timeout")

    cancel_scheduled_unload()
    with _unload_timer_lock:
        global _unload_timer
        _unload_timer = threading.Timer(sec, _fire)
        _unload_timer.daemon = True
        _unload_timer.start()


def unload_whisper_model(*, reason: str = "manual") -> dict[str, Any]:
    """GPU/CPU VRAM·RAM 점유 해제."""
    from engines import auto_subtitle

    cancel_scheduled_unload()
    had = auto_subtitle.is_model_loaded()
    device_before = auto_subtitle.model_device()
    auto_subtitle.clear_whisper_model()
    import gc

    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass
    except Exception:
        pass
    return {
        "unloaded": True,
        "had_model": had,
        "previous_device": device_before,
        "reason": reason,
        "idle_unload_sec": model_unload_idle_sec(),
    }


def runtime_status() -> dict[str, Any]:
    from engines import auto_subtitle

    return {
        "job_busy": is_job_busy(),
        "active_job": get_active_job(),
        "model_loaded": auto_subtitle.is_model_loaded(),
        "model_device": auto_subtitle.model_device(),
        "whisper_download_hint_mb": WHISPER_MODEL_DOWNLOAD_HINT_MB,
        "model_unload_idle_sec": model_unload_idle_sec(),
    }
