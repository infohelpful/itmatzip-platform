from __future__ import annotations

import subprocess
import threading
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from common.async_io import run_sync
import shutil

from common.bin_manager import FFMPEG_EXE, FFPROBE_EXE, ensure_ffmpeg


def _ffmpeg_available() -> bool:
    if FFMPEG_EXE.is_file():
        return True
    return shutil.which("ffmpeg") is not None


def _ffprobe_available() -> bool:
    if FFPROBE_EXE.is_file():
        return True
    return shutil.which("ffprobe") is not None
from common.pick_local_file import behind_go_proxy, run_audio_pick_dialog
from engines import silence_remover as silence_remover_engine
from engines import vocal_remover
from runtime_paths import pick_audio_available

router = APIRouter(prefix="/api/tools/vocal-remover", tags=["vocal-remover"])


def _ensure_vocal_remover_environment() -> None:
    """Vocal Remover가 필요로 하는 FFmpeg 등 로컬 바이너리를 준비합니다."""
    ensure_ffmpeg()


VocalRemoverReady = Annotated[None, Depends(_ensure_vocal_remover_environment)]


class VocalRemoverPrepareStatus(BaseModel):
    phase: str
    progress: float
    message: str | None = None
    step: str | None = None
    detail: str | None = None


class VocalRemoverSeparateBody(BaseModel):
    audio_path: str = Field(..., description="로컬 오디오 파일 절대/상대 경로")
    format: str = Field(..., description="다운로드용 MR 출력 포맷")
    timeout_sec: float = Field(3600.0, ge=10.0, le=7200.0)
    device: str | None = Field(None, description="실행 장치: 'cpu' 또는 'cuda' (미지정 시 자동)")


class VocalRemoverSeparateStatus(BaseModel):
    phase: str
    progress: float
    message: str | None = None
    result_path: str | None = None
    instrumental_path: str | None = None
    vocals_path: str | None = None
    original_path: str | None = None
    duration_sec: float | None = None


class VocalRemoverWaveformPeaksBody(BaseModel):
    audio_path: str = Field(..., description="로컬 오디오 파일 경로")
    timeout_sec: float = Field(900.0, ge=10.0, le=3600.0)
    pixels_per_second: float = Field(80.0, ge=1.0, le=120.0)
    max_waveform_width: int = Field(34000, ge=400, le=40000)


class VocalRemoverSeparateResponse(BaseModel):
    result_path: str
    instrumental_path: str
    vocals_path: str
    original_path: str
    duration_sec: float
    message: str


_prepare_state = VocalRemoverPrepareStatus(
    phase="not_started",
    progress=0.0,
    message="Vocal Remover 준비를 시작하세요.",
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


def _get_prepare_state() -> VocalRemoverPrepareStatus:
    with _prepare_lock:
        return VocalRemoverPrepareStatus(
            phase=_prepare_state.phase,
            progress=_prepare_state.progress,
            message=_prepare_state.message,
            step=_prepare_state.step,
            detail=_prepare_state.detail,
        )


def _prepare_phase_for_step(step: str) -> str:
    lowered = step.lower()
    if "모델" in step or "model" in lowered:
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
            "FFmpeg 확인 중…",
            step="FFmpeg",
            detail="없으면 다운로드합니다 (최초 1회)",
        )
        ensure_ffmpeg(download_timeout_sec=900.0)

        _set_prepare_state(
            "installing_dependencies",
            5.0,
            "Demucs·diffq 환경 확인 중…",
            step="환경 확인",
            detail="설치된 패키지·GPU·wheel 번들을 점검합니다",
        )
        vocal_remover.ensure_workspace()

        if not vocal_remover.is_demucs_installed():
            installed = vocal_remover.install_dependencies(on_progress=report)
            bundle_label = "GPU(CUDA)" if installed == "gpu" else "CPU"
        elif vocal_remover.needs_cpu_torch_reinstall():
            report(
                8.0,
                "CPU wheel 교체",
                "PyTorch CUDA(+cu) 빌드를 CPU wheel로 교체합니다 (GPU 미감지)",
            )
            vocal_remover.reinstall_cpu_torch_wheels(on_progress=report)
            bundle_label = "CPU"
        elif vocal_remover.needs_cuda_torch_reinstall():
            report(
                8.0,
                "CUDA wheel 교체",
                "PyTorch CPU(+cpu) 빌드를 GPU(CUDA) wheel로 교체합니다",
            )
            vocal_remover.reinstall_cuda_torch_wheels(on_progress=report)
            bundle_label = "GPU(CUDA)"
        else:
            bundle = vocal_remover.installed_torch_wheel_variant() or vocal_remover.select_wheel_bundle()
            bundle_label = "GPU(CUDA)" if bundle == "gpu" else "CPU"
        torch_ver = vocal_remover.installed_torch_version() or "?"
        cuda_note = "CUDA 사용 가능" if vocal_remover.is_cuda_available() else "CPU 모드"
        _set_prepare_state(
            "installing_dependencies",
            82.0,
            f"라이브러리 설치 완료 ({bundle_label} · torch {torch_ver} · {cuda_note})",
            step="라이브러리 설치 완료",
            detail=f"{bundle_label} · torch {torch_ver} · {cuda_note}",
        )

        _set_prepare_state(
            "downloading_models",
            84.0,
            "AI 모델 다운로드를 시작합니다…",
            step="AI 모델",
            detail=f"Demucs pretrained 모델({vocal_remover.MODEL_NAME})",
        )

        def model_report(pct: float, step: str, detail: str = "") -> None:
            message = f"{step} — {detail}" if detail else step
            _set_prepare_state("downloading_models", pct, message, step=step, detail=detail or None)

        try:
            vocal_remover.download_models(on_progress=model_report)
            _set_prepare_state(
                "ready",
                100.0,
                "Vocal Remover 준비가 완료되었습니다.",
                step="완료",
                detail=cuda_note,
            )
            return
        except NotImplementedError:
            _set_prepare_state(
                "ready",
                100.0,
                "Demucs 설치가 완료되었습니다. 모델은 첫 분리 시 자동으로 다운로드됩니다.",
                step="완료",
                detail="모델은 첫 분리 시 자동 다운로드",
            )
            return
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
    """
    Vocal Remover 페이지 진입 시 바이너리·모델 존재만 확인합니다.
    다운로드·설치는 POST /prepare 에서 수행합니다.
    """
    planned = vocal_remover.select_wheel_bundle()
    installed = vocal_remover.installed_torch_wheel_variant()
    return {
        "ok": True,
        "tool": "vocal-remover",
        "wheels": {
            "planned_bundle": planned,
            "installed_bundle": installed,
            "gpu_detected": vocal_remover.has_nvidia_gpu(),
            "cuda_torch_reinstall_needed": vocal_remover.needs_cuda_torch_reinstall(),
            "cpu_torch_reinstall_needed": vocal_remover.needs_cpu_torch_reinstall(),
            "torch_version": vocal_remover.installed_torch_version(),
        },
        "binaries": {
            "ffmpeg": _ffmpeg_available(),
            "ffprobe": _ffprobe_available(),
            "demucs": vocal_remover.is_demucs_installed(),
            "diffq": vocal_remover._is_diffq_installed(),
            "model_ready": vocal_remover.is_model_ready(),
            "cuda_available": vocal_remover.is_cuda_available(),
        },
    }


