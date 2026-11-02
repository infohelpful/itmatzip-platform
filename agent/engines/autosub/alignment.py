"""WhisperX precise-alignment runtime: a private Python with torch 2.8 (CPU) plus the Korean model.

The desktop app runs `align_worker.py` in a separate interpreter given by AUTOSUBTITLE_ALIGN_PYTHON.
Here that interpreter is built on first use:

- installed agent (embeddable Python, which ignores PYTHONPATH and has no venv): copy the
  interpreter files into the runtime folder; packages go to its own Lib/site-packages
- development (full Python): a venv

Either way a .pth file puts the sidecar folder on sys.path so align_worker can import its modules.
Build-only torch files (torch/lib/*.lib, ~2.6GB) are removed after install, and only the
safetensors weights of the model are downloaded (see the desktop commit 5379aa6).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from . import paths

LOCK_FILE = paths.SIDECAR_DIR / "requirements-alignment-cpu-win.lock.txt"
TORCH_CPU_INDEX = "https://download.pytorch.org/whl/cpu"
MODEL_ID = "kresnik/wav2vec2-large-xlsr-korean"
MODEL_BYTES = 1_267_280_408  # model.safetensors + JSON configs at the pinned revision
RUNTIME_HINT_MB = 1400
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
_MARKER = "ready.json"
_PTH_NAME = "autosub-sidecar.pth"


def model_revision() -> str:
    """Pinned revision, read from the sidecar so the two never disagree."""
    text = (paths.SIDECAR_DIR / "alignment_runner.py").read_text(encoding="utf-8")
    match = re.search(r'KOREAN_MODEL_REVISION\s*=\s*"([0-9a-f]{40})"', text)
    if not match:
        raise RuntimeError("alignment_runner.py에서 모델 revision을 찾지 못했습니다.")
    return match.group(1)


def _base_python() -> Path:
    return Path(os.environ.get("ITMATZIP_AUTOSUB_ALIGN_BASE_PYTHON", "").strip() or sys.executable)


def _is_embeddable(python: Path) -> bool:
    return any(python.parent.glob("python3*._pth"))


def _runtime_python(root: Path | None = None) -> Path:
    root = root or paths.align_runtime_dir()
    embedded = root / "python" / "python.exe"
    return embedded if embedded.is_file() else root / "python" / "Scripts" / "python.exe"


def _site_packages(python: Path) -> Path:
    base = python.parent if python.parent.name.lower() != "scripts" else python.parent.parent
    return base / "Lib" / "site-packages"


def model_present() -> bool:
    snap = (paths.align_cache_dir() / f"models--{MODEL_ID.replace('/', '--')}" / "snapshots" / model_revision())
    return (snap / "model.safetensors").is_file() and (snap / "config.json").is_file()


def _write_sidecar_pth(python: Path) -> None:
    site = _site_packages(python)
    site.mkdir(parents=True, exist_ok=True)
    (site / _PTH_NAME).write_text(str(paths.SIDECAR_DIR) + "\n", encoding="utf-8")


def python_path() -> str | None:
    """Alignment interpreter to hand to the sidecar, or None (the sidecar then falls back to RMS)."""
    override = os.environ.get("ITMATZIP_AUTOSUB_ALIGN_PYTHON", "").strip()
    if override:
        return override if os.path.isfile(override) else None
    root = paths.align_runtime_dir()
    python = _runtime_python(root)
    marker = root / _MARKER
    if not python.is_file() or not marker.is_file():
        return None
    try:
        info = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if info.get("sidecarDir") != str(paths.SIDECAR_DIR):  # agent moved or updated: repoint, no reinstall
        _write_sidecar_pth(python)
        info["sidecarDir"] = str(paths.SIDECAR_DIR)
        marker.write_text(json.dumps(info), encoding="utf-8")
    return str(python)


def status() -> dict[str, Any]:
    return {"installed": python_path() is not None, "modelPresent": model_present(),
            "ready": python_path() is not None and model_present(),
            "downloadHintMb": RUNTIME_HINT_MB + round(MODEL_BYTES / 1024**2)}


# -- install -------------------------------------------------------------------------------
_lock = threading.Lock()
_state: dict[str, Any] = {"state": "idle", "pct": 0.0, "stage": "", "error": None}


def install_state() -> dict[str, Any]:
    with _lock:
        return dict(_state)


def _set(**kw: Any) -> None:
    with _lock:
        if "pct" in kw:
            kw["pct"] = max(_state["pct"], min(100.0, float(kw["pct"])))
        _state.update(kw)


def _create_interpreter(root: Path) -> Path:
    base = _base_python()
    target = root / "python"
    if _runtime_python(root).is_file():
        return _runtime_python(root)
    if target.exists():
        shutil.rmtree(target)
    if _is_embeddable(base):
        target.mkdir(parents=True)
        for item in base.parent.iterdir():
            if item.is_file():
                shutil.copy2(item, target / item.name)
        (target / "Lib" / "site-packages").mkdir(parents=True)
        return target / "python.exe"
    subprocess.run([str(base), "-m", "venv", str(target)], check=True, capture_output=True, creationflags=_NO_WINDOW)
    return target / "Scripts" / "python.exe"


def _pip_install(python: Path) -> None:
    if _is_embeddable(python):
        # The private copy has no pip; the agent's Python installs into its site-packages.
        cmd = [str(_base_python()), "-m", "pip", "install", "--target", str(_site_packages(python))]
    else:
        cmd = [str(python), "-m", "pip", "install"]
    cmd += ["--no-warn-script-location", "--disable-pip-version-check", "--only-binary=:all:",
            "--index-url", TORCH_CPU_INDEX, "--extra-index-url", "https://pypi.org/simple", "-r", str(LOCK_FILE)]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                            errors="replace", creationflags=_NO_WINDOW)
    tail: list[str] = []
    assert proc.stdout
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        tail = (tail + [line])[-20:]
        if line.startswith(("Downloading", "Collecting")):
            _set(pct=min(60.0, install_state()["pct"] + 0.4), stage=f"패키지 내려받는 중: {line.split()[1][:60]}")
        elif line.startswith("Installing collected packages"):
            _set(pct=60.0, stage="패키지 설치 중")
    if proc.wait() != 0:
        raise RuntimeError("정렬 런타임 설치 실패: " + (tail[-1] if tail else f"exit {proc.returncode}"))


def _strip_build_only_files(python: Path) -> int:
    torch_lib = _site_packages(python) / "torch" / "lib"
    freed = 0
    for lib in torch_lib.glob("*.lib"):
        freed += lib.stat().st_size
        lib.unlink()
    return freed


def _verify(python: Path) -> None:
    check = ("import torch, whisperx, forced_align; "
             "assert torch.__version__ == '2.8.0+cpu', torch.__version__")
    proc = subprocess.run([str(python), "-c", check], capture_output=True, timeout=600, creationflags=_NO_WINDOW,
                          env={**os.environ, "PYTHONUTF8": "1"})
    if proc.returncode != 0:
        raise RuntimeError("정렬 런타임 확인 실패: " + proc.stderr.decode("utf-8", "replace").strip()[-400:])


def _download_model(python: Path) -> None:
    cache = paths.align_cache_dir()
    cache.mkdir(parents=True, exist_ok=True)
    code = ("import sys; from huggingface_hub import snapshot_download; "
            "snapshot_download(sys.argv[1], revision=sys.argv[2], cache_dir=sys.argv[3], "
            "allow_patterns=['*.json', 'model.safetensors'])")
    repo_dir = cache / f"models--{MODEL_ID.replace('/', '--')}"
    start = sum(p.stat().st_size for p in repo_dir.rglob("*") if p.is_file()) if repo_dir.exists() else 0
    proc = subprocess.Popen([str(python), "-c", code, MODEL_ID, model_revision(), str(cache)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, creationflags=_NO_WINDOW)
    while proc.poll() is None:
        done = sum(p.stat().st_size for p in repo_dir.rglob("*") if p.is_file()) if repo_dir.exists() else 0
        _set(pct=72.0 + 27.0 * min(1.0, max(0, done - start) / MODEL_BYTES), stage="정렬 모델 내려받는 중")
        time.sleep(1.0)
    if proc.returncode != 0:
        raise RuntimeError("정렬 모델 다운로드 실패: " + proc.stderr.read().decode("utf-8", "replace").strip()[-400:])


def _run_install() -> None:
    root = paths.align_runtime_dir()
    try:
        root.mkdir(parents=True, exist_ok=True)
        (root / _MARKER).unlink(missing_ok=True)
        _set(pct=1.0, stage="정렬용 Python 준비")
        python = _create_interpreter(root)
        _write_sidecar_pth(python)
        _set(pct=3.0, stage="패키지 내려받는 중")
        _pip_install(python)
        _set(pct=68.0, stage="설치 정리 중")
        freed = _strip_build_only_files(python)
        _set(pct=70.0, stage="설치 확인 중")
        _verify(python)
        if not model_present():
            _download_model(python)
        (root / _MARKER).write_text(json.dumps({"sidecarDir": str(paths.SIDECAR_DIR), "strippedBytes": freed,
                                                "revision": model_revision()}), encoding="utf-8")
        _set(pct=100.0, stage="완료", state="done")
    except Exception as error:  # noqa: BLE001 - reported to the UI
        _set(state="error", error=str(error))


def start_install() -> dict[str, Any]:
    with _lock:
        if _state["state"] == "running":
            raise RuntimeError("정밀 정렬 설치가 이미 진행 중입니다.")
        _state.update(state="running", pct=0.0, stage="시작", error=None)
    threading.Thread(target=_run_install, name="autosub-align-install", daemon=True).start()
    return install_state()
