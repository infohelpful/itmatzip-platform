"""Watermark Remover (ProPainter) — 작업 공간·모델 다운로드·추론 잡 관리."""

from __future__ import annotations

import base64
import binascii
import json
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from common.bin_manager import (
    ensure_ffmpeg,
    get_ffmpeg_executable,
    get_ffprobe_executable,
    prepend_ffmpeg_bin_to_env,
)
from common.subprocess_util import no_window_creationflags
from engines import propainter_runtime
from runtime_paths import (
    agent_package_root,
    is_frozen,
    propainter_runner_script,
    watermark_remover_python_executable,
)

PrepareProgressCallback = Callable[[float, str, str], None]

WATERMARK_REMOVER_ROOT = propainter_runtime.watermark_remover_root()
WORKSPACE_ROOT = propainter_runtime.workspace_root()
ALLOWED_VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
ALLOWED_MASK_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
BATCH_OUTPUT_DIR_NAME = "watermark-remover-out"

_MAX_MASK_BASE64_BYTES = 40 * 1024 * 1024
_PROGRESS_RE = re.compile(r"^ITZ_PROGRESS\s+([0-9.]+)\s*(.*)$")
_RESULT_RE = re.compile(r"^ITZ_RESULT\s+(\{.*\})$")


@dataclass
class EraseResult:
    original_path: Path
    mask_path: Path
    output_path: Path
    preview_path: Path
    original_preview_path: Path
    width: int
    height: int


@dataclass
class BatchEraseSummary:
    folder_path: Path
    output_dir: Path
    total: int
    done: int
    failed: int
    first_original_path: Path | None = None
    first_output_path: Path | None = None
    errors: list[str] | None = None


@dataclass
class EraseJobStatus:
    phase: str
    progress: float
    message: str | None = None
    result: EraseResult | None = None
    batch: bool = False
    batch_total: int = 0
    batch_done: int = 0
    batch_failed: int = 0
    batch_output_dir: Path | None = None
    batch_summary: BatchEraseSummary | None = None


_job_lock = threading.RLock()
_job = EraseJobStatus(phase="idle", progress=0.0, message=None)
_job_thread: threading.Thread | None = None


def _emit(
    on_progress: PrepareProgressCallback | None,
    pct: float,
    step: str,
    detail: str = "",
) -> None:
    if on_progress is not None:
        on_progress(pct, step, detail)


def ensure_workspace() -> None:
    propainter_runtime.models_dir()
    propainter_runtime.source_root()
    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)


def is_model_ready_fast() -> bool:
    return propainter_runtime.is_model_ready_fast()


def is_model_ready() -> bool:
    try:
        return propainter_runtime.is_model_ready()
    except Exception:
        return False


def has_nvidia_gpu() -> bool:
    return propainter_runtime.has_nvidia_gpu()


def is_cuda_available() -> bool:
    return propainter_runtime.is_cuda_available()


def installed_torch_version() -> str | None:
    return propainter_runtime.installed_torch_version()


def select_torch_bundle() -> str:
    return propainter_runtime.select_torch_bundle()


def python_version() -> str:
    try:
        python = propainter_runtime.propainter_python()
    except RuntimeError:
        return ""
    from common.subprocess_util import run_hidden

    proc = run_hidden([str(python), "--version"], capture_output=True, text=True, timeout=30)
    return (proc.stdout or proc.stderr or "").strip()


def is_allowed_media_path(path: Path) -> bool:
    resolved = path.resolve()
    if WORKSPACE_ROOT in resolved.parents or resolved == WORKSPACE_ROOT:
        return True
    if WATERMARK_REMOVER_ROOT in resolved.parents or resolved == WATERMARK_REMOVER_ROOT:
        return True
    suffix = resolved.suffix.lower()
    return resolved.is_file() and (
        suffix in ALLOWED_VIDEO_SUFFIXES or suffix in {".jpg", ".jpeg", ".png", ".webp"}
    )


def is_allowed_input_path(path: Path) -> bool:
    resolved = path.resolve()
    if not resolved.is_file():
        return False
    if resolved.suffix.lower() not in ALLOWED_VIDEO_SUFFIXES:
        return False
    return is_allowed_media_path(resolved)


