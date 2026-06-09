"""Electron ffmpeg-single-pass.ts 대응 — BGRA/RGBA rawvideo 단일 패스 자막 번인."""

from __future__ import annotations

import math
import re
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator

from common.bin_manager import get_ffmpeg_executable
from common.ffmpeg_filter import filter_complex_argv
from common.subprocess_util import no_window_creationflags
from engines.auto_subtitle_export import ExportProgressCallback

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


CUE_OVERLAY_BATCH_SIZE = 8
SUBTITLE_LAYER_CODEC = ("qtrle", "argb")


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


def _ensure_cue_png(rgba_path: Path, rw: int, rh: int) -> Path:
    png_path = rgba_path.with_suffix(".png")
    if png_path.is_file():
        try:
            if png_path.stat().st_mtime >= rgba_path.stat().st_mtime:
                return png_path
        except OSError:
            pass
    from PIL import Image

    raw = rgba_path.read_bytes()
    img = Image.frombytes("RGBA", (rw, rh), raw)
    png_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(png_path, format="PNG", compress_level=1)
    return png_path


def build_cue_overlay_on_layer_filter(
    cue_timings: list[tuple[float, float]],
    *,
    full_w: int,
    full_h: int,
    png_input_start: int = 1,
    wm_input_index: int | None = None,
    wm_x: int = 0,
    wm_y: int = 0,
) -> str:
    """투명/누적 자막 레이어 위에 cue PNG enable overlay (입력 0 = 베이스 레이어)."""
    w, h = max(1, int(full_w)), max(1, int(full_h))
    parts = ["[0:v]format=rgba[base0]"]
    current = "[base0]"
    n = len(cue_timings)
    for i, (start, end) in enumerate(cue_timings):
        en = f"between(t\\,{start:.6f}\\,{end:.6f})"
        in_idx = png_input_start + i
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
    """업로드 cue PNG(-loop 1 -i)를 enable 오버레이로 합성 — movie 필터 미사용(FFmpeg 62+ 호환)."""
    w, h = max(1, int(full_w)), max(1, int(full_h))
    parts = [f"[0:v]fps=fps={fps_expr},setpts=PTS-STARTPTS,setsar=1[vmain]"]
    current = "[vmain]"
    n = len(cue_timings)
    for i, (start, end) in enumerate(cue_timings):
        en = f"between(t\\,{start:.6f}\\,{end:.6f})"
        out = "[vout]" if i == n - 1 and wm_input_index is None else f"[ov{i}]"
        in_idx = i + 1
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
_FRAME_CACHE_MAX = 8


def _read_frame_bytes(path: Path, frame_bytes: int) -> bytes:
    key = str(path.resolve())
    cached = _FRAME_BYTES_CACHE.get(key)
    if cached is not None:
        return cached
    data = path.read_bytes()
    if len(data) != frame_bytes:
        raise ValueError(f"프레임 크기 불일치: {path} ({len(data)} / 기대 {frame_bytes})")
    if len(_FRAME_BYTES_CACHE) >= _FRAME_CACHE_MAX:
        _FRAME_BYTES_CACHE.pop(next(iter(_FRAME_BYTES_CACHE)))
    _FRAME_BYTES_CACHE[key] = data
    return data


def _pick_frame_buffer(
    t: float,
    sorted_cues: list[_TimeCue],
    blank: bytes,
    frame_bytes: int,
) -> bytes:
    """구간 끝 프레임 포함(<= end). 겹치면 마지막 cue 우선 — 짧은 무자막 프레임 깜박임 방지."""
    hit: _TimeCue | None = None
    for c in sorted_cues:
        if t >= c.start and t <= c.end + 1e-7:
            hit = c
    if hit is not None:
        if hit.buf is not None:
            return hit.buf
        if hit.path is not None:
            return _read_frame_bytes(hit.path, frame_bytes)
    return blank


