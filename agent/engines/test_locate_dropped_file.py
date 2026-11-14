"""Unit tests — 드롭된 파일의 원본 경로 찾기."""

from __future__ import annotations

import os
import tempfile
import time
import unittest
from pathlib import Path

from common.locate_dropped_file import find_dropped_file


class LocateDroppedFileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "a" / "b").mkdir(parents=True)
        self.target = self.root / "a" / "b" / "내 영상.MP4"
        self.target.write_bytes(b"x" * 1234)
        self.mtime = time.time() - 5000
        os.utime(self.target, (self.mtime, self.mtime))

    def _find(self, name="내 영상.MP4", size=1234, mtime=None, **kw):
        return find_dropped_file(name, size, (self.mtime if mtime is None else mtime) * 1000, roots=[self.root], **kw)

    def test_finds_by_name_size_mtime(self) -> None:
        out = self._find()
        self.assertTrue(out["found"])
        self.assertEqual(Path(out["candidates"][0]), self.target)

    def test_case_insensitive_name_on_windows_only_semantics(self) -> None:
        out = self._find(name="내 영상.MP4")
        self.assertTrue(out["found"])

    def test_wrong_size_or_mtime_not_found(self) -> None:
        self.assertFalse(self._find(size=1235)["found"])
        self.assertFalse(self._find(mtime=self.mtime + 600)["found"])

    def test_same_name_other_size_is_ignored(self) -> None:
        other = self.root / "a" / "내 영상.MP4"
        other.write_bytes(b"y" * 10)
        out = self._find()
        self.assertEqual([Path(p) for p in out["candidates"]], [self.target])

    def test_skips_excluded_dirs(self) -> None:
        skip = self.root / "node_modules"
        skip.mkdir()
        (skip / "n.wav").write_bytes(b"z" * 5)
        out = find_dropped_file("n.wav", 5, None, roots=[self.root])
        self.assertFalse(out["found"])

    def test_missing_mtime_matches_by_name_and_size(self) -> None:
        out = find_dropped_file("내 영상.MP4", 1234, None, roots=[self.root])
        self.assertTrue(out["found"])

    def test_budget_exhausted_reports_timeout(self) -> None:
        out = find_dropped_file("nope.mp4", 1, None, roots=[self.root], budget_sec=0.0)
        self.assertFalse(out["found"])


if __name__ == "__main__":
    unittest.main()
