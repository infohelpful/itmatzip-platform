"""
인접 단어 사이 RMS V 바닥(valley) — Golden Standard (Anchor A/B + Scored Valley).

Whisper 경계 근처 미시 탐색 대신, 단어 내부 앵커 peak 사이
후보 골짜기를 depth·distance 스코어로 선택.
word A 음절 수 × SEC_PER_SYLLABLE 로 t_target 거리 힌트 (타이밍 맞추기).
"""

from __future__ import annotations

import logging
import math
import re
from copy import deepcopy
from typing import Any, Literal

import numpy as np

from common.bin_manager import get_ffmpeg_executable
from engines.auto_subtitle_rms_vad import (
    MIN_WORD_SEC,
    _decode_mono_f32_16k,
    _dynamic_threshold_db,
    _is_pause_or_filler_token,
    _is_silence_token,
    _resolve_ffmpeg,
    _rms_db_frames,
)
from engines.auto_subtitle_zero_cross import SR

logger = logging.getLogger(__name__)

PAD_SEC = 0.50
MIN_VALLEY_DIP_DB = 2.0
MIN_ADJUST_SEC = 0.008
BOUNDARY_OK_EPS_SEC = 0.015
OVERLAP_EPS_SEC = 0.012
TAIL_PEAK_PAD_SEC = 0.45
MIN_RISE_AFTER_INNER_VALLEY_DB = 3.0
MAX_EXTEND_END_SEC = 0.60
MAX_SHORTEN_END_SEC = 0.45
MAX_SHORTEN_END_SYLLABLE_SEC = 0.65
MIN_PEAK_GAP_SEC = 0.10
NEXT_WORD_SEARCH_SEC = 0.70
MISPLACED_TAIL_PAD_SEC = 0.42
MIN_SYLLABLE_OFFSET_SEC = 0.25
# Golden Standard
ANCHOR_PAD_SEC = 0.10
SCAN_WINDOW_SEC = 1.0
SMOOTH_KERNEL = 3
W_VALLEY_DEPTH = 100.0
W_WHISPER_DIST = 2.0
MIN_VALLEY_QUIET_SEC = 0.05
# Syllable-target valley (타이밍 맞추기 — word A 발화 길이 힌트)
USE_SYLLABLE_TARGET = True
SEC_PER_SYLLABLE = 0.14
SYLLABLE_COUNT_MIN = 1
SYLLABLE_COUNT_MAX = 12
WIN_LO_SEC = 0.28
WIN_HI_SEC = 0.28
SYLLABLE_OVERSHOOT_RATIO = 1.35
SYLLABLE_DURATION_ABS_SLACK = 0.08
SYLLABLE_STUCK_MIN_RATIO = 1.10
SYLLABLE_DURATION_UNDERSHOOT_PER_CHAR = 0.03
RATE_GLOBAL_MIN = 0.08
RATE_GLOBAL_MAX = 0.22
RATE_GLOBAL_MIN_CHARS = 20
VALLEY_ALIGN_ENGINE_REV = "rate-global-v12"
T_TARGET_FLOOR_SEC = 0.12
W_TARGET_DIST = 2.5
SYLLABLE_OK_EPS_SEC = 0.08
SYLLABLE_DIP_RELAX_DB = 1.5
B_ONSET_SEARCH_SEC = 0.45
B_ONSET_VALLEY_MARGIN_SEC = 0.06

ContaminationKind = Literal[
    "ok",
    "a_tail_invades_b",
    "a_tail_eats_b_head",
    "a_tail_stolen",
    "whisper_stuck_inner",
]


class _RateScale:
    """미디어 전역 rate_global — 칩/줄 타임스탬프와 무관한 글자당 기대 시간."""

    __slots__ = ("rate",)

    def __init__(self, rate: float) -> None:
        self.rate = float(rate)

    @classmethod
    def fallback(cls) -> _RateScale:
        return cls(SEC_PER_SYLLABLE)

    def expected_duration(self, word: dict[str, Any]) -> float:
        return _syllable_count(word) * self.rate

    def min_duration(self, word: dict[str, Any]) -> float:
        n = _syllable_count(word)
        return max(MIN_WORD_SEC, n * self.rate - n * SYLLABLE_DURATION_UNDERSHOOT_PER_CHAR)

    def max_duration(self, word: dict[str, Any]) -> float:
        """rate_global 기준 상한 — t_target(글자×rate) + SYLLABLE_OK_EPS."""
        exp = self.expected_duration(word)
        return exp + SYLLABLE_OK_EPS_SEC

    def t_target_end(self, word: dict[str, Any], start_sec: float) -> float:
        n = _syllable_count(word)
        t = float(start_sec) + n * self.rate
        return max(t, float(start_sec) + T_TARGET_FLOOR_SEC)

    def min_boundary(self, word: dict[str, Any], start_sec: float) -> float:
        return float(start_sec) + self.min_duration(word)


def _compute_rate_global(
    flat: list[tuple[int, int, dict[str, Any]]],
    db_frames: np.ndarray,
    hop_sec: float,
    speech_thresh_db: float,
) -> tuple[float, dict[str, Any]]:
    """
    VAD 음성 구간 / spoken 글자 수 — cue·줄 duration 미사용.
    """
    meta: dict[str, Any] = {"fallback": False}
    total_chars = sum(_syllable_count(w) for _, _, w in flat)
    meta["spoken_char_count"] = total_chars
    if total_chars < RATE_GLOBAL_MIN_CHARS:
        meta["fallback"] = True
        meta["rate_global"] = SEC_PER_SYLLABLE
        return SEC_PER_SYLLABLE, meta

    speech_frames = int(np.sum(db_frames >= speech_thresh_db))
    speech_sec = float(speech_frames * hop_sec)
    meta["vad_speech_sec"] = _round_sec(speech_sec)
    if speech_sec <= 0 or total_chars <= 0:
        meta["fallback"] = True
        meta["rate_global"] = SEC_PER_SYLLABLE
        return SEC_PER_SYLLABLE, meta

    raw = speech_sec / float(total_chars)
    rate = max(RATE_GLOBAL_MIN, min(RATE_GLOBAL_MAX, raw))
    meta["rate_global_raw"] = _round_sec(raw)
    meta["rate_global"] = _round_sec(rate)
    meta["fallback"] = abs(rate - raw) > 1e-9
    return rate, meta


def _round_sec(v: float) -> float:
    return round(float(v), 3)


def _syllable_count(word: dict[str, Any]) -> int:
    """한글·CJK·라틴 visible 글자 수 — 발화 길이 추정용."""
    raw = str(word.get("word", "") or "").strip()
    if not raw:
        return SYLLABLE_COUNT_MIN
    cleaned = re.sub(r"[\s\-–—…]+", "", raw)
    count = 0
    for ch in cleaned:
        o = ord(ch)
        if 0xAC00 <= o <= 0xD7A3:
            count += 1
        elif 0x4E00 <= o <= 0x9FFF or 0x3040 <= o <= 0x30FF:
            count += 1
        elif ch.isalpha() and o < 128:
            count += 1
    if count <= 0:
        count = max(1, len(cleaned))
    return max(SYLLABLE_COUNT_MIN, min(SYLLABLE_COUNT_MAX, count))


def _syllable_target_sec(
    word: dict[str, Any],
    a_s: float,
    scale: _RateScale | None = None,
) -> float:
    sc = scale or _RateScale.fallback()
    return sc.t_target_end(word, a_s)


def _word_duration_sec(word: dict[str, Any]) -> float:
    try:
        return float(word.get("end", 0)) - float(word.get("start", 0))
    except (TypeError, ValueError):
        return 0.0


def _expected_word_duration_sec(
    word: dict[str, Any],
    scale: _RateScale | None = None,
) -> float:
    sc = scale or _RateScale.fallback()
    return sc.expected_duration(word)


def _min_acceptable_word_duration_sec(
    word: dict[str, Any],
    scale: _RateScale | None = None,
) -> float:
    sc = scale or _RateScale.fallback()
    return sc.min_duration(word)


def _min_boundary_for_word(
    word: dict[str, Any],
    a_s: float,
    scale: _RateScale | None = None,
) -> float:
    sc = scale or _RateScale.fallback()
    return sc.min_boundary(word, a_s)


def _whisper_duration_too_long(
    word: dict[str, Any],
    scale: _RateScale | None = None,
) -> bool:
    """Whisper 구간이 글자×rate_global + 여유(SYLLABLE_OK_EPS)를 초과."""
    sc = scale or _RateScale.fallback()
    actual = _word_duration_sec(word)
    return actual > sc.max_duration(word) + 1e-6


def _whisper_duration_too_short(
    word: dict[str, Any],
    scale: _RateScale | None = None,
) -> bool:
    sc = scale or _RateScale.fallback()
    actual = _word_duration_sec(word)
    return actual + 1e-6 < sc.min_duration(word)


def _might_be_whisper_stuck_at_inner_valley(
    word_a: dict[str, Any],
    a_e: float,
    b_s: float,
    scale: _RateScale | None = None,
) -> bool:
    if abs(float(a_e) - float(b_s)) > BOUNDARY_OK_EPS_SEC:
        return False
    sc = scale or _RateScale.fallback()
    expected = sc.expected_duration(word_a)
    if expected <= 0:
        return False
    return _word_duration_sec(word_a) > expected * SYLLABLE_STUCK_MIN_RATIO + 1e-6


def _duration_still_too_long_after_boundary(
    word: dict[str, Any],
    a_s: float,
    boundary: float,
    scale: _RateScale | None = None,
) -> bool:
    sc = scale or _RateScale.fallback()
    return float(boundary) - float(a_s) > sc.max_duration(word) + 1e-6


def _pair_position_flags(pair_index: int, pairs_total: int) -> dict[str, bool]:
    """첫 칩(A)·마지막 칩(B) 위치 — 침범 유형별 필터."""
    return {
        "is_first_word_a": pair_index == 0,
        "is_last_word_b": pair_index >= pairs_total - 1,
    }


def _classify_pair_contamination(
    word_a: dict[str, Any],
    word_b: dict[str, Any],
    *,
    a_s: float,
    a_e: float,
    b_s: float,
    scale: _RateScale,
    pos: dict[str, bool],
    might_be_stuck: bool,
    overlap: bool,
    tail_peak_after_whisper: float | None = None,
) -> ContaminationKind:
    """
    중간 칩 4유형 + whisper stuck.
    첫 칩(A): 1번(앞 꼬리 침범) 불가 — B start 침범(1)은 가능.
    마지막 칩(B): 2·4번(B end 관련) 불가 — A end(2·4)는 가능.
    """
    a_long = _whisper_duration_too_long(word_a, scale)
    a_short = _whisper_duration_too_short(word_a, scale)
    b_long = _whisper_duration_too_long(word_b, scale)

    if might_be_stuck:
        t_target = scale.t_target_end(word_a, a_s)
        if a_long and float(a_e) > float(t_target) + WIN_HI_SEC:
            return "a_tail_eats_b_head"
        tail_after = (
            tail_peak_after_whisper is not None
            and float(tail_peak_after_whisper) > float(a_e) + 0.06
        )
        if tail_after:
            return "whisper_stuck_inner"
        if a_long and float(a_e) > float(t_target) + SYLLABLE_OK_EPS_SEC:
            return "a_tail_eats_b_head"
        return "whisper_stuck_inner"

    allow_a_end_fix = True
    allow_b_start_fix = True

    if allow_a_end_fix and a_long and not a_short:
        return "a_tail_eats_b_head"

    if overlap and a_long:
        return "a_tail_eats_b_head"

    if (
        allow_a_end_fix
        and a_short
        and not a_long
        and _word_duration_sec(word_a) + SYLLABLE_OK_EPS_SEC
        < scale.expected_duration(word_a)
    ):
        return "a_tail_stolen"

    if (
        allow_b_start_fix
        and not pos["is_last_word_b"]
        and b_long
        and not a_long
        and abs(float(a_e) - float(b_s)) <= BOUNDARY_OK_EPS_SEC + 0.06
    ):
        return "a_tail_invades_b"

    if allow_b_start_fix and b_long and not a_long and overlap:
        return "a_tail_invades_b"

    if overlap and a_long:
        return "a_tail_eats_b_head"

    return "ok"


