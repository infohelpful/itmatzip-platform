"""Line Mode v4 reflow unit tests."""

from __future__ import annotations

import unittest

from engines.line_mode_reflow import (
    apply_line_mode_reflow,
    calculate_split_score,
    group_words_into_cues,
    map_whisper_words,
    reflow_cues_skip_user_moved,
)
from engines.line_mode_snap_grid import build_snap_grid_from_peaks


def _w(text: str, start: float, end: float | None = None) -> dict:
    e = end if end is not None else start + 0.2
    return {"word": text, "start": start, "end": e}


class LineModeReflowTests(unittest.TestCase):
    def test_map_whisper_words_gap_non_negative(self) -> None:
        words = map_whisper_words([_w("안녕", 0.0), _w("하세요", 0.5)])
        self.assertEqual(len(words), 2)
        self.assertGreaterEqual(words[1]["gap"], 0.0)

    def test_filters_silence_placeholder(self) -> None:
        words = map_whisper_words([_w("--", 0.0), _w("테스트", 1.0)])
        self.assertEqual(len(words), 1)
        self.assertEqual(words[0]["word"], "테스트")

    def test_josa_penalty_lowers_score(self) -> None:
        a = {"word": "사과", "hintStart": 0.0, "hintEnd": 0.3}
        b = {"word": "를", "hintStart": 0.35, "hintEnd": 0.5}
        c = {"word": "먹", "hintStart": 0.55, "hintEnd": 0.8}
        self.assertLess(calculate_split_score(a, b), calculate_split_score(a, c))

    def test_group_respects_max_chars(self) -> None:
        words = map_whisper_words(
            [_w(f"w{i}", i * 0.3) for i in range(12)]
        )
        cues = group_words_into_cues(words, mode="horizontal")
        for cue in cues:
            text = cue["text"].replace(" ", "")
            self.assertLessEqual(len(text), 28)

    def test_reflow_skip_user_moved(self) -> None:
        raw = [
            {
                "start": 0.0,
                "end": 2.0,
                "text": "고정 줄",
                "words": map_whisper_words([_w("고정", 0.0, 0.5), _w("줄", 0.6, 1.0)]),
                "flags": {"userMoved": True},
            },
            {
                "start": 2.0,
                "end": 4.0,
                "text": "다음",
                "words": map_whisper_words([_w("다음", 2.0, 2.5)]),
            },
        ]
        out = reflow_cues_skip_user_moved(raw)
        self.assertEqual(out[0]["text"], "고정 줄")
        self.assertTrue(out[0]["flags"]["userMoved"])

    def test_apply_line_mode_reflow_from_segments(self) -> None:
        subs = [
            {
                "start": 0.0,
                "end": 5.0,
                "text": "하나 둘 셋",
                "words": [
                    _w("하나", 0.0, 0.4),
                    _w("둘", 0.5, 0.8),
                    _w("셋", 0.9, 1.2),
                ],
            }
        ]
        cues = apply_line_mode_reflow(subs)
        self.assertGreaterEqual(len(cues), 1)
        self.assertIn("flags", cues[0])


class LineModeSnapGridTests(unittest.TestCase):
    def test_build_onsets_from_rising_edge(self) -> None:
        peaks = [-40.0] * 10 + [-20.0] * 10 + [-40.0] * 10
        grid = build_snap_grid_from_peaks(peaks, duration_sec=1.0)
        self.assertGreater(len(grid["onsets"]), 0)
        self.assertEqual(grid["dragStartSnaps"], grid["onsets"])


if __name__ == "__main__":
    unittest.main()