@router.get("/status")
def get_status() -> dict[str, object]:
    return {
        "ok": True,
        "tool": "vocal-remover",
        "demucs_installed": vocal_remover.is_demucs_installed(),
        "model_ready": vocal_remover.is_model_ready(),
        "supported_formats": ["wav", "mp3", "flac"],
    }


@router.post("/pick-local-file")
def post_pick_local_file() -> dict[str, str]:
    if behind_go_proxy():
        raise HTTPException(
            status_code=503,
            detail="브라우저에서는 POST /api/agent/pick-local-audio-file 을 사용하세요.",
        )
    if not pick_audio_available():
        raise HTTPException(status_code=500, detail="파일 선택 기능을 사용할 수 없습니다.")
    try:
        path = run_audio_pick_dialog(timeout=600)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="파일 선택 대화상자 시간 초과") from None
    except RuntimeError as exc:
        msg = str(exc)
        if "tkinter" in msg.lower():
            raise HTTPException(status_code=501, detail=msg) from exc
        raise HTTPException(status_code=500, detail=msg) from exc
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    path = str(path or "").strip()
    if not path:
        raise HTTPException(status_code=400, detail="파일 선택이 취소되었습니다.")

    if not Path(path).is_file():
        raise HTTPException(status_code=400, detail=f"선택한 경로에 파일이 없습니다: {path}")

    suffix = Path(path).suffix.lower()
    if suffix and suffix not in vocal_remover.ALLOWED_AUDIO_SUFFIXES:
        raise HTTPException(status_code=400, detail=f"지원되지 않는 오디오 형식입니다: {suffix}")

    return {"video_path": path, "audio_path": path}


