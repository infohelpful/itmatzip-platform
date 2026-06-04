"""Auto Subtitle — Faster-Whisper 전사·모델 준비 (ItMatZip Agent)."""

from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from common.bin_manager import ensure_ffmpeg, get_ffmpeg_executable, is_file_locked_error, prepend_ffmpeg_bin_to_env
from common.runtime_site_packages import (
    TOOL_AUTO_SUBTITLE,
    activate_runtime_site_packages,
    pip_install_cmd,
    tool_has_module,
    verify_importable,
)
from common.subprocess_util import no_window_creationflags, run_hidden
from runtime_paths import is_frozen

RUNTIME_TOOL_ID = TOOL_AUTO_SUBTITLE

PrepareProgressCallback = Callable[[float, str, str], None]

HF_REPO_ID = "deepdml/faster-whisper-large-v3-turbo-ct2"
LOCAL_MODEL_NAME = "deepdml-faster-whisper-large-v3-turbo-ct2"

ALLOWED_MEDIA_SUFFIXES = {
    ".mp4",
    ".mkv",
    ".avi",
    ".mov",
    ".webm",
    ".m4v",
    ".mp3",
    ".wav",
    ".flac",
    ".m4a",
    ".aac",
    ".ogg",
    ".wma",
    ".opus",
}

ALLOWED_IMAGE_SUFFIXES = {
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".bmp",
}

_whisper_model: Any | None = None
_model_device: str | None = None
_prepare_progress_max: float = -1.0


def _agent_data_root() -> Path:
    data = os.environ.get("ITMATZIP_AGENT_DATA", "").strip()
    if data:
        return Path(data)
    appdata = os.environ.get("APPDATA", "").strip()
    if appdata:
        return Path(appdata) / "ItMatZip"
    return Path.home() / ".itmatzip"


AUTO_SUBTITLE_ROOT = _agent_data_root() / "auto-subtitle"
MODEL_ROOT = AUTO_SUBTITLE_ROOT / "models"
WORKSPACE_ROOT = AUTO_SUBTITLE_ROOT / "workspace"
LOCAL_MODEL_DIR = MODEL_ROOT / LOCAL_MODEL_NAME
_STAGING_MODEL_DIR = MODEL_ROOT / f".{LOCAL_MODEL_NAME}.staging"
_ACTIVE_MODEL_MARKER = MODEL_ROOT / "active_model_dir.txt"
_MODEL_DOWNLOAD_LOCK = MODEL_ROOT / ".model_download.lock"
_HF_HUB_CACHE_DIR = MODEL_ROOT / ".hf-cache"
_STALE_MODEL_LOCK_SEC = 600.0

_transcribe_lock = threading.RLock()
_transcribe_thread: threading.Thread | None = None


@dataclass
class TranscribeJobStatus:
    phase: str
    progress: float
    message: str | None = None
    result: dict[str, Any] | None = None
    error: str | None = None


_transcribe_job = TranscribeJobStatus(phase="idle", progress=0.0, message=None)


def ensure_workspace() -> Path:
    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    return WORKSPACE_ROOT


def is_allowed_download_path(path: Path) -> bool:
    """다운로드 API — workspace 이하만 허용."""
    try:
        resolved = path.resolve()
        workspace = WORKSPACE_ROOT.resolve()
        return resolved == workspace or workspace in resolved.parents
    except OSError:
        return False


def normalize_media_path(raw: str) -> str:
    p = unicodedata.normalize("NFC", raw).strip().strip('"').strip("'")
    p = p.replace("¥", "\\").replace("₩", "\\")
    p = re.sub(r"[\u200b-\u200f\u202a-\u202e\ufeff]", "", p)
    p = re.sub(r"^[\\/]+([A-Za-z]:[\\/])", r"\1", p)
    p = re.sub(r"^([A-Za-z])[\\/](?![\\/])", r"\1:\\", p)
    return os.path.normpath(p)


def resolve_existing_file(p: str) -> Path | None:
    if os.path.isfile(p):
        return Path(p)
    if os.name == "nt":
        ap = os.path.abspath(p)
        if not ap.startswith("\\\\?\\"):
            long_p = "\\\\?\\" + ap
            if os.path.isfile(long_p):
                return Path(long_p)
    return None


def _is_ct2_model_dir(path: Path) -> bool:
    return path.is_dir() and (path / "model.bin").is_file()


def is_faster_whisper_installed() -> bool:
    return tool_has_module(RUNTIME_TOOL_ID, "faster_whisper")


def is_huggingface_hub_installed() -> bool:
    return tool_has_module(RUNTIME_TOOL_ID, "huggingface_hub")


def _runtime_module_installed(module_name: str) -> bool:
    return tool_has_module(RUNTIME_TOOL_ID, module_name)


