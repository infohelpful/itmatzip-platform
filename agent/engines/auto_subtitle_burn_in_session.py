"""웹에서 업로드한 자막 프레임 → 단일 패스 번인 작업."""

from __future__ import annotations

import json
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from engines import auto_subtitle
from engines.auto_subtitle_burn_in import (
    estimate_overlay_duration_sec,
    get_subtitle_render_dimensions,
    run_single_pass_subtitle_burn_in,
    select_h264_encoder,
)
from engines.auto_subtitle_export import (
    _set_export_job,
    probe_video_dimensions,
)
from engines.auto_subtitle_formats import normalize_cut_ranges

_session_lock = threading.RLock()
_sessions: dict[str, "BurnInSession"] = {}


@dataclass
class BurnInSession:
    job_id: str
    job_dir: Path
    media_path: Path
    output_path: Path
    full_w: int
    full_h: int
    render_w: int
    render_h: int
    duration_sec: float
    frame_meta: dict[int, dict[str, float]] = field(default_factory=dict)


def create_session(video_path: Path) -> BurnInSession:
    auto_subtitle.ensure_workspace()
    media = video_path.resolve()
    if not media.is_file():
        raise FileNotFoundError(f"영상 파일을 찾을 수 없습니다: {media}")
    full_w, full_h, dur = probe_video_dimensions(media)
    render_w, render_h = get_subtitle_render_dimensions(full_w, full_h)
    job_id = uuid.uuid4().hex[:12]
    job_dir = auto_subtitle.WORKSPACE_ROOT / f"burn-{job_id}"
    job_dir.mkdir(parents=True, exist_ok=True)
    out = job_dir / f"{media.stem}_AutoSubtitle.mp4"
    sess = BurnInSession(
        job_id=job_id,
        job_dir=job_dir,
        media_path=media,
        output_path=out,
        full_w=full_w,
        full_h=full_h,
        render_w=render_w,
        render_h=render_h,
        duration_sec=dur,
    )
    with _session_lock:
        _sessions[job_id] = sess
    return sess


def get_session(job_id: str) -> BurnInSession:
    with _session_lock:
        sess = _sessions.get(job_id)
    if sess is None:
        raise KeyError(f"burn-in 세션을 찾을 수 없습니다: {job_id}")
    return sess


def _decode_frame_payload(payload: bytes, render_w: int, render_h: int) -> bytes:
    expected = render_w * render_h * 4
    if payload[:8] == b"\x89PNG\r\n\x1a\n":
        from io import BytesIO

        from PIL import Image

        img = Image.open(BytesIO(payload)).convert("RGBA")
        if img.size != (render_w, render_h):
            img = img.resize((render_w, render_h), Image.Resampling.LANCZOS)
        raw = img.tobytes()
        if len(raw) != expected:
            raise ValueError(f"PNG 디코드 크기 불일치: {len(raw)} (기대 {expected})")
        return raw
    if len(payload) != expected:
        raise ValueError(f"프레임 크기 불일치: {len(payload)} (기대 {expected})")
    return payload


def save_frame(job_id: str, index: int, start: float, end: float, payload: bytes) -> None:
    sess = get_session(job_id)
    if index < 0:
        raise ValueError("index must be >= 0")
    rgba = _decode_frame_payload(payload, sess.render_w, sess.render_h)
    frame_path = sess.job_dir / f"frame_{index:04d}.rgba"
    frame_path.write_bytes(rgba)
    meta = {"start": float(start), "end": float(end)}
    (sess.job_dir / f"frame_{index:04d}.meta.json").write_text(
        json.dumps(meta, ensure_ascii=False),
        encoding="utf-8",
    )
    with _session_lock:
        sess.frame_meta[index] = meta


def _ordered_frame_paths_and_timing(sess: BurnInSession) -> tuple[list[Path], list[dict[str, float]]]:
    indices = sorted(sess.frame_meta.keys())
    if not indices:
        raise ValueError("업로드된 자막 프레임이 없습니다.")
    paths: list[Path] = []
    timing: list[dict[str, float]] = []
    for i in indices:
        meta = sess.frame_meta[i]
        path = sess.job_dir / f"frame_{i:04d}.rgba"
        if not path.is_file():
            raise FileNotFoundError(f"프레임 파일 없음: {path}")
        paths.append(path)
        timing.append({"start": meta["start"], "end": meta["end"]})
    return paths, timing


def _burn_in_worker(
    sess: BurnInSession,
    *,
    cut_ranges: list[dict[str, Any]] | None,
) -> None:
    try:
        def report(pct: float, msg: str) -> None:
            _set_export_job("running", pct, msg, fmt="video")

        report(8.0, "자막 프레임 준비…")
        frame_paths, timing = _ordered_frame_paths_and_timing(sess)
        mapped_end = max((t["end"] for t in timing), default=1.0)
        cuts = normalize_cut_ranges(cut_ranges)
        overlay_dur = estimate_overlay_duration_sec(sess.duration_sec, cuts, mapped_end)
        encoder = select_h264_encoder()

        report(28.0, "FFmpeg 자막 번인 준비…")
        run_single_pass_subtitle_burn_in(
            ffmpeg_path=None,
            input_video_path=sess.media_path,
            output_path=sess.output_path,
            full_video_width=sess.full_w,
            full_video_height=sess.full_h,
            render_width=sess.render_w,
            render_height=sess.render_h,
            overlay_duration_sec=overlay_dur,
            frame_paths=frame_paths,
            timing=timing,
            h264_encoder=encoder,
            on_progress=report,
        )
        _set_export_job(
            "completed",
            100.0,
            "영상보내기 완료",
            result_path=str(sess.output_path),
            fmt="video",
        )
    except Exception as exc:
        _set_export_job("failed", 0.0, str(exc), error=str(exc), fmt="video")
    finally:
        with _session_lock:
            _sessions.pop(sess.job_id, None)


def finish_and_start_export(
    job_id: str,
    *,
    cut_ranges: list[dict[str, Any]] | None = None,
) -> None:
    from engines import auto_subtitle_runtime

    sess = get_session(job_id)
    if not sess.frame_meta:
        raise ValueError("업로드된 자막 프레임이 없습니다.")

    auto_subtitle_runtime.try_begin_job("export")
    _set_export_job("queued", 0.0, "영상 번인 대기…", fmt="video")

    def _target() -> None:
        try:
            _burn_in_worker(sess, cut_ranges=cut_ranges)
        finally:
            auto_subtitle_runtime.end_job()

    import threading

    threading.Thread(target=_target, daemon=True).start()
