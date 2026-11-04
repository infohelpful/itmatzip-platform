"""Video burn-in and audio export (port of desktop src/main: ffmpeg-single-pass.ts, ffmpegClipGraph.ts,
audioClipGraph.ts, audioExport.ts, validateMediaDecode.ts and the `export:by-format` handler).

Electron captured each subtitle state from an offscreen window. On the web the browser renders the
same markup to PNG (one per state) and uploads it; the agent decodes the PNGs in order and streams
raw BGRA frames to FFmpeg exactly like the desktop single pass: one overlay frame per output frame,
blank between states, scaled over the source and encoded once.
"""
from __future__ import annotations

import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any

from . import media, paths

EXPORT_FPS = 30
MAX_RENDER_W, MAX_RENDER_H = 1920, 1080
VIDEO_TIMEOUT_SEC = 2 * 60 * 60
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


# -- clip plan (shared/clipPlan.ts) ------------------------------------------------------
def validate_clip_plan(clips: list[dict[str, Any]], source_duration: float) -> list[dict[str, Any]]:
    if not math.isfinite(source_duration) or source_duration <= 0:
        raise ValueError("Invalid source duration")
    if not clips:
        raise ValueError("No media remains in the clip plan")
    nxt, ids, out = 0.0, set(), []
    for clip in clips:
        try:
            cid, s, e, p = str(clip["occurrenceId"]), float(clip["sourceStart"]), float(clip["sourceEnd"]), float(clip["programStart"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("Invalid clip plan") from error
        if (not cid or cid in ids or not all(map(math.isfinite, (s, e, p))) or s < 0
                or e > source_duration + 1e-6 or e <= s or abs(p - nxt) > 1e-6):
            raise ValueError("Invalid clip plan")
        ids.add(cid)
        e = min(source_duration, e)
        out.append({"occurrenceId": cid, "sourceStart": s, "sourceEnd": e, "programStart": nxt})
        nxt += e - s
    return out


def clip_plan_from_cuts(duration: float, cuts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ranges = sorted(({"start": max(0.0, min(duration, float(c["start"]))), "end": max(0.0, min(duration, float(c["end"])))}
                     for c in cuts if float(c["end"]) >= float(c["start"])), key=lambda r: r["start"])
    result: list[dict[str, Any]] = []
    cursor = program = 0.0

    def append(start: float, end: float) -> None:
        nonlocal program
        if end <= start:
            return
        result.append({"occurrenceId": f"clip-{len(result)}", "sourceStart": start, "sourceEnd": end, "programStart": program})
        program += end - start

    for cut in ranges:
        append(cursor, cut["start"])
        cursor = max(cursor, cut["end"])
    append(cursor, duration)
    return result


def program_duration(clips: list[dict[str, Any]]) -> float:
    last = clips[-1] if clips else None
    return last["programStart"] + last["sourceEnd"] - last["sourceStart"] if last else 0.0


def _f(value: float) -> str:
    return f"{value:.9f}"


def build_clip_graph(clips: list[dict[str, Any]], duration: float, origin: float, has_audio: bool) -> str:
    """ffmpegClipGraph.ts buildClipGraph, line for line."""
    plan = validate_clip_plan(clips, duration)
    n = len(plan)
    filters = [f"[0:v:0]setpts=PTS-({_f(origin)})/TB,split={n}" + "".join(f"[vs{i}]" for i in range(n))]
    if has_audio:
        filters.append(f"[0:a:0]asetpts=PTS-({_f(origin)})/TB,aresample=async=1:first_pts=0,apad,atrim=end={_f(duration)},"
                       f"asplit={n}" + "".join(f"[as{i}]" for i in range(n)))
    visible = []
    for i, c in enumerate(plan):
        start_frame = math.ceil(c["programStart"] * 30 - 1e-9)
        end_frame = math.ceil((c["programStart"] + c["sourceEnd"] - c["sourceStart"]) * 30 - 1e-9)
        frames = end_frame - start_frame
        if frames > 0:
            filters.append(f"[vs{i}]trim=start={_f(c['sourceStart'])}:end={_f(c['sourceEnd'])},setpts=PTS-({_f(c['sourceStart'])})/TB,"
                           f"fps=30,tpad=stop_mode=clone:stop_duration=1,trim=end_frame={frames},setpts=N/(30*TB)[v{i}]")
            visible.append(f"[v{i}]")
        else:
            filters.append(f"[vs{i}]nullsink")
        if has_audio:
            filters.append(f"[as{i}]atrim=start={_f(c['sourceStart'])}:end={_f(c['sourceEnd'])},asetpts=PTS-({_f(c['sourceStart'])})/TB[a{i}]")
    if not visible:
        raise ValueError("No output video frames")
    filters.append("".join(visible) + f"concat=n={len(visible)}:v=1:a=0[vjoined];[vjoined]setpts=N/(30*TB)[vmain]")
    if has_audio:
        filters.append("".join(f"[a{i}]" for i in range(n)) + f"concat=n={n}:v=0:a=1[amain]")
    return ";".join(filters)


def build_audio_clip_graph(clips: list[dict[str, Any]], duration: float) -> str:
    plan = validate_clip_plan(clips, duration)
    n = len(plan)
    filters = [f"[0:a:0]asplit={n}" + "".join(f"[src{i}]" for i in range(n))]
    for i, c in enumerate(plan):
        filters.append(f"[src{i}]atrim=start_sample={round(c['sourceStart'] * 48000)}:end_sample={round(c['sourceEnd'] * 48000)},"
                       f"asetpts=PTS-STARTPTS[a{i}]")
    filters.append("".join(f"[a{i}]" for i in range(n)) + f"concat=n={n}:v=0:a=1[aout]")
    return ";".join(filters)


def render_dimensions(full_w: int, full_h: int) -> tuple[int, int]:
    w, h = max(1, full_w), max(1, full_h)
    scale = min(MAX_RENDER_W / w, MAX_RENDER_H / h, 1)
    return max(320, round(w * scale)), max(240, round(h * scale))


def h264_encode_args(encoder: str) -> list[str]:
    e = (encoder or "libx264").strip().lower()
    if e == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p1", "-cq", "23"]
    if e == "h264_qsv":
        return ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "23"]
    if e == "h264_amf":
        return ["-c:v", "h264_amf", "-quality", "speed"]
    return ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23"]


ENCODER_NAMES = {"h264_nvenc": "NVIDIA NVENC (h264_nvenc)", "h264_qsv": "Intel Quick Sync (h264_qsv)",
                 "h264_amf": "AMD AMF (h264_amf)", "libx264": "x264 (CPU, ultrafast · CRF 23)"}


def select_h264_encoder(ffmpeg: str) -> str:
    try:
        out = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True, timeout=30,
                             creationflags=_NO_WINDOW).stdout.decode("utf-8", "replace")
    except (OSError, subprocess.TimeoutExpired):
        return "libx264"
    for name in ("h264_nvenc", "h264_qsv", "h264_amf"):
        if re.search(rf"\b{name}\b", out):
            return name
    return "libx264"


def progress_percent(line: str, expected_sec: float) -> int | None:
    m = re.fullmatch(r"out_time_(?:us|ms)=(-?\d+)", line.strip())
    if not m or not math.isfinite(expected_sec) or expected_sec <= 0:
        return None
    raw = int(m.group(1))
    return max(0, min(99, math.floor(raw / (expected_sec * 1e6) * 100))) if raw >= 0 else None


def validate_media_decode(ffmpeg: str, path: Path, *, audio_only: bool = False, cancel: threading.Event | None = None) -> None:
    args = [ffmpeg, "-v", "error", "-xerror", "-i", str(path),
            *(["-map", "0:a:0"] if audio_only else ["-map", "0:v:0", "-map", "0:a?"]), "-f", "null", "-"]
    proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                            creationflags=_NO_WINDOW)
    _wait(proc, cancel, VIDEO_TIMEOUT_SEC, "출력 전체 디코드 검증 실패")


