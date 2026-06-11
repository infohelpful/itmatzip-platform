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

    def test_min_archive_size_sane(self) -> None:
        self.assertGreater(_MIN_ARCHIVE_BYTES, 10 * 1024 * 1024)

    def test_is_ffmpeg_ready_false_when_missing(self) -> None:
        with mock.patch("common.bin_manager._ffmpeg_runtime_complete", return_value=False):
            self.assertFalse(is_ffmpeg_ready())


if __name__ == "__main__":
    unittest.main()
