from __future__ import annotations

import json
import re
import threading
import uuid
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from common.bin_manager import FFMPEG_EXE, FFPROBE_EXE, ensure_ffmpeg
from engines import auto_subtitle
from engines import auto_subtitle_audiowaveform
from engines import auto_subtitle_export
from engines import auto_subtitle_png_export
from engines import auto_subtitle_project
from engines import auto_subtitle_gpu_runtime
from engines import auto_subtitle_runtime
from engines import silence_remover as silence_remover_engine
from engines import system_fonts

router = APIRouter(prefix="/api/tools/auto-subtitle", tags=["auto-subtitle"])


def _ensure_auto_subtitle_environment() -> None:
    ensure_ffmpeg()


AutoSubtitleReady = Annotated[None, Depends(_ensure_auto_subtitle_environment)]


class AutoSubtitlePrepareStatus(BaseModel):
    phase: str
    progress: float
    message: str | None = None
    step: str | None = None
    detail: str | None = None


class AutoSubtitleTranscribeBody(BaseModel):
    video_path: str = Field(..., description="로컬 영상/오디오 파일 절대 경로")
    language: str | None = Field(None, description="ISO 언어 코드 (미지정 시 자동)")
    beam_size: int = Field(5, ge=1, le=20)
    vad_filter: bool = True
    rms_vad_align: bool = Field(
        True,
        description="전사 후 PCM RMS/VAD 단어 타임스탬프 정렬 (AutoSubtitle 기본)",
    )


class AutoSubtitleTranscribeStatus(BaseModel):
    phase: str
    progress: float
    message: str | None = None
    error: str | None = None
    cues: list[dict[str, Any]] | None = None
    language: str | None = None
    duration_sec: float | None = None
    device: str | None = None
    srt_path: str | None = None
    cues_json_path: str | None = None
    waveform_peaks: dict[str, Any] | None = None
    waveform_peaks_json: dict[str, Any] | None = None


class CutRangeModel(BaseModel):
    start: float = Field(..., ge=0.0)
    end: float = Field(..., gt=0.0)


class AutoSubtitleExportBody(BaseModel):
    format: str = Field(..., description="srt | vtt | ass | txt | video | mp3 | wav")
    cues: list[dict[str, Any]] = Field(default_factory=list)
    video_path: str | None = Field(None, description="video/mp3/wav 보내기 시 원본 미디어")
    cut_ranges: list[CutRangeModel] = Field(default_factory=list)
    style: dict[str, Any] | None = Field(None, description="ASS/SRT/VTT 스타일 (선택)")


class AutoSubtitleExportStatus(BaseModel):
    phase: str
    progress: float
    message: str | None = None
    error: str | None = None
    result_path: str | None = None
    format: str | None = None


class AutoSubtitleExportFileResponse(BaseModel):
    ok: bool
    file_path: str
    format: str
    download_hint: str


class AutoSubtitleShowFolderBody(BaseModel):
    file_path: str = Field(..., description="보내기 결과 파일 절대 경로")


class PngOverlayTimingItem(BaseModel):
    start: float = Field(..., ge=0.0)
    end: float = Field(..., gt=0.0)


class AutoSubtitlePngExportBody(BaseModel):
    """Electron 오프스크린 PNG + processor.export_video_png_overlay 대응."""

    video_path: str
    png_paths: list[str] = Field(..., min_length=1)
    timing: list[PngOverlayTimingItem] = Field(..., min_length=1)
    output_path: str | None = None
    video_width: int = Field(1920, ge=16)
    video_height: int = Field(1080, ge=16)
    h264_encoder: str = Field("libx264", description="h264_nvenc | h264_qsv | h264_amf | libx264")
    png_sequence_fps: int = Field(24, ge=1, le=60)
    skip_phase1: bool = False
    phase1_codec: str | None = None
    phase1_second_input: str | None = None