def resolve_model_dir() -> Path:
    """다운로드·승격 실패(WinError 32) 시 스테이징 경로를 포함해 실제 모델 폴더를 반환."""
    if _ACTIVE_MODEL_MARKER.is_file():
        try:
            marked = Path(_ACTIVE_MODEL_MARKER.read_text(encoding="utf-8").strip())
            if _is_ct2_model_dir(marked):
                return marked
        except OSError:
            pass
    if _is_ct2_model_dir(LOCAL_MODEL_DIR):
        return LOCAL_MODEL_DIR
    if _is_ct2_model_dir(_STAGING_MODEL_DIR):
        return _STAGING_MODEL_DIR
    return LOCAL_MODEL_DIR


def _set_active_model_dir(path: Path) -> None:
    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    _ACTIVE_MODEL_MARKER.write_text(str(path.resolve()), encoding="utf-8")


def is_model_present() -> bool:
    return _is_ct2_model_dir(resolve_model_dir())


def is_model_loaded() -> bool:
    return _whisper_model is not None


def model_device() -> str | None:
    return _model_device


def clear_whisper_model() -> None:
    """메모리에서 Whisper 모델 해제 (auto_subtitle_runtime.unload_whisper_model)."""
    global _whisper_model, _model_device
    _whisper_model = None
    _model_device = None


