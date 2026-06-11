"""Electron ffmpeg-single-pass.ts 대응 — BGRA/RGBA rawvideo 단일 패스 자막 번인."""

from __future__ import annotations

import math
import os
import re
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator

from common.bin_manager import get_ffmpeg_executable
from common.ffmpeg_filter import filter_complex_argv
from common.subprocess_util import no_window_creationflags
from engines.auto_subtitle_export import ExportProgressCallback
from engines.auto_subtitle_media_probe import parse_ntsc_fps_fraction, probe_media_timing

EXPORT_FPS = 30
STDIN_FRAME_CHUNK = 20
RAWVIDEO_PIXEL_FORMAT = "rgba"
import logging as _logging

_log = _logging.getLogger(__name__)


def _probe_encoder(ffmpeg: str, encoder: str) -> bool:
    """GPU 인코더가 실제 사용 가능한지 1-frame 테스트 (NVENC 최소 해상도 256px)."""
    if encoder == "libx264":
        return True
    try:
        p = subprocess.run(
            [
                ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "nullsrc=s=256x256:d=0.04",
                "-c:v", encoder, "-frames:v", "1",
                "-f", "null", "-",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=10,
            creationflags=no_window_creationflags(),
        )
        return p.returncode == 0
    except Exception:
        return False


def get_subtitle_render_dimensions(full_width: int, full_height: int) -> tuple[int, int]:
    """자막 캡처 해상도 — 최대 1920×1080."""
    w = max(16, int(full_width))
    h = max(16, int(full_height))
    max_w, max_h = 1920, 1080
    if w <= max_w and h <= max_h:
        return w, h
    ratio = min(max_w / w, max_h / h)
    return max(16, round(w * ratio)), max(16, round(h * ratio))


WATERMARK_POSITIONS = frozenset({
    "top-left",
    "top-center",
    "top-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
})

WATERMARK_MAX_WIDTH_RATIO = 0.045
WATERMARK_MARGIN_RATIO = 0.005


def normalize_watermark_position(raw: str | None) -> str:
    pos = str(raw or "top-right").strip().lower()
    if pos not in WATERMARK_POSITIONS:
        return "top-right"
    return pos


def compute_watermark_dimensions(
    full_width: int,
    full_height: int,
    image_width: int,
    image_height: int,
    *,
    max_width_ratio: float = WATERMARK_MAX_WIDTH_RATIO,
) -> tuple[int, int]:
    fw = max(1, int(full_width))
    fh = max(1, int(full_height))
    iw = max(1, int(image_width))
    ih = max(1, int(image_height))
    max_w = max(8, round(fw * max_width_ratio))
    scale = min(1.0, max_w / iw)
    out_w = max(1, round(iw * scale))
    out_h = max(1, round(ih * scale))
    if out_h > fh:
        scale = fh / out_h
        out_w = max(1, round(out_w * scale))
        out_h = max(1, round(out_h * scale))
    return out_w, out_h


def watermark_overlay_xy(
    position: str,
    full_width: int,
    full_height: int,
    watermark_width: int,
    watermark_height: int,
    *,
    margin_ratio: float = WATERMARK_MARGIN_RATIO,
) -> tuple[int, int]:
    fw = max(1, int(full_width))
    fh = max(1, int(full_height))
    ww = max(1, int(watermark_width))
    wh = max(1, int(watermark_height))
    mx = max(0, round(fw * margin_ratio))
    my = max(0, round(fh * margin_ratio))
    pos = normalize_watermark_position(position)
    if pos == "top-left":
        return mx, my
    if pos == "top-center":
        return max(0, (fw - ww) // 2), my
    if pos == "top-right":
        return max(0, fw - ww - mx), my
    if pos == "bottom-left":
        return mx, max(0, fh - wh - my)
    if pos == "bottom-center":
        return max(0, (fw - ww) // 2), max(0, fh - wh - my)
    return max(0, fw - ww - mx), max(0, fh - wh - my)


def probe_image_dimensions(image_path: Path) -> tuple[int, int]:
    from PIL import Image, ImageOps

    with Image.open(image_path) as img:
        img = ImageOps.exif_transpose(img)
        w, h = img.size
    return max(1, int(w)), max(1, int(h))


def prepare_watermark_for_burn_in(
    source: Path,
    dest: Path,
    *,
    full_width: int,
    full_height: int,
    position: str,
) -> tuple[Path, int, int, int, int]:
    """프리뷰(CSS max-width 4.5%)와 동일 비율로 1회 리사이즈 → (path, x, y, w, h)."""
    from PIL import Image, ImageOps

    with Image.open(source) as img:
        img = ImageOps.exif_transpose(img)
        iw, ih = img.size
        wm_w, wm_h = compute_watermark_dimensions(full_width, full_height, iw, ih)
        wm_x, wm_y = watermark_overlay_xy(position, full_width, full_height, wm_w, wm_h)
        rgba = img.convert("RGBA").resize((wm_w, wm_h), Image.Resampling.LANCZOS)
        dest.parent.mkdir(parents=True, exist_ok=True)
        rgba.save(dest, format="PNG")
    return dest, wm_x, wm_y, wm_w, wm_h


def estimate_overlay_duration_sec(
    input_dur: float | None,
    cut_ranges: list[dict[str, Any]] | None,
    mapped_end_max: float,
) -> float:
    cut_sum = 0.0
    for c in cut_ranges or []:
        try:
            s = float(c.get("start", 0))
            e = float(c.get("end", 0))
        except (TypeError, ValueError):
            continue
        if e > s:
            cut_sum += e - s
    trimmed = max(0.1, float(input_dur or 0) - cut_sum) if input_dur else mapped_end_max
    return max(trimmed, mapped_end_max, 1.0)


FILTER_PROGRAM_START_EPS = 0.02
FILTER_PROGRAM_END_EPS = 0.05
MAX_FILTER_CONCAT_SEGMENTS = 256
BURN_IN_AAC_BITRATE = "192k"


def exceeds_fast_path_segment_limit(
    virtual_audio_map: list[dict[str, Any]] | None,
) -> bool:
    """Fast-Path filter_program trim+concat 상한 초과 여부 (Slow-Path 라우팅 SSOT)."""
    return len(normalize_keep_segments(virtual_audio_map)) > MAX_FILTER_CONCAT_SEGMENTS


def normalize_keep_segments(
    virtual_audio_map: list[dict[str, Any]] | None,
) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for raw in virtual_audio_map or []:
        if not isinstance(raw, dict):
            continue
        try:
            start = float(raw.get("sourceStart", raw.get("source_start", 0)))
            end = float(raw.get("sourceEnd", raw.get("source_end", 0)))
        except (TypeError, ValueError):
            continue
        if end > start + 1e-6:
            out.append((start, end))
    return out


def dedupe_overlapping_keep_segments(
    segments: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    """JS `removeAdjacentSourceOverlaps` Policy A — trim only, never drop queue entries."""
    if len(segments) <= 1:
        return list(segments)
    segs = list(segments)
    eps = 1e-6
    min_block = 1e-4
    for i in range(len(segs) - 1):
        a_start, a_end = segs[i]
        b_start, b_end = segs[i + 1]
        overlap_start = max(a_start, b_start)
        overlap_end = min(a_end, b_end)
        if overlap_end <= overlap_start + eps:
            continue
        if b_start < a_start - eps:
            continue
        same_source_anchor = abs(b_start - a_start) <= eps
        if b_start >= a_start - eps:
            if not same_source_anchor:
                segs[i] = (a_start, min(a_end, b_start))
        else:
            segs[i + 1] = (max(b_start, a_end), b_end)
        a_start, a_end = segs[i]
        if a_end <= a_start + eps:
            segs[i] = (a_start, a_start + min_block)
        b_start, b_end = segs[i + 1]
        if b_end <= b_start + eps:
            b_start = min(b_start, a_end)
            segs[i + 1] = (b_start, b_start + min_block)
    return [(s, e) for s, e in segs if e > s + eps]


def program_duration_from_keep_segments(segments: list[tuple[float, float]]) -> float:
    return sum(end - start for start, end in segments)


def virtual_audio_map_needs_filter_program(
    virtual_audio_map: list[dict[str, Any]] | None,
    input_dur: float,
) -> bool:
    segments = normalize_keep_segments(virtual_audio_map)
    if not segments:
        return False
    if len(segments) > 1:
        return True
    start, end = segments[0]
    if start > FILTER_PROGRAM_START_EPS:
        return True
    if input_dur > 0.0 and end < input_dur - FILTER_PROGRAM_END_EPS:
        return True
    return False


def estimate_burn_in_overlay_duration(
    input_dur: float | None,
    cut_ranges: list[dict[str, Any]] | None,
    mapped_end_max: float,
    virtual_audio_map: list[dict[str, Any]] | None,
    *,
    apply_filter_program: bool,
) -> float:
    if apply_filter_program:
        segments = normalize_keep_segments(virtual_audio_map)
        if segments:
            prog = program_duration_from_keep_segments(segments)
            return max(prog, mapped_end_max, 0.1)
    return estimate_overlay_duration_sec(input_dur, cut_ranges, mapped_end_max)


@dataclass
class _BurnInAvPipeline:
    vmain_chain: str
    audio_map: str | None
    reencode_audio: bool


def _probe_has_audio(probe_data: dict[str, Any]) -> bool:
    raw = probe_data.get("audio_duration_sec")
    if raw is None:
        return False
    try:
        return float(raw) > 0
    except (TypeError, ValueError):
        return False


def _build_vmain_tail_chain(
    fps_expr: str,
    probe_data: dict[str, Any],
    *,
    in_label: str,
    force_fps: bool = False,
) -> str:
    if not force_fps and _should_skip_video_fps_filter(fps_expr, probe_data):
        return f"{in_label}setpts=PTS-STARTPTS,setsar=1[vmain]"
    return f"{in_label}fps=fps={fps_expr},setpts=PTS-STARTPTS,setsar=1[vmain]"


def _build_filter_program_av_chain(
    segments: list[tuple[float, float]],
    fps_expr: str,
    probe_data: dict[str, Any],
    *,
    has_audio: bool,
    force_fps: bool = False,
) -> tuple[str, str | None]:
    if not segments:
        raise ValueError("filter_program keep segments가 비어 있습니다.")

    parts: list[str] = []
    if len(segments) == 1:
        start, end = segments[0]
        parts.append(f"[0:v]trim=start={start:.6f}:end={end:.6f},setpts=PTS-STARTPTS[v_edit]")
        if has_audio:
            parts.append(f"[0:a]atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS[a_edit]")
    else:
        v_labels: list[str] = []
        a_labels: list[str] = []
        for i, (start, end) in enumerate(segments):
            parts.append(f"[0:v]trim=start={start:.6f}:end={end:.6f},setpts=PTS-STARTPTS[v{i}t]")
            v_labels.append(f"[v{i}t]")
            if has_audio:
                parts.append(f"[0:a]atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS[a{i}t]")
                a_labels.append(f"[a{i}t]")
        n = len(segments)
        if has_audio:
            # concat v=1:a=1 — 입력 순서는 [v0][a0][v1][a1]… (전부 v 뒤 전부 a 아님)
            concat_in = "".join(
                label for i in range(n) for label in (v_labels[i], a_labels[i])
            )
            parts.append(f"{concat_in}concat=n={n}:v=1:a=1[v_edit][a_edit]")
        else:
            concat_in = "".join(v_labels)
            parts.append(f"{concat_in}concat=n={n}:v=1:a=0[v_edit]")

    parts.append(
        _build_vmain_tail_chain(fps_expr, probe_data, in_label="[v_edit]", force_fps=force_fps)
    )
    audio_out = "[a_edit]" if has_audio else None
    return ";".join(parts), audio_out


def _resolve_burn_in_av_pipeline(
    *,
    input_video_path: Path,
    fps_expr: str,
    probe_data: dict[str, Any],
    virtual_audio_map: list[dict[str, Any]] | None,
    requires_concat: bool,
    force_cfr: bool = False,
) -> _BurnInAvPipeline:
    input_dur = float(
        probe_data.get("format_duration_sec")
        or probe_data.get("video_duration_sec")
        or 0.0
    )
    apply_filter = (
        not requires_concat
        and virtual_audio_map_needs_filter_program(virtual_audio_map, input_dur)
    )
    if not apply_filter:
        return _BurnInAvPipeline(
            vmain_chain=_build_vmain_chain(
                input_video_path, fps_expr, probe_data, force_fps=force_cfr
            ),
            audio_map="0:a?",
            reencode_audio=False,
        )

    raw_segments = normalize_keep_segments(virtual_audio_map)
    segments = dedupe_overlapping_keep_segments(raw_segments)
    if len(segments) != len(raw_segments):
        _log.warning(
            "[BURN_IN] keep_segments deduped raw=%s out=%s (source overlap removed)",
            len(raw_segments),
            len(segments),
        )
    has_audio = _probe_has_audio(probe_data)
    chain, audio_label = _build_filter_program_av_chain(
        segments,
        fps_expr,
        probe_data,
        has_audio=has_audio,
        force_fps=force_cfr,
    )
    _log.info(
        "[BURN_IN] filter_program segments=%s has_audio=%s program_dur=%.3f force_cfr=%s",
        len(segments),
        has_audio,
        program_duration_from_keep_segments(segments),
        force_cfr,
    )
    return _BurnInAvPipeline(
        vmain_chain=chain,
        audio_map=audio_label,
        reencode_audio=has_audio,
    )


def _burn_in_audio_output_args(pipeline: _BurnInAvPipeline) -> list[str]:
    if not pipeline.audio_map:
        return []
    args = ["-map", pipeline.audio_map]
    if pipeline.reencode_audio:
        args.extend(["-c:a", "aac", "-b:a", BURN_IN_AAC_BITRATE])
    else:
        args.extend(["-c:a", "copy"])
    return args


def _ffmpeg_encoders_output(ffmpeg_exe: str) -> str:
    r = subprocess.run(
        [ffmpeg_exe, "-hide_banner", "-encoders"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=no_window_creationflags(),
    )
    return (r.stdout or "") + "\n" + (r.stderr or "")


def _has_encoder(encoders_output: str, encoder_name: str) -> bool:
    return bool(re.search(rf"\b{re.escape(encoder_name)}\b", encoders_output))


def select_h264_encoder(ffmpeg_exe: str | None = None) -> str:
    exe = str(ffmpeg_exe or get_ffmpeg_executable())
    enc = _ffmpeg_encoders_output(exe)
    for name in ("h264_nvenc", "h264_qsv", "h264_amf"):
        if _has_encoder(enc, name):
            return name
    return "libx264"


def select_burn_in_h264_encoder(ffmpeg_exe: str | None = None) -> str:
    """자막 1회 overlay 최종 패스 — GPU 인코더 우선."""
    return select_h264_encoder(ffmpeg_exe)


STALL_TIMEOUT_SEC = 300.0
MUX_FINISH_MESSAGE = "Muxing 마무리 중…"

def _fps_filter_expr(fps: float) -> str:
    if abs(fps - 30000 / 1001) < 0.02:
        return "30000/1001"
    if abs(fps - 24000 / 1001) < 0.02:
        return "24000/1001"
    if abs(fps - 60000 / 1001) < 0.02:
        return "60000/1001"
    rounded = round(fps)
    if abs(fps - rounded) < 0.001:
        return str(int(rounded))
    return f"{fps:.6g}"


def build_direct_overlay_filter_complex(
    *,
    vmain_chain: str,
    cue_timings: list[tuple[float, float]],
    full_w: int,
    full_h: int,
    num_media_inputs: int = 1,
    wm_input_index: int | None = None,
    wm_x: int = 0,
    wm_y: int = 0,
) -> str:
    """V6 — [vmain] 위에 PNG enable overlay (qtrle 중간 레이어 없음)."""
    w, h = max(1, int(full_w)), max(1, int(full_h))
    png_start = max(1, int(num_media_inputs))
    parts = [vmain_chain.rstrip(";")]
    current = "[vmain]"
    n = len(cue_timings)
    for i, (start, end) in enumerate(cue_timings):
        en = f"between(t\\,{start:.6f}\\,{end:.6f})"
        in_idx = png_start + i
        out = "[vout]" if i == n - 1 and wm_input_index is None else f"[ov{i}]"
        parts.append(
            f"[{in_idx}:v]format=rgba,scale={w}:{h}:flags=bilinear[sub{i}s];"
            f"{current}[sub{i}s]overlay=0:0:enable='{en}'{out}"
        )
        current = out
    if wm_input_index is not None:
        parts.append(
            f"[{wm_input_index}:v]format=rgba[wm];"
            f"{current}[wm]overlay={wm_x}:{wm_y}[vout]"
        )
    return ";".join(parts)


def build_cue_overlay_filter_complex(
    cue_timings: list[tuple[float, float]],
    *,
    fps_expr: str,
    full_w: int,
    full_h: int,
    wm_input_index: int | None = None,
    wm_x: int = 0,
    wm_y: int = 0,
) -> str:
    """레거시 — vmain을 [0:v]fps로 생성 (stdin rawvideo 경로)."""
    vmain = f"[0:v]fps=fps={fps_expr},setpts=PTS-STARTPTS,setsar=1[vmain]"
    return build_direct_overlay_filter_complex(
        vmain_chain=vmain,
        cue_timings=cue_timings,
        full_w=full_w,
        full_h=full_h,
        num_media_inputs=1,
        wm_input_index=wm_input_index,
        wm_x=wm_x,
        wm_y=wm_y,
    )


def _build_filter_program_audio_chain(
    segments: list[tuple[float, float]],
    *,
    input_index: int = 0,
) -> str:
    """V6 Deferred Audio — 지정 입력에서 trim+concat 후 [a_edit]만 생성."""
    if not segments:
        return f"[{input_index}:a]asetpts=PTS-STARTPTS[a_edit]"
    prefix_a = f"[{input_index}:a]"
    parts: list[str] = []
    if len(segments) == 1:
        start, end = segments[0]
        parts.append(
            f"{prefix_a}atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS[a_edit]"
        )
    else:
        labels: list[str] = []
        for i, (start, end) in enumerate(segments):
            parts.append(
                f"{prefix_a}atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS[a{i}t]"
            )
            labels.append(f"[a{i}t]")
        n = len(segments)
        parts.append(f"{''.join(labels)}concat=n={n}:v=0:a=1[a_edit]")
    return ";".join(parts)


def build_h264_video_encode_args(encoder: str) -> list[str]:
    e = (encoder or "libx264").strip().lower()
    if e == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p1", "-cq", "23"]
    if e == "h264_qsv":
        return ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "23"]
    if e == "h264_amf":
        return ["-c:v", "h264_amf", "-quality", "speed"]
    return ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-threads", "0"]


@dataclass
class _TimeCue:
    start: float
    end: float
    buf: bytes | None = None
    path: Path | None = None


_FRAME_BYTES_CACHE: dict[str, bytes] = {}
_FRAME_CACHE_MAX = 32
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _decode_subtitle_frame_bytes(payload: bytes, render_w: int, render_h: int) -> bytes:
    """PNG 또는 raw RGBA → render 해상도 RGBA bytes."""
    expected = render_w * render_h * 4
    if payload[:8] == _PNG_MAGIC:
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


def _read_frame_bytes(path: Path, render_w: int, render_h: int) -> bytes:
    key = str(path.resolve())
    cached = _FRAME_BYTES_CACHE.get(key)
    if cached is not None:
        return cached
    data = path.read_bytes()
    raw = _decode_subtitle_frame_bytes(data, render_w, render_h)
    if len(_FRAME_BYTES_CACHE) >= _FRAME_CACHE_MAX:
        _FRAME_BYTES_CACHE.pop(next(iter(_FRAME_BYTES_CACHE)))
    _FRAME_BYTES_CACHE[key] = raw
    return raw


def _warm_frame_bytes_cache(cues: list[_TimeCue], render_w: int, render_h: int) -> None:
    seen: set[str] = set()
    for cue in cues:
        if cue.path is None:
            continue
        key = str(cue.path.resolve())
        if key in seen:
            continue
        seen.add(key)
        try:
            _read_frame_bytes(cue.path, render_w, render_h)
        except Exception as exc:
            _log.warning("[BURN_IN] frame_cache_warm_failed path=%s err=%s", cue.path.name, exc)


def _pick_frame_buffer(
    t: float,
    sorted_cues: list[_TimeCue],
    blank: bytes,
    render_w: int,
    render_h: int,
) -> bytes:
    """FE 비중첩 스케줄 신뢰 — strict [start, end) hit only."""
    for c in sorted_cues:
        if t >= c.start - 1e-7 and t < c.end - 1e-7:
            if c.buf is not None:
                return c.buf
            if c.path is not None:
                return _read_frame_bytes(c.path, render_w, render_h)
            break
    return blank


def _iter_rawvideo_chunks(
    render_w: int,
    render_h: int,
    overlay_dur: float,
    fps: float,
    sorted_cues: list[_TimeCue],
    blank: bytes,
) -> Iterator[tuple[bytes, int]]:
    """Electron buildRawVideoReadable — 프레임을 필요할 때만 생성 (전체 버퍼 선할당 없음)."""
    frame_bytes = render_w * render_h * 4
    total_frames = max(1, math.ceil(overlay_dur * fps - 1e-9))
    frame_index = 0
    while frame_index < total_frames:
        chunk_parts: list[bytes] = []
        chunk_bytes = 0
        max_chunk = STDIN_FRAME_CHUNK * frame_bytes
        chunk_frame_count = 0
        while frame_index < total_frames and chunk_bytes < max_chunk:
            t = (frame_index + 0.5) / fps
            chunk_parts.append(_pick_frame_buffer(t, sorted_cues, blank, render_w, render_h))
            frame_index += 1
            chunk_bytes += frame_bytes
            chunk_frame_count += 1
        if len(chunk_parts) == 1:
            yield chunk_parts[0], chunk_frame_count
        else:
            yield b"".join(chunk_parts), chunk_frame_count


@dataclass
class _FfmpegMonitorState:
    last_out_time_ms: int = 0
    last_out_time_at: float = field(default_factory=time.perf_counter)
    progress_end_received: bool = False
    stderr_tail: list[str] = field(default_factory=list)
    read_error: BaseException | None = None


def _fps_matches_target(probe_fps: float | None, target_fps: float, tolerance: float = 0.02) -> bool:
    if probe_fps is None or not (probe_fps > 0):
        return False
    return abs(float(probe_fps) - target_fps) < tolerance


def _should_skip_video_fps_filter(fps_expr: str, probe_data: dict[str, Any]) -> bool:
    if not probe_data.get("ok"):
        return False
    if probe_data.get("vfr_suspected") or probe_data.get("needs_vfr_normalize"):
        return False
    target_fps = parse_ntsc_fps_fraction(fps_expr)
    r_fps = probe_data.get("video_r_frame_rate_fps")
    avg_fps = probe_data.get("video_avg_frame_rate_fps")
    return _fps_matches_target(r_fps, target_fps) and _fps_matches_target(avg_fps, target_fps)


def _build_vmain_chain(
    input_path: Path,
    fps_expr: str,
    probe_data: dict[str, Any],
    *,
    force_fps: bool = False,
) -> str:
    _ = input_path
    if not force_fps and _should_skip_video_fps_filter(fps_expr, probe_data):
        _log.info(
            "[BURN_IN] vmain_chain skip_fps input_fps_r=%s input_fps_avg=%s target=%s",
            probe_data.get("video_r_frame_rate_fps"),
            probe_data.get("video_avg_frame_rate_fps"),
            fps_expr,
        )
        return "[0:v]setpts=PTS-STARTPTS,setsar=1[vmain]"
    return f"[0:v]fps=fps={fps_expr},setpts=PTS-STARTPTS,setsar=1[vmain]"


def _progress_cap_message(
    mapped: float,
    cap: float,
    log_label: str,
    default_message: str,
) -> str:
    if log_label == "layer_mux" and mapped >= cap - 0.01:
        return MUX_FINISH_MESSAGE
    return default_message


def _monitor_ffmpeg_progress(
    proc: subprocess.Popen[Any],
    *,
    overlay_dur: float,
    on_progress: ExportProgressCallback | None,
    timeout_sec: float,
    log_label: str,
    progress_base: float = 32.0,
    progress_span: float = 67.0,
    progress_message: str = "FFmpeg 인코딩 중…",
    line_handler: Callable[[str, _FfmpegMonitorState], None] | None = None,
    stall_timeout_sec: float = STALL_TIMEOUT_SEC,
) -> str:
    assert proc.stderr is not None
    state = _FfmpegMonitorState()
    expected_ms = max(1, int(overlay_dur * 1000))
    progress_lock = threading.Lock()
    last_reported_pct = progress_base
    cap = progress_base + progress_span
    capped_at_cap_logged = False
    wait_started = time.perf_counter()
    last_heartbeat_at = wait_started

    def _default_line_handler(stripped: str, st: _FfmpegMonitorState) -> None:
        nonlocal last_reported_pct, capped_at_cap_logged
        if stripped.startswith("out_time_ms="):
            try:
                raw = int(stripped.split("=", 1)[1])
            except (ValueError, IndexError):
                return
            st.last_out_time_ms = raw
            st.last_out_time_at = time.perf_counter()
            pct = max(0, min(99, int((raw / expected_ms) * 100)))
            mapped = progress_base + (pct / 100.0) * progress_span
            msg = _progress_cap_message(mapped, cap, log_label, progress_message)
            if not on_progress:
                return
            with progress_lock:
                if mapped > last_reported_pct + 0.05 or mapped >= cap - 0.01:
                    if mapped >= cap - 0.01 and not capped_at_cap_logged:
                        capped_at_cap_logged = True
                        _log.info(
                            "[BURN_IN] ui_progress_capped mode=%s mapped=%.2f expected_ms=%s last_out_time_ms=%s",
                            log_label,
                            mapped,
                            expected_ms,
                            st.last_out_time_ms,
                        )
                    last_reported_pct = mapped
                    on_progress(mapped, msg)
        elif stripped in {"progress=end", "progress=done"}:
            st.progress_end_received = True
            _log.info("[BURN_IN] ffmpeg_progress_signal mode=%s signal=%s", log_label, stripped)

    handler = line_handler or _default_line_handler

    def _read_stderr() -> None:
        buf = b""
        try:
            while True:
                chunk = proc.stderr.read(4096)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    raw_line, buf = buf.split(b"\n", 1)
                    line = raw_line.decode("utf-8", errors="replace")
                    state.stderr_tail.append(line)
                    if len(state.stderr_tail) > 200:
                        state.stderr_tail.pop(0)
                    handler(line.strip(), state)
        except Exception as exc:
            state.read_error = exc
        finally:
            _log.info(
                "[BURN_IN] stderr_reader_done mode=%s last_out_time_ms=%s tail_lines=%s",
                log_label,
                state.last_out_time_ms,
                len(state.stderr_tail),
            )

    stderr_thread = threading.Thread(target=_read_stderr, name=f"burn-in-stderr-{log_label}", daemon=True)
    stderr_thread.start()

    deadline = time.perf_counter() + timeout_sec
    while proc.poll() is None:
        now = time.perf_counter()
        if now > deadline:
            proc.kill()
            raise TimeoutError("FFmpeg보내기 시간 초과")
        if (
            not state.progress_end_received
            and state.last_out_time_ms > 0
            and (now - state.last_out_time_at) >= stall_timeout_sec
        ):
            proc.kill()
            raise TimeoutError(
                f"FFmpeg stall ({log_label}): out_time_ms unchanged for {int(stall_timeout_sec)}s"
            )
        if now - last_heartbeat_at >= 30.0:
            last_heartbeat_at = now
            stall_ms = (now - state.last_out_time_at) * 1000.0 if state.last_out_time_ms > 0 else -1.0
            _log.info(
                "[BURN_IN] heartbeat mode=%s elapsed=%.1fs ui_pct=%.1f progress_end=%s "
                "last_out_time_ms=%s out_time_stall_ms=%.0f",
                log_label,
                now - wait_started,
                last_reported_pct,
                state.progress_end_received,
                state.last_out_time_ms,
                stall_ms,
            )
        time.sleep(0.1)

    stderr_thread.join(timeout=5.0)
    rest = proc.stderr.read()
    if rest:
        state.stderr_tail.append(rest.decode("utf-8", errors="replace"))
    ffmpeg_err = "\n".join(state.stderr_tail)[-4000:]
    if proc.returncode != 0 or state.read_error:
        _log.error("[BURN_IN] ffmpeg_stderr_tail mode=%s\n%s", log_label, ffmpeg_err[-1500:])
    if state.read_error:
        raise state.read_error
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg 실패 (exit {proc.returncode}): {ffmpeg_err or 'unknown'}")
    return ffmpeg_err


def _run_ffmpeg_filter_pass(
    cmd: list[str],
    *,
    overlay_dur: float,
    on_progress: ExportProgressCallback | None,
    timeout_sec: float,
    log_label: str,
    progress_base: float = 32.0,
    progress_span: float = 67.0,
    progress_message: str = "FFmpeg 인코딩 중…",
) -> None:
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=no_window_creationflags(),
    )
    _log.info("[BURN_IN] ffmpeg_pid=%s mode=%s", proc.pid, log_label)
    _monitor_ffmpeg_progress(
        proc,
        overlay_dur=overlay_dur,
        on_progress=on_progress,
        timeout_sec=timeout_sec,
        log_label=log_label,
        progress_base=progress_base,
        progress_span=progress_span,
        progress_message=progress_message,
    )


def _publish_burn_in_diagnostics(*, video_encoder: str, overlay_mode: str) -> None:
    from engines.auto_subtitle_export import update_burn_in_diagnostics

    update_burn_in_diagnostics(video_encoder=video_encoder, overlay_mode=overlay_mode)


def _append_loop_png_inputs(cmd: list[str], png_paths: list[Path]) -> None:
    for p in png_paths:
        cmd.extend(["-loop", "1", "-i", str(p)])


def _burn_in_force_direct_overlay() -> bool:
    return os.getenv("BURN_IN_FORCE_FALLBACK", "").strip().lower() in ("1", "true", "yes")


def _run_direct_overlay_fallback(
    *,
    ffmpeg: str,
    input_video_path: Path,
    output_path: Path,
    pairs: list[_TimeCue],
    overlay_dur: float,
    w: int,
    h: int,
    wm_path: Path | None,
    wm_x: int,
    wm_y: int,
    enc_args: list[str],
    av_pipeline: _BurnInAvPipeline,
    on_progress: ExportProgressCallback | None,
    timeout_sec: float,
) -> None:
    """stdin 실패 시 PNG enable overlay 단일 패스 (Phase 3 fallback)."""
    cue_pngs: list[tuple[Path, float, float]] = []
    for cue in pairs:
        if cue.path is None:
            raise ValueError("direct overlay fallback requires frame paths")
        cue_pngs.append((cue.path, cue.start, cue.end))

    png_paths = [p for p, _, _ in cue_pngs]
    timings = [(start, end) for _, start, end in cue_pngs]
    num_media = 1
    wm_idx = num_media + len(png_paths) if wm_path is not None else None

    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-dn",
        "-sn",
        "-fflags",
        "+genpts",
        "-i",
        str(input_video_path),
    ]
    _append_loop_png_inputs(cmd, png_paths)
    if wm_path is not None:
        cmd.extend(["-loop", "1", "-i", str(wm_path)])

    filter_body = build_direct_overlay_filter_complex(
        vmain_chain=av_pipeline.vmain_chain,
        cue_timings=timings,
        full_w=w,
        full_h=h,
        num_media_inputs=num_media,
        wm_input_index=wm_idx,
        wm_x=wm_x,
        wm_y=wm_y,
    )
    script_path = output_path.parent / "_direct_overlay_fallback.txt"
    audio_args = _burn_in_audio_output_args(av_pipeline)
    if not audio_args:
        audio_args = ["-map", "0:a?", "-c:a", "copy"]
    cmd.extend(
        [
            *filter_complex_argv(ffmpeg, filter_body, script_path=script_path),
            "-map",
            "[vout]",
            *audio_args,
            "-map",
            "-0:s",
            *enc_args,
            "-t",
            f"{overlay_dur:.6f}",
            "-progress",
            "pipe:2",
            "-nostats",
            "-max_muxing_queue_size",
            "1024",
            str(output_path),
        ]
    )
    _log.info(
        "[BURN_IN] direct_overlay_fallback cues=%s wm=%s filter_program_audio=%s",
        len(cue_pngs),
        wm_path is not None,
        av_pipeline.reencode_audio,
    )
    if on_progress:
        on_progress(62.0, "FFmpeg Direct Overlay (fallback)…")
    _run_ffmpeg_filter_pass(
        cmd,
        overlay_dur=overlay_dur,
        on_progress=on_progress,
        timeout_sec=timeout_sec,
        log_label="direct_overlay_fallback",
        progress_base=62.0,
        progress_span=37.0,
        progress_message="FFmpeg Direct Overlay (fallback)…",
    )
    _log.info(
        "[BURN_IN] ffmpeg_success mode=direct_overlay_fallback output=%s size_bytes=%s",
        output_path.name,
        output_path.stat().st_size if output_path.is_file() else 0,
    )


def _run_stdin_rawvideo_burn_in(
    *,
    ffmpeg: str,
    input_video_path: Path,
    output_path: Path,
    pairs: list[_TimeCue],
    overlay_dur: float,
    fps: float,
    fps_expr: str,
    rw: int,
    rh: int,
    w: int,
    h: int,
    wm_path: Path | None,
    wm_x: int,
    wm_y: int,
    enc_args: list[str],
    chosen_encoder: str,
    av_pipeline: _BurnInAvPipeline,
    on_progress: ExportProgressCallback | None,
    timeout_sec: float,
) -> None:
    vmain_chain = av_pipeline.vmain_chain
    if wm_path is not None:
        filter_complex = (
            f"{vmain_chain};"
            f"[1:v]format=rgba,scale={w}:{h}:flags=bilinear[sub];"
            f"[vmain][sub]overlay=0:0[vsub];"
            f"[vsub][2:v]overlay={wm_x}:{wm_y}[vout]"
        )
    else:
        filter_complex = (
            f"{vmain_chain};"
            f"[1:v]format=rgba,scale={w}:{h}:flags=bilinear[sub];"
            f"[vmain][sub]overlay=0:0[vout]"
        )

    if on_progress:
        on_progress(45.0, "FFmpeg 자막 합성·인코딩…")

    frame_bytes = rw * rh * 4
    blank = bytes(frame_bytes)
    total_frames = max(1, math.ceil(overlay_dur * fps - 1e-9))

    def _try_start_ffmpeg(enc_args_local: list[str]) -> subprocess.Popen:
        cmd = [
            ffmpeg,
            "-y",
            "-hide_banner",
            "-dn",
            "-sn",
            "-thread_queue_size",
            "512",
            "-fflags",
            "+genpts",
            "-i",
            str(input_video_path),
            "-thread_queue_size",
            "512",
            "-f",
            "rawvideo",
            "-pixel_format",
            RAWVIDEO_PIXEL_FORMAT,
            "-video_size",
            f"{rw}x{rh}",
            "-framerate",
            fps_expr,
            "-i",
            "-",
        ]
        if wm_path is not None:
            cmd.extend(["-loop", "1", "-i", str(wm_path)])
        stdin_audio_args = _burn_in_audio_output_args(av_pipeline)
        if not stdin_audio_args:
            stdin_audio_args = ["-map", "0:a?", "-c:a", "copy"]
        cmd.extend([
            "-filter_complex",
            filter_complex,
            "-map",
            "[vout]",
            *stdin_audio_args,
            "-map",
            "-0:s",
            *enc_args_local,
            "-t",
            f"{overlay_dur:.6f}",
            "-progress",
            "pipe:2",
            "-nostats",
            str(output_path),
        ])
        return subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            creationflags=no_window_creationflags(),
        )

    timing_end_max = max((c.end for c in pairs), default=0.0)
    timing_start_min = min((c.start for c in pairs), default=0.0)
    _log.info(
        "[BURN_IN] ffmpeg_start mode=stdin_rawvideo input=%s output=%s encoder=%s overlay_dur=%.3f "
        "expected_ms=%s total_raw_frames=%s cue_frames=%s timing=[%.3f,%.3f] render=%dx%d full=%dx%d fps=%s",
        input_video_path.name,
        output_path.name,
        chosen_encoder,
        overlay_dur,
        max(1, int(overlay_dur * 1000)),
        total_frames,
        len(pairs),
        timing_start_min,
        timing_end_max,
        rw,
        rh,
        w,
        h,
        fps,
    )
    proc = _try_start_ffmpeg(enc_args)
    assert proc.stdin is not None
    assert proc.stderr is not None
    _log.info("[BURN_IN] ffmpeg_pid=%s", proc.pid)

    write_err: list[BaseException] = []
    progress_lock = threading.Lock()
    diag_lock = threading.Lock()
    last_pct = 45.0
    expected_ms = max(1, int(overlay_dur * 1000))
    last_out_time_ms = 0
    stdin_frames_sent = 0
    stdin_finished = False
    wait_started = time.perf_counter()
    capped_at_99_logged = False

    def _report(pct: float, msg: str) -> None:
        nonlocal last_pct, capped_at_99_logged, last_out_time_ms
        if not on_progress:
            return
        with progress_lock:
            mapped = max(45.0, min(99.0, float(pct)))
            if mapped > last_pct + 0.05 or mapped >= 99.0:
                if mapped >= 99.0 and not capped_at_99_logged:
                    capped_at_99_logged = True
                    _log.info(
                        "[BURN_IN] ui_progress_capped_99 raw_pct=%.2f expected_ms=%s last_out_time_ms=%s",
                        pct,
                        expected_ms,
                        last_out_time_ms,
                    )
                last_pct = mapped
                on_progress(mapped, msg)

    def _stdin_stderr_handler(stripped: str, state: _FfmpegMonitorState) -> None:
        nonlocal last_out_time_ms
        if stripped.startswith("out_time_ms="):
            try:
                raw = int(stripped.split("=", 1)[1])
            except (ValueError, IndexError):
                return
            state.last_out_time_ms = raw
            state.last_out_time_at = time.perf_counter()
            last_out_time_ms = raw
            pct = max(0, min(99, int((raw / expected_ms) * 100)))
            _report(60.0 + pct * 0.39, "FFmpeg 인코딩 중…")
        elif stripped in {"progress=end", "progress=done"}:
            state.progress_end_received = True
            _log.info("[BURN_IN] ffmpeg_progress_signal %s", stripped)

    def _write_stdin() -> None:
        nonlocal stdin_frames_sent, stdin_finished
        frames_sent = 0
        t0 = time.perf_counter()
        try:
            for chunk, n_frames in _iter_rawvideo_chunks(
                rw, rh, overlay_dur, fps, pairs, blank
            ):
                proc.stdin.write(chunk)
                frames_sent += n_frames
                with diag_lock:
                    stdin_frames_sent = frames_sent
                if total_frames > 0:
                    send_pct = frames_sent / total_frames
                    _report(45.0 + send_pct * 15.0, "자막 레이어 전송…")
            proc.stdin.close()
            _log.info(
                "[BURN_IN] stdin_write_done frames_sent=%s/%s elapsed=%.2fs",
                frames_sent,
                total_frames,
                time.perf_counter() - t0,
            )
        except (BrokenPipeError, OSError) as exc:
            try:
                proc.stdin.close()
            except OSError:
                pass
            _log.info(
                "[BURN_IN] stdin_closed_by_ffmpeg frames_sent=%s/%s err=%s",
                frames_sent,
                total_frames,
                exc,
            )
        except Exception as exc:
            write_err.append(exc)
            _log.error(
                "[BURN_IN] stdin_write_failed frames_sent=%s/%s err=%s",
                frames_sent,
                total_frames,
                exc,
                exc_info=True,
            )
            try:
                proc.kill()
            except OSError:
                pass
        finally:
            with diag_lock:
                stdin_frames_sent = frames_sent
            stdin_finished = True

    writer = threading.Thread(target=_write_stdin, name="burn-in-stdin", daemon=True)
    writer.start()

    try:
        ffmpeg_err = _monitor_ffmpeg_progress(
            proc,
            overlay_dur=overlay_dur,
            on_progress=on_progress,
            timeout_sec=timeout_sec,
            log_label="stdin_rawvideo",
            progress_base=60.0,
            progress_span=39.0,
            progress_message="FFmpeg 인코딩 중…",
            line_handler=_stdin_stderr_handler,
        )
    finally:
        writer.join(timeout=10.0)

    elapsed = time.perf_counter() - wait_started
    _log.info(
        "[BURN_IN] ffmpeg_exited pid=%s returncode=%s elapsed=%.2fs stdin_done=%s "
        "writer_joined=%s frames_sent=%s/%s last_out_time_ms=%s",
        proc.pid,
        proc.returncode,
        elapsed,
        stdin_finished,
        not writer.is_alive(),
        stdin_frames_sent,
        total_frames,
        last_out_time_ms,
    )

    if write_err:
        first_err = write_err[0]
        if proc.returncode == 0:
            _log.info("write_err 발생했으나 FFmpeg 정상 종료 (exit=0), 무시: %s", first_err)
        else:
            if "Broken pipe" in str(first_err) or "Errno 32" in str(first_err):
                raise RuntimeError(
                    f"FFmpeg가 인코딩 중 비정상 종료했습니다 (exit={proc.returncode}).\n"
                    f"FFmpeg 로그:\n{ffmpeg_err[-2000:]}"
                )
            raise first_err

    _log.info(
        "[BURN_IN] ffmpeg_success mode=stdin_rawvideo output=%s size_bytes=%s",
        output_path.name,
        output_path.stat().st_size if output_path.is_file() else 0,
    )
    if on_progress:
        on_progress(100.0, "완료")


def _log_frame_sampling_handoff(
    *,
    fps: float,
    overlay_dur: float,
    pairs: list[_TimeCue],
    probe_data: dict[str, Any],
    apply_filter_program: bool,
) -> None:
    from engines.auto_subtitle_burn_in_pipeline_diag import (
        burn_in_pipeline_diag,
        is_burn_in_pipeline_diag_enabled,
        probe_summary_for_diag,
    )

    if not is_burn_in_pipeline_diag_enabled():
        return
    total_frames = max(1, math.ceil(overlay_dur * fps - 1e-9))

    def _cue_index_at(t: float) -> int:
        for i, c in enumerate(pairs):
            if t >= c.start - 1e-7 and t < c.end - 1e-7:
                return i
        return -1

    sample_indices = sorted(
        {
            0,
            total_frames // 4,
            total_frames // 2,
            (3 * total_frames) // 4,
            max(0, total_frames - 1),
        }
    )
    samples = []
    for fi in sample_indices:
        t = (fi + 0.5) / fps
        ci = _cue_index_at(t)
        seg = pairs[ci] if ci >= 0 else None
        samples.append(
            {
                "frame_index": fi,
                "t": round(t, 4),
                "cue_index": ci,
                "cue_start": round(seg.start, 4) if seg else None,
                "cue_end": round(seg.end, 4) if seg else None,
            }
        )

    burn_in_pipeline_diag(
        "frame_sampling_handoff",
        export_fps=fps,
        overlay_dur=overlay_dur,
        total_frames=total_frames,
        timing_segments=len(pairs),
        timing_first_start=round(pairs[0].start, 4) if pairs else None,
        timing_last_end=round(pairs[-1].end, 4) if pairs else None,
        input_probe=probe_summary_for_diag(probe_data),
        filter_program=apply_filter_program,
        samples=samples,
    )


def run_single_pass_subtitle_burn_in(
    *,
    ffmpeg_path: str | None,
    input_video_path: Path,
    output_path: Path,
    full_video_width: int,
    full_video_height: int,
    render_width: int,
    render_height: int,
    overlay_duration_sec: float,
    timing: list[dict[str, float]],
    h264_encoder: str,
    raw_frame_buffers: list[bytes] | None = None,
    frame_paths: list[Path] | None = None,
    watermark_path: Path | None = None,
    watermark_position: str | None = None,
    export_fps: float | None = None,
    on_progress: ExportProgressCallback | None = None,
    timeout_sec: float = 7200.0,
    virtual_audio_map: list[dict[str, Any]] | None = None,
    requires_concat: bool = False,
    burn_in_overlay_mode: str | None = None,
) -> None:
    if raw_frame_buffers is None and frame_paths is None:
        raise ValueError("raw_frame_buffers 또는 frame_paths 가 필요합니다.")
    if raw_frame_buffers is not None and frame_paths is not None:
        raise ValueError("raw_frame_buffers 와 frame_paths 는 동시에 지정할 수 없습니다.")

    ffmpeg = str(ffmpeg_path or get_ffmpeg_executable())
    fps = float(export_fps) if export_fps and export_fps > 0 else float(EXPORT_FPS)
    rw = max(1, int(render_width))
    rh = max(1, int(render_height))
    frame_bytes = rw * rh * 4
    overlay_dur = max(0.1, float(overlay_duration_sec))

    pairs: list[_TimeCue] = []
    if frame_paths is not None:
        n = len(frame_paths)
        if n == 0:
            raise ValueError("frame_paths 가 비어 있습니다.")
        if len(timing) != n:
            raise ValueError("timing 길이가 frame_paths 와 일치해야 합니다.")
        for i, path in enumerate(frame_paths):
            p = Path(path)
            if not p.is_file():
                raise FileNotFoundError(f"프레임 파일 없음: {p}")
            pairs.append(
                _TimeCue(
                    start=float(timing[i]["start"]),
                    end=float(timing[i]["end"]),
                    path=p,
                )
            )
    else:
        assert raw_frame_buffers is not None
        n = len(raw_frame_buffers)
        if n == 0:
            raise ValueError("raw_frame_buffers 가 비어 있습니다.")
        if len(timing) != n:
            raise ValueError("timing 길이가 raw_frame_buffers 와 일치해야 합니다.")
        for i, buf in enumerate(raw_frame_buffers):
            if len(buf) != frame_bytes:
                raise ValueError(f"프레임 {i} 크기 불일치: {len(buf)} (기대 {frame_bytes})")
            pairs.append(
                _TimeCue(
                    start=float(timing[i]["start"]),
                    end=float(timing[i]["end"]),
                    buf=buf,
                )
            )

    _FRAME_BYTES_CACHE.clear()
    pairs.sort(key=lambda c: (c.start, c.end))
    if frame_paths is not None:
        _warm_frame_bytes_cache(pairs, rw, rh)

    w = max(1, round(full_video_width))
    h = max(1, round(full_video_height))
    wm_path: Path | None = None
    wm_x = 0
    wm_y = 0
    wm_pos = normalize_watermark_position(watermark_position)
    if watermark_path is not None:
        candidate = Path(watermark_path)
        if candidate.is_file():
            prepared = output_path.parent / "_watermark_prepared.png"
            wm_path, wm_x, wm_y, wm_w, wm_h = prepare_watermark_for_burn_in(
                candidate,
                prepared,
                full_width=w,
                full_height=h,
                position=wm_pos,
            )
            _log.info(
                "워터마크 번인: %s → %dx%d @ (%d,%d) on %dx%d",
                candidate.name,
                wm_w,
                wm_h,
                wm_x,
                wm_y,
                w,
                h,
            )

    fps_expr = _fps_filter_expr(fps)
    chosen_encoder = (h264_encoder or select_h264_encoder(ffmpeg)).strip().lower()
    if chosen_encoder != "libx264" and not _probe_encoder(ffmpeg, chosen_encoder):
        _log.warning("인코더 %s 사용 불가 → libx264 fallback", chosen_encoder)
        chosen_encoder = "libx264"
    enc_args = build_h264_video_encode_args(chosen_encoder)
    _log.info("[BURN_IN] video_encoder=%s", chosen_encoder)

    probe_data = probe_media_timing(input_video_path)
    _log.info(
        "[BURN_IN] probe ok=%s vfr=%s r_fps=%s avg_fps=%s",
        probe_data.get("ok"),
        probe_data.get("vfr_suspected"),
        probe_data.get("video_r_frame_rate_fps"),
        probe_data.get("video_avg_frame_rate_fps"),
    )

    _publish_burn_in_diagnostics(
        video_encoder=chosen_encoder,
        overlay_mode=burn_in_overlay_mode or "stdin_rawvideo",
    )

    av_pipeline = _resolve_burn_in_av_pipeline(
        input_video_path=input_video_path,
        fps_expr=fps_expr,
        probe_data=probe_data,
        virtual_audio_map=virtual_audio_map,
        requires_concat=requires_concat,
        force_cfr=True,
    )
    apply_filter_program = (
        not requires_concat
        and virtual_audio_map_needs_filter_program(
            virtual_audio_map,
            float(
                probe_data.get("format_duration_sec")
                or probe_data.get("video_duration_sec")
                or 0.0
            ),
        )
    )
    _log_frame_sampling_handoff(
        fps=fps,
        overlay_dur=overlay_dur,
        pairs=pairs,
        probe_data=probe_data,
        apply_filter_program=apply_filter_program,
    )

    fallback_kwargs = dict(
        ffmpeg=ffmpeg,
        input_video_path=input_video_path,
        output_path=output_path,
        pairs=pairs,
        overlay_dur=overlay_dur,
        w=w,
        h=h,
        wm_path=wm_path,
        wm_x=wm_x,
        wm_y=wm_y,
        enc_args=enc_args,
        av_pipeline=av_pipeline,
        on_progress=on_progress,
        timeout_sec=timeout_sec,
    )
    stdin_kwargs = dict(
        ffmpeg=ffmpeg,
        input_video_path=input_video_path,
        output_path=output_path,
        pairs=pairs,
        overlay_dur=overlay_dur,
        fps=fps,
        fps_expr=fps_expr,
        rw=rw,
        rh=rh,
        w=w,
        h=h,
        wm_path=wm_path,
        wm_x=wm_x,
        wm_y=wm_y,
        enc_args=enc_args,
        chosen_encoder=chosen_encoder,
        av_pipeline=av_pipeline,
        on_progress=on_progress,
        timeout_sec=timeout_sec,
    )

    if _burn_in_force_direct_overlay() and frame_paths is not None:
        _log.warning("[BURN_IN] BURN_IN_FORCE_FALLBACK=1 → direct overlay fallback")
        _publish_burn_in_diagnostics(
            video_encoder=chosen_encoder,
            overlay_mode="direct_overlay_fallback",
        )
        _run_direct_overlay_fallback(**fallback_kwargs)
        if on_progress:
            on_progress(100.0, "완료")
        return

    try:
        _run_stdin_rawvideo_burn_in(**stdin_kwargs)
    except (RuntimeError, TimeoutError) as exc:
        if frame_paths is None:
            raise
        _log.warning(
            "[BURN_IN] stdin_rawvideo failed → direct_overlay fallback: %s",
            exc,
        )
        _publish_burn_in_diagnostics(
            video_encoder=chosen_encoder,
            overlay_mode="direct_overlay_fallback",
        )
        if output_path.is_file():
            try:
                output_path.unlink()
            except OSError:
                pass
        _run_direct_overlay_fallback(**fallback_kwargs)
        if on_progress:
            on_progress(100.0, "완료")
