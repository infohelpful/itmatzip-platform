"""Watermark Remover (ProPainter) FastAPI router — Magic Eraser 패턴."""

from __future__ import annotations

import os
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from common.bin_manager import ensure_ffmpeg
from engines import propainter_runtime, watermark_remover

router = APIRouter(prefix="/api/tools/watermark-remover", tags=["watermark-remover"])


class WatermarkRemoverPrepareStatus(BaseModel):
    phase: str
    progress: float
    message: str | None = None
    step: str | None = None
    detail: str | None = None


class WatermarkRemoverPreviewBody(BaseModel):
    video_path: str = Field(..., min_length=1, description="로컬 영상 절대 경로")


class WatermarkRemoverEraseBody(BaseModel):
    video_path: str = Field(..., description="로컬 영상 파일 절대 경로")
    mask_base64: str | None = Field(
        None,
        description="PNG/L(grayscale) base64 마스크. white(255)=지울 영역",
    )
    mask_path: str | None = Field(None, description="로컬 마스크 이미지 절대 경로")
    device: str | None = Field(None, description="'cpu' | 'cuda' | None=auto")
    timeout_sec: float = Field(7200.0, ge=60.0, le=14400.0)


class WatermarkRemoverBatchEraseBody(BaseModel):
    folder_path: str = Field(..., description="영상이 들어 있는 로컬 폴더 절대 경로")
    mask_base64: str = Field(
        ...,
        min_length=1,
        description="첫 영상에서 그린 PNG/L 마스크 base64. white(255)=지울 영역",
    )
    device: str | None = Field(None, description="'cpu' | 'cuda' | None=auto")
    timeout_sec: float = Field(
        7200.0,
        ge=60.0,
        le=14400.0,
        description="영상 1개당 타임아웃(초)",
    )


class WatermarkRemoverScanFolderBody(BaseModel):
    folder_path: str = Field(..., min_length=1, description="로컬 폴더 절대 경로")


class WatermarkRemoverEraseStatus(BaseModel):
    phase: str
    progress: float
    message: str | None = None
    original_path: str | None = None
    mask_path: str | None = None
    output_path: str | None = None
    preview_path: str | None = None
    original_preview_path: str | None = None
    width: int | None = None
    height: int | None = None
    batch: bool = False
    batch_total: int = 0
    batch_done: int = 0
    batch_failed: int = 0
    batch_output_dir: str | None = None
    folder_path: str | None = None


class WatermarkRemoverShowInFolderBody(BaseModel):
    path: str = Field(..., min_length=1, description="탐색기에서 열 파일 또는 폴더 경로")


class WatermarkRemoverWorkspaceCleanupResponse(BaseModel):
    ok: bool
    files_removed: int = 0
    dirs_removed: int = 0
    errors: list[str] = Field(default_factory=list)