def has_nvidia_gpu() -> bool:
    try:
        r = subprocess.run(
            ["nvidia-smi", "-L"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
            creationflags=no_window_creationflags(),
        )
        if r.returncode != 0:
            return False
        out = f"{r.stdout}\n{r.stderr}".lower()
        return "gpu " in out or "nvidia" in out
    except Exception:
        return False


def _ctranslate2_dir() -> Path | None:
    try:
        import ctranslate2

        return Path(ctranslate2.__file__).resolve().parent
    except ImportError:
        return None


def _find_cublas_bin_dir() -> Path | None:
    """Agent GPU 런타임·pip wheel·ctranslate2 번들 내 cublas64_12.dll."""
    from engines import auto_subtitle_gpu_runtime as gpu_rt

    if gpu_rt.is_gpu_runtime_installed():
        return gpu_rt.gpu_runtime_dir()
    for base in sys.path:
        if not base:
            continue
        candidate = Path(base) / "nvidia" / "cublas" / "bin" / "cublas64_12.dll"
        if candidate.is_file():
            return candidate.parent
    ct2 = _ctranslate2_dir()
    if ct2 is not None:
        bundled = ct2 / "cublas64_12.dll"
        if bundled.is_file():
            return ct2
    return None


_cuda_dll_dirs_added: set[str] = set()


def prepend_cuda_runtime_dll_dirs() -> None:
    """Windows: cublas/cudnn DLL 검색 경로 (Whisper CUDA 전사 전 호출)."""
    if sys.platform != "win32":
        return
    for directory in (_find_cublas_bin_dir(), _ctranslate2_dir()):
        if directory is None:
            continue
        key = str(directory.resolve())
        if key in _cuda_dll_dirs_added:
            continue
        _cuda_dll_dirs_added.add(key)
        if hasattr(os, "add_dll_directory"):
            try:
                os.add_dll_directory(key)
            except OSError:
                pass
        path_env = os.environ.get("PATH", "")
        if key not in path_env.split(os.pathsep):
            os.environ["PATH"] = key + os.pathsep + path_env


def cuda_runtime_ready() -> bool:
    """GPU가 있어도 cuBLAS DLL이 없으면 False → CPU만 사용."""
    if not has_nvidia_gpu():
        return False
    prepend_cuda_runtime_dll_dirs()
    return _find_cublas_bin_dir() is not None


def _emit_prepare_progress(
    on_progress: PrepareProgressCallback | None,
    value: float,
    step: str,
    detail: str = "",
) -> None:
    global _prepare_progress_max
    capped = max(0.0, min(100.0, float(value)))
    v = max(_prepare_progress_max, capped) if _prepare_progress_max >= 0 else capped
    if _prepare_progress_max >= 0 and v <= _prepare_progress_max + 0.02 and v < 99.98:
        return
    _prepare_progress_max = v
    if on_progress is not None:
        on_progress(v, step, detail)


def _reset_prepare_progress() -> None:
    global _prepare_progress_max
    _prepare_progress_max = -1.0


def _release_model_download_lock() -> None:
    try:
        _MODEL_DOWNLOAD_LOCK.unlink(missing_ok=True)  # type: ignore[arg-type]
    except OSError:
        pass


def _clear_stale_model_download_lock() -> None:
    if not _MODEL_DOWNLOAD_LOCK.is_file():
        return
    try:
        age = time.time() - _MODEL_DOWNLOAD_LOCK.stat().st_mtime
    except OSError:
        return
    if age >= _STALE_MODEL_LOCK_SEC:
        _release_model_download_lock()


def _try_acquire_model_download_lock() -> bool:
    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(str(_MODEL_DOWNLOAD_LOCK), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.close(fd)
        return True
    except FileExistsError:
        return False


def _clear_staging_dir_with_retry(staging: Path, *, retries: int = 8) -> None:
    if not staging.exists():
        return
    last: BaseException | None = None
    for attempt in range(retries):
        try:
            shutil.rmtree(staging)
            return
        except OSError as exc:
            last = exc
            if not is_file_locked_error(exc):
                raise
            time.sleep(0.45 * (attempt + 1))
    if last:
        raise last


def _rename_path_with_retry(src: Path, dst: Path, *, retries: int = 8) -> None:
    last: BaseException | None = None
    for attempt in range(retries):
        try:
            src.rename(dst)
            return
        except OSError as exc:
            last = exc
            if not is_file_locked_error(exc):
                raise
            time.sleep(0.45 * (attempt + 1))
    if last:
        raise last


def _promote_staging_dir(staging: Path, target: Path) -> None:
    """다운로드 스테이징 폴더를 최종 경로로 옮깁니다 (WinError 32 완화)."""
    if not staging.is_dir():
        raise FileNotFoundError(f"스테이징 폴더 없음: {staging}")
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        _rename_path_with_retry(staging, target)
        return
    backup = target.parent / f"{target.name}.bak"
    _clear_staging_dir_with_retry(backup)
    for attempt in range(8):
        try:
            target.rename(backup)
            break
        except OSError as exc:
            if not is_file_locked_error(exc) or attempt >= 7:
                _clear_staging_dir_with_retry(target)
                break
            time.sleep(0.45 * (attempt + 1))
    _rename_path_with_retry(staging, target)
    _clear_staging_dir_with_retry(backup)


def _snapshot_download_model(*, staging: Path, tqdm_class: type) -> None:
    from huggingface_hub import snapshot_download

    _HF_HUB_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    kwargs: dict[str, Any] = {
        "repo_id": HF_REPO_ID,
        "local_dir": str(staging),
        "local_dir_use_symlinks": False,
        "tqdm_class": tqdm_class,
    }
    if os.name == "nt":
        kwargs["max_workers"] = 1
    prev_cache = os.environ.get("HF_HUB_CACHE")
    os.environ["HF_HUB_CACHE"] = str(_HF_HUB_CACHE_DIR.resolve())
    try:
        snapshot_download(**kwargs)
    finally:
        if prev_cache is None:
            os.environ.pop("HF_HUB_CACHE", None)
        else:
            os.environ["HF_HUB_CACHE"] = prev_cache


def _repo_download_bytes_total() -> int | None:
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(HF_REPO_ID)
        total = 0
        for s in info.siblings or []:
            sz = getattr(s, "size", None)
            if sz is not None:
                total += int(sz)
        return total if total > 0 else None
    except Exception:
        return None


def install_python_dependencies(on_progress: PrepareProgressCallback | None = None) -> None:
    """faster-whisper 등 pip 패키지 (웹에서 prepare 시 1회)."""
    if is_frozen():
        if is_faster_whisper_installed() and is_huggingface_hub_installed():
            return
        raise RuntimeError(
            "PyInstaller 단독 exe에서는 Auto Subtitle Python 패키지 자동 설치를 지원하지 않습니다. "
            "ItMatZip Agent MSI(engine Python)를 사용하세요."
        )

    missing: list[str] = []
    if not is_faster_whisper_installed():
        missing.append("faster-whisper>=1.0.3")
    if not is_huggingface_hub_installed():
        missing.append("huggingface_hub>=0.26.0")
    if not _runtime_module_installed("tqdm"):
        missing.append("tqdm>=4.66.0")
    if not _runtime_module_installed("numpy"):
        missing.append("numpy")
    if not _runtime_module_installed("tokenizers"):
        missing.append("tokenizers")
    if not _runtime_module_installed("ctranslate2"):
        missing.append("ctranslate2")
    if not _runtime_module_installed("av"):
        missing.append("av")
    if not tool_has_module(RUNTIME_TOOL_ID, "kiwipiepy"):
        missing.append("kiwipiepy>=0.18.0")
    if not missing:
        _emit_prepare_progress(on_progress, 12.0, "Python 패키지", "faster-whisper 이미 설치됨")
        return

    _emit_prepare_progress(
        on_progress,
        6.0,
        "Python 패키지",
        f"pip install 시작: {', '.join(missing)} (수 분 소요될 수 있습니다)",
    )
    from common.runtime_site_packages import ensure_runtime_tree_acl, finalize_runtime_pip
    from common.subprocess_util import agent_subprocess_env

    ensure_runtime_tree_acl(RUNTIME_TOOL_ID)
    cmd = pip_install_cmd(RUNTIME_TOOL_ID, upgrade=True)
    cmd.extend(missing)
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=no_window_creationflags(),
        env=agent_subprocess_env({"ITMATZIP_RUNTIME_TOOL": RUNTIME_TOOL_ID}),
    )
    lines_seen = 0
    last_line = ""
    while True:
        line = proc.stdout.readline()  # type: ignore[union-attr]
        if not line and proc.poll() is not None:
            break
        if not line:
            continue
        lines_seen += 1
        stripped = line.strip()
        if stripped:
            last_line = stripped
        if on_progress is not None and lines_seen % 3 == 0:
            pct = min(17.0, 7.0 + lines_seen * 0.1)
            short = last_line[:80] if last_line else "설치 중…"
            _emit_prepare_progress(on_progress, pct, "Python 패키지 설치", short)
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"pip install 실패 (exit {proc.returncode}): {last_line}")
    finalize_runtime_pip(RUNTIME_TOOL_ID)
    activate_runtime_site_packages(RUNTIME_TOOL_ID)
    verify_importable(
        RUNTIME_TOOL_ID,
        "faster_whisper",
        "huggingface_hub",
        "tqdm",
        "numpy",
        "tokenizers",
        "ctranslate2",
        "av",
    )
    prepend_cuda_runtime_dll_dirs()
    _emit_prepare_progress(on_progress, 18.0, "Python 패키지", "설치 완료")


