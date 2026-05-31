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
from common.subprocess_util import no_window_creationflags
from engines.auto_subtitle_export import ExportProgressCallback

EXPORT_FPS = 30
STDIN_FRAME_CHUNK = 20
RAWVIDEO_PIXEL_FORMAT = "rgba"

import logging as _logging

_log = _logging.getLogger(__name__)


def _probe_encoder(ffmpeg: str, encoder: str) -> bool:
    """GPU 인코더가 실제 사용 가능한지 1-frame 테스트."""
    if encoder == "libx264":
        return True
    try:
        p = subprocess.run(
            [
                ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "nullsrc=s=64x64:d=0.04",
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


def build_h264_video_encode_args(encoder: str) -> list[str]:
    e = (encoder or "libx264").strip().lower()
    if e == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p1", "-cq", "23"]
    if e == "h264_qsv":
        return ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "23"]
    if e == "h264_amf":
        return ["-c:v", "h264_amf", "-quality", "speed"]
    return ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23"]


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
    for c in sorted_cues:
        if t >= c.start and t < c.end - 1e-9:
            if c.buf is not None:
                return c.buf
            if c.path is not None:
                return _read_frame_bytes(c.path, frame_bytes)
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
    on_progress: ExportProgressCallback | None = None,
    timeout_sec: float = 7200.0,
) -> None:
    if raw_frame_buffers is None and frame_paths is None:
        raise ValueError("raw_frame_buffers 또는 frame_paths 가 필요합니다.")
    if raw_frame_buffers is not None and frame_paths is not None:
        raise ValueError("raw_frame_buffers 와 frame_paths 는 동시에 지정할 수 없습니다.")

    ffmpeg = str(ffmpeg_path or get_ffmpeg_executable())
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
    total_frames = max(1, math.ceil(overlay_dur * EXPORT_FPS - 1e-9))

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

    if wm_path is not None:
        filter_complex = (
            f"[0:v]setpts=PTS-STARTPTS[vmain];"
            f"[1:v]format=rgba,scale={w}:{h}:flags=lanczos[sub];"
            f"[vmain][sub]overlay=0:0:shortest=1[vsub];"
            f"[vsub][2:v]overlay={wm_x}:{wm_y}[vout]"
        )
    else:
        filter_complex = (
            f"[0:v]setpts=PTS-STARTPTS[vmain];"
            f"[1:v]format=rgba,scale={w}:{h}:flags=lanczos[sub];"
            f"[vmain][sub]overlay=0:0:shortest=1[vout]"
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
            "-i",
            str(input_video_path),
            "-f",
            "rawvideo",
            "-pixel_format",
            RAWVIDEO_PIXEL_FORMAT,
            "-video_size",
            f"{rw}x{rh}",
            "-framerate",
            str(EXPORT_FPS),
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
            "-movflags",
            "+faststart",
            "-shortest",
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

    chosen_encoder = (h264_encoder or "libx264").strip().lower()
    if chosen_encoder != "libx264" and not _probe_encoder(ffmpeg, chosen_encoder):
        _log.warning("인코더 %s 사용 불가 → libx264 fallback", chosen_encoder)
        chosen_encoder = "libx264"

    enc_args = build_h264_video_encode_args(chosen_encoder)
    proc = _try_start_ffmpeg(enc_args)
    assert proc.stdin is not None
    assert proc.stderr is not None

    write_err: list[BaseException] = []
    stderr_tail: list[str] = []
    progress_lock = threading.Lock()
    last_pct = 32.0
    expected_ms = max(1, int(overlay_dur * 1000))

    def _report(pct: float, msg: str) -> None:
        nonlocal last_pct
        if not on_progress:
            return
        with progress_lock:
            mapped = max(32.0, min(99.0, float(pct)))
            if mapped > last_pct + 0.05 or mapped >= 99.0:
                last_pct = mapped
                on_progress(mapped, msg)

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
                    stderr_tail.append(line)
                    if len(stderr_tail) > 200:
                        stderr_tail.pop(0)
                    stripped = line.strip()
                    if stripped.startswith("out_time_ms="):
                        try:
                            raw = int(stripped.split("=", 1)[1])
                            pct = max(0, min(99, int((raw / expected_ms) * 100)))
                            _report(40.0 + pct * 0.59, "FFmpeg 인코딩 중…")
                        except (ValueError, IndexError):
                            pass
        except Exception as exc:
            write_err.append(exc)

    def _write_stdin() -> None:
        frames_sent = 0
        try:
            for chunk, n_frames in _iter_rawvideo_chunks(
                rw, rh, overlay_dur, EXPORT_FPS, pairs, blank
            ):
                proc.stdin.write(chunk)
                frames_sent += n_frames
                if total_frames > 0:
                    send_pct = frames_sent / total_frames
                    _report(32.0 + send_pct * 8.0, "자막 레이어 전송…")
            proc.stdin.close()
        except (BrokenPipeError, OSError) as exc:
            # -shortest로 인해 FFmpeg가 영상 끝에서 stdin을 닫는 것은 정상 동작
            try:
                proc.stdin.close()
            except OSError:
                pass
            _log.info("stdin closed by FFmpeg (expected with -shortest): %s", exc)
        except Exception as exc:
            write_err.append(exc)
            try:
                proc.kill()
            except OSError:
                pass

    stderr_thread = threading.Thread(target=_read_stderr, daemon=True)
    writer = threading.Thread(target=_write_stdin, daemon=True)
    stderr_thread.start()
    writer.start()

    deadline = time.perf_counter() + timeout_sec
    while proc.poll() is None:
        if time.perf_counter() > deadline:
            proc.kill()
            raise TimeoutError("FFmpeg보내기 시간 초과")
        time.sleep(0.1)

    writer.join(timeout=10.0)
    stderr_thread.join(timeout=5.0)

    rest = proc.stderr.read()
    if rest:
        stderr_tail.append(rest.decode("utf-8", errors="replace"))

    ffmpeg_err = "\n".join(stderr_tail)[-4000:]

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
    if on_progress:
        on_progress(100.0, "완료")
