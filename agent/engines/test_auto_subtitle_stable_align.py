"""stable-ts align_words cue helpers — auto_subtitle_stable_align."""

from __future__ import annotations

import unittest

from engines.auto_subtitle_stable_align import (
    _cues_to_align_segments,
    apply_stable_align_words,
)


class StableAlignCueTests(unittest.TestCase):
    def test_cues_to_align_segments_skips_silence(self) -> None:
        cues = [
            {"start": 0.0, "end": 1.0, "text": "hello", "words": []},
            {"start": 1.0, "end": 2.0, "text": "--", "words": []},
            {"start": 2.0, "end": 3.5, "text": "world", "words": []},
        ]
        indices, segments = _cues_to_align_segments(cues)
        self.assertEqual(indices, [0, 2])
        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0]["text"], "hello")
        self.assertEqual(segments[1]["text"], "world")

    def test_apply_stable_align_words_no_model_returns_unchanged(self) -> None:
        cues = [
            {
                "start": 0.0,
                "end": 1.0,
                "text": "테스트",
                "words": [{"start": 0.0, "end": 1.0, "word": "테스트"}],
            }
        ]
        out, stats = apply_stable_align_words(
            cues,
            "/tmp/audio.wav",
            None,
            language="ko",
            model_path="/models/whisper",
        )
        self.assertEqual(out, cues)
        self.assertFalse(stats.get("applied"))


if __name__ == "__main__":
    unittest.main()
