"""
Whisper 단어 타임스탬프를 PCM RMS 기반 VAD로 정제 — AutoSubtitle python_sidecar/rms_vad_word_align.py 이식.
"""

from __future__ import annotations

import logging
import math
import subprocess
from pathlib import Path
from typing import Any

import numpy as np

from common.bin_manager import get_ffmpeg_executable
from common.subprocess_util import no_window_creationflags

logger = logging.getLogger(__name__)

SR = 16_000
HOP_MS = 10.0
WIN_MS = 15.0
RMS_EPS = 1e-6
BOTTOM_FRAC = 0.10
DYNAMIC_OFFSET_DB = 8.0
THRESH_DB_MIN = -55.0
THRESH_DB_MAX = -22.0
DEBOUNCE_MIN_SILENCE_SEC = 0.30
DEBOUNCE_MIN_SPEECH_SEC = 0.10
DEBOUNCE_PASSES = 2
SNAP_SEARCH_SEC = 0.35
PREPAD_SEC = 0.04
END_SNAP_MIN_AFTER_START_SEC = 0.055
END_SNAP_FRAC_OF_WHISPER_DUR = 0.22
MIN_SNAPPED_WORD_SEC = 0.06
MIN_SNAPPED_TO_WHISPER_RATIO = 0.36
GAP_INSERT_SILENCE_SEC = 0.30
GAP_BOUNDARY_MIN_SEC = 1e-4
GAP_VALLEY_RISE_DELTA_DB = 4.0
GAP_VALLEY_MIN_DIP_DB = 1.0
GAP_TAIL_DECAY_DB = 5.0
GAP_TAIL_PEAK_WINDOW_SEC = 0.08
GAP_SMOOTH_HALF_FRAMES = 2
GAP_RISE_DELTA_DB = 4.0
GAP_RISE_WINDOW_FRAMES = 4
GAP_FLAT_RANGE_DB = 3.0
MIN_WORD_SEC = 0.05
TIMELINE_PAIR_EPS = 1e-4


def _resolve_ffmpeg(explicit: str | None) -> str:
    if explicit and str(explicit).strip():
        p = Path(explicit)
        if p.is_file():
            return str(p.resolve())
    return str(get_ffmpeg_executable())


def _decode_mono_f32_16k(media_path: str, ffmpeg_exe: str) -> np.ndarray:
    cflags = no_window_creationflags()
    r = subprocess.run(
        [
            ffmpeg_exe,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            media_path,
            "-ac",
            "1",
            "-ar",
            str(SR),
            "-f",
            "f32le",
            "-",
        ],
        capture_output=True,
        timeout=3 * 60 * 60,
        creationflags=cflags,
    )
    if r.returncode != 0:
        err = (r.stderr or b"").decode("utf-8", errors="replace")
        raise RuntimeError(err.strip() or f"ffmpeg decode exit {r.returncode}")
    raw = r.stdout or b""
    if len(raw) < 4:
        raise RuntimeError("ffmpeg produced empty audio")
    n = len(raw) // 4
    return np.frombuffer(raw[: n * 4], dtype=np.float32).copy()


def _rms_db_frames(samples: np.ndarray) -> tuple[np.ndarray, float, int, int]:
    hop = max(1, int(SR * (HOP_MS / 1000.0)))
    win = max(hop, int(SR * (WIN_MS / 1000.0)))
    n = len(samples)
    if n < win:
        return np.array([-100.0], dtype=np.float64), HOP_MS / 1000.0, hop, win
    sq = samples.astype(np.float64) * samples.astype(np.float64)
    cs = np.empty(n + 1, dtype=np.float64)
    cs[0] = 0.0
    np.cumsum(sq, out=cs[1:])
    n_frames = 1 + (n - win) // hop
    out = np.empty(n_frames, dtype=np.float64)
    hop_sec = hop / float(SR)
    for i in range(n_frames):
        s0 = i * hop
        s1 = s0 + win
        mean_sq = (cs[s1] - cs[s0]) / float(win)
        rms = float(math.sqrt(max(mean_sq, 1e-24)))
        out[i] = 20.0 * math.log10(rms + RMS_EPS)
    return out, hop_sec, hop, win