def is_allowed_mask_path(path: Path) -> bool:
    resolved = path.resolve()
    if not resolved.is_file():
        return False
    if resolved.suffix.lower() not in ALLOWED_MASK_SUFFIXES:
        return False
    return is_allowed_media_path(resolved)


def get_job_status() -> EraseJobStatus:
    with _job_lock:
        return EraseJobStatus(
            phase=_job.phase,
            progress=_job.progress,
            message=_job.message,
            result=_job.result,
            batch=_job.batch,
            batch_total=_job.batch_total,
            batch_done=_job.batch_done,
            batch_failed=_job.batch_failed,
            batch_output_dir=_job.batch_output_dir,
            batch_summary=_job.batch_summary,
        )


def _set_job(
    phase: str,
    progress: float,
    message: str | None = None,
    result: EraseResult | None = None,
    *,
    batch: bool | None = None,
    batch_total: int | None = None,
    batch_done: int | None = None,
    batch_failed: int | None = None,
    batch_output_dir: Path | None = None,
    batch_summary: BatchEraseSummary | None = None,
    clear_batch: bool = False,
) -> None:
    with _job_lock:
        _job.phase = phase
        _job.progress = progress
        _job.message = message
        if result is not None or phase in {"idle", "failed"}:
            _job.result = result
        if clear_batch:
            _job.batch = False
            _job.batch_total = 0
            _job.batch_done = 0
            _job.batch_failed = 0
            _job.batch_output_dir = None
            _job.batch_summary = None
        if batch is not None:
            _job.batch = batch
        if batch_total is not None:
            _job.batch_total = batch_total
        if batch_done is not None:
            _job.batch_done = batch_done
        if batch_failed is not None:
            _job.batch_failed = batch_failed
        if batch_output_dir is not None:
            _job.batch_output_dir = batch_output_dir
        if batch_summary is not None:
            _job.batch_summary = batch_summary


def cleanup_workspace() -> dict[str, object]:
    ensure_workspace()
    errors: list[str] = []
    files_removed = 0
    dirs_removed = 0

    with _job_lock:
        if _job_thread is not None and _job_thread.is_alive():
            return {
                "ok": False,
                "files_removed": 0,
                "dirs_removed": 0,
                "errors": ["워터마크 제거 작업이 진행 중입니다. 완료 후 정리할 수 있습니다."],
            }
        _job.phase = "idle"
        _job.progress = 0.0
        _job.message = "작업 공간이 정리되었습니다."
        _job.result = None
        _job.batch = False
        _job.batch_total = 0
        _job.batch_done = 0
        _job.batch_failed = 0
        _job.batch_output_dir = None
        _job.batch_summary = None

    for entry in list(WORKSPACE_ROOT.iterdir()):
        try:
            if entry.is_dir():
                shutil.rmtree(entry)
                dirs_removed += 1
            elif entry.is_file():
                entry.unlink()
                files_removed += 1
        except OSError as exc:
            errors.append(f"{entry.name}: {exc}")

    return {
        "ok": len(errors) == 0,
        "files_removed": files_removed,
        "dirs_removed": dirs_removed,
        "errors": errors,
    }


def download_models(on_progress: PrepareProgressCallback | None = None) -> None:
    propainter_runtime.download_models(on_progress)


def install_dependencies(on_progress: PrepareProgressCallback | None = None) -> str:
    if is_frozen():
        raise RuntimeError("Frozen exe 환경에서는 Watermark Remover 자동 설치를 지원하지 않습니다.")
    ensure_workspace()
    bundle = propainter_runtime.install_runtime_dependencies(on_progress)
    _emit(
        on_progress,
        54.0,
        "Watermark Remover Python",
        str(propainter_runtime.propainter_python()),
    )
    return bundle


def _resolve_device(device: str | None) -> str:
    if device is None:
        return "cuda" if is_cuda_available() else "cpu"
    normalized = str(device).lower()
    if normalized not in {"cpu", "cuda"}:
        raise ValueError("device must be 'cpu' or 'cuda'")
    if normalized == "cuda" and not is_cuda_available():
        raise RuntimeError(
            "CUDA를 사용할 수 없습니다. Watermark Remover 준비를 다시 실행하거나 CPU를 선택하세요."
        )
    return normalized


