"""
Whisper 단어 타임스탬프를 PCM RMS 기반 VAD로 정제 — AutoSubtitle python_sidecar/rms_vad_word_align.py 이식.
"""

from __future__ import annotations

import math
import subprocess
from pathlib import Path
from typing import Any

import numpy as np

from common.bin_manager import get_ffmpeg_executable
from common.subprocess_util import no_window_creationflags

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
SNAP_SEARCH_SEC = 0.15
PREPAD_SEC = 0.04
END_SNAP_MIN_AFTER_START_SEC = 0.055
END_SNAP_FRAC_OF_WHISPER_DUR = 0.22
MIN_SNAPPED_WORD_SEC = 0.06
MIN_SNAPPED_TO_WHISPER_RATIO = 0.36
GAP_INSERT_SILENCE_SEC = 0.30


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


def _snap_word_pair(
    ws: float,
    we: float,
    mask: np.ndarray,
    hop_sec: float,
    dur_max: float,
    prev_end: float,
) -> tuple[float, float]:
    ws0, we0 = float(ws), float(we)
    if not (we0 > ws0 + 1e-6):
        return ws0, we0
    whisper_dur = we0 - ws0
    lo_s = max(0.0, ws0 - SNAP_SEARCH_SEC)
    hi_s = min(dur_max, ws0 + SNAP_SEARCH_SEC)
    onset = _first_voice_onset_sec(mask, hop_sec, lo_s, hi_s)
    if onset is not None and onset < we0 - 1e-4:
        ws1 = max(prev_end + 1e-4, onset - PREPAD_SEC)
        ws1 = min(ws1, we0 - 1e-4)
        if ws1 < ws0 - 1e-4:
            ws1 = ws0
    else:
        ws1 = max(prev_end + 1e-4, ws0)
    end_floor = min(
        whisper_dur * 0.92,
        max(END_SNAP_MIN_AFTER_START_SEC, END_SNAP_FRAC_OF_WHISPER_DUR * whisper_dur),
    )
    lo_e = max(ws1 + end_floor, we0 - SNAP_SEARCH_SEC)
    hi_e = min(dur_max, we0 + SNAP_SEARCH_SEC)
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
        ws_fb = max(prev_end + 1e-4, ws0)
        we_fb = min(dur_max, we0)
        if we_fb > ws_fb + need * 0.9:
            return ws_fb, we_fb
        we1 = min(dur_max, max(we1, ws1 + max(need, whisper_dur * 0.85)))
        if we1 <= ws1 + 1e-6:
            we1 = min(dur_max, ws1 + whisper_dur)
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


def apply_rms_vad_word_align(
    cues: list[dict[str, Any]],
    media_path: str,
    ffmpeg_exe: str | None,
    *,
    total_duration: float,
) -> list[dict[str, Any]]:
    if not cues:
        return cues
    try:
        ff = _resolve_ffmpeg(ffmpeg_exe)
    except (FileNotFoundError, OSError):
        return cues
    try:
        samples = _decode_mono_f32_16k(media_path, ff)
    except (RuntimeError, OSError, subprocess.TimeoutExpired):
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
        for w in words_in:
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
            nws, nwe = _snap_word_pair(ws, we, mask, hop_sec, dur_max, pe)
            nws = max(pe + 1e-4, nws)
            if nwe <= nws + 1e-6:
                nwe = min(dur_max, nws + max(1e-3, we - ws))
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
    return out_cues
