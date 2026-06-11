"""Transcribe completes without program-master fields (deferred baking)."""

from __future__ import annotations

import unittest


class TranscribeDeferredMasterTest(unittest.TestCase):
    def test_completed_result_excludes_program_master_keys(self) -> None:
        """Document contract: transcribe result must not require program master."""
        sample = {
            "cues": [],
            "preview_media_path": "/tmp/preview.mp4",
            "media_timing": {"ok": True},
            "waveform_peaks": {"ok": False},
        }
        for key in (
            "program_master_path",
            "program_duration_sec",
            "program_master_probe_ok",
            "bake_level",
        ):
            self.assertNotIn(key, sample)

    def test_export_pipeline_bakes_when_master_missing(self) -> None:
        from engines.auto_subtitle_export import export_video_program_ssot_pipeline

        source = open(export_video_program_ssot_pipeline.__code__.co_filename, encoding="utf-8")
        body = source.read()
        source.close()
        self.assertIn("if master_path is None:", body)
        self.assertIn("bake_program_master(", body)


if __name__ == "__main__":
    unittest.main()