def _decode_mask_base64(mask_base64: str, dest: Path) -> Path:
    from PIL import Image
    import io

    raw = mask_base64.strip()
    if raw.startswith("data:"):
        comma = raw.find(",")
        if comma != -1:
            raw = raw[comma + 1 :]
    try:
        decoded = base64.b64decode(raw, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"mask_base64 디코딩 실패: {exc}") from None
    if not decoded:
        raise ValueError("mask_base64 가 비어 있습니다.")
    if len(decoded) > _MAX_MASK_BASE64_BYTES:
        raise ValueError("mask_base64 크기가 너무 큽니다.")

    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        with Image.open(io.BytesIO(decoded)) as image:
            image.convert("L").save(dest, format="PNG")
    except Exception as exc:
        raise ValueError(f"mask_base64 이미지 디코딩 실패: {exc}") from None
    return dest


def extract_preview_frame(video_path: Path, dest: Path | None = None) -> Path:
    """영상 첫 프레임을 JPEG로 추출해 캔버스 미리보기에 쓴다."""
    if not is_allowed_input_path(video_path):
        raise ValueError(f"허용되지 않은 영상 경로입니다: {video_path}")
    ensure_ffmpeg()
    ffmpeg = get_ffmpeg_executable()
    if dest is None:
        ensure_workspace()
        dest = WORKSPACE_ROOT / "previews" / f"{video_path.stem}-frame.jpg"
    dest.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            str(ffmpeg),
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            "0",
            "-i",
            str(video_path.resolve()),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            str(dest),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
        creationflags=no_window_creationflags(),
    )
    if proc.returncode != 0 or not dest.is_file():
        detail = (proc.stderr or proc.stdout or "").strip()[-800:]
        raise RuntimeError(f"미리보기 프레임 추출 실패\n{detail}")
    return dest.resolve()


def show_path_in_folder(path: Path) -> None:
    import platform

    resolved = path.resolve()
    system = platform.system()
    if resolved.is_file():
        if system == "Windows":
            subprocess.run(["explorer", "/select,", str(resolved)], check=False)
            return
        if system == "Darwin":
            subprocess.run(["open", "-R", str(resolved)], check=False)
            return
        subprocess.run(["xdg-open", str(resolved.parent)], check=False)
        return
    if resolved.is_dir():
        if system == "Windows":
            subprocess.run(["explorer", str(resolved)], check=False)
            return
        if system == "Darwin":
            subprocess.run(["open", str(resolved)], check=False)
            return
        subprocess.run(["xdg-open", str(resolved)], check=False)
        return
    raise FileNotFoundError(f"경로를 찾을 수 없습니다: {resolved}")


