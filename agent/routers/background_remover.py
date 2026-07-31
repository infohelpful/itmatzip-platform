from __future__ import annotations

import os
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from engines import background_remover, birefnet_runtime

router = APIRouter(prefix="/api/tools/background-remover", tags=["background-remover"])


class BackgroundRemoverPrepareStatus(BaseModel):
    phase: str
    progress: float
    message: str | None = None
    step: str | None = None
    detail: str | None = None


class BackgroundRemoverPreviewBody(BaseModel):
    image_path: str = Field(..., min_length=1, description="로컬 이미지 절대 경로")


class BackgroundRemoverRemoveBody(BaseModel):
    image_path: str = Field(..., description="로컬 이미지 파일 절대 경로")
    variant: str = Field(
        background_remover.DEFAULT_MODEL_VARIANT,
        description="general | hr",
    )
    feather: int = Field(0, ge=0, le=20, description="알파 경계 블러 반경(px)")
    threshold: float = Field(0.0, ge=0.0, le=0.9, description="이 값 미만 알파는 0")
    max_size: int = Field(
        0,
        ge=0,
        le=8192,
        description="긴 변 상한(px). 0=원본 유지",
    )
    use_half: bool = Field(True, description="CUDA fp16 추론")
    device: str | None = Field(None, description="'cpu' | 'cuda' | None=auto")
    timeout_sec: float = Field(1800.0, ge=30.0, le=7200.0)


class BackgroundRemoverRemoveStatus(BaseModel):
    phase: str
    progress: float
    message: str | None = None
    cutout_path: str | None = None
    mask_path: str | None = None
    original_path: str | None = None
    width: int | None = None
    height: int | None = None
    variant: str | None = None


class BackgroundRemoverWorkspaceCleanupResponse(BaseModel):
    ok: bool
    files_removed: int = 0
    dirs_removed: int = 0
    errors: list[str] = Field(default_factory=list)


_prepare_state = BackgroundRemoverPrepareStatus(
    phase="not_started",
    progress=0.0,
    message="Background Remover 준비를 시작하세요.",
)
_prepare_lock = threading.RLock()
_prepare_thread: threading.Thread | None = None


def _set_prepare_state(
    phase: str,
    progress: float,
    message: str | None = None,
    *,
    step: str | None = None,
    detail: str | None = None,
) -> None:
    with _prepare_lock:
        _prepare_state.phase = phase
        _prepare_state.progress = progress
        _prepare_state.message = message
        _prepare_state.step = step
        _prepare_state.detail = detail


def _get_prepare_state() -> BackgroundRemoverPrepareStatus:
    with _prepare_lock:
        return BackgroundRemoverPrepareStatus(
            phase=_prepare_state.phase,
            progress=_prepare_state.progress,
            message=_prepare_state.message,
            step=_prepare_state.step,
            detail=_prepare_state.detail,
        )


def _prepare_phase_for_step(step: str) -> str:
    lowered = step.lower()
    if "모델" in step or "model" in lowered or "safetensors" in lowered:
        return "downloading_models"
    return "installing_dependencies"


def _run_prepare() -> None:
    def report(pct: float, step: str, detail: str = "") -> None:
        phase = _prepare_phase_for_step(step)
        message = f"{step} — {detail}" if detail else step
        _set_prepare_state(phase, pct, message, step=step, detail=detail or None)

    try:
        _set_prepare_state(
            "installing_dependencies",
            3.0,
            "디스크 공간 확인 중…",
            step="환경",
            detail="최소 6GB 여유 권장",
        )
        background_remover.ensure_workspace()

        _set_prepare_state(
            "installing_dependencies",
            5.0,
            "BiRefNet 전용 Python 3.12 환경 설치 중…",
            step="설치 시작",
            detail="library-hub wheel · BiRefNet 모델",
        )
        bundle = background_remover.install_dependencies(on_progress=report)
        bundle_label = "GPU(CUDA)" if bundle == "gpu" else "CPU"
        cuda_note = "CUDA 사용 가능" if background_remover.is_cuda_available() else "CPU 모드"
        torch_ver = background_remover.installed_torch_version() or "?"

        _set_prepare_state(
            "downloading_models",
            58.0,
            "AI 모델 다운로드를 시작합니다…",
            step="AI 모델",
            detail="BiRefNet general · HR(선택)",
        )
        background_remover.download_models(on_progress=report)

        birefnet_runtime.invalidate_torch_probe_cache()
        _set_prepare_state(
            "ready",
            100.0,
            "Background Remover 준비가 완료되었습니다.",
            step="완료",
            detail=f"{bundle_label} · torch {torch_ver} · {cuda_note}",
        )
    except Exception as exc:
        _set_prepare_state(
            "failed",
            0.0,
            f"준비 중 오류가 발생했습니다: {exc}",
            step="오류",
            detail=str(exc),
        )