def _wait(proc: subprocess.Popen[bytes], cancel: threading.Event | None, timeout: float, failure: str) -> None:
    import time

    deadline = time.monotonic() + timeout
    while True:
        try:
            _, err = proc.communicate(timeout=0.25)
            break
        except subprocess.TimeoutExpired:
            if (cancel and cancel.is_set()) or time.monotonic() > deadline:
                proc.kill()
                proc.wait()
                raise RuntimeError("Export canceled" if cancel and cancel.is_set() else f"{failure}: timed out") from None
    if proc.returncode != 0:
        raise RuntimeError(f"{failure}: {(err or b'').decode('utf-8', 'replace')[-4000:]}")


# -- output location & jobs --------------------------------------------------------------
_exported: set[str] = set()
_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()


def output_path(input_path: Path, out_dir: str, ext: str) -> Path:
    folder = Path(out_dir)
    if not folder.is_dir():
        raise ValueError("저장할 폴더를 찾을 수 없습니다.")
    stem = f"{input_path.stem}_AutoSubtitle"
    candidate = folder / f"{stem}{ext}"
    n = 2
    while candidate.exists():
        candidate = folder / f"{stem} ({n}){ext}"
        n += 1
    if os.path.normcase(str(candidate)) == os.path.normcase(str(input_path)):
        raise ValueError("원본 영상과 다른 저장 경로를 선택하세요.")
    return candidate