def _dynamic_threshold_db(db_frames: np.ndarray) -> float:
    v = db_frames[np.isfinite(db_frames)]
    if v.size == 0:
        return -40.0
    vs = np.sort(v)
    n10 = max(1, int(math.ceil(vs.size * BOTTOM_FRAC)))
    floor_mean = float(np.mean(vs[:n10]))
    t = floor_mean + DYNAMIC_OFFSET_DB
    return float(max(THRESH_DB_MIN, min(THRESH_DB_MAX, t)))


def _binary_mask(db_frames: np.ndarray, thresh: float) -> np.ndarray:
    return (db_frames > thresh).astype(np.int8)


def _debounce_mask(mask: np.ndarray, hop_sec: float) -> np.ndarray:
    m = mask.astype(np.int8).copy()
    nfr = m.size
    min_sil_fr = max(1, int(math.ceil(DEBOUNCE_MIN_SILENCE_SEC / hop_sec)))
    min_sp_fr = max(1, int(math.ceil(DEBOUNCE_MIN_SPEECH_SEC / hop_sec)))
    for _ in range(DEBOUNCE_PASSES):
        i = 0
        while i < nfr:
            v = int(m[i])
            j = i + 1
            while j < nfr and int(m[j]) == v:
                j += 1
            runlen = j - i
            if v == 0 and runlen < min_sil_fr:
                m[i:j] = 1
            elif v == 1 and runlen < min_sp_fr:
                m[i:j] = 0
            i = j
    return m


def _first_voice_onset_sec(mask: np.ndarray, hop_sec: float, t_lo: float, t_hi: float) -> float | None:
    n = mask.size
    k0 = max(0, int(math.floor(t_lo / hop_sec)))
    k1 = min(n - 2, int(math.ceil(t_hi / hop_sec)))
    for k in range(k0, k1 + 1):
        if int(mask[k]) == 0 and int(mask[k + 1]) == 1:
            return float((k + 1) * hop_sec)
    return None


def _first_voice_offset_sec(mask: np.ndarray, hop_sec: float, t_lo: float, t_hi: float) -> float | None:
    n = mask.size
    k0 = max(0, int(math.floor(t_lo / hop_sec)))
    k1 = min(n - 2, int(math.ceil(t_hi / hop_sec)))
    for k in range(k0, k1 + 1):
        if int(mask[k]) == 1 and int(mask[k + 1]) == 0:
            return float((k + 1) * hop_sec)
    return None


def _interval_fully_silent(mask: np.ndarray, hop_sec: float, t0: float, t1: float) -> bool:
    if not (t1 > t0 + 1e-9):
        return True
    n = mask.size
    k0 = max(0, int(math.floor(t0 / hop_sec)))
    k1 = min(n - 1, int(math.floor(t1 / hop_sec)))
    for k in range(k0, k1 + 1):
        if int(mask[k]) != 0:
            return False
    return True


def _smooth_db_frames(db_frames: np.ndarray, half_win: int = GAP_SMOOTH_HALF_FRAMES) -> np.ndarray:
    n = db_frames.size
    if n == 0:
        return db_frames.astype(np.float64)
    hw = max(0, int(half_win))
    out = np.empty(n, dtype=np.float64)
    for k in range(n):
        k0 = max(0, k - hw)
        k1 = min(n, k + hw + 1)
        out[k] = float(np.mean(db_frames[k0:k1]))
    return out


