"""Auto Subtitle — Faster-Whisper 전사·모델 준비 (ItMatZip Agent)."""

from __future__ import annotations

import importlib
import importlib.util
import json
import logging
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
    purge_runtime_site_all,
    probe_runtime_import,
    tool_has_module,
    verify_importable,
)
from common.subprocess_util import no_window_creationflags, run_hidden
from runtime_paths import is_frozen

logger = logging.getLogger(__name__)

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


def _user_config_root() -> Path:
    """트레이 사용자 쓰기 가능 — active_model_dir 등 소형 상태 파일."""
    appdata = os.environ.get("APPDATA", "").strip()
    if appdata:
        return Path(appdata) / "ItMatZip"
    return Path.home() / ".itmatzip"


AUTO_SUBTITLE_ROOT = _agent_data_root() / "auto-subtitle"
MODEL_ROOT = AUTO_SUBTITLE_ROOT / "models"
WORKSPACE_ROOT = AUTO_SUBTITLE_ROOT / "workspace"
LOCAL_MODEL_DIR = MODEL_ROOT / LOCAL_MODEL_NAME
_STAGING_MODEL_DIR = MODEL_ROOT / f".{LOCAL_MODEL_NAME}.staging"
_USER_AUTO_SUBTITLE_CONFIG = _user_config_root() / "auto-subtitle"
_ACTIVE_MODEL_MARKER = _USER_AUTO_SUBTITLE_CONFIG / "active_model_dir.txt"
_LEGACY_ACTIVE_MODEL_MARKER = MODEL_ROOT / "active_model_dir.txt"
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
    from common.runtime_site_packages import ensure_data_tree_acl

    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    ensure_data_tree_acl(AUTO_SUBTITLE_ROOT)
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


def is_stable_ts_installed() -> bool:
    return tool_has_module(RUNTIME_TOOL_ID, "stable_whisper")


def get_whisper_model() -> Any | None:
    """전사에 로드된 faster-whisper 인스턴스 (stable-ts align 공유용)."""
    return _whisper_model


def _runtime_module_installed(module_name: str) -> bool:
    return tool_has_module(RUNTIME_TOOL_ID, module_name)


# (import_name, pip_spec, purge_dir_prefixes…, import_smoke…)
_PREPARE_PYTHON_PACKAGES: tuple[tuple[str, str, tuple[str, ...], tuple[str, ...]], ...] = (
    ("faster_whisper", "faster-whisper>=1.0.3", ("faster_whisper", "faster-whisper"), ()),
    ("huggingface_hub", "huggingface_hub>=0.26.0", ("huggingface_hub",), ()),
    ("tqdm", "tqdm>=4.66.0", ("tqdm",), ()),
    ("numpy", "numpy", ("numpy", "numpy.libs"), ("numpy.linalg",)),
    ("tokenizers", "tokenizers", ("tokenizers",), ()),
    ("ctranslate2", "ctranslate2", ("ctranslate2",), ()),
    ("av", "av", ("av",), ()),
    ("kiwipiepy", "kiwipiepy>=0.18.0", ("kiwipiepy", "kiwipiepy_model"), ()),
)

# 손상 복구 시 한 번에 설치 (faster-whisper 가 대부분 의존성 포함)
_FRESH_PREPARE_PIP_SPECS: tuple[str, ...] = (
    "numpy",
    "kiwipiepy>=0.18.0",
    "faster-whisper>=1.0.3",
)

# faster-whisper 설치 시 중복 pip 방지
_WHISPER_PIP_BUNDLE = frozenset({
    "numpy",
    "tokenizers",
    "ctranslate2",
    "av",
    "tqdm>=4.66.0",
    "huggingface_hub>=0.26.0",
})
_WHISPER_PIP_SPEC = "faster-whisper>=1.0.3"


def _evict_runtime_modules_from_sys(*import_names: str) -> None:
    for name in import_names:
        for key in list(sys.modules):
            if key == name or key.startswith(f"{name}."):
                sys.modules.pop(key, None)


