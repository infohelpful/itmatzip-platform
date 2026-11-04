"""AutoSubtitle web API (desktop app ported to the browser). Mounted at /api/tools/auto-subtitle/v2.

The browser's `window.api` adapter (web-src/auto-subtitle/src/renderer/src/platform/webApi.ts) maps
each Electron IPC call to one of these routes. Long work runs in threads and is polled.
"""
from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response

from engines.autosub import alignment, export, media, paths, service

router = APIRouter(prefix="/api/tools/auto-subtitle/v2", tags=["auto-subtitle"])


def _bad(error: Exception, status: int = 400) -> HTTPException:
    return HTTPException(status_code=status, detail=str(error))


def _str(body: dict[str, Any], key: str) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(status_code=400, detail=f"'{key}' 값이 필요합니다.")
    return value


# -- engine ------------------------------------------------------------------------------
@router.get("/deps")
async def get_deps() -> dict[str, Any]:
    return await run_in_threadpool(service.deps_status)


@router.post("/deps/prepare")
async def post_deps_prepare() -> dict[str, Any]:
    try:
        return service.start_prepare()
    except RuntimeError as error:
        raise _bad(error, 409) from error


@router.get("/deps/prepare")
async def get_deps_prepare() -> dict[str, Any]:
    return service.prepare_state()


@router.get("/ffmpeg")
async def get_ffmpeg() -> dict[str, Any]:
    ff = paths.ffmpeg_paths()
    # Video export (and its ProRes/QTRLE probe) is not available on the web yet.
    return {"ffmpegPath": ff[0] if ff else "", "isProResAvailable": False, "isQtrleAvailable": False}


@router.get("/gpu")
async def get_gpu() -> dict[str, Any]:
    return await run_in_threadpool(service.gpu_status)


@router.post("/gpu/install")
async def post_gpu_install() -> dict[str, Any]:
    try:
        return service.start_gpu_install()
    except RuntimeError as error:
        raise _bad(error, 409) from error


@router.get("/gpu/install")
async def get_gpu_install() -> dict[str, Any]:
    return service.gpu_install_state()