def _gap_tail_end_frame(
    db_smooth: np.ndarray,
    hop_sec: float,
    t_lo: float,
    t_hi: float,
    *,
    decay_db: float = GAP_TAIL_DECAY_DB,
    peak_window_sec: float = GAP_TAIL_PEAK_WINDOW_SEC,
) -> int:
    k0 = max(0, int(math.floor(t_lo / hop_sec)))
    k1 = min(db_smooth.size - 1, int(math.floor(t_hi / hop_sec)))
    if k1 <= k0:
        return k0
    k_peak_hi = min(k1, k0 + max(1, int(math.ceil(peak_window_sec / hop_sec))))
    peak_ref = float(np.max(db_smooth[k0 : k_peak_hi + 1]))
    target = peak_ref - decay_db
    for k in range(k0, k1 + 1):
        if float(db_smooth[k]) <= target + 1e-6:
            return k
    return k0


def _first_tail_decay_rise_onset_sec(
    db_frames: np.ndarray,
    db_smooth: np.ndarray,
    hop_sec: float,
    t_lo: float,
    t_hi: float,
    speech_thresh_db: float,
    *,
    rise_delta_db: float = GAP_RISE_DELTA_DB,
    rise_frames: int = GAP_RISE_WINDOW_FRAMES,
) -> float | None:
    """Tail 감쇠 직후 [t_lo,t_hi]에서 시간순 첫 local-min + 급상승 onset."""
    if not (t_hi > t_lo + 1e-6):
        return None
    k0 = max(0, int(math.floor(t_lo / hop_sec)))
    k1 = min(db_smooth.size - 1, int(math.floor(t_hi / hop_sec)))
    if k1 <= k0 + 2:
        return None

    seg = db_smooth[k0 : k1 + 1]
    if float(np.max(seg) - np.min(seg)) < GAP_FLAT_RANGE_DB:
        return None

    tail_k = _gap_tail_end_frame(db_smooth, hop_sec, t_lo, t_hi)
    search_start = max(k0, tail_k)
    rise_n = max(1, int(rise_frames))

    for k in range(search_start + 1, k1):
        v = float(db_smooth[k])
        if not (v <= float(db_smooth[k - 1]) + 1e-6 and v <= float(db_smooth[k + 1]) + 1e-6):
            continue
        v_raw = float(db_frames[k])
        rise_db = max(float(speech_thresh_db), v_raw + rise_delta_db)
        k_end = min(k1, k + rise_n)
        for j in range(k + 1, k_end + 1):
            if float(db_frames[j]) >= rise_db - 1e-6:
                return float(k * hop_sec)
    return None


def _valley_energy_rise_onset_sec(
    db_frames: np.ndarray,
    hop_sec: float,
    t_lo: float,
    t_hi: float,
    speech_thresh_db: float,
    *,
    rise_delta_db: float = GAP_VALLEY_RISE_DELTA_DB,
    min_dip_db: float = GAP_VALLEY_MIN_DIP_DB,
) -> float | None:
    """Gap [t_lo, t_hi] — raw db_frames valley 이후 에너지 상승 지점 (debounce 미사용)."""
    if not (t_hi > t_lo + 1e-6):
        return None
    n = db_frames.size
    k0 = max(0, int(math.floor(t_lo / hop_sec)))
    k1 = min(n - 1, int(math.floor(t_hi / hop_sec)))
    if k1 <= k0:
        return None

    seg = db_frames[k0 : k1 + 1]
    if seg.size < 2:
        return None

    peak_db = float(np.max(seg))
    valley_rel = int(np.argmin(seg))
    valley_k = k0 + valley_rel
    valley_db = float(db_frames[valley_k])
    if peak_db - valley_db < min_dip_db:
        return None

    rise_db = max(float(speech_thresh_db), valley_db + rise_delta_db)
    for k in range(valley_k + 1, k1 + 1):
        if float(db_frames[k]) >= rise_db - 1e-6:
            return float(k * hop_sec)
    return None