def _prepare_import_smoke_map() -> dict[str, tuple[str, ...]]:
    return {import_name: smoke for import_name, _, _, smoke in _PREPARE_PYTHON_PACKAGES if smoke}


def _scan_prepare_python_packages() -> tuple[list[str], list[str]]:
    """누락·손상 pip spec 과 purge 대상 prefix."""
    missing_specs: list[str] = []
    purge_prefixes: list[str] = []
    for import_name, pip_spec, purge, smoke in _PREPARE_PYTHON_PACKAGES:
        present = tool_has_module(RUNTIME_TOOL_ID, import_name)
        if not present:
            missing_specs.append(pip_spec)
            continue
        if not probe_runtime_import(RUNTIME_TOOL_ID, import_name, smoke):
            purge_prefixes.extend(purge)
            if pip_spec not in missing_specs:
                missing_specs.append(pip_spec)
    return missing_specs, purge_prefixes


def _dedupe_prepare_pip_specs(specs: list[str]) -> list[str]:
    """faster-whisper 번들에 포함되는 spec 은 제외."""
    if _WHISPER_PIP_SPEC not in specs:
        return list(dict.fromkeys(specs))
    out = [_WHISPER_PIP_SPEC]
    for spec in specs:
        if spec == _WHISPER_PIP_SPEC or spec in _WHISPER_PIP_BUNDLE:
            continue
        out.append(spec)
    return list(dict.fromkeys(out))


def _assert_runtime_site_empty() -> None:
    from common.runtime_site_packages import runtime_site_packages_dir

    left = list(runtime_site_packages_dir(RUNTIME_TOOL_ID).iterdir())
    if left:
        names = ", ".join(p.name for p in left[:8])
        raise RuntimeError(
            f"runtime Python 패키지 폴더를 비우지 못했습니다 ({names}). "
            "itmatzip-agent 트레이를 완전히 종료한 뒤 「환경 준비」를 다시 시도하세요."
        )


def _run_prepare_pip_install(
    specs: list[str],
    *,
    on_progress: PrepareProgressCallback | None,
    batch: bool = False,
) -> None:
    from common.runtime_site_packages import (
        ensure_runtime_tree_acl,
        finalize_runtime_pip,
        pip_subprocess_env,
    )

    if not specs:
        return

    ensure_runtime_tree_acl(RUNTIME_TOOL_ID)
    batches = [specs] if batch else [[spec] for spec in specs]
    for batch_specs in batches:
        cmd = pip_install_cmd(RUNTIME_TOOL_ID, upgrade=False, force_reinstall=False)
        cmd.extend(batch_specs)
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=no_window_creationflags(),
            env=pip_subprocess_env({"ITMATZIP_RUNTIME_TOOL": RUNTIME_TOOL_ID}),
        )
        lines_seen = 0
        last_line = ""
        output_tail: list[str] = []
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
                output_tail.append(stripped)
                if len(output_tail) > 40:
                    output_tail.pop(0)
            label = batch_specs[0] if len(batch_specs) == 1 else f"{len(batch_specs)} packages"
            if on_progress is not None and lines_seen % 3 == 0:
                pct = min(17.0, 7.0 + lines_seen * 0.1)
                short = last_line[:80] if last_line else f"{label} 설치 중…"
                _emit_prepare_progress(on_progress, pct, "Python 패키지 설치", short)
        proc.wait()
        combined = "\n".join(output_tail)
        if proc.returncode != 0 and "Successfully installed" not in combined:
            hint = ""
            if "Permission" in last_line or "permission" in last_line.lower():
                hint = (
                    " — pip 캐시/폴더 권한 문제일 수 있습니다. "
                    "itmatzip-agent 트레이를 완전히 종료한 뒤 「환경 준비」를 다시 시도하세요."
                )
            label = ", ".join(batch_specs)
            raise RuntimeError(
                f"pip install 실패 ({label}, exit {proc.returncode}): {last_line}{hint}"
            )
    finalize_runtime_pip(RUNTIME_TOOL_ID)


