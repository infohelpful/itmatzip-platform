"""Create-Music FastAPI 라우터 — ACE-Step 1.5 AI 음악 생성."""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from common.bin_manager import ensure_ffmpeg, get_ffmpeg_executable
from common.subprocess_util import run_hidden
from engines import create_music

try:
    from engines import create_music_lora
except Exception:
    create_music_lora = None  # type: ignore

router = APIRouter(prefix="/api/tools/create-music", tags=["create-music"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class GenerateRequest(BaseModel):
    task_type: str = "text2music"
    caption: str = ""
    lyrics: str = ""
    vocal_language: str = "ko"
    duration: float = -1.0
    bpm: Optional[int] = None
    keyscale: str = ""
    timesignature: str = ""
    batch_size: int = Field(default=1, ge=1, le=8)

    dit_model: str = "turbo"
    lm_model: str = "auto"
    inference_steps: int = Field(default=10, ge=1, le=200)
    guidance_scale: float = Field(default=5.0, ge=1.0, le=15.0)
    shift: float = Field(default=3.0, ge=1.0, le=5.0)
    seed: int = -1
    infer_method: str = "ode"
    audio_format: str = "wav"
    lora_name: Optional[str] = None

    src_audio_path: Optional[str] = None
    reference_audio_path: Optional[str] = None
    repainting_start: float = 0.0
    repainting_end: float = -1.0
    cover_strength: float = Field(default=1.0, ge=0.0, le=1.0)


# ---------------------------------------------------------------------------
# Readiness
# ---------------------------------------------------------------------------

@router.get("/readiness")
def get_readiness(quick: bool = False) -> dict:
    vram = create_music.detect_gpu_vram_mb()
    gpu_cfg = create_music.get_gpu_config(vram)
    if quick:
        deps = create_music.check_dependencies_fast()
        all_ready = create_music.all_dependencies_ready_fast()
    else:
        deps = create_music.check_dependencies()
        all_ready = create_music.all_dependencies_ready()
    recommended = create_music.recommend_models(vram)
    tier_info = create_music.gpu_config_for_api(gpu_cfg)

    try:
        from engines import create_music_acestep_runtime as ace_rt

        runtime = ace_rt.runtime_status()
    except Exception as exc:
        runtime = {"error": str(exc)}

    return {
        "ok": True,
        "tool": "create-music",
        "gpu": {
            "vram_mb": vram,
            "available": vram > 0,
            **tier_info,
        },
        "recommended": recommended,
        "dependencies": deps,
        "all_ready": all_ready,
        "runtime": runtime,
        "dit_models": tier_info["available_dit_models"],
        "lm_models": ["none", *tier_info["available_lm_models"]],
        "lora_list": _list_loras(),
    }


# ---------------------------------------------------------------------------
# Prepare
# ---------------------------------------------------------------------------

@router.post("/prepare")
def post_prepare(force: bool = False) -> dict:
    if create_music.is_prepare_running():
        state = create_music.get_prepare_state()
        return {"ok": True, "phase": state.phase, "progress": state.progress, "message": state.message}

    state = create_music.start_prepare(force=force)
    return {"ok": True, "phase": state.phase, "progress": state.progress, "message": state.message}


@router.get("/prepare/status")
def get_prepare_status() -> dict:
    state = create_music.get_prepare_state()
    return {
        "phase": state.phase,
        "progress": state.progress,
        "message": state.message,
        "error": state.error,
    }


# ---------------------------------------------------------------------------
# Generate
# ---------------------------------------------------------------------------

@router.post("/generate")
def post_generate(req: GenerateRequest) -> dict:
    if not create_music.all_dependencies_ready():
        raise HTTPException(status_code=503, detail="환경 준비가 필요합니다. '환경 준비' 버튼을 먼저 실행하세요.")

    params = create_music.GenerationParams(
        task_type=req.task_type,
        caption=req.caption,
        lyrics=req.lyrics,
        vocal_language=req.vocal_language,
        duration=req.duration,
        bpm=req.bpm,
        keyscale=req.keyscale,
        timesignature=req.timesignature,
        batch_size=req.batch_size,
        dit_model=req.dit_model,
        lm_model=req.lm_model,
        inference_steps=req.inference_steps,
        guidance_scale=req.guidance_scale,
        shift=req.shift,
        seed=req.seed,
        infer_method=req.infer_method,
        audio_format=req.audio_format,
        lora_name=req.lora_name,
        src_audio_path=req.src_audio_path,
        reference_audio_path=req.reference_audio_path,
        repainting_start=req.repainting_start,
        repainting_end=req.repainting_end,
        cover_strength=req.cover_strength,
    )

    try:
        job = create_music.start_generation(params)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))

    return {"ok": True, "job_id": job.id, "status": job.status}