def _apply_gap_boundary_pullback(
    ws0: float,
    we0: float,
    prev_end: float,
    mask: np.ndarray,
    db_frames: np.ndarray,
    hop_sec: float,
    dur_max: float,
    speech_thresh_db: float,
    next_word_start: float | None,
) -> tuple[float, bool]:
    """세그먼트 첫 단어 gap pull-back — 1차 mask onset, 2차 tail-decay rise, 3차 valley."""
    lo_s = max(0.0, prev_end)
    hi_s = min(dur_max, ws0 + SNAP_SEARCH_SEC)
    gap_hi_s = min(dur_max, ws0)
    if next_word_start is not None:
        hi_s = min(hi_s, next_word_start - 0.01)
        gap_hi_s = min(gap_hi_s, next_word_start - 0.01)

    onset: float | None = None
    if hi_s > lo_s + 1e-6:
        onset = _first_voice_onset_sec(mask, hop_sec, lo_s, hi_s)

    if onset is not None and onset < ws0 - 1e-4:
        ws1 = max(prev_end + 1e-4, onset - PREPAD_SEC)
        ws1 = min(ws1, we0 - 1e-4)
        return ws1, ws1 < ws0 - 1e-4

    if gap_hi_s > lo_s + GAP_BOUNDARY_MIN_SEC and db_frames.size > 0:
        db_smooth = _smooth_db_frames(db_frames)
        flux_onset = _first_tail_decay_rise_onset_sec(
            db_frames,
            db_smooth,
            hop_sec,
            lo_s,
            gap_hi_s,
            speech_thresh_db,
        )
        if flux_onset is not None and flux_onset < ws0 - 1e-4:
            ws1 = max(prev_end + 1e-4, flux_onset - PREPAD_SEC)
            ws1 = min(ws1, we0 - 1e-4)
            if ws1 < ws0 - 1e-4:
                logger.debug(
                    "gap tail-decay rise pull-back pe=%.3f ws0=%.3f onset=%.3f ws1=%.3f",
                    prev_end,
                    ws0,
                    flux_onset,
                    ws1,
                )
                return ws1, True

        valley_onset = _valley_energy_rise_onset_sec(
            db_frames,
            hop_sec,
            lo_s,
            gap_hi_s,
            speech_thresh_db,
        )
        if valley_onset is not None and valley_onset < ws0 - 1e-4:
            ws1 = max(prev_end + 1e-4, valley_onset - PREPAD_SEC)
            ws1 = min(ws1, we0 - 1e-4)
            if ws1 < ws0 - 1e-4:
                logger.debug(
                    "gap valley fallback pull-back pe=%.3f ws0=%.3f valley_onset=%.3f ws1=%.3f",
                    prev_end,
                    ws0,
                    valley_onset,
                    ws1,
                )
                return ws1, True

    return max(prev_end + 1e-4, ws0), False