def resolve_model_dir() -> Path:
    """다운로드·승격 실패(WinError 32) 시 스테이징 경로를 포함해 실제 모델 폴더를 반환."""
    for marker in (_ACTIVE_MODEL_MARKER, _LEGACY_ACTIVE_MODEL_MARKER):
        if not marker.is_file():
            continue
        try:
            marked = Path(marker.read_text(encoding="utf-8").strip())
            if _is_ct2_model_dir(marked):
                return marked
        except OSError:
            continue
    if _is_ct2_model_dir(LOCAL_MODEL_DIR):
        return LOCAL_MODEL_DIR
    if _is_ct2_model_dir(_STAGING_MODEL_DIR):
        return _STAGING_MODEL_DIR
    return LOCAL_MODEL_DIR


def _set_active_model_dir(path: Path) -> None:
    _USER_AUTO_SUBTITLE_CONFIG.mkdir(parents=True, exist_ok=True)
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
    from common.runtime_site_packages import ensure_runtime_tree_acl, finalize_runtime_pip

    activate_runtime_site_packages(RUNTIME_TOOL_ID)
    ensure_runtime_tree_acl(RUNTIME_TOOL_ID)

    if is_frozen():
        if is_faster_whisper_installed() and is_huggingface_hub_installed():
            return
        raise RuntimeError(
            "PyInstaller 단독 exe에서는 Auto Subtitle Python 패키지 자동 설치를 지원하지 않습니다. "
            "ItMatZip Agent MSI(engine Python)를 사용하세요."
        )

    missing_specs, purge_prefixes = _scan_prepare_python_packages()
    full_reinstall = bool(purge_prefixes)
    if full_reinstall:
        _emit_prepare_progress(
            on_progress,
            5.0,
            "Python 패키지",
            "손상된 runtime 패키지 정리 중… (잠시만 기다려 주세요)",
        )
        purge_runtime_site_all(RUNTIME_TOOL_ID)
        _assert_runtime_site_empty()
        _evict_runtime_modules_from_sys(*(row[0] for row in _PREPARE_PYTHON_PACKAGES))
        ensure_runtime_tree_acl(RUNTIME_TOOL_ID)
        missing_specs = list(_FRESH_PREPARE_PIP_SPECS)

    if missing_specs:
        pip_specs = list(_FRESH_PREPARE_PIP_SPECS) if full_reinstall else _dedupe_prepare_pip_specs(missing_specs)
        _emit_prepare_progress(
            on_progress,
            6.0,
            "Python 패키지",
            f"pip install 시작: {', '.join(pip_specs)} (수 분 소요될 수 있습니다)",
        )
        _run_prepare_pip_install(
            pip_specs,
            on_progress=on_progress,
            batch=False,
        )
    elif not full_reinstall:
        _emit_prepare_progress(on_progress, 12.0, "Python 패키지", "faster-whisper 이미 설치됨")

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
        "kiwipiepy",
        smoke_by_module=_prepare_import_smoke_map(),
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
        transcribe_kwargs: dict[str, Any] = {
            "beam_size": beam_size,
            "language": language,
            "vad_filter": vad_filter,
            "word_timestamps": True,
            "condition_on_previous_text": False,
        }
        if vad_filter:
            transcribe_kwargs["vad_parameters"] = {
                "min_silence_duration_ms": 500,
                "speech_pad_ms": 150,
            }
        return _whisper_model.transcribe(audio_path, **transcribe_kwargs)

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


_BOUNDARY_PUNCT_STRIP = ".,!?…"
_BOUNDARY_WORD_GAP_SEC = 0.2
_BOUNDARY_CUE_GAP_SEC = 0.35


def _cue_is_silence_row(cue: dict[str, Any]) -> bool:
    return bool(cue.get("is_silence") or cue.get("isSilence"))


def _norm_boundary_word_text(word: str) -> str:
    return str(word or "").strip().rstrip(_BOUNDARY_PUNCT_STRIP)


def _nonempty_cue_words(cue: dict[str, Any]) -> list[dict[str, Any]]:
    words = cue.get("words")
    if not isinstance(words, list):
        return []
    out: list[dict[str, Any]] = []
    for w in words:
        if not isinstance(w, dict):
            continue
        if str(w.get("word", "") or "").strip():
            out.append(w)
    return out


