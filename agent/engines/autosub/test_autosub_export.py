"""Tests for the AutoSubtitle export port (run: python -m unittest engines.autosub.test_autosub_export)."""
from __future__ import annotations

import struct
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engines.autosub import export  # noqa: E402


def _png(width: int, height: int) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    raw = b"".join(b"\x00" + bytes(width * 4) for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.root = Path(self.dir.name)

    def test_render_dimensions_match_desktop(self):
        self.assertEqual(export.render_dimensions(3840, 2160), (1920, 1080))
        self.assertEqual(export.render_dimensions(1080, 1920), (608, 1080))
        self.assertEqual(export.render_dimensions(640, 360), (640, 360))
        self.assertEqual(export.render_dimensions(100, 100), (320, 240))

    def test_downloads_dir_is_an_existing_folder(self):
        folder = export.downloads_dir()
        self.assertTrue(folder.is_dir())

    def test_save_text_writes_bom_utf8_without_overwriting_and_allows_show_in_folder(self):
        source = self.root / "강의 영상.mp4"
        first = export.save_text(str(source), str(self.root), "srt", "1\n00:00:00,000 --> 00:00:01,000\n안녕\n")
        self.assertEqual(first.name, "강의 영상_AutoSubtitle.srt")
        self.assertEqual(first.read_bytes()[:3], b"\xef\xbb\xbf")
        self.assertIn("안녕", first.read_text(encoding="utf-8-sig"))
        second = export.save_text(str(source), str(self.root), ".srt", "x")
        self.assertEqual(second.name, "강의 영상_AutoSubtitle (2).srt")
        self.assertIn(__import__("os").path.normcase(str(second)), export._exported)
        with self.assertRaises(ValueError):
            export.save_text(str(source), str(self.root), "exe", "x")
        with self.assertRaises(ValueError):
            export.save_text(str(source), str(self.root / "missing"), "srt", "x")

    def test_output_never_overwrites_and_never_targets_the_source(self):
        source = self.root / "clip.mp4"
        source.write_bytes(b"x")
        first = export.output_path(source, str(self.root), ".mp4")
        self.assertEqual(first.name, "clip_AutoSubtitle.mp4")
        first.write_bytes(b"y")
        self.assertEqual(export.output_path(source, str(self.root), ".mp4").name, "clip_AutoSubtitle (2).mp4")
        with self.assertRaisesRegex(ValueError, "폴더"):
            export.output_path(source, str(self.root / "missing"), ".mp4")

    def test_clip_plan_rejects_gaps_and_overruns(self):
        ok = [{"occurrenceId": "a", "sourceStart": 0, "sourceEnd": 2, "programStart": 0},
              {"occurrenceId": "b", "sourceStart": 5, "sourceEnd": 6, "programStart": 2}]
        self.assertEqual(export.program_duration(export.validate_clip_plan(ok, 10)), 3)
        with self.assertRaises(ValueError):
            export.validate_clip_plan([{**ok[0]}, {**ok[1], "programStart": 2.5}], 10)
        with self.assertRaises(ValueError):
            export.validate_clip_plan([{**ok[0], "sourceEnd": 11}], 10)
        with self.assertRaises(ValueError):
            export.validate_clip_plan([ok[0], {**ok[1], "occurrenceId": "a"}], 10)

    def test_progress_parse(self):
        self.assertEqual(export.progress_percent("out_time_us=5000000", 10), 50)
        self.assertEqual(export.progress_percent("out_time_us=20000000", 10), 99)
        self.assertIsNone(export.progress_percent("frame=12", 10))

    def test_states_must_arrive_in_order_at_render_size(self):
        job = export._new_job("video", self.root / "out.mp4")
        job.update(render=(4, 2), states=0, timing=SimpleNamespace(duration=1.0))
        with self.assertRaisesRegex(ValueError, "순서"):
            export.put_state(job["id"], 1, _png(4, 2))
        with self.assertRaisesRegex(ValueError, "크기"):
            export.put_state(job["id"], 0, _png(5, 2))
        with self.assertRaisesRegex(ValueError, "PNG"):
            export.put_state(job["id"], 0, b"not a png")
        export.put_state(job["id"], 0, _png(4, 2))
        self.assertTrue((job["tmp"] / "state_000000.png").is_file())
        with self.assertRaisesRegex(ValueError, "맞지 않습니다"):
            export.start_encode(job["id"], [{"startFrame": 0, "endFrame": 5}, {"startFrame": 5, "endFrame": 9}],
                                [{"occurrenceId": "a", "sourceStart": 0, "sourceEnd": 1, "programStart": 0}])
        with self.assertRaisesRegex(ValueError, "구간"):
            export.start_encode(job["id"], [{"startFrame": 5, "endFrame": 5}],
                                [{"occurrenceId": "a", "sourceStart": 0, "sourceEnd": 1, "programStart": 0}])
        export._finish(job, error="test")

    def test_show_in_folder_only_for_exported_files(self):
        stray = self.root / "secret.txt"
        stray.write_text("x")
        self.assertFalse(export.show_in_folder(str(stray)))


if __name__ == "__main__":
    unittest.main()
