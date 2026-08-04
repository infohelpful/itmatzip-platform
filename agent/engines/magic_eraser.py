"""Magic Eraser (IOPaint LaMa erase-only) — 작업 공간·모델 다운로드·추론 잡 관리."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from common.subprocess_util import no_window_creationflags, run_hidden
from engines import iopaint_runtime
from runtime_paths import (
    agent_package_root,
    iopaint_runner_script,
    is_frozen,
    magic_eraser_python_executable,
)

PrepareProgressCallback = Callable[[float, str, str], None]

MAGIC_ERASER_ROOT = iopaint_runtime.magic_eraser_root()
MODEL_ROOT = MAGIC_ERASER_ROOT / "models"
WORKSPACE_ROOT = MAGIC_ERASER_ROOT / "workspace"
MANIFEST_PATH = MAGIC_ERASER_ROOT / "prepare-manifest.json"

ALLOWED_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".jfif"}
ALLOWED_MASK_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

_MIN_LAMA_MODEL_BYTES = 50_000_000
_MAX_MASK_BASE64_BYTES = 40 * 1024 * 1024  # 디코딩 후 원본 이미지 크기 상한

_PROGRESS_RE = re.compile(r"^ITZ_PROGRESS\s+([0-9.]+)\s*(.*)$")
_RESULT_RE = re.compile(r"^ITZ_RESULT\s+(\{.*\})$")


@dataclass
class EraseResult:
    original_path: Path
    mask_path: Path
    output_path: Path
    width: int
    height: int


@dataclass
class EraseJobStatus:
    phase: str
    progress: float
    message: str | None = None
    result: EraseResult | None = None


_job_lock = threading.RLock()
_job = EraseJobStatus(phase="idle", progress=0.0, message=None)
_job_thread: threading.Thread | None = None


def _emit(
    on_progress: PrepareProgressCallback | None,
    pct: float,
    step: str,
    detail: str = "",
) -> None:
    if on_progress is not None:
        on_progress(pct, step, detail)


def ensure_workspace() -> None:
    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)


def is_model_ready_fast() -> bool:
    if not iopaint_runtime.is_runtime_ready_fast():
        return False
    if not iopaint_runtime.is_pip_stack_ready_fast():
        return False
    return iopaint_runtime.is_lama_model_ready()


def is_model_ready() -> bool:
    try:
        if not iopaint_runtime.is_runtime_ready():
            return False
    except Exception:
        return False
    return iopaint_runtime.is_lama_model_ready()


def has_nvidia_gpu() -> bool:
    return iopaint_runtime.has_nvidia_gpu()


def is_cuda_available() -> bool:
    return iopaint_runtime.is_cuda_available()


def installed_torch_version() -> str | None:
    return iopaint_runtime.installed_torch_version()


def select_torch_bundle() -> str:
    return iopaint_runtime.select_torch_bundle()


def iopaint_python_version() -> str:
    try:
        python = iopaint_runtime.iopaint_python()
    except RuntimeError:
        return ""
    proc = run_hidden([str(python), "--version"], capture_output=True, text=True, timeout=30)
    return (proc.stdout or proc.stderr or "").strip()


def is_allowed_media_path(path: Path) -> bool:
    resolved = path.resolve()
    if WORKSPACE_ROOT in resolved.parents or resolved == WORKSPACE_ROOT:
        return True
    if MAGIC_ERASER_ROOT in resolved.parents or resolved == MAGIC_ERASER_ROOT:
        return True
    return resolved.is_file() and resolved.suffix.lower() in ALLOWED_IMAGE_SUFFIXES


def is_allowed_input_path(path: Path) -> bool:
    resolved = path.resolve()
    if not resolved.is_file():
        return False
    if resolved.suffix.lower() not in ALLOWED_IMAGE_SUFFIXES:
        return False
    return is_allowed_media_path(resolved)


def is_allowed_mask_path(path: Path) -> bool:
    resolved = path.resolve()
    if not resolved.is_file():
        return False
    if resolved.suffix.lower() not in ALLOWED_MASK_SUFFIXES:
        return False
    return is_allowed_media_path(resolved)


def get_job_status() -> EraseJobStatus:
    with _job_lock:
        return EraseJobStatus(
            phase=_job.phase,
            progress=_job.progress,
            message=_job.message,
            result=_job.result,
        )


def _set_job(
    phase: str,
    progress: float,
    message: str | None = None,
    result: EraseResult | None = None,
) -> None:
    with _job_lock:
        _job.phase = phase
        _job.progress = progress
        _job.message = message
        if result is not None or phase in {"idle", "failed"}:
            _job.result = result


def cleanup_workspace() -> dict[str, object]:
    ensure_workspace()
    errors: list[str] = []
    files_removed = 0
    dirs_removed = 0

    with _job_lock:
        if _job_thread is not None and _job_thread.is_alive():
            return {
                "ok": False,
                "files_removed": 0,
                "dirs_removed": 0,
                "errors": ["지우기 작업이 진행 중입니다. 완료 후 정리할 수 있습니다."],
            }
        _job.phase = "idle"
        _job.progress = 0.0
        _job.message = "작업 공간이 정리되었습니다."
        _job.result = None

    for entry in list(WORKSPACE_ROOT.iterdir()):
        try:
            if entry.is_dir():
                shutil.rmtree(entry)
                dirs_removed += 1
            elif entry.is_file():
                entry.unlink()
                files_removed += 1
        except OSError as exc:
            errors.append(f"{entry.name}: {exc}")

    return {
        "ok": len(errors) == 0,
        "files_removed": files_removed,
        "dirs_removed": dirs_removed,
        "errors": errors,
    }


def _load_manifest() -> dict:
    if not MANIFEST_PATH.is_file():
        return {"version": 1, "python": "3.12", "files": {}}
    try:
        return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"version": 1, "python": "3.12", "files": {}}


def _save_manifest(data: dict) -> None:
    ensure_workspace()
    data.setdefault("python", "3.12")
    MANIFEST_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _record_download(name: str, url: str, path: Path) -> None:
    manifest = _load_manifest()
    manifest["files"] = manifest.get("files") or {}
    digest = hashlib.sha256()
    try:
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(chunk)
        manifest["files"][name] = {
            "url": url,
            "sha256": digest.hexdigest(),
            "bytes": path.stat().st_size,
        }
    except OSError:
        manifest["files"][name] = {"url": url}
    _save_manifest(manifest)


def download_models(on_progress: PrepareProgressCallback | None = None) -> None:
    """LaMa TorchScript 가중치(big-lama.pt)를 library-hub 에서 내려받는다."""
    path = iopaint_runtime.ensure_lama_model(on_progress, base_pct=60.0)
    _record_download("big-lama.pt", iopaint_runtime.lama_model_url(), path)


def install_dependencies(on_progress: PrepareProgressCallback | None = None) -> str:
    if is_frozen():
        raise RuntimeError("Frozen exe 환경에서는 Magic Eraser 자동 설치를 지원하지 않습니다.")
    ensure_workspace()
    bundle = iopaint_runtime.install_runtime_dependencies(on_progress)
    _emit(
        on_progress,
        52.0,
        "Magic Eraser Python",
        str(iopaint_runtime.iopaint_python()),
    )
    return bundle


def _resolve_device(device: str | None) -> str:
    if device is None:
        return "cuda" if is_cuda_available() else "cpu"
    normalized = str(device).lower()
    if normalized not in {"cpu", "cuda"}:
        raise ValueError("device must be 'cpu' or 'cuda'")
    if normalized == "cuda" and not is_cuda_available():
        raise RuntimeError(
            "CUDA를 사용할 수 없습니다. Magic Eraser 준비를 다시 실행하거나 CPU를 선택하세요."
        )
    return normalized


def _decode_mask_base64(mask_base64: str, dest: Path) -> Path:
    """base64 PNG/L(grayscale, white=erase) 마스크를 디코딩해 job 폴더에 저장."""
    from PIL import Image
    import io

    raw = mask_base64.strip()
    if raw.startswith("data:"):
        comma = raw.find(",")
        if comma != -1:
            raw = raw[comma + 1 :]
    try:
        decoded = base64.b64decode(raw, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"mask_base64 디코딩 실패: {exc}") from None
    if not decoded:
        raise ValueError("mask_base64 가 비어 있습니다.")
    if len(decoded) > _MAX_MASK_BASE64_BYTES:
        raise ValueError("mask_base64 크기가 너무 큽니다.")

    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        with Image.open(io.BytesIO(decoded)) as image:
            mask = image.convert("L")
            mask.save(dest, format="PNG")
    except Exception as exc:
        raise ValueError(f"mask_base64 이미지 디코딩 실패: {exc}") from None
    return dest


def image_size(path: Path) -> tuple[int, int]:
    from PIL import Image

    with Image.open(path) as image:
        return image.size


def _run_iopaint_subprocess(
    input_path: Path,
    mask_path: Path,
    output_path: Path,
    model_path: Path,
    *,
    device: str,
    timeout_sec: float,
    on_progress: Callable[[float, str], None] | None = None,
) -> dict[str, object]:
    runner = iopaint_runner_script()
    if not runner.is_file():
        raise RuntimeError(f"iopaint_runner.py 없음: {runner}")

    python = magic_eraser_python_executable()
    package_root = agent_package_root()
    env = iopaint_runtime.runtime_env()
    env["ITMATZIP_AGENT_PACKAGE_ROOT"] = str(package_root)
    env["ITMATZIP_AGENT_DIR"] = str(package_root)

    command = [
        str(python),
        "-P",
        "-u",
        str(runner),
        "--input",
        str(input_path.resolve()),
        "--mask",
        str(mask_path.resolve()),
        "--output",
        str(output_path.resolve()),
        "--model-path",
        str(model_path.resolve()),
        "--device",
        device,
    ]

    proc = subprocess.Popen(  # noqa: S603
        command,
        cwd=str(package_root),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=no_window_creationflags(),
    )

    result_payload: dict[str, object] | None = None
    log_tail: list[str] = []
    last_pct = 12.0
    try:
        assert proc.stdout is not None
        for raw_line in proc.stdout:
            line = raw_line.strip()
            if not line:
                continue
            log_tail.append(line)
            if len(log_tail) > 80:
                log_tail.pop(0)

            result_match = _RESULT_RE.match(line)
            if result_match:
                try:
                    parsed = json.loads(result_match.group(1))
                    if isinstance(parsed, dict):
                        result_payload = parsed
                except json.JSONDecodeError:
                    pass
                continue

            progress_match = _PROGRESS_RE.match(line)
            if progress_match and on_progress:
                raw_pct = float(progress_match.group(1))
                last_pct = max(12.0, min(92.0, 12.0 + raw_pct * 0.8))
                on_progress(last_pct, progress_match.group(2) or "처리 중…")
            elif on_progress and len(line) < 160:
                on_progress(last_pct, line)
        proc.wait(timeout=timeout_sec)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise RuntimeError(f"지우기 처리 시간 초과 ({int(timeout_sec)}초)") from None

    if proc.returncode != 0:
        detail = "\n".join(log_tail)[-2000:] if log_tail else ""
        message = f"LaMa 실행 실패 (exit {proc.returncode})"
        raise RuntimeError(f"{message}\n{detail}" if detail else message)
    if result_payload is None:
        raise RuntimeError("LaMa 결과 정보를 받지 못했습니다.")
    return result_payload


def erase(
    input_path: Path,
    *,
    mask_path: Path | None = None,
    mask_base64: str | None = None,
    device: str | None = None,
    timeout_sec: float = 1800.0,
    on_progress: Callable[[float, str], None] | None = None,
) -> EraseResult:
    def report(pct: float, message: str) -> None:
        if on_progress:
            on_progress(pct, message)

    if not is_model_ready():
        raise RuntimeError(
            "Magic Eraser 환경이 준비되지 않았습니다. "
            "환경 준비(prepare)로 PyTorch·LaMa 모델을 설치한 뒤 다시 시도하세요."
        )
    if not is_allowed_input_path(input_path):
        raise ValueError(f"허용되지 않은 입력 경로입니다: {input_path}")
    if not mask_path and not mask_base64:
        raise ValueError("mask_path 또는 mask_base64 중 하나가 필요합니다.")
    if mask_path is not None and not is_allowed_mask_path(mask_path):
        raise ValueError(f"허용되지 않은 마스크 경로입니다: {mask_path}")

    device_resolved = _resolve_device(device)
    report(6.0, f"작업 폴더 준비 중… ({device_resolved.upper()})")

    job_dir = WORKSPACE_ROOT / f"job-{int(time.time() * 1000)}"
    input_dir = job_dir / "input"
    output_dir = job_dir / "output"
    input_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    staged_input = input_dir / f"input{input_path.suffix.lower()}"
    shutil.copy2(input_path, staged_input)

    staged_mask = input_dir / "mask.png"
    if mask_base64:
        _decode_mask_base64(mask_base64, staged_mask)
    else:
        assert mask_path is not None
        from PIL import Image

        with Image.open(mask_path) as raw_mask:
            raw_mask.convert("L").save(staged_mask, format="PNG")

    model_path = iopaint_runtime.lama_model_path()
    if not model_path.is_file():
        raise RuntimeError(f"LaMa 모델 파일을 찾을 수 없습니다: {model_path}")

    output_path = output_dir / "erased.png"

    payload = _run_iopaint_subprocess(
        staged_input,
        staged_mask,
        output_path,
        model_path,
        device=device_resolved,
        timeout_sec=timeout_sec,
        on_progress=on_progress,
    )

    result_output_path = Path(str(payload.get("output_path") or "")).resolve()
    if not result_output_path.is_file():
        raise RuntimeError("지워진 결과 이미지를 찾을 수 없습니다.")

    report(100.0, "지우기가 완료되었습니다.")
    return EraseResult(
        original_path=input_path.resolve(),
        mask_path=staged_mask.resolve(),
        output_path=result_output_path,
        width=int(payload.get("width") or 0),
        height=int(payload.get("height") or 0),
    )


def _run_job(
    input_path: Path,
    mask_path: Path | None,
    mask_base64: str | None,
    device: str | None,
    timeout_sec: float,
) -> None:
    try:

        def on_progress(pct: float, message: str) -> None:
            _set_job("running", pct, message)

        result = erase(
            input_path,
            mask_path=mask_path,
            mask_base64=mask_base64,
            device=device,
            timeout_sec=timeout_sec,
            on_progress=on_progress,
        )
        _set_job("ready", 100.0, "완료", result=result)
    except Exception as exc:
        _set_job("failed", 0.0, str(exc))


def start_erase_job(
    input_path: Path,
    *,
    mask_path: Path | None = None,
    mask_base64: str | None = None,
    device: str | None = None,
    timeout_sec: float = 1800.0,
) -> EraseJobStatus:
    global _job_thread

    with _job_lock:
        if _job_thread is not None and _job_thread.is_alive():
            return get_job_status()
        _set_job("running", 2.0, "지우기 작업을 시작합니다…")
        _job_thread = threading.Thread(
            target=_run_job,
            args=(input_path, mask_path, mask_base64, device, timeout_sec),
            daemon=True,
        )
        _job_thread.start()
    return get_job_status()


def workspace_env_summary() -> dict[str, object]:
    return {
        "root": str(MAGIC_ERASER_ROOT),
        "workspace": str(WORKSPACE_ROOT),
        "models": str(MODEL_ROOT),
        "appdata": os.environ.get("APPDATA", ""),
    }