_FOLDERID_DOWNLOADS = "{374DE290-123F-4565-9164-39C4925E467B}"


def downloads_dir() -> Path:
    """The user's Downloads folder (Windows known folder, so a moved/redirected folder is honoured)."""
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            class _GUID(ctypes.Structure):
                _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD), ("Data3", wintypes.WORD),
                            ("Data4", ctypes.c_ubyte * 8)]

            guid = _GUID()
            ctypes.oledll.ole32.CLSIDFromString(_FOLDERID_DOWNLOADS, ctypes.byref(guid))
            out = ctypes.c_wchar_p()
            ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(out))
            try:
                if out.value and Path(out.value).is_dir():
                    return Path(out.value)
            finally:
                ctypes.windll.ole32.CoTaskMemFree(out)
        except (OSError, AttributeError, ValueError):
            pass
    fallback = Path.home() / "Downloads"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


_TEXT_EXTS = {".srt", ".vtt", ".ass", ".txt"}
_MAX_TEXT_BYTES = 20 * 1024 * 1024


def save_text(input_path: str, out_dir: str, ext: str, text: str) -> Path:
    """Write a subtitle/script text export (UTF-8 with BOM, like the browser save) without overwriting anything."""
    ext = ext.lower() if ext.startswith(".") else f".{ext.lower()}"
    if ext not in _TEXT_EXTS:
        raise ValueError(f"지원하지 않는 내보내기 형식: {ext}")
    data = ("\ufeff" + text).encode("utf-8")
    if len(data) > _MAX_TEXT_BYTES:
        raise ValueError("내보낼 자막이 너무 큽니다.")
    target = output_path(Path(input_path or "AutoSubtitle"), out_dir, ext)
    with open(target, "xb") as fh:
        fh.write(data)
    _exported.add(os.path.normcase(str(target)))
    return target


def _new_job(kind: str, output: Path) -> dict[str, Any]:
    job = {"id": str(uuid.uuid4()), "kind": kind, "output": output, "state": "waiting", "percent": 0, "label": "",
           "encoderName": None, "error": None, "cancel": threading.Event(), "tmp": Path(tempfile.mkdtemp(prefix="autosub-export-"))}
    with _jobs_lock:
        _jobs[job["id"]] = job
    return job


def _job(job_id: str) -> dict[str, Any]:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None:
        raise KeyError("내보내기 작업을 찾을 수 없습니다.")
    return job


def job_status(job_id: str) -> dict[str, Any]:
    job = _job(job_id)
    return {"state": job["state"], "percent": job["percent"], "label": job["label"], "encoderName": job["encoderName"],
            "error": job["error"], "outputPath": str(job["output"]) if job["state"] == "done" else None}