def _pick_best_valley_candidate(
    candidates: list[tuple[float, float, float, float]],
    *,
    a_s: float,
    t_target: float,
    word: dict[str, Any],
) -> tuple[float, float, float, float] | None:
    """
    V 후보 중 선택 — min(글자×0.11) 미만이면 t_target 왼쪽 V 버리고 오른쪽 우선.
    """
    if not candidates:
        return None
    min_b = _min_boundary_for_word(word, a_s)

    def rank(row: tuple[float, float, float, float]) -> tuple[float, float]:
        vt, _vdb, dl, dr = row
        return (abs(vt - t_target), -min(dl, dr))

    viable = [c for c in candidates if c[0] >= min_b - 1e-6]
    if viable:
        return min(viable, key=rank)

    too_short_left = [c for c in candidates if c[0] < min_b - 1e-6 and c[0] < float(t_target) - 1e-6]
    if too_short_left:
        right_of_target = [c for c in candidates if c[0] >= float(t_target) - 1e-6]
        if right_of_target:
            return min(right_of_target, key=rank)

    return min(candidates, key=rank)


def _resolve_overshoot_boundary(
    smooth: np.ndarray,
    hop_sec: float,
    dur_max: float,
    speech_thresh_db: float,
    *,
    word_a: dict[str, Any],
    a_s: float,
    b_s: float,
    t_target: float,
) -> tuple[float, float, float, float] | None:
    """
    글자수×0.14 초과 — golden 우회, t_target±WIN 안에서만 V 또는 최저 볼륨.
    다음 단어 peak/onset 쪽으로 밀리지 않게 anchor 상한을 t_target+WIN_HI 로 고정.
    """
    lo_t = max(float(a_s) + hop_sec * 2, float(t_target) - WIN_LO_SEC)
    hi_t = min(float(t_target) + WIN_HI_SEC, float(b_s) + 0.04, dur_max)
    if hi_t <= lo_t + hop_sec:
        hi_t = min(float(t_target) + WIN_HI_SEC, dur_max)
    if hi_t <= lo_t + hop_sec:
        return None

    k_scan0 = max(0, int(math.floor((float(a_s) - 0.05) / hop_sec)))
    k_scan1 = min(int(smooth.size) - 2, int(math.ceil((hi_t + 0.06) / hop_sec)))
    pick = _pick_valley_in_syllable_window(
        smooth,
        hop_sec,
        dur_max,
        speech_thresh_db,
        t_target=t_target,
        valley_lo_t=lo_t,
        anchor_b=hi_t,
        left_ref=float(a_s),
        k_scan0=k_scan0,
        k_scan1=k_scan1,
        b_onset_peak=None,
        a_s=a_s,
        word=word_a,
        enforce_min_duration=True,
    )
    if pick is None:
        k_lo = max(k_scan0, int(math.floor(lo_t / hop_sec)))
        k_hi = min(k_scan1, int(math.ceil(hi_t / hop_sec)))
        pick = _force_lowest_volume_near_target(
            smooth,
            hop_sec,
            lo_t=lo_t,
            hi_t=hi_t,
            t_target=t_target,
            k_lo=k_lo,
            k_hi=k_hi,
            word=word_a,
            a_s=a_s,
        )
    if pick is not None:
        vt, vdb, dl, dr = pick
        min_b = _min_boundary_for_word(word_a, a_s)
        if vt < min_b - 1e-6:
            hi_t2 = min(float(t_target) + WIN_HI_SEC, float(b_s) + 0.04, dur_max)
            k_lo2 = max(k_scan0, int(math.floor(max(min_b, t_target) / hop_sec)))
            k_hi2 = min(k_scan1, int(math.ceil(hi_t2 / hop_sec)))
            retry = _force_lowest_volume_near_target(
                smooth,
                hop_sec,
                lo_t=max(min_b, float(t_target)),
                hi_t=hi_t2,
                t_target=t_target,
                k_lo=k_lo2,
                k_hi=k_hi2,
                word=word_a,
                a_s=a_s,
            )
            if retry is not None:
                return retry
    return pick


def _resolve_b_onset_peak(
    smooth: np.ndarray,
    hop_sec: float,
    dur_max: float,
    *,
    a_e: float,
    b_s: float,
    b_e: float,
) -> float | None:
    """B 단어 실제 onset — a_e≈b_s일 때 b_s 구간 peak 오인 방지."""
    b_onset = _peak_time_in_window(
        smooth,
        hop_sec,
        b_s,
        min(dur_max, b_s + B_ONSET_SEARCH_SEC),
        dur_max,
    )
    if b_onset is None or float(b_onset) <= float(a_e) + 0.06:
        onset_lo = _next_peak_search_lo(a_e, b_s)
        b_onset = _peak_time_in_window(
            smooth,
            hop_sec,
            onset_lo,
            min(dur_max, max(b_e, b_s) + NEXT_WORD_SEARCH_SEC),
            dur_max,
        )
    return b_onset


def _duration_at_boundary_too_short(
    word: dict[str, Any],
    a_s: float,
    boundary: float,
    scale: _RateScale,
) -> bool:
    dur = float(boundary) - float(a_s)
    return dur + SYLLABLE_OK_EPS_SEC < scale.expected_duration(word)


def _needs_snap_boundary_to_right_valley(
    smooth: np.ndarray,
    hop_sec: float,
    dur_max: float,
    speech_thresh_db: float,
    db_frames: np.ndarray,
    *,
    word_a: dict[str, Any],
    a_s: float,
    boundary: float,
    tail_peak: float | None,
    next_peak: float | None,
    scale: _RateScale,
    contamination: ContaminationKind,
) -> bool:
    """경계가 peak 위 + (A 짧음/연장) → B onset 전 오른쪽 V 스냅."""
    if contamination == "a_tail_eats_b_head":
        return False
    if not _is_local_peak_at(smooth, hop_sec, boundary, dur_max):
        return False
    if _whisper_duration_too_short(word_a, scale):
        return True
    if contamination in ("a_tail_stolen", "whisper_stuck_inner"):
        return True
    try:
        a_e = float(word_a.get("end", 0))
    except (TypeError, ValueError):
        a_e = float(a_s)
    if float(boundary) > a_e + MIN_ADJUST_SEC:
        return True
    if next_peak is None:
        return False
    return float(next_peak) > float(boundary) + 0.05


def _collect_qualified_valleys(
    smooth: np.ndarray,
    hop_sec: float,
    lo_t: float,
    hi_t: float,
    k_scan0: int,
    k_scan1: int,
    speech_thresh_db: float,
    left_ref: float,
    right_ref: float,
    *,
    min_t: float = 0.0,
) -> list[tuple[float, float, float, float]]:
    if hi_t <= lo_t + hop_sec:
        return []
    k_lo = max(k_scan0, int(math.floor(lo_t / hop_sec)))
    k_hi = min(k_scan1, int(math.ceil(hi_t / hop_sec)))
    if k_hi <= k_lo + 1:
        return []
    seg_full = smooth[k_scan0 : k_scan1 + 1]
    out: list[tuple[float, float, float, float]] = []
    for valley_k, valley_t, valley_db in _enumerate_local_valleys(
        smooth, hop_sec, k_lo, k_hi
    ):
        if valley_t < min_t or valley_t < lo_t or valley_t > hi_t:
            continue
        valley_rel = valley_k - k_scan0
        dip_l, dip_r = _dip_at_frame(
            smooth,
            hop_sec,
            valley_k,
            left_ref,
            right_ref,
            k_scan0,
            k_scan1,
            seg_full,
            valley_rel,
        )
        if min(dip_l, dip_r) < MIN_VALLEY_DIP_DB:
            continue
        if not _valley_has_quiet_run(smooth, hop_sec, valley_k, speech_thresh_db):
            continue
        out.append((float(valley_t), float(valley_db), dip_l, dip_r))
    return out


def _resolve_snap_boundary_to_right_valley(
    smooth: np.ndarray,
    hop_sec: float,
    dur_max: float,
    speech_thresh_db: float,
    *,
    word_a: dict[str, Any],
    a_s: float,
    boundary: float,
    b_s: float,
    b_e: float,
    b_onset_peak: float | None,
) -> tuple[float, float, float, float] | None:
    """
    현재 경계가 peak/조기 cut → B onset 직전까지 qualified V 중 가장 오른쪽.
    t_target±WIN 밖(요즘 0.46 등)도 B onset 전이면 허용.
    """
    onset = b_onset_peak
    if onset is None or float(onset) <= float(boundary) + 0.06:
        onset = _resolve_b_onset_peak(
            smooth,
            hop_sec,
            dur_max,
            a_e=float(boundary),
            b_s=b_s,
            b_e=b_e,
        )
    lo_t = float(boundary) + MIN_ADJUST_SEC
    hi_t = float(b_e)
    if onset is not None:
        hi_t = min(hi_t, float(onset) - B_ONSET_VALLEY_MARGIN_SEC)
    hi_t = min(dur_max, hi_t)
    if hi_t <= lo_t + hop_sec:
        return None

    k_scan0 = max(0, int(math.floor((float(a_s) - 0.05) / hop_sec)))
    k_scan1 = min(int(smooth.size) - 2, int(math.ceil((hi_t + 0.12) / hop_sec)))
    candidates = _collect_qualified_valleys(
        smooth,
        hop_sec,
        lo_t,
        hi_t,
        k_scan0,
        k_scan1,
        speech_thresh_db,
        float(a_s),
        hi_t,
        min_t=lo_t,
    )
    if not candidates:
        return None
    return max(candidates, key=lambda row: row[0])


def _snap_last_word_end_to_right_valley(
    word: dict[str, Any],
    smooth: np.ndarray,
    hop_sec: float,
    dur_max: float,
    speech_thresh_db: float,
    scale: _RateScale,
) -> float | None:
    """마지막 칩 end — peak/조기 cut이면 오른쪽 V까지 연장."""
    try:
        a_s = float(word.get("start", 0))
        a_e = float(word.get("end", 0))
    except (TypeError, ValueError):
        return None
    if a_e <= a_s + MIN_WORD_SEC:
        return None
    t_target = scale.t_target_end(word, a_s)
    on_peak = _is_local_peak_at(smooth, hop_sec, a_e, dur_max)
    too_short = _whisper_duration_too_short(word, scale)
    if not on_peak and not too_short:
        return None
    if _whisper_duration_too_long(word, scale):
        return None

    lo_t = float(a_e) + MIN_ADJUST_SEC
    hi_t = min(
        dur_max,
        float(a_e) + MAX_EXTEND_END_SEC + 0.15,
        float(t_target) + WIN_HI_SEC + 0.20,
        float(a_s) + scale.expected_duration(word) + 0.45,
    )
    if hi_t <= lo_t + hop_sec:
        return None

    k_scan0 = max(0, int(math.floor((a_s - 0.05) / hop_sec)))
    k_scan1 = min(int(smooth.size) - 2, int(math.ceil((hi_t + 0.10) / hop_sec)))
    candidates = _collect_qualified_valleys(
        smooth,
        hop_sec,
        lo_t,
        hi_t,
        k_scan0,
        k_scan1,
        speech_thresh_db,
        a_s,
        hi_t,
        min_t=lo_t,
    )
    if not candidates:
        return None
    vt, _, _, _ = max(candidates, key=lambda row: row[0])
    if vt <= float(a_e) + MIN_ADJUST_SEC:
        return None
    return _round_sec(vt)


