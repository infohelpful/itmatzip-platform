"""Gap 구간 db_frames / VAD / valley 진단 (일회성)."""
from __future__ import annotations

import math
import sys
from pathlib import Path

AGENT = Path(r"C:\Program Files\itmatzip-agent\agent")
sys.path.insert(0, str(AGENT))

from engines.auto_subtitle_rms_vad import (  # noqa: E402
    GAP_VALLEY_MIN_DIP_DB,
    GAP_VALLEY_RISE_DELTA_DB,
    PREPAD_SEC,
    _binary_mask,
    _debounce_mask,
    _dynamic_threshold_db,
    _first_voice_onset_sec,
    _rms_db_frames,
    _valley_energy_rise_onset_sec,
    _decode_mono_f32_16k,
    _resolve_ffmpeg,
)

WAV = Path(
    r"C:\ProgramData\itmatzip-agent\auto-subtitle\workspace"
    r"\prep-20260609-062838.482\whisper-audio.wav"
)
PE = 8.29
WS0_WHISPER = 8.59
WS0_ALIGNED = 8.54


def main() -> None:
    ff = _resolve_ffmpeg(r"C:\Users\MyComputer\AppData\Local\Microsoft\WinGet\Links\ffmpeg.exe")
    samples = _decode_mono_f32_16k(str(WAV), ff)
    db_frames, hop_sec, _, _ = _rms_db_frames(samples)
    thresh = _dynamic_threshold_db(db_frames)
    raw_mask = _binary_mask(db_frames, thresh)
    deb_mask = _debounce_mask(raw_mask, hop_sec)

    print(f"media={WAV}")
    print(f"hop_sec={hop_sec:.4f} thresh_db={thresh:.2f}")
    print(f"gap pe={PE} ws0_whisper={WS0_WHISPER} ws0_aligned={WS0_ALIGNED}")
    print()

    for label, t_lo, t_hi in [
        ("gap [pe, ws0]", PE, WS0_WHISPER),
        ("1st scan [pe, ws0+0.35]", PE, WS0_WHISPER + 0.35),
    ]:
        o_deb = _first_voice_onset_sec(deb_mask, hop_sec, t_lo, t_hi)
        o_raw = _first_voice_onset_sec(raw_mask, hop_sec, t_lo, t_hi)
        v = _valley_energy_rise_onset_sec(db_frames, hop_sec, t_lo, WS0_WHISPER, thresh)
        print(f"{label}:")
        print(f"  onset debounced={o_deb} raw={o_raw} valley_rise={v}")
        if v is not None:
            ws1 = max(PE + 1e-4, v - PREPAD_SEC)
            print(f"  -> ws1={ws1:.4f} (pull-back from ws0={WS0_WHISPER - ws1:.3f}s)")

    print()
    print("frame table [pe, ws0+0.05] (time, db, raw_mask, deb_mask):")
    k0 = max(0, int(math.floor(PE / hop_sec)))
    k1 = min(len(db_frames) - 1, int(math.ceil((WS0_WHISPER + 0.05) / hop_sec)))
    seg = db_frames[k0 : k1 + 1]
    peak_db = float(seg.max())
    valley_rel = int(seg.argmin())
    valley_k = k0 + valley_rel
    valley_db = float(db_frames[valley_k])
    rise_db = max(thresh, valley_db + GAP_VALLEY_RISE_DELTA_DB)
    print(
        f"  peak={peak_db:.2f} valley_t={valley_k * hop_sec:.3f} "
        f"valley_db={valley_db:.2f} dip={peak_db - valley_db:.2f} "
        f"(min_dip={GAP_VALLEY_MIN_DIP_DB}) rise_db={rise_db:.2f}"
    )
    print("  time     db     raw deb  note")
    for k in range(k0, k1 + 1):
        t = k * hop_sec
        db = float(db_frames[k])
        rm = int(raw_mask[k])
        dm = int(deb_mask[k])
        note = ""
        if k == valley_k:
            note = "<-- valley"
        if dm == 1 and (k == k0 or int(deb_mask[k - 1]) == 0):
            note += " deb_onset"
        if db >= rise_db - 1e-6 and k > valley_k:
            if "rise" not in note:
                note += " >=rise_thresh"
        print(f"  {t:6.3f}  {db:6.2f}  {rm:3d}  {dm:3d}  {note}")


if __name__ == "__main__":
    main()