def download_whisper_model(on_progress: PrepareProgressCallback | None = None) -> bool:
    """HF CT2 모델 다운로드. True if download ran."""
    _reset_prepare_progress()
    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    if is_model_present():
        _set_active_model_dir(resolve_model_dir())
        _emit_prepare_progress(on_progress, 88.0, "AI 모델", "이미 다운로드됨")
        return False

    from tqdm.auto import tqdm as std_tqdm

    _clear_stale_model_download_lock()
    deadline = time.monotonic() + 120.0
    held_lock = False
    while time.monotonic() < deadline:
        if is_model_present():
            _set_active_model_dir(resolve_model_dir())
            _emit_prepare_progress(on_progress, 88.0, "AI 모델", "이미 다운로드됨")
            return False
        if _try_acquire_model_download_lock():
            held_lock = True
            break
        time.sleep(0.25)
        _clear_stale_model_download_lock()

    if not held_lock:
        raise TimeoutError(
            "Whisper 모델 다운로드가 다른 작업과 겹칩니다. 1~2분 후 환경 준비를 다시 시도하세요."
        )

    try:
        if is_model_present():
            _set_active_model_dir(resolve_model_dir())
            _emit_prepare_progress(on_progress, 88.0, "AI 모델", "이미 다운로드됨")
            return False

        _emit_prepare_progress(on_progress, 20.0, "AI 모델", f"Hugging Face · {HF_REPO_ID}")
        grand_total = _repo_download_bytes_total()
        download_cap = 85.0

        def make_json_tqdm(grand: int | None) -> type:
            class JsonProgressTqdm(std_tqdm):
                def __init__(self, *args: Any, **kwargs: Any):
                    kwargs.setdefault("mininterval", 0.15)
                    super().__init__(*args, **kwargs)
                    self._last_emitted: float = -1.0

                def update(self, n: int | float = 1) -> bool | None:
                    r = super().update(n)
                    if grand and grand > 0:
                        pct = download_cap * min(float(self.n), float(grand)) / float(grand)
                    else:
                        t = float(self.total) if self.total else 0.0
                        if t <= 0:
                            return r
                        pct = download_cap * min(float(self.n), t) / t
                    if pct - self._last_emitted >= 0.5 or pct <= 0.5 or pct >= download_cap - 0.01:
                        self._last_emitted = pct
                        if grand and grand > 0:
                            ratio = min(float(self.n), float(grand)) / float(grand)
                            mb_done = float(self.n) / (1024 * 1024)
                            mb_total = float(grand) / (1024 * 1024)
                            detail = f"{HF_REPO_ID} · {mb_done:.0f}/{mb_total:.0f} MB ({ratio * 100:.0f}%)"
                        elif self.total and float(self.total) > 0:
                            ratio = min(float(self.n), float(self.total)) / float(self.total)
                            detail = f"{HF_REPO_ID} · {ratio * 100:.0f}%"
                        else:
                            detail = f"{HF_REPO_ID} · {pct:.0f}%"
                        _emit_prepare_progress(on_progress, pct, "AI 모델 다운로드", detail)
                    return r

            return JsonProgressTqdm

        staging = _STAGING_MODEL_DIR
        promoted = False
        last_err: BaseException | None = None
        for attempt in range(3):
            try:
                _clear_staging_dir_with_retry(staging)
                _snapshot_download_model(staging=staging, tqdm_class=make_json_tqdm(grand_total))
                last_err = None
                break
            except OSError as exc:
                last_err = exc
                if not is_file_locked_error(exc) or attempt >= 2:
                    raise
                time.sleep(1.0 * (attempt + 1))
        if last_err is not None:
            raise last_err

        if not _is_ct2_model_dir(staging):
            raise RuntimeError("모델 다운로드 후 model.bin을 찾지 못했습니다.")
        try:
            _promote_staging_dir(staging, LOCAL_MODEL_DIR)
            _set_active_model_dir(LOCAL_MODEL_DIR)
            promoted = True
        except OSError as exc:
            if not is_file_locked_error(exc):
                raise
            _set_active_model_dir(staging)
        finally:
            if promoted:
                _clear_staging_dir_with_retry(staging)

        if not _is_ct2_model_dir(resolve_model_dir()):
            raise RuntimeError("모델 다운로드 후 model.bin을 찾지 못했습니다.")
        _emit_prepare_progress(on_progress, 88.0, "AI 모델", "다운로드 완료")
        return True
    finally:
        if held_lock:
            _release_model_download_lock()