def _resolve_extend_tail_boundary(
    smooth: np.ndarray,
    hop_sec: float,
    dur_max: float,
    speech_thresh_db: float,
    *,
    word_a: dict[str, Any],
    a_s: float,
    a_e: float,
    b_s: float,
    b_e: float,
    scale: _RateScale,
    b_onset_peak: float | None = None,
) -> tuple[float, float, float, float] | None:
    """유형 4 — A 꼬리가 B에 뺏김: 현재 end 이후 t_target±WIN 안 오른쪽 V까지 연장."""
    t_target = scale.t_target_end(word_a, a_s)
    min_b = scale.min_boundary(word_a, a_s)

    lo_t = max(float(a_s) + hop_sec * 2, float(a_e) - 0.04)
    hi_cap = float(b_e)
    onset = b_onset_peak
    if onset is None or float(onset) <= float(a_e) + 0.06:
        onset = _resolve_b_onset_peak(
            smooth, hop_sec, dur_max, a_e=a_e, b_s=b_s, b_e=b_e
        )
    if onset is not None:
        hi_cap = min(hi_cap, float(onset) - B_ONSET_VALLEY_MARGIN_SEC)
    hi_t = min(
        hi_cap,
        float(t_target) + WIN_HI_SEC + 0.06,
        max(float(b_s) + NEXT_WORD_SEARCH_SEC, float(t_target) + 0.12),
        dur_max,
    )
    if hi_t <= lo_t + hop_sec:
        return None

    k_scan0 = max(0, int(math.floor((float(a_s) - 0.05) / hop_sec)))
    k_scan1 = min(int(smooth.size) - 2, int(math.ceil((hi_t + 0.10) / hop_sec)))
    seg_full = smooth[k_scan0 : k_scan1 + 1]

    scan_lo = max(lo_t, float(t_target) - WIN_LO_SEC)
    k_lo = max(k_scan0, int(math.floor(scan_lo / hop_sec)))
    k_hi = min(k_scan1, int(math.ceil(hi_t / hop_sec)))
    if k_hi <= k_lo + 1:
        return None

    candidates: list[tuple[float, float, float, float]] = []
    for valley_k, valley_t, valley_db in _enumerate_local_valleys(
        smooth, hop_sec, k_lo, k_hi
    ):
        if valley_t <= float(a_e) + MIN_ADJUST_SEC or valley_t > hi_t:
            continue
        valley_rel = valley_k - k_scan0
        dip_l, dip_r = _dip_at_frame(
            smooth,
            hop_sec,
            valley_k,
            float(a_e),
            hi_cap,
            k_scan0,
            k_scan1,
            seg_full,
            valley_rel,
        )
        depth = min(dip_l, dip_r)
        if depth < MIN_VALLEY_DIP_DB:
            continue
        if not _valley_has_quiet_run(smooth, hop_sec, valley_k, speech_thresh_db):
            continue
        candidates.append((float(valley_t), float(valley_db), dip_l, dip_r))

    if not candidates:
        return _force_lowest_volume_near_target(
            smooth,
            hop_sec,
            lo_t=max(float(a_e) + MIN_ADJUST_SEC, scan_lo),
            hi_t=hi_t,
            t_target=t_target,
            k_lo=k_lo,
            k_hi=k_hi,
            word=None,
            a_s=None,
        )

    viable_min = [c for c in candidates if c[0] >= min_b - 1e-6]
    pool = viable_min if viable_min else candidates

    def _rank(row: tuple[float, float, float, float]) -> tuple[float, float, float]:
        vt, _vdb, dl, dr = row
        return (abs(vt - t_target), -min(dl, dr), -vt)

    vt, vdb, dl, dr = min(pool, key=_rank)
    return vt, vdb, dl, dr


def _resolve_b_start_invasion_boundary(
    smooth: np.ndarray,
    hop_sec: float,
    dur_max: float,
    speech_thresh_db: float,
    *,
    word_a: dict[str, Any],
    word_b: dict[str, Any],
    a_s: float,
    a_e: float,
    b_s: float,
    b_e: float,
    scale: _RateScale,
    b_onset_peak: float | None,
) -> tuple[float, float, float, float] | None:
    """유형 1 — A 꼬리가 B start에 침범: 경계를 오른쪽 V로 (B.start 뒤로)."""
    t_target = scale.t_target_end(word_a, a_s)
    min_b = scale.min_boundary(word_a, a_s)
    lo_t = max(min_b, float(a_e) - 0.04, float(a_s) + hop_sec * 2)
    hi_cap = float(b_e)
    if b_onset_peak is not None:
        hi_cap = min(hi_cap, float(b_onset_peak) - B_ONSET_VALLEY_MARGIN_SEC)
    hi_t = min(hi_cap, float(b_s) + 0.5, float(t_target) + WIN_HI_SEC + 0.08, dur_max)
    if hi_t <= lo_t + hop_sec:
        return None
    k_scan0 = max(0, int(math.floor(lo_t / hop_sec)))
    k_scan1 = min(int(smooth.size) - 2, int(math.ceil(hi_t / hop_sec)))
    pick = _pick_valley_in_syllable_window(
        smooth,
        hop_sec,
        dur_max,
        speech_thresh_db,
        t_target=max(t_target, float(b_s)),
        valley_lo_t=lo_t,
        anchor_b=hi_t,
        left_ref=float(a_s),
        k_scan0=k_scan0,
        k_scan1=k_scan1,
        b_onset_peak=None,
        a_s=a_s,
        word=word_a,
        enforce_min_duration=True,
    )
    if pick is not None:
        return pick
    return _force_lowest_volume_near_target(
        smooth,
        hop_sec,
        lo_t=lo_t,
        hi_t=hi_t,
        t_target=max(t_target, float(b_s)),
        k_lo=k_scan0,
        k_hi=k_scan1,
        word=word_a,
        a_s=a_s,
    )


def _resolve_whisper_stuck_inner_boundary(
    db_frames: np.ndarray,
    smooth: np.ndarray,
    hop_sec: float,
    dur_max: float,
    speech_thresh_db: float,
    *,
    word_a: dict[str, Any],
    a_s: float,
    a_e: float,
    b_s: float,
    b_e: float,
    peak_l: float | None,
    scale: _RateScale,
) -> tuple[float, float, float, float] | None:
    """
    Whisper end/start가 동일 V₁에 박힘 — A tail peak 이후 ~ B 실제 peak 사이
    가장 오른쪽 qualified V(valley) 선택 (V₂ 연장).
    """
    tail_peak = _find_tail_peak_after_whisper_end(
        db_frames,
        hop_sec,
        dur_max,
        speech_thresh_db,
        a_s=a_s,
        a_e=a_e,
        peak_l=peak_l,
    )
    if tail_peak is None:
        tail_peak = float(peak_l if peak_l is not None else a_e)

    b_search_lo = _next_peak_search_lo(a_e, b_s)
    b_peak_e = min(dur_max, max(b_e, b_s) + NEXT_WORD_SEARCH_SEC)
    next_peak = _anchor_peak_back_half(
        smooth,
        hop_sec,
        float(b_s),
        b_peak_e,
        dur_max,
        search_lo=b_search_lo,
    )
    if next_peak is None:
        next_peak = _peak_time_in_window(smooth, hop_sec, b_search_lo, b_peak_e, dur_max)
    if next_peak is None or float(next_peak) <= float(tail_peak) + hop_sec * 2:
        next_peak = min(dur_max, float(b_s) + 0.45)

    lo_t = max(float(a_s) + hop_sec * 2, float(tail_peak) + hop_sec * 2)
    hi_t = min(float(next_peak) - hop_sec * 0.5, float(b_s) + 0.42, dur_max)
    if hi_t <= lo_t + hop_sec:
        hi_t = min(dur_max, float(next_peak) + hop_sec * 0.5)
    if hi_t <= lo_t + hop_sec:
        return None

    pick = _find_valley_sec(
        smooth,
        hop_sec,
        lo_t,
        hi_t,
        dur_max,
        peak_ref_l=tail_peak,
        peak_ref_r=next_peak,
        prefer_rightmost=True,
    )
    if pick is not None:
        vt, vdb, dl, dr = pick
        min_b = scale.min_boundary(word_a, a_s)
        if vt >= min_b - 1e-6:
            return pick
    return None


def _resolve_boundary_for_contamination(
    kind: ContaminationKind,
    smooth: np.ndarray,
    hop_sec: float,
    dur_max: float,
    speech_thresh_db: float,
    *,
    word_a: dict[str, Any],
    word_b: dict[str, Any],
    a_s: float,
    a_e: float,
    b_s: float,
    b_e: float,
    scale: _RateScale,
    b_onset_peak: float | None,
    peak_l: float | None = None,
    db_frames: np.ndarray | None = None,
) -> tuple[float, float, float, float] | None:
    if kind == "whisper_stuck_inner" and db_frames is not None:
        return _resolve_whisper_stuck_inner_boundary(
            db_frames,
            smooth,
            hop_sec,
            dur_max,
            speech_thresh_db,
            word_a=word_a,
            a_s=a_s,
            a_e=a_e,
            b_s=b_s,
            b_e=b_e,
            peak_l=peak_l,
            scale=scale,
        )
    if kind == "a_tail_eats_b_head":
        return _resolve_overshoot_boundary(
            smooth,
            hop_sec,
            dur_max,
            speech_thresh_db,
            word_a=word_a,
            a_s=a_s,
            b_s=b_s,
            t_target=scale.t_target_end(word_a, a_s),
        )
    if kind == "a_tail_stolen":
        return _resolve_extend_tail_boundary(
            smooth,
            hop_sec,
            dur_max,
            speech_thresh_db,
            word_a=word_a,
            a_s=a_s,
            a_e=a_e,
            b_s=b_s,
            b_e=b_e,
            scale=scale,
            b_onset_peak=b_onset_peak,
        )
    if kind == "a_tail_invades_b":
        return _resolve_b_start_invasion_boundary(
            smooth,
            hop_sec,
            dur_max,
            speech_thresh_db,
            word_a=word_a,
            word_b=word_b,
            a_s=a_s,
            a_e=a_e,
            b_s=b_s,
            b_e=b_e,
            scale=scale,
            b_onset_peak=b_onset_peak,
        )
    return None


def _force_lowest_volume_near_target(
    smooth: np.ndarray,
    hop_sec: float,
    *,
    lo_t: float,
    hi_t: float,
    t_target: float,
    k_lo: int,
    k_hi: int,
    word: dict[str, Any] | None = None,
    a_s: float | None = None,
) -> tuple[float, float, float, float] | None:
    """V골 없을 때 — RMS 최저. min duration 미만이면 t_target 오른쪽 구간 우선."""
    min_b: float | None = None
    if word is not None and a_s is not None:
        min_b = _min_boundary_for_word(word, a_s)

    phases: list[tuple[float, float, bool]] = []
    if min_b is not None:
        phases.append((max(lo_t, min_b, float(t_target)), hi_t, True))
        phases.append((max(lo_t, min_b), hi_t, True))
        phases.append((max(lo_t, float(t_target)), hi_t, True))
    phases.append((lo_t, hi_t, False))

    for phase_lo, phase_hi, prefer_right in phases:
        if phase_hi <= phase_lo + hop_sec * 0.5:
            continue
        best_k: int | None = None
        best_key: tuple[float, float] | None = None
        pk0 = max(1, int(math.floor(phase_lo / hop_sec)))
        pk1 = min(int(smooth.size) - 1, int(math.ceil(phase_hi / hop_sec)))
        for k in range(max(k_lo, pk0), min(k_hi, pk1) + 1):
            t = float(k * hop_sec)
            if t < phase_lo or t > phase_hi:
                continue
            db = float(smooth[k])
            key = (db, -t) if prefer_right else (db, abs(t - float(t_target)))
            if best_key is None or key < best_key:
                best_key = key
                best_k = k
        if best_k is not None:
            vt = float(best_k * hop_sec)
            return vt, float(smooth[best_k]), SYLLABLE_DIP_RELAX_DB, SYLLABLE_DIP_RELAX_DB
    return None


def _is_local_peak_at(
    db_frames: np.ndarray,
    hop_sec: float,
    t_sec: float,
    dur_max: float,
) -> bool:
    """경계 시각이 RMS 국소 peak(peak cut)인지."""
    if db_frames.size < 3 or hop_sec <= 0:
        return False
    t_sec = max(0.0, min(dur_max, float(t_sec)))
    k = max(1, min(int(db_frames.size) - 2, int(round(t_sec / hop_sec))))
    cur = float(db_frames[k])
    return cur >= float(db_frames[k - 1]) and cur >= float(db_frames[k + 1])