_prepare_state = WatermarkRemoverPrepareStatus(
    phase="not_started",
    progress=0.0,
    message="Watermark Remover 준비를 시작하세요.",
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


def _get_prepare_state() -> WatermarkRemoverPrepareStatus:
    with _prepare_lock:
        return WatermarkRemoverPrepareStatus(
            phase=_prepare_state.phase,
            progress=_prepare_state.progress,
            message=_prepare_state.message,
            step=_prepare_state.step,
            detail=_prepare_state.detail,
        )


def _prepare_phase_for_step(step: str) -> str:
    lowered = step.lower()
    if "모델" in step or "model" in lowered or "propainter" in lowered or "소스" in step:
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
        watermark_remover.ensure_workspace()
        ensure_ffmpeg()

        _set_prepare_state(
            "installing_dependencies",
            5.0,
            "Watermark Remover 전용 Python 3.12 환경 설치 중…",
            step="설치 시작",
            detail="library-hub wheel · ProPainter",
        )
        bundle = watermark_remover.install_dependencies(on_progress=report)
        bundle_label = "GPU(CUDA)" if bundle == "gpu" else "CPU"
        cuda_note = "CUDA 사용 가능" if watermark_remover.is_cuda_available() else "CPU 모드"
        torch_ver = watermark_remover.installed_torch_version() or "?"

        _set_prepare_state(
            "downloading_models",
            58.0,
            "AI 모델 다운로드를 시작합니다…",
            step="AI 모델",
            detail="ProPainter 소스 · 가중치",
        )
        watermark_remover.download_models(on_progress=report)

        propainter_runtime.invalidate_torch_probe_cache()
        _set_prepare_state(
            "ready",
            100.0,
            "Watermark Remover 준비가 완료되었습니다.",
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
    try:
        planned = watermark_remover.select_torch_bundle()
        runtime = propainter_runtime.runtime_status_fast()
        python_path: str | None = None
        python_ver: str | None = None
        try:
            python_path = str(propainter_runtime.propainter_python())
            python_ver = watermark_remover.python_version()
        except Exception as exc:
            python_path = None
            python_ver = str(exc)

        runtime_fast = propainter_runtime.is_runtime_ready_fast()
        pip_stack = propainter_runtime.is_pip_stack_ready_fast()
        model_ready = watermark_remover.is_model_ready_fast()
        torch_ok = runtime_fast and (propainter_runtime.is_torch_installed() or model_ready)
        return {
            "ok": True,
            "tool": "watermark-remover",
            "runtime": runtime,
            "propainter_python": {
                "executable": python_path,
                "version": python_ver,
            },
            "pytorch": {
                "planned_bundle": planned,
                "installed_bundle": propainter_runtime.installed_torch_variant() if torch_ok else None,
                "gpu_detected": watermark_remover.has_nvidia_gpu(),
                "torch_version": watermark_remover.installed_torch_version() if torch_ok else None,
                "source": "library-hub watermark-remover-lib (wheel)",
            },
            "binaries": {
                "torch": torch_ok,
                "pip_stack": pip_stack,
                "model_ready": model_ready,
                "source_ready": propainter_runtime.is_source_ready(),
                "cuda_available": propainter_runtime.is_cuda_available_fast() if torch_ok else False,
            },
            "model": "ProPainter (raft + flow + inpaint)",
        }
    except Exception as exc:
        return {
            "ok": False,
            "tool": "watermark-remover",
            "error": str(exc),
            "pytorch": {"gpu_detected": watermark_remover.has_nvidia_gpu()},
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
        "tool": "watermark-remover",
        "model_ready": watermark_remover.is_model_ready_fast(),
        "allowed_suffixes": sorted(watermark_remover.ALLOWED_VIDEO_SUFFIXES),
    }


@router.post("/prepare")
def post_prepare(force: bool = Query(False)) -> dict[str, object]:
    global _prepare_thread
    with _prepare_lock:
        running = _prepare_thread is not None and _prepare_thread.is_alive()
        if running and not force:
            return {"ok": True, "started": False, "phase": _prepare_state.phase}
        if running and force:
            return {"ok": True, "started": False, "phase": _prepare_state.phase}
        _set_prepare_state(
            "installing_dependencies",
            1.0,
            "Watermark Remover 준비를 시작합니다…",
            step="시작",
        )
        _prepare_thread = threading.Thread(target=_run_prepare, daemon=True)
        _prepare_thread.start()
    return {"ok": True, "started": True, "phase": "installing_dependencies"}


@router.get("/prepare/status", response_model=WatermarkRemoverPrepareStatus)
def get_prepare_status() -> WatermarkRemoverPrepareStatus:
    return _get_prepare_state()


def _erase_status_payload(job: watermark_remover.EraseJobStatus) -> WatermarkRemoverEraseStatus:
    result = job.result
    summary = job.batch_summary
    folder_path = None
    if summary is not None:
        folder_path = str(summary.folder_path)
    return WatermarkRemoverEraseStatus(
        phase=job.phase,
        progress=job.progress,
        message=job.message,
        original_path=str(result.original_path) if result else None,
        mask_path=str(result.mask_path) if result else None,
        output_path=str(result.output_path) if result else None,
        preview_path=str(result.preview_path) if result else None,
        original_preview_path=str(result.original_preview_path) if result else None,
        width=result.width if result else None,
        height=result.height if result else None,
        batch=bool(job.batch),
        batch_total=int(job.batch_total or 0),
        batch_done=int(job.batch_done or 0),
        batch_failed=int(job.batch_failed or 0),
        batch_output_dir=str(job.batch_output_dir) if job.batch_output_dir else None,
        folder_path=folder_path,
    )


@router.post("/erase", response_model=WatermarkRemoverEraseStatus)
def post_erase(body: WatermarkRemoverEraseBody) -> WatermarkRemoverEraseStatus:
    path = Path(os.path.expandvars(os.path.expanduser(body.video_path.strip().strip('"').strip("'"))))
    if not watermark_remover.is_allowed_input_path(path):
        raise HTTPException(status_code=400, detail="지원하지 않는 영상 경로입니다.")
    mask_path = None
    if body.mask_path:
        mask_path = Path(os.path.expandvars(os.path.expanduser(body.mask_path.strip().strip('"').strip("'"))))
        if not watermark_remover.is_allowed_mask_path(mask_path):
            raise HTTPException(status_code=400, detail="지원하지 않는 마스크 경로입니다.")
    if not watermark_remover.is_model_ready():
        raise HTTPException(
            status_code=409,
            detail="Watermark Remover 환경이 준비되지 않았습니다. 「환경 준비」를 먼저 실행하세요.",
        )
    job = watermark_remover.start_erase_job(
        path,
        mask_path=mask_path,
        mask_base64=body.mask_base64,
        device=body.device,
        timeout_sec=body.timeout_sec,
    )
    return _erase_status_payload(job)


@router.post("/erase-batch", response_model=WatermarkRemoverEraseStatus)
def post_erase_batch(body: WatermarkRemoverBatchEraseBody) -> WatermarkRemoverEraseStatus:
    if body.device is not None and body.device not in {"cpu", "cuda"}:
        raise HTTPException(status_code=400, detail="device는 'cpu' 또는 'cuda' 이어야 합니다.")
    folder = Path(os.path.expandvars(os.path.expanduser(body.folder_path.strip().strip('"').strip("'"))))
    if not watermark_remover.is_allowed_folder_path(folder):
        raise HTTPException(status_code=400, detail=f"폴더를 찾을 수 없습니다: {folder}")
    if not watermark_remover.is_model_ready():
        raise HTTPException(
            status_code=409,
            detail="Watermark Remover 환경이 준비되지 않았습니다. 「환경 준비」를 먼저 실행하세요.",
        )
    try:
        job = watermark_remover.start_batch_erase_job(
            folder,
            mask_base64=body.mask_base64,
            device=body.device,
            timeout_sec=body.timeout_sec,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return _erase_status_payload(job)


@router.get("/erase/status", response_model=WatermarkRemoverEraseStatus)
def get_erase_status() -> WatermarkRemoverEraseStatus:
    return _erase_status_payload(watermark_remover.get_job_status())


@router.post("/scan-folder")
def post_scan_folder(body: WatermarkRemoverScanFolderBody) -> dict[str, object]:
    folder = Path(os.path.expandvars(os.path.expanduser(body.folder_path.strip().strip('"').strip("'"))))
    if not watermark_remover.is_allowed_folder_path(folder):
        raise HTTPException(status_code=400, detail=f"폴더를 찾을 수 없습니다: {folder}")
    try:
        videos = watermark_remover.list_folder_videos(folder)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    first = videos[0] if videos else None
    return {
        "ok": True,
        "folder_path": str(folder.resolve()),
        "count": len(videos),
        "videos": [str(path) for path in videos],
        "first_video": str(first) if first else None,
        "output_dir": str(watermark_remover.batch_output_dir_for(folder)),
        "allowed_suffixes": sorted(watermark_remover.ALLOWED_VIDEO_SUFFIXES),
    }


@router.post("/show-in-folder")
def post_show_in_folder(body: WatermarkRemoverShowInFolderBody) -> dict[str, object]:
    path_obj = Path(os.path.expandvars(os.path.expanduser(body.path.strip().strip('"').strip("'"))))
    try:
        watermark_remover.show_path_in_folder(path_obj)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"탐색기 열기 실패: {exc}") from None
    return {"ok": True, "path": str(path_obj.resolve())}


@router.post("/workspace/cleanup", response_model=WatermarkRemoverWorkspaceCleanupResponse)
def post_workspace_cleanup() -> WatermarkRemoverWorkspaceCleanupResponse:
    result = watermark_remover.cleanup_workspace()
    if not result.get("ok"):
        busy = any("진행 중" in str(error) for error in result.get("errors") or [])
        if busy:
            raise HTTPException(status_code=409, detail="; ".join(result.get("errors") or []))
    return WatermarkRemoverWorkspaceCleanupResponse(
        ok=bool(result.get("ok")),
        files_removed=int(result.get("files_removed") or 0),
        dirs_removed=int(result.get("dirs_removed") or 0),
        errors=list(result.get("errors") or []),
    )


def _resolve_media_path(raw: str) -> Path:
    cleaned = os.path.expandvars(os.path.expanduser(raw.strip().strip('"').strip("'")))
    path_obj = Path(cleaned)
    if not path_obj.is_absolute():
        path_obj = watermark_remover.WORKSPACE_ROOT / path_obj
    return path_obj.resolve()


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
    if suffix == ".mp4":
        return "video/mp4"
    if suffix == ".webm":
        return "video/webm"
    return "application/octet-stream"


@router.post("/preview")
def post_preview(body: WatermarkRemoverPreviewBody) -> FileResponse:
    path_obj = _resolve_media_path(body.video_path)
    if not watermark_remover.is_allowed_input_path(path_obj):
        raise HTTPException(status_code=400, detail="지원하지 않는 영상입니다.")
    try:
        frame = watermark_remover.extract_preview_frame(path_obj)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from None
    return FileResponse(frame, filename=frame.name, media_type="image/jpeg")


@router.get("/media/image")
def get_media_image(
    image_path: str | None = Query(None, description="로컬 이미지 절대 경로"),
    path: str | None = Query(None, description="image_path 별칭"),
) -> FileResponse:
    raw = (image_path or path or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="image_path 쿼리가 필요합니다.")
    path_obj = _resolve_media_path(raw)
    if not path_obj.is_file():
        raise HTTPException(status_code=404, detail="이미지 파일을 찾을 수 없습니다.")
    if not watermark_remover.is_allowed_media_path(path_obj):
        raise HTTPException(status_code=400, detail="허용되지 않는 경로입니다.")
    return FileResponse(
        path_obj,
        filename=path_obj.name,
        media_type=_image_media_type(path_obj),
    )


@router.get("/media/video")
def get_media_video(
    video_path: str | None = Query(None, description="로컬 영상 절대 경로"),
    path: str | None = Query(None, description="video_path 별칭"),
) -> FileResponse:
    raw = (video_path or path or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="video_path 쿼리가 필요합니다.")
    path_obj = _resolve_media_path(raw)
    if not path_obj.is_file():
        raise HTTPException(status_code=404, detail="영상 파일을 찾을 수 없습니다.")
    if not watermark_remover.is_allowed_media_path(path_obj):
        raise HTTPException(status_code=400, detail="허용되지 않는 경로입니다.")
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
    if not watermark_remover.is_allowed_media_path(path_obj):
        raise HTTPException(status_code=400, detail="허용되지 않는 다운로드 경로입니다.")
    if not path_obj.is_file():
        raise HTTPException(status_code=404, detail="요청한 파일을 찾을 수 없습니다.")
    return FileResponse(
        path_obj,
        filename=path_obj.name,
        media_type=_image_media_type(path_obj),
    )