def _run_propainter_subprocess(
    input_path: Path,
    mask_path: Path,
    output_path: Path,
    preview_path: Path,
    work_dir: Path,
    *,
    device: str,
    timeout_sec: float,
    on_progress: Callable[[float, str], None] | None = None,
) -> dict[str, object]:
    runner = propainter_runner_script()
    if not runner.is_file():
        raise RuntimeError(f"propainter_runner.py 없음: {runner}")
    script = propainter_runtime.find_inference_script()
    if not script.is_file():
        raise RuntimeError("ProPainter 소스가 없습니다. 환경 준비를 먼저 실행하세요.")

    python = watermark_remover_python_executable()
    package_root = agent_package_root()
    env = propainter_runtime.runtime_env()
    env["ITMATZIP_AGENT_PACKAGE_ROOT"] = str(package_root)
    env["ITMATZIP_AGENT_DIR"] = str(package_root)
    prepend_ffmpeg_bin_to_env(env)

    command = [
        str(python),
        "-P",
        "-u",
        str(runner),
        "--input",
        str(input_path.resolve()),
        "--mask",
        str(mask_path.resolve()),
        "--output",
        str(output_path.resolve()),
        "--preview",
        str(preview_path.resolve()),
        "--work-dir",
        str(work_dir.resolve()),
        "--device",
        device,
        "--ffmpeg",
        str(get_ffmpeg_executable()),
        "--ffprobe",
        str(get_ffprobe_executable()),
        "--python",
        str(python),
        "--script",
        str(script.resolve()),
        "--cwd",
        str(propainter_runtime.propainter_cwd().resolve()),
        "--timeout",
        str(timeout_sec),
    ]

    proc = subprocess.Popen(  # noqa: S603
        command,
        cwd=str(package_root),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=no_window_creationflags(),
    )

    result_payload: dict[str, object] | None = None
    log_tail: list[str] = []
    last_pct = 12.0
    try:
        assert proc.stdout is not None
        for raw_line in proc.stdout:
            line = raw_line.strip()
            if not line:
                continue
            log_tail.append(line)
            if len(log_tail) > 80:
                log_tail.pop(0)

            result_match = _RESULT_RE.match(line)
            if result_match:
                try:
                    parsed = json.loads(result_match.group(1))
                    if isinstance(parsed, dict):
                        result_payload = parsed
                except json.JSONDecodeError:
                    pass
                continue

            progress_match = _PROGRESS_RE.match(line)
            if progress_match and on_progress:
                raw_pct = float(progress_match.group(1))
                last_pct = max(12.0, min(96.0, raw_pct))
                on_progress(last_pct, progress_match.group(2) or "처리 중…")
            elif on_progress and len(line) < 160:
                on_progress(last_pct, line)
        proc.wait(timeout=timeout_sec + 30)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise RuntimeError(f"워터마크 제거 처리 시간 초과 ({int(timeout_sec)}초)") from None

    if proc.returncode != 0:
        detail = "\n".join(log_tail)[-2000:] if log_tail else ""
        message = f"ProPainter 실행 실패 (exit {proc.returncode})"
        raise RuntimeError(f"{message}\n{detail}" if detail else message)
    if result_payload is None:
        raise RuntimeError("ProPainter 결과 정보를 받지 못했습니다.")
    return result_payload


def erase(
    input_path: Path,
    *,
    mask_path: Path | None = None,
    mask_base64: str | None = None,
    device: str | None = None,
    timeout_sec: float = 7200.0,
    on_progress: Callable[[float, str], None] | None = None,
) -> EraseResult:
    def report(pct: float, message: str) -> None:
        if on_progress:
            on_progress(pct, message)

    if not is_model_ready():
        raise RuntimeError(
            "Watermark Remover 환경이 준비되지 않았습니다. "
            "환경 준비(prepare)로 PyTorch·ProPainter 모델을 설치한 뒤 다시 시도하세요."
        )
    if not is_allowed_input_path(input_path):
        raise ValueError(f"허용되지 않은 입력 경로입니다: {input_path}")
    if not mask_path and not mask_base64:
        raise ValueError("mask_path 또는 mask_base64 중 하나가 필요합니다.")
    if mask_path is not None and not is_allowed_mask_path(mask_path):
        raise ValueError(f"허용되지 않은 마스크 경로입니다: {mask_path}")

    ensure_ffmpeg()
    device_resolved = _resolve_device(device)
    report(4.0, f"작업 폴더 준비 중… ({device_resolved.upper()})")

    job_dir = WORKSPACE_ROOT / f"job-{int(time.time() * 1000)}"
    input_dir = job_dir / "input"
    output_dir = job_dir / "output"
    input_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    staged_input = input_path.resolve()

    staged_mask = input_dir / "mask.png"
    if mask_base64:
        _decode_mask_base64(mask_base64, staged_mask)
    else:
        assert mask_path is not None
        from PIL import Image

        with Image.open(mask_path) as raw_mask:
            raw_mask.convert("L").save(staged_mask, format="PNG")

    original_preview = extract_preview_frame(input_path, input_dir / "original-frame.jpg")
    output_path = output_dir / f"{input_path.stem}-clean.mp4"
    preview_path = output_dir / "result-frame.jpg"

    payload = _run_propainter_subprocess(
        staged_input,
        staged_mask,
        output_path,
        preview_path,
        job_dir / "work",
        device=device_resolved,
        timeout_sec=timeout_sec,
        on_progress=on_progress,
    )

    result_output = Path(str(payload.get("output_path") or output_path)).resolve()
    result_preview = Path(str(payload.get("preview_path") or preview_path)).resolve()
    if not result_output.is_file():
        raise RuntimeError("워터마크가 제거된 결과 영상을 찾을 수 없습니다.")

    report(100.0, "워터마크 제거가 완료되었습니다.")
    return EraseResult(
        original_path=input_path.resolve(),
        mask_path=staged_mask.resolve(),
        output_path=result_output,
        preview_path=result_preview if result_preview.is_file() else original_preview,
        original_preview_path=original_preview,
        width=int(payload.get("width") or 0),
        height=int(payload.get("height") or 0),
    )