def _iter_rawvideo_chunks(
    render_w: int,
    render_h: int,
    overlay_dur: float,
    fps: int,
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
            chunk_parts.append(_pick_frame_buffer(t, sorted_cues, blank, frame_bytes))
            frame_index += 1
            chunk_bytes += frame_bytes
            chunk_frame_count += 1
        if len(chunk_parts) == 1:
            yield chunk_parts[0], chunk_frame_count
        else:
            yield b"".join(chunk_parts), chunk_frame_count


def _wait_ffmpeg_burn_in(
    proc: subprocess.Popen,
    *,
    overlay_dur: float,
    on_progress: ExportProgressCallback | None,
    timeout_sec: float,
    log_label: str,
) -> None:
    assert proc.stderr is not None
    write_err: list[BaseException] = []
    stderr_tail: list[str] = []
    progress_lock = threading.Lock()
    diag_lock = threading.Lock()
    last_pct = 32.0
    expected_ms = max(1, int(overlay_dur * 1000))
    last_out_time_ms = 0
    last_out_time_at = time.perf_counter()
    stderr_finished = False
    wait_started = time.perf_counter()
    last_heartbeat_at = wait_started
    capped_at_99_logged = False

    def _report(pct: float, msg: str) -> None:
        nonlocal last_pct, capped_at_99_logged
        if not on_progress:
            return
        with progress_lock:
            mapped = max(32.0, min(99.0, float(pct)))
            if mapped > last_pct + 0.05 or mapped >= 99.0:
                if mapped >= 99.0 and not capped_at_99_logged:
                    capped_at_99_logged = True
                    _log.info(
                        "[BURN_IN] ui_progress_capped_99 mode=%s raw_pct=%.2f expected_ms=%s last_out_time_ms=%s",
                        log_label,
                        pct,
                        expected_ms,
                        last_out_time_ms,
                    )
                last_pct = mapped
                on_progress(mapped, msg)

    def _read_stderr() -> None:
        nonlocal last_out_time_ms, last_out_time_at, stderr_finished
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
                    stderr_tail.append(line)
                    if len(stderr_tail) > 200:
                        stderr_tail.pop(0)
                    stripped = line.strip()
                    if stripped.startswith("out_time_ms="):
                        try:
                            raw = int(stripped.split("=", 1)[1])
                            with diag_lock:
                                last_out_time_ms = raw
                                last_out_time_at = time.perf_counter()
                            pct = max(0, min(99, int((raw / expected_ms) * 100)))
                            _report(32.0 + pct * 0.67, "FFmpeg 인코딩 중…")
                        except (ValueError, IndexError):
                            pass
                    elif stripped in {"progress=end", "progress=done"}:
                        _log.info("[BURN_IN] ffmpeg_progress_signal %s", stripped)
        except Exception as exc:
            write_err.append(exc)
        finally:
            stderr_finished = True

    stderr_thread = threading.Thread(target=_read_stderr, name="burn-in-stderr", daemon=True)
    stderr_thread.start()

    deadline = time.perf_counter() + timeout_sec
    while proc.poll() is None:
        now = time.perf_counter()
        if now > deadline:
            proc.kill()
            raise TimeoutError("FFmpeg보내기 시간 초과")
        if now - last_heartbeat_at >= 30.0:
            last_heartbeat_at = now
            stall_ms = (now - last_out_time_at) * 1000.0 if last_out_time_ms > 0 else -1.0
            _log.info(
                "[BURN_IN] heartbeat mode=%s elapsed=%.1fs ui_pct=%.1f stderr_done=%s "
                "last_out_time_ms=%s out_time_stall_ms=%.0f",
                log_label,
                now - wait_started,
                last_pct,
                stderr_finished,
                last_out_time_ms,
                stall_ms,
            )
        time.sleep(0.1)

    stderr_thread.join(timeout=5.0)
    rest = proc.stderr.read()
    if rest:
        stderr_tail.append(rest.decode("utf-8", errors="replace"))
    ffmpeg_err = "\n".join(stderr_tail)[-4000:]
    if proc.returncode != 0 or write_err:
        _log.error("[BURN_IN] ffmpeg_stderr_tail mode=%s\n%s", log_label, ffmpeg_err[-1500:])
    if write_err:
        raise write_err[0]
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg 실패 (exit {proc.returncode}): {ffmpeg_err or 'unknown'}")


def _chunk_cue_pngs(
    cue_pngs: list[tuple[Path, float, float]],
    batch_size: int,
) -> list[list[tuple[Path, float, float]]]:
    if batch_size < 1:
        raise ValueError("batch_size must be >= 1")
    return [cue_pngs[i : i + batch_size] for i in range(0, len(cue_pngs), batch_size)]


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

    write_err: list[BaseException] = []
    stderr_tail: list[str] = []
    progress_lock = threading.Lock()
    diag_lock = threading.Lock()
    last_pct = progress_base
    expected_ms = max(1, int(overlay_dur * 1000))
    last_out_time_ms = 0
    stderr_finished = False
    wait_started = time.perf_counter()
    capped_at_99_logged = False

    def _report(pct: float, msg: str) -> None:
        nonlocal last_pct, capped_at_99_logged
        if not on_progress:
            return
        with progress_lock:
            mapped = max(progress_base, min(progress_base + progress_span, float(pct)))
            cap = progress_base + progress_span
            if mapped > last_pct + 0.05 or mapped >= cap - 0.01:
                if mapped >= cap - 0.01 and not capped_at_99_logged:
                    capped_at_99_logged = True
                last_pct = mapped
                on_progress(mapped, msg)

    def _read_stderr() -> None:
        nonlocal last_out_time_ms, stderr_finished
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
                    stderr_tail.append(line)
                    if len(stderr_tail) > 200:
                        stderr_tail.pop(0)
                    stripped = line.strip()
                    if stripped.startswith("out_time_ms="):
                        try:
                            raw = int(stripped.split("=", 1)[1])
                            with diag_lock:
                                last_out_time_ms = raw
                            pct = max(0, min(99, int((raw / expected_ms) * 100)))
                            _report(
                                progress_base + (pct / 100.0) * progress_span,
                                progress_message,
                            )
                        except (ValueError, IndexError):
                            pass
        except Exception as exc:
            write_err.append(exc)
        finally:
            stderr_finished = True

    stderr_thread = threading.Thread(target=_read_stderr, name="burn-in-stderr", daemon=True)
    stderr_thread.start()

    deadline = time.perf_counter() + timeout_sec
    while proc.poll() is None:
        if time.perf_counter() > deadline:
            proc.kill()
            raise TimeoutError("FFmpeg보내기 시간 초과")
        time.sleep(0.1)

    stderr_thread.join(timeout=5.0)
    rest = proc.stderr.read()
    if rest:
        stderr_tail.append(rest.decode("utf-8", errors="replace"))
    ffmpeg_err = "\n".join(stderr_tail)[-4000:]
    if proc.returncode != 0 or write_err:
        _log.error("[BURN_IN] ffmpeg_stderr_tail mode=%s\n%s", log_label, ffmpeg_err[-1500:])
    if write_err:
        raise write_err[0]
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg 실패 (exit {proc.returncode}): {ffmpeg_err or 'unknown'}")


def _write_transparent_segment_mov(
    ffmpeg: str,
    path: Path,
    duration: float,
    w: int,
    h: int,
) -> None:
    if duration <= 1e-6:
        return
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-f",
        "lavfi",
        "-i",
        f"color=c=0x00000000:s={w}x{h}:d={duration:.6f}:r=30",
        "-an",
        "-c:v",
        SUBTITLE_LAYER_CODEC[0],
        "-pix_fmt",
        SUBTITLE_LAYER_CODEC[1],
        str(path),
    ]
    proc = subprocess.run(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=no_window_creationflags(),
    )
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", errors="replace")[-1500:]
        raise RuntimeError(f"투명 구간 생성 실패: {err or proc.returncode}")


