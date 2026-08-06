"""Voice Changer (Seed-VC) FastAPI router — Vocal Remover / Magic Eraser 패턴."""

from __future__ import annotations

import os
import shutil
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from common.bin_manager import FFMPEG_EXE, ensure_ffmpeg
from engines import seedvc_runtime, voice_changer

router = APIRouter(prefix="/api/tools/voice-changer", tags=["voice-changer"])


class VoiceChangerPrepareStatus(BaseModel):
    phase: str
    progress: float
    message: str | None = None
    step: str | None = None
    detail: str | None = None


class VoiceChangerConvertBody(BaseModel):
    source_path: str = Field(..., description="변환할 소스 음성 로컬 경로")
    reference_path: str = Field(..., description="목표 음색 레퍼런스 로컬 경로")
    format: str = Field("wav", description="출력 포맷 wav|mp3|flac")
    timeout_sec: float = Field(3600.0, ge=30.0, le=7200.0)
    device: str | None = Field(None, description="'cpu' | 'cuda' | None=auto")
    diffusion_steps: int = Field(25, ge=4, le=100)
    f0_condition: bool = Field(False, description="노래 변환 시 True")


class VoiceChangerConvertStatus(BaseModel):
    phase: str
    progress: float
    message: str | None = None
    source_path: str | None = None
    reference_path: str | None = None
    output_path: str | None = None
    duration_sec: float | None = None


class VoiceChangerWorkspaceCleanupResponse(BaseModel):
    ok: bool
    files_removed: int = 0
    dirs_removed: int = 0
    errors: list[str] = Field(default_factory=list)


_prepare_state = VoiceChangerPrepareStatus(
    phase="not_started",
    progress=0.0,
    message="Voice Changer 준비를 시작하세요.",
)
_prepare_lock = threading.RLock()
_prepare_thread: threading.Thread | None = None


def _ffmpeg_available() -> bool:
    try:
        if FFMPEG_EXE.is_file():
            return True
    except Exception:
        pass
    return shutil.which("ffmpeg") is not None


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


def _get_prepare_state() -> VoiceChangerPrepareStatus:
    with _prepare_lock:
        return VoiceChangerPrepareStatus(
            phase=_prepare_state.phase,
            progress=_prepare_state.progress,
            message=_prepare_state.message,
            step=_prepare_state.step,
            detail=_prepare_state.detail,
        )