def _run_job(
    input_path: Path,
    mask_path: Path | None,
    mask_base64: str | None,
    device: str | None,
    timeout_sec: float,
) -> None:
    try:

        def on_progress(pct: float, message: str) -> None:
            _set_job("running", pct, message)

        result = erase(
            input_path,
            mask_path=mask_path,
            mask_base64=mask_base64,
            device=device,
            timeout_sec=timeout_sec,
            on_progress=on_progress,
        )
        _set_job("ready", 100.0, "완료", result=result)
    except Exception as exc:
        _set_job("failed", 0.0, str(exc))


def start_erase_job(
    input_path: Path,
    *,
    mask_path: Path | None = None,
    mask_base64: str | None = None,
    device: str | None = None,
    timeout_sec: float = 7200.0,
) -> EraseJobStatus:
    global _job_thread

    with _job_lock:
        if _job_thread is not None and _job_thread.is_alive():
            return get_job_status()
        _set_job("running", 2.0, "워터마크 제거를 시작합니다…", clear_batch=True)
        _job_thread = threading.Thread(
            target=_run_job,
            args=(input_path, mask_path, mask_base64, device, timeout_sec),
            daemon=True,
        )
        _job_thread.start()
    return get_job_status()


def is_allowed_folder_path(path: Path) -> bool:
    resolved = path.resolve()
    return resolved.is_dir()