def load_whisper_model(on_progress: PrepareProgressCallback | None = None) -> dict[str, Any]:
    global _whisper_model, _model_device

    if _whisper_model is not None:
        _emit_prepare_progress(on_progress, 100.0, "모델 로드", f"재사용 ({_model_device})")
        return {"reused": True, "device": _model_device}

    model_dir = resolve_model_dir()
    if not _is_ct2_model_dir(model_dir):
        raise RuntimeError("Whisper 모델이 없습니다. prepare를 먼저 실행하세요.")

    activate_runtime_site_packages(RUNTIME_TOOL_ID)
    from faster_whisper import WhisperModel

    path = str(model_dir.resolve())
    prepend_cuda_runtime_dll_dirs()
    _emit_prepare_progress(on_progress, 90.0, "모델 로드", "GPU(CUDA) 시도…")

    if cuda_runtime_ready():
        try:
            _whisper_model = WhisperModel(path, device="cuda", compute_type="float16")
            _model_device = "cuda"
            _emit_prepare_progress(on_progress, 100.0, "모델 로드", "CUDA float16")
            return {"device": "cuda", "compute_type": "float16", "path": path}
        except Exception as e_cuda:
            _whisper_model = None
            _model_device = None
            _emit_prepare_progress(
                on_progress,
                92.0,
                "모델 로드",
                f"CUDA 실패 → CPU 폴백 ({e_cuda})",
            )
    elif has_nvidia_gpu():
        _emit_prepare_progress(
            on_progress,
            91.0,
            "모델 로드",
            "GPU 런타임(cuBLAS) 없음 — CPU int8 (환경 준비에서 runtime_dlls.zip 설치)",
        )

    _whisper_model = WhisperModel(path, device="cpu", compute_type="int8")
    _model_device = "cpu"
    _emit_prepare_progress(on_progress, 100.0, "모델 로드", "CPU int8")
    return {"device": "cpu", "compute_type": "int8", "path": path}


def prepare_all(on_progress: PrepareProgressCallback | None = None) -> dict[str, Any]:
    """FFmpeg + pip + HF 모델 + 메모리 로드."""
    from engines import auto_subtitle_runtime

    auto_subtitle_runtime.cancel_scheduled_unload()
    prepend_ffmpeg_bin_to_env(os.environ)
    _emit_prepare_progress(on_progress, 3.0, "FFmpeg", "FFmpeg 준비 확인…")
    ensure_ffmpeg(download_timeout_sec=300.0, on_progress=on_progress)
    _emit_prepare_progress(on_progress, 5.0, "FFmpeg", "준비 완료")
    install_python_dependencies(on_progress)
    if has_nvidia_gpu():
        from engines import auto_subtitle_gpu_runtime as gpu_rt

        if not gpu_rt.is_gpu_runtime_installed():
            _emit_prepare_progress(on_progress, 18.0, "GPU 런타임", "cuBLAS DLL 다운로드 시작…")

            def _gpu_progress(pct: float, step: str, detail: str) -> None:
                mapped = 18.0 + (pct / 100.0) * 12.0
                _emit_prepare_progress(on_progress, mapped, step, detail)

            gpu_rt.install_gpu_runtime(on_progress=_gpu_progress)
        prepend_cuda_runtime_dll_dirs()
    downloaded = download_whisper_model(on_progress)
    load_info = load_whisper_model(on_progress)
    return {
        "model_dir": str(LOCAL_MODEL_DIR.resolve()),
        "downloaded": downloaded,
        "load": load_info,
        "repo_id": HF_REPO_ID,
    }


def _is_cuda_runtime_missing_error(err: Exception) -> bool:
    msg = str(err).lower()
    if "cublas" in msg or "cudnn" in msg:
        return True
    if "cuda" in msg and ("cannot be loaded" in msg or "is not found" in msg):
        return True
    return "library" in msg and ".dll" in msg and (
        "not found" in msg or "cannot be loaded" in msg
    )


def _force_reload_model_cpu() -> None:
    global _whisper_model, _model_device
    activate_runtime_site_packages(RUNTIME_TOOL_ID)
    from faster_whisper import WhisperModel

    path = str(resolve_model_dir().resolve())
    _whisper_model = WhisperModel(path, device="cpu", compute_type="int8")
    _model_device = "cpu"


