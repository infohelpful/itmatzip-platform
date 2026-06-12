"""Preview-parity programClip playback SSOT tests."""

from __future__ import annotations

import unittest

from engines.auto_subtitle_program_clip_playback import (
    clip_playback_source_end,
    list_and_source_successors_match,
)
from engines.auto_subtitle_program_clips import program_clips_to_literal_bake_segments


class ProgramClipPlaybackTests(unittest.TestCase):
    def test_playback_source_end_prefers_effective(self) -> None:
        clip = {
            "sourceStart": 0.0,
            "sourceEnd": 5.2,
            "effectiveSourceEnd": 5.0,
        }
        self.assertAlmostEqual(clip_playback_source_end(clip), 5.0)

    def test_literal_bake_uses_effective_end(self) -> None:
        clips = [
            {
                "id": "a",
                "sourceStart": 0.0,
                "sourceEnd": 5.2,
                "effectiveSourceEnd": 5.0,
                "programStart": 0.0,
                "programEnd": 5.0,
                "isSilence": False,
            }
        ]
        segs = program_clips_to_literal_bake_segments(clips)
        self.assertEqual(segs, [(0.0, 5.0)])

    def test_reorder_successors_do_not_match(self) -> None:
        clips = [
            {
                "id": "line2",
                "blockIndex": 0,
                "sourceStart": 2.0,
                "sourceEnd": 5.0,
                "isSilence": False,
            },
            {
                "id": "line1",
                "blockIndex": 1,
                "sourceStart": 0.0,
                "sourceEnd": 2.0,
                "isSilence": False,
            },
        ]
        self.assertFalse(list_and_source_successors_match(clips, 0, 1))

    def test_monotonic_list_successors_match(self) -> None:
        clips = [
            {
                "id": "a",
                "blockIndex": 0,
                "sourceStart": 0.0,
                "sourceEnd": 5.0,
                "isSilence": False,
            },
            {
                "id": "b",
                "blockIndex": 1,
                "sourceStart": 5.0,
                "sourceEnd": 8.0,
                "isSilence": False,
            },
        ]
        self.assertTrue(list_and_source_successors_match(clips, 0, 1))


if __name__ == "__main__":
    unittest.main()