def _pick_valley_in_syllable_window(
    smooth: np.ndarray,
    hop_sec: float,
    dur_max: float,
    speech_thresh_db: float,
    *,
    t_target: float,
    valley_lo_t: float,
    anchor_b: float,
    left_ref: float,
    k_scan0: int,
    k_scan1: int,
    b_onset_peak: float | None,
    a_s: float | None = None,
    word: dict[str, Any] | None = None,
    enforce_min_duration: bool = False,
) -> tuple[float, float, float, float] | None:
    """
    t_target(=start+n×0.14) 전후 [−WIN_LO, +WIN_HI]:
      1) qualified V → t_target에 가장 가까운 곳 (동점: 깊은 V)
      2) V 없음 → 구간 RMS 최저 (동점: t_target 가까운 쪽)
    """
    lo_t = max(float(valley_lo_t), float(t_target) - WIN_LO_SEC)
    hi_t = min(float(anchor_b) - hop_sec * 0.5, float(t_target) + WIN_HI_SEC)
    if b_onset_peak is not None:
        hi_t = min(hi_t, float(b_onset_peak) - B_ONSET_VALLEY_MARGIN_SEC)
    if a_s is not None:
        lo_t = max(lo_t, float(a_s) + hop_sec * 2)
    if hi_t <= lo_t + hop_sec:
        return None

    k_lo = max(k_scan0, int(math.floor(lo_t / hop_sec)))
    k_hi = min(k_scan1, int(math.ceil(hi_t / hop_sec)))
    if k_hi <= k_lo + 1:
        return None

    seg_full = smooth[k_scan0 : k_scan1 + 1]
    candidates: list[tuple[float, float, float, float]] = []

    for valley_k, valley_t, valley_db in _enumerate_local_valleys(
        smooth, hop_sec, k_lo, k_hi
    ):
        if valley_t < lo_t or valley_t > hi_t:
            continue
        valley_rel = valley_k - k_scan0
        dip_l, dip_r = _dip_at_frame(
            smooth,
            hop_sec,
            valley_k,
            left_ref,
            float(anchor_b),
            k_scan0,
            k_scan1,
            seg_full,
            valley_rel,
        )
        depth = min(dip_l, dip_r)
        if depth < MIN_VALLEY_DIP_DB:
            continue
        if not _valley_has_quiet_run(smooth, hop_sec, valley_k, speech_thresh_db):
            continue
        candidates.append((float(valley_t), float(valley_db), dip_l, dip_r))

    if candidates:
        if enforce_min_duration and word is not None and a_s is not None:
            picked = _pick_best_valley_candidate(
                candidates,
                a_s=float(a_s),
                t_target=t_target,
                word=word,
            )
            if picked is not None:
                return picked
        candidates.sort(
            key=lambda row: (abs(row[0] - t_target), -min(row[2], row[3])),
        )
        vt, vdb, dl, dr = candidates[0]
        return vt, vdb, dl, dr

    return _force_lowest_volume_near_target(
        smooth,
        hop_sec,
        lo_t=lo_t,
        hi_t=hi_t,
        t_target=t_target,
        k_lo=k_lo,
        k_hi=k_hi,
        word=word if enforce_min_duration else None,
        a_s=a_s if enforce_min_duration else None,
    )


def _is_spoken_word(w: dict[str, Any]) -> bool:
    if w.get("is_deleted") or w.get("isDeleted"):
        return False
    if _is_silence_token(w) or _is_pause_or_filler_token(w):
        return False
    return bool(str(w.get("word", "") or "").strip())


def _flatten_spoken(
    cues: list[dict[str, Any]],
) -> list[tuple[int, int, dict[str, Any]]]:
    flat: list[tuple[int, int, dict[str, Any], float]] = []
    for ci, cue in enumerate(cues):
        if not isinstance(cue, dict):
            continue
        raw = cue.get("words")
        if not isinstance(raw, list):
            continue
        for wi, w in enumerate(raw):
            if not isinstance(w, dict) or not _is_spoken_word(w):
                continue
            try:
                ws = float(w.get("start", 0))
            except (TypeError, ValueError):
                continue
            flat.append((ci, wi, w, ws))
    flat.sort(key=lambda x: x[3])
    return [(ci, wi, w) for ci, wi, w, _ in flat]


def _smooth_db_frames(db_frames: np.ndarray, kernel: int = SMOOTH_KERNEL) -> np.ndarray:
    """RMS dB median smoothing — hop 단위 노이즈/ripple 완화 (벡터화)."""
    if kernel <= 1 or db_frames.size == 0:
        return db_frames.astype(np.float64, copy=False)
    k = max(3, kernel | 1)
    x = db_frames.astype(np.float64, copy=False)
    if k == 3:
        pad = np.pad(x, (1, 1), mode="edge")
        return np.median(np.stack([pad[:-2], pad[1:-1], pad[2:]], axis=0), axis=0)
    pad = k // 2
    padded = np.pad(x, (pad, pad), mode="edge")
    from numpy.lib.stride_tricks import sliding_window_view

    return np.median(sliding_window_view(padded, k), axis=-1)


def _anchor_peak_front_half(
    db: np.ndarray,
    hop_sec: float,
    t_s: float,
    t_e: float,
    dur_max: float,
) -> float | None:
    """Word A — 앞쪽 절반 RMS max (되was 알맹이)."""
    mid = t_s + max(hop_sec * 2, (t_e - t_s) * 0.55)
    return _peak_time_in_window(db, hop_sec, t_s, min(t_e, mid), dur_max)


def _anchor_peak_back_half(
    db: np.ndarray,
    hop_sec: float,
    t_s: float,
    t_e: float,
    dur_max: float,
    *,
    search_lo: float | None = None,
) -> float | None:
    """Word B — 뒤쪽 절반 RMS max (예전 알맹이)."""
    lo = float(search_lo if search_lo is not None else t_s + (t_e - t_s) * 0.45)
    lo = max(t_s, min(lo, t_e - hop_sec * 2))
    return _peak_time_in_window(db, hop_sec, lo, t_e, dur_max)


def _valley_has_quiet_run(
    db: np.ndarray,
    hop_sec: float,
    valley_k: int,
    speech_thresh_db: float,
    min_sec: float = MIN_VALLEY_QUIET_SEC,
) -> bool:
    """골짜기가 최소 시간 이상 저에너지 유지."""
    quiet_db = speech_thresh_db + 2.5
    need_k = max(1, int(math.ceil(min_sec / hop_sec)))
    lo = max(0, valley_k - need_k)
    hi = min(int(db.size) - 1, valley_k + need_k)
    quiet_count = sum(1 for k in range(lo, hi + 1) if float(db[k]) <= quiet_db)
    return quiet_count >= need_k


def _find_golden_scored_boundary(
    db_frames: np.ndarray,
    hop_sec: float,
    dur_max: float,
    speech_thresh_db: float,
    *,
    a_s: float,
    a_e: float,
    b_s: float,
    b_e: float,
    peak_l: float | None,
    search_lo: float,
    search_hi: float,
    smooth_frames: np.ndarray | None = None,
    word_a: dict[str, Any] | None = None,
    scale: _RateScale | None = None,
) -> tuple[float, float, float, float, float, float, float, float | None] | None:
    """
    Anchor A/B + [A~B] 전역 valley 후보 스코어링.
    Returns (boundary_t, valley_db, dip_l, dip_r, anchor_a, anchor_b, score, t_target).
    """
    if db_frames.size == 0 or hop_sec <= 0:
        return None

    smooth = smooth_frames if smooth_frames is not None else _smooth_db_frames(db_frames)
    whisper_mid = (float(a_e) + float(b_s)) * 0.5
    t_target: float | None = None
    if USE_SYLLABLE_TARGET and word_a is not None:
        t_target = _syllable_target_sec(word_a, a_s, scale)
    ref_t = t_target if t_target is not None else whisper_mid
    w_dist = W_TARGET_DIST if t_target is not None else W_WHISPER_DIST

    might_stuck_inner = (
        word_a is not None
        and scale is not None
        and _might_be_whisper_stuck_at_inner_valley(word_a, a_e, b_s, scale)
    )

    anchor_a = _anchor_peak_front_half(smooth, hop_sec, a_s, a_e, dur_max)
    if anchor_a is None:
        anchor_a = _peak_time_in_window(smooth, hop_sec, a_s, a_e, dur_max)
    if anchor_a is None:
        anchor_a = float(peak_l if peak_l is not None else a_s)

    b_search_lo = _next_peak_search_lo(a_e, b_s)
    b_peak_s = float(b_s)
    b_peak_e = min(dur_max, max(b_e, b_s) + NEXT_WORD_SEARCH_SEC)
    if t_target is not None and t_target < float(b_s) - hop_sec * 2:
        onset_lo = max(float(a_s) + hop_sec * 2, t_target - WIN_LO_SEC)
        b_search_lo = min(b_search_lo, onset_lo)
        if abs(float(a_e) - float(b_s)) > BOUNDARY_OK_EPS_SEC:
            b_peak_s = min(b_peak_s, onset_lo)
        b_peak_e = max(b_peak_e, float(b_s) + 0.35)

    if t_target is not None:
        if abs(float(a_e) - float(b_s)) <= BOUNDARY_OK_EPS_SEC and not might_stuck_inner:
            near_b = _peak_time_in_window(
                smooth,
                hop_sec,
                float(b_s) - 0.25,
                min(dur_max, float(b_s) + 0.35),
                dur_max,
            )
            if near_b is not None:
                anchor_b = near_b
            else:
                b_anchor_lo = max(
                    float(a_s) + hop_sec * 2,
                    float(t_target) - WIN_LO_SEC * 0.5,
                )
                anchor_b = _peak_time_in_window(
                    smooth,
                    hop_sec,
                    b_anchor_lo,
                    min(dur_max, max(float(b_e), float(b_s)) + 0.45),
                    dur_max,
                )
        elif might_stuck_inner:
            anchor_b = _anchor_peak_back_half(
                smooth,
                hop_sec,
                b_peak_s,
                b_peak_e,
                dur_max,
                search_lo=b_search_lo,
            )
            if anchor_b is None:
                anchor_b = _peak_time_in_window(
                    smooth,
                    hop_sec,
                    b_search_lo,
                    b_peak_e,
                    dur_max,
                )
        else:
            b_anchor_lo = max(b_search_lo, b_peak_s)
            anchor_b = _peak_time_in_window(
                smooth,
                hop_sec,
                b_anchor_lo,
                min(dur_max, max(b_e, b_s) + 0.40),
                dur_max,
            )
    else:
        anchor_b = _anchor_peak_back_half(
            smooth,
            hop_sec,
            b_peak_s,
            b_peak_e,
            dur_max,
            search_lo=b_search_lo,
        )
    if anchor_b is None:
        anchor_b = _peak_time_in_window(
            smooth,
            hop_sec,
            b_search_lo,
            min(dur_max, b_search_lo + max(0.50, WIN_HI_SEC + WIN_LO_SEC)),
            dur_max,
        )
    if anchor_b is None or float(anchor_b) <= float(anchor_a) + hop_sec * 3:
        return None

    whisper_tail = _find_tail_peak_after_whisper_end(
        db_frames,
        hop_sec,
        dur_max,
        speech_thresh_db,
        a_s=a_s,
        a_e=a_e,
        peak_l=peak_l,
    )
    left_ref = float(anchor_a)
    valley_lo_t = left_ref + hop_sec * 2.0
    if whisper_tail is not None and float(whisper_tail) > left_ref + 0.04:
        left_ref = float(whisper_tail)
        valley_lo_t = max(valley_lo_t, float(whisper_tail) + hop_sec * 2.0)
    if t_target is not None:
        syllable_lo = max(float(a_s) + hop_sec * 2, t_target - WIN_LO_SEC)
        valley_lo_t = min(valley_lo_t, syllable_lo)

    if t_target is not None:
        scan_lo = min(t_target - WIN_LO_SEC, whisper_mid - SCAN_WINDOW_SEC)
        scan_hi = max(t_target + WIN_HI_SEC, whisper_mid + SCAN_WINDOW_SEC)
    else:
        scan_lo = whisper_mid - SCAN_WINDOW_SEC
        scan_hi = whisper_mid + SCAN_WINDOW_SEC

    win_lo = max(
        search_lo,
        float(anchor_a) - ANCHOR_PAD_SEC,
        scan_lo,
        a_s - 0.05,
    )
    win_hi = min(
        search_hi,
        float(anchor_b) + ANCHOR_PAD_SEC,
        scan_hi,
        dur_max,
    )
    win_lo = max(0.0, min(dur_max, win_lo))
    win_hi = max(win_lo + hop_sec * 3, min(dur_max, win_hi))

    k0 = max(1, int(math.floor(valley_lo_t / hop_sec)))
    k1 = min(int(smooth.size) - 2, int(math.floor(float(anchor_b) / hop_sec) - 1))
    k0 = max(k0, int(math.floor(win_lo / hop_sec)))
    k1 = min(k1, int(math.ceil(win_hi / hop_sec)))
    if k1 <= k0 + 1:
        return None

    seg = smooth[k0 : k1 + 1]
    whisper_stuck = abs(float(a_e) - float(b_s)) <= BOUNDARY_OK_EPS_SEC
    b_onset = _peak_time_in_window(
        smooth,
        hop_sec,
        b_s,
        min(dur_max, b_s + B_ONSET_SEARCH_SEC),
        dur_max,
    )
    b_start_on_peak = (
        b_onset is not None
        and abs(float(b_s) - float(b_onset)) <= hop_sec * 2.5
        and _is_local_peak_at(smooth, hop_sec, b_s, dur_max)
    )
    a_end_on_peak = _is_local_peak_at(smooth, hop_sec, a_e, dur_max)
    # might_stuck_inner computed above for anchor_b
    whisper_stuck_rightmost = (
        whisper_stuck
        and not b_start_on_peak
        and not _whisper_duration_too_long(word_a if word_a is not None else {}, scale)
        and not (a_end_on_peak and not might_stuck_inner)
    )

    if t_target is not None and not whisper_stuck_rightmost:
        syllable_pick = _pick_valley_in_syllable_window(
            smooth,
            hop_sec,
            dur_max,
            speech_thresh_db,
            t_target=t_target,
            valley_lo_t=valley_lo_t,
            anchor_b=float(anchor_b),
            left_ref=left_ref,
            k_scan0=k0,
            k_scan1=k1,
            b_onset_peak=b_onset,
            a_s=a_s,
            word=word_a,
        )
        if syllable_pick is not None:
            vt, vdb, dl, dr = syllable_pick
            dist = abs(vt - t_target)
            score = (W_VALLEY_DEPTH * min(dl, dr)) - (W_TARGET_DIST * dist)
            return vt, vdb, dl, dr, left_ref, float(anchor_b), score, t_target

    best: tuple[float, float, float, float, float, float] | None = None
    best_score = -float("inf")
    stuck_candidates: list[tuple[float, float, float, float, float, float]] = []

    for valley_k, valley_t, valley_db in _enumerate_local_valleys(smooth, hop_sec, k0, k1):
        if valley_t < valley_lo_t or valley_t >= float(anchor_b) - hop_sec * 0.5:
            continue
        valley_rel = valley_k - k0
        dip_l, dip_r = _dip_at_frame(
            smooth,
            hop_sec,
            valley_k,
            left_ref,
            float(anchor_b),
            k0,
            k1,
            seg,
            valley_rel,
        )
        depth = min(dip_l, dip_r)
        if depth < MIN_VALLEY_DIP_DB:
            continue
        if not _valley_has_quiet_run(smooth, hop_sec, valley_k, speech_thresh_db):
            continue

        dist = abs(float(valley_t) - ref_t)
        score = (W_VALLEY_DEPTH * depth) - (w_dist * dist)
        entry = (float(valley_t), float(valley_db), dip_l, dip_r, left_ref, float(anchor_b))

        if whisper_stuck_rightmost:
            stuck_candidates.append(entry)

        if score > best_score + 1e-6:
            best_score = score
            best = entry
        elif abs(score - best_score) <= 1e-6 and best is not None:
            if t_target is not None:
                if abs(float(valley_t) - ref_t) < abs(best[0] - ref_t):
                    best = entry
            elif float(valley_t) > best[0]:
                best = entry

    if whisper_stuck_rightmost and stuck_candidates:
        best = max(stuck_candidates, key=lambda row: row[0])
    elif best is None:
        return None
    vt, vdb, dl, dr, lr, ab = best
    return vt, vdb, dl, dr, lr, ab, best_score, t_target


