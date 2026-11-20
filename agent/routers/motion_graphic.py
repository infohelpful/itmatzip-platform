"""모션그래픽도구 FastAPI 라우터 — docs/motion-graphic-spec.md.

흐름: 영상+SRT(project/init) → 스타일 프리셋 + 설계하기(design) → 수정 요청(design/edit) → 설계대로 적용(design/apply)
→ MP4 내보내기(render, 적용된 설계서가 있어야만).

기존 플랫폼 규칙대로 prefix 는 /api/tools/motion-graphic (브라우저 → Go :19876 → 여기 :19877).
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from common.media_paths import normalize_media_path
from engines import motion_graphic as mg
from engines import motion_graphic_ai as mg_ai
from engines import motion_graphic_design as mg_design
from engines import motion_graphic_styles as mg_styles
from engines import motion_graphic_ctx as mgx

router = APIRouter(prefix="/api/tools/motion-graphic", tags=["motion-graphic"])

_VIDEO_EXT = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}
_VIDEO_TYPES = {".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
                ".mkv": "video/x-matroska", ".avi": "video/x-msvideo"}


# ── 준비 ───────────────────────────────────────────────────────────────

class PrepareStatus(BaseModel):
    phase: str
    progress: float
    message: str | None = None
    step: str | None = None
    detail: str | None = None


_prepare_state = PrepareStatus(phase="not_started", progress=0.0, message="모션그래픽 엔진 준비를 시작하세요.")
_prepare_lock = threading.RLock()
_prepare_thread: threading.Thread | None = None


def _set_prepare(phase: str, progress: float, message: str | None = None, *, step: str | None = None,
                 detail: str | None = None) -> None:
    with _prepare_lock:
        _prepare_state.phase = phase
        _prepare_state.progress = progress
        _prepare_state.message = message
        _prepare_state.step = step
        _prepare_state.detail = detail


def _run_prepare() -> None:
    def report(pct: float, step: str, detail: str = "") -> None:
        phase = "downloading" if ("다운로드" in detail or "Chrome" in detail) else "installing_dependencies"
        _set_prepare(phase, float(pct), f"{step} — {detail}" if detail else step, step=step, detail=detail or None)

    try:
        mg.prepare(report)
        _set_prepare("ready", 100.0, "모션그래픽 엔진 준비가 완료되었습니다.", step="완료",
                     detail=f"Node {mg.NODE_VERSION} · Premotion(Remotion) · {mg.runtime_root()}")
    except Exception as exc:  # noqa: BLE001
        _set_prepare("failed", 0.0, f"준비 중 오류가 발생했습니다: {exc}", step="오류", detail=str(exc))


@router.get("/readiness")
def get_readiness() -> dict[str, Any]:
    try:
        r = mg.readiness()
        return {"ok": True, "tool": "motion-graphic", "binaries": r, "nvenc": None}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "tool": "motion-graphic", "error": str(exc),
                "binaries": {"ffmpeg": False, "node": False, "premotion_core": False, "browser": False, "ready": False}}


@router.post("/prepare")
def post_prepare(force: bool = Query(False)) -> PrepareStatus:
    global _prepare_thread
    with _prepare_lock:
        if _prepare_thread is not None and _prepare_thread.is_alive():
            return _prepare_state.model_copy()
        if not force and mg.is_ready():
            _set_prepare("ready", 100.0, "모션그래픽 엔진이 이미 준비되어 있습니다.", step="완료")
            return _prepare_state.model_copy()
        _set_prepare("installing_dependencies", 2.0, "모션그래픽 엔진 준비를 시작합니다…", step="설치 시작",
                     detail="FFmpeg · Node.js 포터블 · Premotion(Remotion)")
        _prepare_thread = threading.Thread(target=_run_prepare, daemon=True, name="mg-prepare")
        _prepare_thread.start()
        return _prepare_state.model_copy()


@router.get("/prepare/status")
def get_prepare_status() -> PrepareStatus:
    with _prepare_lock:
        return _prepare_state.model_copy()


# ── 프로젝트 ───────────────────────────────────────────────────────────

class ProjectInitBody(BaseModel):
    video_path: str = Field(..., min_length=1, description="로컬 MP4 경로")
    srt_path: str | None = Field(None, description="로컬 SRT 경로 (srt_text 와 둘 중 하나)")
    srt_text: str | None = Field(None, max_length=4_000_000, description="SRT 본문 (브라우저에서 읽은 내용)")
    srt_name: str | None = Field(None, max_length=200)


def _resolve_file(raw: str, allowed: set[str], label: str) -> Path:
    path = Path(normalize_media_path(raw))
    if not path.is_absolute() or not path.is_file():
        raise HTTPException(status_code=400, detail=f"{label} 파일을 찾을 수 없습니다: {raw}")
    if path.suffix.lower() not in allowed:
        raise HTTPException(status_code=415, detail=f"지원하지 않는 {label} 형식입니다: {path.suffix}")
    return path


def _read_srt(path: Path) -> str:
    data = path.read_bytes()
    if len(data) > 4_000_000:
        raise HTTPException(status_code=413, detail="SRT 파일이 너무 큽니다.")
    for enc in ("utf-8-sig", "cp949", "utf-16"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    raise HTTPException(status_code=400, detail="SRT 인코딩을 읽지 못했습니다 (UTF-8 권장).")


@router.post("/project/init")
def post_project_init(body: ProjectInitBody) -> dict[str, Any]:
    video = _resolve_file(body.video_path, _VIDEO_EXT, "영상")
    srt_name = body.srt_name or "source.srt"
    if body.srt_text and body.srt_text.strip():
        srt_text = body.srt_text
    elif body.srt_path:
        srt_file = _resolve_file(body.srt_path, {".srt", ".vtt"}, "자막")
        srt_text = _read_srt(srt_file)
        srt_name = srt_file.name
    else:
        sibling = next((video.with_suffix(ext) for ext in (".srt", ".SRT") if video.with_suffix(ext).is_file()), None)
        if sibling is None:
            raise HTTPException(status_code=400, detail="SRT 자막을 선택해 주세요 (영상과 같은 이름의 .srt 도 자동 인식).")
        srt_text = _read_srt(sibling)
        srt_name = sibling.name
    try:
        pid = mg.create_project(video, srt_text, srt_name)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"project_id": pid, "phase": "preprocessing"}


@router.get("/projects")
def get_projects(limit: int = Query(20, ge=1, le=100)) -> dict[str, Any]:
    return {"projects": mg.list_projects(limit), "active": mg.active_project()}


def _project_or_404(pid: str) -> str:
    try:
        if not mg.project_exists(pid):
            raise HTTPException(status_code=404, detail=f"프로젝트를 찾을 수 없습니다: {pid}")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return pid


@router.get("/project/{pid}")
def get_project(pid: str, include: str = Query("", description="subs,waveform 콤마 구분")) -> dict[str, Any]:
    _project_or_404(pid)
    meta = mg.load_project(pid)
    out: dict[str, Any] = {"project": meta, "design": mg_design.load_design(pid), "job": mg_design.project_status(pid)}
    wants = {x.strip() for x in include.split(",") if x.strip()}
    if meta.get("phase") == "ready":
        analysis = mg._read_json(mg.project_dir(pid) / "analysis.json")
        if isinstance(analysis, dict):
            out["analysis"] = {k: analysis.get(k) for k in ("fps", "duration_sec", "duration_frames", "static_runs",
                                                            "logo_candidates", "motion", "sample_fps", "width", "height")}
            if "subs" in wants:
                out["subs"] = analysis.get("subs")
        if "waveform" in wants:
            out["waveform"] = mg._read_json(mg.project_dir(pid) / "waveform.json", {"levels": []})
    return out


@router.get("/project/{pid}/revision")
def get_project_revision(pid: str) -> dict[str, Any]:
    """미리보기 폴링용 — 설계서 revision 과 진행 중 AI 작업."""
    _project_or_404(pid)
    meta = mg.load_project(pid)
    design = mg_design.load_design(pid)
    return {"revision": (design or {}).get("revision", 0), "phase": meta.get("phase"), "progress": meta.get("progress"),
            "message": meta.get("message"), "job": mg_design.project_status(pid)}


@router.post("/project/{pid}/open")
def post_project_open(pid: str) -> dict[str, Any]:
    _project_or_404(pid)
    mg.set_active_project(pid)
    return {"ok": True, "project_id": pid}


# ── 설계 ───────────────────────────────────────────────────────────────

@router.get("/catalog")
def get_catalog() -> dict[str, Any]:
    """스타일 프리셋 · FULL 장면 템플릿 · OVERLAY 효과 목록 (mg-core.js 와 같은 내용)."""
    return mg_design.catalog()


@router.get("/styles")
def get_styles(exclude: str | None = Query(None)) -> dict[str, Any]:
    """작업 내역: 지금까지 만든 프로젝트의 디자인(색·배경·움직임). 열린 프로젝트(exclude)는 뺀다."""
    return {"styles": mg_styles.list_styles(exclude)}


@router.get("/ai/clients")
def get_ai_clients() -> dict[str, Any]:
    return {"clients": mg_ai.clients_status()}


class DesignBody(BaseModel):
    client: str
    style: str | None = None   # 보관함 디자인 id. 없으면 새 디자인
    media: str = "photo"        # 소재 방식: photo(실사 사진+로고) | logo(로고만) | emoji(웹 다운로드 없음)
    directives: str = Field("", max_length=20000)
    instruction: str = Field("", max_length=2000)


class EditBody(BaseModel):
    client: str
    request: str = Field(..., max_length=1000)
    segment_id: str | None = None
    frame: int | None = None
    fetch_more: bool = False         # 자료(이미지·로고)가 부실하면 웹에서 더 받아 보강
    detail: bool = False             # 구간 다시 설계: 더 촘촘하게(장면·키워드·효과)
    start_frame: int | None = None   # 타임라인에서 고른 시간 범위 (원본 fps 프레임)
    end_frame: int | None = None


class TypeBody(BaseModel):
    type: str


@router.post("/project/{pid}/design")
def post_design(pid: str, body: DesignBody) -> dict[str, Any]:
    _project_or_404(pid)
    try:
        return mg_design.start(pid, body.client, body.style, body.directives, body.instruction, body.media)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/project/{pid}/design/edit")
def post_design_edit(pid: str, body: EditBody) -> dict[str, Any]:
    _project_or_404(pid)
    try:
        return mg_design.start_edit(pid, body.client, body.request, body.segment_id, body.frame, body.start_frame, body.end_frame, body.fetch_more, body.detail)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class UserImageBody(BaseModel):
    name: str = Field(..., max_length=200)
    data: str = Field(..., max_length=16 * 1024 * 1024)  # base64


class PlaceImageBody(BaseModel):
    file: str = Field(..., max_length=200)
    sub: int
    sub_end: int | None = None
    caption: str = Field("", max_length=60)


@router.get("/project/{pid}/user-images")
def get_user_images(pid: str) -> dict[str, Any]:
    _project_or_404(pid)
    return {"items": mg_design.list_user_images(pid)}


@router.post("/project/{pid}/user-images")
def post_user_image(pid: str, body: UserImageBody) -> dict[str, Any]:
    _project_or_404(pid)
    import base64
    import binascii
    try:
        return mg_design.save_user_image(pid, body.name, base64.b64decode(body.data, validate=True))
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/project/{pid}/user-images/{name}")
def delete_user_image(pid: str, name: str) -> dict[str, Any]:
    _project_or_404(pid)
    return {"ok": mg_design.delete_user_image(pid, name)}


@router.post("/project/{pid}/design/place-image")
def post_place_image(pid: str, body: PlaceImageBody) -> dict[str, Any]:
    _project_or_404(pid)
    try:
        return {"design": mg_design.place_user_image(pid, body.file, body.sub, body.sub_end, body.caption)}
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/project/{pid}/design/segment/{sid}/type")
def post_design_type(pid: str, sid: str, body: TypeBody) -> dict[str, Any]:
    _project_or_404(pid)
    try:
        return {"design": mg_design.set_type(pid, sid, body.type)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class SegmentBody(BaseModel):
    segment: dict[str, Any]


@router.post("/project/{pid}/design/segment/{sid}")
def post_design_segment(pid: str, sid: str, body: SegmentBody) -> dict[str, Any]:
    """구간 하나를 그대로 저장 (MCP·외부 편집용). 검증·하이라이트 위치·추적은 서버가 다시 한다."""
    _project_or_404(pid)
    try:
        return {"design": mg_design.save_segment(pid, sid, body.segment)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/project/{pid}/design/apply")
def post_design_apply(pid: str, value: bool = Query(True)) -> dict[str, Any]:
    _project_or_404(pid)
    try:
        return {"design": mg_design.apply(pid, value)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/project/{pid}/design/thumb/{sid}")
def get_design_thumb(pid: str, sid: str) -> FileResponse:
    _project_or_404(pid)
    path = mg_design.thumb_path(pid, sid)
    if not path:
        raise HTTPException(status_code=404, detail="썸네일이 없습니다.")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.get("/design/{job_id}")
def get_design_job(job_id: str) -> dict[str, Any]:
    try:
        return mg_design.status(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="AI 작업을 찾을 수 없습니다.") from exc


@router.post("/design/{job_id}/cancel")
def post_design_cancel(job_id: str) -> dict[str, Any]:
    return {"cancelled": mg_design.cancel(job_id)}


_ASSET_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
                ".svg": "image/svg+xml", ".avif": "image/avif"}


@router.get("/assets/{pid}/{name:path}")
def get_asset(pid: str, name: str) -> FileResponse:
    """웹에서 받은 로고·사진 (프로젝트 assets 폴더 안의 이미지 파일만)."""
    _project_or_404(pid)
    root = (mg.project_dir(pid) / "assets").resolve()
    path = (root / name).resolve()
    if root not in path.parents or not path.is_file() or path.suffix.lower() not in _ASSET_TYPES:
        raise HTTPException(status_code=404, detail="에셋을 찾을 수 없습니다.")
    return FileResponse(path, media_type=_ASSET_TYPES[path.suffix.lower()], headers={"Cache-Control": "max-age=3600"})


@router.get("/media/{pid}")
def get_media(pid: str) -> FileResponse:
    """미리보기용 원본 영상 (Range 지원). 프로젝트에 등록된 파일만 내보낸다."""
    _project_or_404(pid)
    path = Path(mg.load_project(pid)["video_path"])
    if not path.is_file():
        raise HTTPException(status_code=404, detail="원본 영상이 이동되었거나 삭제되었습니다.")
    return FileResponse(path, media_type=_VIDEO_TYPES.get(path.suffix.lower(), "video/mp4"),
                        headers={"Cache-Control": "no-store"})


# ── 렌더 ───────────────────────────────────────────────────────────────

class RenderBody(BaseModel):
    project_id: str


@router.post("/render")
def post_render(body: RenderBody, request: Request) -> dict[str, Any]:
    _project_or_404(body.project_id)
    # Remotion 이 원본을 읽을 주소 — 이 요청이 들어온 같은 서버의 /media (Range 지원)
    media_url = f"{str(request.base_url).rstrip('/')}/api/tools/motion-graphic/media/{body.project_id}"
    try:
        return mg.start_render(body.project_id, media_url)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/render/{job_id}")
def get_render(job_id: str) -> dict[str, Any]:
    try:
        return mg.render_status(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc.args[0])) from exc


@router.post("/render/{job_id}/cancel")
def post_render_cancel(job_id: str) -> dict[str, Any]:
    return {"ok": mg.cancel_render(job_id)}


@router.get("/download")
def get_download(project_id: str = Query(...)) -> FileResponse:
    _project_or_404(project_id)
    path = mg.project_dir(project_id) / "output.mp4"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="내보낸 MP4 가 없습니다. 먼저 MP4 내보내기를 완료해 주세요.")
    meta = mg.load_project(project_id)
    stem = Path(meta.get("video_name") or "video").stem
    return FileResponse(path, media_type="video/mp4", filename=f"{stem}-motion.mp4")


@router.post("/project/{pid}/open-dir")
def post_open_project_dir(pid: str) -> dict[str, Any]:
    """프로젝트 폴더 열기 (탐색기)"""
    _project_or_404(pid)
    return {"ok": mg.open_project_folder(pid), "path": str(mg.project_dir(pid))}


@router.post("/open-folder")
def post_open_folder(body: RenderBody) -> dict[str, Any]:
    _project_or_404(body.project_id)
    return {"ok": mg.open_output_folder(body.project_id)}