class AutoSubtitleWaveformPeaksBody(BaseModel):
    video_path: str
    timeout_sec: float = Field(900.0, ge=10.0, le=3600.0)
    pixels_per_second: float = Field(80.0, ge=1.0, le=800.0)
    max_waveform_width: int = Field(34000, ge=400, le=40000)


class AutoSubtitleProjectSaveBody(BaseModel):
    project: dict[str, Any]
    name: str | None = Field(None, description="파일명 stem (.autosub 제외)")


class AutoSubtitleProjectLoadBody(BaseModel):
    project_path: str


_prepare_state = AutoSubtitlePrepareStatus(
    phase="not_started",
    progress=0.0,
    message="자막 추출 준비를 시작하세요.",
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


def _get_prepare_state() -> AutoSubtitlePrepareStatus:
    with _prepare_lock:
        return AutoSubtitlePrepareStatus(
            phase=_prepare_state.phase,
            progress=_prepare_state.progress,
            message=_prepare_state.message,
            step=_prepare_state.step,
            detail=_prepare_state.detail,
        )


def _prepare_phase_for_step(step: str) -> str:
    lowered = step.lower()
    if "모델" in step or "model" in lowered or "hugging" in lowered:
        return "downloading_models"
    if "pip" in lowered or "python" in lowered or "패키지" in step:
        return "installing_dependencies"
    if "ffmpeg" in lowered:
        return "installing_dependencies"
    if "로드" in step or "load" in lowered:
        return "downloading_models"
    return "installing_dependencies"


def _run_prepare() -> None:
    def report(pct: float, step: str, detail: str = "") -> None:
        phase = _prepare_phase_for_step(step)
        message = f"{step} — {detail}" if detail else step
        _set_prepare_state(phase, pct, message, step=step, detail=detail or None)

    try:
        auto_subtitle.prepare_all(on_progress=report)
        device = auto_subtitle.model_device() or "cpu"
        _set_prepare_state(
            "ready",
            100.0,
            "자막 추출 준비가 완료되었습니다.",
            step="완료",
            detail=f"Whisper · {device}",
        )
    except Exception as exc:
        msg = str(exc)
        if "WinError 32" in msg or "다른 프로세스가 파일" in msg:
            msg += (
                " — ItMatZipAgent 서비스를 재시작한 뒤 다시 시도하세요. "
                "(설정 → 서비스 → ItMatZipAgent → 다시 시작)"
            )
        _set_prepare_state(
            "failed",
            0.0,
            f"준비 중 오류: {msg}",
            step="오류",
            detail=msg,
        )


def _validate_project_path(raw: str) -> Path:
    norm = auto_subtitle.normalize_media_path(raw)
    resolved = auto_subtitle.resolve_existing_file(norm)
    if resolved is None:
        raise HTTPException(status_code=400, detail=f"프로젝트 파일을 찾을 수 없습니다: {norm}")
    if resolved.suffix.lower() not in {".autosub", ".json"}:
        raise HTTPException(
            status_code=400,
            detail=f"프로젝트 파일은 .autosub 또는 .json 이어야 합니다: {resolved.suffix}",
        )
    return resolved


def _validate_media_path(raw: str) -> Path:
    norm = auto_subtitle.normalize_media_path(raw)
    resolved = auto_subtitle.resolve_existing_file(norm)
    if resolved is None:
        raise HTTPException(status_code=400, detail=f"파일을 찾을 수 없습니다: {norm}")
    if resolved.suffix.lower() not in auto_subtitle.ALLOWED_MEDIA_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail=f"지원하지 않는 형식입니다: {resolved.suffix}",
        )
    return resolved