def _peak_time_in_window(
    db_frames: np.ndarray,
    hop_sec: float,
    t_lo: float,
    t_hi: float,
    dur_max: float,
) -> float | None:
    if not (t_hi > t_lo + 1e-6) or db_frames.size == 0:
        return None
    t_lo = max(0.0, min(dur_max, t_lo))
    t_hi = max(t_lo + hop_sec, min(dur_max, t_hi))
    k0 = max(0, int(math.floor(t_lo / hop_sec)))
    k1 = min(int(db_frames.size) - 1, int(math.ceil(t_hi / hop_sec)))
    if k1 <= k0:
        return None
    seg = db_frames[k0 : k1 + 1]
    rel = int(np.argmax(seg))
    return float((k0 + rel) * hop_sec)


def _enumerate_local_peaks(
    db_frames: np.ndarray,
    hop_sec: float,
    k0: int,
    k1: int,
) -> list[tuple[int, float]]:
    """국소 최대 (frame_idx, time_sec)."""
    out: list[tuple[int, float]] = []
    if k1 <= k0 + 1:
        return out
    for k in range(k0 + 1, k1):
        cur = float(db_frames[k])
        if cur >= float(db_frames[k - 1]) and cur >= float(db_frames[k + 1]):
            out.append((k, float(k * hop_sec)))
    return out


def _significant_local_peaks(
    db_frames: np.ndarray,
    hop_sec: float,
    k0: int,
    k1: int,
    min_db: float,
    min_gap_sec: float = MIN_PEAK_GAP_SEC,
) -> list[tuple[int, float]]:
    """RMS 국소 peak — 최소 간격으로 음절 단위만 유지."""
    raw = _enumerate_local_peaks(db_frames, hop_sec, k0, k1)
    kept: list[tuple[int, float]] = []
    min_gap_k = max(1, int(min_gap_sec / hop_sec))
    for k, t in raw:
        if float(db_frames[k]) < min_db:
            continue
        if kept and k - kept[-1][0] < min_gap_k:
            if float(db_frames[k]) > float(db_frames[kept[-1][0]]):
                kept[-1] = (k, t)
            continue
        kept.append((k, t))
    return kept


def _rightmost_local_peak_sec(
    db_frames: np.ndarray,
    hop_sec: float,
    t_lo: float,
    t_hi: float,
    dur_max: float,
    speech_thresh_db: float,
) -> float | None:
    """구간 내 마지막(가장 오른쪽) 국소 피크 — 꼬리 음절 포함."""
    if not (t_hi > t_lo + 1e-6) or db_frames.size == 0 or hop_sec <= 0:
        return None
    t_lo = max(0.0, min(dur_max, t_lo))
    t_hi = max(t_lo + hop_sec * 3, min(dur_max, t_hi))
    k0 = max(1, int(math.floor(t_lo / hop_sec)))
    k1 = min(int(db_frames.size) - 2, int(math.ceil(t_hi / hop_sec)))
    if k1 <= k0:
        return _peak_time_in_window(db_frames, hop_sec, t_lo, t_hi, dur_max)

    peak_db = speech_thresh_db + 1.5
    last_k: int | None = None
    for k in range(k0, k1 + 1):
        cur = float(db_frames[k])
        if cur < peak_db:
            continue
        left = float(db_frames[k - 1])
        right = float(db_frames[k + 1])
        if cur >= left and cur >= right:
            last_k = k
    if last_k is not None:
        return float(last_k * hop_sec)
    return _peak_time_in_window(db_frames, hop_sec, t_lo, t_hi, dur_max)


def _dip_at_frame(
    db_frames: np.ndarray,
    hop_sec: float,
    valley_k: int,
    peak_ref_l: float | None,
    peak_ref_r: float | None,
    k0: int,
    k1: int,
    seg: np.ndarray,
    valley_rel: int,
) -> tuple[float, float]:
    valley_db = float(db_frames[valley_k])
    if peak_ref_l is not None and peak_ref_r is not None:
        k_pl = max(0, min(int(db_frames.size) - 1, int(round(peak_ref_l / hop_sec))))
        k_pr = max(0, min(int(db_frames.size) - 1, int(round(peak_ref_r / hop_sec))))
        dip_l = float(db_frames[k_pl]) - valley_db
        dip_r = float(db_frames[k_pr]) - valley_db
    else:
        left_peak = float(np.max(seg[: valley_rel + 1]))
        right_peak = float(np.max(seg[valley_rel:]))
        dip_l = left_peak - valley_db
        dip_r = right_peak - valley_db
    return dip_l, dip_r


def _enumerate_local_valleys(
    db_frames: np.ndarray,
    hop_sec: float,
    k0: int,
    k1: int,
) -> list[tuple[int, float, float]]:
    """국소 최소 (frame_idx, time_sec, db)."""
    out: list[tuple[int, float, float]] = []
    if k1 <= k0 + 1:
        return out
    for k in range(k0 + 1, k1):
        cur = float(db_frames[k])
        if cur <= float(db_frames[k - 1]) and cur <= float(db_frames[k + 1]):
            out.append((k, float(k * hop_sec), cur))
    return out


def _next_peak_search_lo(a_e: float, b_s: float) -> float:
    """Whisper end≈start일 때만 b_s+offset — 블록 간격이 있으면 짧은 마진."""
    base = min(a_e, b_s)
    if abs(a_e - b_s) <= 0.04:
        return max(a_e, b_s) + MIN_SYLLABLE_OFFSET_SEC
    return base + 0.06


def _is_real_valley_at_boundary(
    db_frames: np.ndarray,
    hop_sec: float,
    dur_max: float,
    speech_thresh_db: float,
    boundary_sec: float,
    tail_peak: float | None,
    next_peak: float | None,
) -> bool:
    """파형상 boundary가 양쪽 peak 사이 qualified valley인지."""
    if db_frames.size == 0 or hop_sec <= 0:
        return False
    boundary_sec = max(0.0, min(dur_max, float(boundary_sec)))
    k_v = max(1, min(int(db_frames.size) - 2, int(round(boundary_sec / hop_sec))))
    valley_db = float(db_frames[k_v])

    ref_l = float(tail_peak if tail_peak is not None else boundary_sec - 0.12)
    ref_r = float(next_peak if next_peak is not None else boundary_sec + 0.12)
    k_l = max(0, min(int(db_frames.size) - 1, int(round(ref_l / hop_sec))))
    k_r = max(0, min(int(db_frames.size) - 1, int(round(ref_r / hop_sec))))
    if k_l > k_v:
        k_l = max(0, k_v - 1)
    if k_r < k_v:
        k_r = min(int(db_frames.size) - 1, k_v + 1)

    left_peak_db = float(np.max(db_frames[k_l : k_v + 1]))
    right_peak_db = float(np.max(db_frames[k_v : k_r + 1]))
    dip_l = left_peak_db - valley_db
    dip_r = right_peak_db - valley_db
    if min(dip_l, dip_r) < MIN_VALLEY_DIP_DB:
        return False

    if k_r > k_v + 1:
        rise = float(np.max(db_frames[k_v + 1 : k_r + 1])) - valley_db
        if rise < MIN_RISE_AFTER_INNER_VALLEY_DB:
            return False
    return True


def _has_speech_between_boundary_and_next_peak(
    db_frames: np.ndarray,
    hop_sec: float,
    speech_thresh_db: float,
    boundary_sec: float,
    next_peak: float | None,
) -> bool:
    """boundary ~ next_peak 사이 유의미한 에너지 = 습니다 등이 아직 다음 단어 쪽에 남음."""
    if next_peak is None or db_frames.size == 0 or hop_sec <= 0:
        return False
    if float(next_peak) <= float(boundary_sec) + 0.05:
        return False
    k0 = max(0, int(math.floor(float(boundary_sec) / hop_sec)) + 1)
    k1 = min(int(db_frames.size) - 1, int(math.ceil(float(next_peak) / hop_sec)))
    if k1 <= k0:
        return False
    seg = db_frames[k0 : k1 + 1]
    return bool(seg.size > 0 and float(np.max(seg)) >= speech_thresh_db + 2.0)


