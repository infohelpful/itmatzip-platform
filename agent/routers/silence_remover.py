"""
무음 탐지(silence-remover) 툴 전용 API.

이 모듈에만 무음 탐지에 필요한 환경 점검(예: FFmpeg/ffprobe)을 묶어,
다른 툴이 추가되어도 해당 툴을 쓰지 않는 요청에서는 이 로직이 실행되지 않습니다.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Annotated, Callable

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from common.async_io import run_sync
from common.bin_manager import ensure_ffmpeg, get_bin_root, get_ffmpeg_exe, get_ffprobe_exe, is_ffmpeg_ready
from common.pick_local_file import behind_go_proxy, run_media_pick_dialog
from engines import auto_subtitle, silence_remover
from engines.silence_remover_runtime import ensure_silence_remover_runtime
from runtime_paths import pick_file_available

router = APIRouter(prefix="/api/tools/silence-remover", tags=["silence-remover"])


def _ensure_silence_remover_environment() -> None:
    """무음 탐지 툴이 필요로 하는 로컬 바이너리·Python runtime 만 준비합니다."""
    ensure_silence_remover_runtime(install=True)
    ensure_ffmpeg(download_timeout_sec=900.0)


SilenceRemoverReady = Annotated[None, Depends(_ensure_silence_remover_environment)]


def _resolve_media_path(raw: str) -> Path:
    """Windows NFC·₩ 경로 등을 정규화한 뒤 실제 파일을 찾습니다."""
    norm = auto_subtitle.normalize_media_path(raw)
    resolved = auto_subtitle.resolve_existing_file(norm)
    if resolved is None:
        raise HTTPException(status_code=400, detail=f"파일을 찾을 수 없습니다: {norm}")
    return resolved


class SilenceRemoverAnalyzeBody(BaseModel):
    """웹 UI에서 로컬 영상 경로를 POST로 넘겨 무음 분석을 요청할 때 사용합니다."""

    video_path: str = Field(..., description="로컬 디스크의 영상 파일 절대/상대 경로")
    noise_db: float = Field(-50.0, description="silencedetect noise 임계값 (dB)")
    min_silence_sec: float = Field(0.1, description="이 길이 이상을 무음으로 간주 (초)")
    pixels_per_second: float = Field(
        36.0,
        ge=8.0,
        le=120.0,
        description="파형·무음 탐지 공통 가로 해상도(초당 픽셀). UI 파형 미리보기와 동일해야 합니다.",
    )
    max_waveform_width: int = Field(
        34000,
        ge=1600,
        le=40000,
        description="파형 가로 픽셀 상한",
    )
    timeout_sec: float = Field(3600.0, ge=1.0, description="FFmpeg 실행 상한 (초)")
    title: str | None = Field(None, description="EDL TITLE (미지정 시 파일명 기반)")
    reel: str = Field("SILENCE", description="EDL 릴 이름 (최대 8자)")
    fcm: str | None = Field(
        None,
        description="FCM 헤더(미지정 시 FPS에 따라 DROP/NON-DROP 자동)",
    )
    fps_rational: str | None = Field(
        None,
        description="EDL·프레임 스냅 FPS (예: 30000/1001). 미지정 시 ffprobe avg_frame_rate",
    )
    fps: float | None = Field(
        None,
        gt=0,
        le=240,
        description="UI 프레임 입력값(예: 29.97). EDL 타임코드용, 미지정 시 fps_rational 사용",
    )
    padding_ms: float = Field(
        100.0,
        ge=0.0,
        le=5000.0,
        description="말소리 구간 앞뒤 여백(ms). Auto_Cutter padding과 동일",
    )
    remove_silent: bool = Field(
        True,
        description="True면 무음 빼고 말소리만 이어 붙임. False면 무음·말소리 전부 컷만(전체 길이 유지)",
    )
    use_autocutter_pipeline: bool = Field(
        True,
        description="True면 Auto_Cutter와 동일한 silencedetect·말소리·EDL 파이프라인",
    )
    use_recommended_noise: bool = Field(
        True,
        description="True면 volumedetect+PCM 추천 noise(dB)로 silencedetect (영상마다 자동)",
    )
    use_pcm_preview: bool = Field(
        True,
        description="True면 파형 열+dB 미리보기와 동일한 PCM 탐지로 EDL·무음 구간 생성",
    )
    clip_name: str | None = Field(
        None,
        description="미디어 풀 클립 파일명(예: Rec 0001.mp4). 미지정 시 video_path에서 추출",
    )
    require_cached_peaks: bool = Field(
        False,
        description="True면 이미 로드된 파형 캐시만 사용(재디코드 생략, 파형 로드 후 분석 권장)",
    )


class SilenceRemoverProbeBody(BaseModel):
    """경로가 준비되면 FPS·평균 볼륨·추천 무음 민감도만 빠르게 조회합니다."""

    video_path: str = Field(..., description="로컬 디스크의 미디어 파일 절대/상대 경로")
    timeout_sec: float = Field(300.0, ge=5.0, le=3600.0, description="프로브 상한 (초)")


class SilenceRemoverWaveformPeaksBody(BaseModel):
    """Canvas 파형용 PCM 열 피크 JSON."""

    video_path: str = Field(..., description="로컬 미디어 경로")
    timeout_sec: float = Field(600.0, ge=30.0, le=3600.0, description="FFmpeg 상한 (초)")
    pixels_per_second: float = Field(
        36.0,
        ge=8.0,
        le=120.0,
        description="가로 해상도(초당 열 수)",
    )
    max_waveform_width: int = Field(34000, ge=1600, le=40000, description="가로 열 상한")


class SilenceRemoverWaveformPreviewBody(BaseModel):
    """미리보기용 전체 오디오 파형 PNG 생성."""

    video_path: str = Field(..., description="로컬 미디어 경로")
    timeout_sec: float = Field(600.0, ge=30.0, le=3600.0, description="FFmpeg 상한 (초)")
    pixels_per_second: float = Field(
        36.0,
        ge=8.0,
        le=120.0,
        description="가로 해상도(재생 1초당 픽셀). 클수록 이미지가 넓고 생성 시간이 늘어납니다.",
    )
    waveform_height: int = Field(
        280,
        ge=80,
        le=360,
        description="파형 PNG 전체 세로(픽셀). 실제 파동은 이 높이의 wave_vertical_fraction만 사용하고 위·아래는 여백.",
    )
    wave_vertical_fraction: float = Field(
        0.72,
        ge=0.5,
        le=0.98,
        description="캔버스 세로 중 파동이 차지하는 비율(나머지는 상하 레터박스).",
    )
    max_width: int = Field(12000, ge=1600, le=20000, description="가로 픽셀 상한(너무 큰 PNG 방지)")


class SilenceInterval(BaseModel):
    """무음 구간(초)."""

    start_sec: float = Field(..., ge=0)
    end_sec: float = Field(..., ge=0)


class VocalIntervalMs(BaseModel):
    start_ms: float = Field(..., ge=0)
    end_ms: float = Field(..., gt=0)


class SilenceRemoverBuildEdlBody(BaseModel):
    """분석에 저장된 무음 구간(시작·끝 초)과 편집 FPS로 EDL 생성."""

    silences: list[SilenceInterval] = Field(default_factory=list)
    silences_display: list[SilenceInterval] | None = Field(
        None,
        description="coalesced raw 무음(초). vocal_intervals_ms 없을 때 EDL용 말소리 재계산에 사용.",
    )
    padding_ms: float = Field(
        100.0,
        ge=0.0,
        le=5000.0,
        description="EDL fallback 시 말소리 앞뒤 여백(ms). Auto_Cutter padding과 동일",
    )
    vocal_intervals_ms: list[VocalIntervalMs] | None = Field(
        None,
        description="분석 시 반환된 말소리 구간(ms). 있으면 EDL에 직접 사용.",
    )
    duration_sec: float = Field(..., gt=0, description="타임라인 길이(초)")
    fps_rational: str | None = Field(
        None,
        description="EDL 타임코드 FPS (예: 30000/1001)",
    )
    title: str | None = Field(None, description="EDL TITLE")
    reel: str | None = Field(None, description="EDL 릴 이름 (최대 8자, 미지정 시 clip_name에서 추출)")
    clip_name: str | None = Field(
        None,
        description="미디어 풀 클립 파일명(예: Rec0001.mp4). FROM CLIP NAME 매칭용",
    )
    fcm: str | None = Field(None, description="FCM 헤더(미지정 시 자동)")
    fps: float | None = Field(None, gt=0, le=240, description="EDL 타임코드 FPS(예: 29.97)")
    remove_silent: bool = Field(
        True,
        description="True면 무음 빼고 말소리만 이어 붙임. False면 무음·말소리 전부 컷만(전체 길이 유지)",
    )
    min_silence_sec: float = Field(
        0.3,
        ge=0.0,
        le=30.0,
        description="말소리 사이 이 길이 미만 간격은 병합(파형 미리보기·EDL 동일)",
    )
    video_path: str | None = Field(
        None,
        description="로컬 미디어 경로(클립 파일명 추출용)",
    )
    source_tc_offset_sec: float | None = Field(
        None,
        ge=0.0,
        description="분석 시 확정된 미디어 풀 시작 TC(초). 미지정 시 0",
    )


class SilenceRemoverWaveformAnalyzedBody(BaseModel):
    """무음 구간을 표시한 전체 타임라인 파형 PNG."""

    video_path: str = Field(..., description="로컬 미디어 경로")
    silences: list[SilenceInterval] = Field(default_factory=list, description="무음 구간 목록")
    timeout_sec: float = Field(600.0, ge=30.0, le=3600.0, description="FFmpeg 상한 (초)")
    pixels_per_second: float = Field(
        36.0,
        ge=8.0,
        le=120.0,
        description="가로 해상도(재생 1초당 픽셀).",
    )
    waveform_height: int = Field(
        280,
        ge=80,
        le=360,
        description="파형 PNG 전체 세로(픽셀).",
    )
    wave_vertical_fraction: float = Field(
        0.72,
        ge=0.5,
        le=0.98,
        description="캔버스 세로 중 파동이 차지하는 비율.",
    )
    max_width: int = Field(12000, ge=1600, le=20000, description="가로 픽셀 상한")
    playhead_sec: float | None = Field(
        None,
        description="선택) 재생 헤드 위치(초). 지정 시 밝은 파란 세로선으로 표시합니다.",
    )
    timeline_sec: float | None = Field(
        None,
        gt=0,
        description="분석 응답 duration_sec(silencedetect 타임라인). 무음 구간 시각과 동일한 기준.",
    )
    noise_db: float | None = Field(
        None,
        description="분석 시 사용한 무음 민감도(dB). 파형 표시 임계값과 맞춥니다.",
    )
    mean_volume_db: float | None = Field(
        None,
        description="volumedetect 평균 볼륨(dB). 파형·오버레이 임계값 보정용.",
    )
    max_volume_db: float | None = Field(
        None,
        description="volumedetect 최대 볼륨(dB).",
    )
    min_silence_sec: float = Field(
        0.3,
        ge=0.05,
        le=30.0,
        description="최소 무음 길이(초). 파형 오버레이 최소 폭.",
    )
    waveform_width: int | None = Field(
        None,
        ge=400,
        description="분석 시 사용한 파형 가로 열 수. analyze 응답 waveform_width와 동일해야 합니다.",
    )
    highlight_mode: str = Field(
        "pcm",
        description='무음 표시: "pcm"(dB·파형 열 실시간) 또는 "segments"(분석 silences 고정)',
    )


def _silence_binaries_payload() -> dict[str, object]:
    return {
        "ffmpeg": is_ffmpeg_ready(),
        "ffprobe": is_ffmpeg_ready(),
        "bin_dir": str(get_bin_root()),
    }


@router.get("/readiness")
def get_readiness() -> dict[str, object]:
    """
    무음 탐지 페이지 진입 시 빠르게 바이너리 존재만 확인합니다.
    다운로드·설치는 POST /prepare 에서 수행합니다.
    """
    return {
        "ok": True,
        "tool": "silence-remover",
        "binaries": _silence_binaries_payload(),
    }


@router.post("/prepare")
def post_prepare() -> dict[str, object]:
    """FFmpeg/ffprobe가 없으면 다운로드·설치합니다 (최초 1회, 수십 초~수 분 소요 가능)."""
    try:
        ensure_silence_remover_runtime(install=True)
        ensure_ffmpeg(download_timeout_sec=900.0)
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail=f"FFmpeg 설치 실패 ({get_bin_root()}): {e}",
        ) from e
    binaries = _silence_binaries_payload()
    if not binaries["ffmpeg"] or not binaries["ffprobe"]:
        raise HTTPException(
            status_code=503,
            detail=f"FFmpeg 설치 후에도 바이너리가 없습니다: {binaries['bin_dir']}",
        )
    return {
        "ok": True,
        "tool": "silence-remover",
        "binaries": binaries,
    }


@router.post("/pick-local-file")
def post_pick_local_file() -> dict[str, str]:
    """레거시: Go 프록시 뒤에서는 /api/agent/pick-local-file 사용."""
    if behind_go_proxy():
        raise HTTPException(
            status_code=503,
            detail="브라우저에서는 POST /api/agent/pick-local-file 을 사용하세요.",
        )
    if not pick_file_available():
        raise HTTPException(
            status_code=500,
            detail="파일 선택 스크립트를 찾을 수 없습니다. exe를 다시 빌드하거나 agent/scripts를 확인하세요.",
        )
    try:
        path = run_media_pick_dialog(timeout=600)
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

    return {"video_path": path}


@router.post("/probe")
def post_probe(
    _: SilenceRemoverReady,
    body: SilenceRemoverProbeBody,
) -> dict[str, object]:
    """영상/오디오 파일 경로로 FPS·평균 볼륨·추천 무음 noise(dB)를 반환합니다."""
    path = _resolve_media_path(body.video_path)

    try:
        return silence_remover.probe_media_for_silence_ui(path, timeout_sec=body.timeout_sec)
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


class _WaveformPreviewError(Exception):
    """스레드 안에서 파형 생성 실패를 async 핸들러로 전달하기 위한 예외."""

    def __init__(self, status_code: int, detail: str) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


def _waveform_preview_png_bytes(path: Path, body: SilenceRemoverWaveformPreviewBody) -> bytes:
    try:
        dur, _sr = silence_remover.get_media_audio_timeline_sec(
            path,
            timeout_sec=min(120.0, body.timeout_sec),
        )
    except (FileNotFoundError, RuntimeError, OSError) as e:
        raise _WaveformPreviewError(422, str(e)) from e

    if dur <= 0:
        raise _WaveformPreviewError(422, "재생 시간(duration)을 알 수 없습니다.")

    w = silence_remover.compute_waveform_column_count(
        dur,
        pixels_per_second=body.pixels_per_second,
        max_width=body.max_width,
    )

    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()

    def _cleanup() -> None:
        tmp_path.unlink(missing_ok=True)

    try:
        _out, effective_dur = silence_remover.render_waveform_preview_png(
            path,
            tmp_path,
            waveform_width=w,
            waveform_height=body.waveform_height,
            wave_vertical_fraction=body.wave_vertical_fraction,
            timeout_sec=body.timeout_sec,
            duration_sec=dur,
        )
        silence_remover.finalize_preview_png_file(tmp_path, effective_dur)
    except FileNotFoundError as e:
        _cleanup()
        raise _WaveformPreviewError(400, str(e)) from e
    except RuntimeError as e:
        _cleanup()
        raise _WaveformPreviewError(422, str(e)) from e
    except subprocess.TimeoutExpired as e:
        _cleanup()
        raise _WaveformPreviewError(504, f"파형 생성 시간 초과: {e}") from e
    except Exception as e:
        _cleanup()
        raise _WaveformPreviewError(500, str(e)) from e

    try:
        png_bytes = tmp_path.read_bytes()
    finally:
        _cleanup()

    if not png_bytes:
        raise _WaveformPreviewError(500, "생성된 파형 데이터가 비어 있습니다.")
    return png_bytes


def _waveform_analyzed_png_bytes(path: Path, body: SilenceRemoverWaveformAnalyzedBody) -> bytes:
    if body.timeline_sec is not None and body.timeline_sec > 0:
        dur = float(body.timeline_sec)
    else:
        try:
            dur, _sr = silence_remover.get_media_audio_timeline_sec(
                path,
                timeout_sec=min(120.0, body.timeout_sec),
            )
        except (FileNotFoundError, RuntimeError, OSError) as e:
            raise _WaveformPreviewError(422, str(e)) from e

        if dur <= 0:
            raise _WaveformPreviewError(422, "재생 시간(duration)을 알 수 없습니다.")

    if body.waveform_width is not None and body.waveform_width >= 400:
        w = int(body.waveform_width)
    else:
        w = silence_remover.compute_waveform_column_count(
            dur,
            pixels_per_second=body.pixels_per_second,
            max_width=body.max_width,
        )
    segs: list[silence_remover.SilenceSegment] = []
    for s in body.silences:
        t0 = max(0.0, float(s.start_sec))
        t1 = max(0.0, float(s.end_sec))
        if t1 > t0:
            segs.append(silence_remover.SilenceSegment(t0, t1))

    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()

    def _cleanup() -> None:
        tmp_path.unlink(missing_ok=True)

    try:
        silence_remover.render_waveform_preview_png_with_silence_highlights(
            path,
            segs,
            tmp_path,
            duration_sec=dur,
            waveform_width=w,
            waveform_height=body.waveform_height,
            wave_vertical_fraction=body.wave_vertical_fraction,
            timeout_sec=body.timeout_sec,
            mean_volume_db=body.mean_volume_db,
            noise_db=body.noise_db,
            max_volume_db=body.max_volume_db,
            min_silence_sec=body.min_silence_sec,
            playhead_sec=body.playhead_sec,
            highlight_mode=body.highlight_mode,
        )
    except FileNotFoundError as e:
        _cleanup()
        raise _WaveformPreviewError(400, str(e)) from e
    except RuntimeError as e:
        _cleanup()
        raise _WaveformPreviewError(422, str(e)) from e
    except subprocess.TimeoutExpired as e:
        _cleanup()
        raise _WaveformPreviewError(504, f"파형 생성 시간 초과: {e}") from e
    except Exception as e:
        _cleanup()
        raise _WaveformPreviewError(500, str(e)) from e

    try:
        png_bytes = tmp_path.read_bytes()
    finally:
        _cleanup()

    if not png_bytes:
        raise _WaveformPreviewError(500, "생성된 파형 데이터가 비어 있습니다.")
    return png_bytes


@router.post("/waveform-peaks")
async def post_waveform_peaks(
    _: SilenceRemoverReady,
    body: SilenceRemoverWaveformPeaksBody,
) -> dict[str, object]:
    """Canvas 파형용 열당 피크·dB 배열을 반환합니다 (PNG 없음)."""
    path = _resolve_media_path(body.video_path)
    try:
        return await run_sync(
            silence_remover.build_waveform_peaks_payload,
            path,
            timeout_sec=body.timeout_sec,
            pixels_per_second=body.pixels_per_second,
            max_waveform_width=body.max_waveform_width,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except subprocess.TimeoutExpired as e:
        raise HTTPException(
            status_code=504,
            detail=f"PCM 추출 시간 초과: {e}",
        ) from e
    except RuntimeError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/waveform-preview")
async def post_waveform_preview(
    _: SilenceRemoverReady,
    body: SilenceRemoverWaveformPreviewBody,
) -> Response:
    """전체 타임라인 오디오 파형 PNG(무음 마커 없음). 가로 스크롤용으로 폭이 길 수 있습니다."""
    path = _resolve_media_path(body.video_path)

    try:
        png_bytes = await asyncio.to_thread(_waveform_preview_png_bytes, path, body)
    except _WaveformPreviewError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail) from e

    return Response(content=png_bytes, media_type="image/png")


@router.post("/waveform-preview-analyzed")
async def post_waveform_preview_analyzed(
    _: SilenceRemoverReady,
    body: SilenceRemoverWaveformAnalyzedBody,
) -> Response:
    """전체 타임라인 파형 PNG에 무음 구간(반투명 노랑 + 황금 경계선)을 합성합니다."""
    path = _resolve_media_path(body.video_path)

    try:
        png_bytes = await asyncio.to_thread(_waveform_analyzed_png_bytes, path, body)
    except _WaveformPreviewError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail) from e

    return Response(content=png_bytes, media_type="image/png")


def _analyze_video_payload(
    body: SilenceRemoverAnalyzeBody,
    *,
    on_progress: Callable[[float, str], None] | None = None,
) -> dict[str, object]:
    path = _resolve_media_path(body.video_path)
    (
        edl,
        segments,
        duration_sec,
        waveform_width,
        fps_edl,
        native_fps,
        raw_silences,
        vocal_ms,
        applied_noise_db,
        waveform_timeline_sec,
        waveform_pcm_decoded_sec,
        waveform_pixels_per_second,
        silence_column_ranges,
    ) = silence_remover.analyze_video_to_edl_with_metadata(
        path,
        noise_db=body.noise_db,
        min_silence_sec=body.min_silence_sec,
        padding_ms=body.padding_ms,
        remove_silent=body.remove_silent,
        use_autocutter_pipeline=body.use_autocutter_pipeline,
        use_recommended_noise=body.use_recommended_noise,
        use_pcm_preview=body.use_pcm_preview,
        require_cached_peaks=body.require_cached_peaks,
        timeout_sec=body.timeout_sec,
        pixels_per_second=body.pixels_per_second,
        max_waveform_width=body.max_waveform_width,
        title=body.title,
        reel=body.reel,
        fcm=body.fcm,
        fps_rational=body.fps_rational,
        fps_float=body.fps,
        on_progress=on_progress,
    )
    detection = "pcm_columns" if body.use_pcm_preview else "silencedetect"
    out: dict[str, object] = {
        "format": "cmx3600",
        "detection": detection,
        "edl": edl,
        "duration_sec": duration_sec,
        "waveform_width": waveform_width,
        "waveform_timeline_sec": waveform_timeline_sec,
        "waveform_pcm_decoded_sec": waveform_pcm_decoded_sec,
        "waveform_pixels_per_second": waveform_pixels_per_second,
        "waveform_peaks_from_cache": silence_remover.consume_waveform_cache_hit(),
        "fps_rational": f"{fps_edl.numerator}/{fps_edl.denominator}",
        "native_fps_rational": f"{native_fps.numerator}/{native_fps.denominator}",
        "fps_edl": float(fps_edl),
        "native_fps": float(native_fps),
        "clip_name": silence_remover.clip_name_from_media_path(path),
        "silences": [{"start_sec": s.start_sec, "end_sec": s.end_sec} for s in segments],
        "silences_display": [
            {"start_sec": s.start_sec, "end_sec": s.end_sec} for s in raw_silences
        ],
        "vocal_intervals_ms": [
            {"start_ms": float(a), "end_ms": float(b)} for a, b in vocal_ms
        ],
        "applied_noise_db": applied_noise_db,
        "silence_column_ranges": [
            [int(c0), int(c1)] for c0, c1 in silence_column_ranges
        ],
    }
    edl_timing = silence_remover.probe_media_edl_timing(path, fps=fps_edl)
    out["edl_source_tc_offset_sec"] = silence_remover.resolve_source_tc_offset_for_edl(
        edl_timing.source_tc_offset_sec
    )
    out["edl_content_duration_sec"] = (
        edl_timing.content_duration_sec if edl_timing.content_duration_sec > 0 else duration_sec
    )
    out["edl_total_frames"] = edl_timing.total_frames
    fps_f = float(body.fps) if body.fps is not None and body.fps > 0 else float(fps_edl)
    clip_fn = silence_remover.clip_name_from_media_path(path)
    ttl = (body.title or "AutoCut_Option").strip()[:79] or "AutoCut_Option"
    if on_progress is not None:
        on_progress(92.0, "XML 생성 중…")
    fcp_xml = silence_remover.create_fcp7_xml(
        vocal_ms,
        fps=fps_f,
        remove_silent=body.remove_silent,
        title=ttl,
        clip_filename=clip_fn,
        source_file_path=str(path.resolve()),
        duration_sec=float(duration_sec),
        silences=segments,
    )
    if fcp_xml.strip():
        out["fcp_xml"] = fcp_xml
    return out


def _analyze_status_payload(job: silence_remover.AnalyzeJobStatus) -> dict[str, object]:
    out: dict[str, object] = {
        "phase": job.phase,
        "progress": job.progress,
        "message": job.message,
    }
    if job.result:
        out.update(job.result)
    return out


@router.post("/analyze")
def post_analyze(
    _: SilenceRemoverReady,
    body: SilenceRemoverAnalyzeBody,
) -> dict[str, object]:
    """무음 분석을 백그라운드에서 시작하고 즉시 상태를 반환합니다. GET /analyze/status 로 폴링하세요."""
    _resolve_media_path(body.video_path)

    def _run() -> dict[str, object]:
        def on_progress(pct: float, msg: str) -> None:
            silence_remover.report_analyze_progress(pct, msg)

        return _analyze_video_payload(body, on_progress=on_progress)

    job = silence_remover.start_analyze_job(_run)
    return _analyze_status_payload(job)


@router.get("/analyze/status")
def get_analyze_status() -> dict[str, object]:
    return _analyze_status_payload(silence_remover.get_analyze_job_status())


@router.post("/analyze-sync")
async def post_analyze_sync(
    _: SilenceRemoverReady,
    body: SilenceRemoverAnalyzeBody,
) -> dict[str, object]:
    """(레거시) 동기 분석 — 긴 영상에서는 /analyze + /analyze/status 를 사용하세요."""
    _resolve_media_path(body.video_path)

    try:
        return await run_sync(_analyze_video_payload, body)
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except subprocess.TimeoutExpired as e:
        raise HTTPException(
            status_code=504,
            detail=f"FFmpeg 실행이 시간 초과되었습니다: {e}",
        ) from e
    except RuntimeError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/build-edl")
def post_build_edl(
    _: SilenceRemoverReady,
    body: SilenceRemoverBuildEdlBody,
) -> dict[str, object]:
    """분석에 저장된 무음(시작·끝 초)과 편집 FPS로 CMX EDL을 생성합니다."""
    try:
        segs = [
            silence_remover.SilenceSegment(float(s.start_sec), float(s.end_sec))
            for s in body.silences
            if float(s.end_sec) > float(s.start_sec)
        ]
        if not segs:
            raise HTTPException(
                status_code=400,
                detail="무음 구간이 없습니다. 먼저 분석을 실행하세요.",
            )
        fps_frac = silence_remover.resolve_edl_fps_fraction(body.fps, body.fps_rational)
        fps_f = silence_remover._edl_fps_float(fps_frac)
        if body.fps is None or body.fps <= 0:
            raise HTTPException(
                status_code=400,
                detail="편집기 FPS를 입력한 뒤 다시 시도하세요.",
            )
        ttl = (body.title or "AutoCut_Option").strip()[:79] or "AutoCut_Option"
        clip_label = (body.clip_name or "").strip() or None
        media_p = Path(body.video_path) if body.video_path else None
        if media_p is not None and not clip_label and media_p.is_file():
            clip_label = silence_remover.clip_name_from_media_path(media_p)
        vocal_ms: list[tuple[float, float]] | None = None
        if body.vocal_intervals_ms:
            vocal_ms = [
                (float(v.start_ms), float(v.end_ms))
                for v in body.vocal_intervals_ms
                if float(v.end_ms) > float(v.start_ms)
            ]
        if not vocal_ms:
            vocal_ms = silence_remover._vocal_ms_from_silence_segments(
                segs, float(body.duration_sec)
            )
        if not vocal_ms:
            raise HTTPException(status_code=400, detail="말소리 구간이 없습니다.")
        vocal_ms = silence_remover._merge_vocal_intervals_by_min_gap(
            vocal_ms,
            min_gap_sec=float(body.min_silence_sec),
        )
        tc_offset = silence_remover.resolve_source_tc_offset_for_edl(0.0)
        total_frames: int | None = None
        if body.source_tc_offset_sec is not None and body.source_tc_offset_sec > 1e-6:
            tc_offset = silence_remover.resolve_source_tc_offset_for_edl(
                float(body.source_tc_offset_sec)
            )
        if media_p is not None and media_p.is_file():
            try:
                timing = silence_remover.probe_media_edl_timing(media_p, fps=fps_frac)
                tc_offset = silence_remover.resolve_source_tc_offset_for_edl(
                    timing.source_tc_offset_sec
                )
                if timing.total_frames > 0:
                    total_frames = timing.total_frames
            except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired):
                if body.source_tc_offset_sec is not None:
                    tc_offset = silence_remover.resolve_source_tc_offset_for_edl(
                        float(body.source_tc_offset_sec)
                    )
                else:
                    tc_offset = silence_remover.resolve_source_tc_offset_for_edl(0.0)
        fps_export = float(body.fps or fps_f)
        edl_frame_cap = silence_remover._resolve_edl_export_frame_cap(
            total_frames if total_frames > 0 else None,
            intervals_ms=vocal_ms,
            fps_f=fps_export,
            source_tc_offset_sec=tc_offset,
            analysis_duration_sec=float(body.duration_sec),
        )
        edl = silence_remover.create_edl_autocutter(
            vocal_ms,
            fps=fps_export,
            remove_silent=body.remove_silent,
            title=ttl,
            clip_filename=clip_label,
            source_tc_offset_sec=tc_offset,
            total_frames=edl_frame_cap,
            analysis_duration_sec=float(body.duration_sec),
        )
        if not edl.strip() or "말소리 구간이 없습니다" in edl:
            raise HTTPException(
                status_code=400,
                detail="EDL 내용이 비어 있습니다. 무음 분석 설정을 조정한 뒤 다시 시도하세요.",
            )
        return {"format": "cmx3600", "edl": edl, "source_tc_offset_sec": tc_offset}
    except HTTPException:
        raise
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except (RuntimeError, ValueError, OSError, subprocess.TimeoutExpired) as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/build-fcp-xml")
def post_build_fcp_xml(
    _: SilenceRemoverReady,
    body: SilenceRemoverBuildEdlBody,
) -> dict[str, object]:
    """분석에 저장된 무음 구간과 편집 FPS로 FCP7 XMEML을 생성합니다 (EDL과 동일한 무음 탐지·프레임)."""
    try:
        segs = [
            silence_remover.SilenceSegment(float(s.start_sec), float(s.end_sec))
            for s in body.silences
            if float(s.end_sec) > float(s.start_sec)
        ]
        if not segs:
            raise HTTPException(
                status_code=400,
                detail="무음 구간이 없습니다. 먼저 분석을 실행하세요.",
            )
        fps_frac = silence_remover.resolve_edl_fps_fraction(body.fps, body.fps_rational)
        fps_f = silence_remover._edl_fps_float(fps_frac)
        if body.fps is None or body.fps <= 0:
            raise HTTPException(
                status_code=400,
                detail="편집기 FPS를 입력한 뒤 다시 시도하세요.",
            )
        ttl = (body.title or "AutoCut_Option").strip()[:79] or "AutoCut_Option"
        clip_label = (body.clip_name or "").strip() or None
        media_p = Path(body.video_path) if body.video_path else None
        if media_p is not None and not clip_label and media_p.is_file():
            clip_label = silence_remover.clip_name_from_media_path(media_p)
        vocal_ms: list[tuple[float, float]] | None = None
        if body.vocal_intervals_ms:
            vocal_ms = [
                (float(v.start_ms), float(v.end_ms))
                for v in body.vocal_intervals_ms
                if float(v.end_ms) > float(v.start_ms)
            ]
        if not vocal_ms:
            vocal_ms = silence_remover._vocal_ms_from_silence_segments(
                segs, float(body.duration_sec)
            )
        if not vocal_ms:
            raise HTTPException(status_code=400, detail="말소리 구간이 없습니다.")
        vocal_ms = silence_remover._merge_vocal_intervals_by_min_gap(
            vocal_ms,
            min_gap_sec=float(body.min_silence_sec),
        )
        src_path = str(media_p.resolve()) if media_p and media_p.is_file() else None
        fcp_xml = silence_remover.create_fcp7_xml(
            vocal_ms,
            fps=float(body.fps or fps_f),
            remove_silent=body.remove_silent,
            title=ttl,
            clip_filename=clip_label,
            source_file_path=src_path,
            duration_sec=float(body.duration_sec) if body.duration_sec else None,
            silences=segs,
        )
        if not fcp_xml.strip():
            raise HTTPException(
                status_code=400,
                detail="XML 내용이 비어 있습니다. 무음 분석 설정을 조정한 뒤 다시 시도하세요.",
            )
        return {"format": "fcp7_xmeml", "fcp_xml": fcp_xml}
    except HTTPException:
        raise
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except (RuntimeError, ValueError, OSError, subprocess.TimeoutExpired) as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
