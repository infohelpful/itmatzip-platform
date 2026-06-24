"""Magic Canvas FastAPI router."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from engines import magic_canvas

router = APIRouter(prefix="/api/tools/magic-canvas", tags=["magic-canvas"])

MAX_CANVAS_SIDE = 16384


class PrepareStatus(BaseModel):
    phase: str
    progress: float
    message: str | None = None
    detail: str | None = None
    running: bool = False


class StageImageBody(BaseModel):
    image_path: str = Field(..., min_length=1, description="로컬 원본 이미지 절대 경로")


class StageImageResponse(BaseModel):
    status: str = "success"
    staged_path: str


class UploadMaskBody(BaseModel):
    mask_base64: str = Field(..., min_length=1, description="PNG 마스크 Base64 (data URL 허용)")


class UploadMaskResponse(BaseModel):
    status: str = "success"
    mask_path: str


class SubmitBody(BaseModel):
    action: Literal["outpaint", "remove", "compose"]
    image_path: str | None = None
    mask_path: str | None = None
    bg_image_path: str | None = None
    fg_image_path: str | None = None
    target_width: int | None = Field(None, ge=64, le=MAX_CANVAS_SIDE)
    target_height: int | None = Field(None, ge=64, le=MAX_CANVAS_SIDE)
    prompt: str | None = None
    x: int | None = None
    y: int | None = None
    fg_width: int | None = Field(None, ge=1, le=MAX_CANVAS_SIDE)
    fg_height: int | None = Field(None, ge=1, le=MAX_CANVAS_SIDE)


class SubmitResponse(BaseModel):
    status: str = "success"
    message: str = "작업이 시작되었습니다."


class JobStatusResponse(BaseModel):
    status: str
    progress: float
    message: str = ""
    output_path: str | None = None
    error: str | None = None
    action: str | None = None


class WorkspaceCleanupResponse(BaseModel):
    ok: bool
    files_removed: int = 0
    errors: list[str] = Field(default_factory=list)


class HfTokenBody(BaseModel):
    token: str = Field(..., min_length=8, description="Hugging Face Access Token (hf_...)")


class HfTokenResponse(BaseModel):
    ok: bool = True
    configured: bool = True


@router.get("/readiness")
def get_readiness(quick: bool = Query(False)) -> dict[str, Any]:
    data = magic_canvas.readiness_payload(quick=quick)
    if not data.get("gpu_detected"):
        data["ok"] = False
        data["message"] = "NVIDIA GPU가 감지되지 않았습니다. Magic Canvas는 GPU 전용입니다."
    return data


@router.post("/prepare")
def post_prepare(force: bool = Query(False)) -> dict[str, Any]:
    if magic_canvas.is_prepare_running():
        if force:
            magic_canvas.reset_prepare_for_force()
        else:
            state = magic_canvas.get_prepare_state()
            return {
                "ok": True,
                "phase": state.phase,
                "progress": state.progress,
                "message": state.message,
            }
    state = magic_canvas.start_prepare(force=force)
    return {
        "ok": True,
        "phase": state.phase,
        "progress": state.progress,
        "message": state.message,
    }


@router.get("/prepare/status")
def get_prepare_status() -> dict[str, Any]:
    state = magic_canvas.get_prepare_state()
    return {
        "phase": state.phase,
        "progress": state.progress,
        "message": state.message,
        "error": state.error,
    }


@router.post("/hf-token", response_model=HfTokenResponse)
def post_hf_token(body: HfTokenBody) -> HfTokenResponse:
    try:
        magic_canvas.save_hf_token(body.token)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return HfTokenResponse()


@router.post("/workspace/stage-image", response_model=StageImageResponse)
def post_stage_image(body: StageImageBody) -> StageImageResponse:
    try:
        staged = magic_canvas.stage_to_workspace(body.image_path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return StageImageResponse(staged_path=staged)


@router.post("/workspace/upload-mask", response_model=UploadMaskResponse)
def post_upload_mask(body: UploadMaskBody) -> UploadMaskResponse:
    try:
        mask_path = magic_canvas.save_mask_base64(body.mask_base64)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return UploadMaskResponse(mask_path=mask_path)


@router.post("/submit", response_model=SubmitResponse)
def post_submit(body: SubmitBody) -> SubmitResponse:
    if magic_canvas.is_job_busy():
        raise HTTPException(status_code=409, detail="다른 이미지 편집 작업이 진행 중입니다.")

    if not magic_canvas.try_acquire_gpu_lock():
        raise HTTPException(status_code=409, detail="다른 이미지 편집 작업이 진행 중입니다.")

    if not magic_canvas.readiness_payload(quick=True).get("gpu_detected"):
        magic_canvas.release_gpu_lock()
        raise HTTPException(status_code=503, detail="NVIDIA GPU가 필요합니다.")

    try:
        output_path = magic_canvas.new_output_path()
        payload: dict[str, Any] = {"output_path": output_path}

        if body.action == "outpaint":
            if not body.image_path or body.target_width is None or body.target_height is None:
                raise HTTPException(status_code=400, detail="outpaint: image_path, target_width, target_height 필요")
            img = magic_canvas.validate_workspace_file(body.image_path)
            payload.update(
                {
                    "image_path": str(img),
                    "target_width": body.target_width,
                    "target_height": body.target_height,
                    "prompt": body.prompt or "",
                }
            )
        elif body.action == "remove":
            if not body.image_path or not body.mask_path:
                raise HTTPException(status_code=400, detail="remove: image_path, mask_path 필요")
            img = magic_canvas.validate_workspace_file(body.image_path)
            mask = magic_canvas.validate_workspace_file(body.mask_path)
            payload.update({"image_path": str(img), "mask_path": str(mask)})
        elif body.action == "compose":
            if not body.bg_image_path or not body.fg_image_path:
                raise HTTPException(status_code=400, detail="compose: bg_image_path, fg_image_path 필요")
            if body.x is None or body.y is None or body.fg_width is None or body.fg_height is None:
                raise HTTPException(status_code=400, detail="compose: x, y, fg_width, fg_height 필요")
            bg = magic_canvas.validate_workspace_file(body.bg_image_path)
            fg = magic_canvas.validate_workspace_file(body.fg_image_path)
            payload.update(
                {
                    "bg_image_path": str(bg),
                    "fg_image_path": str(fg),
                    "x": body.x,
                    "y": body.y,
                    "fg_width": body.fg_width,
                    "fg_height": body.fg_height,
                    "prompt": body.prompt or "",
                }
            )
        else:
            raise HTTPException(status_code=400, detail="지원하지 않는 action")

        magic_canvas.build_worker_command(body.action, payload)
        magic_canvas.submit_job(body.action, payload)
    except HTTPException:
        magic_canvas.release_gpu_lock()
        raise
    except RuntimeError as exc:
        magic_canvas.release_gpu_lock()
        if "진행 중" in str(exc):
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except ValueError as exc:
        magic_canvas.release_gpu_lock()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        magic_canvas.release_gpu_lock()
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return SubmitResponse()


@router.get("/status", response_model=JobStatusResponse)
def get_status() -> JobStatusResponse:
    job = magic_canvas.get_current_job()
    return JobStatusResponse(
        status=job.status,
        progress=job.progress,
        message=job.message or "",
        output_path=job.output_path,
        error=job.error,
        action=job.action,
    )


@router.post("/workspace/cleanup", response_model=WorkspaceCleanupResponse)
def post_workspace_cleanup() -> WorkspaceCleanupResponse:
    result = magic_canvas.cleanup_workspace()
    if not result.get("ok") and result.get("errors"):
        busy = any("진행" in e for e in result.get("errors") or [])
        if busy:
            raise HTTPException(status_code=409, detail="; ".join(result["errors"]))
    return WorkspaceCleanupResponse(
        ok=bool(result.get("ok")),
        files_removed=int(result.get("files_removed") or 0),
        errors=list(result.get("errors") or []),
    )