def _find_tail_peak_after_whisper_end(
    db_frames: np.ndarray,
    hop_sec: float,
    dur_max: float,
    speech_thresh_db: float,
    *,
    a_s: float,
    a_e: float,
    peak_l: float | None,
) -> float | None:
    """
    Whisper end(a_e) 뒤 꼬리 음절 peak(습니다) — [peak_l, a_e+pad] 스캔.
    a_e 구간 안 argmax(peak_l)만으로는 절대 못 잡음.
    """
    if db_frames.size == 0 or hop_sec <= 0:
        return None
    anchor = float(peak_l if peak_l is not None else a_s)
    t_lo = max(0.0, anchor + hop_sec * 0.5)
    t_hi = min(dur_max, float(a_e) + TAIL_PEAK_PAD_SEC)
    if t_hi <= t_lo + hop_sec * 2:
        return None

    k0 = max(1, int(math.floor(t_lo / hop_sec)))
    k1 = min(int(db_frames.size) - 2, int(math.ceil(t_hi / hop_sec)))
    min_db = speech_thresh_db + 0.8
    sig = _significant_local_peaks(db_frames, hop_sec, k0, k1, min_db, MIN_PEAK_GAP_SEC * 0.8)
    after_anchor = [t for _k, t in sig if t > anchor + hop_sec * 0.4]
    if after_anchor:
        return after_anchor[-1]
    return _rightmost_local_peak_sec(
        db_frames,
        hop_sec,
        t_lo,
        t_hi,
        dur_max,
        speech_thresh_db,
    )


def _resolve_inter_word_peaks(
    db_frames: np.ndarray,
    hop_sec: float,
    dur_max: float,
    speech_thresh_db: float,
    *,
    a_s: float,
    a_e: float,
    b_s: float,
    b_e: float,
    peak_l: float | None,
) -> tuple[float | None, float | None]:
    """
    b_s(Whisper) 무시 — [a_s, b_e+여유] 파형에서
    꼬리 peak(습니다) / 다음 단어 peak(예전) 분리.
    """
    if db_frames.size == 0 or hop_sec <= 0:
        return None, None

    scan_lo = max(0.0, min(a_s, a_e) - 0.03)
    scan_hi = min(dur_max, max(a_e, b_s) + NEXT_WORD_SEARCH_SEC)

    k0 = max(1, int(math.floor(scan_lo / hop_sec)))
    k1 = min(int(db_frames.size) - 2, int(math.ceil(scan_hi / hop_sec)))
    min_db = speech_thresh_db + 1.0
    sig = _significant_local_peaks(db_frames, hop_sec, k0, k1, min_db)

    anchor = float(peak_l if peak_l is not None else a_s)
    after_anchor = [t for _k, t in sig if t > anchor + hop_sec * 0.5]

    cut_line = min(a_e, b_s) - 0.06
    whisper_line = max(a_e, b_s)
    next_search_lo = _next_peak_search_lo(a_e, b_s)

    tail_from_offset = [t for t in after_anchor if t >= cut_line and t < next_search_lo]
    next_from_offset = [t for t in after_anchor if t >= next_search_lo]

    if tail_from_offset and next_from_offset:
        return tail_from_offset[-1], next_from_offset[0]

    peaks_after_cut = [t for t in after_anchor if t >= cut_line]

    if (
        len(peaks_after_cut) >= 1
        and peaks_after_cut[0] > whisper_line - 0.02
        and (
            len(peaks_after_cut) == 1
            or peaks_after_cut[1] - peaks_after_cut[0] < 0.12
        )
    ):
        return anchor, peaks_after_cut[0]

    if len(peaks_after_cut) >= 2:
        tail_peak = peaks_after_cut[0]
        next_peak = _peak_time_in_window(
            db_frames,
            hop_sec,
            max(tail_peak + 0.06, next_search_lo),
            min(dur_max, max(tail_peak + 0.55, next_search_lo + 0.45)),
            dur_max,
        )
        if next_peak is None or next_peak <= tail_peak + hop_sec * 2:
            next_cands = [t for t in peaks_after_cut[1:] if t >= tail_peak + 0.12]
            next_peak = next_cands[0] if next_cands else peaks_after_cut[1]
        if next_peak is not None and float(next_peak) < next_search_lo:
            further = _peak_time_in_window(
                db_frames,
                hop_sec,
                next_search_lo,
                min(dur_max, next_search_lo + 0.45),
                dur_max,
            )
            if further is not None:
                next_peak = further
        return tail_peak, next_peak

    if len(peaks_after_cut) == 1:
        lone = peaks_after_cut[0]
        if lone <= max(a_e, b_s) + MISPLACED_TAIL_PAD_SEC:
            further_lo = lone + MIN_PEAK_GAP_SEC
            kf0 = max(1, int(math.floor(further_lo / hop_sec)))
            kf1 = k1
            further = _significant_local_peaks(db_frames, hop_sec, kf0, kf1, min_db)
            further_t = [t for _k, t in further if t > lone + hop_sec]
            if further_t:
                return lone, further_t[0]
        return anchor, lone

    if len(after_anchor) >= 1:
        return anchor, after_anchor[0]

    peak_r = _peak_time_in_window(
        db_frames,
        hop_sec,
        next_search_lo,
        min(dur_max, next_search_lo + 0.45),
        dur_max,
    )
    tail = _rightmost_local_peak_sec(
        db_frames,
        hop_sec,
        max(a_s, anchor),
        min(dur_max, max(a_e, b_s) + TAIL_PEAK_PAD_SEC),
        dur_max,
        speech_thresh_db,
    )
    if tail is not None and peak_r is not None and tail < peak_r - hop_sec * 3:
        return tail, peak_r
    return peak_l, peak_r


def _finalize_tail_and_next_peaks(
    db_frames: np.ndarray,
    hop_sec: float,
    dur_max: float,
    speech_thresh_db: float,
    *,
    a_s: float,
    a_e: float,
    b_s: float,
    peak_l: float | None,
    tail_peak: float | None,
    next_peak: float | None,
) -> tuple[float | None, float | None]:
    """Whisper end 뒤 습니다 peak를 tail로 강제, next는 그 뒤에서 탐색."""
    whisper_tail = _find_tail_peak_after_whisper_end(
        db_frames,
        hop_sec,
        dur_max,
        speech_thresh_db,
        a_s=a_s,
        a_e=a_e,
        peak_l=peak_l,
    )
    next_search_lo = _next_peak_search_lo(a_e, b_s)

    if whisper_tail is not None and float(whisper_tail) > float(peak_l or a_s) + 0.05:
        within_tail_pad = float(whisper_tail) <= float(a_e) + TAIL_PEAK_PAD_SEC
        before_next = (
            next_peak is None
            or float(whisper_tail) <= float(next_peak) - 0.10
        )
        if within_tail_pad and before_next:
            tail_peak = float(whisper_tail)
        need_next = (
            next_peak is None
            or float(next_peak) <= tail_peak + 0.08
            or float(next_peak) < next_search_lo
        )
        if need_next:
            found_next = _peak_time_in_window(
                db_frames,
                hop_sec,
                max(next_search_lo, tail_peak + 0.06),
                min(dur_max, max(next_search_lo + 0.45, tail_peak + 0.55)),
                dur_max,
            )
            if found_next is not None:
                next_peak = float(found_next)

    return tail_peak, next_peak


def _find_boundary_valley_between_peaks(
    db_frames: np.ndarray,
    hop_sec: float,
    dur_max: float,
    speech_thresh_db: float,
    *,
    tail_peak: float,
    next_peak: float,
    search_lo: float,
    search_hi: float,
) -> tuple[float, float, float, float] | None:
    """꼬리 peak ~ 다음 단어 peak 사이 **마지막** qualified V = 경계."""
    if db_frames.size == 0 or hop_sec <= 0:
        return None
    if not (next_peak > tail_peak + hop_sec * 2):
        return None

    valley_lo = max(search_lo, float(tail_peak) + hop_sec * 2.0)
    valley_hi = min(search_hi, float(next_peak) - hop_sec * 0.5)
    valley_lo = max(0.0, min(dur_max, valley_lo))
    valley_hi = max(valley_lo + hop_sec, min(dur_max, valley_hi))

    k0 = max(0, int(math.floor(valley_lo / hop_sec)))
    k1 = min(int(db_frames.size) - 1, int(math.floor(valley_hi / hop_sec)))
    if k1 <= k0:
        return None

    seg = db_frames[k0 : k1 + 1]
    qualified: list[tuple[int, float, float, float, float]] = []
    for valley_k, valley_t, valley_db in _enumerate_local_valleys(db_frames, hop_sec, k0, k1):
        valley_rel = valley_k - k0
        dip_l, dip_r = _dip_at_frame(
            db_frames,
            hop_sec,
            valley_k,
            tail_peak,
            next_peak,
            k0,
            k1,
            seg,
            valley_rel,
        )
        if min(dip_l, dip_r) >= MIN_VALLEY_DIP_DB:
            qualified.append((valley_k, valley_t, valley_db, dip_l, dip_r))

    if qualified:
        _vk, vt, vdb, dl, dr = qualified[-1]
        return vt, vdb, dl, dr

    rise_db = speech_thresh_db + 2.0
    valley_k = k0
    for k in range(k1, k0 - 1, -1):
        if float(db_frames[k]) < rise_db:
            valley_k = k
            break
    else:
        valley_k = k0 + int(np.argmin(seg))

    valley_t = float(valley_k * hop_sec)
    valley_db = float(db_frames[valley_k])
    valley_rel = valley_k - k0
    dip_l, dip_r = _dip_at_frame(
        db_frames,
        hop_sec,
        valley_k,
        tail_peak,
        next_peak,
        k0,
        k1,
        seg,
        valley_rel,
    )
    if min(dip_l, dip_r) < MIN_VALLEY_DIP_DB:
        return None
    return valley_t, valley_db, dip_l, dip_r


def _find_deepest_valley_before_next_peak(
    db_frames: np.ndarray,
    hop_sec: float,
    dur_max: float,
    *,
    a_s: float,
    a_e: float,
    b_s: float,
    b_e: float,
    peak_l: float | None,
    peak_r: float | None,
    speech_thresh_db: float,
    search_lo: float,
    search_hi: float,
    smooth_frames: np.ndarray | None = None,
    word_a: dict[str, Any] | None = None,
    scale: _RateScale | None = None,
) -> tuple[float, float, float, float, float | None, float | None, float | None] | None:
    """Golden Standard scored valley — fallback: legacy peak-pair valley."""
    if db_frames.size == 0 or hop_sec <= 0:
        return None

    golden = _find_golden_scored_boundary(
        db_frames,
        hop_sec,
        dur_max,
        speech_thresh_db,
        a_s=a_s,
        a_e=a_e,
        b_s=b_s,
        b_e=b_e,
        peak_l=peak_l,
        search_lo=search_lo,
        search_hi=search_hi,
        smooth_frames=smooth_frames,
        word_a=word_a,
        scale=scale,
    )
    if golden is not None:
        vt, vdb, dl, dr, tail_ref, next_ref, _score, t_target = golden
        return vt, vdb, dl, dr, float(tail_ref), float(next_ref), t_target

    tail_peak, next_peak = _resolve_inter_word_peaks(
        db_frames,
        hop_sec,
        dur_max,
        speech_thresh_db,
        a_s=a_s,
        a_e=a_e,
        b_s=b_s,
        b_e=b_e,
        peak_l=peak_l,
    )
    tail_peak, next_peak = _finalize_tail_and_next_peaks(
        db_frames,
        hop_sec,
        dur_max,
        speech_thresh_db,
        a_s=a_s,
        a_e=a_e,
        b_s=b_s,
        peak_l=peak_l,
        tail_peak=tail_peak,
        next_peak=next_peak,
    )
    if tail_peak is None or next_peak is None:
        if peak_r is None:
            peak_r = _peak_time_in_window(db_frames, hop_sec, b_s, b_e, dur_max)
        if peak_r is None:
            return None
        tail_peak = float(peak_l if peak_l is not None else a_e)
        next_peak = float(peak_r)

    found = _find_boundary_valley_between_peaks(
        db_frames,
        hop_sec,
        dur_max,
        speech_thresh_db,
        tail_peak=float(tail_peak),
        next_peak=float(next_peak),
        search_lo=search_lo,
        search_hi=search_hi,
    )
    if found is None:
        return None
    vt, vdb, dl, dr = found
    t_target_fb = (
        _syllable_target_sec(word_a, a_s) if USE_SYLLABLE_TARGET and word_a is not None else None
    )
    return vt, vdb, dl, dr, float(tail_peak), (
        float(next_peak) if next_peak is not None else None
    ), t_target_fb