def _write_png_segment_mov(
    ffmpeg: str,
    png_path: Path,
    path: Path,
    duration: float,
    w: int,
    h: int,
) -> None:
    dur = max(0.04, float(duration))
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loop",
        "1",
        "-i",
        str(png_path),
        "-t",
        f"{dur:.6f}",
        "-vf",
        f"scale={w}:{h}",
        "-an",
        "-c:v",
        SUBTITLE_LAYER_CODEC[0],
        "-pix_fmt",
        SUBTITLE_LAYER_CODEC[1],
        str(path),
    ]
    proc = subprocess.run(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=no_window_creationflags(),
    )
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", errors="replace")[-1500:]
        raise RuntimeError(f"자막 구간 생성 실패: {err or proc.returncode}")


def _cue_pngs_overlap(cue_pngs: list[tuple[Path, float, float]]) -> bool:
    ordered = sorted(cue_pngs, key=lambda item: (item[1], item[2]))
    prev_end = -1.0
    for _, start, end in ordered:
        if start < prev_end - 1e-6:
            return True
        prev_end = max(prev_end, end)
    return False


def _build_subtitle_layer_mov_concat(
    *,
    ffmpeg: str,
    cue_pngs: list[tuple[Path, float, float]],
    overlay_dur: float,
    w: int,
    h: int,
    work_dir: Path,
    on_progress: ExportProgressCallback | None,
) -> Path:
    """cue/gap 구간별 짧은 qtrle 클립 → concat (overlay 필터 N-input 회피)."""
    segments_dir = work_dir / "_subtitle_segs"
    segments_dir.mkdir(parents=True, exist_ok=True)
    for old in segments_dir.glob("*.mov"):
        try:
            old.unlink()
        except OSError:
            pass

    ordered = sorted(cue_pngs, key=lambda item: (item[1], item[2]))
    segments: list[Path] = []
    pos = 0.0
    total_steps = max(1, len(ordered) * 2 + 1)
    step = 0

    for png_path, start, end in ordered:
        start = max(0.0, min(float(start), overlay_dur))
        end = max(start, min(float(end), overlay_dur))
        if end <= start + 1e-6:
            continue
        if start > pos + 1e-6:
            seg = segments_dir / f"seg_{len(segments):04d}.mov"
            _write_transparent_segment_mov(ffmpeg, seg, start - pos, w, h)
            segments.append(seg)
            pos = start
            step += 1
            if on_progress:
                on_progress(32.0 + (step / total_steps) * 28.0, "자막 레이어 합성…")
        seg = segments_dir / f"seg_{len(segments):04d}.mov"
        _write_png_segment_mov(ffmpeg, png_path, seg, end - start, w, h)
        segments.append(seg)
        pos = end
        step += 1
        if on_progress:
            on_progress(32.0 + (step / total_steps) * 28.0, "자막 레이어 합성…")

    if pos < overlay_dur - 1e-6:
        seg = segments_dir / f"seg_{len(segments):04d}.mov"
        _write_transparent_segment_mov(ffmpeg, seg, overlay_dur - pos, w, h)
        segments.append(seg)

    if not segments:
        raise ValueError("자막 레이어 세그먼트가 없습니다.")

    list_path = work_dir / "_subtitle_concat.txt"
    lines: list[str] = []
    for seg in segments:
        esc = str(seg.resolve()).replace("\\", "/").replace("'", "'\\''")
        lines.append(f"file '{esc}'")
    list_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    layer_path = work_dir / "_subtitle_layer.mov"
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_path),
        "-c",
        "copy",
        str(layer_path),
    ]
    proc = subprocess.run(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=no_window_creationflags(),
    )
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", errors="replace")[-1500:]
        raise RuntimeError(f"자막 레이어 concat 실패: {err or proc.returncode}")

    try:
        list_path.unlink(missing_ok=True)
    except OSError:
        pass
    for seg in segments:
        try:
            seg.unlink(missing_ok=True)
        except OSError:
            pass
    try:
        segments_dir.rmdir()
    except OSError:
        pass
    return layer_path


