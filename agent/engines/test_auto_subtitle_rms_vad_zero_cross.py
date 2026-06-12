"""Zero-crossing refine helpers — auto_subtitle_rms_vad."""

from __future__ import annotations

import math
import unittest

import numpy as np

from engines.auto_subtitle_rms_vad import _apply_zero_cross_refine_to_cues
from engines.auto_subtitle_zero_cross import (
    SR,
    refine_time_to_zero_cross,
)


class ZeroCrossRefineTests(unittest.TestCase):
    def test_refine_snaps_to_nearest_zero_cross(self) -> None:
        dur = 0.2
        t = np.arange(0, dur, 1.0 / SR, dtype=np.float32)
        samples = np.sin(2.0 * math.pi * 440.0 * t).astype(np.float32)
        target = 0.0105
        refined = refine_time_to_zero_cross(
            samples,
            SR,
            target,
            0.005,
            0.005,
            dur_max=dur,
        )
        idx = int(round(refined * SR))
        idx = max(0, min(len(samples) - 1, idx))
        self.assertLess(abs(float(samples[idx])), 0.08)
        self.assertLess(abs(refined - target), 0.004)

    def test_apply_zero_cross_refine_preserves_order(self) -> None:
        dur = 0.5
        t = np.arange(0, dur, 1.0 / SR, dtype=np.float32)
        samples = (0.3 * np.sin(2.0 * math.pi * 220.0 * t)).astype(np.float32)
        cues = [
            {
                "start": 0.05,
                "end": 0.18,
                "text": "hello world",
                "words": [
                    {"word": "hello", "start": 0.05, "end": 0.10},
                    {"word": "world", "start": 0.11, "end": 0.18},
                ],
            }
        ]
        out = _apply_zero_cross_refine_to_cues(cues, samples, dur)
        words = out[0]["words"]
        self.assertEqual(len(words), 2)
        self.assertLess(float(words[0]["start"]), float(words[0]["end"]))
        self.assertLessEqual(float(words[0]["end"]), float(words[1]["start"]) + 1e-3)


if __name__ == "__main__":
    unittest.main()