def _transcribe_status_payload(job: auto_subtitle.TranscribeJobStatus) -> AutoSubtitleTranscribeStatus:
    result = job.result or {}
    return AutoSubtitleTranscribeStatus(
        phase=job.phase,
        progress=job.progress,
        message=job.message,
        error=job.error,
        cues=result.get("cues") if job.phase == "completed" else None,
        language=result.get("language"),
        duration_sec=result.get("duration_sec"),
        device=result.get("device"),
        srt_path=result.get("srt_path"),
        cues_json_path=result.get("cues_json_path"),
        waveform_peaks=result.get("waveform_peaks") if job.phase == "completed" else None,
        waveform_peaks_json=result.get("waveform_peaks_json") if job.phase == "completed" else None,
    )


@router.get("/readiness")
def get_readiness() -> dict[str, object]:
    auto_subtitle.ensure_workspace()
    runtime = auto_subtitle_runtime.runtime_status()
    gpu_status = auto_subtitle_gpu_runtime.gpu_runtime_status()
    gpu_status["nvidia_gpu"] = auto_subtitle.has_nvidia_gpu()
    return {
        "ok": True,
        "tool": "auto-subtitle",
        "binaries": {
            "ffmpeg": FFMPEG_EXE.is_file(),
            "ffprobe": FFPROBE_EXE.is_file(),
            "faster_whisper": auto_subtitle.is_faster_whisper_installed(),
            "model_present": auto_subtitle.is_model_present(),
            "model_loaded": auto_subtitle.is_model_loaded(),
            "gpu_detected": auto_subtitle.has_nvidia_gpu(),
            "cuda_runtime_ready": auto_subtitle.cuda_runtime_ready(),
            "gpu_runtime_installed": bool(gpu_status.get("installed")),
            "audiowaveform": auto_subtitle_audiowaveform.resolve_audiowaveform_exe() is not None,
        },
        "gpu_runtime": gpu_status,
        "model": {
            "repo_id": auto_subtitle.HF_REPO_ID,
            "model_dir": str(auto_subtitle.LOCAL_MODEL_DIR),
            "device": auto_subtitle.model_device(),
            "download_hint_mb": auto_subtitle_runtime.WHISPER_MODEL_DOWNLOAD_HINT_MB,
            "first_run_note": (
                "첫 자막 추출 시 Whisper AI 모델(약 1.6GB)과 FFmpeg를 "
                "PC에 자동으로 받습니다."
            ),
        },
        "runtime": runtime,
    }


@router.get("/system-fonts")
def get_system_fonts() -> dict[str, object]:
    """로컬 PC에 설치된 글꼴 패밀리 목록."""
    return {"ok": True, "fonts": system_fonts.list_installed_font_families()}


@router.post("/gpu-runtime/install")
def post_gpu_runtime_install(_: AutoSubtitleReady) -> dict[str, object]:
    """AutoSubtitle runtime_dlls.zip — cuBLAS 등 GPU DLL 설치 (NVIDIA GPU 있을 때)."""
    if not auto_subtitle.has_nvidia_gpu():
        raise HTTPException(
            status_code=400,
            detail="NVIDIA GPU가 감지되지 않아 GPU 런타임 설치가 필요하지 않습니다.",
        )
    if auto_subtitle_runtime.is_job_busy():
        raise HTTPException(status_code=409, detail="다른 작업이 진행 중입니다.")
    try:
        return auto_subtitle_gpu_runtime.install_gpu_runtime()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/model/unload")
def post_model_unload() -> dict[str, object]:
    """Whisper 모델을 메모리에서 해제합니다 (VRAM/RAM 절약)."""
    if auto_subtitle_runtime.is_job_busy():
        raise HTTPException(
            status_code=409,
            detail="작업이 진행 중일 때는 모델을 해제할 수 없습니다.",
        )
    return auto_subtitle_runtime.unload_whisper_model(reason="api")


class AutoSubtitleWorkspaceCleanupResponse(BaseModel):
    ok: bool
    files_removed: int = 0
    dirs_removed: int = 0
    errors: list[str] = Field(default_factory=list)