def _snap_word_pair(
    ws: float,
    we: float,
    mask: np.ndarray,
    hop_sec: float,
    dur_max: float,
    prev_end: float,
    next_word_start: float | None = None,
    *,
    is_cue_first_word: bool = False,
    gap_sec: float = 0.0,
    db_frames: np.ndarray | None = None,
    speech_thresh_db: float = -40.0,
) -> tuple[float, float]:
    ws0, we0 = float(ws), float(we)
    if not (we0 > ws0 + 1e-6):
        return ws0, we0
    whisper_dur = we0 - ws0
    allow_gap_pullback = (
        is_cue_first_word and gap_sec > GAP_BOUNDARY_MIN_SEC
    )
    pulled_back = False

    if allow_gap_pullback:
        ws1, pulled_back = _apply_gap_boundary_pullback(
            ws0,
            we0,
            prev_end,
            mask,
            db_frames if db_frames is not None else np.array([], dtype=np.float64),
            hop_sec,
            dur_max,
            speech_thresh_db,
            next_word_start,
        )
    else:
        lo_s = max(0.0, ws0 - SNAP_SEARCH_SEC)
        hi_s = min(dur_max, ws0 + SNAP_SEARCH_SEC)
        if next_word_start is not None:
            hi_s = min(hi_s, next_word_start - 0.01)
        onset = _first_voice_onset_sec(mask, hop_sec, lo_s, hi_s)
        if onset is not None and onset < we0 - 1e-4:
            ws1 = max(prev_end + 1e-4, onset - PREPAD_SEC)
            ws1 = min(ws1, we0 - 1e-4)
            ws1 = max(ws0 - SNAP_SEARCH_SEC, ws1)
        else:
            ws1 = max(prev_end + 1e-4, ws0)
    end_floor = min(
        whisper_dur * 0.92,
        max(END_SNAP_MIN_AFTER_START_SEC, END_SNAP_FRAC_OF_WHISPER_DUR * whisper_dur),
    )
    lo_e = max(ws1 + end_floor, we0 - SNAP_SEARCH_SEC)
    hi_e = min(dur_max, we0 + SNAP_SEARCH_SEC)
    if next_word_start is not None:
        hi_e = min(hi_e, next_word_start - 0.01)
    off = _first_voice_offset_sec(mask, hop_sec, lo_e, hi_e)
    if off is not None and off > ws1 + 1e-4:
        we1 = min(off, hi_e)
    else:
        we1 = we0
    if we1 <= ws1 + 1e-6:
        we1 = min(dur_max, ws1 + max(1e-3, we0 - ws0))
    snapped = we1 - ws1
    need = max(MIN_SNAPPED_WORD_SEC, MIN_SNAPPED_TO_WHISPER_RATIO * whisper_dur)
    need = float(min(need, whisper_dur))
    if whisper_dur > 0.11 and snapped + 1e-9 < need:
        if pulled_back:
            we1 = min(dur_max, max(we1, ws1 + max(need, whisper_dur * 0.85)))
            if we1 <= ws1 + 1e-6:
                we1 = min(dur_max, ws1 + whisper_dur)
        else:
            ws_fb = max(prev_end + 1e-4, ws0)
            we_fb = min(dur_max, we0)
            if we_fb > ws_fb + need * 0.9:
                ws1, we1 = ws_fb, we_fb
            else:
                we1 = min(dur_max, max(we1, ws1 + max(need, whisper_dur * 0.85)))
                if we1 <= ws1 + 1e-6:
                    we1 = min(dur_max, ws1 + whisper_dur)
    if next_word_start is not None:
        we1 = min(we1, next_word_start - 0.01)
    we1 = max(we1, ws1 + 1e-4)
    return ws1, we1


def _is_silence_token(w: dict[str, Any]) -> bool:
    if w.get("isSilence") is True or w.get("is_silence") is True:
        return True
    ww = str(w.get("word", "") or "").strip()
    return ww == "--" or ww == "-- "


def _is_pause_or_filler_token(w: dict[str, Any]) -> bool:
    if _is_silence_token(w):
        return True
    ww = str(w.get("word", "") or "").strip()
    if not ww:
        return False
    if ww in ("…", "...", "..", "."):
        return True
    return all(ch in "…." for ch in ww)


