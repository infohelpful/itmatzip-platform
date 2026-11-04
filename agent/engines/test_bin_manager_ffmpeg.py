"""Unit tests — FFmpeg download URL list and readiness helpers."""

from __future__ import annotations

import unittest
from unittest import mock

from common.bin_manager import (
    _fetch_ffmpeg_urls_from_github_api,
    _rank_ffmpeg_asset_name,
    _MIN_ARCHIVE_BYTES,
    is_ffmpeg_ready,
)


class BinManagerFfmpegTests(unittest.TestCase):
    def test_rank_prefers_n71_stable(self) -> None:
        n71 = "ffmpeg-n7.1.4-9-gc06af95f12-win64-gpl-shared-7.1.zip"
        n81 = "ffmpeg-n8.1.1-11-ge4c7fbf6c0-win64-gpl-shared-8.1.zip"
        master = "ffmpeg-N-124941-g54749da98a-win64-gpl-shared.zip"
        self.assertLess(_rank_ffmpeg_asset_name(n71)[0], _rank_ffmpeg_asset_name(n81)[0])
        self.assertLess(_rank_ffmpeg_asset_name(n81)[0], _rank_ffmpeg_asset_name(master)[0])

    def test_fetch_github_api_returns_working_urls(self) -> None:
        urls = _fetch_ffmpeg_urls_from_github_api()
        self.assertGreaterEqual(len(urls), 1)
        self.assertTrue(all("win64-gpl-shared" in u.lower() for u in urls))
        self.assertTrue(all(u.startswith("https://github.com/") for u in urls))

    def test_pinned_ffmpeg_is_tried_first(self) -> None:
        import common.bin_manager as bm

        with mock.patch.dict("os.environ", {"ITMATZIP_FFMPEG_URL": ""}), \
                mock.patch.object(bm, "_read_ffmpeg_url_cache", return_value=["https://example.invalid/latest.zip"]):
            urls = bm._ffmpeg_download_urls()
        self.assertEqual(urls[: len(bm.PINNED_FFMPEG_URLS)], list(bm.PINNED_FFMPEG_URLS))
        self.assertTrue(bm.PINNED_FFMPEG_URLS[0].startswith("https://github.com/infohelpful/library-hub/"))
        self.assertIn("-n7.1", bm.PINNED_FFMPEG_NAME)
        self.assertIn("https://example.invalid/latest.zip", urls)

    def test_pinned_ffmpeg_rejects_other_file(self) -> None:
        import tempfile
        from pathlib import Path

        import common.bin_manager as bm

        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "ffmpeg.zip"
            archive.write_bytes(b"x" * 1024)
            with self.assertRaises(RuntimeError):
                bm._verify_pinned_ffmpeg_archive(archive)
            self.assertFalse(archive.exists())

    def test_min_archive_size_sane(self) -> None:
        self.assertGreater(_MIN_ARCHIVE_BYTES, 10 * 1024 * 1024)

    def test_is_ffmpeg_ready_false_when_missing(self) -> None:
        with mock.patch("common.bin_manager._ffmpeg_runtime_complete", return_value=False):
            self.assertFalse(is_ffmpeg_ready())


if __name__ == "__main__":
    unittest.main()