def _find_valley_sec(
    db_frames: np.ndarray,
    hop_sec: float,
    t_lo: float,
    t_hi: float,
    dur_max: float,
    *,
    peak_ref_l: float | None = None,
    peak_ref_r: float | None = None,
    prefer_rightmost: bool = True,
) -> tuple[float, float, float, float] | None:
    """Returns (valley_t, valley_db, dip_l, dip_r). prefer_rightmost=True → 마지막 V."""
    if not (t_hi > t_lo + 1e-6) or db_frames.size == 0 or hop_sec <= 0:
        return None
    t_lo = max(0.0, min(dur_max, t_lo))
    t_hi = max(t_lo + hop_sec, min(dur_max, t_hi))
    k0 = max(0, int(math.floor(t_lo / hop_sec)))
    k1 = min(int(db_frames.size) - 1, int(math.ceil(t_hi / hop_sec)))
    if k1 <= k0 + 1:
        return None
    seg = db_frames[k0 : k1 + 1]

    candidates: list[tuple[int, int]] = []
    for rel in range(1, len(seg) - 1):
        if seg[rel] <= seg[rel - 1] and seg[rel] <= seg[rel + 1]:
            candidates.append((k0 + rel, rel))

    if prefer_rightmost and candidates:
        for valley_k, valley_rel in reversed(candidates):
            dip_l, dip_r = _dip_at_frame(
                db_frames,
                hop_sec,
                valley_k,
                peak_ref_l,
                peak_ref_r,
                k0,
                k1,
                seg,
                valley_rel,
            )
            if min(dip_l, dip_r) >= MIN_VALLEY_DIP_DB:
                return (
                    float(valley_k * hop_sec),
                    float(db_frames[valley_k]),
                    dip_l,
                    dip_r,
                )

    valley_rel = int(np.argmin(seg))
    valley_k = k0 + valley_rel
    valley_db = float(db_frames[valley_k])
    dip_l, dip_r = _dip_at_frame(
        db_frames,
        hop_sec,
        valley_k,
        peak_ref_l,
        peak_ref_r,
        k0,
        k1,
        seg,
        valley_rel,
    )
    if min(dip_l, dip_r) < MIN_VALLEY_DIP_DB:
        return None
    return float(valley_k * hop_sec), valley_db, dip_l, dip_r


def _valid_tail_peak(
    tail_peak: float | None,
    peak_l: float | None,
    peak_r: float | None,
    hop_sec: float,
) -> float | None:
    """다음 단어 onset으로 오인된 피크는 제외."""
    if tail_peak is None:
        return None
    if peak_r is not None and tail_peak >= peak_r - hop_sec * 5:
        return None
    if peak_l is not None and tail_peak <= peak_l + hop_sec * 1.5:
        return None
    return tail_peak


def _valley_search_window(
    *,
    a_s: float,
    a_e: float,
    b_s: float,
    b_e: float,
    search_lo: float,
    search_hi: float,
    peak_l: float | None,
    peak_r: float | None,
    tail_peak: float | None,
    hop_sec: float,
    dur_max: float,
) -> tuple[float, float]:
    """앞 단어 꼬리 ~ 다음 단어 peak 사이 V 탐색."""
    anchor_l = peak_l if peak_l is not None else a_s
    valid_tail = _valid_tail_peak(tail_peak, peak_l, peak_r, hop_sec)
    if valid_tail is not None and valid_tail > anchor_l:
        anchor_l = valid_tail

    anchor_r = peak_r if peak_r is not None else max(b_s, b_e)

    valley_lo = max(search_lo, anchor_l + hop_sec * 0.5)
    valley_hi = min(search_hi, anchor_r - hop_sec * 0.5)

    if valley_hi <= valley_lo + hop_sec * 2:
        overlap_lo = max(search_lo, min(a_s, b_s) - 0.02)
        overlap_hi = min(
            search_hi,
            max(a_e, b_s) + TAIL_PEAK_PAD_SEC,
            anchor_r - hop_sec * 2,
        )
        if peak_r is not None:
            overlap_hi = min(overlap_hi, peak_r - hop_sec * 3)
        valley_lo = max(search_lo, overlap_lo)
        valley_hi = max(valley_lo + hop_sec * 2, overlap_hi)

    valley_lo = max(0.0, min(dur_max, valley_lo))
    valley_hi = max(valley_lo + hop_sec, min(dur_max, valley_hi))
    return valley_lo, valley_hi


def _resync_cue_times(cue: dict[str, Any]) -> None:
    raw = cue.get("words")
    if not isinstance(raw, list) or not raw:
        return
    times: list[tuple[float, float]] = []
    for w in raw:
        if not isinstance(w, dict):
            continue
        try:
            s, e = float(w.get("start", 0)), float(w.get("end", 0))
        except (TypeError, ValueError):
            continue
        times.append((s, e))
    if not times:
        return
    cue["start"] = _round_sec(min(s for s, _ in times))
    cue["end"] = _round_sec(max(e for _, e in times))


def _trim_overshoot_word_end(
    word: dict[str, Any],
    smooth_frames: np.ndarray,
    hop_sec: float,
    dur_max: float,
    speech_thresh_db: float,
    scale: _RateScale,
) -> float | None:
    """마지막 칩 — end만 (유형 2 해당 없음, 과다 길이만 V로 trim)."""
    if not _whisper_duration_too_long(word, scale):
        return None
    try:
        a_s = float(word.get("start", 0))
        a_e = float(word.get("end", 0))
    except (TypeError, ValueError):
        return None
    if a_e <= a_s + MIN_WORD_SEC:
        return None
    t_target = _syllable_target_sec(word, a_s, scale)
    k_scan0 = max(0, int(math.floor((a_s - 0.05) / hop_sec)))
    k_scan1 = min(int(smooth_frames.size) - 2, int(math.ceil((a_e + 0.55) / hop_sec)))
    pick = _pick_valley_in_syllable_window(
        smooth_frames,
        hop_sec,
        dur_max,
        speech_thresh_db,
        t_target=t_target,
        valley_lo_t=a_s + hop_sec * 2,
        anchor_b=min(dur_max, max(a_e, t_target + WIN_HI_SEC) + 0.15),
        left_ref=a_s,
        k_scan0=k_scan0,
        k_scan1=k_scan1,
        b_onset_peak=None,
        a_s=a_s,
        word=word,
        enforce_min_duration=True,
    )
    if pick is None:
        return None
    vt, _, _, _ = pick
    min_b = _min_boundary_for_word(word, a_s, scale)
    boundary = _round_sec(max(min_b, min(dur_max, vt)))
    if boundary >= a_e - MIN_ADJUST_SEC:
        return None
    return boundary