def _rebuild_cue_text(words: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for w in words:
        t = str(w.get("word", "") or "").strip()
        if t:
            parts.append(t)
    return " ".join(parts).strip()


def _round_timeline_sec(value: float) -> float:
    return round(float(value), 3)


def _word_time_bounds(w: dict[str, Any]) -> tuple[float, float] | None:
    try:
        start = float(w.get("start", 0))
        end = float(w.get("end", 0))
    except (TypeError, ValueError):
        return None
    return start, end


def _is_sealable_spoken_word(w: dict[str, Any]) -> bool:
    """음성·필러(… 등) — 명시적 무음(--) 제외."""
    if _is_silence_token(w):
        return False
    return bool(str(w.get("word", "") or "").strip())


def _spoken_word_duration_ok(start: float, end: float) -> bool:
    if end + 1e-9 < start:
        return False
    return (end - start) >= MIN_WORD_SEC - 1e-9


def _set_word_time_bounds(w: dict[str, Any], start: float, end: float) -> None:
    w["start"] = _round_timeline_sec(start)
    w["end"] = _round_timeline_sec(end)


def _flatten_timeline_words(
    cues: list[dict[str, Any]],
) -> list[tuple[int, int, dict[str, Any]]]:
    """(cue_index, word_index, word_ref) — word.start → cue_index → word_index."""
    flat: list[tuple[int, int, dict[str, Any], float]] = []
    for ci, cue in enumerate(cues):
        if not isinstance(cue, dict):
            continue
        raw_words = cue.get("words")
        if not isinstance(raw_words, list):
            continue
        for wi, w in enumerate(raw_words):
            if not isinstance(w, dict):
                continue
            bounds = _word_time_bounds(w)
            if bounds is None:
                continue
            flat.append((ci, wi, w, bounds[0]))
    flat.sort(key=lambda item: (item[3], item[0], item[1]))
    return [(ci, wi, w) for ci, wi, w, _ in flat]


def _try_silence_boundary_attach(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """P1 (V21): `--` 불변 — 음성 단어 end만 조정. start 이동 필요 시 skip."""
    a_sil = _is_silence_token(a)
    b_sil = _is_silence_token(b)
    if a_sil and b_sil:
        return False
    a_bounds = _word_time_bounds(a)
    b_bounds = _word_time_bounds(b)
    if a_bounds is None or b_bounds is None:
        return False
    a_s, a_e = a_bounds
    b_s, b_e = b_bounds

    if a_sil and not b_sil:
        return False

    if not a_sil and b_sil:
        new_a_e = b_s
        if not _spoken_word_duration_ok(a_s, new_a_e):
            return False
        _set_word_time_bounds(a, a_s, new_a_e)
        return True

    return False


def _try_asymmetric_seal_spoken_pair(
    a: dict[str, Any],
    b: dict[str, Any],
    *,
    a_start: float,
    a_end: float,
    b_start: float,
    b_end: float,
) -> bool:
    """
    V21 — B.start(onset) 불변, A.end만 B.start에 맞춤.
    Overlap: A 꼬리 축소. Gap: A 꼬리 연장(tail-extension).
    """
    _ = b_end
    if abs(b_start - a_end) <= TIMELINE_PAIR_EPS:
        return False
    new_a_e = _round_timeline_sec(b_start)
    if not _spoken_word_duration_ok(a_start, new_a_e):
        return False
    _set_word_time_bounds(a, a_start, new_a_e)
    return True


def _try_timeline_pair_sealing(a: dict[str, Any], b: dict[str, Any]) -> str:
    """
    V21 우선순위: P1 `--` → P2/P3 비대칭 봉합.
    반환: applied | skipped | noop
    """
    a_sil = _is_silence_token(a)
    b_sil = _is_silence_token(b)

    if a_sil or b_sil:
        if a_sil and b_sil:
            return "noop"
        return "applied" if _try_silence_boundary_attach(a, b) else "skipped"

    if not (_is_sealable_spoken_word(a) and _is_sealable_spoken_word(b)):
        return "noop"

    a_bounds = _word_time_bounds(a)
    b_bounds = _word_time_bounds(b)
    if a_bounds is None or b_bounds is None:
        return "noop"
    a_s, a_e = a_bounds
    b_s, b_e = b_bounds

    if abs(b_s - a_e) <= TIMELINE_PAIR_EPS:
        return "noop"

    if _try_asymmetric_seal_spoken_pair(
        a, b, a_start=a_s, a_end=a_e, b_start=b_s, b_end=b_e
    ):
        return "applied"
    return "skipped"


def _resync_cue_metadata_after_sealing(cues: list[dict[str, Any]]) -> None:
    for cue in cues:
        if not isinstance(cue, dict):
            continue
        raw_words = cue.get("words")
        if not isinstance(raw_words, list) or not raw_words:
            continue
        words: list[dict[str, Any]] = []
        for w in raw_words:
            if not isinstance(w, dict):
                continue
            if _word_time_bounds(w) is None:
                continue
            words.append(w)
        if not words:
            continue
        words.sort(key=lambda w: float(w["start"]))
        cue["words"] = words
        cue["start"] = _round_timeline_sec(min(float(w["start"]) for w in words))
        cue["end"] = _round_timeline_sec(max(float(w["end"]) for w in words))
        cue["text"] = _rebuild_cue_text(words)


def _log_spoken_word_integrity_issues(cues: list[dict[str, Any]]) -> None:
    bad = 0
    for cue in cues:
        if not isinstance(cue, dict):
            continue
        raw_words = cue.get("words")
        if not isinstance(raw_words, list):
            continue
        for w in raw_words:
            if not isinstance(w, dict) or not _is_sealable_spoken_word(w):
                continue
            bounds = _word_time_bounds(w)
            if bounds is None:
                bad += 1
                continue
            s, e = bounds
            if not _spoken_word_duration_ok(s, e):
                bad += 1
    if bad:
        logger.warning(
            "v21 asymmetric timeline pass: %d spoken/filler word(s) below MIN_WORD_SEC "
            "or reversed (pre-existing or skipped pairs)",
            bad,
        )


def _apply_v21_asymmetric_timeline_pass(cues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """V21: onset(B.start) 보존 — A.end만 조정하는 비대칭 봉합."""
    flat = _flatten_timeline_words(cues)
    if len(flat) < 2:
        _resync_cue_metadata_after_sealing(cues)
        return cues

    applied = 0
    skipped = 0
    for i in range(len(flat) - 1):
        a = flat[i][2]
        b = flat[i + 1][2]
        result = _try_timeline_pair_sealing(a, b)
        if result == "applied":
            applied += 1
        elif result == "skipped":
            skipped += 1

    _resync_cue_metadata_after_sealing(cues)
    logger.debug(
        "v21 asymmetric timeline pass: seal_applied=%d skipped=%d pairs=%d",
        applied,
        skipped,
        len(flat) - 1,
    )
    _log_spoken_word_integrity_issues(cues)
    return cues


def apply_rms_vad_word_align(
    cues: list[dict[str, Any]],
    media_path: str,
    ffmpeg_exe: str | None,
    *,
    total_duration: float,
    word_snap: bool = True,
) -> list[dict[str, Any]]:
    if not cues:
        return cues
    try:
        ff = _resolve_ffmpeg(ffmpeg_exe)
    except (FileNotFoundError, OSError) as e:
        logger.error(
            "RMS/VAD align skipped: ffmpeg not available (media=%s): %s",
            media_path,
            e,
        )
        return cues
    try:
        samples = _decode_mono_f32_16k(media_path, ff)
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as e:
        logger.error(
            "RMS/VAD align skipped: audio decode failed (media=%s): %s",
            media_path,
            e,
            exc_info=isinstance(e, RuntimeError),
        )
        return cues
    dur_audio = len(samples) / float(SR)
    dur_max = float(total_duration) if total_duration and total_duration > 0 else dur_audio
    dur_max = min(dur_max, dur_audio + 0.5)
    db_frames, hop_sec, _hop, _win = _rms_db_frames(samples)
    thresh = _dynamic_threshold_db(db_frames)
    mask = _binary_mask(db_frames, thresh)
    mask = _debounce_mask(mask, hop_sec)
    out_cues: list[dict[str, Any]] = []
    prev_global_end = 0.0
    for cue in cues:
        if not isinstance(cue, dict):
            continue
        raw_words = cue.get("words")
        if not isinstance(raw_words, list) or len(raw_words) == 0:
            out_cues.append(dict(cue))
            continue
        words_in: list[dict[str, Any]] = []
        for w in raw_words:
            if not isinstance(w, dict):
                continue
            try:
                ws = float(w.get("start", 0))
                we = float(w.get("end", 0))
            except (TypeError, ValueError):
                continue
            ww = str(w.get("word", "") or "").strip()
            if not ww and not _is_silence_token(w):
                continue
            words_in.append(dict(w))
        if not words_in:
            out_cues.append(dict(cue))
            continue
        words_in.sort(key=lambda x: float(x["start"]))
        snapped: list[dict[str, Any]] = []
        first_spoken_done = False
        for i, w in enumerate(words_in):
            if _is_silence_token(w):
                ws = max(0.0, min(dur_max, float(w.get("start", 0))))
                we = max(ws + 1e-4, min(dur_max, float(w.get("end", 0))))
                snapped.append(
                    {
                        "start": ws,
                        "end": we,
                        "word": "--",
                        "is_silence": True,
                        "isSilence": True,
                    }
                )
                prev_global_end = max(prev_global_end, we)
                continue
            ws = float(w["start"])
            we = float(w["end"])
            pe = max(prev_global_end, 0.0)
            if _is_pause_or_filler_token(w):
                nws = max(pe + 1e-4, min(dur_max, ws))
                nwe = max(nws + 1e-4, min(dur_max, we))
                snapped.append({**w, "start": nws, "end": nwe})
                prev_global_end = max(prev_global_end, nwe)
                continue
            next_word_start: float | None = None
            if i + 1 < len(words_in):
                nw = words_in[i + 1]
                if not _is_silence_token(nw):
                    next_word_start = float(nw["start"])
            is_first_spoken = not first_spoken_done
            first_spoken_done = True
            if word_snap:
                gap_sec = max(0.0, ws - pe) if is_first_spoken else 0.0
                nws, nwe = _snap_word_pair(
                    ws,
                    we,
                    mask,
                    hop_sec,
                    dur_max,
                    pe,
                    next_word_start=next_word_start,
                    is_cue_first_word=is_first_spoken,
                    gap_sec=gap_sec,
                    db_frames=db_frames,
                    speech_thresh_db=thresh,
                )
                nws = max(pe + 1e-4, nws)
                if nwe <= nws + 1e-6:
                    nwe = min(dur_max, nws + max(1e-3, we - ws))
            else:
                nws = max(pe + 1e-4, min(dur_max, ws))
                nwe = max(nws + 1e-4, min(dur_max, we))
                if next_word_start is not None:
                    nwe = min(nwe, next_word_start - 0.01)
            snapped.append({**w, "start": nws, "end": nwe})
            prev_global_end = max(prev_global_end, nwe)
        merged: list[dict[str, Any]] = []
        for i, w in enumerate(snapped):
            merged.append(w)
            if i >= len(snapped) - 1:
                break
            a = w
            b = snapped[i + 1]
            if _is_pause_or_filler_token(a) or _is_pause_or_filler_token(b):
                continue
            gap_s = float(b["start"]) - float(a["end"])
            if gap_s >= GAP_INSERT_SILENCE_SEC - 1e-6:
                t0, t1 = float(a["end"]), float(b["start"])
                if _interval_fully_silent(mask, hop_sec, t0, t1):
                    merged.append(
                        {
                            "start": t0,
                            "end": t1,
                            "word": "--",
                            "is_silence": True,
                            "isSilence": True,
                        }
                    )
        merged.sort(key=lambda x: float(x["start"]))
        eps = 1e-4
        for i in range(len(merged) - 1):
            a, b = merged[i], merged[i + 1]
            if float(a["end"]) > float(b["start"]) + eps:
                a["end"] = max(float(a["start"]) + eps, float(b["start"]) - eps)
        out_cues.append(
            {
                "start": min(float(x["start"]) for x in merged),
                "end": max(float(x["end"]) for x in merged),
                "text": _rebuild_cue_text(merged),
                "words": merged,
            }
        )
    return _apply_v21_asymmetric_timeline_pass(out_cues)