def _build_batched_subtitle_layer_mov(
    *,
    ffmpeg: str,
    cue_pngs: list[tuple[Path, float, float]],
    overlay_dur: float,
    fps_expr: str,
    w: int,
    h: int,
    work_dir: Path,
    on_progress: ExportProgressCallback | None,
    timeout_sec: float,
) -> Path:
    """cue PNG를 소배치 overlay로 투명 자막 레이어 mov 생성 (입력 수 제한)."""
    batches = _chunk_cue_pngs(cue_pngs, CUE_OVERLAY_BATCH_SIZE)
    layer_path: Path | None = None
    temp_paths: list[Path] = []

    for bi, batch in enumerate(batches):
        out_path = work_dir / f"_subtitle_layer_{bi:03d}.mov"
        temp_paths.append(out_path)
        script_path = work_dir / f"_subtitle_layer_{bi:03d}.txt"

        if on_progress:
            pct = 32.0 + (bi / max(1, len(batches))) * 28.0
            on_progress(pct, f"자막 레이어 합성 ({bi + 1}/{len(batches)})…")

        cmd = [ffmpeg, "-y", "-hide_banner"]
        if layer_path is None:
            lavfi = f"color=c=0x00000000:s={w}x{h}:d={overlay_dur:.6f}:r={fps_expr}"
            cmd.extend(["-f", "lavfi", "-i", lavfi])
        else:
            cmd.extend(["-i", str(layer_path)])
        for png_path, _, _ in batch:
            cmd.extend(["-loop", "1", "-i", str(png_path)])

        script_body = build_cue_overlay_on_layer_filter(
            [(start, end) for _, start, end in batch],
            full_w=w,
            full_h=h,
        )
        cmd.extend(
            [
                *filter_complex_argv(ffmpeg, script_body, script_path=script_path),
                "-map",
                "[vout]",
                "-an",
                "-c:v",
                SUBTITLE_LAYER_CODEC[0],
                "-pix_fmt",
                SUBTITLE_LAYER_CODEC[1],
                "-t",
                f"{overlay_dur:.6f}",
                "-progress",
                "pipe:2",
                "-nostats",
                str(out_path),
            ]
        )
        _log.info(
            "[BURN_IN] subtitle_layer_batch batch=%s/%s cues=%s in=%s out=%s",
            bi + 1,
            len(batches),
            len(batch),
            layer_path.name if layer_path else "lavfi",
            out_path.name,
        )
        _run_ffmpeg_filter_pass(
            cmd,
            overlay_dur=overlay_dur,
            on_progress=on_progress,
            timeout_sec=timeout_sec,
            log_label=f"subtitle_layer_{bi}",
            progress_base=32.0 + (bi / max(1, len(batches))) * 28.0,
            progress_span=28.0 / max(1, len(batches)),
            progress_message=f"자막 레이어 합성 ({bi + 1}/{len(batches)})…",
        )
        layer_path = out_path

    if layer_path is None:
        raise ValueError("자막 레이어를 생성하지 못했습니다.")
    for p in temp_paths:
        if p != layer_path and p.is_file():
            try:
                p.unlink()
            except OSError:
                pass
    for p in work_dir.glob("_subtitle_layer_*.txt"):
        try:
            p.unlink()
        except OSError:
            pass
    return layer_path