def _collect_transcribe_segments(
    audio_path: str,
    *,
    language: str | None,
    beam_size: int,
    vad_filter: bool,
) -> tuple[Any, Any, bool]:
    """transcribe 세그먼트 이터레이터 반환. cuBLAS 누락 시 CPU 모델로 1회 재시도.

    반환값의 segments 는 faster-whisper 제너레이터이므로 list() 로 한꺼번에
    소비하면 진행률이 갱신되지 않는다. 호출 측에서 for-loop 로 순회할 것.
    """
    global _whisper_model, _model_device

    did_fallback = False
    prepend_cuda_runtime_dll_dirs()

    def _invoke():
        if _whisper_model is None:
            raise RuntimeError("Whisper 모델이 로드되지 않았습니다.")
        return _whisper_model.transcribe(
            audio_path,
            beam_size=beam_size,
            language=language,
            vad_filter=vad_filter,
            word_timestamps=True,
        )

    for attempt in range(2):
        try:
            segments, info = _invoke()
            return segments, info, did_fallback
        except Exception as e:
            if attempt == 0 and _is_cuda_runtime_missing_error(e) and _model_device == "cuda":
                _force_reload_model_cpu()
                did_fallback = True
                continue
            raise


_GAP_THRESHOLD_SEC = 0.1
# 말끝 짧은 간격(예: 0.3s)을 별도 `--` cue 로 두지 않고 이전 cue end 연장
_MERGE_SHORT_GAP_SEC = 0.45
_SILENCE_GAP_TEXT = "--"
_UNKNOWN_WORD_LABEL = "???"


def _silence_gap_cue(start: float, end: float) -> dict[str, Any]:
    s = float(start)
    e = float(end)
    if not (e > s):
        s, e = min(s, e), max(s, e)
        if not (e > s):
            s, e = 0.0, max(0.01, e)
    token = _SILENCE_GAP_TEXT
    return {
        "start": s,
        "end": e,
        "text": token,
        "words": [{"start": s, "end": e, "word": token, "is_silence": True, "isSilence": True}],
        "is_silence": True,
        "isSilence": True,
    }


def _extend_last_cue_end(out: list[dict[str, Any]], new_end: float) -> None:
    if not out:
        return
    ne = float(new_end)
    last = out[-1]
    last["end"] = ne
    words = last.get("words")
    if isinstance(words, list) and words:
        lw = words[-1]
        if isinstance(lw, dict):
            lw["end"] = ne


def _normalize_cue_words_and_empty_text(c: dict[str, Any]) -> dict[str, Any] | None:
    try:
        s = float(c.get("start", 0))
        e = float(c.get("end", 0))
    except (TypeError, ValueError):
        return None
    if not (e > s):
        return None
    text = str(c.get("text") or "").strip()
    words_out: list[dict[str, Any]] = []
    raw_words = c.get("words")
    if isinstance(raw_words, list):
        for w in raw_words:
            if not isinstance(w, dict):
                continue
            try:
                ws = float(w.get("start", s))
                we = float(w.get("end", e))
            except (TypeError, ValueError):
                continue
            ww = str(w.get("word", "")).strip()
            if not ww:
                continue
            word_entry: dict[str, Any] = {"start": ws, "end": we, "word": ww}
            if w.get("isSilence") is True or w.get("is_silence") is True:
                word_entry["isSilence"] = True
                word_entry["is_silence"] = True
            words_out.append(word_entry)
    if not text and not words_out:
        text = _UNKNOWN_WORD_LABEL
        words_out = [{"start": s, "end": e, "word": _UNKNOWN_WORD_LABEL}]
    return {"start": s, "end": e, "text": text, "words": words_out}


def _fill_unvoiced_gaps(raw_cues: list[dict[str, Any]], total_dur: float) -> list[dict[str, Any]]:
    """AutoSubtitle main.py — 0.1s 이상 무음은 `--` cue, 미만은 이전 cue end 연장."""
    td = max(0.0, float(total_dur or 0))
    normalized: list[dict[str, Any]] = []
    for c in raw_cues:
        n = _normalize_cue_words_and_empty_text(c)
        if n is not None:
            normalized.append(n)
    normalized.sort(key=lambda x: float(x["start"]))

    if not normalized:
        if td > 0:
            return [_silence_gap_cue(0.0, td)]
        return []

    out: list[dict[str, Any]] = []
    prev_end = 0.0

    for c in normalized:
        s = float(c["start"])
        e = float(c["end"])
        if td > 0:
            if s >= td:
                continue
            e = min(e, td)
        if not (e > s):
            continue
        s = max(0.0, s)
        if s < prev_end:
            s = prev_end
        if e <= s:
            continue

        gap = s - prev_end
        if gap > 1e-9:
            if gap >= _GAP_THRESHOLD_SEC:
                if out and gap < _MERGE_SHORT_GAP_SEC:
                    _extend_last_cue_end(out, s)
                else:
                    out.append(_silence_gap_cue(prev_end, s))
            elif out:
                _extend_last_cue_end(out, s)

        out.append(
            {
                "start": s,
                "end": e,
                "text": c["text"],
                "words": c["words"],
            }
        )
        prev_end = e

    if td > 0:
        gap_tail = td - prev_end
        if gap_tail >= _GAP_THRESHOLD_SEC:
            if out and gap_tail < _MERGE_SHORT_GAP_SEC:
                _extend_last_cue_end(out, td)
            else:
                out.append(_silence_gap_cue(prev_end, td))
        elif gap_tail > 1e-9 and out:
            _extend_last_cue_end(out, td)

    return out


