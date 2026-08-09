from __future__ import annotations

import os
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from engines import iopaint_runtime, magic_eraser

router = APIRouter(prefix="/api/tools/magic-eraser", tags=["magic-eraser"])


class MagicEraserPrepareStatus(BaseModel):
    phase: str
    progress: float
    message: str | None = None
    step: str | None = None
    detail: str | None = None


class MagicEraserPreviewBody(BaseModel):
    image_path: str = Field(..., min_length=1, description="로컬 이미지 절대 경로")


class MagicEraserEraseBody(BaseModel):
    image_path: str = Field(..., description="로컬 이미지 파일 절대 경로")
    mask_base64: str | None = Field(
        None,
        description="PNG/L(grayscale) base64 마스크. white(255)=지울 영역",
    )
    mask_path: str | None = Field(None, description="로컬 마스크 이미지 절대 경로")
    device: str | None = Field(None, description="'cpu' | 'cuda' | None=auto")
    timeout_sec: float = Field(1800.0, ge=30.0, le=7200.0)


class MagicEraserBatchEraseBody(BaseModel):
    folder_path: str = Field(..., description="이미지가 들어 있는 로컬 폴더 절대 경로")
    mask_base64: str = Field(
        ...,
        min_length=1,
        description="첫 이미지에서 그린 PNG/L 마스크 base64. white(255)=지울 영역",
    )
    device: str | None = Field(None, description="'cpu' | 'cuda' | None=auto")
    timeout_sec: float = Field(
        1800.0,
        ge=30.0,
        le=7200.0,
        description="이미지 1장당 타임아웃(초)",
    )


class MagicEraserScanFolderBody(BaseModel):
    folder_path: str = Field(..., min_length=1, description="로컬 폴더 절대 경로")


class MagicEraserShowInFolderBody(BaseModel):
    path: str = Field(..., min_length=1, description="탐색기에서 열 파일 또는 폴더 경로")


class MagicEraserEraseStatus(BaseModel):
    phase: str
    progress: float
    message: str | None = None
    original_path: str | None = None
    mask_path: str | None = None
    output_path: str | None = None
    width: int | None = None
    height: int | None = None
    batch: bool = False
    batch_total: int = 0
    batch_done: int = 0
    batch_failed: int = 0
    batch_output_dir: str | None = None
    folder_path: str | None = None


class MagicEraserWorkspaceCleanupResponse(BaseModel):
    ok: bool
    files_removed: int = 0
    dirs_removed: int = 0
    errors: list[str] = Field(default_factory=list)


