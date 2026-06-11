"""Burn-in media timing pipeline diagnostics — [BURN-IN-PIPE] structured logs."""

from __future__ import annotations

import json
import logging
import os
from typing import Any

_log = logging.getLogger(__name__)

_runtime_enabled = False


def set_burn_in_pipeline_diag_enabled(on: bool) -> None:
    global _runtime_enabled
    _runtime_enabled = bool(on)


def apply_pipeline_diag_request_flag(flag: bool | None) -> None:
    """FE prepare/finish/export body.pipeline_diag — 구버전 에이전트 호환."""
    if flag:
        set_burn_in_pipeline_diag_enabled(True)


def is_burn_in_pipeline_diag_enabled() -> bool:
    if _runtime_enabled:
        return True
    return os.getenv("BURN_IN_PIPELINE_DIAG", "").strip().lower() in ("1", "true", "yes")


def burn_in_pipeline_diag(event: str, **fields: Any) -> None:
    if not is_burn_in_pipeline_diag_enabled():
        return
    payload = {"event": event, **fields}
    try:
        line = json.dumps(payload, ensure_ascii=False, default=str)
    except TypeError:
        line = json.dumps({"event": event, "error": "serialize_failed"}, ensure_ascii=False)
    _log.info("[BURN-IN-PIPE] %s", line)


def probe_summary_for_diag(probe: dict[str, Any] | None) -> dict[str, Any]:
    if not probe:
        return {}
    return {
        "ok": probe.get("ok"),
        "video_duration_sec": probe.get("video_duration_sec"),
        "audio_duration_sec": probe.get("audio_duration_sec"),
        "format_duration_sec": probe.get("format_duration_sec"),
        "target_ntsc_fps": probe.get("target_ntsc_fps"),
        "video_r_frame_rate_fps": probe.get("video_r_frame_rate_fps"),
        "video_avg_frame_rate_fps": probe.get("video_avg_frame_rate_fps"),
        "vfr_suspected": probe.get("vfr_suspected"),
    }