def _sync_cue_times_and_text_from_words(cue: dict[str, Any]) -> None:
    words = _nonempty_cue_words(cue)
    if not words:
        return
    starts: list[float] = []
    ends: list[float] = []
    texts: list[str] = []
    for w in words:
        try:
            starts.append(float(w.get("start", 0)))
            ends.append(float(w.get("end", 0)))
        except (TypeError, ValueError):
            continue
        t = str(w.get("word", "") or "").strip()
        if t:
            texts.append(t)
    if starts and ends:
        cue["start"] = min(starts)
        cue["end"] = max(ends)
    if texts:
        cue["text"] = " ".join(texts)


def _dedup_echo_in_next_word(_prev_word: dict[str, Any], next_word: dict[str, Any]) -> None:
    next_word["word"] = ""


def _prune_empty_words(cue: dict[str, Any]) -> None:
    words = cue.get("words")
    if not isinstance(words, list):
        return
    cue["words"] = [
        w
        for w in words
        if isinstance(w, dict) and str(w.get("word", "") or "").strip()
    ]


def smooth_boundaries(subtitles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """VAD 세그먼트 경계 — word time overlap 분리 + 텍스트 echo 제거."""
    if len(subtitles) < 2:
        return subtitles

    for i in range(len(subtitles) - 1):
        prev_cue = subtitles[i]
        next_cue = subtitles[i + 1]
        if _cue_is_silence_row(prev_cue) or _cue_is_silence_row(next_cue):
            continue

        prev_words = _nonempty_cue_words(prev_cue)
        next_words = _nonempty_cue_words(next_cue)
        if not prev_words or not next_words:
            continue

        prev_word = prev_words[-1]
        next_word = next_words[0]

        try:
            pw_end = float(prev_word.get("end", 0))
            nw_start = float(next_word.get("start", 0))
            prev_cue_end = float(prev_cue.get("end", 0))
            next_cue_start = float(next_cue.get("start", 0))
        except (TypeError, ValueError):
            continue

        word_overlap = pw_end > nw_start
        if word_overlap:
            mid = round((pw_end + nw_start) / 2.0, 3)
            prev_word["end"] = mid
            next_word["start"] = mid
            pw_end = mid
            nw_start = mid

        pt = _norm_boundary_word_text(str(prev_word.get("word", "") or ""))
        nt = _norm_boundary_word_text(str(next_word.get("word", "") or ""))
        if not pt or not nt:
            _sync_cue_times_and_text_from_words(prev_cue)
            _sync_cue_times_and_text_from_words(next_cue)
            continue

        time_ok = (
            (nw_start - pw_end) < _BOUNDARY_WORD_GAP_SEC
            or (next_cue_start - prev_cue_end) < _BOUNDARY_CUE_GAP_SEC
            or word_overlap
        )
        should_dedup = False

        if pt.endswith(nt):
            if len(nt) <= 3:
                should_dedup = True
            elif time_ok:
                should_dedup = True
        elif (
            len(pt) <= 2
            and len(nt) == len(pt) + 1
            and nt.endswith(pt)
        ):
            if nt[0] == "이" or (nt[0] == "으" and pt in ("로", "면")):
                should_dedup = True
        elif len(nt) == 1 and pt[-1] == nt[0]:
            should_dedup = True

        if should_dedup:
            _dedup_echo_in_next_word(prev_word, next_word)
            _prune_empty_words(next_cue)

        _sync_cue_times_and_text_from_words(prev_cue)
        _sync_cue_times_and_text_from_words(next_cue)

    return subtitles


_GAP_THRESHOLD_SEC = 0.1
# 말끝 짧은 간격(예: 0.3s)을 별도 `--` cue 로 두지 않고 이전 cue end 연장
_MERGE_SHORT_GAP_SEC = 0.45
# VFR/CFR 정규화 소스 — Whisper segment gap 은 `--` 삽입 완화
_GAP_THRESHOLD_NORMALIZED_SEC = 0.35
_MERGE_SHORT_GAP_NORMALIZED_SEC = 0.55
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


def _gap_fill_thresholds(media_timing: dict[str, Any] | None) -> tuple[float, float]:
    """(gap_threshold, merge_short_gap) — normalized/VFR 소스는 `--` cue 덜 삽입."""
    mt = media_timing or {}
    source = mt.get("source_probe") if isinstance(mt.get("source_probe"), dict) else {}
    normalized = bool(mt.get("normalized"))
    vfr = bool(mt.get("vfr_suspected")) or bool(source.get("vfr_suspected"))
    actions = mt.get("normalize_actions")
    if normalized or vfr or (isinstance(actions, list) and len(actions) > 0):
        return _GAP_THRESHOLD_NORMALIZED_SEC, _MERGE_SHORT_GAP_NORMALIZED_SEC
    return _GAP_THRESHOLD_SEC, _MERGE_SHORT_GAP_SEC


def _fill_unvoiced_gaps(
    raw_cues: list[dict[str, Any]],
    total_dur: float,
    *,
    media_timing: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Whisper segment 사이 무음 — gap 이상이면 `--` cue, 미만은 이전 cue end 연장."""
    gap_threshold, merge_short_gap = _gap_fill_thresholds(media_timing)
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
            if gap >= gap_threshold:
                if out and gap < merge_short_gap:
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
        if gap_tail >= gap_threshold:
            if out and gap_tail < merge_short_gap:
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


def _contract_is_source_video_pts(contract: dict[str, Any] | None) -> bool:
    if not isinstance(contract, dict):
        return False
    axis = str(contract.get("timeline_axis") or "").strip()
    return axis == "source_video_pts" and bool(contract.get("ok", True))


def _media_timing_from_contract(
    contract: dict[str, Any],
    *,
    source_media_path: Path,
    whisper_audio_path: Path,
) -> dict[str, Any]:
    """Go MediaTimingContract → API pass-through (no word time scale)."""
    out = dict(contract)
    out.setdefault("contract_version", "1.0")
    out.setdefault("timeline_axis", "source_video_pts")
    out["source_media_path"] = str(source_media_path.resolve())
    out["source_path"] = str(source_media_path.resolve())
    out["whisper_audio_path"] = str(whisper_audio_path.resolve())
    out["preview_media_path"] = str(source_media_path.resolve())
    out["transcribe_media_path"] = str(whisper_audio_path.resolve())
    out["normalized"] = False
    vdur = contract.get("video_duration_sec")
    if isinstance(vdur, (int, float)) and float(vdur) > 0:
        vd = float(vdur)
        out["word_timeline_duration_sec"] = vd
        out["playback_duration_sec"] = vd
    if contract.get("preprocess_actions") and not out.get("normalize_actions"):
        out["normalize_actions"] = list(contract.get("preprocess_actions") or [])
    return out


def _apply_preview_probe_to_media_timing(
    media_timing: dict[str, Any],
    preview_probe: dict[str, Any],
    *,
    preview_path: Path,
    prep_actions: list[str],
) -> dict[str, Any]:
    """정규화된 preview ffprobe — A/V 길이·재생 SSOT 갱신."""
    out = {**media_timing, **preview_probe}
    out["preview_media_path"] = str(preview_path.resolve())
    out["normalized"] = True
    actions: list[str] = []
    for src in (media_timing.get("normalize_actions"), prep_actions):
        if isinstance(src, list):
            actions.extend(str(a) for a in src if a)
    if media_timing.get("preprocess_actions"):
        actions.extend(str(a) for a in media_timing["preprocess_actions"] if a)
    out["normalize_actions"] = list(dict.fromkeys(actions))
    playback = preview_probe.get("playback_duration_sec")
    if not (isinstance(playback, (int, float)) and float(playback) > 0):
        playback = preview_probe.get("video_duration_sec") or preview_probe.get(
            "audio_duration_sec"
        )
    if isinstance(playback, (int, float)) and float(playback) > 0:
        pb = float(playback)
        out["word_timeline_duration_sec"] = pb
        out["playback_duration_sec"] = pb
    return out


def _preview_video_duration_sec(
    preview_probe: dict[str, Any], media_timing: dict[str, Any]
) -> float:
    for key in (
        "video_duration_sec",
        "playback_duration_sec",
        "word_timeline_duration_sec",
        "audio_duration_sec",
    ):
        for src in (preview_probe, media_timing):
            v = src.get(key)
            if isinstance(v, (int, float)) and float(v) > 0:
                return float(v)
    return 0.0


def build_preview_media_ssot(
    media_path: Path,
    *,
    on_progress: Callable[[float, str, str], None] | None = None,
) -> dict[str, Any]:
    """프로젝트 불러오기·export용 CFR preview SSOT (transcribe 없이)."""
    from engines.auto_subtitle_media_normalize import prepare_preview_media_bundle

    media_path = media_path.resolve()
    if not media_path.is_file():
        return {
            "ok": False,
            "error": "file_not_found",
            "source_path": str(media_path),
        }

    prepend_ffmpeg_bin_to_env(os.environ)
    prep, source_probe, preview_probe = prepare_preview_media_bundle(
        media_path,
        on_progress=on_progress,
    )
    base_timing: dict[str, Any] = {
        **source_probe,
        "source_media_path": str(media_path),
        "source_path": str(media_path),
        "source_probe": source_probe,
    }
    media_timing = _apply_preview_probe_to_media_timing(
        base_timing,
        preview_probe,
        preview_path=prep.preview_path,
        prep_actions=prep.actions,
    )
    media_timing["normalized"] = bool(prep.normalized)
    return {
        "ok": True,
        "preview_media_path": str(prep.preview_path.resolve()),
        "media_timing": media_timing,
        "normalized": prep.normalized,
        "actions": prep.actions,
        "source_path": str(media_path),
    }


def _run_transcribe(
    media_path: Path,
    *,
    language: str | None,
    beam_size: int,
    vad_filter: bool,
    rms_vad_align: bool,
    job_dir: Path,
    whisper_audio_path: Path | None = None,
    media_timing_contract: dict[str, Any] | None = None,
) -> None:
    global _whisper_model, _model_device

    if _whisper_model is None:
        _set_transcribe_job("failed", 0.0, error="Whisper 모델이 로드되지 않았습니다. /prepare를 먼저 실행하세요.")
        return

    _set_transcribe_job("running", 1.0, "미디어 타임라인 분석…")
    prepend_ffmpeg_bin_to_env(os.environ)
    t0 = time.perf_counter()

    use_contract = (
        whisper_audio_path is not None
        and whisper_audio_path.is_file()
        and _contract_is_source_video_pts(media_timing_contract)
    )

    from engines.auto_subtitle_media_normalize import (
        WHISPER_FROM_PREVIEW_WAV,
        extract_whisper_wav_from_preview,
        prepare_transcribe_media,
    )
    from engines.auto_subtitle_media_probe import probe_media_timing

    _set_transcribe_job("running", 1.5, "재생용 미디어 A/V 정규화…")
    source_probe = probe_media_timing(media_path)

    def _norm_progress(pct: float, step: str, detail: str = "") -> None:
        _set_transcribe_job(
            "running",
            max(1.0, min(4.5, 1.5 + pct * 0.03)),
            detail or step,
        )

    prep = prepare_transcribe_media(
        media_path,
        job_dir,
        source_probe,
        on_progress=_norm_progress,
    )
    prep_preview = prep.preview_path

    _set_transcribe_job("running", 2.0, "프리뷰 SSOT 타임라인…")
    preview_probe = probe_media_timing(prep_preview, unify_ssot=True)

    if use_contract:
        assert media_timing_contract is not None
        base_timing = _media_timing_from_contract(
            media_timing_contract,
            source_media_path=media_path,
            whisper_audio_path=prep_preview,
        )
        base_timing["source_probe"] = source_probe
    else:
        base_timing = {
            **source_probe,
            "source_media_path": str(media_path.resolve()),
            "source_probe": source_probe,
        }

    media_timing = _apply_preview_probe_to_media_timing(
        base_timing,
        preview_probe,
        preview_path=prep_preview,
        prep_actions=prep.actions,
    )
    logger.info(
        "preview A/V sync: video=%.3fs audio=%.3fs delta=%.3fs vfr=%s actions=%s",
        float(media_timing.get("video_duration_sec") or 0),
        float(media_timing.get("audio_duration_sec") or 0),
        float(media_timing.get("av_duration_delta_sec") or 0),
        media_timing.get("vfr_suspected"),
        media_timing.get("normalize_actions"),
    )

    preview_dur = _preview_video_duration_sec(preview_probe, media_timing)
    whisper_wav = job_dir / WHISPER_FROM_PREVIEW_WAV
    _set_transcribe_job("running", 2.5, "프리뷰 미디어에서 Whisper 입력 추출…")
    extract_whisper_wav_from_preview(
        prep_preview,
        whisper_wav,
        duration_sec=preview_dur if preview_dur > 0 else None,
    )
    audio_path = str(whisper_wav.resolve())
    transcribe_media = whisper_wav
    media_timing = {
        **media_timing,
        "whisper_audio_path": audio_path,
        "transcribe_media_path": audio_path,
        "preview_media_path": str(prep_preview.resolve()),
        "normalize_actions": prep.actions,
        "normalized": prep.normalized,
    }
    if whisper_audio_path is not None and whisper_audio_path.is_file():
        media_timing["go_whisper_audio_path"] = str(whisper_audio_path.resolve())

    _set_transcribe_job("running", 3.0, "자막 추출을 시작합니다.")

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
    whisper_dur = total_dur
    pb = media_timing.get("playback_duration_sec") or media_timing.get(
        "word_timeline_duration_sec"
    )
    if isinstance(pb, (int, float)) and float(pb) > 0:
        total_dur = float(pb)
    elif total_dur <= 0:
        vdur = media_timing.get("video_duration_sec")
        if isinstance(vdur, (int, float)) and float(vdur) > 0:
            total_dur = float(vdur)
    media_timing = {
        **media_timing,
        "whisper_duration_sec": whisper_dur if whisper_dur > 0 else total_dur,
        "word_timeline_duration_sec": total_dur
        if total_dur > 0
        else media_timing.get("word_timeline_duration_sec"),
        "playback_duration_sec": total_dur
        if total_dur > 0
        else media_timing.get("playback_duration_sec"),
    }
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

    subtitles = smooth_boundaries(subtitles)

    if rms_vad_align:
        _set_transcribe_job("running", 92.0, "단어 타임스탬프 정렬 (RMS/VAD)…")
        try:
            from engines.auto_subtitle_rms_vad import apply_rms_vad_word_align

            subtitles = apply_rms_vad_word_align(
                subtitles,
                audio_path,
                str(get_ffmpeg_executable()),
                total_duration=total_dur,
            )
        except Exception as e:
            logger.error("RMS/VAD align failed: %s", e, exc_info=True)

    _set_transcribe_job("running", 96.0, "자막 추출 마무리…")
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
            peaks_media = prep_preview.resolve()
            wf_result = auto_subtitle_audiowaveform.waveform_peaks_impl(peaks_media, peaks_path)
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
        "duration_sec": total_dur if total_dur > 0 else whisper_dur,
        "device": _model_device,
        "fallback_to_cpu": did_fallback,
        "transcribe_ms": elapsed_ms,
        "cues_json_path": str(cues_path.resolve()),
        "srt_path": str(srt_path.resolve()),
        "media_path": str(media_path.resolve()),
        "preview_media_path": str(prep_preview.resolve()),
        "media_timing": media_timing,
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
    rms_vad_align: bool = False,
    whisper_audio_path: Path | None = None,
    media_timing_contract: dict[str, Any] | None = None,
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
                    whisper_audio_path=whisper_audio_path,
                    media_timing_contract=media_timing_contract,
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