def list_folder_videos(folder: Path) -> list[Path]:
    """폴더 직속 영상만 반환 (watermark-remover-out 하위·숨김 파일 제외)."""
    resolved = folder.resolve()
    if not resolved.is_dir():
        raise ValueError(f"폴더를 찾을 수 없습니다: {resolved}")

    videos: list[Path] = []
    for entry in sorted(resolved.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_file():
            continue
        if entry.name.startswith("."):
            continue
        if entry.suffix.lower() not in ALLOWED_VIDEO_SUFFIXES:
            continue
        videos.append(entry.resolve())
    return videos


def batch_output_dir_for(folder: Path) -> Path:
    return folder.resolve() / BATCH_OUTPUT_DIR_NAME


def _copy_result_to_batch_output(result: EraseResult, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(result.output_path, dest)
    return dest.resolve()


def _run_batch_job(
    folder_path: Path,
    mask_base64: str,
    device: str | None,
    timeout_sec: float,
) -> None:
    errors: list[str] = []
    first_original: Path | None = None
    first_output: Path | None = None
    first_result: EraseResult | None = None
    done = 0
    failed = 0

    try:
        videos = list_folder_videos(folder_path)
        total = len(videos)
        if total == 0:
            raise ValueError("폴더에 지원하는 영상이 없습니다.")

        output_dir = batch_output_dir_for(folder_path)
        output_dir.mkdir(parents=True, exist_ok=True)

        shared_mask = WORKSPACE_ROOT / f"batch-mask-{int(time.time() * 1000)}.png"
        _decode_mask_base64(mask_base64, shared_mask)

        _set_job(
            "running",
            1.0,
            f"폴더 일괄 지우기 시작 ({total}개)…",
            batch=True,
            batch_total=total,
            batch_done=0,
            batch_failed=0,
            batch_output_dir=output_dir,
        )

        for index, video_path in enumerate(videos):
            base = (index / total) * 100.0
            span = 100.0 / total

            def on_progress(pct: float, message: str, *, _i=index, _base=base, _span=span) -> None:
                overall = min(99.0, _base + (max(0.0, min(100.0, pct)) / 100.0) * _span)
                _set_job(
                    "running",
                    overall,
                    f"[{_i + 1}/{total}] {video_path.name}: {message}",
                    batch=True,
                    batch_total=total,
                    batch_done=done,
                    batch_failed=failed,
                    batch_output_dir=output_dir,
                )

            try:
                on_progress(4.0, "시작")
                result = erase(
                    video_path,
                    mask_path=shared_mask,
                    device=device,
                    timeout_sec=timeout_sec,
                    on_progress=on_progress,
                )
                dest_name = video_path.name
                if video_path.suffix.lower() not in {".mp4", ".m4v"}:
                    dest_name = f"{video_path.stem}.mp4"
                dest = output_dir / dest_name
                copied = _copy_result_to_batch_output(result, dest)
                done += 1
                if first_original is None:
                    first_original = video_path.resolve()
                    first_output = copied
                    first_result = EraseResult(
                        original_path=first_original,
                        mask_path=result.mask_path,
                        output_path=copied,
                        preview_path=result.preview_path,
                        original_preview_path=result.original_preview_path,
                        width=result.width,
                        height=result.height,
                    )
            except Exception as exc:
                failed += 1
                errors.append(f"{video_path.name}: {exc}")
                _set_job(
                    "running",
                    min(99.0, ((index + 1) / total) * 100.0),
                    f"[{index + 1}/{total}] {video_path.name} 실패 — 다음 영상으로 계속",
                    batch=True,
                    batch_total=total,
                    batch_done=done,
                    batch_failed=failed,
                    batch_output_dir=output_dir,
                )

        summary = BatchEraseSummary(
            folder_path=folder_path.resolve(),
            output_dir=output_dir.resolve(),
            total=total,
            done=done,
            failed=failed,
            first_original_path=first_original,
            first_output_path=first_output,
            errors=errors or None,
        )

        if done == 0:
            detail = errors[0] if errors else "처리된 영상이 없습니다."
            _set_job(
                "failed",
                0.0,
                f"폴더 일괄 지우기 실패: {detail}",
                batch=True,
                batch_total=total,
                batch_done=done,
                batch_failed=failed,
                batch_output_dir=output_dir,
                batch_summary=summary,
            )
            return

        message = f"완료 — {done}/{total}개 저장"
        if failed:
            message += f" (실패 {failed}개)"
        _set_job(
            "ready",
            100.0,
            message,
            result=first_result,
            batch=True,
            batch_total=total,
            batch_done=done,
            batch_failed=failed,
            batch_output_dir=output_dir,
            batch_summary=summary,
        )
    except Exception as exc:
        _set_job(
            "failed",
            0.0,
            str(exc),
            batch=True,
            batch_summary=BatchEraseSummary(
                folder_path=folder_path.resolve(),
                output_dir=batch_output_dir_for(folder_path),
                total=0,
                done=done,
                failed=failed,
                first_original_path=first_original,
                first_output_path=first_output,
                errors=errors or [str(exc)],
            ),
        )


def start_batch_erase_job(
    folder_path: Path,
    *,
    mask_base64: str,
    device: str | None = None,
    timeout_sec: float = 7200.0,
) -> EraseJobStatus:
    global _job_thread

    if not mask_base64 or not str(mask_base64).strip():
        raise ValueError("mask_base64 가 필요합니다.")
    if not is_allowed_folder_path(folder_path):
        raise ValueError(f"폴더를 찾을 수 없습니다: {folder_path}")
    videos = list_folder_videos(folder_path)
    if not videos:
        raise ValueError("폴더에 지원하는 영상이 없습니다.")

    with _job_lock:
        if _job_thread is not None and _job_thread.is_alive():
            return get_job_status()
        output_dir = batch_output_dir_for(folder_path)
        _set_job(
            "running",
            1.0,
            f"폴더 일괄 지우기 준비 중… ({len(videos)}개)",
            clear_batch=True,
            batch=True,
            batch_total=len(videos),
            batch_done=0,
            batch_failed=0,
            batch_output_dir=output_dir,
        )
        _job_thread = threading.Thread(
            target=_run_batch_job,
            args=(folder_path, mask_base64, device, timeout_sec),
            daemon=True,
        )
        _job_thread.start()
    return get_job_status()