# -- media -------------------------------------------------------------------------------
@router.post("/media/register")
async def post_media_register(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Validate a path the user picked (dialog or project file) so it may be served."""
    try:
        path = media.existing_media_file(_str(body, "path"))
    except (OSError, ValueError) as error:
        raise _bad(error) from error
    return {"path": str(path)}


@router.post("/media/prepare")
async def post_media_prepare(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        media.start_prepare(_str(body, "path"), _str(body, "requestId"))
    except (OSError, ValueError) as error:
        return {"state": "done", "result": {"ok": False, "reason": str(error)}}
    return {"state": "running"}


@router.get("/media/prepare")
async def get_media_prepare(requestId: str = Query(...), wait: float = Query(0.0, ge=0, le=10)) -> dict[str, Any]:
    return await run_in_threadpool(media.prepare_status, requestId, wait)


@router.post("/media/prepare/cancel")
async def post_media_prepare_cancel(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    media.cancel_prepare(_str(body, "requestId"))
    return {"ok": True}


@router.post("/media/pcm")
async def post_media_pcm(body: dict[str, Any] = Body(...)) -> Response:
    try:
        total, pcm = await run_in_threadpool(media.read_prepared_pcm, _str(body, "path"), body.get("ranges"))
    except (OSError, ValueError) as error:
        return Response(content=str(error).encode("utf-8"), status_code=422, media_type="text/plain; charset=utf-8")
    return Response(content=pcm, media_type="application/octet-stream",
                    headers={"X-Pcm-Total-Frames": str(total), "X-Pcm-Sample-Rate": "48000",
                             "X-Pcm-Channels": "2", "Access-Control-Expose-Headers": "X-Pcm-Total-Frames"})


@router.post("/media/fingerprint")
async def post_media_fingerprint(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        return {"ok": True, "fingerprint": await run_in_threadpool(media.fingerprint_media, _str(body, "path"))}
    except (OSError, ValueError, RuntimeError) as error:
        return {"ok": False, "reason": str(error)}


def decode_path_token(token: str) -> str:
    padded = token + "=" * (-len(token) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")


@router.get("/media/file/{token}/{name}")
async def get_media_file(token: str, name: str) -> FileResponse:
    """Serve a registered file with HTTP Range support (<video> seeking, peaks JSON)."""
    try:
        path = Path(decode_path_token(token))
    except ValueError as error:
        raise _bad(error) from error
    if not media.is_servable(path) or not path.is_file():
        raise HTTPException(status_code=404, detail="등록되지 않았거나 없는 파일입니다.")
    return FileResponse(path, headers={"Cache-Control": "no-store"})


# -- waveform ----------------------------------------------------------------------------
@router.post("/waveform/cache-path")
async def post_waveform_cache_path(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        return await run_in_threadpool(media.waveform_cache_json_path, _str(body, "path"))
    except (OSError, ValueError) as error:
        return {"ok": False, "reason": str(error)}


@router.post("/waveform/read")
async def post_waveform_read(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return await run_in_threadpool(media.read_peaks_json, _str(body, "path"))


@router.post("/waveform/cancel")
async def post_waveform_cancel(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    service.cancel_waveform(_str(body, "requestId"))
    return {"ok": True}


@router.post("/sidecar")
async def post_sidecar(body: dict[str, Any] = Body(...)) -> Any:
    params = body.get("params") if isinstance(body.get("params"), dict) else {}
    try:
        return await run_in_threadpool(service.sidecar_call, _str(body, "method"), params)
    except PermissionError as error:
        raise _bad(error, 403) from error


# -- transcription -----------------------------------------------------------------------
@router.post("/transcribe")
async def post_transcribe(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    mode = body.get("alignmentMode")
    try:
        service.start_transcription(_str(body, "path"), mode if isinstance(mode, str) else None, _str(body, "jobId"))
    except (OSError, ValueError) as error:
        return {"jobId": body.get("jobId"), "done": True,
                "events": [{"seq": 0, "type": "error", "payload": {"message": str(error)}}]}
    return {"jobId": body["jobId"], "done": False, "events": []}


@router.get("/transcribe/events")
async def get_transcribe_events(jobId: str = Query(...), since: int = Query(0, ge=0)) -> dict[str, Any]:
    return service.transcribe_events(jobId, since)


@router.post("/transcribe/cancel")
async def post_transcribe_cancel() -> dict[str, Any]:
    await run_in_threadpool(service.cancel_transcription)
    return {"ok": True}


# -- precise alignment (WhisperX) --------------------------------------------------------
@router.get("/alignment")
async def get_alignment() -> dict[str, Any]:
    return await run_in_threadpool(alignment.status)


@router.post("/alignment/install")
async def post_alignment_install() -> dict[str, Any]:
    try:
        return alignment.start_install()
    except RuntimeError as error:
        raise _bad(error, 409) from error


@router.get("/alignment/install")
async def get_alignment_install() -> dict[str, Any]:
    return alignment.install_state()


@router.post("/realign")
async def post_realign(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return await run_in_threadpool(service.start_realign, body)


@router.get("/realign")
async def get_realign(requestId: str = Query(...), wait: float = Query(0.0, ge=0, le=10)) -> dict[str, Any]:
    return await run_in_threadpool(service.realign_status, requestId, wait)


@router.post("/realign/cancel")
async def post_realign_cancel(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    await run_in_threadpool(service.cancel_realign, _str(body, "requestId"))
    return {"ok": True}


# -- export (video burn-in, MP3/WAV) -----------------------------------------------------
_MAX_STATE_PNG_BYTES = 32 * 1024 * 1024


@router.post("/export/audio")
async def post_export_audio(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    cuts = body.get("cutRanges") if isinstance(body.get("cutRanges"), list) else []
    try:
        return await run_in_threadpool(export.start_audio, _str(body, "inputPath"), _str(body, "outDir"),
                                       _str(body, "format"), cuts)
    except (OSError, ValueError, RuntimeError) as error:
        raise _bad(error) from error


@router.post("/export/video")
async def post_export_video(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        return await run_in_threadpool(export.start_video, _str(body, "inputPath"), _str(body, "outDir"))
    except (OSError, ValueError, RuntimeError) as error:
        raise _bad(error) from error


@router.put("/export/video/{job_id}/state/{index}")
async def put_export_state(job_id: str, index: int, request: Request) -> dict[str, Any]:
    data = await request.body()
    if len(data) > _MAX_STATE_PNG_BYTES:
        raise HTTPException(status_code=413, detail="자막 이미지가 너무 큽니다.")
    try:
        await run_in_threadpool(export.put_state, job_id, index, data)
    except (KeyError, ValueError) as error:
        raise _bad(error) from error
    return {"ok": True}


@router.post("/export/video/{job_id}/encode")
async def post_export_encode(job_id: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    schedule = body.get("schedule") if isinstance(body.get("schedule"), list) else []
    clips = body.get("clips") if isinstance(body.get("clips"), list) else []
    try:
        await run_in_threadpool(export.start_encode, job_id, schedule, clips)
    except (KeyError, ValueError, TypeError) as error:
        raise _bad(error) from error
    return {"ok": True}


@router.get("/export/downloads-dir")
async def get_export_downloads_dir() -> dict[str, Any]:
    """Default save folder for the export page (no folder picker)."""
    try:
        return {"path": str(await run_in_threadpool(export.downloads_dir))}
    except OSError as error:
        raise _bad(error, 500) from error


@router.post("/export/text")
async def post_export_text(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    text = body.get("text")
    if not isinstance(text, str):
        raise HTTPException(status_code=400, detail="'text' 값이 필요합니다.")
    input_path = body.get("inputPath") if isinstance(body.get("inputPath"), str) else ""
    try:
        target = await run_in_threadpool(export.save_text, input_path, _str(body, "outDir"), _str(body, "format"), text)
    except (OSError, ValueError) as error:
        raise _bad(error) from error
    return {"outputPath": str(target)}


@router.get("/export/{job_id}")
async def get_export(job_id: str) -> dict[str, Any]:
    try:
        return export.job_status(job_id)
    except KeyError as error:
        raise _bad(error, 404) from error


@router.post("/export/{job_id}/cancel")
async def post_export_cancel(job_id: str) -> dict[str, Any]:
    export.cancel_job(job_id)
    return {"ok": True}


@router.post("/export/show-in-folder")
async def post_export_show_in_folder(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    shown = await run_in_threadpool(export.show_in_folder, _str(body, "path"))
    return {"ok": True} if shown else {"ok": False, "reason": "이번에 내보낸 파일만 폴더에서 열 수 있습니다."}