def _run_cue_file_burn_in(
    *,
    ffmpeg: str,
    input_video_path: Path,
    output_path: Path,
    pairs: list[_TimeCue],
    overlay_dur: float,
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
    on_progress: ExportProgressCallback | None,
    timeout_sec: float,
) -> None:
    cue_pngs: list[tuple[Path, float, float]] = []
    for c in pairs:
        if c.path is None:
            raise ValueError("cue overlay 경로에 frame path가 없습니다.")
        cue_pngs.append((_ensure_cue_png(c.path, rw, rh), c.start, c.end))

    work_dir = output_path.parent
    if _cue_pngs_overlap(cue_pngs):
        _log.warning("[BURN_IN] overlapping cues detected — batched overlay fallback")
        layer_mov = _build_batched_subtitle_layer_mov(
            ffmpeg=ffmpeg,
            cue_pngs=cue_pngs,
            overlay_dur=overlay_dur,
            fps_expr=fps_expr,
            w=w,
            h=h,
            work_dir=work_dir,
            on_progress=on_progress,
            timeout_sec=timeout_sec,
        )
    else:
        layer_mov = _build_subtitle_layer_mov_concat(
            ffmpeg=ffmpeg,
            cue_pngs=cue_pngs,
            overlay_dur=overlay_dur,
            w=w,
            h=h,
            work_dir=work_dir,
            on_progress=on_progress,
        )

    if on_progress:
        on_progress(62.0, "FFmpeg 영상·자막 합성·인코딩…")

    vmain_chain = f"[0:v]fps=fps={fps_expr},setpts=PTS-STARTPTS,setsar=1[vmain]"
    if wm_path is not None:
        filter_complex = (
            f"{vmain_chain};"
            f"[1:v]format=rgba[sub];"
            f"[vmain][sub]overlay=0:0[vsub];"
            f"[vsub][2:v]overlay={wm_x}:{wm_y}[vout]"
        )
    else:
        filter_complex = (
            f"{vmain_chain};"
            f"[1:v]format=rgba[sub];"
            f"[vmain][sub]overlay=0:0[vout]"
        )

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
        "-i",
        str(layer_mov),
    ]
    if wm_path is not None:
        cmd.extend(["-loop", "1", "-i", str(wm_path)])
    cmd.extend(
        [
            "-filter_complex",
            filter_complex,
            "-map",
            "[vout]",
            "-map",
            "0:a?",
            "-map",
            "-0:s",
            *enc_args,
            "-c:a",
            "copy",
            "-t",
            f"{overlay_dur:.6f}",
            "-progress",
            "pipe:2",
            "-nostats",
            str(output_path),
        ]
    )
    _log.info(
        "[BURN_IN] ffmpeg_start mode=layer_mux input=%s layer=%s output=%s encoder=%s "
        "overlay_dur=%.3f cues=%s render=%dx%d full=%dx%d fps=%s",
        input_video_path.name,
        layer_mov.name,
        output_path.name,
        chosen_encoder,
        overlay_dur,
        len(cue_pngs),
        rw,
        rh,
        w,
        h,
        fps_expr,
    )
    enc_label = chosen_encoder.replace("h264_", "").upper()
    mux_message = f"FFmpeg 인코딩 중… ({enc_label})"
    _run_ffmpeg_filter_pass(
        cmd,
        overlay_dur=overlay_dur,
        on_progress=on_progress,
        timeout_sec=timeout_sec,
        log_label="layer_mux",
        progress_base=62.0,
        progress_span=37.0,
        progress_message=mux_message,
    )
    try:
        layer_mov.unlink(missing_ok=True)
    except OSError:
        pass
    _log.info(
        "[BURN_IN] ffmpeg_success mode=layer_mux output=%s size_bytes=%s",
        output_path.name,
        output_path.stat().st_size if output_path.is_file() else 0,
    )
    if on_progress:
        on_progress(100.0, "완료")


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
            size = p.stat().st_size
            if size != frame_bytes:
                raise ValueError(f"프레임 {i} 크기 불일치: {size} (기대 {frame_bytes})")
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
    blank = bytes(frame_bytes)
    total_frames = max(1, math.ceil(overlay_dur * fps - 1e-9))

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

    if frame_paths is not None:
        _run_cue_file_burn_in(
            ffmpeg=ffmpeg,
            input_video_path=input_video_path,
            output_path=output_path,
            pairs=pairs,
            overlay_dur=overlay_dur,
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
            on_progress=on_progress,
            timeout_sec=timeout_sec,
        )
        return

    # concat copy 등 VFR/깨진 PTS 입력은 setpts만으로는 1프레임으로 끝남 → fps로 CFR 정규화
    vmain_chain = f"[0:v]fps=fps={fps_expr},setpts=PTS-STARTPTS,setsar=1[vmain]"
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
        on_progress(32.0, "FFmpeg 자막 합성·인코딩…")

    def _try_start_ffmpeg(enc_args: list[str]) -> subprocess.Popen:
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
        cmd.extend([
            "-filter_complex",
            filter_complex,
            "-map",
            "[vout]",
            "-map",
            "0:a?",
            "-map",
            "-0:s",
            *enc_args,
            "-c:a",
            "copy",
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
    stderr_tail: list[str] = []
    progress_lock = threading.Lock()
    diag_lock = threading.Lock()
    last_pct = 32.0
    expected_ms = max(1, int(overlay_dur * 1000))
    last_out_time_ms = 0
    last_out_time_at = time.perf_counter()
    stdin_frames_sent = 0
    stdin_finished = False
    stderr_finished = False
    wait_started = time.perf_counter()
    last_heartbeat_at = wait_started
    capped_at_99_logged = False

    def _report(pct: float, msg: str) -> None:
        nonlocal last_pct, capped_at_99_logged
        if not on_progress:
            return
        with progress_lock:
            mapped = max(32.0, min(99.0, float(pct)))
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

    def _read_stderr() -> None:
        nonlocal last_out_time_ms, last_out_time_at, stderr_finished
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
                    stderr_tail.append(line)
                    if len(stderr_tail) > 200:
                        stderr_tail.pop(0)
                    stripped = line.strip()
                    if stripped.startswith("out_time_ms="):
                        try:
                            raw = int(stripped.split("=", 1)[1])
                            with diag_lock:
                                last_out_time_ms = raw
                                last_out_time_at = time.perf_counter()
                            pct = max(0, min(99, int((raw / expected_ms) * 100)))
                            _report(40.0 + pct * 0.59, "FFmpeg 인코딩 중…")
                        except (ValueError, IndexError):
                            pass
                    elif stripped in {"progress=end", "progress=done"}:
                        _log.info("[BURN_IN] ffmpeg_progress_signal %s", stripped)
        except Exception as exc:
            write_err.append(exc)
        finally:
            stderr_finished = True
            _log.info(
                "[BURN_IN] stderr_reader_done last_out_time_ms=%s tail_lines=%s",
                last_out_time_ms,
                len(stderr_tail),
            )

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
                    _report(32.0 + send_pct * 8.0, "자막 레이어 전송…")
            proc.stdin.close()
            _log.info(
                "[BURN_IN] stdin_write_done frames_sent=%s/%s elapsed=%.2fs",
                frames_sent,
                total_frames,
                time.perf_counter() - t0,
            )
        except (BrokenPipeError, OSError) as exc:
            # -shortest로 인해 FFmpeg가 영상 끝에서 stdin을 닫는 것은 정상 동작
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

    stderr_thread = threading.Thread(target=_read_stderr, name="burn-in-stderr", daemon=True)
    writer = threading.Thread(target=_write_stdin, name="burn-in-stdin", daemon=True)
    stderr_thread.start()
    writer.start()

    deadline = time.perf_counter() + timeout_sec
    while proc.poll() is None:
        now = time.perf_counter()
        if now > deadline:
            _log.error(
                "[BURN_IN] ffmpeg_timeout elapsed=%.1fs stdin_done=%s stderr_done=%s "
                "frames_sent=%s/%s last_out_time_ms=%s",
                now - wait_started,
                stdin_finished,
                stderr_finished,
                stdin_frames_sent,
                total_frames,
                last_out_time_ms,
            )
            proc.kill()
            raise TimeoutError("FFmpeg보내기 시간 초과")
        if now - last_heartbeat_at >= 30.0:
            last_heartbeat_at = now
            stall_ms = (now - last_out_time_at) * 1000.0 if last_out_time_ms > 0 else -1.0
            _log.info(
                "[BURN_IN] heartbeat elapsed=%.1fs ui_pct=%.1f stdin_done=%s stderr_done=%s "
                "writer_alive=%s stderr_alive=%s frames_sent=%s/%s last_out_time_ms=%s "
                "out_time_stall_ms=%.0f",
                now - wait_started,
                last_pct,
                stdin_finished,
                stderr_finished,
                writer.is_alive(),
                stderr_thread.is_alive(),
                stdin_frames_sent,
                total_frames,
                last_out_time_ms,
                stall_ms,
            )
        time.sleep(0.1)

    elapsed = time.perf_counter() - wait_started
    writer.join(timeout=10.0)
    stderr_thread.join(timeout=5.0)
    _log.info(
        "[BURN_IN] ffmpeg_exited pid=%s returncode=%s elapsed=%.2fs stdin_done=%s "
        "stderr_done=%s writer_joined=%s stderr_joined=%s frames_sent=%s/%s last_out_time_ms=%s",
        proc.pid,
        proc.returncode,
        elapsed,
        stdin_finished,
        stderr_finished,
        not writer.is_alive(),
        not stderr_thread.is_alive(),
        stdin_frames_sent,
        total_frames,
        last_out_time_ms,
    )

    rest = proc.stderr.read()
    if rest:
        stderr_tail.append(rest.decode("utf-8", errors="replace"))

    ffmpeg_err = "\n".join(stderr_tail)[-4000:]
    if proc.returncode != 0 or write_err:
        _log.error(
            "[BURN_IN] ffmpeg_stderr_tail\n%s",
            ffmpeg_err[-1500:],
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

    if proc.returncode != 0:
        err = ffmpeg_err
        raise RuntimeError(f"FFmpeg 실패 (exit {proc.returncode}): {err or 'unknown'}")
    _log.info(
        "[BURN_IN] ffmpeg_success output=%s size_bytes=%s",
        output_path.name,
        output_path.stat().st_size if output_path.is_file() else 0,
    )
    if on_progress:
        on_progress(100.0, "완료")
