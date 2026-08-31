from __future__ import annotations

import shutil
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from common.bin_manager import FFMPEG_EXE, FFPROBE_EXE, ensure_ffmpeg, get_bin_root, is_ffmpeg_ready
from engines import audio_join

router = APIRouter(prefix="/api/tools/audio-join", tags=["audio-join"])


def _ffmpeg_available() -> bool:
    if FFMPEG_EXE.is_file():
        return True
    return shutil.which("ffmpeg") is not None


def _ffprobe_available() -> bool:
    if FFPROBE_EXE.is_file():
        return True
    return shutil.which("ffprobe") is not None


class AudioJoinTrack(BaseModel):
    path: str
    volume: float = Field(1.0, ge=0.0, le=4.0)
    start_sec: float = Field(0.0, ge=0.0)
    end_sec: float | None = Field(None, ge=0.0)


class AudioJoinBody(BaseModel):
    tracks: list[AudioJoinTrack] = Field(..., min_length=1, max_length=40)
    fade_in_sec: float = Field(2.0, ge=0.0, le=30.0)
    fade_out_sec: float = Field(3.0, ge=0.0, le=30.0)
    fade_first_in: bool = False
    fade_last_out: bool = True
    gap_sec: float = Field(0.0, ge=0.0, le=30.0)
    join_mode: Literal["sequential", "crossfade"] = "sequential"
    crossfade_sec: float = Field(2.0, ge=0.05, le=15.0)
    format: Literal["mp3", "wav", "flac", "ogg"] = "mp3"
    sample_rate: int = Field(44100, ge=44100, le=48000)
    normalize: bool = False
    trim_silence: bool = False
    silence_db: float = Field(-40.0, ge=-70.0, le=-20.0)
    timeout_sec: float = Field(7200.0, ge=30.0, le=14400.0)


class AudioJoinProbeBody(BaseModel):
    path: str


class AudioJoinStatus(BaseModel):
    phase: str
    progress: float
    message: str | None = None
    result_path: str | None = None
    duration_sec: float | None = None


@router.get("/readiness")
def get_readiness() -> dict[str, object]:
    return {
        "ok": True,
        "tool": "audio-join",
        "binaries": {
            "ffmpeg": is_ffmpeg_ready() or _ffmpeg_available(),
            "ffprobe": is_ffmpeg_ready() or _ffprobe_available(),
            "bin_dir": str(get_bin_root()),
        },
    }


@router.post("/prepare")
def post_prepare() -> dict[str, object]:
    try:
        ensure_ffmpeg(download_timeout_sec=900.0)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"FFmpeg 설치 실패 ({get_bin_root()}): {exc}") from exc
    ffmpeg_ok = is_ffmpeg_ready() or _ffmpeg_available()
    ffprobe_ok = is_ffmpeg_ready() or _ffprobe_available()
    if not ffmpeg_ok or not ffprobe_ok:
        raise HTTPException(status_code=503, detail=f"FFmpeg가 없습니다: {get_bin_root()}")
    return {
        "ok": True,
        "tool": "audio-join",
        "binaries": {
            "ffmpeg": ffmpeg_ok,
            "ffprobe": ffprobe_ok,
            "bin_dir": str(get_bin_root()),
        },
    }


@router.post("/probe")
def post_probe(body: AudioJoinProbeBody) -> dict[str, float]:
    try:
        path = audio_join.resolve_audio_path(body.path)
        duration = audio_join.probe_duration_sec(path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"duration_sec": duration}


@router.post("/join")
def post_join(body: AudioJoinBody) -> AudioJoinStatus:
    rate = 48000 if int(body.sample_rate) >= 48000 else 44100
    try:
        audio_join.start_join_job(
            [t.model_dump() for t in body.tracks],
            fade_in_sec=body.fade_in_sec,
            fade_out_sec=body.fade_out_sec,
            fade_first_in=body.fade_first_in,
            fade_last_out=body.fade_last_out,
            gap_sec=body.gap_sec,
            join_mode=body.join_mode,
            crossfade_sec=body.crossfade_sec,
            fmt=body.format,
            sample_rate=rate,
            normalize=body.normalize,
            trim_silence=body.trim_silence,
            silence_db=body.silence_db,
            timeout_sec=body.timeout_sec,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return AudioJoinStatus(**get_join_status().model_dump())


@router.get("/join/status")
def get_join_status() -> AudioJoinStatus:
    st = audio_join.get_join_job_status()
    return AudioJoinStatus(
        phase=st.phase,
        progress=st.progress,
        message=st.message,
        result_path=st.result_path,
        duration_sec=st.duration_sec,
    )


@router.get("/download")
def get_download(file_path: str | None = Query(None)) -> FileResponse:
    raw = (file_path or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="file_path 쿼리가 필요합니다.")
    path_obj = Path(raw)
    if not path_obj.is_absolute():
        path_obj = audio_join.WORKSPACE_ROOT / path_obj
    path_obj = path_obj.resolve()
    if not audio_join.is_allowed_media_path(path_obj):
        raise HTTPException(status_code=400, detail="허용되지 않는 다운로드 경로입니다.")
    if not path_obj.is_file():
        raise HTTPException(status_code=404, detail="요청한 파일을 찾을 수 없습니다.")
    return FileResponse(path_obj, filename=path_obj.name, media_type="application/octet-stream")