def _prepare_phase_for_step(step: str) -> str:
    lowered = step.lower()
    if "ai 모델" in lowered or "checkpoint" in lowered or "huggingface" in lowered:
        return "downloading_models"
    if "모델" in step and "소스" not in step:
        return "downloading_models"
    if "model" in lowered and "소스" not in step:
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
            detail="최소 8GB 여유 권장 (Seed-VC + 모델)",
        )
        voice_changer.ensure_workspace()
        ensure_ffmpeg(download_timeout_sec=900.0)

        _set_prepare_state(
            "installing_dependencies",
            5.0,
            "Seed-VC 전용 Python 환경 설치 중…",
            step="설치 시작",
            detail="library-hub voice-changer-lib · Seed-VC",
        )
        bundle = voice_changer.install_dependencies(on_progress=report)
        bundle_label = "GPU(CUDA)" if bundle == "gpu" else "CPU"
        cuda_note = "CUDA 사용 가능" if voice_changer.is_cuda_available() else "CPU 모드"
        torch_ver = voice_changer.installed_torch_version() or "?"

        _set_prepare_state(
            "downloading_models",
            58.0,
            "AI 모델 다운로드를 시작합니다…",
            step="AI 모델",
            detail="library-hub seedvc-models.zip",
        )
        voice_changer.download_models(on_progress=report)

        seedvc_runtime.invalidate_torch_probe_cache()
        _set_prepare_state(
            "ready",
            100.0,
            "Voice Changer 준비가 완료되었습니다.",
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
        planned = voice_changer.select_torch_bundle()
        runtime = seedvc_runtime.runtime_status_fast()
        runtime_fast = seedvc_runtime.is_runtime_ready_fast()
        pip_stack = seedvc_runtime.is_pip_stack_ready_fast()
        model_ready = voice_changer.is_model_ready_fast()
        torch_ok = seedvc_runtime.is_torch_installed() or (runtime_fast and model_ready)
        return {
            "ok": True,
            "tool": "voice-changer",
            "runtime": runtime,
            "pytorch": {
                "planned_bundle": planned,
                "installed_bundle": seedvc_runtime.installed_torch_variant() if torch_ok else None,
                "gpu_detected": voice_changer.has_nvidia_gpu(),
                "torch_version": voice_changer.installed_torch_version() if torch_ok else None,
                "source": "library-hub voice-changer-lib (wheel)",
            },
            "models": {
                "seedvc_ready": seedvc_runtime.is_model_ready(),
                "model": "seedvc-models.zip (DiT speech)",
            },
            "binaries": {
                "ffmpeg": _ffmpeg_available(),
                "torch": torch_ok,
                "pip_stack": pip_stack,
                "source_ready": seedvc_runtime.is_seedvc_source_ready(),
                "model_ready": model_ready,
                "cuda_available": seedvc_runtime.is_cuda_available_fast() if torch_ok else False,
            },
        }
    except Exception as exc:
        return {
            "ok": False,
            "tool": "voice-changer",
            "error": str(exc),
            "binaries": {
                "ffmpeg": False,
                "torch": False,
                "pip_stack": False,
                "source_ready": False,
                "model_ready": False,
                "cuda_available": False,
            },
        }


@router.get("/status")
def get_status() -> dict[str, object]:
    return {
        "ok": True,
        "tool": "voice-changer",
        "model_ready": voice_changer.is_model_ready_fast(),
        "supported_formats": sorted(voice_changer.SUPPORTED_FORMATS),
        "allowed_suffixes": sorted(voice_changer.ALLOWED_AUDIO_SUFFIXES),
    }


@router.post("/prepare")
def post_prepare(
    force: bool = Query(False, description="ready여도 재준비"),
) -> VoiceChangerPrepareStatus:
    global _prepare_thread

    with _prepare_lock:
        if _prepare_thread is not None and _prepare_thread.is_alive():
            _prepare_state.detail = "설치가 이미 진행 중입니다."
            return _get_prepare_state()

        if (
            _prepare_state.phase == "ready"
            and not force
            and voice_changer.is_model_ready()
        ):
            return _get_prepare_state()

        _prepare_state.message = "Voice Changer 준비를 시작합니다…"
        _prepare_state.step = "설치 시작"
        _prepare_state.detail = "Seed-VC · PyTorch · 모델"
        _prepare_state.phase = "installing_dependencies"
        _prepare_state.progress = 5.0
        _prepare_thread = threading.Thread(target=_run_prepare, daemon=True)
        _prepare_thread.start()

    return _get_prepare_state()


@router.get("/prepare/status")
def get_prepare_status() -> VoiceChangerPrepareStatus:
    return _get_prepare_state()


def _convert_status_payload(job: voice_changer.ConvertJobStatus) -> VoiceChangerConvertStatus:
    result = job.result
    return VoiceChangerConvertStatus(
        phase=job.phase,
        progress=job.progress,
        message=job.message,
        source_path=str(result.source_path) if result else None,
        reference_path=str(result.reference_path) if result else None,
        output_path=str(result.output_path) if result else None,
        duration_sec=result.duration_sec if result else None,
    )


@router.post("/convert", response_model=VoiceChangerConvertStatus)
def post_convert(body: VoiceChangerConvertBody) -> VoiceChangerConvertStatus:
    if body.device is not None and body.device not in {"cpu", "cuda"}:
        raise HTTPException(status_code=400, detail="device는 'cpu' 또는 'cuda' 이어야 합니다.")
    fmt = body.format.lower().strip()
    if fmt not in voice_changer.SUPPORTED_FORMATS:
        raise HTTPException(
            status_code=400,
            detail=f"format은 {sorted(voice_changer.SUPPORTED_FORMATS)} 중 하나여야 합니다.",
        )

    source = Path(body.source_path)
    reference = Path(body.reference_path)
    if not source.is_file():
        raise HTTPException(status_code=400, detail=f"소스 파일을 찾을 수 없습니다: {source}")
    if not reference.is_file():
        raise HTTPException(status_code=400, detail=f"레퍼런스 파일을 찾을 수 없습니다: {reference}")
    if not voice_changer.is_allowed_input_path(source):
        raise HTTPException(status_code=400, detail="허용되지 않은 소스 경로입니다.")
    if not voice_changer.is_allowed_input_path(reference):
        raise HTTPException(status_code=400, detail="허용되지 않은 레퍼런스 경로입니다.")

    if not voice_changer.is_model_ready():
        raise HTTPException(
            status_code=503,
            detail=(
                "Voice Changer 환경이 준비되지 않았습니다. "
                "페이지에서 「환경 준비」를 완료한 뒤 다시 시도하세요. "
                "(Seed-VC + PyTorch + 모델)"
            ),
        )

    job = voice_changer.start_convert_job(
        source,
        reference,
        output_format=fmt,
        device=body.device,
        diffusion_steps=body.diffusion_steps,
        f0_condition=body.f0_condition,
        timeout_sec=body.timeout_sec,
    )
    return _convert_status_payload(job)


@router.get("/convert/status", response_model=VoiceChangerConvertStatus)
def get_convert_status() -> VoiceChangerConvertStatus:
    return _convert_status_payload(voice_changer.get_job_status())


@router.post("/workspace/cleanup", response_model=VoiceChangerWorkspaceCleanupResponse)
def post_workspace_cleanup() -> VoiceChangerWorkspaceCleanupResponse:
    result = voice_changer.cleanup_workspace()
    if not result.get("ok"):
        busy = any("진행 중" in str(error) for error in result.get("errors") or [])
        if busy:
            raise HTTPException(status_code=409, detail="; ".join(result.get("errors") or []))
    return VoiceChangerWorkspaceCleanupResponse(
        ok=bool(result.get("ok")),
        files_removed=int(result.get("files_removed") or 0),
        dirs_removed=int(result.get("dirs_removed") or 0),
        errors=list(result.get("errors") or []),
    )


def _resolve_media_path(raw: str) -> Path:
    cleaned = os.path.expandvars(os.path.expanduser(raw.strip().strip('"').strip("'")))
    path_obj = Path(cleaned)
    if not path_obj.is_absolute():
        path_obj = voice_changer.WORKSPACE_ROOT / path_obj
    return path_obj.resolve()


def _audio_media_type(path_obj: Path) -> str:
    suffix = path_obj.suffix.lower()
    if suffix == ".wav":
        return "audio/wav"
    if suffix == ".mp3":
        return "audio/mpeg"
    if suffix == ".flac":
        return "audio/flac"
    if suffix in {".m4a", ".aac"}:
        return "audio/mp4"
    if suffix == ".ogg":
        return "audio/ogg"
    return "application/octet-stream"


@router.get("/download")
def get_download(
    file_path: str | None = Query(None, description="결과 파일 절대 경로"),
    path: str | None = Query(None, description="file_path 별칭"),
) -> FileResponse:
    raw = (file_path or path or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="file_path 쿼리가 필요합니다.")
    path_obj = _resolve_media_path(raw)
    if not voice_changer.is_allowed_media_path(path_obj):
        raise HTTPException(status_code=400, detail="허용되지 않는 다운로드 경로입니다.")
    if not path_obj.is_file():
        raise HTTPException(status_code=404, detail="요청한 파일을 찾을 수 없습니다.")
    return FileResponse(
        path_obj,
        filename=path_obj.name,
        media_type=_audio_media_type(path_obj),
    )