_prepare_state = MagicEraserPrepareStatus(
    phase="not_started",
    progress=0.0,
    message="Magic Eraser 준비를 시작하세요.",
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


def _get_prepare_state() -> MagicEraserPrepareStatus:
    with _prepare_lock:
        return MagicEraserPrepareStatus(
            phase=_prepare_state.phase,
            progress=_prepare_state.progress,
            message=_prepare_state.message,
            step=_prepare_state.step,
            detail=_prepare_state.detail,
        )


def _prepare_phase_for_step(step: str) -> str:
    lowered = step.lower()
    if "모델" in step or "model" in lowered or "big-lama" in lowered:
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
            detail="최소 3GB 여유 권장",
        )
        magic_eraser.ensure_workspace()

        _set_prepare_state(
            "installing_dependencies",
            5.0,
            "Magic Eraser 전용 Python 3.12 환경 설치 중…",
            step="설치 시작",
            detail="library-hub wheel · LaMa 모델",
        )
        bundle = magic_eraser.install_dependencies(on_progress=report)
        bundle_label = "GPU(CUDA)" if bundle == "gpu" else "CPU"
        cuda_note = "CUDA 사용 가능" if magic_eraser.is_cuda_available() else "CPU 모드"
        torch_ver = magic_eraser.installed_torch_version() or "?"

        _set_prepare_state(
            "downloading_models",
            58.0,
            "AI 모델 다운로드를 시작합니다…",
            step="AI 모델",
            detail="LaMa (big-lama.pt)",
        )
        magic_eraser.download_models(on_progress=report)

        iopaint_runtime.invalidate_torch_probe_cache()
        _set_prepare_state(
            "ready",
            100.0,
            "Magic Eraser 준비가 완료되었습니다.",
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
        planned = magic_eraser.select_torch_bundle()
        runtime = iopaint_runtime.runtime_status_fast()
        python_path: str | None = None
        python_ver: str | None = None
        try:
            python_path = str(iopaint_runtime.iopaint_python())
            python_ver = magic_eraser.iopaint_python_version()
        except Exception as exc:
            python_path = None
            python_ver = str(exc)

        runtime_fast = iopaint_runtime.is_runtime_ready_fast()
        pip_stack = iopaint_runtime.is_pip_stack_ready_fast()
        model_ready = magic_eraser.is_model_ready_fast()
        if model_ready and not pip_stack:
            pip_stack = iopaint_runtime.is_pip_stack_ready()
        torch_ok = runtime_fast and (iopaint_runtime.is_torch_installed() or model_ready)
        return {
            "ok": True,
            "tool": "magic-eraser",
            "runtime": runtime,
            "iopaint_python": {
                "executable": python_path,
                "version": python_ver,
            },
            "pytorch": {
                "planned_bundle": planned,
                "installed_bundle": iopaint_runtime.installed_torch_variant() if torch_ok else None,
                "gpu_detected": magic_eraser.has_nvidia_gpu(),
                "torch_version": magic_eraser.installed_torch_version() if torch_ok else None,
                "source": "library-hub magic-eraser-lib (wheel)",
            },
            "models": {
                "lama_ready": iopaint_runtime.is_lama_model_ready(),
                "model": "big-lama.pt",
            },
            "binaries": {
                "torch": torch_ok,
                "pip_stack": pip_stack,
                "model_ready": model_ready,
                "cuda_available": iopaint_runtime.is_cuda_available_fast(),
            },
        }
    except Exception as exc:
        return {
            "ok": False,
            "tool": "magic-eraser",
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
        "tool": "magic-eraser",
        "model_ready": magic_eraser.is_model_ready_fast(),
        "allowed_suffixes": sorted(magic_eraser.ALLOWED_IMAGE_SUFFIXES),
    }


@router.post("/prepare")
def post_prepare(
    force: bool = Query(False, description="ready여도 재준비"),
) -> MagicEraserPrepareStatus:
    global _prepare_thread

    with _prepare_lock:
        if _prepare_thread is not None and _prepare_thread.is_alive():
            _prepare_state.detail = "설치가 이미 진행 중입니다."
            return _get_prepare_state()

        if (
            _prepare_state.phase == "ready"
            and not force
            and magic_eraser.is_model_ready()
        ):
            return _get_prepare_state()

        _prepare_state.message = "Magic Eraser 준비를 시작합니다…"
        _prepare_state.step = "설치 시작"
        _prepare_state.detail = "Python 3.12 · PyTorch · LaMa"
        _prepare_state.phase = "installing_dependencies"
        _prepare_state.progress = 5.0
        _prepare_thread = threading.Thread(target=_run_prepare, daemon=True)
        _prepare_thread.start()

    return _get_prepare_state()


@router.get("/prepare/status")
def get_prepare_status() -> MagicEraserPrepareStatus:
    return _get_prepare_state()


def _erase_status_payload(job: magic_eraser.EraseJobStatus) -> MagicEraserEraseStatus:
    result = job.result
    summary = job.batch_summary
    folder_path = None
    if summary is not None:
        folder_path = str(summary.folder_path)
    return MagicEraserEraseStatus(
        phase=job.phase,
        progress=job.progress,
        message=job.message,
        original_path=str(result.original_path) if result else None,
        mask_path=str(result.mask_path) if result else None,
        output_path=str(result.output_path) if result else None,
        width=result.width if result else None,
        height=result.height if result else None,
        batch=bool(job.batch),
        batch_total=int(job.batch_total or 0),
        batch_done=int(job.batch_done or 0),
        batch_failed=int(job.batch_failed or 0),
        batch_output_dir=str(job.batch_output_dir) if job.batch_output_dir else None,
        folder_path=folder_path,
    )


@router.post("/erase", response_model=MagicEraserEraseStatus)
def post_erase(body: MagicEraserEraseBody) -> MagicEraserEraseStatus:
    if body.device is not None and body.device not in {"cpu", "cuda"}:
        raise HTTPException(status_code=400, detail="device는 'cpu' 또는 'cuda' 이어야 합니다.")
    if not body.mask_base64 and not body.mask_path:
        raise HTTPException(status_code=400, detail="mask_base64 또는 mask_path 중 하나가 필요합니다.")

    path = Path(body.image_path)
    if not path.is_file():
        raise HTTPException(status_code=400, detail=f"파일을 찾을 수 없습니다: {path}")
    if not magic_eraser.is_allowed_input_path(path):
        raise HTTPException(status_code=400, detail="허용되지 않은 이미지 경로입니다.")

    mask_path: Path | None = None
    if body.mask_path:
        mask_path = Path(body.mask_path)
        if not mask_path.is_file():
            raise HTTPException(status_code=400, detail=f"마스크 파일을 찾을 수 없습니다: {mask_path}")
        if not magic_eraser.is_allowed_mask_path(mask_path):
            raise HTTPException(status_code=400, detail="허용되지 않은 마스크 경로입니다.")

    if not magic_eraser.is_model_ready():
        raise HTTPException(
            status_code=503,
            detail=(
                "Magic Eraser 환경이 준비되지 않았습니다. "
                "페이지에서 「환경 준비」를 완료한 뒤 다시 시도하세요. "
                "(PyTorch + LaMa 모델)"
            ),
        )

    job = magic_eraser.start_erase_job(
        path,
        mask_path=mask_path,
        mask_base64=body.mask_base64,
        device=body.device,
        timeout_sec=body.timeout_sec,
    )
    return _erase_status_payload(job)


@router.post("/erase-batch", response_model=MagicEraserEraseStatus)
def post_erase_batch(body: MagicEraserBatchEraseBody) -> MagicEraserEraseStatus:
    if body.device is not None and body.device not in {"cpu", "cuda"}:
        raise HTTPException(status_code=400, detail="device는 'cpu' 또는 'cuda' 이어야 합니다.")

    folder = Path(body.folder_path)
    if not magic_eraser.is_allowed_folder_path(folder):
        raise HTTPException(status_code=400, detail=f"폴더를 찾을 수 없습니다: {folder}")

    if not magic_eraser.is_model_ready():
        raise HTTPException(
            status_code=503,
            detail=(
                "Magic Eraser 환경이 준비되지 않았습니다. "
                "페이지에서 「환경 준비」를 완료한 뒤 다시 시도하세요. "
                "(PyTorch + LaMa 모델)"
            ),
        )

    try:
        job = magic_eraser.start_batch_erase_job(
            folder,
            mask_base64=body.mask_base64,
            device=body.device,
            timeout_sec=body.timeout_sec,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return _erase_status_payload(job)


@router.get("/erase/status", response_model=MagicEraserEraseStatus)
def get_erase_status() -> MagicEraserEraseStatus:
    return _erase_status_payload(magic_eraser.get_job_status())


@router.post("/scan-folder")
def post_scan_folder(body: MagicEraserScanFolderBody) -> dict[str, object]:
    folder = Path(body.folder_path)
    if not magic_eraser.is_allowed_folder_path(folder):
        raise HTTPException(status_code=400, detail=f"폴더를 찾을 수 없습니다: {folder}")
    try:
        images = magic_eraser.list_folder_images(folder)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    first = images[0] if images else None
    return {
        "ok": True,
        "folder_path": str(folder.resolve()),
        "count": len(images),
        "images": [str(path) for path in images],
        "first_image": str(first) if first else None,
        "output_dir": str(magic_eraser.batch_output_dir_for(folder)),
        "allowed_suffixes": sorted(magic_eraser.ALLOWED_IMAGE_SUFFIXES),
    }


@router.post("/show-in-folder")
def post_show_in_folder(body: MagicEraserShowInFolderBody) -> dict[str, object]:
    path_obj = Path(body.path)
    try:
        magic_eraser.show_path_in_folder(path_obj)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"탐색기 열기 실패: {exc}") from None
    return {"ok": True, "path": str(path_obj.resolve())}


@router.post("/workspace/cleanup", response_model=MagicEraserWorkspaceCleanupResponse)
def post_workspace_cleanup() -> MagicEraserWorkspaceCleanupResponse:
    result = magic_eraser.cleanup_workspace()
    if not result.get("ok"):
        busy = any("진행 중" in str(error) for error in result.get("errors") or [])
        if busy:
            raise HTTPException(status_code=409, detail="; ".join(result.get("errors") or []))
    return MagicEraserWorkspaceCleanupResponse(
        ok=bool(result.get("ok")),
        files_removed=int(result.get("files_removed") or 0),
        dirs_removed=int(result.get("dirs_removed") or 0),
        errors=list(result.get("errors") or []),
    )


def _resolve_media_path(raw: str) -> Path:
    cleaned = os.path.expandvars(os.path.expanduser(raw.strip().strip('"').strip("'")))
    path_obj = Path(cleaned)
    if not path_obj.is_absolute():
        path_obj = magic_eraser.WORKSPACE_ROOT / path_obj
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
    if suffix not in magic_eraser.ALLOWED_IMAGE_SUFFIXES:
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
def post_preview(body: MagicEraserPreviewBody) -> FileResponse:
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
    if not magic_eraser.is_allowed_media_path(path_obj):
        raise HTTPException(status_code=400, detail="허용되지 않는 다운로드 경로입니다.")
    if not path_obj.is_file():
        raise HTTPException(status_code=404, detail="요청한 파일을 찾을 수 없습니다.")
    return FileResponse(
        path_obj,
        filename=path_obj.name,
        media_type=_image_media_type(path_obj),
    )
