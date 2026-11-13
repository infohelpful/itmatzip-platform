"""Unit tests — Create Music 설치 다운로드 (Range 병렬 받기, 원격 분할 zip 골라 받기, PyTorch 받는 곳 순서)."""

from __future__ import annotations

import hashlib
import io
import os
import re
import tempfile
import threading
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from engines import create_music_fetch as fetch


class _RangeHandler(BaseHTTPRequestHandler):
    files: dict[str, bytes] = {}
    support_range = True

    def log_message(self, *_args) -> None:  # 조용히
        pass

    def do_GET(self) -> None:  # noqa: N802
        data = self.files.get(self.path)
        if data is None:
            self.send_response(404)
            self.end_headers()
            return
        rng = self.headers.get("Range")
        m = re.match(r"bytes=(\d+)-(\d*)$", rng or "")
        if m and self.support_range:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else len(data) - 1
            body = data[start : end + 1]
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
        else:
            body = data
            self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class _Server:
    def __init__(self, files: dict[str, bytes], *, support_range: bool = True) -> None:
        handler = type("H", (_RangeHandler,), {"files": files, "support_range": support_range})
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def __exit__(self, *_exc) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def _stored_zip(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


class FetchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        # 작은 조각으로 나눠 여러 연결 경로를 실제로 타게 함
        patcher = mock.patch.multiple(fetch, CHUNK_BYTES=1000, PARALLEL_MIN_BYTES=1)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_parallel_download_matches_and_checks_sha256(self) -> None:
        data = os.urandom(12_345)
        with _Server({"/a.whl": data}) as base:
            seen: list[tuple[int, int]] = []
            out = fetch.download_file(
                f"{base}/a.whl",
                self.dir / "a.whl",
                sha256=hashlib.sha256(data).hexdigest(),
                connections=4,
                progress=lambda d, t: seen.append((d, t)),
            )
            self.assertEqual(out.read_bytes(), data)
            self.assertEqual(seen[-1], (len(data), len(data)))
            self.assertFalse((self.dir / "a.whl.part").exists())

            with self.assertRaises(RuntimeError):
                fetch.download_file(f"{base}/a.whl", self.dir / "b.whl", sha256="0" * 64)
            self.assertFalse((self.dir / "b.whl").exists())

    def test_falls_back_to_single_stream_without_range(self) -> None:
        data = os.urandom(5_000)
        with _Server({"/a.whl": data}, support_range=False) as base:
            out = fetch.download_file(f"{base}/a.whl", self.dir / "a.whl")
            self.assertEqual(out.read_bytes(), data)

    def test_picks_members_out_of_split_remote_zip(self) -> None:
        entries = {
            "torch-2.7.1+cu128-cp312-cp312-win_amd64.whl": os.urandom(9_000),
            "numpy-2.5.1-cp312-cp312-win_amd64.whl": os.urandom(3_210),
            "tiny-1.0-py3-none-any.whl": b"x",
        }
        blob = _stored_zip(entries)
        cut = len(blob) // 2  # 항목 하나가 두 조각에 걸치도록
        with _Server({"/p.001": blob[:cut], "/p.002": blob[cut:]}) as base:
            parts, members = fetch.list_remote_zip([f"{base}/p.001", f"{base}/p.002"])
            self.assertEqual({m.name for m in members}, set(entries))
            wanted = [m for m in members if not m.name.startswith("torch-")]
            paths = fetch.download_remote_members(parts, wanted, self.dir, connections=3)
            self.assertEqual({p.name for p in paths}, set(entries) - {next(iter(entries))})
            for p in paths:
                self.assertEqual(p.read_bytes(), entries[p.name])
            self.assertFalse(any(self.dir.glob("*.part")))

    def test_segments_span_parts(self) -> None:
        parts = [fetch.RemotePart("u1", 10), fetch.RemotePart("u2", 10)]
        segs = fetch._segments_for(parts, 8, 5)
        self.assertEqual(
            segs,
            [fetch.Segment("u1", 8, 2, 0), fetch.Segment("u2", 0, 3, 2)],
        )
        with self.assertRaises(ValueError):
            fetch._segments_for(parts, 18, 5)


class TorchSourceOrderTests(unittest.TestCase):
    def setUp(self) -> None:
        from engines import create_music_acestep_runtime as rt

        self.rt = rt
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_official_first_then_github(self) -> None:
        rt = self.rt
        calls: list[str] = []

        def official(_d, _p):
            calls.append("official")
            raise RuntimeError("blocked")

        def hub(_d, _p):
            calls.append("github")
            return [Path("x.whl")]

        with mock.patch.dict(os.environ, {"ITMATZIP_CREATE_MUSIC_TORCH_SOURCE": ""}), mock.patch.object(
            rt, "_download_torch_official", official
        ), mock.patch.object(rt, "_download_torch_from_hub", hub):
            msgs: list[str] = []
            out = rt.download_pytorch_wheels(Path(self.tmp.name), message_cb=msgs.append)
        self.assertEqual(calls, ["official", "github"])
        self.assertEqual(out, [Path("x.whl")])
        self.assertTrue(any("보조 서버" in m for m in msgs))

    def test_official_success_skips_github(self) -> None:
        rt = self.rt
        hub = mock.Mock()
        with mock.patch.dict(os.environ, {"ITMATZIP_CREATE_MUSIC_TORCH_SOURCE": ""}), mock.patch.object(
            rt, "_download_torch_official", return_value=[Path("t.whl")]
        ), mock.patch.object(rt, "_download_torch_from_hub", hub):
            self.assertEqual(rt.download_pytorch_wheels(Path(self.tmp.name)), [Path("t.whl")])
        hub.assert_not_called()

    def test_both_fail_reports_both(self) -> None:
        rt = self.rt
        with mock.patch.dict(os.environ, {"ITMATZIP_CREATE_MUSIC_TORCH_SOURCE": ""}), mock.patch.object(
            rt, "_download_torch_official", side_effect=RuntimeError("a")
        ), mock.patch.object(rt, "_download_torch_from_hub", side_effect=RuntimeError("b")):
            with self.assertRaises(RuntimeError) as ctx:
                rt.download_pytorch_wheels(Path(self.tmp.name))
        self.assertIn("official: a", str(ctx.exception))
        self.assertIn("github: b", str(ctx.exception))

    def test_cleanup_removes_cache_lm_and_nano_but_keeps_models(self) -> None:
        root = Path(self.tmp.name)
        cm = root / "create-music"
        files = {
            "wheels-cache/parts/wheels_create_music.zip.001": b"x" * 10,
            "wheels-cache/wheel/numpy.whl": b"y",
            "nano-vllm-source/extracted/a.txt": b"z",
            "checkpoints/acestep-5Hz-lm-1.7B/model.safetensors": b"lm",
            "checkpoints/acestep-v15-turbo/model.safetensors": b"dit",
            "checkpoints/vae/model.safetensors": b"vae",
        }
        for rel, data in files.items():
            (cm / rel).parent.mkdir(parents=True, exist_ok=True)
            (cm / rel).write_bytes(data)
        env = {"ITMATZIP_AGENT_DATA": str(root), "ITMATZIP_ACESTEP_CHECKPOINTS": ""}
        with mock.patch.dict(os.environ, env):
            freed = self.rt.cleanup_install_cache()
        self.assertEqual(freed, 11)
        self.assertFalse((cm / "wheels-cache").exists())
        self.assertFalse((cm / "nano-vllm-source").exists())
        self.assertFalse((cm / "checkpoints/acestep-5Hz-lm-1.7B").exists())
        self.assertTrue((cm / "checkpoints/acestep-v15-turbo/model.safetensors").is_file())
        self.assertTrue((cm / "checkpoints/vae/model.safetensors").is_file())

    def test_official_url_escapes_plus(self) -> None:
        url = self.rt._official_torch_url("torch-2.7.1+cu128-cp312-cp312-win_amd64.whl")
        self.assertEqual(
            url,
            "https://download.pytorch.org/whl/cu128/torch-2.7.1%2Bcu128-cp312-cp312-win_amd64.whl",
        )

    def test_bundle_member_filter_skips_torch_trio_only(self) -> None:
        f = self.rt._is_bundle_package_member
        self.assertFalse(f("torch-2.7.1+cu128-cp312-cp312-win_amd64.whl"))
        self.assertFalse(f("torchvision-0.22.1+cu128-cp312-cp312-win_amd64.whl"))
        self.assertFalse(f("torchaudio-2.7.1+cu128-cp312-cp312-win_amd64.whl"))
        self.assertTrue(f("torchao-0.16.0-py3-none-any.whl"))
        self.assertTrue(f("torchcodec-0.15.0-cp312-cp312-win_amd64.whl"))
        self.assertTrue(f("sub/numpy-2.5.1-cp312-cp312-win_amd64.whl"))
        self.assertFalse(f("README.txt"))


if __name__ == "__main__":
    unittest.main()
