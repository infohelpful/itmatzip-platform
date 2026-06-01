from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from engines import codeformer_runtime, image_enhancer

router = APIRouter(prefix="/api/tools/image-enhancer", tags=["image-enhancer"])


class ImageEnhancerPrepareStatus(BaseModel):
    phase: str
    progress: float
    message: str | None = None
    step: str | None = None
    detail: str | None = None


class ImageEnhancerPreviewBody(BaseModel):
    image_path: str = Field(..., min_length=1, description="로컬 이미지 절대 경로")


class ImageEnhancerEnhanceBody(BaseModel):
    image_path: str = Field(..., description="로컬 이미지 파일 절대 경로")
    fidelity: float = Field(0.7, ge=0.0, le=1.0, description="CodeFormer fidelity weight (w)")
    upscale: int = Field(1, ge=1, le=4)
    background_enhance: bool = False
    bg_tile: int = Field(400, ge=128, le=1024, description="RealESRGAN 타일 크기 (작을수록 품질↑·느림)")
    only_center_face: bool = False
    face_upsample: bool = True
    output_format: str = Field("png", description="png | jpg | jpeg")
    jpg_quality: int = Field(95, ge=60, le=100)
    device: str | None = Field(None, description="'cpu' | 'cuda' | None=auto")
    timeout_sec: float = Field(1800.0, ge=30.0, le=7200.0)


class ImageEnhancerEnhanceStatus(BaseModel):
    phase: str
    progress: float
    message: str | None = None
    result_path: str | None = None
    original_path: str | None = None
    width: int | None = None
    height: int | None = None


class ImageEnhancerWorkspaceCleanupResponse(BaseModel):
    ok: bool
    files_removed: int = 0
    dirs_removed: int = 0
    errors: list[str] = Field(default_factory=list)


