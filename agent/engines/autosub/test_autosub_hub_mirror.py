"""Tests for the library-hub engine mirror (run: python -m unittest engines.autosub.test_autosub_hub_mirror)."""
from __future__ import annotations

import hashlib
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engines.autosub import hub_mirror  # noqa: E402


class HubMirrorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.payload = b"engine bytes" * 100
        self.key = "test_asset"
        hub_mirror.ASSETS[self.key] = ("asset.bin", len(self.payload), hashlib.sha256(self.payload).hexdigest())

    def tearDown(self) -> None:
        hub_mirror.ASSETS.pop(self.key, None)

    def _fake_download(self, data: bytes):
        def run(url, part, size, on_progress):
            part.write_bytes(data)
        return run

    def test_every_asset_is_pinned(self) -> None:
        for key, (name, size, sha) in hub_mirror.ASSETS.items():
            if key == self.key:
                continue
            self.assertTrue(name.endswith(".zip"), name)
            self.assertGreater(size, 0)
            self.assertRegex(sha, r"^[0-9a-f]{64}$")
            self.assertTrue(hub_mirror.asset_url(key).startswith(hub_mirror.HUB_BASE_URL))

    def test_split_asset_is_joined_and_verified(self) -> None:
        whole = bytes(range(256)) * 40
        parts = [whole[:4000], whole[4000:]]
        sha = lambda b: hashlib.sha256(b).hexdigest()  # noqa: E731
        hub_mirror.SPLIT_ASSETS["test_split"] = ("big.zip", len(whole), sha(whole),
                                                 [("big.zip.001", len(parts[0]), sha(parts[0])),
                                                  ("big.zip.002", len(parts[1]), sha(parts[1]))])
        self.addCleanup(hub_mirror.SPLIT_ASSETS.pop, "test_split", None)
        by_url = {hub_mirror.split_asset_url("big.zip.001"): parts[0], hub_mirror.split_asset_url("big.zip.002"): parts[1]}

        def run(url, part, size, on_progress):
            part.write_bytes(by_url[url])
        with mock.patch.object(hub_mirror, "_download_once", run):
            path = hub_mirror.fetch_split("test_split", self.tmp)
        self.assertEqual(path.read_bytes(), whole)
        self.assertFalse((self.tmp / "big.zip.001").exists())

        path.unlink()
        by_url[hub_mirror.split_asset_url("big.zip.002")] = b"x" * len(parts[1])  # tampered part
        with mock.patch.object(hub_mirror, "_download_once", run), mock.patch.object(hub_mirror.time, "sleep"):
            with self.assertRaises(RuntimeError):
                hub_mirror.fetch_split("test_split", self.tmp)
        self.assertFalse((self.tmp / "big.zip").exists())

    def test_cuda_wheels_are_pinned_in_parts_under_2gb(self) -> None:
        name, size, sha, parts = hub_mirror.SPLIT_ASSETS["align_cuda_wheels"]
        self.assertRegex(sha, r"^[0-9a-f]{64}$")
        self.assertEqual(sum(p[1] for p in parts), size)
        self.assertTrue(all(p[1] < 2 * 1024**3 and p[0].startswith(name) for p in parts))

    def test_fetch_accepts_matching_file(self) -> None:
        with mock.patch.object(hub_mirror, "_download_once", self._fake_download(self.payload)):
            path = hub_mirror.fetch(self.key, self.tmp)
        self.assertEqual(path.read_bytes(), self.payload)
        self.assertFalse(path.with_name("asset.bin.part").exists())

    def test_fetch_rejects_wrong_content(self) -> None:
        wrong = b"x" * len(self.payload)
        with mock.patch.object(hub_mirror, "_download_once", self._fake_download(wrong)), \
                mock.patch.object(hub_mirror.time, "sleep"):
            with self.assertRaises(RuntimeError):
                hub_mirror.fetch(self.key, self.tmp)
        self.assertFalse((self.tmp / "asset.bin").exists())

    def test_fetch_rejects_wrong_size(self) -> None:
        with mock.patch.object(hub_mirror, "_download_once", self._fake_download(self.payload[:-1])), \
                mock.patch.object(hub_mirror.time, "sleep"):
            with self.assertRaises(RuntimeError):
                hub_mirror.fetch(self.key, self.tmp)

    def test_extract_replaces_target(self) -> None:
        archive = self.tmp / "a.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr("model.bin", b"new")
        dest = self.tmp / "model"
        dest.mkdir()
        (dest / "old.txt").write_text("old")
        hub_mirror.extract(archive, dest)
        self.assertEqual((dest / "model.bin").read_bytes(), b"new")
        self.assertFalse((dest / "old.txt").exists())

    def test_extract_rejects_path_traversal(self) -> None:
        archive = self.tmp / "evil.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr("../escape.txt", b"x")
        with self.assertRaises(RuntimeError):
            hub_mirror.extract(archive, self.tmp / "out")
        self.assertFalse((self.tmp / "escape.txt").exists())


if __name__ == "__main__":
    unittest.main()