def cancel_job(job_id: str) -> None:
    try:
        _job(job_id)["cancel"].set()
    except KeyError:
        pass


def _finish(job: dict[str, Any], *, error: str | None = None) -> None:
    job["state"] = "error" if error else "done"
    job["error"] = error
    if not error:
        job["percent"] = 100
        job["label"] = "완료"
        _exported.add(os.path.normcase(str(job["output"])))
    shutil.rmtree(job["tmp"], ignore_errors=True)


def show_in_folder(path: str) -> bool:
    if os.path.normcase(path) not in _exported or not Path(path).is_file():
        return False
    subprocess.run(["explorer", "/select,", path], check=False, creationflags=_NO_WINDOW)
    return True


# -- audio -------------------------------------------------------------------------------
def start_audio(input_path: str, out_dir: str, fmt: str, cuts: list[dict[str, Any]]) -> dict[str, Any]:
    if fmt not in ("mp3", "wav"):
        raise ValueError(f"지원하지 않는 내보내기 형식: {fmt}")
    source = media.existing_media_file(input_path)
    job = _new_job(fmt, output_path(source, out_dir, f".{fmt}"))
    job["state"] = "running"

    def work() -> None:
        pending = job["output"].with_name(f"{job['output'].name}.{uuid.uuid4()}.partial.{fmt}")
        try:
            ff = paths.ffmpeg_paths()
            if not ff:
                raise RuntimeError("ffmpeg 준비가 필요합니다. 먼저 엔진 다운로드를 실행해 주세요.")
            job["label"] = "오디오 준비 중…"
            prepared = media.prepare_blocking(str(source))
            clips = clip_plan_from_cuts(prepared["duration"], cuts)
            expected = program_duration(clips)
            graph = build_audio_clip_graph(clips, prepared["duration"])
            proc = subprocess.Popen([ff[0], "-nostdin", "-v", "error", "-y", "-i", prepared["audioPath"], "-filter_complex", graph,
                                     "-map", "[aout]", "-vn",
                                     *(["-c:a", "libmp3lame", "-q:a", "2"] if fmt == "mp3" else ["-c:a", "pcm_s16le"]),
                                     "-progress", "pipe:2", "-nostats", str(pending)],
                                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                    creationflags=_NO_WINDOW)
            job["label"] = "오디오 인코딩 중…"
            _pump_progress(proc, job, expected, lambda p: p)
            out = media.probe_any(ff[1], pending)
            if not out["hasAudio"] or abs(out["duration"] - expected) > 0.1:
                raise RuntimeError("출력 오디오 길이 검증 실패")
            validate_media_decode(ff[0], pending, audio_only=True, cancel=job["cancel"])
            os.replace(pending, job["output"])
            _finish(job)
        except Exception as error:  # noqa: BLE001
            _finish(job, error=str(error))
        finally:
            pending.unlink(missing_ok=True)

    threading.Thread(target=work, name="autosub-export-audio", daemon=True).start()
    return {"jobId": job["id"], "outputPath": str(job["output"])}


def _pump_progress(proc: subprocess.Popen[bytes], job: dict[str, Any], expected: float, scale) -> None:
    """Read `-progress pipe:2` lines until exit; kill on cancel; raise with the stderr tail on failure."""
    assert proc.stderr
    tail = b""
    def kill_on_cancel() -> None:
        while proc.poll() is None:
            if job["cancel"].wait(0.25):
                proc.kill()
                return

    threading.Thread(target=kill_on_cancel, daemon=True).start()
    for raw in proc.stderr:
        tail = (tail + raw)[-6000:]
        pct = progress_percent(raw.decode("utf-8", "replace"), expected)
        if pct is not None:
            job["percent"] = max(job["percent"], scale(pct))
    code = proc.wait()
    if job["cancel"].is_set():
        raise RuntimeError("Export canceled")
    if code != 0:
        raise RuntimeError(f"ffmpeg 실패 (exit {code}): {tail.decode('utf-8', 'replace')}")