def _set_transcribe_job(
    phase: str,
    progress: float,
    message: str | None = None,
    *,
    result: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    with _transcribe_lock:
        _transcribe_job.phase = phase
        _transcribe_job.progress = progress
        _transcribe_job.message = message
        if result is not None or phase in {"idle", "failed", "completed"}:
            _transcribe_job.result = result
        _transcribe_job.error = error if phase == "failed" else None


def get_transcribe_job_status() -> TranscribeJobStatus:
    with _transcribe_lock:
        return TranscribeJobStatus(
            phase=_transcribe_job.phase,
            progress=_transcribe_job.progress,
            message=_transcribe_job.message,
            result=_transcribe_job.result,
            error=_transcribe_job.error,
        )


def _run_transcribe(
    media_path: Path,
    *,
    language: str | None,
    beam_size: int,
    vad_filter: bool,
    rms_vad_align: bool,
    job_dir: Path,
) -> None:
    global _whisper_model, _model_device

    if _whisper_model is None:
        _set_transcribe_job("failed", 0.0, error="Whisper 모델이 로드되지 않았습니다. /prepare를 먼저 실행하세요.")
        return

    _set_transcribe_job("running", 2.0, "자막 추출을 시작합니다.")
    prepend_ffmpeg_bin_to_env(os.environ)
    t0 = time.perf_counter()
    audio_path = str(media_path)

    try:
        segments, info, did_fallback = _collect_transcribe_segments(
            audio_path,
            language=language,
            beam_size=beam_size,
            vad_filter=vad_filter,
        )
    except Exception as e:
        _set_transcribe_job("failed", 0.0, error=str(e))
        return

    if did_fallback:
        _set_transcribe_job(
            "running",
            4.0,
            "CUDA 라이브러리 없음 — CPU로 추출합니다 (느릴 수 있습니다)…",
        )

    total_dur = float(getattr(info, "duration", 0) or 0)
    subtitles: list[dict[str, Any]] = []
    for i, seg in enumerate(segments):
        subtitles.append(
            {
                "start": float(seg.start),
                "end": float(seg.end),
                "text": (getattr(seg, "text", None) or "").strip(),
                "words": [
                    {
                        "start": float(getattr(w, "start", seg.start)),
                        "end": float(getattr(w, "end", seg.end)),
                        "word": str(getattr(w, "word", "")).strip(),
                    }
                    for w in (getattr(seg, "words", None) or [])
                ],
            }
        )
        if total_dur > 0:
            pct = max(2.0, min(99.0, 100.0 * min(float(seg.end), total_dur) / total_dur))
        else:
            pct = min(99.0, 2.0 + float(i + 1) * 3.0)
        _set_transcribe_job("running", pct, f"자막 추출 중… ({int(pct)}%)")

    if rms_vad_align:
        _set_transcribe_job("running", 94.0, "단어 타임스탬프 정렬 (RMS/VAD)…")
        try:
            from engines.auto_subtitle_rms_vad import apply_rms_vad_word_align

            subtitles = apply_rms_vad_word_align(
                subtitles,
                audio_path,
                str(get_ffmpeg_executable()),
                total_duration=total_dur,
            )
        except Exception:
            pass

    _set_transcribe_job("running", 96.0, "자막 추출 중… (무음 구간 보정)")
    subtitles = _fill_unvoiced_gaps(subtitles, total_dur)

    _set_transcribe_job("running", 97.0, "파형 피크 생성…")
    waveform_peaks: dict[str, Any] = {"ok": False, "path": None}
    waveform_peaks_json: dict[str, Any] | None = None
    peaks_path = job_dir / "waveform-peaks.json"
    try:
        from engines import auto_subtitle_audiowaveform

        if auto_subtitle_audiowaveform.resolve_audiowaveform_exe() is None:
            waveform_peaks = {
                "ok": False,
                "path": None,
                "reason": "audiowaveform binary not found",
            }
        else:
            wf_result = auto_subtitle_audiowaveform.waveform_peaks_impl(media_path, peaks_path)
            waveform_peaks = {
                "ok": bool(wf_result.get("ok")),
                "path": wf_result.get("path"),
                "reason": wf_result.get("reason"),
                "cached": bool(wf_result.get("cached")),
            }
            if wf_result.get("ok") and peaks_path.is_file():
                waveform_peaks_json = json.loads(peaks_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        waveform_peaks = {"ok": False, "path": None, "reason": str(exc)}

    elapsed_ms = int((time.perf_counter() - t0) * 1000)

    job_dir.mkdir(parents=True, exist_ok=True)
    cues_path = job_dir / "cues.json"
    cues_path.write_text(
        json.dumps(subtitles, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    srt_path = job_dir / "subtitles.srt"
    srt_path.write_text(build_srt_text(subtitles), encoding="utf-8-sig")

    result = {
        "cues": subtitles,
        "language": getattr(info, "language", None),
        "duration_sec": total_dur,
        "device": _model_device,
        "fallback_to_cpu": did_fallback,
        "transcribe_ms": elapsed_ms,
        "cues_json_path": str(cues_path.resolve()),
        "srt_path": str(srt_path.resolve()),
        "media_path": str(media_path.resolve()),
        "waveform_peaks": waveform_peaks,
        "waveform_peaks_json": waveform_peaks_json,
    }
    _set_transcribe_job("completed", 100.0, "자막 추출이 완료되었습니다.", result=result)


def start_transcribe_job(
    media_path: Path,
    *,
    language: str | None = None,
    beam_size: int = 5,
    vad_filter: bool = True,
    rms_vad_align: bool = True,
) -> TranscribeJobStatus:
    global _transcribe_thread

    from engines import auto_subtitle_runtime

    if not is_model_loaded():
        raise RuntimeError(
            "Whisper 모델이 준비되지 않았습니다. "
            "자막 추출을 눌러 환경을 준비한 뒤 다시 시도해 주세요."
        )

    auto_subtitle_runtime.try_begin_job("transcribe")

    with _transcribe_lock:
        if _transcribe_thread is not None and _transcribe_thread.is_alive():
            auto_subtitle_runtime.end_job()
            return get_transcribe_job_status()

        job_id = uuid.uuid4().hex[:12]
        job_dir = ensure_workspace() / job_id

        def _target() -> None:
            try:
                _run_transcribe(
                    media_path,
                    language=language,
                    beam_size=beam_size,
                    vad_filter=vad_filter,
                    rms_vad_align=rms_vad_align,
                    job_dir=job_dir,
                )
            except Exception as exc:
                _set_transcribe_job("failed", 0.0, error=str(exc))
            finally:
                auto_subtitle_runtime.end_job()

        _set_transcribe_job("queued", 0.0, "자막 추출을 시작합니다.")
        _transcribe_thread = threading.Thread(target=_target, daemon=True)
        _transcribe_thread.start()

    return get_transcribe_job_status()


def format_srt_timestamp(sec: float) -> str:
    s = max(0.0, float(sec) if sec == sec else 0.0)
    hh = int(s // 3600)
    mm = int((s % 3600) // 60)
    ss = int(s % 60)
    ms = int((s - int(s)) * 1000)
    return f"{hh:02d}:{mm:02d}:{ss:02d},{ms:03d}"


def build_srt_text(cues: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    cue_num = 1
    for item in cues:
        if item.get("is_silence"):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        start = float(item.get("start", 0))
        end = float(item.get("end", start))
        if end <= start + 0.02:
            continue
        lines.append(str(cue_num))
        lines.append(f"{format_srt_timestamp(start)} --> {format_srt_timestamp(end)}")
        lines.append(text)
        lines.append("")
        cue_num += 1
    return "\n".join(lines)


def cleanup_workspace() -> dict[str, Any]:
    """workspace/export·job 임시 폴더 정리 (진행 중 작업이 있으면 실패)."""
    from engines import auto_subtitle_runtime

    if auto_subtitle_runtime.is_job_busy():
        return {
            "ok": False,
            "errors": ["다른 작업이 진행 중이라 정리할 수 없습니다."],
        }
    ensure_workspace()
    files_removed = 0
    dirs_removed = 0
    errors: list[str] = []
    root = WORKSPACE_ROOT.resolve()
    for child in list(WORKSPACE_ROOT.iterdir()):
        if not child.is_dir():
            continue
        try:
            import shutil

            shutil.rmtree(child, ignore_errors=True)
            dirs_removed += 1
        except OSError as exc:
            errors.append(f"{child.name}: {exc}")
    return {
        "ok": len(errors) == 0,
        "files_removed": files_removed,
        "dirs_removed": dirs_removed,
        "errors": errors,
        "workspace": str(root),
    }


def write_srt_export(cues: list[dict[str, Any]], *, stem: str = "export") -> Path:
    job_dir = ensure_workspace() / f"export-{uuid.uuid4().hex[:10]}"
    job_dir.mkdir(parents=True, exist_ok=True)
    out = job_dir / f"{stem}.srt"
    out.write_text(build_srt_text(cues), encoding="utf-8-sig")
    return out.resolve()