@router.get("/generate/status")
def get_generate_status() -> dict:
    job = create_music.get_current_job()
    if not job:
        return {"status": "idle", "progress": 0, "message": "대기 중"}
    return {
        "job_id": job.id,
        "status": job.status,
        "progress": job.progress,
        "message": job.message,
        "output_paths": job.output_paths,
    }


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

@router.get("/result/{job_id}/{filename}")
def get_result_file(job_id: str, filename: str):
    file_path = _safe_history_file(job_id, filename)
    media_types = {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".flac": "audio/flac",
        ".opus": "audio/opus",
        ".aac": "audio/aac",
    }
    mt = media_types.get(file_path.suffix.lower(), "application/octet-stream")
    return FileResponse(str(file_path), media_type=mt, filename=filename)


def _safe_history_file(job_id: str, filename: str) -> Path:
    if ".." in job_id or ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="잘못된 경로입니다.")
    file_path = create_music.history_root() / job_id / filename
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    return file_path


@router.get("/download-mp3/{job_id}")
def download_mp3(job_id: str, filename: str = Query(..., min_length=1)) -> FileResponse:
    """생성된 WAV/FLAC 등을 ffmpeg로 MP3 변환 후 다운로드."""
    src = _safe_history_file(job_id, filename)
    if src.suffix.lower() == ".mp3":
        return FileResponse(str(src), media_type="audio/mpeg", filename=src.name)

    try:
        ensure_ffmpeg()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"FFmpeg 설치 필요: {exc}") from exc

    mp3_path = src.with_suffix(".mp3")
    if not mp3_path.is_file() or mp3_path.stat().st_mtime < src.stat().st_mtime:
        ffmpeg = get_ffmpeg_executable()
        proc = run_hidden(
            [
                str(ffmpeg),
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(src),
                "-codec:a",
                "libmp3lame",
                "-b:a",
                "192k",
                str(mp3_path),
            ],
            capture_output=True,
            text=True,
            timeout=600,
        )
        if proc.returncode != 0 or not mp3_path.is_file():
            err = (proc.stderr or proc.stdout or "ffmpeg 변환 실패")[-1500:]
            raise HTTPException(status_code=500, detail=err)

    dl_name = f"{src.stem}.mp3"
    return FileResponse(str(mp3_path), media_type="audio/mpeg", filename=dl_name)


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------

@router.get("/history")
def get_history(limit: int = 50) -> dict:
    items = create_music.list_history(limit=limit)
    return {"ok": True, "items": items}


# ---------------------------------------------------------------------------
# Audio upload (for remix/repaint)
# ---------------------------------------------------------------------------

@router.post("/upload-audio")
async def upload_audio(file: UploadFile = File(...)) -> dict:
    upload_dir = create_music.workspace_root() / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)

    filename = file.filename or "upload.wav"
    dest = upload_dir / filename
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)

    return {"ok": True, "path": str(dest), "filename": filename}


# ---------------------------------------------------------------------------
# LoRA
# ---------------------------------------------------------------------------

@router.get("/lora/list")
def get_lora_list() -> dict:
    details = create_music_lora.list_loras() if create_music_lora else []
    return {"ok": True, "loras": _list_loras(), "details": details}


class LoRATrainRequest(BaseModel):
    lora_name: str
    training_files: list[str] = []
    captions: list[str] = []
    training_steps: int = Field(default=1000, ge=100, le=10000)
    learning_rate: str = "1e-4"
    rank: int = Field(default=32, ge=4, le=128)
    dit_model: str = "turbo"


@router.post("/lora/train")
def post_lora_train(req: LoRATrainRequest) -> dict:
    raise HTTPException(
        status_code=501,
        detail="LoRA 학습은 ACE-Step Gradio UI의 'LoRA Training' 탭을 사용하세요. (웹 도구에서는 추후 지원 예정)",
    )


@router.get("/lora/status")
def get_lora_status() -> dict:
    if not create_music_lora:
        return {"id": "", "status": "idle", "progress": 0, "message": "", "current_step": 0, "total_steps": 0, "error": None}
    state = create_music_lora.get_training_state()
    return {
        "id": state.id,
        "status": state.status,
        "progress": state.progress,
        "message": state.message,
        "current_step": state.current_step,
        "total_steps": state.total_steps,
        "error": state.error,
    }


@router.delete("/lora/{name}")
def delete_lora(name: str) -> dict:
    if not create_music_lora:
        raise HTTPException(status_code=503, detail="LoRA 모듈을 사용할 수 없습니다.")
    ok = create_music_lora.delete_lora(name)
    if not ok:
        raise HTTPException(status_code=404, detail="LoRA를 찾을 수 없습니다.")
    return {"ok": True, "deleted": name}


def _list_loras() -> list[str]:
    root = create_music.lora_root()
    if not root.exists():
        return []
    return [d.name for d in root.iterdir() if d.is_dir()]
