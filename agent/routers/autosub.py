"""AutoSubtitle web API (desktop app ported to the browser). Mounted at /api/tools/auto-subtitle/v2.

The browser's `window.api` adapter (web-src/auto-subtitle/src/renderer/src/platform/webApi.ts) maps
each Electron IPC call to one of these routes. Long work runs in threads and is polled.
"""
from __future__ import annotations

import base64
import json
import re
import io
import wave
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response

from engines.autosub import ai_proofread, ai_settings, alignment, export, media, paths, service
from engines import mcp_chat, mcp_registry

router = APIRouter(prefix="/api/tools/auto-subtitle/v2", tags=["auto-subtitle"])


def _bad(error: Exception, status: int = 400) -> HTTPException:
    return HTTPException(status_code=status, detail=str(error))


def _str(body: dict[str, Any], key: str) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(status_code=400, detail=f"'{key}' 값이 필요합니다.")
    return value


@router.get("/mcp/status")
async def get_mcp_status() -> dict[str, Any]:
    state = mcp_registry.status()
    configured = await run_in_threadpool(mcp_chat.configured_clients)
    return {**state, "connected": state["connected"] or bool(configured), "configuredClients": configured}


@router.post("/mcp/chat")
async def post_mcp_chat(body: dict[str, Any] = Body(...)) -> dict[str, str]:
    client = body.get("client")
    instruction = body.get("instruction")
    session_id = _valid_mcp_session(body.get("sessionId"))
    if not isinstance(client, str) or not isinstance(instruction, str):
        raise HTTPException(status_code=400, detail="AI CLI와 요청 문장을 확인해 주세요.")
    try:
        job_id = await run_in_threadpool(mcp_chat.start, client, instruction.strip(), session_id)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return {"jobId": job_id}


@router.get("/mcp/chat")
async def get_mcp_chat(jobId: str = Query(...)) -> dict[str, str]:
    try:
        return mcp_chat.get(jobId)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.post("/mcp/session")
async def post_mcp_session(body: dict[str, Any] = Body(...)) -> dict[str, bool]:
    session_id = _str(body, "sessionId")
    if len(session_id) > 80 or not session_id.replace("-", "").isalnum():
        raise HTTPException(status_code=400, detail="MCP 세션 값이 올바르지 않습니다.")
    mcp_registry.heartbeat(session_id)
    return {"ok": True}


@router.delete("/mcp/session/{session_id}")
async def delete_mcp_session(session_id: str) -> dict[str, bool]:
    mcp_registry.disconnect(session_id)
    return {"ok": True}


def _valid_mcp_session(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,80}", value):
        raise HTTPException(status_code=400, detail="MCP 세션 값이 올바르지 않습니다.")
    return value


@router.post("/mcp/editor")
async def post_mcp_editor(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    session_id = _valid_mcp_session(body.get("sessionId"))
    basis, snapshot = body.get("basis"), body.get("snapshot")
    if not isinstance(basis, str) or not re.fullmatch(r"[a-f0-9]{16}", basis):
        raise HTTPException(status_code=400, detail="자막 기준값이 올바르지 않습니다.")
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("words"), list):
        raise HTTPException(status_code=400, detail="현재 자막 정보가 올바르지 않습니다.")
    words = snapshot["words"]
    if not 1 <= len(words) <= 40_000 or len(json.dumps(snapshot, ensure_ascii=False)) > 8_000_000:
        raise HTTPException(status_code=413, detail="전달할 자막이 너무 큽니다.")
    for index, word in enumerate(words):
        if (not isinstance(word, dict) or word.get("index") != index
                or not isinstance(word.get("id"), str) or not isinstance(word.get("text"), str)
                or len(word["text"]) > ai_proofread.MAX_WORD_LENGTH):
            raise HTTPException(status_code=400, detail="자막 단어 정보가 올바르지 않습니다.")
    audio_path, duration = snapshot.get("audioPath"), snapshot.get("duration")
    if audio_path is not None and (not isinstance(audio_path, str) or len(audio_path) > 4096):
        raise HTTPException(status_code=400, detail="준비된 오디오 경로가 올바르지 않습니다.")
    if duration is not None and (not isinstance(duration, (int, float)) or isinstance(duration, bool) or duration <= 0):
        raise HTTPException(status_code=400, detail="미디어 길이가 올바르지 않습니다.")
    return mcp_registry.publish_editor(session_id, basis, snapshot)