def apply_valley_word_align(
    cues: list[dict[str, Any]],
    media_path: str,
    ffmpeg_exe: str | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """인접 spoken 단어 쌍 — V 바닥 단일 경계. 텍스트 불변."""
    stats: dict[str, Any] = {
        "applied": False,
        "pairs_total": 0,
        "pairs_adjusted": 0,
        "pairs_skipped": 0,
        "skip_reasons": {},
        "max_delta_start_ms": 0.0,
        "max_delta_end_ms": 0.0,
        "patches": [],
        "engine_rev": VALLEY_ALIGN_ENGINE_REV,
    }
    if not cues:
        return cues, stats

    out = deepcopy(cues)
    flat = _flatten_spoken(out)
    if len(flat) < 2:
        stats["skip_reasons"]["too_few_words"] = 1
        return out, stats

    try:
        ff = _resolve_ffmpeg(ffmpeg_exe or str(get_ffmpeg_executable()))
        samples = _decode_mono_f32_16k(media_path, ff)
    except (OSError, RuntimeError) as exc:
        logger.warning("valley align skipped: decode failed: %s", exc)
        stats["skip_reasons"]["decode_failed"] = 1
        return cues, stats

    dur_max = len(samples) / float(SR)
    db_frames, hop_sec, _, _ = _rms_db_frames(samples)
    if db_frames.size == 0 or hop_sec <= 0:
        stats["skip_reasons"]["no_frames"] = 1
        return cues, stats

    speech_thresh = _dynamic_threshold_db(db_frames)
    smooth_frames = _smooth_db_frames(db_frames)
    rate_val, rate_meta = _compute_rate_global(flat, db_frames, hop_sec, speech_thresh)
    scale = _RateScale(rate_val)
    stats["rate_global"] = rate_meta.get("rate_global", _round_sec(rate_val))
    stats["rate_global_meta"] = rate_meta
    stats["pairs_total"] = len(flat) - 1
    pairs_total = stats["pairs_total"]
    patches: list[dict[str, Any]] = []

    for i in range(len(flat) - 1):
        aci, awi, word_a = flat[i]
        bci, bwi, word_b = flat[i + 1]
        pos = _pair_position_flags(i, pairs_total)
        try:
            a_s = float(word_a.get("start", 0))
            a_e = float(word_a.get("end", 0))
            b_s = float(word_b.get("start", 0))
            b_e = float(word_b.get("end", 0))
        except (TypeError, ValueError):
            stats["pairs_skipped"] += 1
            stats["skip_reasons"]["bad_times"] = stats["skip_reasons"].get("bad_times", 0) + 1
            continue
        if not (a_e > a_s and b_e > b_s):
            stats["pairs_skipped"] += 1
            stats["skip_reasons"]["invalid_duration"] = (
                stats["skip_reasons"].get("invalid_duration", 0) + 1
            )
            continue

        overlap = a_e > b_s + OVERLAP_EPS_SEC
        might_be_stuck = _might_be_whisper_stuck_at_inner_valley(word_a, a_e, b_s, scale)
        peak_l = _peak_time_in_window(db_frames, hop_sec, a_s, a_e, dur_max)
        whisper_tail = _find_tail_peak_after_whisper_end(
            db_frames,
            hop_sec,
            dur_max,
            speech_thresh,
            a_s=a_s,
            a_e=a_e,
            peak_l=peak_l,
        )
        contamination = _classify_pair_contamination(
            word_a,
            word_b,
            a_s=a_s,
            a_e=a_e,
            b_s=b_s,
            scale=scale,
            pos=pos,
            might_be_stuck=might_be_stuck,
            overlap=overlap,
            tail_peak_after_whisper=whisper_tail,
        )
        needs_duration_fix = contamination in {
            "a_tail_eats_b_head",
            "a_tail_stolen",
            "a_tail_invades_b",
        }

        search_lo = max(0.0, min(a_s, b_s) - PAD_SEC)
        search_hi = min(
            dur_max,
            max(a_e, b_e) + NEXT_WORD_SEARCH_SEC + PAD_SEC,
        )

        found_raw = _find_deepest_valley_before_next_peak(
            db_frames,
            hop_sec,
            dur_max,
            a_s=a_s,
            a_e=a_e,
            b_s=b_s,
            b_e=b_e,
            peak_l=peak_l,
            peak_r=None,
            speech_thresh_db=speech_thresh,
            search_lo=search_lo,
            search_hi=search_hi,
            smooth_frames=smooth_frames,
            word_a=word_a,
            scale=scale,
        )
        if found_raw is None:
            stats["pairs_skipped"] += 1
            stats["skip_reasons"]["no_valley"] = stats["skip_reasons"].get("no_valley", 0) + 1
            continue

        valley_t, _valley_db, dip_l, dip_r, tail_peak, next_peak, t_target = found_raw
        boundary = _round_sec(max(0.0, min(dur_max, valley_t)))
        b_onset = _resolve_b_onset_peak(
            smooth_frames,
            hop_sec,
            dur_max,
            a_e=a_e,
            b_s=b_s,
            b_e=b_e,
        )

        if contamination != "ok":
            contam_pick = _resolve_boundary_for_contamination(
                contamination,
                smooth_frames,
                hop_sec,
                dur_max,
                speech_thresh,
                word_a=word_a,
                word_b=word_b,
                a_s=a_s,
                a_e=a_e,
                b_s=b_s,
                b_e=b_e,
                scale=scale,
                b_onset_peak=b_onset,
                peak_l=peak_l,
                db_frames=db_frames,
            )
            if contam_pick is not None:
                ob, odb, odl, odr = contam_pick
                min_b = scale.min_boundary(word_a, a_s)
                ob = max(float(ob), float(a_s) + MIN_WORD_SEC)
                golden_still_long = _duration_still_too_long_after_boundary(
                    word_a, a_s, boundary, scale
                )
                apply_contam = False
                if contamination == "a_tail_stolen":
                    apply_contam = ob + MIN_ADJUST_SEC > float(a_e)
                elif ob >= min_b - 1e-6 and (
                    contamination == "whisper_stuck_inner"
                    or golden_still_long
                    or ob + MIN_ADJUST_SEC < float(boundary)
                    or contamination == "a_tail_invades_b"
                ):
                    apply_contam = True
                if apply_contam:
                    boundary = _round_sec(min(dur_max, ob))
                    dip_l, dip_r = odl, odr
                    _valley_db = odb
        elif (
            _whisper_duration_too_short(word_a, scale)
            and float(boundary) + SYLLABLE_OK_EPS_SEC
            < scale.min_boundary(word_a, a_s)
        ):
            ext_pick = _resolve_extend_tail_boundary(
                smooth_frames,
                hop_sec,
                dur_max,
                speech_thresh,
                word_a=word_a,
                a_s=a_s,
                a_e=a_e,
                b_s=b_s,
                b_e=b_e,
                scale=scale,
                b_onset_peak=b_onset,
            )
            if ext_pick is not None:
                ob, odb, odl, odr = ext_pick
                if ob + MIN_ADJUST_SEC > float(a_e):
                    boundary = _round_sec(
                        max(float(a_s) + MIN_WORD_SEC, min(dur_max, ob)),
                    )
                    dip_l, dip_r = odl, odr
                    _valley_db = odb
                    contamination = "a_tail_stolen"
        elif needs_duration_fix and USE_SYLLABLE_TARGET:
            t_fix = t_target if t_target is not None else scale.t_target_end(word_a, a_s)
            golden_boundary = boundary
            overshoot_pick = _resolve_overshoot_boundary(
                smooth_frames,
                hop_sec,
                dur_max,
                speech_thresh,
                word_a=word_a,
                a_s=a_s,
                b_s=b_s,
                t_target=t_fix,
            )
            if overshoot_pick is not None:
                ob, odb, odl, odr = overshoot_pick
                if _duration_still_too_long_after_boundary(word_a, a_s, ob, scale):
                    lo_t = max(float(a_s) + hop_sec * 2, float(t_fix) - WIN_LO_SEC)
                    hi_t = min(float(t_fix) + WIN_HI_SEC, dur_max)
                    k_lo = max(1, int(math.floor(lo_t / hop_sec)))
                    k_hi = min(int(smooth_frames.size) - 2, int(math.ceil(hi_t / hop_sec)))
                    forced = _force_lowest_volume_near_target(
                        smooth_frames,
                        hop_sec,
                        lo_t=lo_t,
                        hi_t=hi_t,
                        t_target=t_fix,
                        k_lo=k_lo,
                        k_hi=k_hi,
                        word=word_a,
                        a_s=a_s,
                    )
                    if forced is not None:
                        ob, odb, odl, odr = forced
                min_b = scale.min_boundary(word_a, a_s)
                ob = max(float(ob), min_b)
                golden_still_long = _duration_still_too_long_after_boundary(
                    word_a, a_s, golden_boundary, scale
                )
                if ob >= min_b - 1e-6 and (
                    golden_still_long
                    or ob + MIN_ADJUST_SEC < float(golden_boundary)
                ):
                    boundary = _round_sec(max(float(a_s) + MIN_WORD_SEC, min(dur_max, ob)))
                    dip_l, dip_r = odl, odr
                    _valley_db = odb

        snapped_right = False
        if _needs_snap_boundary_to_right_valley(
            smooth_frames,
            hop_sec,
            dur_max,
            speech_thresh,
            db_frames,
            word_a=word_a,
            a_s=a_s,
            boundary=boundary,
            tail_peak=tail_peak,
            next_peak=next_peak,
            scale=scale,
            contamination=contamination,
        ):
            snap_pick = _resolve_snap_boundary_to_right_valley(
                smooth_frames,
                hop_sec,
                dur_max,
                speech_thresh,
                word_a=word_a,
                a_s=a_s,
                boundary=boundary,
                b_s=b_s,
                b_e=b_e,
                b_onset_peak=b_onset,
            )
            if snap_pick is not None:
                sb, sdb, sdl, sdr = snap_pick
                if sb > float(boundary) + MIN_ADJUST_SEC:
                    boundary = _round_sec(min(dur_max, sb))
                    dip_l, dip_r = sdl, sdr
                    _valley_db = sdb
                    snapped_right = True
                    if contamination == "ok":
                        contamination = "a_tail_stolen"

        needs_shorten_a = a_e > boundary + OVERLAP_EPS_SEC
        needs_extend_a = a_e + OVERLAP_EPS_SEC < boundary
        needs_b_start = b_s < boundary - OVERLAP_EPS_SEC
        whisper_stuck_at_inner_v = (
            abs(a_e - b_s) <= BOUNDARY_OK_EPS_SEC
            and next_peak is not None
            and float(next_peak) > boundary + 0.12
        )
        speech_after_boundary = _has_speech_between_boundary_and_next_peak(
            db_frames,
            hop_sec,
            speech_thresh,
            boundary,
            next_peak,
        )
        is_real_valley = _is_real_valley_at_boundary(
            db_frames,
            hop_sec,
            dur_max,
            speech_thresh,
            boundary,
            tail_peak,
            next_peak,
        )
        boundary_on_peak = _is_local_peak_at(smooth_frames, hop_sec, boundary, dur_max)
        b_start_on_peak = _is_local_peak_at(smooth_frames, hop_sec, b_s, dur_max)
        a_end_on_peak = _is_local_peak_at(smooth_frames, hop_sec, a_e, dur_max)
        already_ok = (
            contamination == "ok"
            and not might_be_stuck
            and not whisper_stuck_at_inner_v
            and not speech_after_boundary
            and not overlap
            and not needs_shorten_a
            and not needs_extend_a
            and not needs_b_start
            and is_real_valley
            and not boundary_on_peak
            and not (b_start_on_peak and abs(b_s - boundary) <= 0.05)
            and not (a_end_on_peak and abs(a_e - boundary) <= 0.05)
            and abs(a_e - boundary) <= BOUNDARY_OK_EPS_SEC
            and abs(b_s - boundary) <= BOUNDARY_OK_EPS_SEC
        )
        if already_ok:
            stats["pairs_skipped"] += 1
            stats["skip_reasons"]["whisper_ok"] = stats["skip_reasons"].get("whisper_ok", 0) + 1
            continue

        if (
            needs_extend_a
            and boundary > float(b_s) + OVERLAP_EPS_SEC
            and _whisper_duration_too_long(word_b, scale)
            and contamination not in ("whisper_stuck_inner", "a_tail_stolen")
            and not snapped_right
            and abs(float(a_e) - float(b_s)) > BOUNDARY_OK_EPS_SEC + 0.04
        ):
            stats["pairs_skipped"] += 1
            stats["skip_reasons"]["protect_overshoot_b"] = (
                stats["skip_reasons"].get("protect_overshoot_b", 0) + 1
            )
            continue

        if boundary <= a_s + MIN_WORD_SEC - 1e-6:
            stats["pairs_skipped"] += 1
            stats["skip_reasons"]["a_too_short"] = stats["skip_reasons"].get("a_too_short", 0) + 1
            continue
        if boundary >= b_e - MIN_WORD_SEC + 1e-6:
            stats["pairs_skipped"] += 1
            stats["skip_reasons"]["b_too_short"] = stats["skip_reasons"].get("b_too_short", 0) + 1
            continue

        delta_a_extend = max(0.0, boundary - a_e)
        delta_a_shorten = max(0.0, a_e - boundary)
        delta_b = abs(boundary - b_s)
        max_shorten = (
            MAX_SHORTEN_END_SYLLABLE_SEC
            if t_target is not None or needs_duration_fix
            else MAX_SHORTEN_END_SEC
        )
        if needs_duration_fix and contamination == "a_tail_eats_b_head":
            excess = _word_duration_sec(word_a) - scale.expected_duration(word_a)
            max_shorten = max(max_shorten, min(0.85, excess + 0.12))
        if delta_a_extend > MAX_EXTEND_END_SEC or delta_a_shorten > max_shorten:
            stats["pairs_skipped"] += 1
            stats["skip_reasons"]["delta_too_large"] = (
                stats["skip_reasons"].get("delta_too_large", 0) + 1
            )
            continue
        if delta_b > MAX_EXTEND_END_SEC:
            stats["pairs_skipped"] += 1
            stats["skip_reasons"]["delta_too_large"] = (
                stats["skip_reasons"].get("delta_too_large", 0) + 1
            )
            continue
        if (
            delta_a_extend < MIN_ADJUST_SEC
            and delta_a_shorten < MIN_ADJUST_SEC
            and delta_b < MIN_ADJUST_SEC
            and not overlap
            and not needs_shorten_a
            and not needs_extend_a
            and not needs_b_start
            and not snapped_right
        ):
            stats["pairs_skipped"] += 1
            stats["skip_reasons"]["delta_too_small"] = (
                stats["skip_reasons"].get("delta_too_small", 0) + 1
            )
            continue

        word_a["end"] = boundary
        word_b["start"] = boundary
        patches.append(
            {
                "left": {"cue_index": aci, "word_index": awi},
                "right": {"cue_index": bci, "word_index": bwi},
                "boundary_sec": boundary,
                "same_cue": aci == bci,
                "tail_peak_sec": _round_sec(tail_peak) if tail_peak else None,
                "last_left_peak_sec": _round_sec(tail_peak) if tail_peak else None,
                "next_word_peak_sec": _round_sec(next_peak) if next_peak else None,
                "anchor_a_sec": _round_sec(tail_peak) if tail_peak else None,
                "anchor_b_sec": _round_sec(next_peak) if next_peak else None,
                "valley_dip_l_db": _round_sec(dip_l) if dip_l else None,
                "valley_dip_r_db": _round_sec(dip_r) if dip_r else None,
                "syllable_count": _syllable_count(word_a) if USE_SYLLABLE_TARGET else None,
                "syllable_target_sec": _round_sec(t_target) if t_target is not None else None,
                "contamination": contamination,
                "rate_global": stats.get("rate_global"),
            },
        )
        stats["pairs_adjusted"] += 1
        stats["applied"] = True
        stats["max_delta_end_ms"] = max(
            stats["max_delta_end_ms"],
            max(delta_a_extend, delta_a_shorten) * 1000.0,
        )
        stats["max_delta_start_ms"] = max(stats["max_delta_start_ms"], delta_b * 1000.0)

    stats["patches"] = patches

    if flat:
        ci, wi, last_word = flat[-1]
        trim_end = _trim_overshoot_word_end(
            last_word,
            smooth_frames,
            hop_sec,
            dur_max,
            speech_thresh,
            scale,
        )
        snap_end = _snap_last_word_end_to_right_valley(
            last_word,
            smooth_frames,
            hop_sec,
            dur_max,
            speech_thresh,
            scale,
        )
        final_end = trim_end
        if snap_end is not None:
            if final_end is None or snap_end > float(final_end):
                final_end = snap_end
        if final_end is not None:
            last_word["end"] = final_end
            patches.append(
                {
                    "left": {"cue_index": ci, "word_index": wi},
                    "right": None,
                    "boundary_sec": final_end,
                    "same_cue": True,
                    "tail_peak_sec": None,
                    "last_left_peak_sec": None,
                    "next_word_peak_sec": None,
                    "anchor_a_sec": None,
                    "anchor_b_sec": None,
                    "valley_dip_l_db": None,
                    "valley_dip_r_db": None,
                    "syllable_count": _syllable_count(last_word),
                    "syllable_target_sec": _round_sec(
                        _syllable_target_sec(
                            last_word,
                            float(last_word.get("start", 0)),
                            scale,
                        )
                    ),
                    "trim_end_only": True,
                    "snap_end_only": snap_end is not None and (
                        trim_end is None or snap_end > float(trim_end)
                    ),
                },
            )
            stats["pairs_adjusted"] += 1
            stats["applied"] = True

    for cue in out:
        if isinstance(cue, dict):
            _resync_cue_times(cue)

    return out, stats