_prepare_state = ImageEnhancerPrepareStatus(
    phase="not_started",
    progress=0.0,
    message="Image Enhancer 준비를 시작하세요.",
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


def _get_prepare_state() -> ImageEnhancerPrepareStatus:
    with _prepare_lock:
        return ImageEnhancerPrepareStatus(
            phase=_prepare_state.phase,
            progress=_prepare_state.progress,
            message=_prepare_state.message,
            step=_prepare_state.step,
            detail=_prepare_state.detail,
        )


def _prepare_phase_for_step(step: str) -> str:
    lowered = step.lower()
    if "모델" in step or "model" in lowered or "codeformer.pth" in lowered:
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
            detail="최소 8GB 여유 권장",
        )
        image_enhancer.ensure_workspace()

        _set_prepare_state(
            "installing_dependencies",
            5.0,
            "CodeFormer 전용 Python 3.12 환경 설치 중…",
            step="설치 시작",
            detail="library-hub wheel · CodeFormer 소스 · 모델",
        )
        bundle = image_enhancer.install_dependencies(on_progress=report)
        bundle_label = "GPU(CUDA)" if bundle == "gpu" else "CPU"
        cuda_note = "CUDA 사용 가능" if image_enhancer.is_cuda_available() else "CPU 모드"
        torch_ver = image_enhancer.installed_torch_version() or "?"

        _set_prepare_state(
            "downloading_models",
            70.0,
            "AI 모델 다운로드를 시작합니다…",
            step="AI 모델",
            detail="codeformer.pth · RealESRGAN_x2plus.pth",
        )
        image_enhancer.download_models(on_progress=report)

        codeformer_runtime.invalidate_torch_probe_cache()
        _set_prepare_state(
            "ready",
            100.0,
            "Image Enhancer 준비가 완료되었습니다.",
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
        planned = image_enhancer.select_torch_bundle()
        runtime = codeformer_runtime.runtime_status_fast()
        cf_python: str | None = None
        cf_py_ver: str | None = None
        try:
            cf_python = str(codeformer_runtime.venv_python())
            cf_py_ver = image_enhancer.codeformer_python_version()
        except Exception as exc:
            cf_python = None
            cf_py_ver = str(exc)

        venv_fast = codeformer_runtime.is_venv_ready_fast()
        vendor_ready = image_enhancer.is_codeformer_vendor_ready()
        model_ready = image_enhancer.is_model_ready_fast()
        # basicsr는 vendor/CodeFormer/basicsr 에 있음 (PyPI basicsr 제거됨)
        pip_stack = codeformer_runtime.is_pip_stack_ready_fast(
            vendor_root=image_enhancer.VENDOR_ROOT,
        )
        if model_ready and not pip_stack:
            pip_stack = codeformer_runtime.is_pip_stack_ready(
                vendor_root=image_enhancer.VENDOR_ROOT,
            )
        torch_ok = venv_fast and (
            codeformer_runtime.is_torch_installed() or model_ready
        )
        return {
            "ok": True,
            "tool": "image-enhancer",
            "runtime": runtime,
            "codeformer_python": {
                "executable": cf_python,
                "version": cf_py_ver,
            },
            "pytorch": {
                "planned_bundle": planned,
                "installed_bundle": codeformer_runtime.installed_torch_variant()
                if torch_ok
                else None,
                "gpu_detected": image_enhancer.has_nvidia_gpu(),
                "torch_version": image_enhancer.installed_torch_version()
                if torch_ok
                else None,
                "source": "library-hub image-enhancer-lib (wheel)",
            },
            "binaries": {
                "torch": torch_ok,
                "pip_stack": pip_stack,
                "vendor_ready": vendor_ready,
                "model_ready": model_ready,
                "cuda_available": codeformer_runtime.is_cuda_available_fast(),
            },
        }
    except Exception as exc:
        return {
            "ok": False,
            "tool": "image-enhancer",
            "error": str(exc),
            "binaries": {
                "torch": False,
                "pip_stack": False,
                "vendor_ready": image_enhancer.is_codeformer_vendor_ready(),
                "model_ready": False,
                "cuda_available": False,
            },
        }


@router.get("/status")
def get_status() -> dict[str, object]:
    return {
        "ok": True,
        "tool": "image-enhancer",
        "model_ready": image_enhancer.is_model_ready_fast(),
        "supported_formats": ["png", "jpg", "jpeg"],
        "allowed_suffixes": sorted(image_enhancer.ALLOWED_IMAGE_SUFFIXES),
    }


@router.post("/prepare")
def post_prepare(
    force: bool = Query(False, description="ready여도 재준비"),
) -> ImageEnhancerPrepareStatus:
    global _prepare_thread

    with _prepare_lock:
        if _prepare_thread is not None and _prepare_thread.is_alive():
            _prepare_state.detail = "설치가 이미 진행 중입니다."
            return _get_prepare_state()

        if _prepare_state.phase == "ready" and not force and image_enhancer.is_model_ready():
            return _get_prepare_state()

        _prepare_state.message = "Image Enhancer 준비를 시작합니다…"
        _prepare_state.step = "설치 시작"
        _prepare_state.detail = "Python 3.12 · PyTorch · CodeFormer · 모델"
        _prepare_state.phase = "installing_dependencies"
        _prepare_state.progress = 5.0
        _prepare_thread = threading.Thread(target=_run_prepare, daemon=True)
        _prepare_thread.start()

    return _get_prepare_state()


@router.get("/prepare/status")
def get_prepare_status() -> ImageEnhancerPrepareStatus:
    return _get_prepare_state()


def _enhance_status_payload(job: image_enhancer.EnhanceJobStatus) -> ImageEnhancerEnhanceStatus:
    result = job.result
    return ImageEnhancerEnhanceStatus(
        phase=job.phase,
        progress=job.progress,
        message=job.message,
        result_path=str(result.result_path) if result else None,
        original_path=str(result.original_path) if result else None,
        width=result.width if result else None,
        height=result.height if result else None,
    )


@router.post("/enhance", response_model=ImageEnhancerEnhanceStatus)
def post_enhance(body: ImageEnhancerEnhanceBody) -> ImageEnhancerEnhanceStatus:
    fmt = body.output_format.lower()
    if fmt not in image_enhancer.SUPPORTED_OUTPUT_FORMATS:
        raise HTTPException(status_code=400, detail="지원되지 않는 출력 포맷입니다.")
    if body.device is not None and body.device not in {"cpu", "cuda"}:
        raise HTTPException(status_code=400, detail="device는 'cpu' 또는 'cuda' 이어야 합니다.")

    path = Path(body.image_path)
    if not path.is_file():
        raise HTTPException(status_code=400, detail=f"파일을 찾을 수 없습니다: {path}")
    if not image_enhancer.is_allowed_input_path(path):
        raise HTTPException(status_code=400, detail="허용되지 않은 이미지 경로입니다.")

    if not image_enhancer.is_model_ready():
        raise HTTPException(
            status_code=503,
            detail="CodeFormer 환경이 준비되지 않았습니다. 먼저 /prepare를 호출하세요.",
        )

    job = image_enhancer.start_enhance_job(
        path,
        fidelity=body.fidelity,
        upscale=body.upscale,
        background_enhance=body.background_enhance,
        only_center_face=body.only_center_face,
        face_upsample=body.face_upsample,
        output_format=fmt,
        jpg_quality=body.jpg_quality,
        device=body.device,
        bg_tile=body.bg_tile,
        timeout_sec=body.timeout_sec,
    )
    return _enhance_status_payload(job)


@router.get("/enhance/status", response_model=ImageEnhancerEnhanceStatus)
def get_enhance_status() -> ImageEnhancerEnhanceStatus:
    return _enhance_status_payload(image_enhancer.get_enhance_job_status())


@router.post("/workspace/cleanup", response_model=ImageEnhancerWorkspaceCleanupResponse)
def post_workspace_cleanup() -> ImageEnhancerWorkspaceCleanupResponse:
    result = image_enhancer.cleanup_workspace()
    if not result.get("ok"):
        busy = any("진행 중" in str(e) for e in result.get("errors") or [])
        if busy:
            raise HTTPException(status_code=409, detail="; ".join(result.get("errors") or []))
    return ImageEnhancerWorkspaceCleanupResponse(
        ok=bool(result.get("ok")),
        files_removed=int(result.get("files_removed") or 0),
        dirs_removed=int(result.get("dirs_removed") or 0),
        errors=list(result.get("errors") or []),
    )


def _resolve_media_path(raw: str) -> Path:
    cleaned = os.path.expandvars(os.path.expanduser(raw.strip().strip('"').strip("'")))
    path_obj = Path(cleaned)
    if not path_obj.is_absolute():
        path_obj = image_enhancer.WORKSPACE_ROOT / path_obj
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
    if suffix not in image_enhancer.ALLOWED_IMAGE_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail=f"지원하지 않는 이미지 형식입니다: {path_obj.suffix}",
        )
    return path_obj


def _image_media_type(path_obj: Path) -> str:
    suffix = path_obj.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".png":
        return "image/png"
    if suffix == ".webp":
        return "image/webp"
    if suffix == ".gif":
        return "image/gif"
    if suffix == ".bmp":
        return "image/bmp"
    if suffix == ".jfif":
        return "image/jpeg"
    return "application/octet-stream"


@router.post("/preview")
def post_preview(body: ImageEnhancerPreviewBody) -> FileResponse:
    """브라우저 원본 미리보기 — 경로를 JSON 본문으로 전달 (Windows·한글 경로 안전)."""
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
    """브라우저 원본 미리보기 — GET (레거시)."""
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
    if not image_enhancer.is_allowed_media_path(path_obj):
        raise HTTPException(status_code=400, detail="허용되지 않는 다운로드 경로입니다.")
    if not path_obj.is_file():
        raise HTTPException(status_code=404, detail="요청한 파일을 찾을 수 없습니다.")
    return FileResponse(
        path_obj,
        filename=path_obj.name,
        media_type=_image_media_type(path_obj),
    )
