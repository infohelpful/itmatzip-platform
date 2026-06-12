"""Unit tests — bake segment prepare + filter acrossfade."""

from __future__ import annotations

import math
import unittest

import numpy as np

from engines.auto_subtitle_bake_segments import (
    merge_contiguous_segments,
    merge_literal_segments_for_bake,
    refine_segments_zero_cross,
)
from engines.auto_subtitle_filter_concat import (
    EXPORT_AUDIO_CROSSFADE_SEC,
    build_audio_acrossfade_chain,
    build_trim_concat_filter_parts,
)
from engines.auto_subtitle_zero_cross import SR, refine_time_to_zero_cross


class BakeSegmentPrepareTests(unittest.TestCase):
    def test_merge_contiguous_segments(self) -> None:
        segs = [(0.0, 2.0), (2.0, 5.0), (6.0, 8.0)]
        merged = merge_contiguous_segments(segs)
        self.assertEqual(merged, [(0.0, 5.0), (6.0, 8.0)])

    def test_merge_literal_segments_stt_gap(self) -> None:
        clips = [
            {
                "id": "a",
                "sourceStart": 0.0,
                "sourceEnd": 5.0,
                "programStart": 0.0,
                "programEnd": 5.0,
                "isSilence": False,
            },
            {
                "id": "b",
                "sourceStart": 5.12,
                "sourceEnd": 8.0,
                "programStart": 5.0,
                "programEnd": 7.88,
                "isSilence": False,
            },
        ]
        segs = [(0.0, 5.0), (5.12, 8.0)]
        merged, slots, meta = merge_literal_segments_for_bake(clips, segs)
        self.assertEqual(merged, [(0.0, 8.0)])
        self.assertAlmostEqual(slots[0], 7.88, places=2)
        self.assertEqual(meta["runs"], 1)
        self.assertEqual(meta["bridged_gaps"], 1)

    def test_merge_literal_segments_long_breath_gap(self) -> None:
        clips = [
            {
                "id": "a",
                "sourceStart": 0.0,
                "sourceEnd": 5.0,
                "programStart": 0.0,
                "programEnd": 5.0,
                "isSilence": False,
            },
            {
                "id": "b",
                "sourceStart": 6.2,
                "sourceEnd": 10.0,
                "programStart": 5.0,
                "programEnd": 8.8,
                "isSilence": False,
            },
        ]
        segs = [(0.0, 5.0), (6.2, 10.0)]
        merged, slots, meta = merge_literal_segments_for_bake(clips, segs)
        self.assertEqual(merged, [(0.0, 10.0)])
        self.assertAlmostEqual(slots[0], 8.8, places=3)
        self.assertEqual(meta["runs"], 1)

    def test_merge_literal_segments_deletion_gap_split(self) -> None:
        clips = [
            {
                "sourceStart": 0.0,
                "sourceEnd": 5.0,
                "programStart": 0.0,
                "programEnd": 5.0,
                "isSilence": False,
            },
            {
                "sourceStart": 20.0,
                "sourceEnd": 25.0,
                "programStart": 5.0,
                "programEnd": 10.0,
                "isSilence": False,
            },
        ]
        segs = [(0.0, 5.0), (20.0, 25.0)]
        merged, _slots, meta = merge_literal_segments_for_bake(clips, segs)
        self.assertEqual(len(merged), 2)
        self.assertEqual(meta["runs"], 2)

    def test_merge_literal_segments_reorder_split(self) -> None:
        clips = [
            {"id": "a", "sourceStart": 0.0, "sourceEnd": 5.0, "isSilence": False},
            {"id": "b", "sourceStart": 12.0, "sourceEnd": 15.0, "isSilence": False},
        ]
        segs = [(0.0, 5.0), (12.0, 15.0)]
        merged, _slots, _meta = merge_literal_segments_for_bake(clips, segs)
        self.assertEqual(len(merged), 2)

    def test_merge_requires_list_source_successor(self) -> None:
        clips = [
            {
                "id": "line2",
                "blockIndex": 0,
                "sourceStart": 2.0,
                "sourceEnd": 5.0,
                "programStart": 0.0,
                "programEnd": 3.0,
                "isSilence": False,
            },
            {
                "id": "line1",
                "blockIndex": 1,
                "sourceStart": 0.0,
                "sourceEnd": 2.0,
                "programStart": 3.0,
                "programEnd": 5.0,
                "isSilence": False,
            },
        ]
        segs = [(2.0, 5.0), (0.0, 2.0)]
        merged, slots, meta = merge_literal_segments_for_bake(clips, segs)
        self.assertEqual(len(merged), 2)
        self.assertEqual(meta["runs"], 2)
        self.assertEqual(len(slots), 2)

    def test_refine_segments_zero_cross(self) -> None:
        dur = 0.5
        t = np.arange(0, dur, 1.0 / SR, dtype=np.float32)
        samples = (0.2 * np.sin(2.0 * math.pi * 220.0 * t)).astype(np.float32)
        out = refine_segments_zero_cross(
            [(0.05, 0.12), (0.12, 0.2)],
            samples,
            dur_max=dur,
        )
        self.assertEqual(len(out), 2)
        self.assertLess(out[0][0], out[0][1])
        self.assertLessEqual(out[0][1], out[1][0] + 1e-3)


class FilterConcatTests(unittest.TestCase):
    def test_acrossfade_chain_two_segments(self) -> None:
        parts = build_audio_acrossfade_chain(
            ["[a0]", "[a1]"],
            "[a_out]",
            fade_sec=EXPORT_AUDIO_CROSSFADE_SEC,
        )
        self.assertEqual(len(parts), 1)
        self.assertIn("acrossfade", parts[0])
        self.assertIn("0.005000", parts[0])

    def test_trim_concat_uses_segment_afade_for_multi_audio(self) -> None:
        parts = build_trim_concat_filter_parts(
            [(0.0, 1.0), (1.0, 2.0)],
            has_audio=True,
            v_out="v_edit",
            a_out="a_edit",
            id_prefix="t",
            audio_crossfade_sec=0.005,
        )
        joined = ";".join(parts)
        self.assertIn("afade=t=in", joined)
        self.assertIn("afade=t=out", joined)
        self.assertIn("concat=n=2:v=1:a=0", joined)
        self.assertIn("concat=n=2:v=0:a=1", joined)

    def test_refine_time_snaps_near_zero(self) -> None:
        dur = 0.2
        t = np.arange(0, dur, 1.0 / SR, dtype=np.float32)
        samples = np.sin(2.0 * math.pi * 440.0 * t).astype(np.float32)
        refined = refine_time_to_zero_cross(
            samples, SR, 0.0105, 0.005, 0.005, dur_max=dur
        )
        idx = int(round(refined * SR))
        idx = max(0, min(len(samples) - 1, idx))
        self.assertLess(abs(float(samples[idx])), 0.08)


if __name__ == "__main__":
    unittest.main()