@router.post("/mcp/editor/heartbeat")
async def post_mcp_editor_heartbeat(body: dict[str, Any] = Body(...)) -> dict[str, bool]:
    session_id = _valid_mcp_session(body.get("sessionId"))
    if not mcp_registry.heartbeat_editor(session_id):
        raise HTTPException(status_code=404, detail="AutoSubtitle 페이지 세션이 만료되었습니다.")
    return {"ok": True}


@router.get("/mcp/editor")
async def get_mcp_editor() -> dict[str, Any]:
    try:
        return mcp_registry.active_editor()
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get("/mcp/editor/audio")
async def get_mcp_editor_audio(startSec: float = Query(...), endSec: float = Query(...)) -> Response:
    try:
        active = mcp_registry.active_editor_audio()
        duration = active.get("duration")
        if (not isinstance(duration, (int, float)) or startSec < 0 or endSec <= startSec
                or endSec - startSec > 6 or endSec > duration + 0.01):
            raise ValueError("오디오 구간은 영상 길이 안의 최대 6초로 지정해 주세요.")
        start_frame = round(startSec * media.PCM_SAMPLE_RATE)
        frame_count = max(1, round((endSec - startSec) * media.PCM_SAMPLE_RATE))
        _, pcm = media.read_prepared_pcm(active["audioPath"], [{"startFrame": start_frame, "frameCount": frame_count}])
        wav = io.BytesIO()
        with wave.open(wav, "wb") as output:
            output.setnchannels(2)
            output.setsampwidth(2)
            output.setframerate(media.PCM_SAMPLE_RATE)
            output.writeframes(pcm)
        return Response(content=wav.getvalue(), media_type="audio/wav",
                        headers={"X-Audio-Start-Sec": str(startSec), "X-Audio-End-Sec": str(endSec)})
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="준비된 오디오를 찾지 못했습니다. 영상을 다시 열어 주세요.") from error


@router.post("/mcp/editor/submit")
async def post_mcp_editor_submit(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    revision, corrections, starts = body.get("revision"), body.get("corrections"), body.get("lineStarts")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise HTTPException(status_code=400, detail="자막 revision 값이 올바르지 않습니다.")
    if not isinstance(corrections, list) or len(corrections) > 40_000:
        raise HTTPException(status_code=400, detail="수정 단어 목록이 올바르지 않습니다.")
    if not isinstance(starts, list) or not all(isinstance(x, int) and not isinstance(x, bool) for x in starts):
        raise HTTPException(status_code=400, detail="새 줄 정보가 올바르지 않습니다.")
    try:
        active = mcp_registry.active_editor()
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    if active["revision"] != revision:
        raise HTTPException(status_code=409, detail="자막이 MCP로 전달된 뒤 변경됐습니다. 최신 자막을 다시 가져와 수정해 주세요.")
    word_count = len(active["snapshot"].get("words", []))
    clean_corrections: dict[int, str] = {}
    for item in corrections:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="수정 단어 형식이 올바르지 않습니다.")
        index, text = item.get("index"), item.get("text")
        if (not isinstance(index, int) or isinstance(index, bool) or index < 0 or index >= word_count
                or not isinstance(text, str) or len(text) > ai_proofread.MAX_WORD_LENGTH):
            raise HTTPException(status_code=400, detail="수정 단어 형식이 올바르지 않습니다.")
        clean_corrections[index] = text
    answer = {
        "corrections": [{"id": index, "text": text} for index, text in sorted(clean_corrections.items())],
        "lineStarts": sorted(set(starts)), "uncertain": [], "emphasis": [],
    }
    try:
        return mcp_registry.stage_edit(revision, answer)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.get("/mcp/editor/pending")
async def get_mcp_editor_pending(sessionId: str = Query(...)) -> dict[str, Any]:
    return {"pending": mcp_registry.pending_edit(_valid_mcp_session(sessionId))}