@router.get("/readiness")
def get_readiness() -> dict[str, object]:
    """페이지 로드용 — subprocess import·긴 wheel 검사 없이 빠르게 응답."""
    try:
        planned = background_remover.select_torch_bundle()
        runtime = birefnet_runtime.runtime_status_fast()
        python_path: str | None = None
        python_ver: str | None = None
        try:
            python_path = str(birefnet_runtime.birefnet_python())
            python_ver = background_remover.birefnet_python_version()
        except Exception as exc:
            python_path = None
            python_ver = str(exc)

        runtime_fast = birefnet_runtime.is_runtime_ready_fast()
        pip_stack = birefnet_runtime.is_pip_stack_ready_fast()
        model_ready = background_remover.is_model_ready_fast()
        if model_ready and not pip_stack:
            pip_stack = birefnet_runtime.is_pip_stack_ready()
        torch_ok = runtime_fast and (birefnet_runtime.is_torch_installed() or model_ready)
        return {
            "ok": True,
            "tool": "background-remover",
            "runtime": runtime,
            "birefnet_python": {
                "executable": python_path,
                "version": python_ver,
            },
            "pytorch": {
                "planned_bundle": planned,
                "installed_bundle": birefnet_runtime.installed_torch_variant() if torch_ok else None,
                "gpu_detected": background_remover.has_nvidia_gpu(),
                "torch_version": background_remover.installed_torch_version() if torch_ok else None,
                "source": "library-hub background-remover-lib (wheel)",
            },
            "models": {
                "ready_variants": background_remover.ready_variants(),
                "default_variant": background_remover.DEFAULT_MODEL_VARIANT,
                "variants": list(background_remover.MODEL_VARIANTS),
            },
            "binaries": {
                "torch": torch_ok,
                "pip_stack": pip_stack,
                "model_ready": model_ready,
                "cuda_available": birefnet_runtime.is_cuda_available_fast(),
            },
        }
    except Exception as exc:
        return {
            "ok": False,
            "tool": "background-remover",
            "error": str(exc),
            "binaries": {
                "torch": False,
                "pip_stack": False,
                "model_ready": False,
                "cuda_available": False,
            },
        }


@router.get("/status")
def get_status() -> dict[str, object]:
    return {
        "ok": True,
        "tool": "background-remover",
        "model_ready": background_remover.is_model_ready_fast(),
        "ready_variants": background_remover.ready_variants(),
        "supported_variants": list(background_remover.MODEL_VARIANTS),
        "allowed_suffixes": sorted(background_remover.ALLOWED_IMAGE_SUFFIXES),
    }


@router.post("/prepare")
def post_prepare(
    force: bool = Query(False, description="ready여도 재준비"),
) -> BackgroundRemoverPrepareStatus:
    global _prepare_thread

    with _prepare_lock:
        if _prepare_thread is not None and _prepare_thread.is_alive():
            _prepare_state.detail = "설치가 이미 진행 중입니다."
            return _get_prepare_state()

        if (
            _prepare_state.phase == "ready"
            and not force
            and background_remover.is_model_ready()
        ):
            return _get_prepare_state()

        _prepare_state.message = "Background Remover 준비를 시작합니다…"
        _prepare_state.step = "설치 시작"
        _prepare_state.detail = "Python 3.12 · PyTorch · BiRefNet"
        _prepare_state.phase = "installing_dependencies"
        _prepare_state.progress = 5.0
        _prepare_thread = threading.Thread(target=_run_prepare, daemon=True)
        _prepare_thread.start()

    return _get_prepare_state()


@router.get("/prepare/status")
def get_prepare_status() -> BackgroundRemoverPrepareStatus:
    return _get_prepare_state()


def _remove_status_payload(job: background_remover.RemoveJobStatus) -> BackgroundRemoverRemoveStatus:
    result = job.result
    return BackgroundRemoverRemoveStatus(
        phase=job.phase,
        progress=job.progress,
        message=job.message,
        cutout_path=str(result.cutout_path) if result else None,
        mask_path=str(result.mask_path) if result else None,
        original_path=str(result.original_path) if result else None,
        width=result.width if result else None,
        height=result.height if result else None,
        variant=result.variant if result else None,
    )


