"""Background Remover (BiRefNet) — 작업 공간·모델 다운로드·추론 잡 관리."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from common.subprocess_util import no_window_creationflags, run_hidden
from engines import birefnet_runtime
from runtime_paths import (
    agent_package_root,
    background_remover_python_executable,
    birefnet_runner_script,
    is_frozen,
)

PrepareProgressCallback = Callable[[float, str, str], None]

BACKGROUND_REMOVER_ROOT = birefnet_runtime.background_remover_root()
MODEL_ROOT = BACKGROUND_REMOVER_ROOT / "models"
WORKSPACE_ROOT = BACKGROUND_REMOVER_ROOT / "workspace"
MANIFEST_PATH = BACKGROUND_REMOVER_ROOT / "prepare-manifest.json"

ALLOWED_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".jfif"}

MODEL_VARIANTS = birefnet_runtime.MODEL_VARIANTS
DEFAULT_MODEL_VARIANT = birefnet_runtime.DEFAULT_MODEL_VARIANT

# 코드 파일(transformers trust_remote_code) — 가중치와 함께 있어야 오프라인 로드 가능
_MODEL_CODE_FILES = ("config.json", "birefnet.py", "BiRefNet_config.py")
_MODEL_WEIGHT_NAME = "model.safetensors"
_MIN_WEIGHT_BYTES = 50_000_000

_PROGRESS_RE = re.compile(r"^ITZ_PROGRESS\s+([0-9.]+)\s*(.*)$")
_RESULT_RE = re.compile(r"^ITZ_RESULT\s+(\{.*\})$")


@dataclass
class RemoveResult:
    original_path: Path
    cutout_path: Path
    mask_path: Path
    width: int
    height: int
    variant: str


@dataclass
class RemoveJobStatus:
    phase: str
    progress: float
    message: str | None = None
    result: RemoveResult | None = None


_job_lock = threading.RLock()
_job = RemoveJobStatus(phase="idle", progress=0.0, message=None)
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


def variant_label(variant: str) -> str:
    return "고해상도 (2048)" if birefnet_runtime.normalize_variant(variant) == "hr" else "일반 (1024)"


def is_variant_ready(variant: str) -> bool:
    directory = birefnet_runtime.model_dir(variant)
    if not all((directory / name).is_file() for name in _MODEL_CODE_FILES):
        return False
    weight = directory / _MODEL_WEIGHT_NAME
    return weight.is_file() and weight.stat().st_size > _MIN_WEIGHT_BYTES


def ready_variants() -> list[str]:
    return [name for name in MODEL_VARIANTS if is_variant_ready(name)]


def is_model_ready_fast() -> bool:
    if not birefnet_runtime.is_runtime_ready_fast():
        return False
    if not birefnet_runtime.is_pip_stack_ready_fast():
        return False
    return is_variant_ready(DEFAULT_MODEL_VARIANT)


def is_model_ready() -> bool:
    try:
        if not birefnet_runtime.is_runtime_ready():
            return False
    except Exception:
        return False
    return is_variant_ready(DEFAULT_MODEL_VARIANT)


def has_nvidia_gpu() -> bool:
    return birefnet_runtime.has_nvidia_gpu()


def is_cuda_available() -> bool:
    return birefnet_runtime.is_cuda_available()


def installed_torch_version() -> str | None:
    return birefnet_runtime.installed_torch_version()


def select_torch_bundle() -> str:
    return birefnet_runtime.select_torch_bundle()


def birefnet_python_version() -> str:
    try:
        python = birefnet_runtime.birefnet_python()
    except RuntimeError:
        return ""
    proc = run_hidden([str(python), "--version"], capture_output=True, text=True, timeout=30)
    return (proc.stdout or proc.stderr or "").strip()


def is_allowed_media_path(path: Path) -> bool:
    resolved = path.resolve()
    if WORKSPACE_ROOT in resolved.parents or resolved == WORKSPACE_ROOT:
        return True
    if BACKGROUND_REMOVER_ROOT in resolved.parents or resolved == BACKGROUND_REMOVER_ROOT:
        return True
    return resolved.is_file() and resolved.suffix.lower() in ALLOWED_IMAGE_SUFFIXES


def is_allowed_input_path(path: Path) -> bool:
    resolved = path.resolve()
    if not resolved.is_file():
        return False
    if resolved.suffix.lower() not in ALLOWED_IMAGE_SUFFIXES:
        return False
    return is_allowed_media_path(resolved)


def get_job_status() -> RemoveJobStatus:
    with _job_lock:
        return RemoveJobStatus(
            phase=_job.phase,
            progress=_job.progress,
            message=_job.message,
            result=_job.result,
        )


def _set_job(
    phase: str,
    progress: float,
    message: str | None = None,
    result: RemoveResult | None = None,
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
                "errors": ["배경 제거 작업이 진행 중입니다. 완료 후 정리할 수 있습니다."],
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


def ensure_model_variant(
    variant: str,
    on_progress: PrepareProgressCallback | None = None,
    *,
    base_pct: float = 60.0,
) -> Path:
    """BiRefNet 코드(zip) + 가중치(safetensors)를 library-hub 에서 내려받아 로컬 모델 폴더 구성."""
    name = birefnet_runtime.normalize_variant(variant)
    directory = birefnet_runtime.model_dir(name)
    directory.mkdir(parents=True, exist_ok=True)
    label = variant_label(name)

    if is_variant_ready(name):
        _emit(on_progress, base_pct + 14.0, "AI 모델", f"{label} 이미 설치됨")
        return directory

    if not all((directory / item).is_file() for item in _MODEL_CODE_FILES):
        code_url = birefnet_runtime.model_asset_url(name, "code")
        _emit(on_progress, base_pct, "AI 모델", f"{label} 코드 다운로드")
        with tempfile.TemporaryDirectory() as tmpdir:
            zip_path = Path(tmpdir) / "birefnet-code.zip"
            birefnet_runtime.download_http_file(
                code_url,
                zip_path,
                message_cb=lambda text: _emit(on_progress, base_pct + 1.0, "AI 모델", text),
                label=f"BiRefNet {name} code",
            )
            with zipfile.ZipFile(zip_path, "r") as zf:
                zf.extractall(Path(tmpdir) / "code")
            extracted = Path(tmpdir) / "code"
            for item in _MODEL_CODE_FILES:
                found = next(iter(extracted.rglob(item)), None)
                if found is None:
                    raise RuntimeError(f"BiRefNet 코드 zip 에 {item} 이 없습니다: {code_url}")
                shutil.copy2(found, directory / item)
        _record_download(f"{name}-code.zip", code_url, directory / "config.json")

    weight_path = directory / _MODEL_WEIGHT_NAME
    if not (weight_path.is_file() and weight_path.stat().st_size > _MIN_WEIGHT_BYTES):
        weight_url = birefnet_runtime.model_asset_url(name, "weights")
        _emit(on_progress, base_pct + 3.0, "AI 모델", f"{label} 가중치 다운로드")
        birefnet_runtime.download_http_file(
            weight_url,
            weight_path,
            message_cb=lambda text: _emit(on_progress, base_pct + 6.0, "AI 모델", text),
            label=f"BiRefNet {name} weights",
        )
        _record_download(f"{name}-{_MODEL_WEIGHT_NAME}", weight_url, weight_path)

    if not is_variant_ready(name):
        raise RuntimeError(f"BiRefNet {label} 모델 설치를 확인할 수 없습니다: {directory}")
    return directory


def download_models(on_progress: PrepareProgressCallback | None = None) -> None:
    """기본(general)은 항상, 고해상도(HR)는 GPU 환경에서만 미리 내려받습니다."""
    ensure_model_variant(DEFAULT_MODEL_VARIANT, on_progress, base_pct=60.0)
    if has_nvidia_gpu():
        ensure_model_variant("hr", on_progress, base_pct=78.0)
    else:
        _emit(on_progress, 92.0, "AI 모델", "고해상도 모델은 선택 시 다운로드")


def install_dependencies(on_progress: PrepareProgressCallback | None = None) -> str:
    if is_frozen():
        raise RuntimeError("Frozen exe 환경에서는 BiRefNet 자동 설치를 지원하지 않습니다.")
    ensure_workspace()
    bundle = birefnet_runtime.install_runtime_dependencies(on_progress)
    _emit(
        on_progress,
        52.0,
        "BiRefNet Python",
        str(birefnet_runtime.birefnet_python()),
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
            "CUDA를 사용할 수 없습니다. Background Remover 준비를 다시 실행하거나 CPU를 선택하세요."
        )
    return normalized


def _run_birefnet_subprocess(
    input_path: Path,
    output_dir: Path,
    model_directory: Path,
    *,
    variant: str,
    device: str,
    feather: int,
    threshold: float,
    max_size: int,
    use_half: bool,
    timeout_sec: float,
    on_progress: Callable[[float, str], None] | None = None,
) -> dict[str, object]:
    runner = birefnet_runner_script()
    if not runner.is_file():
        raise RuntimeError(f"birefnet_runner.py 없음: {runner}")

    python = background_remover_python_executable()
    package_root = agent_package_root()
    env = birefnet_runtime.runtime_env()
    env["ITMATZIP_AGENT_PACKAGE_ROOT"] = str(package_root)
    env["ITMATZIP_AGENT_DIR"] = str(package_root)

    command = [
        str(python),
        "-P",
        "-u",
        str(runner),
        "--input",
        str(input_path.resolve()),
        "--output-dir",
        str(output_dir.resolve()),
        "--model-dir",
        str(model_directory.resolve()),
        "--input-size",
        str(birefnet_runtime.model_input_size(variant)),
        "--device",
        device,
        "--feather",
        str(max(0, min(20, feather))),
        "--threshold",
        str(max(0.0, min(0.9, threshold))),
        "--max-size",
        str(max(0, min(8192, max_size))),
    ]
    if use_half and device == "cuda":
        command.append("--half")

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
        raise RuntimeError(f"배경 제거 처리 시간 초과 ({int(timeout_sec)}초)") from None

    if proc.returncode != 0:
        detail = "\n".join(log_tail)[-2000:] if log_tail else ""
        message = f"BiRefNet 실행 실패 (exit {proc.returncode})"
        raise RuntimeError(f"{message}\n{detail}" if detail else message)
    if result_payload is None:
        raise RuntimeError("BiRefNet 결과 정보를 받지 못했습니다.")
    return result_payload


def remove_background(
    input_path: Path,
    *,
    variant: str = DEFAULT_MODEL_VARIANT,
    device: str | None = None,
    feather: int = 0,
    threshold: float = 0.0,
    max_size: int = 0,
    use_half: bool = True,
    timeout_sec: float = 1800.0,
    on_progress: Callable[[float, str], None] | None = None,
) -> RemoveResult:
    def report(pct: float, message: str) -> None:
        if on_progress:
            on_progress(pct, message)

    if not is_model_ready():
        raise RuntimeError(
            "BiRefNet 환경이 준비되지 않았습니다. "
            "환경 준비(prepare)로 PyTorch·transformers·모델을 설치한 뒤 다시 시도하세요."
        )
    if not is_allowed_input_path(input_path):
        raise ValueError(f"허용되지 않은 입력 경로입니다: {input_path}")

    name = birefnet_runtime.normalize_variant(variant)
    device_resolved = _resolve_device(device)

    if not is_variant_ready(name):
        report(4.0, f"{variant_label(name)} 모델 다운로드 중…")

        def model_progress(pct: float, step: str, detail: str = "") -> None:
            report(min(10.0, 4.0 + pct * 0.05), f"{step} — {detail}" if detail else step)

        ensure_model_variant(name, model_progress, base_pct=0.0)

    model_directory = birefnet_runtime.model_dir(name)
    report(10.0, f"작업 폴더 준비 중… ({device_resolved.upper()} · {variant_label(name)})")

    job_dir = WORKSPACE_ROOT / f"job-{int(time.time() * 1000)}"
    input_dir = job_dir / "input"
    output_dir = job_dir / "output"
    input_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    staged_input = input_dir / f"input{input_path.suffix.lower()}"
    shutil.copy2(input_path, staged_input)

    payload = _run_birefnet_subprocess(
        staged_input,
        output_dir,
        model_directory,
        variant=name,
        device=device_resolved,
        feather=feather,
        threshold=threshold,
        max_size=max_size,
        use_half=use_half,
        timeout_sec=timeout_sec,
        on_progress=on_progress,
    )

    cutout_path = Path(str(payload.get("cutout_path") or "")).resolve()
    mask_path = Path(str(payload.get("mask_path") or "")).resolve()
    if not cutout_path.is_file():
        raise RuntimeError("배경이 제거된 결과 이미지를 찾을 수 없습니다.")

    report(100.0, "배경 제거가 완료되었습니다.")
    return RemoveResult(
        original_path=input_path.resolve(),
        cutout_path=cutout_path,
        mask_path=mask_path if mask_path.is_file() else cutout_path,
        width=int(payload.get("width") or 0),
        height=int(payload.get("height") or 0),
        variant=name,
    )


def _run_job(
    input_path: Path,
    variant: str,
    device: str | None,
    feather: int,
    threshold: float,
    max_size: int,
    use_half: bool,
    timeout_sec: float,
) -> None:
    try:

        def on_progress(pct: float, message: str) -> None:
            _set_job("running", pct, message)

        result = remove_background(
            input_path,
            variant=variant,
            device=device,
            feather=feather,
            threshold=threshold,
            max_size=max_size,
            use_half=use_half,
            timeout_sec=timeout_sec,
            on_progress=on_progress,
        )
        _set_job("ready", 100.0, "완료", result=result)
    except Exception as exc:
        _set_job("failed", 0.0, str(exc))


def start_remove_job(
    input_path: Path,
    *,
    variant: str = DEFAULT_MODEL_VARIANT,
    device: str | None = None,
    feather: int = 0,
    threshold: float = 0.0,
    max_size: int = 0,
    use_half: bool = True,
    timeout_sec: float = 1800.0,
) -> RemoveJobStatus:
    global _job_thread

    with _job_lock:
        if _job_thread is not None and _job_thread.is_alive():
            return get_job_status()
        _set_job("running", 2.0, "배경 제거 작업을 시작합니다…")
        _job_thread = threading.Thread(
            target=_run_job,
            args=(
                input_path,
                variant,
                device,
                feather,
                threshold,
                max_size,
                use_half,
                timeout_sec,
            ),
            daemon=True,
        )
        _job_thread.start()
    return get_job_status()


def image_size(path: Path) -> tuple[int, int]:
    from PIL import Image

    with Image.open(path) as image:
        return image.size


def workspace_env_summary() -> dict[str, object]:
    return {
        "root": str(BACKGROUND_REMOVER_ROOT),
        "workspace": str(WORKSPACE_ROOT),
        "models": str(MODEL_ROOT),
        "hf_home": str(birefnet_runtime.hf_home_dir()),
        "appdata": os.environ.get("APPDATA", ""),
    }