@router.post("/waveform-peaks")
async def post_waveform_peaks(body: VocalRemoverWaveformPeaksBody, _: VocalRemoverReady) -> dict[str, object]:
    path = Path(body.audio_path)
    if not path.is_file():
        raise HTTPException(status_code=400, detail=f"파일을 찾을 수 없습니다: {path}")
    try:
        return await run_sync(
            silence_remover_engine.build_waveform_peaks_payload,
            path,
            timeout_sec=body.timeout_sec,
            pixels_per_second=body.pixels_per_second,
            max_waveform_width=body.max_waveform_width,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/prepare")
def post_prepare(
    force: bool = Query(False, description="이미 ready여도 CUDA wheel 등 재준비 강제"),
) -> VocalRemoverPrepareStatus:
    global _prepare_thread

    with _prepare_lock:
        if _prepare_thread is not None and _prepare_thread.is_alive():
            _prepare_state.detail = (
                "GPU wheel 다운로드·설치가 이미 진행 중입니다. 진행률을 계속 갱신합니다."
            )
            return _get_prepare_state()

        cuda_fixup = vocal_remover.needs_cuda_torch_reinstall()
        cpu_fixup = vocal_remover.needs_cpu_torch_reinstall()
        if _prepare_state.phase == "ready" and not force and not cuda_fixup and not cpu_fixup:
            return _get_prepare_state()

        if cpu_fixup:
            _prepare_state.message = "CPU PyTorch wheel 설치를 시작합니다…"
            _prepare_state.step = "설치 시작"
            _prepare_state.detail = "CUDA 빌드를 CPU wheel로 교체합니다 (wheel.zip)"
        elif cuda_fixup:
            _prepare_state.message = "GPU(CUDA) PyTorch wheel 설치를 시작합니다…"
            _prepare_state.step = "설치 시작"
            _prepare_state.detail = "wheels_gpu.zip 분할 파일을 다운로드합니다"
        else:
            _prepare_state.message = "Vocal Remover 준비를 시작합니다…"
            _prepare_state.step = "설치 시작"
            _prepare_state.detail = "Demucs·diffq·PyTorch wheel 준비"
        _prepare_state.phase = "installing_dependencies"
        _prepare_state.progress = 5.0
        _prepare_thread = threading.Thread(target=_run_prepare, daemon=True)
        _prepare_thread.start()

    return _get_prepare_state()


@router.get("/prepare/status")
def get_prepare_status() -> VocalRemoverPrepareStatus:
    return _get_prepare_state()


def _separate_status_payload(job: vocal_remover.SeparationJobStatus) -> VocalRemoverSeparateStatus:
    result = job.result
    return VocalRemoverSeparateStatus(
        phase=job.phase,
        progress=job.progress,
        message=job.message,
        result_path=str(result.export_path) if result else None,
        instrumental_path=str(result.instrumental_path) if result else None,
        vocals_path=str(result.vocals_path) if result else None,
        original_path=str(result.original_path) if result else None,
        duration_sec=float(result.duration_sec) if result else None,
    )


@router.post("/separate", response_model=VocalRemoverSeparateStatus)
def post_separate(body: VocalRemoverSeparateBody, _: VocalRemoverReady) -> VocalRemoverSeparateStatus:
    if body.format not in {"wav", "mp3", "flac"}:
        raise HTTPException(status_code=400, detail="지원되지 않는 출력 포맷입니다.")
    if body.device is not None and body.device not in {"cpu", "cuda"}:
        raise HTTPException(status_code=400, detail="device는 'cpu' 또는 'cuda' 이어야 합니다.")

    path = Path(body.audio_path)
    if not path.is_file():
        raise HTTPException(status_code=400, detail=f"파일을 찾을 수 없습니다: {path}")

    if not vocal_remover.is_demucs_installed():
        raise HTTPException(status_code=503, detail="Demucs 패키지가 설치되지 않았습니다. 먼저 /prepare를 호출하세요.")

    job = vocal_remover.start_separation_job(
        path,
        body.format,
        timeout_sec=body.timeout_sec,
        device=body.device,
    )
    return _separate_status_payload(job)


@router.get("/separate/status", response_model=VocalRemoverSeparateStatus)
def get_separate_status() -> VocalRemoverSeparateStatus:
    return _separate_status_payload(vocal_remover.get_separation_job_status())


class VocalRemoverWorkspaceCleanupResponse(BaseModel):
    ok: bool
    files_removed: int = 0
    dirs_removed: int = 0
    errors: list[str] = Field(default_factory=list)


@router.post("/workspace/cleanup", response_model=VocalRemoverWorkspaceCleanupResponse)
def post_workspace_cleanup(_: VocalRemoverReady) -> VocalRemoverWorkspaceCleanupResponse:
    """분리 결과·demucs 임시 폴더를 workspace에서 삭제합니다."""
    result = vocal_remover.cleanup_workspace()
    if not result.get("ok"):
        busy = any("진행 중" in str(e) for e in result.get("errors") or [])
        if busy:
            raise HTTPException(status_code=409, detail="; ".join(result.get("errors") or []))
    return VocalRemoverWorkspaceCleanupResponse(
        ok=bool(result.get("ok")),
        files_removed=int(result.get("files_removed") or 0),
        dirs_removed=int(result.get("dirs_removed") or 0),
        errors=list(result.get("errors") or []),
    )


@router.get("/download")
def get_download(
    file_path: str | None = Query(None, description="결과 파일 절대 경로"),
    path: str | None = Query(None, description="file_path 별칭(하위 호환)"),
) -> FileResponse:
    raw = (file_path or path or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="file_path 쿼리가 필요합니다.")
    path_obj = Path(raw)
    if not path_obj.is_absolute():
        path_obj = vocal_remover.WORKSPACE_ROOT / path_obj
    path_obj = path_obj.resolve()
    if not vocal_remover.is_allowed_media_path(path_obj):
        raise HTTPException(status_code=400, detail="허용되지 않는 다운로드 경로입니다.")
    if not path_obj.is_file():
        raise HTTPException(status_code=404, detail="요청한 파일을 찾을 수 없습니다.")
    return FileResponse(path_obj, filename=path_obj.name, media_type="application/octet-stream")