@router.post("/remove", response_model=BackgroundRemoverRemoveStatus)
def post_remove(body: BackgroundRemoverRemoveBody) -> BackgroundRemoverRemoveStatus:
    variant = birefnet_runtime.normalize_variant(body.variant)
    if body.device is not None and body.device not in {"cpu", "cuda"}:
        raise HTTPException(status_code=400, detail="device는 'cpu' 또는 'cuda' 이어야 합니다.")

    path = Path(body.image_path)
    if not path.is_file():
        raise HTTPException(status_code=400, detail=f"파일을 찾을 수 없습니다: {path}")
    if not background_remover.is_allowed_input_path(path):
        raise HTTPException(status_code=400, detail="허용되지 않은 이미지 경로입니다.")

    if not background_remover.is_model_ready():
        raise HTTPException(
            status_code=503,
            detail=(
                "BiRefNet 환경이 준비되지 않았습니다. "
                "페이지에서 「환경 준비」를 완료한 뒤 다시 시도하세요. "
                "(PyTorch + transformers/timm + 모델)"
            ),
        )

    job = background_remover.start_remove_job(
        path,
        variant=variant,
        device=body.device,
        feather=body.feather,
        threshold=body.threshold,
        max_size=body.max_size,
        use_half=body.use_half,
        timeout_sec=body.timeout_sec,
    )
    return _remove_status_payload(job)


@router.get("/remove/status", response_model=BackgroundRemoverRemoveStatus)
def get_remove_status() -> BackgroundRemoverRemoveStatus:
    return _remove_status_payload(background_remover.get_job_status())


@router.post("/workspace/cleanup", response_model=BackgroundRemoverWorkspaceCleanupResponse)
def post_workspace_cleanup() -> BackgroundRemoverWorkspaceCleanupResponse:
    result = background_remover.cleanup_workspace()
    if not result.get("ok"):
        busy = any("진행 중" in str(error) for error in result.get("errors") or [])
        if busy:
            raise HTTPException(status_code=409, detail="; ".join(result.get("errors") or []))
    return BackgroundRemoverWorkspaceCleanupResponse(
        ok=bool(result.get("ok")),
        files_removed=int(result.get("files_removed") or 0),
        dirs_removed=int(result.get("dirs_removed") or 0),
        errors=list(result.get("errors") or []),
    )


def _resolve_media_path(raw: str) -> Path:
    cleaned = os.path.expandvars(os.path.expanduser(raw.strip().strip('"').strip("'")))
    path_obj = Path(cleaned)
    if not path_obj.is_absolute():
        path_obj = background_remover.WORKSPACE_ROOT / path_obj
    return path_obj.resolve()


def _normalize_image_suffix(path_obj: Path) -> str:
    suffix = path_obj.suffix.lower()
    if suffix == ".jfif":
        return ".jpeg"
    return suffix


def _open_local_image_for_preview(raw: str) -> Path:
    path_obj = _resolve_media_path(raw)
    if not path_obj.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"이미지 파일을 찾을 수 없습니다: {path_obj}",
        )
    suffix = _normalize_image_suffix(path_obj)
    if suffix not in background_remover.ALLOWED_IMAGE_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail=f"지원하지 않는 이미지 형식입니다: {path_obj.suffix}",
        )
    return path_obj


def _image_media_type(path_obj: Path) -> str:
    suffix = path_obj.suffix.lower()
    if suffix in {".jpg", ".jpeg", ".jfif"}:
        return "image/jpeg"
    if suffix == ".png":
        return "image/png"
    if suffix == ".webp":
        return "image/webp"
    if suffix == ".bmp":
        return "image/bmp"
    return "application/octet-stream"


@router.post("/preview")
def post_preview(body: BackgroundRemoverPreviewBody) -> FileResponse:
    path_obj = _open_local_image_for_preview(body.image_path)
    return FileResponse(
        path_obj,
        filename=path_obj.name,
        media_type=_image_media_type(path_obj),
    )


@router.get("/media/image")
def get_media_image(
    image_path: str | None = Query(None, description="로컬 이미지 절대 경로"),
    path: str | None = Query(None, description="image_path 별칭"),
) -> FileResponse:
    raw = (image_path or path or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="image_path 쿼리가 필요합니다.")
    path_obj = _open_local_image_for_preview(raw)
    return FileResponse(
        path_obj,
        filename=path_obj.name,
        media_type=_image_media_type(path_obj),
    )


@router.get("/download")
def get_download(
    file_path: str | None = Query(None, description="결과 파일 절대 경로"),
    path: str | None = Query(None, description="file_path 별칭"),
) -> FileResponse:
    raw = (file_path or path or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="file_path 쿼리가 필요합니다.")
    path_obj = _resolve_media_path(raw)
    if not background_remover.is_allowed_media_path(path_obj):
        raise HTTPException(status_code=400, detail="허용되지 않는 다운로드 경로입니다.")
    if not path_obj.is_file():
        raise HTTPException(status_code=404, detail="요청한 파일을 찾을 수 없습니다.")
    return FileResponse(
        path_obj,
        filename=path_obj.name,
        media_type=_image_media_type(path_obj),
    )
