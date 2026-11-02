"""Tests for the AutoSubtitle web engine media port (run: python -m pytest agent/engines/autosub)."""
from __future__ import annotations

import base64
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engines.autosub import media, paths  # noqa: E402
from routers.autosub import decode_path_token  # noqa: E402


def _wav(path: Path, frames: int, rf64: bool = False) -> bytes:
    pcm = bytes(i % 256 for i in range(frames * 4))
    fmt = struct.pack("<HHIIHH", 1, 2, 48000, 192000, 4, 16)
    body = b"WAVE" + b"fmt " + struct.pack("<I", 16) + fmt
    if rf64:
        body = b"WAVE" + b"ds64" + struct.pack("<I", 28) + struct.pack("<QQQI", 0, len(pcm), frames, 0) + body[4:]
        body += b"data" + struct.pack("<I", 0xFFFFFFFF) + pcm
        path.write_bytes(b"RF64" + struct.pack("<I", 0xFFFFFFFF) + body)
    else:
        body += b"data" + struct.pack("<I", len(pcm)) + pcm
        path.write_bytes(b"RIFF" + struct.pack("<I", len(body)) + body)
    return pcm


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.root = Path(self.dir.name)
        patcher = mock.patch.dict(os.environ, {"ITMATZIP_AGENT_DATA": str(self.root)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.cache = paths.prepared_media_dir()
        self.cache.mkdir(parents=True)

    def test_parse_timing_matches_desktop_rules(self):
        timing = media.parse_media_timing({
            "streams": [{"codec_type": "video", "start_time": "1.5", "duration": "10", "width": 720, "height": 480,
                         "sample_aspect_ratio": "32:27", "avg_frame_rate": "30000/1001"},
                        {"codec_type": "audio"}],
            "format": {"start_time": "1.5", "duration": "10", "format_name": "mov,mp4"}})
        self.assertEqual((timing.width, timing.height), (854, 480))
        self.assertTrue(timing.has_audio)
        self.assertTrue(timing.needs_preview_normalization)  # nonzero origin
        self.assertEqual(timing.duration, 10.0)

    def test_parse_timing_rotated_and_zero_origin(self):
        timing = media.parse_media_timing({
            "streams": [{"codec_type": "video", "start_time": "0", "duration": "4", "width": 1920, "height": 1080,
                         "side_data_list": [{"rotation": -90}]}],
            "format": {"start_time": "0", "duration": "4", "format_name": "mov,mp4"}})
        self.assertEqual((timing.width, timing.height), (1080, 1920))
        self.assertFalse(timing.needs_preview_normalization)

    def test_reads_requested_pcm_ranges_riff_and_rf64(self):
        for rf64 in (False, True):
            wav = self.cache / ("a" * 64 + ".wav")
            pcm = _wav(wav, 1000, rf64=rf64)
            total, data = media.read_prepared_pcm(str(wav), [{"startFrame": 10, "frameCount": 5},
                                                            {"startFrame": 0, "frameCount": 2}])
            self.assertEqual(total, 1000)
            self.assertEqual(data, pcm[40:60] + pcm[0:8])

    def test_pcm_outside_cache_or_range_is_refused(self):
        outside = self.root / ("b" * 64 + ".wav")
        _wav(outside, 10)
        with self.assertRaisesRegex(ValueError, "캐시"):
            media.read_prepared_pcm(str(outside), [{"startFrame": 0, "frameCount": 1}])
        wav = self.cache / ("c" * 64 + ".wav")
        _wav(wav, 10)
        with self.assertRaisesRegex(ValueError, "범위"):
            media.read_prepared_pcm(str(wav), [{"startFrame": 5, "frameCount": 6}])
        with self.assertRaisesRegex(ValueError, "너무 큽니다"):
            media.read_prepared_pcm(str(wav), [{"startFrame": 0, "frameCount": 48000 * 7}])

    def test_only_registered_media_and_engine_caches_are_servable(self):
        video = self.root / "clip.mp4"
        video.write_bytes(b"x")
        secret = self.root / "secret.txt"
        secret.write_text("no")
        self.assertFalse(media.is_servable(video))
        media.existing_media_file(str(video))
        self.assertTrue(media.is_servable(video))
        self.assertFalse(media.is_servable(secret))
        self.assertTrue(media.is_servable(self.cache / "anything.wav"))
        with self.assertRaisesRegex(ValueError, "형식"):
            media.existing_media_file(str(secret))

    def test_path_token_round_trips_korean_paths(self):
        path = r"E:\영상\테스트 1.mp4"
        token = base64.urlsafe_b64encode(path.encode("utf-8")).decode("ascii").rstrip("=")
        self.assertEqual(decode_path_token(token), path)


if __name__ == "__main__":
    unittest.main()
