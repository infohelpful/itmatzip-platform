"""
단일 칩 Micro-Realign — target↔next 끝 경계만 (순차 편집, start 고정).

다음 단어 구간에서 가장 깊은 V골(없으면 구간 최저 RMS)을 경계로 사용.
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np

from common.bin_manager import get_ffmpeg_executable
from engines.auto_subtitle_rms_vad import MIN_WORD_SEC, _dynamic_threshold_db, _rms_db_frames
from engines.auto_subtitle_zero_cross import (
    SR,
    ZC_END_SEARCH_AFTER_SEC,
    ZC_END_SEARCH_BEFORE_SEC,
    decode_mono_f32_16k_segment,
    refine_time_to_zero_cross,
)

logger = logging.getLogger(__name__)

MICRO_REALIGN_ENGINE_REV = "micro-realign-v3-next-min-rms"
MAX_SEGMENT_SEC = 3.0
MAX_END_DRIFT_SEC = 0.60
MIN_DURATION_RATIO = 0.20
MAX_DURATION_RATIO = 2.50
EDGE_PAD_SEC = 0.15
MIN_V_VALLEY_DIP_DB = 1.5


def _safety_reject_end_only(
    orig_start: float,
    orig_end: float,
    new_end: float,
) -> str | None:
    new_dur = new_end - orig_start
    orig_dur = max(1e-6, orig_end - orig_start)
    if new_dur < orig_dur * MIN_DURATION_RATIO:
        return "duration_too_short"
    if new_dur > orig_dur * MAX_DURATION_RATIO:
        return "duration_too_long"
    if abs(new_end - orig_end) > MAX_END_DRIFT_SEC:
        return "drift_too_large"
    if new_end <= orig_start + 0.04:
        return "invalid_span"
    return None


def _refine_end_zc(samples: np.ndarray, t_rel: float) -> float:
    dur_max = len(samples) / float(SR)
    return refine_time_to_zero_cross(
        samples,
        SR,
        t_rel,
        ZC_END_SEARCH_BEFORE_SEC,
        ZC_END_SEARCH_AFTER_SEC,
        dur_max=dur_max,
    )


def _pick_deepest_valley_or_min_rms(
    db_frames: np.ndarray,
    hop_sec: float,
    t_lo: float,
    t_hi: float,
    dur_max: float,
) -> tuple[float, str]:
    """
    [t_lo, t_hi] 구간에서:
    1) V골(국소 최저) 후보 중 dB가 가장 낮은 지점
    2) V골 없으면 구간 전체 최저 RMS
    """
    if db_frames.size == 0 or hop_sec <= 0 or t_hi <= t_lo + hop_sec * 0.5:
        return float(t_lo), "fallback_lo"

    t_lo = max(0.0, min(dur_max, float(t_lo)))
    t_hi = max(t_lo + hop_sec, min(dur_max, float(t_hi)))
    k0 = max(0, int(np.floor(t_lo / hop_sec)))
    k1 = min(int(db_frames.size) - 1, int(np.ceil(t_hi / hop_sec)))
    if k1 <= k0:
        return float(t_lo), "fallback_lo"

    seg = db_frames[k0 : k1 + 1]
    v_candidates: list[tuple[int, float]] = []
    for rel in range(1, len(seg) - 1):
        v = float(seg[rel])
        if v <= float(seg[rel - 1]) and v <= float(seg[rel + 1]):
            left_peak = float(np.max(seg[max(0, rel - 3) : rel])) if rel > 0 else v + MIN_V_VALLEY_DIP_DB
            right_peak = (
                float(np.max(seg[rel + 1 : min(len(seg), rel + 4)]))
                if rel + 1 < len(seg)
                else v + MIN_V_VALLEY_DIP_DB
            )
            dip = min(left_peak - v, right_peak - v)
            if dip >= MIN_V_VALLEY_DIP_DB:
                v_candidates.append((k0 + rel, v))

    if v_candidates:
        best_k, _best_db = min(v_candidates, key=lambda item: item[1])
        return float(best_k * hop_sec), "v_valley"

    valley_rel = int(np.argmin(seg))
    return float((k0 + valley_rel) * hop_sec), "min_rms"


def apply_micro_realign(
    *,
    media_path: str,
    target: dict[str, Any],
    prev_word: dict[str, Any] | None,
    next_word: dict[str, Any] | None,
    ffmpeg_exe: str | None = None,
) -> dict[str, Any]:
    """target.end + next.start — 다음 단어 블록 RMS 최저(V골 우선)."""
    del prev_word
    ff = str(ffmpeg_exe or get_ffmpeg_executable())
    t_start = float(target["start"])
    t_end = float(target["end"])
    t_text = str(target.get("text") or "")

    orig_start = t_start
    orig_end = t_end

    if next_word is None:
        return {
            "ok": True,
            "applied": False,
            "new_start": orig_start,
            "new_end": orig_end,
            "reason": "missing_next",
            "boundary_patches": [],
            "stats": {"engine_rev": MICRO_REALIGN_ENGINE_REV},
        }

    next_start = float(next_word["start"])
    next_end = float(next_word["end"])
    if next_end <= next_start + MIN_WORD_SEC:
        return {
            "ok": True,
            "applied": False,
            "new_start": orig_start,
            "new_end": orig_end,
            "reason": "invalid_next_span",
            "boundary_patches": [],
            "stats": {"engine_rev": MICRO_REALIGN_ENGINE_REV},
        }

    abs_lo = min(t_start, next_start)
    abs_hi = max(t_end, next_end)
    seg_span = min(MAX_SEGMENT_SEC, max(0.08, abs_hi - abs_lo))

    try:
        samples, segment_t0 = decode_mono_f32_16k_segment(
            media_path,
            abs_lo,
            seg_span,
            pad_sec=EDGE_PAD_SEC,
            ffmpeg_exe=ff,
        )
        db_frames, hop_sec, _, _ = _rms_db_frames(samples)
        dur_max = len(samples) / float(SR)
        if db_frames.size == 0 or hop_sec <= 0:
            return {
                "ok": True,
                "applied": False,
                "new_start": orig_start,
                "new_end": orig_end,
                "reason": "no_frames",
                "boundary_patches": [],
                "stats": {"engine_rev": MICRO_REALIGN_ENGINE_REV},
            }

        _dynamic_threshold_db(db_frames)

        # 다음 단어 블록 [next.start, next.end] — segment 상대 시간
        search_lo = next_start - segment_t0
        search_hi = next_end - segment_t0

        boundary_rel, pick_mode = _pick_deepest_valley_or_min_rms(
            db_frames,
            hop_sec,
            search_lo,
            search_hi,
            dur_max,
        )

        boundary_rel = _refine_end_zc(samples, boundary_rel)
        new_end = boundary_rel + segment_t0
        new_start = orig_start

        # start 고정 — end는 target.start 이후, next.end 이전을 권장
        new_end = max(orig_start + MIN_WORD_SEC, min(next_end, new_end))

        reason = _safety_reject_end_only(orig_start, orig_end, new_end)
        if reason:
            return {
                "ok": True,
                "applied": False,
                "new_start": orig_start,
                "new_end": orig_end,
                "reason": reason,
                "boundary_patches": [],
                "stats": {
                    "engine_rev": MICRO_REALIGN_ENGINE_REV,
                    "pick_mode": pick_mode,
                },
            }

        if abs(new_end - orig_end) < 0.008:
            return {
                "ok": True,
                "applied": False,
                "new_start": orig_start,
                "new_end": orig_end,
                "reason": "no_change",
                "boundary_patches": [],
                "stats": {
                    "engine_rev": MICRO_REALIGN_ENGINE_REV,
                    "pick_mode": pick_mode,
                },
            }

        boundary_patches = [
            {
                "left": {
                    "cue_index": int(target["cue_index"]),
                    "word_index": int(target["word_index"]),
                },
                "right": {
                    "cue_index": int(next_word["cue_index"]),
                    "word_index": int(next_word["word_index"]),
                },
                "boundary_sec": new_end,
                "same_cue": int(target["cue_index"]) == int(next_word["cue_index"]),
            },
        ]

        return {
            "ok": True,
            "applied": True,
            "new_start": new_start,
            "new_end": new_end,
            "reason": None,
            "boundary_patches": boundary_patches,
            "stats": {
                "engine_rev": MICRO_REALIGN_ENGINE_REV,
                "mode": "end_only",
                "pick_mode": pick_mode,
                "search_lo": search_lo + segment_t0,
                "search_hi": search_hi + segment_t0,
                "delta_start_ms": 0.0,
                "delta_end_ms": (new_end - orig_end) * 1000.0,
            },
        }
    except (OSError, RuntimeError, ValueError) as exc:
        logger.warning("micro-realign failed: %s", exc)
        return {
            "ok": True,
            "applied": False,
            "new_start": orig_start,
            "new_end": orig_end,
            "reason": "decode_failed",
            "boundary_patches": [],
            "stats": {"engine_rev": MICRO_REALIGN_ENGINE_REV, "error": str(exc)[:200]},
        }
