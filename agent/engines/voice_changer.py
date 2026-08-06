"""Voice Changer (Seed-VC) — 작업 공간·준비·변환 잡 관리."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from common.bin_manager import ensure_ffmpeg, get_ffmpeg_executable, prepend_ffmpeg_bin_to_env
from common.subprocess_util import no_window_creationflags
from engines import seedvc_runtime
from runtime_paths import (
    agent_package_root,
    is_frozen,
    voice_changer_python_executable,
    voice_changer_runner_script,
)

PrepareProgressCallback = Callable[[float, str, str], None]

VOICE_CHANGER_ROOT = seedvc_runtime.voice_changer_root()
WORKSPACE_ROOT = seedvc_runtime.workspace_root()
MANIFEST_PATH = VOICE_CHANGER_ROOT / "prepare-manifest.json"

SUPPORTED_FORMATS = {"wav", "mp3", "flac"}
ALLOWED_AUDIO_SUFFIXES = {".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".wma", ".opus"}

_PROGRESS_RE = re.compile(r"^ITZ_PROGRESS\s+([0-9.]+)\s*(.*)$")
_RESULT_RE = re.compile(r"^ITZ_RESULT\s+(\{.*\})$")


@dataclass
class ConvertResult:
    source_path: Path
    reference_path: Path
    output_path: Path
    duration_sec: float | None = None


@dataclass
class ConvertJobStatus:
    phase: str
    progress: float
    message: str | None = None
    result: ConvertResult | None = None


_job_lock = threading.RLock()
_job = ConvertJobStatus(phase="idle", progress=0.0, message=None)
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
    VOICE_CHANGER_ROOT.mkdir(parents=True, exist_ok=True)
    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
    seedvc_runtime.hf_hub_cache_dir()
    seedvc_runtime.hf_home_dir()


def is_model_ready_fast() -> bool:
    return seedvc_runtime.is_model_ready_fast()


def is_model_ready() -> bool:
    try:
        if not seedvc_runtime.is_runtime_ready():
            return False
    except Exception:
        return False
    return seedvc_runtime.is_model_ready()


def has_nvidia_gpu() -> bool:
    return seedvc_runtime.has_nvidia_gpu()


def is_cuda_available() -> bool:
    return seedvc_runtime.is_cuda_available()


def installed_torch_version() -> str | None:
    return seedvc_runtime.installed_torch_version()


def select_torch_bundle() -> str:
    return seedvc_runtime.select_torch_bundle()


def is_allowed_media_path(path: Path) -> bool:
    resolved = path.resolve()
    if WORKSPACE_ROOT in resolved.parents or resolved == WORKSPACE_ROOT:
        return True
    if VOICE_CHANGER_ROOT in resolved.parents or resolved == VOICE_CHANGER_ROOT:
        return True
    return resolved.is_file() and resolved.suffix.lower() in ALLOWED_AUDIO_SUFFIXES


def is_allowed_input_path(path: Path) -> bool:
    resolved = path.resolve()
    if not resolved.is_file():
        return False
    if resolved.suffix.lower() not in ALLOWED_AUDIO_SUFFIXES:
        return False
    return True


def get_job_status() -> ConvertJobStatus:
    with _job_lock:
        return ConvertJobStatus(
            phase=_job.phase,
            progress=_job.progress,
            message=_job.message,
            result=_job.result,
        )


def _set_job(
    phase: str,
    progress: float,
    message: str | None = None,
    result: ConvertResult | None = None,
) -> None:
    with _job_lock:
        _job.phase = phase
        _job.progress = progress
        _job.message = message
        if result is not None or phase in {"idle", "failed"}:
            _job.result = result


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
                "errors": ["변환 작업이 진행 중입니다. 완료 후 정리할 수 있습니다."],
            }
        _job.phase = "idle"
        _job.progress = 0.0
        _job.message = "작업 공간이 정리되었습니다."
        _job.result = None

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
    seedvc_runtime.download_models(on_progress)


def install_dependencies(on_progress: PrepareProgressCallback | None = None) -> str:
    if is_frozen():
        raise RuntimeError("Frozen exe 환경에서는 Voice Changer 자동 설치를 지원하지 않습니다.")
    ensure_workspace()
    ensure_ffmpeg(download_timeout_sec=900.0)
    bundle = seedvc_runtime.install_runtime_dependencies(on_progress)
    _emit(on_progress, 54.0, "Voice Changer Python", str(seedvc_runtime.seedvc_python()))
    return bundle


def _resolve_device(device: str | None) -> str:
    if device is None:
        return "cuda" if is_cuda_available() else "cpu"
    normalized = str(device).lower()
    if normalized not in {"cpu", "cuda"}:
        raise ValueError("device must be 'cpu' or 'cuda'")
    if normalized == "cuda" and not is_cuda_available():
        raise RuntimeError(
            "CUDA를 사용할 수 없습니다. Voice Changer 준비를 다시 실행하거나 CPU를 선택하세요."
        )
    return normalized


def _export_audio(wav_path: Path, output_format: str, export_stem: str) -> Path:
    output_format = output_format.lower().strip()
    if output_format not in SUPPORTED_FORMATS:
        raise ValueError(f"지원하지 않는 포맷: {output_format}")
    if output_format == "wav":
        dest = WORKSPACE_ROOT / f"{export_stem}.wav"
        if wav_path.resolve() != dest.resolve():
            shutil.copy2(wav_path, dest)
        return dest

    ensure_ffmpeg()
    ffmpeg = get_ffmpeg_executable()
    dest = WORKSPACE_ROOT / f"{export_stem}.{output_format}"
    proc = subprocess.run(  # noqa: S603
        [str(ffmpeg), "-y", "-i", str(wav_path), str(dest)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=no_window_creationflags(),
        timeout=600,
    )
    if proc.returncode != 0 or not dest.is_file():
        raise RuntimeError(
            "ffmpeg 변환에 실패했습니다. "
            f"stdout={ (proc.stdout or '')[-400:] } stderr={ (proc.stderr or '')[-400:] }"
        )
    return dest


def _run_seedvc_subprocess(
    source_path: Path,
    reference_path: Path,
    output_wav: Path,
    *,
    device: str,
    diffusion_steps: int,
    f0_condition: bool,
    timeout_sec: float,
    on_progress: Callable[[float, str], None] | None = None,
) -> dict[str, object]:
    runner = voice_changer_runner_script()
    if not runner.is_file():
        raise RuntimeError(f"voice_changer_runner.py 없음: {runner}")

    python = voice_changer_python_executable()
    package_root = agent_package_root()
    seedvc_root = seedvc_runtime.resolve_seedvc_root(force_download=False)
    env = seedvc_runtime.runtime_env()
    prepend_ffmpeg_bin_to_env(env)
    env["ITMATZIP_AGENT_PACKAGE_ROOT"] = str(package_root)
    env["ITMATZIP_AGENT_DIR"] = str(package_root)
    env["ITMATZIP_SEEDVC_ROOT"] = str(seedvc_root)
    ckpt = seedvc_runtime.checkpoint_path()
    if ckpt.is_file():
        env["ITMATZIP_SEEDVC_CHECKPOINT"] = str(ckpt.resolve())
    cfg = seedvc_runtime.config_path()
    if cfg.is_file():
        env["ITMATZIP_SEEDVC_CONFIG"] = str(cfg.resolve())
    campplus = seedvc_runtime.campplus_path()
    if campplus.is_file():
        env["ITMATZIP_SEEDVC_CAMPPLUS"] = str(campplus.resolve())
    if device == "cpu":
        env["CUDA_VISIBLE_DEVICES"] = ""

    command = [
        str(python),
        "-P",
        "-u",
        str(runner),
        "--source",
        str(source_path.resolve()),
        "--reference",
        str(reference_path.resolve()),
        "--output",
        str(output_wav.resolve()),
        "--device",
        device,
        "--diffusion-steps",
        str(diffusion_steps),
        "--f0-condition",
        "True" if f0_condition else "False",
    ]

    proc = subprocess.Popen(  # noqa: S603
        command,
        cwd=str(seedvc_root),
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
                last_pct = max(12.0, min(92.0, 12.0 + raw_pct * 0.8))
                on_progress(last_pct, progress_match.group(2) or "변환 중…")
            elif on_progress and len(line) < 160:
                on_progress(last_pct, line)
        proc.wait(timeout=timeout_sec)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise RuntimeError(f"목소리 변환 시간 초과 ({int(timeout_sec)}초)") from None

    if proc.returncode != 0:
        detail = "\n".join(log_tail)[-2000:] if log_tail else ""
        message = f"Seed-VC 실행 실패 (exit {proc.returncode})"
        raise RuntimeError(f"{message}\n{detail}" if detail else message)
    if result_payload is None:
        if output_wav.is_file():
            return {"output_path": str(output_wav), "duration_sec": None}
        raise RuntimeError("Seed-VC 결과 정보를 받지 못했습니다.")
    return result_payload


def convert(
    source_path: Path,
    reference_path: Path,
    *,
    output_format: str = "wav",
    device: str | None = None,
    diffusion_steps: int = 25,
    f0_condition: bool = False,
    timeout_sec: float = 3600.0,
    on_progress: Callable[[float, str], None] | None = None,
) -> ConvertResult:
    def report(pct: float, message: str) -> None:
        if on_progress:
            on_progress(pct, message)

    if not is_model_ready():
        raise RuntimeError(
            "Voice Changer 환경이 준비되지 않았습니다. "
            "환경 준비(prepare)로 Seed-VC·모델을 설치한 뒤 다시 시도하세요."
        )
    if not is_allowed_input_path(source_path):
        raise ValueError(f"허용되지 않은 소스 경로입니다: {source_path}")
    if not is_allowed_input_path(reference_path):
        raise ValueError(f"허용되지 않은 레퍼런스 경로입니다: {reference_path}")

    fmt = output_format.lower().strip()
    if fmt not in SUPPORTED_FORMATS:
        raise ValueError(f"지원하지 않는 포맷: {fmt}")

    resolved_device = _resolve_device(device)
    ensure_workspace()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    job_dir = WORKSPACE_ROOT / f"job-{stamp}"
    job_dir.mkdir(parents=True, exist_ok=True)
    raw_wav = job_dir / "vc-output.wav"

    report(8.0, "Seed-VC 변환을 시작합니다…")
    payload = _run_seedvc_subprocess(
        source_path,
        reference_path,
        raw_wav,
        device=resolved_device,
        diffusion_steps=diffusion_steps,
        f0_condition=f0_condition,
        timeout_sec=timeout_sec,
        on_progress=report,
    )
    out_from_runner = Path(str(payload.get("output_path") or raw_wav))
    if not out_from_runner.is_file():
        raise RuntimeError("변환 결과 WAV 파일이 생성되지 않았습니다.")

    report(94.0, f"{fmt.upper()} 내보내기…")
    export_stem = f"{source_path.stem}-vc-{stamp}"
    final_path = _export_audio(out_from_runner, fmt, export_stem)
    duration = payload.get("duration_sec")
    duration_sec = float(duration) if duration is not None else None
    report(100.0, "변환 완료")
    return ConvertResult(
        source_path=source_path.resolve(),
        reference_path=reference_path.resolve(),
        output_path=final_path.resolve(),
        duration_sec=duration_sec,
    )


def start_convert_job(
    source_path: Path,
    reference_path: Path,
    *,
    output_format: str = "wav",
    device: str | None = None,
    diffusion_steps: int = 25,
    f0_condition: bool = False,
    timeout_sec: float = 3600.0,
) -> ConvertJobStatus:
    global _job_thread

    with _job_lock:
        if _job_thread is not None and _job_thread.is_alive():
            return get_job_status()
        _set_job("running", 2.0, "변환 작업을 시작합니다…")

        def _worker() -> None:
            try:
                def on_progress(pct: float, message: str) -> None:
                    _set_job("running", pct, message)

                result = convert(
                    source_path,
                    reference_path,
                    output_format=output_format,
                    device=device,
                    diffusion_steps=diffusion_steps,
                    f0_condition=f0_condition,
                    timeout_sec=timeout_sec,
                    on_progress=on_progress,
                )
                _set_job("ready", 100.0, "변환이 완료되었습니다.", result=result)
            except Exception as exc:
                _set_job("failed", 0.0, str(exc), result=None)

        _job_thread = threading.Thread(target=_worker, daemon=True)
        _job_thread.start()

    return get_job_status()
