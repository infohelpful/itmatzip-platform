"""Unit tests — program-master bake ladder routing (mock ffmpeg)."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from engines.auto_subtitle_program_clips import (
    program_clips_to_literal_bake_segments,
    validate_literal_bake_segments,
)
from engines.auto_subtitle_program_bake_l1 import (
    L1_MAX_SEGMENTS,
    try_bake_l1_concat_copy,
    try_bake_l1_concat_reencode,
    try_bake_program_master_l1,
)
from engines.auto_subtitle_program_master import (
    DURATION_PROBE_EPS,
    bake_program_master,
    try_bake_program_master_l0_copy,
)


class ProgramBakeLadderRoutingTests(unittest.TestCase):
    def test_l1_skipped_when_segment_count_exceeds_max(self) -> None:
        segs = [(float(i), float(i) + 1.0) for i in range(L1_MAX_SEGMENTS + 1)]
        with tempfile.TemporaryDirectory() as tmp:
            job = Path(tmp)
            preview = job / "preview.mp4"
            preview.write_bytes(b"x")
            ok, path, metrics = try_bake_l1_concat_copy(
                preview, segs, job, expected_program_end=float(len(segs))
            )
            self.assertFalse(ok)
            self.assertIsNone(path)
            self.assertTrue(metrics.get("skipped"))

    @mock.patch("engines.auto_subtitle_program_bake_l1._concat_ffmpeg")
    @mock.patch("engines.auto_subtitle_program_bake_l1.evaluate_dual_quality_gate")
    @mock.patch("engines.auto_subtitle_program_bake_l1.write_concat_demuxer_list")
    def test_l1_copy_success(
        self,
        mock_write: mock.MagicMock,
        mock_gate: mock.MagicMock,
        mock_ffmpeg: mock.MagicMock,
    ) -> None:
        mock_write.return_value = 2
        mock_gate.return_value = (True, {"av_delta_sec": 0.01})

        with tempfile.TemporaryDirectory() as tmp:
            job = Path(tmp)
            preview = job / "preview.mp4"
            preview.write_bytes(b"x")
            segs = [(0.0, 5.0), (5.0, 10.0)]
            ok, path, metrics = try_bake_l1_concat_copy(
                preview, segs, job, expected_program_end=10.0
            )
            self.assertTrue(ok)
            self.assertIsNotNone(path)
            self.assertEqual(metrics.get("bake_level"), "l1_copy")
            mock_ffmpeg.assert_called_once()

    @mock.patch("engines.auto_subtitle_program_bake_l1.try_bake_l1_concat_reencode")
    @mock.patch("engines.auto_subtitle_program_bake_l1.try_bake_l1_filter_crossfade")
    @mock.patch("engines.auto_subtitle_program_bake_l1.try_bake_l1_concat_copy")
    def test_l1_ladder_falls_through_to_reencode(
        self,
        mock_copy: mock.MagicMock,
        mock_filter: mock.MagicMock,
        mock_re: mock.MagicMock,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            job = Path(tmp)
            preview = job / "preview.mp4"
            preview.write_bytes(b"x")
            out = job / "program-master.mp4"
            tmp_re = job / "tmp_pmaster_l1_reencode.mp4"
            tmp_re.write_bytes(b"re")
            mock_copy.return_value = (False, None, {"gate_passed": False})
            mock_filter.return_value = (False, None, {"gate_passed": False})
            mock_re.return_value = (True, tmp_re, {"bake_level": "l1_reencode"})

            ok, level, metrics = try_bake_program_master_l1(
                preview, [(0.0, 3.0)], out, 3.0
            )
            self.assertTrue(ok)
            self.assertEqual(level, "l1_reencode")
            self.assertTrue(out.is_file())
            mock_copy.assert_called_once()
            mock_filter.assert_called_once()
            mock_re.assert_called_once()

    @mock.patch("engines.auto_subtitle_program_master.build_filter_program_av_chain_chunked")
    @mock.patch("engines.auto_subtitle_program_master._run_ffmpeg_with_progress")
    @mock.patch("engines.auto_subtitle_program_master.probe_media_timing")
    @mock.patch("engines.auto_subtitle_program_master.try_bake_program_master_l0_copy")
    @mock.patch("engines.auto_subtitle_program_master._probe_has_audio")
    def test_bake_program_master_l0_then_l1_routing(
        self,
        mock_has_audio: mock.MagicMock,
        mock_l0: mock.MagicMock,
        mock_probe: mock.MagicMock,
        mock_ffmpeg: mock.MagicMock,
        mock_chain: mock.MagicMock,
    ) -> None:
        mock_has_audio.return_value = True
        mock_l0.return_value = False
        mock_chain.return_value = ("[0:v]null[vmain]", "[aout]")
        mock_probe.return_value = {
            "ok": True,
            "playback_duration_sec": 12.0,
            "video_duration_sec": 12.0,
        }

        with tempfile.TemporaryDirectory() as tmp:
            job = Path(tmp)
            preview = job / "preview.mp4"
            preview.write_bytes(b"x")
            clips = [
                {
                    "sourceStart": 0.0,
                    "sourceEnd": 6.0,
                    "programStart": 0.0,
                    "programEnd": 6.0,
                },
                {
                    "sourceStart": 6.0,
                    "sourceEnd": 12.0,
                    "programStart": 6.0,
                    "programEnd": 12.0,
                },
            ]

            with mock.patch(
                "engines.auto_subtitle_program_bake_l1.try_bake_program_master_l1",
            ) as mock_l1:
                def l1_side_effect(preview_media, segments, out, expected, **kwargs):
                    out.write_bytes(b"ok")
                    return True, "l1_copy", {"bake_level": "l1_copy"}

                mock_l1.side_effect = l1_side_effect

                path, dur, metrics = bake_program_master(
                    preview,
                    clips,
                    job,
                    program_duration_sec=12.0,
                )
                self.assertEqual(metrics["bake_level"], "l1_copy")
                self.assertAlmostEqual(dur, 12.0, delta=DURATION_PROBE_EPS)
                mock_l1.assert_called_once()

    @mock.patch("engines.auto_subtitle_program_master.build_filter_program_av_chain_chunked")
    @mock.patch("engines.auto_subtitle_program_master._run_ffmpeg_with_progress")
    @mock.patch("engines.auto_subtitle_program_master.probe_media_timing")
    @mock.patch("engines.auto_subtitle_program_master.try_bake_program_master_l0_copy")
    @mock.patch("engines.auto_subtitle_program_master._probe_has_audio")
    def test_bake_program_master_skips_l1_when_too_many_segments(
        self,
        mock_has_audio: mock.MagicMock,
        mock_l0: mock.MagicMock,
        mock_probe: mock.MagicMock,
        mock_ffmpeg: mock.MagicMock,
        mock_chain: mock.MagicMock,
    ) -> None:
        mock_has_audio.return_value = True
        mock_l0.return_value = False
        mock_chain.return_value = ("[0:v]null[vmain]", "[aout]")
        mock_probe.return_value = {
            "ok": True,
            "playback_duration_sec": 200.0,
        }

        clips = [
            {
                "sourceStart": float(i * 3.0),
                "sourceEnd": float(i * 3.0) + 0.4,
                "programStart": float(i * 0.4),
                "programEnd": float(i * 0.4) + 0.4,
            }
            for i in range(L1_MAX_SEGMENTS + 5)
        ]

        with tempfile.TemporaryDirectory() as tmp:
            job = Path(tmp)
            preview = job / "preview.mp4"
            preview.write_bytes(b"x")

            with mock.patch(
                "engines.auto_subtitle_program_bake_l1.try_bake_program_master_l1",
            ) as mock_l1:
                bake_program_master(
                    preview,
                    clips,
                    job,
                    program_duration_sec=clips[-1]["programEnd"],
                )
                mock_l1.assert_not_called()
                mock_ffmpeg.assert_called_once()


class ProgramClipsLiteralBakeTests(unittest.TestCase):
    def test_literal_segments_one_per_clip_reorder(self) -> None:
        clips = [
            {
                "sourceStart": 0.0,
                "sourceEnd": 2.0,
                "programStart": 0.0,
                "programEnd": 2.0,
                "blockIndex": 0,
            },
            {
                "sourceStart": 10.0,
                "sourceEnd": 12.0,
                "programStart": 2.0,
                "programEnd": 4.0,
                "blockIndex": 1,
            },
            {
                "sourceStart": 5.0,
                "sourceEnd": 11.0,
                "programStart": 4.0,
                "programEnd": 10.0,
                "blockIndex": 2,
            },
        ]
        segs = program_clips_to_literal_bake_segments(clips)
        self.assertEqual(len(segs), 3)
        validate_literal_bake_segments(clips, segs, program_duration_sec=10.0)

    def test_literal_parity_rejects_segment_count_mismatch(self) -> None:
        clips = [{"sourceStart": 0.0, "sourceEnd": 1.0, "programEnd": 1.0}]
        with self.assertRaises(ValueError):
            validate_literal_bake_segments(clips, [])


if __name__ == "__main__":
    unittest.main()