# -- video -------------------------------------------------------------------------------
def start_video(input_path: str, out_dir: str) -> dict[str, Any]:
    source = media.existing_media_file(input_path)
    ff = paths.ffmpeg_paths()
    if not ff:
        raise RuntimeError("ffmpeg 준비가 필요합니다. 먼저 엔진 다운로드를 실행해 주세요.")
    timing = media.probe_media_timing(ff[1], source)
    job = _new_job("video", output_path(source, out_dir, source.suffix or ".mp4"))
    rw, rh = render_dimensions(timing.width, timing.height)
    encoder = select_h264_encoder(ff[0])
    job.update(source=source, timing=timing, render=(rw, rh), encoder=encoder, encoderName=ENCODER_NAMES[encoder],
               states=0, label="자막 렌더 준비 중…", percent=4)
    return {"jobId": job["id"], "outputPath": str(job["output"]), "width": timing.width, "height": timing.height,
            "renderWidth": rw, "renderHeight": rh, "duration": timing.duration, "sourceOriginSec": timing.source_origin_sec,
            "hasAudio": timing.has_audio, "fps": EXPORT_FPS, "encoderName": ENCODER_NAMES[encoder]}


def _png_size(data: bytes) -> tuple[int, int]:
    if data[:8] != _PNG_SIGNATURE or data[12:16] != b"IHDR":
        raise ValueError("PNG 형식이 아닙니다.")
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def put_state(job_id: str, index: int, data: bytes) -> None:
    job = _job(job_id)
    if job["kind"] != "video" or job["state"] != "waiting":
        raise ValueError("자막 이미지를 받을 수 있는 상태가 아닙니다.")
    if index != job["states"]:
        raise ValueError(f"자막 이미지 순서가 맞지 않습니다 (기대 {job['states']}, 받음 {index}).")
    if _png_size(data) != job["render"]:
        raise ValueError(f"자막 이미지 크기가 {job['render'][0]}x{job['render'][1]} 이 아닙니다.")
    (job["tmp"] / f"state_{index:06d}.png").write_bytes(data)
    job["states"] += 1


def _overlay_frames(job: dict[str, Any], ffmpeg: str, schedule: list[tuple[int, int]], total_frames: int, sink) -> None:
    """Write one BGRA frame per output frame: each state's image over its frames, blank elsewhere."""
    rw, rh = job["render"]
    frame_bytes = rw * rh * 4
    blank = bytes(frame_bytes)
    decoder = None
    if schedule:
        decoder = subprocess.Popen([ffmpeg, "-v", "error", "-nostdin", "-f", "image2", "-framerate", "1", "-start_number", "0",
                                    "-i", str(job["tmp"] / "state_%06d.png"), "-f", "rawvideo", "-pix_fmt", "bgra", "-"],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   creationflags=_NO_WINDOW)
    try:
        frame = 0
        for start, end in schedule:
            assert decoder and decoder.stdout
            image = decoder.stdout.read(frame_bytes)
            if len(image) != frame_bytes:
                raise RuntimeError("자막 이미지를 해석하지 못했습니다.")
            while frame < min(start, total_frames):
                sink(blank)
                frame += 1
            while frame < min(end, total_frames):
                sink(image)
                frame += 1
            if job["cancel"].is_set():
                raise RuntimeError("Export canceled")
        while frame < total_frames:
            sink(blank)
            frame += 1
    finally:
        if decoder:
            decoder.kill()
            decoder.wait()


def start_encode(job_id: str, schedule: list[dict[str, Any]], clips: list[dict[str, Any]]) -> None:
    job = _job(job_id)
    if job["kind"] != "video" or job["state"] != "waiting":
        raise ValueError("인코딩을 시작할 수 있는 상태가 아닙니다.")
    timing = job["timing"]
    plan = validate_clip_plan(clips, timing.duration)
    frames: list[tuple[int, int]] = []
    cursor = 0
    for i, item in enumerate(schedule):
        start, end = int(item["startFrame"]), int(item["endFrame"])
        if start < cursor or end <= start:
            raise ValueError("자막 상태 구간이 올바르지 않습니다.")
        frames.append((start, end))
        cursor = end
    if len(frames) != job["states"]:
        raise ValueError(f"자막 이미지 {job['states']}장과 상태 {len(frames)}개가 맞지 않습니다.")
    job["state"] = "running"
    threading.Thread(target=_encode, args=(job, frames, plan), name="autosub-export-video", daemon=True).start()


