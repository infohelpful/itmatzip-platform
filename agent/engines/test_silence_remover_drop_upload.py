"""Unit tests — Silence Detector 드래그 앤 드롭 업로드(임시 저장·삭제·만료 정리)."""

from __future__ import annotations

import asyncio
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

from routers import silence_remover as sr


class _FakeRequest:
    """starlette Request 의 headers·stream()만 흉내 낸다."""

    def __init__(self, chunks: list[bytes], content_length: int | None = None, fail_after: int | None = None) -> None:
        self._chunks = chunks
        self._fail_after = fail_after
        total = sum(len(c) for c in chunks)
        self.headers = {} if content_length is None and total == 0 else {"content-length": str(content_length if content_length is not None else total)}

    async def stream(self):
        for i, chunk in enumerate(self._chunks):
            if self._fail_after is not None and i >= self._fail_after:
                raise ConnectionError("client disconnected")
            yield chunk


def _run(coro):
    return asyncio.run(coro)


class DropUploadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "uploads"
        patcher = mock.patch.object(sr, "_DROP_UPLOAD_ROOT", self.root)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _upload(self, name: str, chunks: list[bytes], **kw):
        return _run(sr.post_drop_upload(_FakeRequest(chunks, **kw), name))

    def test_stores_under_sanitized_original_name_not_client_path(self) -> None:
        out = self._upload("../../evil/내 영상.MP4", [b"abc", b"def"])
        staged = Path(out["video_path"])
        self.assertEqual(staged.name, "내 영상.mp4")
        self.assertTrue(staged.parent.name.startswith("upload-"))
        self.assertEqual(staged.parent.parent, self.root.resolve())
        self.assertEqual(staged.read_bytes(), b"abcdef")
        self.assertEqual(out["size_bytes"], 6)
        self.assertEqual(out["file_name"], "내 영상.MP4")
        self.assertTrue(out["temporary"])

    def test_sanitizes_forbidden_characters_and_reserved_names(self) -> None:
        self.assertEqual(sr._staged_file_name('a<b>:c"d|e?f*.WAV', ".wav"), "a_b__c_d_e_f_.wav")
        self.assertEqual(sr._staged_file_name("CON.mp4", ".mp4"), "media.mp4")
        self.assertEqual(sr._staged_file_name("...mp4", ".mp4"), "media.mp4")
        self.assertEqual(sr._staged_file_name(("x" * 300) + ".mp3", ".mp3"), "x" * 120 + ".mp3")

    def test_rejects_unsupported_extension(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            self._upload("note.txt", [b"x"])
        self.assertEqual(ctx.exception.status_code, 415)
        self.assertFalse(self.root.exists() and any(self.root.iterdir()))

    def test_rejects_empty_and_removes_folder(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            self._upload("a.wav", [])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_rejects_oversize_by_content_length(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            self._upload("a.wav", [b"x"], content_length=sr._DROP_UPLOAD_MAX_BYTES + 1)
        self.assertEqual(ctx.exception.status_code, 413)

    def test_rejects_oversize_while_streaming_and_cleans_up(self) -> None:
        with mock.patch.object(sr, "_DROP_UPLOAD_MAX_BYTES", 5):
            with self.assertRaises(HTTPException) as ctx:
                self._upload("a.wav", [b"abc", b"defg"], content_length=3)
        self.assertEqual(ctx.exception.status_code, 413)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_disconnect_removes_partial_upload(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            self._upload("a.wav", [b"abc", b"def"], fail_after=1)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_bad_filename(self) -> None:
        for bad in ("", "x" * 300):
            with self.assertRaises(HTTPException) as ctx:
                self._upload(bad, [b"x"])
            self.assertEqual(ctx.exception.status_code, 400)

    def test_all_supported_extensions_accepted(self) -> None:
        for ext in sorted(sr._DROP_UPLOAD_EXTENSIONS):
            out = self._upload("clip" + ext.upper(), [b"x"])
            self.assertEqual(Path(out["video_path"]).suffix, ext)


class DropDeleteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "uploads"
        patcher = mock.patch.object(sr, "_DROP_UPLOAD_ROOT", self.root)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _staged(self) -> Path:
        out = _run(sr.post_drop_upload(_FakeRequest([b"data"]), "a.wav"))
        return Path(out["video_path"])

    def test_deletes_only_the_staged_folder(self) -> None:
        keep, gone = self._staged(), self._staged()
        self.assertEqual(sr.delete_drop_upload(str(gone)), {"deleted": True})
        self.assertFalse(gone.parent.exists())
        self.assertTrue(keep.is_file())

    def test_refuses_paths_outside_the_upload_root(self) -> None:
        outside = Path(self.tmp.name) / "my-video.mp4"
        outside.write_bytes(b"precious")
        evil_dir = Path(self.tmp.name) / "upload-fake"
        evil_dir.mkdir()
        evil = evil_dir / "media.wav"
        evil.write_bytes(b"x")
        for bad in (str(outside), str(evil), str(self.root), str(Path(self.tmp.name)), ""):
            with self.assertRaises(HTTPException) as ctx:
                sr.delete_drop_upload(bad)
            self.assertEqual(ctx.exception.status_code, 400)
        self.assertTrue(outside.is_file())
        self.assertTrue(evil.is_file())

    def test_refuses_other_files_inside_a_staged_folder(self) -> None:
        staged = self._staged()
        other = staged.parent / "notes.txt"
        other.write_text("x")
        with self.assertRaises(HTTPException):
            sr.delete_drop_upload(str(other))
        self.assertTrue(staged.is_file())

    def test_purge_removes_only_expired_inactive_folders(self) -> None:
        old, fresh, active = self._staged().parent, self._staged().parent, self._staged().parent
        # 업로드 응답 경로는 resolve()된 경로(Windows 짧은 이름 → 긴 이름)라, 서버가 쓰는 기준(업로드 루트 아래 경로)으로 맞춘다
        old, fresh, active = (self.root / p.name for p in (old, fresh, active))
        past = time.time() - sr._DROP_UPLOAD_TTL_SEC - 60
        for d in (old, active):
            os.utime(d, (past, past))
        with sr._DROP_UPLOAD_LOCK:
            sr._ACTIVE_DROP_UPLOADS.add(active)
        try:
            sr._purge_expired_drop_uploads()
        finally:
            with sr._DROP_UPLOAD_LOCK:
                sr._ACTIVE_DROP_UPLOADS.discard(active)
        self.assertFalse(old.exists())
        self.assertTrue(fresh.exists())
        self.assertTrue(active.exists())


if __name__ == "__main__":
    unittest.main()