@router.post("/workspace/cleanup", response_model=AutoSubtitleWorkspaceCleanupResponse)
def post_workspace_cleanup(_: AutoSubtitleReady) -> AutoSubtitleWorkspaceCleanupResponse:
    result = auto_subtitle.cleanup_workspace()
    if not result.get("ok"):
        busy = any("진행 중" in str(e) for e in result.get("errors") or [])
        if busy:
            raise HTTPException(status_code=409, detail="; ".join(result.get("errors") or []))
    return AutoSubtitleWorkspaceCleanupResponse(
        ok=bool(result.get("ok")),
        files_removed=int(result.get("files_removed") or 0),
        dirs_removed=int(result.get("dirs_removed") or 0),
        errors=list(result.get("errors") or []),
    )


@router.post("/prepare")
def post_prepare(
    force: bool = Query(False, description="ready여도 FFmpeg·모델 재준비"),
) -> AutoSubtitlePrepareStatus:
    global _prepare_thread

    with _prepare_lock:
        if _prepare_thread is not None and _prepare_thread.is_alive():
            _prepare_state.detail = "Whisper 모델·패키지 설치가 진행 중입니다."
            return _get_prepare_state()

        if _prepare_state.phase == "ready" and not force and auto_subtitle.is_model_loaded():
            return _get_prepare_state()

        _prepare_state.phase = "installing_dependencies"
        _prepare_state.progress = 3.0
        _prepare_state.message = "자막 추출 환경을 준비합니다…"
        _prepare_state.step = "시작"
        _prepare_state.detail = "FFmpeg · GPU 런타임(DLL) · faster-whisper · Whisper CT2"
        _prepare_thread = threading.Thread(target=_run_prepare, daemon=True)
        _prepare_thread.start()

    return _get_prepare_state()


@router.get("/prepare/status")
def get_prepare_status() -> AutoSubtitlePrepareStatus:
    return _get_prepare_state()


@router.post("/transcribe", response_model=AutoSubtitleTranscribeStatus)
def post_transcribe(
    body: AutoSubtitleTranscribeBody,
    _: AutoSubtitleReady,
) -> AutoSubtitleTranscribeStatus:
    if not auto_subtitle.is_model_loaded():
        raise HTTPException(
            status_code=503,
            detail="Whisper가 준비되지 않았습니다. 먼저 POST /prepare를 호출하세요.",
        )

    media = _validate_media_path(body.video_path)
    lang = body.language.strip() if body.language and body.language.strip() else None

    try:
        job = auto_subtitle.start_transcribe_job(
            media,
            language=lang,
            beam_size=body.beam_size,
            vad_filter=body.vad_filter,
            rms_vad_align=body.rms_vad_align,
        )
    except RuntimeError as exc:
        msg = str(exc)
        if auto_subtitle_runtime.is_job_busy() or "진행 중" in msg or "대기" in msg:
            raise HTTPException(status_code=409, detail=msg) from exc
        raise HTTPException(status_code=503, detail=msg) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return _transcribe_status_payload(job)


@router.get("/transcribe/status", response_model=AutoSubtitleTranscribeStatus)
def get_transcribe_status() -> AutoSubtitleTranscribeStatus:
    return _transcribe_status_payload(auto_subtitle.get_transcribe_job_status())


def _export_status_payload(job: auto_subtitle_export.ExportJobStatus) -> AutoSubtitleExportStatus:
    return AutoSubtitleExportStatus(
        phase=job.phase,
        progress=job.progress,
        message=job.message,
        error=job.error,
        result_path=job.result_path,
        format=job.format,
    )


def _cut_ranges_payload(ranges: list[CutRangeModel]) -> list[dict[str, float]]:
    return [{"start": r.start, "end": r.end} for r in ranges]


