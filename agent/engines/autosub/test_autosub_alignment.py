"""Tests for the WhisperX runtime bookkeeping (run: python -m unittest engines.autosub.test_autosub_alignment)."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engines.autosub import alignment, paths  # noqa: E402


class AlignmentRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.root = Path(self.dir.name) / "align"
        env = {"ITMATZIP_AUTOSUB_ALIGN_RUNTIME": str(self.root), "ITMATZIP_AUTOSUB_ALIGN_PYTHON": "",
               "ITMATZIP_AUTOSUB_MODELS_DIR": str(Path(self.dir.name) / "models")}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _fake_embedded_runtime(self, sidecar_dir: str) -> Path:
        python = self.root / "python" / "python.exe"
        (python.parent / "Lib" / "site-packages").mkdir(parents=True)
        python.write_bytes(b"")
        (self.root / "ready.json").write_text(json.dumps({"sidecarDir": sidecar_dir}), encoding="utf-8")
        return python

    def test_device_follows_installed_torch_build_and_gpu(self):
        self._fake_embedded_runtime(str(paths.SIDECAR_DIR))
        with mock.patch.object(alignment, "nvidia_present", return_value=True):
            self.assertEqual(alignment.device(), "cpu")  # CPU build installed
            self.assertTrue(alignment.status()["gpuUpgrade"])
            info = json.loads((self.root / "ready.json").read_text(encoding="utf-8"))
            (self.root / "ready.json").write_text(json.dumps({**info, "device": "cuda"}), encoding="utf-8")
            self.assertEqual(alignment.device(), "cuda")
            self.assertFalse(alignment.status()["gpuUpgrade"])
        with mock.patch.object(alignment, "nvidia_present", return_value=False):
            self.assertEqual(alignment.device(), "cpu")  # CUDA build but no GPU (card removed): CPU

    def test_gpu_wheels_come_from_library_hub_first_then_official(self):
        python = Path("python.exe")
        calls = []
        with mock.patch.object(alignment.hub_mirror, "wheels_supported", return_value=True),                 mock.patch.object(alignment, "_install_cuda_from_hub", side_effect=lambda *a: calls.append("hub")),                 mock.patch.object(alignment, "_install_cuda_torch", side_effect=lambda *a, **k: calls.append("official")),                 mock.patch.object(alignment, "_strip_build_only_files", return_value=0),                 mock.patch.object(alignment, "_verify"):
            self.assertTrue(alignment._try_cuda(python, 0, 1))
        self.assertEqual(calls, ["hub"])

        calls.clear()

        def hub_fails(*a):
            calls.append("hub")
            raise RuntimeError("mirror down")
        with mock.patch.object(alignment.hub_mirror, "wheels_supported", return_value=True),                 mock.patch.object(alignment, "_install_cuda_from_hub", side_effect=hub_fails),                 mock.patch.object(alignment, "_install_cuda_torch", side_effect=lambda *a, **k: calls.append("official")),                 mock.patch.object(alignment, "_strip_build_only_files", return_value=0),                 mock.patch.object(alignment, "_verify"):
            self.assertTrue(alignment._try_cuda(python, 0, 1))
        self.assertEqual(calls, ["hub", "official"])

    def test_revision_comes_from_the_sidecar(self):
        self.assertRegex(alignment.model_revision(), r"^[0-9a-f]{40}$")

    def test_not_installed_without_marker(self):
        (self.root / "python").mkdir(parents=True)
        (self.root / "python" / "python.exe").write_bytes(b"")
        self.assertIsNone(alignment.python_path())
        self.assertFalse(alignment.status()["installed"])

    def test_installed_runtime_is_used_and_repointed_after_agent_moves(self):
        python = self._fake_embedded_runtime(r"C:\old\agent\engines\autosub\sidecar")
        self.assertEqual(alignment.python_path(), str(python))
        pth = python.parent / "Lib" / "site-packages" / "autosub-sidecar.pth"
        self.assertEqual(pth.read_text(encoding="utf-8").strip(), str(paths.SIDECAR_DIR))
        marker = json.loads((self.root / "ready.json").read_text(encoding="utf-8"))
        self.assertEqual(marker["sidecarDir"], str(paths.SIDECAR_DIR))

    def test_override_wins_only_when_it_exists(self):
        with mock.patch.dict(os.environ, {"ITMATZIP_AUTOSUB_ALIGN_PYTHON": str(Path(self.dir.name) / "missing.exe")}):
            self.assertIsNone(alignment.python_path())
        exe = Path(self.dir.name) / "py.exe"
        exe.write_bytes(b"")
        with mock.patch.dict(os.environ, {"ITMATZIP_AUTOSUB_ALIGN_PYTHON": str(exe)}):
            self.assertEqual(alignment.python_path(), str(exe))

    def test_strip_removes_only_torch_build_libraries(self):
        python = self._fake_embedded_runtime(str(paths.SIDECAR_DIR))
        lib = python.parent / "Lib" / "site-packages" / "torch" / "lib"
        lib.mkdir(parents=True)
        (lib / "dnnl.lib").write_bytes(b"x" * 10)
        (lib / "torch_cpu.dll").write_bytes(b"y" * 5)
        self.assertEqual(alignment._strip_build_only_files(python), 10)
        self.assertEqual(sorted(p.name for p in lib.iterdir()), ["torch_cpu.dll"])

    def test_model_presence_needs_weights_and_config(self):
        snap = (paths.align_cache_dir() / "models--kresnik--wav2vec2-large-xlsr-korean" / "snapshots"
                / alignment.model_revision())
        snap.mkdir(parents=True)
        (snap / "config.json").write_text("{}")
        self.assertFalse(alignment.model_present())
        (snap / "model.safetensors").write_bytes(b"w")
        self.assertTrue(alignment.model_present())


if __name__ == "__main__":
    unittest.main()
