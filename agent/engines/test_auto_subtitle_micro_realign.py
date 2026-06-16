"""Micro-Realign — next-block min RMS / V-valley."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from engines.auto_subtitle_micro_realign import (
    _pick_deepest_valley_or_min_rms,
    apply_micro_realign,
)
from engines.auto_subtitle_zero_cross import SR, extract_segment_wav


def _write_tone_wav(path: Path, *, duration_sec: float = 2.0) -> None:
    import subprocess

    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:duration={duration_sec}",
            "-ac",
            "1",
            "-ar",
            str(SR),
            str(path),
        ],
        check=True,
        capture_output=True,
    )


class TestAutoSubtitleMicroRealign(unittest.TestCase):
    def test_apply_micro_realign_missing_next(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "t.wav"
            _write_tone_wav(wav)
            out = apply_micro_realign(
                media_path=str(wav),
                target={
                    "cue_index": 0,
                    "word_index": 0,
                    "start": 0.2,
                    "end": 0.8,
                    "text": "가",
                },
                prev_word=None,
                next_word=None,
            )
        self.assertFalse(out["applied"])
        self.assertEqual(out["reason"], "missing_next")

    def test_extract_segment_wav_offset(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "full.wav"
            seg = Path(td) / "seg.wav"
            _write_tone_wav(wav, duration_sec=3.0)
            t0 = extract_segment_wav(wav, 0.5, 1.0, seg, pad_sec=0.1)
            self.assertGreaterEqual(t0, 0.0)
            self.assertLess(t0, 0.5)
            self.assertTrue(seg.is_file())

    def test_pick_deepest_v_valley_then_min_rms(self) -> None:
        import numpy as np

        hop = 0.01
        n = 200
        db = np.full(n, -30.0, dtype=np.float64)
        db[50] = -45.0
        db[49] = -28.0
        db[51] = -27.0
        db[120] = -50.0
        db[119] = -29.0
        db[121] = -28.0
        t, mode = _pick_deepest_valley_or_min_rms(db, hop, 0.0, 2.0, 2.0)
        self.assertEqual(mode, "v_valley")
        self.assertAlmostEqual(t, 1.2, places=2)

        flat = np.full(80, -25.0, dtype=np.float64)
        t2, mode2 = _pick_deepest_valley_or_min_rms(flat, hop, 0.0, 0.8, 0.8)
        self.assertEqual(mode2, "min_rms")


if __name__ == "__main__":
    unittest.main()