@router.post("/mcp/editor/ack")
async def post_mcp_editor_ack(body: dict[str, Any] = Body(...)) -> dict[str, bool]:
    session_id = _valid_mcp_session(body.get("sessionId"))
    edit_id = body.get("editId")
    if not isinstance(edit_id, str):
        raise HTTPException(status_code=400, detail="수정 요청 ID가 올바르지 않습니다.")
    return {"ok": mcp_registry.acknowledge_edit(session_id, edit_id)}


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


# -- AI proofreading (Claude / ChatGPT) --------------------------------------------------
# These routes hold the user's API keys and spend their API credit. Accept JSON only: a plain
# form/text POST from another site needs no CORS preflight, so it could otherwise reach them.
def _require_json(request: Request) -> None:
    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if content_type != "application/json":
        raise HTTPException(status_code=415, detail="JSON 요청만 받습니다.")


def _provider(value: Any) -> str:
    try:
        return ai_settings.check_provider(value)
    except ValueError as error:
        raise _bad(error) from error


@router.get("/ai/settings")
async def get_ai_settings() -> dict[str, Any]:
    return await run_in_threadpool(ai_settings.status)


@router.put("/ai/key")
async def put_ai_key(request: Request, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    _require_json(request)
    provider = _provider(body.get("provider"))
    try:
        key = ai_settings.normalize_key(provider, body.get("apiKey"))
        await run_in_threadpool(ai_proofread.test_key, provider, key, ai_settings.model(provider))
        await run_in_threadpool(ai_settings.set_api_key, provider, key)
    except (ValueError, ai_proofread.ProofreadError, RuntimeError) as error:
        raise _bad(error) from error
    return await run_in_threadpool(ai_settings.status)


@router.delete("/ai/key")
async def delete_ai_key(provider: str = Query(...)) -> dict[str, Any]:
    await run_in_threadpool(ai_settings.delete_api_key, _provider(provider))
    return await run_in_threadpool(ai_settings.status)


@router.put("/ai/provider")
async def put_ai_provider(request: Request, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Which AI to use, and optionally that AI's model (low-cost default or higher quality)."""
    _require_json(request)
    provider = _provider(body.get("provider"))
    try:
        if body.get("model") is not None:
            await run_in_threadpool(ai_settings.set_model, provider, body.get("model"))
        await run_in_threadpool(ai_settings.set_provider, provider)
    except (ValueError, OSError) as error:
        raise _bad(error) from error
    return await run_in_threadpool(ai_settings.status)


@router.post("/ai/test")
async def post_ai_test(request: Request, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    _require_json(request)
    provider = _provider(body.get("provider"))
    key = await run_in_threadpool(ai_settings.api_key, provider)
    if not key:
        raise HTTPException(status_code=400, detail="등록된 API 키가 없습니다.")
    try:
        await run_in_threadpool(ai_proofread.test_key, provider, key, ai_settings.model(provider))
    except ai_proofread.ProofreadError as error:
        raise _bad(error) from error
    return {"ok": True}


@router.put("/ai/glossary")
async def put_ai_glossary(request: Request, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    _require_json(request)
    try:
        terms = ai_settings.normalize_glossary(body.get("terms"))
        await run_in_threadpool(ai_settings.set_glossary, terms)
    except (ValueError, OSError) as error:
        raise _bad(error) from error
    return await run_in_threadpool(ai_settings.status)


@router.post("/ai/proofread")
async def post_ai_proofread(request: Request, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    _require_json(request)
    try:
        job_id = await run_in_threadpool(ai_proofread.start, body)
    except (ValueError, ai_proofread.ProofreadError) as error:
        raise _bad(error) from error
    return {"jobId": job_id}


@router.get("/ai/proofread")
async def get_ai_proofread(jobId: str = Query(...), wait: float = Query(0.0, ge=0, le=10)) -> dict[str, Any]:
    return await run_in_threadpool(ai_proofread.status, jobId, wait)


@router.post("/ai/proofread/cancel")
async def post_ai_proofread_cancel(request: Request, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    _require_json(request)
    ai_proofread.cancel(_str(body, "jobId"))
    return {"ok": True}