@router.post("/export", response_model=AutoSubtitleExportStatus)
def post_export(
    body: AutoSubtitleExportBody,
    _: AutoSubtitleReady,
) -> AutoSubtitleExportStatus:
    """자막 파일·영상 번인·오디오 보내기 job 시작."""
    fmt = body.format.lower().strip()
    valid = {"srt", "vtt", "ass", "txt", "video", "mp3", "wav"}
    if fmt not in valid:
        raise HTTPException(status_code=400, detail=f"지원하지 않는 형식: {body.format}")

    media: Path | None = None
    if fmt in {"video", "mp3", "wav"}:
        if not body.video_path or not body.video_path.strip():
            raise HTTPException(status_code=400, detail="video_path가 필요합니다.")
        media = _validate_media_path(body.video_path)

    cuts = _cut_ranges_payload(body.cut_ranges)
    try:
        job = auto_subtitle_export.start_export_job(
            fmt,
            body.cues,
            media_path=media,
            cut_ranges=cuts,
            style=body.style,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        msg = str(exc)
        code = 409 if ("진행 중" in msg or auto_subtitle_runtime.is_job_busy()) else 503
        raise HTTPException(status_code=code, detail=msg) from exc

    return _export_status_payload(job)


@router.post("/export/sync", response_model=AutoSubtitleExportFileResponse)
def post_export_sync(
    body: AutoSubtitleExportBody,
    _: AutoSubtitleReady,
) -> AutoSubtitleExportFileResponse:
    """SRT/VTT/ASS/TXT 즉시 생성 (짧은 작업)."""
    fmt = body.format.lower().strip()
    if fmt not in {"srt", "vtt", "ass", "txt"}:
        raise HTTPException(status_code=400, detail="sync는 srt/vtt/ass/txt만 지원합니다.")
    if not body.cues:
        raise HTTPException(status_code=400, detail="cues가 비어 있습니다.")
    try:
        out = auto_subtitle_export.sync_export_text(
            fmt,
            body.cues,
            cut_ranges=_cut_ranges_payload(body.cut_ranges),
            style=body.style,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return AutoSubtitleExportFileResponse(
        ok=True,
        file_path=str(out),
        format=fmt,
        download_hint=f"/api/tools/auto-subtitle/download?file_path={out}",
    )


@router.get("/export/status", response_model=AutoSubtitleExportStatus)
def get_export_status() -> AutoSubtitleExportStatus:
    return _export_status_payload(auto_subtitle_export.get_export_job_status())


@router.post("/export/by-format", response_model=AutoSubtitleExportStatus)
def post_export_by_format(
    body: AutoSubtitleExportBody,
    ready: AutoSubtitleReady,
) -> AutoSubtitleExportStatus:
    """Electron export:by-format IPC 대응."""
    return post_export(body, ready)


@router.post("/export/show-in-folder")
def post_export_show_in_folder(
    body: AutoSubtitleShowFolderBody,
    _: AutoSubtitleReady,
) -> dict[str, bool]:
    raw = body.file_path.strip()
    if not raw:
        raise HTTPException(status_code=400, detail="file_path가 필요합니다.")
    path_obj = Path(raw)
    if not path_obj.is_absolute():
        path_obj = auto_subtitle.WORKSPACE_ROOT / path_obj
    path_obj = path_obj.resolve()
    if not auto_subtitle.is_allowed_download_path(path_obj):
        raise HTTPException(status_code=400, detail="허용되지 않는 경로입니다.")
    try:
        auto_subtitle_export.show_result_in_folder(path_obj)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"ok": True}


@router.post("/export/srt", response_model=AutoSubtitleExportFileResponse)
def post_export_srt_legacy(
    body: AutoSubtitleExportBody,
    _: AutoSubtitleReady,
) -> AutoSubtitleExportFileResponse:
    """하위 호환 — SRT sync."""
    if not body.cues:
        raise HTTPException(status_code=400, detail="cues가 비어 있습니다.")
    try:
        out = auto_subtitle_export.sync_export_text(
            "srt",
            body.cues,
            cut_ranges=_cut_ranges_payload(body.cut_ranges),
            style=body.style,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return AutoSubtitleExportFileResponse(
        ok=True,
        file_path=str(out),
        format="srt",
        download_hint=f"/api/tools/auto-subtitle/download?file_path={out}",
    )


@router.get("/media/stream")
def get_media_stream(
    video_path: str = Query(..., description="로컬 미디어 절대 경로"),
    _: AutoSubtitleReady = ...,
) -> FileResponse:
    """브라우저 <video> 미리보기 — Range 요청 지원."""
    media = _validate_media_path(video_path)
    suffix = media.suffix.lower()
    media_types = {
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mkv": "video/x-matroska",
        ".mov": "video/quicktime",
        ".avi": "video/x-msvideo",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".flac": "audio/flac",
        ".m4a": "audio/mp4",
        ".ogg": "audio/ogg",
    }
    media_type = media_types.get(suffix, "application/octet-stream")
    return FileResponse(media, media_type=media_type, filename=media.name)


@router.post("/waveform-peaks")
def post_waveform_peaks(
    body: AutoSubtitleWaveformPeaksBody,
    _: AutoSubtitleReady,
) -> dict[str, object]:
    media = _validate_media_path(body.video_path)
    try:
        payload = silence_remover_engine.build_waveform_peaks_payload(
            media,
            timeout_sec=body.timeout_sec,
            pixels_per_second=body.pixels_per_second,
            max_waveform_width=body.max_waveform_width,
        )
        payload["peaks_engine"] = "pcm_columns"
        return payload
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/waveform-peaks/audiowaveform")
def post_waveform_peaks_audiowaveform(
    body: AutoSubtitleWaveformPeaksBody,
    _: AutoSubtitleReady,
) -> dict[str, object]:
    """Peaks.js 호환 JSON (audiowaveform CLI) — AutoSubtitle main._waveform_peaks_impl."""
    media = _validate_media_path(body.video_path)
    auto_subtitle.ensure_workspace()
    out = auto_subtitle.WORKSPACE_ROOT / f"peaks-aw-{uuid.uuid4().hex[:10]}.json"
    try:
        result = auto_subtitle_audiowaveform.waveform_peaks_impl(media, out)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if not result.get("ok"):
        return {
            "ok": False,
            "reason": str(result.get("reason") or "audiowaveform peaks failed"),
            "peaks_engine": "audiowaveform",
            "video_path": str(media),
        }
    peaks_path = Path(str(result.get("path") or out))
    try:
        peaks_json = json.loads(peaks_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"peaks json read failed: {exc}") from exc
    return {
        **peaks_json,
        "ok": True,
        "peaks_json_path": str(peaks_path),
        "cached": bool(result.get("cached")),
        "peaks_engine": "audiowaveform",
        "video_path": str(media),
    }


@router.post("/export/video-png-overlay")
def post_export_video_png_overlay(
    body: AutoSubtitlePngExportBody,
    _: AutoSubtitleReady,
) -> dict[str, object]:
    """PNG 자막 시퀀스 + FFmpeg 2단계 합성 (AutoSubtitle processor.export_video_png_overlay)."""
    if len(body.timing) != len(body.png_paths):
        raise HTTPException(status_code=400, detail="timing 길이가 png_paths 와 일치해야 합니다.")
    media = _validate_media_path(body.video_path)
    for p in body.png_paths:
        pp = Path(p)
        if not pp.is_file():
            raise HTTPException(status_code=400, detail=f"PNG 파일 없음: {p}")

    auto_subtitle.ensure_workspace()
    job_dir = auto_subtitle.WORKSPACE_ROOT / f"png-export-{uuid.uuid4().hex[:10]}"
    job_dir.mkdir(parents=True, exist_ok=True)
    out_path = (
        Path(body.output_path).resolve()
        if body.output_path and body.output_path.strip()
        else job_dir / f"{media.stem}_png_overlay.mp4"
    )
    intermediate = job_dir / "subtitle_layer.mov"

    params: dict[str, object] = {
        "inputPath": str(media),
        "outputPath": str(out_path),
        "intermediatePath": str(intermediate),
        "pngPaths": body.png_paths,
        "timing": [{"start": t.start, "end": t.end} for t in body.timing],
        "videoWidth": body.video_width,
        "videoHeight": body.video_height,
        "h264Encoder": body.h264_encoder,
        "pngSequenceFps": body.png_sequence_fps,
        "skipPhase1": body.skip_phase1,
    }
    if body.skip_phase1:
        params["phase1Codec"] = body.phase1_codec
        params["phase1SecondInput"] = body.phase1_second_input

    if auto_subtitle_runtime.is_job_busy():
        raise HTTPException(status_code=409, detail="다른 작업이 진행 중입니다.")

    try:
        auto_subtitle_runtime.try_begin_job("export")
        result = auto_subtitle_png_export.export_video_png_overlay(params)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        auto_subtitle_runtime.end_job()

    return {
        "ok": True,
        "output_path": result.get("outputPath") or str(out_path),
        "intermediate_path": result.get("intermediatePath"),
        "phase1_codec": result.get("phase1Codec"),
        "download_hint": f"/api/tools/auto-subtitle/download?file_path={out_path}",
    }


@router.post("/project/save")
def post_project_save(body: AutoSubtitleProjectSaveBody) -> dict[str, str]:
    auto_subtitle.ensure_workspace()
    projects_dir = auto_subtitle.WORKSPACE_ROOT / "projects"
    projects_dir.mkdir(parents=True, exist_ok=True)
    stem = (body.name or "project").strip() or "project"
    stem = re.sub(r'[<>:"/\\|?*]', "_", stem)[:80]
    out = projects_dir / f"{stem}.autosub"
    if out.exists():
        out = projects_dir / f"{stem}-{uuid.uuid4().hex[:6]}.autosub"
    out.write_text(json.dumps(body.project, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": "true", "project_path": str(out.resolve())}


@router.post("/project/load")
def post_project_load(body: AutoSubtitleProjectLoadBody) -> dict[str, Any]:
    path_obj = Path(body.project_path.strip())
    if not path_obj.is_absolute():
        path_obj = auto_subtitle.WORKSPACE_ROOT / "projects" / path_obj
    path_obj = _validate_project_path(str(path_obj.resolve()))
    try:
        raw = json.loads(path_obj.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail=f"프로젝트 읽기 실패: {exc}") from exc
    normalized, err = auto_subtitle_project.parse_autosub_project(raw)
    if normalized is None:
        raise HTTPException(status_code=400, detail=err or "프로젝트 형식이 올바르지 않습니다.")
    return {
        "ok": True,
        "project": raw,
        "normalized": normalized,
        "project_path": str(path_obj),
        "video_path": normalized.get("video_path"),
        "cues": normalized.get("cues") or [],
        "cut_ranges": normalized.get("cut_ranges") or [],
        "subtitle_style": normalized.get("subtitle_style"),
    }


@router.get("/download")
def get_download(
    file_path: str | None = Query(None),
    path: str | None = Query(None),
) -> FileResponse:
    raw = (file_path or path or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="file_path 쿼리가 필요합니다.")
    path_obj = Path(raw)
    if not path_obj.is_absolute():
        path_obj = auto_subtitle.WORKSPACE_ROOT / path_obj
    path_obj = path_obj.resolve()
    if not auto_subtitle.is_allowed_download_path(path_obj):
        raise HTTPException(status_code=400, detail="허용되지 않는 다운로드 경로입니다.")
    if not path_obj.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    suffix = path_obj.suffix.lower()
    media_types = {
        ".srt": "text/plain; charset=utf-8",
        ".vtt": "text/vtt; charset=utf-8",
        ".ass": "text/plain; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".mp4": "video/mp4",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
    }
    media_type = media_types.get(suffix, "application/octet-stream")
    return FileResponse(path_obj, filename=path_obj.name, media_type=media_type)