def _encode(job: dict[str, Any], frames: list[tuple[int, int]], plan: list[dict[str, Any]]) -> None:
    timing = job["timing"]
    pending = job["output"].with_name(f"{job['output'].stem}.{uuid.uuid4()}.partial{job['output'].suffix}")
    try:
        ff = paths.ffmpeg_paths()
        if not ff:
            raise RuntimeError("ffmpeg 준비가 필요합니다.")
        overlay_dur = program_duration(plan)
        total_frames = max(1, math.ceil(overlay_dur * EXPORT_FPS - 1e-9))
        rw, rh = job["render"]
        w, h = max(1, round(timing.width)), max(1, round(timing.height))
        graph = (f"{build_clip_graph(plan, timing.duration, timing.source_origin_sec, timing.has_audio)};"
                 f"[vmain]scale={w}:{h}:flags=lanczos,setsar=1[display];"
                 f"[1:v]format=rgba,scale={w}:{h}:flags=bilinear,setsar=1[sub];"
                 f"[display][sub]overlay=0:0:eof_action=pass:repeatlast=0[vout]")

        def run(encoder: str) -> None:
            argv = [ff[0], "-y", "-hide_banner", "-copyts", "-dn", "-sn", "-i", str(job["source"]),
                    "-f", "rawvideo", "-pixel_format", "bgra", "-video_size", f"{rw}x{rh}", "-framerate", str(EXPORT_FPS),
                    "-i", "-", "-filter_complex", graph, "-map", "[vout]", *(["-map", "[amain]"] if timing.has_audio else []),
                    *h264_encode_args(encoder), "-pix_fmt", "yuv420p", "-r", str(EXPORT_FPS),
                    *(["-c:a", "aac", "-b:a", "192k"] if timing.has_audio else []),
                    "-movflags", "+faststart", "-t", str(overlay_dur), "-progress", "pipe:2", "-nostats", str(pending)]
            proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                    creationflags=_NO_WINDOW)
            feed_error: list[BaseException] = []

            def feed() -> None:
                assert proc.stdin
                try:
                    _overlay_frames(job, ff[0], frames, total_frames, proc.stdin.write)
                except BaseException as error:  # noqa: BLE001 - surfaced after ffmpeg exits
                    feed_error.append(error)
                    proc.kill()
                finally:
                    try:
                        proc.stdin.close()
                    except OSError:
                        pass

            feeder = threading.Thread(target=feed, daemon=True)
            feeder.start()
            try:
                _pump_progress(proc, job, overlay_dur, lambda p: min(99, 12 + round(p / 100 * 87)))
            finally:
                feeder.join()
            if feed_error and not isinstance(feed_error[0], (BrokenPipeError, OSError)):
                raise feed_error[0]

        job["label"] = "자막 렌더·합성·인코딩 중…"
        job["percent"] = 12
        try:
            run(job["encoder"])
        except Exception:
            if job["cancel"].is_set() or job["encoder"] == "libx264":
                raise
            job.update(label="CPU 인코더로 다시 시도 중…", encoderName=ENCODER_NAMES["libx264"], percent=12)
            run("libx264")
        out = media.probe_media_timing(ff[1], pending)
        if abs(out.duration - overlay_dur) > 0.1 or out.has_audio != timing.has_audio:
            raise RuntimeError("출력 영상의 길이 또는 오디오 검증에 실패했습니다.")
        job.update(percent=99, label="출력 영상 전체를 검증하는 중…")
        validate_media_decode(ff[0], pending, cancel=job["cancel"])
        os.replace(pending, job["output"])
        _finish(job)
    except Exception as error:  # noqa: BLE001
        _finish(job, error=str(error))
    finally:
        pending.unlink(missing_ok=True)
