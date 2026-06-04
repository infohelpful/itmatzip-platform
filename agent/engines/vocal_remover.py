from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

PrepareProgressCallback = Callable[[float, str, str], None]

def _wheel_basename(url: str) -> str:
    return url.rsplit("/", 1)[-1]


def _emit_prepare_progress(
    on_progress: PrepareProgressCallback | None,
    pct: float,
    step: str,
    detail: str = "",
) -> None:
    if on_progress is not None:
        on_progress(pct, step, detail)

from common.bin_manager import (
    ensure_ffmpeg,
    get_ffmpeg_executable,
    get_ffprobe_executable,
    prepend_ffmpeg_bin_to_env,
)
from common.runtime_site_packages import (
    engine_python_c_prefix,
    pip_install_cmd,
    prepend_runtime_pythonpath,
    purge_runtime_site_entries,
    use_runtime_site_packages,
    verify_importable,
)
from common.subprocess_util import no_window_creationflags, run_hidden
from runtime_paths import agent_package_root, demucs_runner_script, is_frozen

_DEMUCS_TQDM_RE = re.compile(
    r"(\d+)%\|.*?\|\s*(\d+(?:\.\d+)?)/(\d+(?:\.\d+)?)",
)

VOCAL_REMOVER_ROOT = Path(os.environ.get("APPDATA", Path.home() / ".itmatzip")) / "ItMatZip" / "vocal-remover"
MODEL_ROOT = VOCAL_REMOVER_ROOT / "models"
WORKSPACE_ROOT = VOCAL_REMOVER_ROOT / "workspace"
SUPPORTED_FORMATS = {"wav", "mp3", "flac"}
MODEL_NAME = "mdx_extra_q"
ALLOWED_AUDIO_SUFFIXES = {".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".wma", ".opus"}


@dataclass
class SeparationResult:
    instrumental_path: Path
    vocals_path: Path
    original_path: Path
    export_path: Path
    duration_sec: float


@dataclass
class SeparationJobStatus:
    phase: str
    progress: float
    message: str | None = None
    result: SeparationResult | None = None


_separate_lock = threading.RLock()
_separate_job = SeparationJobStatus(phase="idle", progress=0.0, message=None)
_separate_thread: threading.Thread | None = None


def get_separation_job_status() -> SeparationJobStatus:
    with _separate_lock:
        return SeparationJobStatus(
            phase=_separate_job.phase,
            progress=_separate_job.progress,
            message=_separate_job.message,
            result=_separate_job.result,
        )


def _set_separation_job(
    phase: str,
    progress: float,
    message: str | None = None,
    result: SeparationResult | None = None,
) -> None:
    with _separate_lock:
        _separate_job.phase = phase
        _separate_job.progress = progress
        _separate_job.message = message
        if result is not None or phase in {"idle", "failed"}:
            _separate_job.result = result


def _parse_demucs_tqdm_line(line: str) -> tuple[float, bool] | None:
    """tqdm 한 줄 → (막대 0~100%, 완료 여부). Demucs는 0%→100%만 찍는 경우가 많아 세부 진행도 함께 파싱."""
    match = _DEMUCS_TQDM_RE.search(line)
    if not match:
        return None
    try:
        label_pct = float(match.group(1))
        current = float(match.group(2))
        total = float(match.group(3))
    except ValueError:
        return None
    if total > 0:
        frac_pct = min(100.0, max(0.0, (current / total) * 100.0))
        bar_pct = frac_pct if current < total else max(label_pct, frac_pct)
    else:
        bar_pct = label_pct
    return bar_pct, bar_pct >= 99.5 or label_pct >= 100


def _estimate_demucs_seconds(duration_sec: float, device: str) -> float:
    """진행률 보간용 대략 소요 시간(CPU는 느림, GPU는 상대적으로 빠름)."""
    if duration_sec <= 0:
        return 120.0
    per_audio_sec = 8.0 if device == "cpu" else 1.5
    return max(45.0, min(3600.0, duration_sec * per_audio_sec))


def _demucs_jobs_count() -> int:
    raw = os.environ.get("ITMATZIP_DEMUCS_JOBS", "").strip()
    if raw.isdigit():
        return max(1, min(8, int(raw)))
    return max(1, min(4, os.cpu_count() or 2))


def _format_demucs_failure(
    returncode: int | None,
    stdout: str,
    stderr: str,
    command: list[str],
) -> str:
    rc = returncode if returncode is not None else -1
    parts = [
        f"exit_code={rc}",
        f"python={sys.executable}",
        f"cmd={' '.join(command)}",
    ]
    install = os.environ.get("ITMATZIP_AGENT_INSTALL_ROOT", "").strip()
    if install:
        parts.append(f"install_root={install}")
    combined = (stderr + "\n" + stdout).strip()
    if combined:
        tail = combined[-4000:] if len(combined) > 4000 else combined
        parts.append("output:\n" + tail)
    else:
        parts.append(
            "output=(empty — Demucs가 메시지 없이 종료됨. "
            "engine에 demucs/torch 설치·입력 파일 경로·GPU OOM 여부를 확인하세요.)"
        )
    return "\n".join(parts)


def _stream_pipe_text(pipe, sink: list[str], on_line: Callable[[str], None] | None) -> None:
    assert pipe is not None
    for line in pipe:
        sink.append(line)
        if on_line is not None:
            on_line(line)


def _run_demucs_with_progress(
    command: list[str],
    timeout_sec: float,
    on_progress: Callable[[float, str], None],
    *,
    duration_sec: float = 0.0,
    device_label: str = "cpu",
) -> tuple[int, str, str]:
    """Demucs stderr tqdm + 경과 시간으로 12~88% 구간 진행률을 부드럽게 갱신합니다."""
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    agent_root = agent_package_root()
    agent_root_str = str(agent_root)
    install = os.environ.get("ITMATZIP_AGENT_INSTALL_ROOT", "").strip()
    if install:
        env["ITMATZIP_AGENT_INSTALL_ROOT"] = install
    data = os.environ.get("ITMATZIP_AGENT_DATA", "").strip()
    if data:
        env["ITMATZIP_AGENT_DATA"] = data
    prepend_ffmpeg_bin_to_env(env)
    prepend_runtime_pythonpath(env)
    existing_py_path = env.get("PYTHONPATH", "").strip()
    if existing_py_path:
        if agent_root_str not in existing_py_path.split(os.pathsep):
            env["PYTHONPATH"] = agent_root_str + os.pathsep + existing_py_path
    else:
        env["PYTHONPATH"] = agent_root_str
    kwargs: dict = {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "bufsize": 1,
        "env": env,
        "cwd": agent_root_str,
    }
    if os.name == "nt":
        kwargs["creationflags"] = no_window_creationflags()

    proc = subprocess.Popen(command, **kwargs)  # noqa: S603
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []
    stages_done = 0
    stage_bar_pct = 0.0
    stage_estimate = 4
    last_mapped = 12.0
    estimated_sec = _estimate_demucs_seconds(duration_sec, device_label)
    stop_heartbeat = threading.Event()
    started = time.monotonic()

    def publish(mapped: float, message: str) -> None:
        nonlocal last_mapped
        mapped = max(last_mapped, min(88.0, mapped))
        last_mapped = mapped
        on_progress(mapped, message)

    def on_stderr_line(line: str) -> None:
        nonlocal stages_done, stage_bar_pct, stage_estimate
        parsed = _parse_demucs_tqdm_line(line)
        if parsed is None:
            return
        bar_pct, is_complete = parsed
        if is_complete:
            stages_done += 1
            stage_bar_pct = 0.0
            stage_estimate = max(stage_estimate, stages_done + 1)
        else:
            stage_bar_pct = bar_pct
        denom = max(stage_estimate, stages_done + 1)
        overall = min(0.99, (stages_done + stage_bar_pct / 100.0) / denom)
        mapped = 12.0 + overall * 76.0
        publish(mapped, f"Demucs AI 분리 중… ({int(overall * 100)}%, {device_label.upper()})")

    def consume_stdout() -> None:
        _stream_pipe_text(proc.stdout, stdout_lines, None)

    def consume_stderr() -> None:
        _stream_pipe_text(proc.stderr, stderr_lines, on_stderr_line)

    out_thread = threading.Thread(target=consume_stdout, daemon=True)
    err_thread = threading.Thread(target=consume_stderr, daemon=True)
    out_thread.start()
    err_thread.start()

    def heartbeat() -> None:
        while not stop_heartbeat.wait(2.0):
            elapsed = time.monotonic() - started
            time_ratio = min(0.92, elapsed / estimated_sec)
            mapped = 12.0 + time_ratio * 76.0
            publish(
                mapped,
                f"Demucs AI 분리 중… ({int(time_ratio * 100)}%, {device_label.upper()}, "
                f"{int(elapsed)}초 경과)",
            )

    hb = threading.Thread(target=heartbeat, daemon=True)
    hb.start()
    try:
        proc.wait(timeout=timeout_sec)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise
    finally:
        stop_heartbeat.set()
        out_thread.join(timeout=10.0)
        err_thread.join(timeout=10.0)
        hb.join(timeout=1.0)
    publish(88.0, "Demucs 분리 완료, 결과 파일을 정리합니다…")
    stdout_text = "".join(stdout_lines)
    stderr_text = "".join(stderr_lines)
    return proc.returncode, stdout_text, stderr_text


def is_allowed_media_path(path: Path) -> bool:
    """다운로드/스트리밍 허용: workspace 결과물 또는 로컬 오디오 파일."""
    resolved = path.resolve()
    if WORKSPACE_ROOT in resolved.parents or resolved == WORKSPACE_ROOT:
        return True
    return resolved.is_file() and resolved.suffix.lower() in ALLOWED_AUDIO_SUFFIXES


def _importable(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def ensure_workspace() -> None:
    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)


def cleanup_workspace() -> dict[str, object]:
    """workspace 내 MR/보컬 wav·변환본·demucs 출력 폴더를 삭제합니다."""
    ensure_workspace()
    errors: list[str] = []
    files_removed = 0
    dirs_removed = 0

    with _separate_lock:
        if _separate_thread is not None and _separate_thread.is_alive():
            return {
                "ok": False,
                "files_removed": 0,
                "dirs_removed": 0,
                "errors": ["분리 작업이 진행 중입니다. 완료 후 정리할 수 있습니다."],
            }
        _separate_job.phase = "idle"
        _separate_job.progress = 0.0
        _separate_job.message = "작업 공간이 정리되었습니다."
        _separate_job.result = None

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


WHEEL_RELEASE_BASE = os.environ.get(
    "ITMATZIP_WHEEL_RELEASE_BASE",
    "https://github.com/infohelpful/library-hub/releases/download/VocalRemover-Lib",
)
WHEEL_CPU_URL = os.environ.get(
    "ITMATZIP_WHEEL_CPU_URL",
    f"{WHEEL_RELEASE_BASE}/wheel.zip",
)
WHEEL_GPU_PART_URLS = (
    os.environ.get(
        "ITMATZIP_WHEEL_GPU_PART1_URL",
        f"{WHEEL_RELEASE_BASE}/wheels_gpu.zip.001",
    ),
    os.environ.get(
        "ITMATZIP_WHEEL_GPU_PART2_URL",
        f"{WHEEL_RELEASE_BASE}/wheels_gpu.zip.002",
    ),
)
# 하위 호환
WHEEL_ARCHIVE_URL = os.environ.get("ITMATZIP_WHEEL_ARCHIVE_URL", WHEEL_CPU_URL)


def _is_diffq_installed() -> bool:
    return _importable("diffq")


def is_demucs_installed() -> bool:
    return _importable("demucs") and _importable("torch")


def is_model_ready() -> bool:
    if not is_demucs_installed() or not _is_diffq_installed():
        return False
    if needs_cuda_torch_reinstall() or needs_cpu_torch_reinstall():
        return False
    return True


def _format_megabytes(num_bytes: int) -> str:
    return f"{num_bytes / (1024 * 1024):.1f} MB"


def _download_wheel_archive(
    url: str,
    dest: Path,
    timeout_sec: float = 3600.0,
    *,
    on_progress: PrepareProgressCallback | None = None,
    progress_pct_range: tuple[float, float] = (0.0, 100.0),
    label: str = "wheel 다운로드",
) -> None:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "ItMatZip-Agent-Wheel-Installer/1.0"},
    )
    with urllib.request.urlopen(request, timeout=timeout_sec) as response, dest.open("wb") as out:
        total = int(response.headers.get("Content-Length") or 0)
        downloaded = 0
        chunk_size = 1024 * 1024
        lo, hi = progress_pct_range
        while True:
            chunk = response.read(chunk_size)
            if not chunk:
                break
            out.write(chunk)
            downloaded += len(chunk)
            if on_progress is None:
                continue
            filename = _wheel_basename(url)
            if total > 0:
                frac = min(1.0, downloaded / total)
                pct = lo + (hi - lo) * frac
                size_detail = (
                    f"{filename} · {_format_megabytes(downloaded)} / {_format_megabytes(total)} "
                    f"({frac * 100:.0f}%)"
                )
            else:
                pct = lo + min(0.5, downloaded / (512 * 1024 * 1024)) * (hi - lo)
                size_detail = (
                    f"{filename} · {_format_megabytes(downloaded)} 수신 중 (전체 용량 확인 중)"
                )
            on_progress(pct, label, size_detail)
        if on_progress is not None:
            on_progress(
                hi,
                label,
                f"{_wheel_basename(url)} 다운로드 완료 ({_format_megabytes(downloaded)})",
            )


def has_nvidia_gpu() -> bool:
    """Demucs 설치 전 GPU 여부 판별(nvidia-smi)."""
    try:
        proc = run_hidden(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        return proc.returncode == 0 and bool((proc.stdout or "").strip())
    except Exception:
        return False


def select_wheel_bundle() -> str:
    """
    설치할 wheel 번들: 'cpu' | 'gpu'.
    ITMATZIP_WHEEL_VARIANT=cpu|gpu|auto (기본 auto → nvidia-smi).
    """
    variant = os.environ.get("ITMATZIP_WHEEL_VARIANT", "auto").strip().lower()
    if variant == "cpu":
        return "cpu"
    if variant == "gpu":
        return "gpu"
    return "gpu" if has_nvidia_gpu() else "cpu"


_torch_probe_cache: tuple[float, dict[str, object]] | None = None


def _invalidate_torch_import_cache() -> None:
    """pip로 torch를 바꾼 뒤, 에이전트 프로세스에 남은 import 캐시를 비웁니다."""
    global _torch_probe_cache
    _torch_probe_cache = None
    for name in list(sys.modules):
        if name == "torch" or name.startswith("torch."):
            del sys.modules[name]


def _probe_torch_subprocess(timeout: float = 90.0) -> dict[str, object]:
    """새 Python 프로세스에서 torch 빌드/CUDA를 확인 (에이전트가 CPU torch를 캐시한 경우 방지)."""
    script = (
        engine_python_c_prefix()
        + "import json\n"
        "d = {'version': '', 'variant': None, 'cuda_available': False, 'error': None}\n"
        "try:\n"
        "    import torch\n"
        "    d['version'] = str(torch.__version__)\n"
        "    vl = d['version'].lower()\n"
        "    d['variant'] = 'gpu' if '+cu' in vl else 'cpu'\n"
        "    d['cuda_available'] = bool(getattr(torch, 'cuda', None) and torch.cuda.is_available())\n"
        "except Exception as e:\n"
        "    d['error'] = str(e)\n"
        "print(json.dumps(d))\n"
    )
    proc = run_hidden(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        return {
            "error": (proc.stderr or proc.stdout or "torch probe failed").strip(),
        }
    line = (proc.stdout or "").strip().splitlines()[-1] if proc.stdout else ""
    try:
        data = json.loads(line)
        return data if isinstance(data, dict) else {"error": "invalid probe json"}
    except json.JSONDecodeError:
        return {"error": f"torch probe parse failed: {line[:200]}"}


def _get_torch_probe_cached(max_age_sec: float = 4.0) -> dict[str, object]:
    global _torch_probe_cache
    now = time.monotonic()
    if _torch_probe_cache is not None and now - _torch_probe_cache[0] < max_age_sec:
        return _torch_probe_cache[1]
    data = _probe_torch_subprocess()
    _torch_probe_cache = (now, data)
    return data


def installed_torch_wheel_variant() -> str | None:
    """설치된 torch가 CPU/CUDA wheel인지. 미설치 시 None."""
    if not _importable("torch"):
        return None
    probe = _get_torch_probe_cached()
    if probe.get("error"):
        return None
    variant = probe.get("variant")
    return variant if variant in {"gpu", "cpu"} else None


def installed_torch_version() -> str | None:
    if not _importable("torch"):
        return None
    probe = _get_torch_probe_cached()
    if probe.get("error"):
        return None
    version = probe.get("version")
    return str(version) if version else None


def is_cuda_available() -> bool:
    if not _importable("torch"):
        return False
    probe = _get_torch_probe_cached()
    if probe.get("error"):
        return False
    return bool(probe.get("cuda_available"))


def needs_cuda_torch_reinstall() -> bool:
    """NVIDIA GPU는 있는데 PyTorch가 CPU(+cpu) 빌드로 남아 있는 경우."""
    if not has_nvidia_gpu():
        return False
    variant = os.environ.get("ITMATZIP_WHEEL_VARIANT", "auto").strip().lower()
    if variant == "cpu":
        return False
    return installed_torch_wheel_variant() != "gpu"


def needs_cpu_torch_reinstall() -> bool:
    """NVIDIA GPU가 없는데 PyTorch가 CUDA(+cu) 빌드로 남아 있는 경우."""
    if has_nvidia_gpu():
        return False
    variant = os.environ.get("ITMATZIP_WHEEL_VARIANT", "auto").strip().lower()
    if variant == "gpu":
        return False
    if not _importable("torch"):
        return False
    return installed_torch_wheel_variant() == "gpu"


def _merge_split_zip_parts(parts: list[Path], dest: Path) -> None:
    """wheels_gpu.zip.001 + .002 등 분할 zip을 이어붙여 하나의 zip으로 만듭니다."""
    with dest.open("wb") as outfile:
        for part in parts:
            if not part.is_file():
                raise FileNotFoundError(f"분할 wheel 파일이 없습니다: {part}")
            with part.open("rb") as infile:
                shutil.copyfileobj(infile, outfile, length=16 * 1024 * 1024)


def _verify_zip_archive(path: Path) -> None:
    if not zipfile.is_zipfile(path):
        raise RuntimeError(f"유효한 zip 아카이브가 아닙니다: {path}")
    with zipfile.ZipFile(path, "r") as zf:
        if zf.testzip() is not None:
            raise RuntimeError(f"손상된 zip 아카이브입니다: {path}")


def _fetch_wheel_archive(
    tmpdir: Path,
    bundle: str,
    on_progress: PrepareProgressCallback | None = None,
) -> Path:
    if bundle == "gpu":
        part_paths = [tmpdir / f"wheels_gpu.zip.{i:03d}" for i in (1, 2)]
        urls = WHEEL_GPU_PART_URLS
        ranges = ((16.0, 28.0), (28.0, 40.0))
        for idx, (url, part_path, pct_range) in enumerate(
            zip(urls, part_paths, ranges, strict=True),
            start=1,
        ):
            _download_wheel_archive(
                url,
                part_path,
                on_progress=on_progress,
                progress_pct_range=pct_range,
                label=f"Wheel 다운로드 ({idx}/2)",
            )
        _emit_prepare_progress(
            on_progress,
            55.0,
            "파일 병합",
            "wheels_gpu.zip.001 + wheels_gpu.zip.002 → wheels_gpu.zip",
        )
        merged = tmpdir / "wheels_gpu.zip"
        _merge_split_zip_parts(part_paths, merged)
        _emit_prepare_progress(on_progress, 57.0, "ZIP 검증", "wheels_gpu.zip 무결성 확인")
        _verify_zip_archive(merged)
        return merged

    archive_path = tmpdir / "wheel.zip"
    _download_wheel_archive(
        WHEEL_CPU_URL,
        archive_path,
        on_progress=on_progress,
        progress_pct_range=(16.0, 40.0),
        label="Wheel 다운로드",
    )
    _emit_prepare_progress(on_progress, 41.0, "ZIP 검증", "wheel.zip 무결성 확인")
    _verify_zip_archive(archive_path)
    return archive_path


def _is_cuda_torch_wheel_filename(name: str) -> bool:
    lowered = name.lower()
    if not lowered.startswith("torch"):
        return False
    if "+cu" in lowered:
        return True
    return bool(re.search(r"-cu\d", lowered)) or "cuda" in lowered


def _is_cpu_torch_wheel_filename(name: str) -> bool:
    if not name.lower().startswith("torch"):
        return False
    return not _is_cuda_torch_wheel_filename(name)


def _extract_wheel_archive(archive: Path, dest: Path) -> None:
    """zip 내부 하위 폴더(wheels_gpu/ 등)에 있어도 pip이 찾도록 루트로 펼칩니다."""
    dest.mkdir(parents=True, exist_ok=True)
    staging = dest / "_extract_staging"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "r") as zf:
        zf.extractall(staging)
    for artifact in staging.rglob("*"):
        if not artifact.is_file():
            continue
        suffix = artifact.suffix.lower()
        if suffix == ".whl" or artifact.name.endswith(".tar.gz"):
            target = dest / artifact.name
            if target.exists():
                target.unlink()
            shutil.copy2(artifact, target)
    shutil.rmtree(staging, ignore_errors=True)


def _run_with_heartbeat(
    action: Callable[[], object],
    on_progress: PrepareProgressCallback | None,
    *,
    progress_pct: float,
    step: str,
    detail: str = "",
    interval_sec: float = 5.0,
) -> object:
    if on_progress is None:
        return action()

    stop = threading.Event()

    def heartbeat() -> None:
        started = time.monotonic()
        while not stop.wait(interval_sec):
            elapsed = int(time.monotonic() - started)
            on_progress(progress_pct, step, f"{detail} ({elapsed}초 경과)".strip())

    on_progress(progress_pct, step, detail)
    thread = threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    try:
        return action()
    finally:
        stop.set()
        thread.join(timeout=1.0)


def _runtime_abi_tag() -> str:
    """현재 에이전트 Python(예: 3.14 embeddable → cp314)."""
    return f"cp{sys.version_info.major}{sys.version_info.minor}"


def _wheel_filename_matches_runtime(filename: str) -> bool:
    """다른 Python용 wheel(cp314 등)을 pip에 넘기지 않도록 필터."""
    lowered = filename.lower()
    if sys.platform == "win32" and "win_amd64" not in lowered:
        return False
    abi = _runtime_abi_tag().lower()
    return abi in lowered


TORCH_STACK_PACKAGES = ("torch", "torchaudio", "torchcodec")
# 번들 zip에 없고 PyPI에서만 받는 torch 런타임 의존성 (--no-index 시 filelock 오류 방지)
TORCH_PIP_RUNTIME_DEPS = (
    "filelock",
    "typing-extensions",
    "setuptools",
    "sympy",
    "networkx",
    "jinja2",
    "fsspec",
)


def _list_torch_wheels(wheel_dir: Path) -> list[str]:
    names: list[str] = []
    for pkg in TORCH_STACK_PACKAGES:
        names.extend(p.name for p in _package_wheel_candidates(wheel_dir, pkg))
    if names:
        return sorted(dict.fromkeys(names))
    return sorted(p.name for p in wheel_dir.rglob("torch*.whl") if p.is_file())


def _package_wheel_candidates(wheel_dir: Path, pkg: str) -> list[Path]:
    """torch / torchaudio / torchcodec 각각 올바른 wheel만 선택 (torch*가 audio·codec까지 잡지 않게)."""
    if pkg == "torch":
        raw = [
            p
            for p in wheel_dir.glob("*.whl")
            if p.is_file() and p.name.lower().startswith("torch-")
        ]
    else:
        prefix = f"{pkg}-"
        raw = [
            p for p in wheel_dir.glob("*.whl") if p.is_file() and p.name.lower().startswith(prefix)
        ]
    return sorted(p for p in raw if _wheel_filename_matches_runtime(p.name))


def _wheel_dir_has_cuda_torch(wheel_dir: Path) -> bool:
    for path in _package_wheel_candidates(wheel_dir, "torch"):
        if _is_cuda_torch_wheel_filename(path.name):
            return True
    return False


def _wheel_dir_has_cpu_torch(wheel_dir: Path) -> bool:
    for path in _package_wheel_candidates(wheel_dir, "torch"):
        if _is_cpu_torch_wheel_filename(path.name):
            return True
    return False


def _prune_incompatible_wheels(wheel_dir: Path) -> list[str]:
    """pip이 다른 Python용 wheel을 고르지 않도록 비호환 파일을 제거하고 이름 목록을 반환."""
    removed: list[str] = []
    for whl in list(wheel_dir.glob("*.whl")):
        if not _wheel_filename_matches_runtime(whl.name):
            removed.append(whl.name)
            whl.unlink(missing_ok=True)  # type: ignore[arg-type]
    return removed


def _wheel_name_is_cuda_flavor(name: str) -> bool:
    lowered = name.lower()
    if "+cu" in lowered:
        return True
    return bool(re.search(r"-cu\d", lowered))


def _collect_torch_stack_wheel_paths(wheel_dir: Path, *, want_cuda: bool) -> list[Path]:
    paths: list[Path] = []
    missing: list[str] = []
    for pkg in TORCH_STACK_PACKAGES:
        candidates = _package_wheel_candidates(wheel_dir, pkg)
        matched: Path | None = None
        fallback: Path | None = None
        for candidate in candidates:
            if pkg == "torch":
                is_cuda = _is_cuda_torch_wheel_filename(candidate.name)
            else:
                is_cuda = _wheel_name_is_cuda_flavor(candidate.name)
            if fallback is None:
                fallback = candidate
            if want_cuda == is_cuda:
                matched = candidate
                break
        if matched is None and len(candidates) == 1:
            matched = candidates[0]
        elif matched is None and len(candidates) > 1:
            # 동일 플래버 중 첫 호환 wheel (이미 ABI 필터됨)
            matched = candidates[0]
        elif (
            matched is None
            and want_cuda
            and pkg in ("torchaudio", "torchcodec")
            and fallback is not None
        ):
            # torchaudio/torchcodec는 파일명에 +cu가 없는 빌드가 있어도 CUDA torch와 함께 배포됨
            matched = fallback
        if matched is None:
            missing.append(pkg)
        else:
            paths.append(matched)
    if missing:
        flavor = "CUDA" if want_cuda else "CPU"
        found = ", ".join(_list_torch_wheels(wheel_dir)[:8]) or "(없음)"
        raise RuntimeError(
            f"{flavor} torch 스택 wheel을 찾지 못했습니다 ({', '.join(missing)}). "
            f"wheel 폴더: {found}"
        )
    return paths


def _pip_uninstall_torch_stack() -> None:
    """CPU/CUDA torch 교체 전 기존 빌드 제거 (2.12.0 동일 버전이면 pip가 스킵하는 것 방지)."""
    run_hidden(
        [sys.executable, "-m", "pip", "uninstall", "-y", "torch", "torchaudio", "torchcodec"],
        capture_output=True,
        text=True,
        timeout=600,
    )
    if use_runtime_site_packages():
        purge_runtime_site_entries("torch", "torchaudio", "torchcodec", "functorch")
    _invalidate_torch_import_cache()


def _pip_install_torch_runtime_deps() -> subprocess.CompletedProcess:
    """torch wheel 의존성은 PyPI에서 설치 (torch 패키지 자체는 제외)."""
    cmd = pip_install_cmd()
    cmd.extend(TORCH_PIP_RUNTIME_DEPS)
    return run_hidden(cmd, capture_output=True, text=True, timeout=600)


def _pip_install_torch_stack_from_wheels(
    wheel_dir: Path,
    *,
    want_cuda: bool,
    force_reinstall: bool = False,
) -> subprocess.CompletedProcess:
    """로컬 .whl + uninstall + force-reinstall 로 CPU/CUDA 빌드를 확실히 교체."""
    wheel_paths = _collect_torch_stack_wheel_paths(wheel_dir, want_cuda=want_cuda)
    _pip_uninstall_torch_stack()
    deps_proc = _pip_install_torch_runtime_deps()
    if deps_proc.returncode != 0:
        return deps_proc
    cmd = pip_install_cmd(force_reinstall=True)
    cmd.extend(["--no-deps", *[str(path) for path in wheel_paths]])
    proc = run_hidden(cmd, capture_output=True, text=True, timeout=3600)
    _invalidate_torch_import_cache()
    return proc


def _verify_torch_stack_subprocess(
    *,
    want_cuda: bool,
    wheel_hint: str = "",
) -> tuple[str, bool]:
    """설치 직후 새 프로세스에서 torch 빌드 확인 (에이전트 메모리 캐시와 분리)."""
    _invalidate_torch_import_cache()
    probe = _probe_torch_subprocess()
    if probe.get("error"):
        raise RuntimeError(f"PyTorch 설치 확인 실패: {probe['error']}")
    ver = str(probe.get("version") or "unknown")
    variant = probe.get("variant")
    cuda_ok = bool(probe.get("cuda_available"))
    py = f"{sys.version_info.major}.{sys.version_info.minor}"
    hint_suffix = f" · 번들 torch: {wheel_hint}" if wheel_hint else ""
    if want_cuda:
        if "+cpu" in ver.lower() or variant != "gpu":
            raise RuntimeError(
                f"GPU(CUDA) wheel 설치 후에도 PyTorch가 CPU 빌드입니다 (torch {ver}). "
                "pip가 버전 2.12.0이 같다고 CUDA wheel 설치를 건너뛰었거나, "
                "실행 중인 에이전트가 예전 torch를 잡고 있을 수 있습니다. "
                f"uvicorn을 완전히 종료한 뒤 에이전트를 다시 켜고 준비를 실행하세요. "
                f"Python {py}{hint_suffix}"
            )
        if not cuda_ok:
            raise RuntimeError(
                f"CUDA PyTorch는 설치됐지만 GPU를 사용할 수 없습니다 (torch {ver}). "
                "NVIDIA 드라이버를 확인하고 PC를 재부팅한 뒤 다시 시도하세요."
            )
        return ver, cuda_ok
    if variant != "cpu" or "+cu" in ver.lower():
        raise RuntimeError(
            f"CPU wheel 설치 후에도 PyTorch가 CUDA 빌드입니다 (torch {ver}). "
            f"Python {py}{hint_suffix}"
        )
    return ver, cuda_ok


def _engine_vendor_wheel_dir() -> Path:
    return Path(sys.executable).resolve().parent / "vendor-wheels"


def _prefetched_diffq_wheel() -> Path | None:
    vendor = _engine_vendor_wheel_dir()
    if not vendor.is_dir():
        return None
    for wheel in sorted(vendor.glob("diffq-*.whl"), reverse=True):
        if wheel.is_file() and _wheel_filename_matches_runtime(wheel.name):
            return wheel
    return None


def _pip_find_links_args(wheel_dir: Path) -> list[str]:
    args: list[str] = []
    vendor = _engine_vendor_wheel_dir()
    if vendor.is_dir():
        args.extend(["--find-links", str(vendor)])
    args.extend(["--find-links", str(wheel_dir)])
    return args


def _bundle_sdist_artifacts(wheel_dir: Path) -> tuple[Path, Path]:
    """v1.0.4 wheel.zip / wheels_gpu 에 포함된 demucs·diffq tar.gz (PyPI 최신 sdist 대신)."""
    demucs = next((p for p in sorted(wheel_dir.glob("demucs-*.tar.gz")) if p.is_file()), None)
    diffq = next((p for p in sorted(wheel_dir.glob("diffq-*.tar.gz")) if p.is_file()), None)
    if demucs is None or diffq is None:
        found = ", ".join(p.name for p in wheel_dir.glob("*.tar.gz")) or "(tar.gz 없음)"
        raise RuntimeError(
            f"wheel 번들에 demucs/diffq tar.gz가 없습니다 (발견: {found}). "
            "GitHub v1.0.4 wheel.zip 또는 wheels_gpu를 다시 받아주세요."
        )
    return demucs, diffq


def _pip_install_demucs_diffq_build_prereqs(wheel_dir: Path) -> None:
    """GitHub wheel 번들의 demucs/diffq는 tar.gz(sdist) — Cython·numpy 선설치."""
    cmd = pip_install_cmd(upgrade=True)
    numpy_wheels = sorted(
        p
        for p in wheel_dir.glob("numpy-*.whl")
        if p.is_file() and _wheel_filename_matches_runtime(p.name)
    )
    if numpy_wheels:
        cmd.append(str(numpy_wheels[-1]))
    else:
        cmd.append("numpy")
    cmd.extend(["Cython>=3.0", "setuptools>=69", "wheel"])
    proc = run_hidden(cmd, capture_output=True, text=True, timeout=600)
    if proc.returncode != 0:
        raise RuntimeError(
            "demucs/diffq 빌드 준비(Cython·numpy) 실패: "
            + (proc.stderr or proc.stdout or "unknown")
        )
    verify_importable("Cython", "numpy")


def _pip_install_demucs_diffq_from_bundle(
    wheel_dir: Path,
    *,
    force_reinstall: bool = False,
) -> subprocess.CompletedProcess:
    """번들 tar.gz를 직접 설치 (패키지 이름만 지정하면 PyPI sdist로 새 빌드가 나가 Cython 오류 재발)."""
    _pip_install_demucs_diffq_build_prereqs(wheel_dir)
    demucs_tgz, diffq_tgz = _bundle_sdist_artifacts(wheel_dir)
    diffq_pkg = _prefetched_diffq_wheel()
    if diffq_pkg is None:
        diffq_pkg = diffq_tgz
    lameenc = sorted(
        p
        for p in wheel_dir.glob("lameenc-*.whl")
        if p.is_file() and _wheel_filename_matches_runtime(p.name)
    )
    cmd = pip_install_cmd(force_reinstall=force_reinstall, upgrade=True)
    cmd.extend([*_pip_find_links_args(wheel_dir), "--prefer-binary", "--no-build-isolation"])
    if lameenc:
        cmd.append(str(lameenc[-1]))
    cmd.extend([str(diffq_pkg), str(demucs_tgz)])
    return run_hidden(cmd, capture_output=True, text=True, timeout=3600)


def _pip_install_other_packages_from_wheel_dir(
    wheel_dir: Path,
    packages: list[str],
    *,
    force_reinstall: bool = False,
) -> subprocess.CompletedProcess:
    """demucs·diffq — 번들 tar.gz 직접 설치; 그 외 패키지는 find-links + PyPI."""
    if set(packages) <= {"demucs", "diffq"} and packages:
        return _pip_install_demucs_diffq_from_bundle(wheel_dir, force_reinstall=force_reinstall)
    cmd = pip_install_cmd(force_reinstall=force_reinstall, upgrade=True)
    cmd.extend([*_pip_find_links_args(wheel_dir), "--prefer-binary", *packages])
    return run_hidden(cmd, capture_output=True, text=True, timeout=3600)


def _pip_install_from_wheel_dir(
    wheel_dir: Path,
    packages: list[str],
    *,
    force_reinstall: bool = False,
    require_cuda_torch: bool = False,
    require_cpu_torch: bool = False,
) -> subprocess.CompletedProcess:
    if require_cuda_torch and require_cpu_torch:
        raise ValueError("require_cuda_torch와 require_cpu_torch는 동시에 지정할 수 없습니다.")
    py = f"{sys.version_info.major}.{sys.version_info.minor}"
    found = _list_torch_wheels(wheel_dir) or ["(torch wheel 없음)"]
    if require_cuda_torch and not _wheel_dir_has_cuda_torch(wheel_dir):
        nested = sorted(p.relative_to(wheel_dir).as_posix() for p in wheel_dir.rglob("torch*.whl"))[:5]
        hint = ", ".join(nested) if nested else ", ".join(found[:5])
        raise RuntimeError(
            f"GPU wheel 폴더에 Python {py}용 CUDA torch wheel이 없습니다. "
            f"발견된 torch 관련: {hint}"
        )
    if require_cpu_torch and not _wheel_dir_has_cpu_torch(wheel_dir):
        nested = sorted(p.relative_to(wheel_dir).as_posix() for p in wheel_dir.rglob("torch*.whl"))[:5]
        hint = ", ".join(nested) if nested else ", ".join(found[:5])
        raise RuntimeError(
            f"CPU wheel 폴더에 Python {py}용 CPU torch wheel이 없습니다. "
            f"발견된 torch 관련: {hint}"
        )

    torch_packages = [pkg for pkg in packages if pkg in TORCH_STACK_PACKAGES]
    other_packages = [pkg for pkg in packages if pkg not in TORCH_STACK_PACKAGES]
    last: subprocess.CompletedProcess | None = None

    if torch_packages:
        want_cuda = require_cuda_torch or (
            not require_cpu_torch and _wheel_dir_has_cuda_torch(wheel_dir)
        )
        if require_cpu_torch:
            want_cuda = False
        last = _pip_install_torch_stack_from_wheels(
            wheel_dir,
            want_cuda=want_cuda,
            force_reinstall=force_reinstall,
        )
        if last.returncode != 0:
            return last

    if other_packages:
        last = _pip_install_other_packages_from_wheel_dir(
            wheel_dir,
            other_packages,
            force_reinstall=force_reinstall,
        )
    if last is None:
        raise RuntimeError("설치할 패키지가 지정되지 않았습니다.")
    return last


def _install_from_wheel_dir(wheel_dir: Path, bundle: str = "cpu") -> subprocess.CompletedProcess:
    packages = ["demucs", "diffq"]
    if bundle == "gpu":
        packages = ["torch", "torchaudio", "torchcodec", "demucs", "diffq"]
    return _pip_install_from_wheel_dir(wheel_dir, packages)


def _install_wheels_bundle(
    bundle: str,
    on_progress: PrepareProgressCallback | None = None,
) -> None:
    bundle_label = "GPU(CUDA)" if bundle == "gpu" else "CPU"
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir_path = Path(tmpdir)
        wheel_dir = tmpdir_path / "wheel"
        wheel_dir.mkdir(parents=True, exist_ok=True)

        _emit_prepare_progress(
            on_progress,
            12.0,
            "다운로드 준비",
            f"{bundle_label} · "
            + ("wheels_gpu.zip.001·002 (2분할)" if bundle == "gpu" else "wheel.zip"),
        )
        archive_path = _fetch_wheel_archive(tmpdir_path, bundle, on_progress=on_progress)
        _emit_prepare_progress(on_progress, 58.0, "압축 해제", "wheel 폴더에 파일을 풉니다")
        _extract_wheel_archive(archive_path, wheel_dir)
        pruned = _prune_incompatible_wheels(wheel_dir)
        if pruned:
            _emit_prepare_progress(
                on_progress,
                59.0,
                "wheel 정리",
                f"Python {_runtime_abi_tag()} 미호환 wheel 제외: {', '.join(pruned[:3])}",
            )
        if bundle == "gpu" and not _wheel_dir_has_cuda_torch(wheel_dir):
            found = ", ".join(_list_torch_wheels(wheel_dir)[:6]) or "(없음)"
            raise RuntimeError(
                f"GPU wheel 번들에 Python {_runtime_abi_tag()}용 CUDA torch가 없습니다. "
                f"남은 torch wheel: {found}"
            )

        pip_detail = (
            "torch, torchaudio, torchcodec, demucs, diffq"
            if bundle == "gpu"
            else "demucs, diffq"
        )
        _emit_prepare_progress(
            on_progress,
            60.0,
            "pip 설치",
            f"{bundle_label} · {pip_detail} (수 분 소요될 수 있음)",
        )

        def pip_install() -> subprocess.CompletedProcess:
            return _pip_install_from_wheel_dir(
                wheel_dir,
                ["torch", "torchaudio", "torchcodec", "demucs", "diffq"]
                if bundle == "gpu"
                else ["demucs", "diffq"],
                force_reinstall=False,
                require_cuda_torch=bundle == "gpu",
            )

        proc = _run_with_heartbeat(
            pip_install,
            on_progress,
            progress_pct=62.0,
            step="pip 설치",
            detail=f"{bundle_label} 패키지 설치 중",
            interval_sec=4.0,
        )
        if not isinstance(proc, subprocess.CompletedProcess):
            raise RuntimeError("pip wheel 설치가 비정상 종료되었습니다.")
        if proc.returncode != 0:
            detail = proc.stderr or proc.stdout or "unknown"
            if "WinError 5" in detail or "액세스가 거부" in detail:
                detail += (
                    " (Program Files engine 에 쓸 수 없습니다. "
                    "에이전트 agent/ 소스를 최신으로 반영한 뒤 트레이를 재시작하세요.)"
                )
            raise RuntimeError(
                "번들 wheel 설치에 실패했습니다. pip 출력: " + detail
            )
        from common.runtime_site_packages import activate_runtime_site_packages, verify_importable

        activate_runtime_site_packages()
        verify_importable("demucs", "diffq", "torch")


def reinstall_cuda_torch_wheels(on_progress: PrepareProgressCallback | None = None) -> None:
    """Demucs는 유지하고 PyTorch만 GPU(CUDA) wheel로 교체합니다."""
    if is_frozen():
        raise RuntimeError("Frozen exe 환경에서는 CUDA wheel 재설치를 지원하지 않습니다.")
    _emit_prepare_progress(
        on_progress,
        8.0,
        "CUDA wheel 교체",
        "PyTorch CPU(+cpu) → GPU wheel (torch·torchaudio·torchcodec)",
    )
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir_path = Path(tmpdir)
        wheel_dir = tmpdir_path / "wheel"
        wheel_dir.mkdir(parents=True, exist_ok=True)
        archive_path = _fetch_wheel_archive(tmpdir_path, "gpu", on_progress=on_progress)
        _emit_prepare_progress(on_progress, 58.0, "압축 해제", "GPU wheel zip을 풉니다")
        _extract_wheel_archive(archive_path, wheel_dir)
        _emit_prepare_progress(
            on_progress,
            60.0,
            "pip 설치",
            "torch, torchaudio, torchcodec (--force-reinstall, 대용량·수 분)",
        )

        def pip_install() -> subprocess.CompletedProcess:
            return _pip_install_from_wheel_dir(
                wheel_dir,
                ["torch", "torchaudio", "torchcodec"],
                force_reinstall=True,
                require_cuda_torch=True,
            )

        proc = _run_with_heartbeat(
            pip_install,
            on_progress,
            progress_pct=62.0,
            step="pip 설치",
            detail="PyTorch CUDA wheel 설치 중",
            interval_sec=4.0,
        )
        if not isinstance(proc, subprocess.CompletedProcess):
            raise RuntimeError("PyTorch CUDA pip 설치가 비정상 종료되었습니다.")
        if proc.returncode != 0:
            raise RuntimeError(
                "CUDA PyTorch 재설치에 실패했습니다. pip 출력: "
                + (proc.stderr or proc.stdout or "unknown")
            )
        bundled_torch = ", ".join(_list_torch_wheels(wheel_dir)[:3]) or "없음"
    ver, cuda_ok = _verify_torch_stack_subprocess(want_cuda=True, wheel_hint=bundled_torch)
    _emit_prepare_progress(
        on_progress,
        78.0,
        "CUDA 확인",
        f"torch {ver} · {'CUDA 사용 가능' if cuda_ok else 'CUDA 미사용'}",
    )


def reinstall_cpu_torch_wheels(on_progress: PrepareProgressCallback | None = None) -> None:
    """Demucs는 유지하고 PyTorch만 CPU wheel로 교체합니다 (GPU 미감지 시)."""
    if is_frozen():
        raise RuntimeError("Frozen exe 환경에서는 CPU wheel 재설치를 지원하지 않습니다.")
    _emit_prepare_progress(
        on_progress,
        8.0,
        "CPU wheel 교체",
        "PyTorch CUDA(+cu) → CPU wheel (torch·torchaudio·torchcodec)",
    )
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir_path = Path(tmpdir)
        wheel_dir = tmpdir_path / "wheel"
        wheel_dir.mkdir(parents=True, exist_ok=True)
        archive_path = _fetch_wheel_archive(tmpdir_path, "cpu", on_progress=on_progress)
        _emit_prepare_progress(on_progress, 58.0, "압축 해제", "CPU wheel zip을 풉니다")
        _extract_wheel_archive(archive_path, wheel_dir)
        _emit_prepare_progress(
            on_progress,
            60.0,
            "pip 설치",
            "torch, torchaudio, torchcodec (--force-reinstall, CPU wheel로 교체)",
        )

        def pip_install() -> subprocess.CompletedProcess:
            return _pip_install_from_wheel_dir(
                wheel_dir,
                ["torch", "torchaudio", "torchcodec"],
                force_reinstall=True,
                require_cpu_torch=True,
            )

        proc = _run_with_heartbeat(
            pip_install,
            on_progress,
            progress_pct=62.0,
            step="pip 설치",
            detail="PyTorch CPU wheel 설치 중",
            interval_sec=4.0,
        )
        if not isinstance(proc, subprocess.CompletedProcess):
            raise RuntimeError("PyTorch CPU pip 설치가 비정상 종료되었습니다.")
        if proc.returncode != 0:
            raise RuntimeError(
                "CPU PyTorch 재설치에 실패했습니다. pip 출력: "
                + (proc.stderr or proc.stdout or "unknown")
            )
        bundled_torch = ", ".join(_list_torch_wheels(wheel_dir)[:3]) or "없음"
    ver, _ = _verify_torch_stack_subprocess(want_cuda=False, wheel_hint=bundled_torch)
    _emit_prepare_progress(
        on_progress,
        78.0,
        "CPU 확인",
        f"torch {ver} · CPU wheel",
    )


def install_dependencies(on_progress: PrepareProgressCallback | None = None) -> str:
    """
    Demucs·diffq 의존성 설치. 반환: 사용한 번들('cpu' | 'gpu').
    """
    if is_frozen():
        raise RuntimeError("Frozen exe 환경에서는 Demucs 자동 설치를 지원하지 않습니다.")

    bundle = select_wheel_bundle()
    if (
        is_demucs_installed()
        and _is_diffq_installed()
        and not needs_cuda_torch_reinstall()
        and not needs_cpu_torch_reinstall()
    ):
        return installed_torch_wheel_variant() or bundle

    if is_demucs_installed() and _is_diffq_installed() and needs_cpu_torch_reinstall():
        reinstall_cpu_torch_wheels(on_progress=on_progress)
        return "cpu"

    if is_demucs_installed() and _is_diffq_installed() and needs_cuda_torch_reinstall():
        reinstall_cuda_torch_wheels(on_progress=on_progress)
        return "gpu"

    bundle_label = "GPU(CUDA)" if bundle == "gpu" else "CPU"
    try:
        _install_wheels_bundle(bundle, on_progress=on_progress)
    except Exception as exc:
        err_text = str(exc)
        label = "wheels_gpu(분할)" if bundle == "gpu" else "wheel.zip"
        raise RuntimeError(
            f"Demucs 또는 diffq 설치에 실패했습니다. ({label} · GitHub v1.0.4 wheel 다운로드/설치: {exc})"
        ) from exc

    if not is_demucs_installed():
        raise RuntimeError("Demucs 설치 후 import에 실패했습니다.")
    if not _is_diffq_installed():
        raise RuntimeError("diffq 설치 후 import에 실패했습니다.")
    if bundle == "gpu":
        _verify_torch_stack_subprocess(want_cuda=True)

    return bundle


def download_models(on_progress: PrepareProgressCallback | None = None) -> None:
    if not is_demucs_installed():
        raise RuntimeError("Demucs가 먼저 설치되어야 모델을 다운로드할 수 있습니다.")

    try:
        from demucs.pretrained import get_model

        def load_model() -> object:
            return get_model(MODEL_NAME)

        _run_with_heartbeat(
            load_model,
            on_progress,
            progress_pct=86.0,
            step="AI 모델 다운로드",
            detail=f"Demucs pretrained · {MODEL_NAME}",
            interval_sec=4.0,
        )
    except ImportError as exc:
        raise RuntimeError("Demucs 모델 다운로드를 위한 모듈을 불러올 수 없습니다.") from exc
    except Exception as exc:
        raise RuntimeError(f"Demucs 모델 다운로드 중 오류가 발생했습니다: {exc}") from exc


def _demucs_output_matches_stem(path: Path, selected_stem: str) -> bool:
    """Demucs wav 파일명이 요청 스템과 일치하는지 (`vocals`가 `no_vocals`에 걸리지 않게)."""
    stem = path.stem.lower()
    key = selected_stem.lower()
    if key == "vocals":
        if "no_vocals" in stem or "no-vocals" in stem:
            return False
        return stem == "vocals" or stem.endswith(".vocals") or stem.endswith("_vocals")
    if key == "no_vocals":
        return "no_vocals" in stem or "no-vocals" in stem
    return key in stem


def _find_demucs_output(output_dir: Path, input_stem: str, selected_stem: str) -> Path | None:
    all_wavs = list(output_dir.rglob("*.wav"))
    candidates = [
        p
        for p in all_wavs
        if input_stem in p.stem and _demucs_output_matches_stem(p, selected_stem)
    ]
    if not candidates:
        candidates = [p for p in all_wavs if _demucs_output_matches_stem(p, selected_stem)]
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def _get_duration_seconds(path: Path) -> float | None:
    try:
        ffprobe = get_ffprobe_executable()
    except FileNotFoundError:
        return None
    cmd = [
        str(ffprobe),
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    try:
        proc = run_hidden(cmd, capture_output=True, text=True, timeout=10)
        if proc.returncode != 0:
            return None
        out = (proc.stdout or "").strip()
        return float(out) if out else None
    except Exception:
        return None


def _ensure_min_duration(input_path: Path, min_seconds: float = 6.0) -> Path:
    """If input audio is shorter than min_seconds, create a padded temporary copy by looping it.
    Returns path to a file that is at least min_seconds long (may be same as input_path)."""
    dur = _get_duration_seconds(input_path)
    if dur is None or dur >= min_seconds:
        return input_path

    try:
        ffmpeg = get_ffmpeg_executable()
    except FileNotFoundError:
        return input_path

    loops = max(1, int((min_seconds // dur) + 1))
    out_path = WORKSPACE_ROOT / f"padded-{int(time.time() * 1000)}-{input_path.name}"
    cmd = [
        str(ffmpeg),
        "-y",
        "-stream_loop",
        str(loops),
        "-i",
        str(input_path),
        "-t",
        str(min_seconds),
        str(out_path),
    ]
    proc = run_hidden(cmd, capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        return input_path
    return out_path


def _resolve_device(device: str | None) -> str:
    if device is None:
        try:
            import importlib

            if importlib.util.find_spec("torch"):
                import torch as _torch

                if getattr(_torch, "cuda", None) and _torch.cuda.is_available():
                    return "cuda"
        except Exception:
            pass
        return "cpu"
    normalized = str(device).lower()
    if normalized not in {"cpu", "cuda"}:
        raise ValueError("device must be 'cpu' or 'cuda'")
    if normalized == "cuda" and not is_cuda_available():
        ver = installed_torch_version() or "unknown"
        raise RuntimeError(
            f"CUDA를 사용할 수 없습니다 (설치된 torch: {ver}). "
            "PyTorch CPU 빌드(+cpu)가 남아 있을 수 있습니다. "
            "Vocal Remover에서 '준비'를 다시 실행해 GPU wheel을 설치하세요."
        )
    return normalized


def _export_stem_wav(stem_wav: Path, output_format: str, export_name: str) -> Path:
    output_path = WORKSPACE_ROOT / f"{export_name}.{output_format}"
    output_path.unlink(missing_ok=True)
    if output_format == "wav":
        shutil.copy2(stem_wav, output_path)
        return output_path
    ffmpeg = get_ffmpeg_executable()
    proc = run_hidden(
        [str(ffmpeg), "-y", "-i", str(stem_wav), str(output_path)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "ffmpeg 변환에 실패했습니다. stdout="
            + (proc.stdout or "")
            + " stderr="
            + (proc.stderr or "")
        )
    return output_path


def _grpc_agent_origin() -> str:
    return os.environ.get("ITMATZIP_AGENT_HTTP", "http://127.0.0.1:19876").strip().rstrip("/")


def _separate_stems_via_grpc(
    input_path: Path,
    output_format: str,
    timeout_sec: float = 3600.0,
    device: str | None = None,
    on_progress: Callable[[float, str], None] | None = None,
) -> SeparationResult:
    def report(pct: float, msg: str) -> None:
        if on_progress:
            on_progress(pct, msg)

    report(5.0, "Go gRPC inference 경로로 분리를 요청합니다…")
    payload = json.dumps(
        {
            "audio_path": str(input_path.resolve()),
            "output_format": output_format,
            "device": device,
            "timeout_sec": timeout_sec,
        },
        ensure_ascii=False,
    )
    body = json.dumps({"model_id": MODEL_NAME, "input": payload}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{_grpc_agent_origin()}/inference",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec + 30.0) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"gRPC inference HTTP {exc.code}: {detail}") from exc

    if raw.get("status") != "ok":
        raise RuntimeError(f"gRPC inference failed: {raw}")
    result = raw.get("result") or {}
    if result.get("status") != "ok":
        raise RuntimeError(f"gRPC demucs failed: {result}")

    report(100.0, "MR·보컬 분리가 완료되었습니다.")
    return SeparationResult(
        instrumental_path=Path(result["instrumental_path"]),
        vocals_path=Path(result["vocals_path"]),
        original_path=Path(result.get("original_path", str(input_path.resolve()))),
        export_path=Path(result["export_path"]),
        duration_sec=float(result.get("duration_sec", 0.0)),
    )


def separate_stems(
    input_path: Path,
    output_format: str,
    timeout_sec: float = 3600.0,
    device: str | None = None,
    on_progress: Callable[[float, str], None] | None = None,
) -> SeparationResult:
    """MR(no_vocals)와 보컬 스템을 항상 함께 추출합니다."""

    if os.environ.get("ITMATZIP_USE_GRPC_INFERENCE", "").strip().lower() in {"1", "true", "yes"}:
        return _separate_stems_via_grpc(
            input_path,
            output_format,
            timeout_sec=timeout_sec,
            device=device,
            on_progress=on_progress,
        )

    def report(pct: float, msg: str) -> None:
        if on_progress:
            on_progress(pct, msg)

    ensure_ffmpeg()
    ensure_workspace()

    if output_format not in SUPPORTED_FORMATS:
        raise ValueError(f"지원되지 않는 출력 포맷입니다: {output_format}")
    if not input_path.is_file():
        raise FileNotFoundError(f"입력 파일을 찾을 수 없습니다: {input_path}")
    if not is_demucs_installed():
        raise RuntimeError("Demucs가 설치되지 않았습니다. 먼저 /prepare를 호출하세요.")

    report(5.0, "분리 작업을 준비합니다…")
    output_dir = WORKSPACE_ROOT / f"demucs-output-{int(time.time() * 1000)}"
    output_dir.mkdir(parents=True, exist_ok=True)
    used_input = _ensure_min_duration(input_path, min_seconds=6.0)
    device_resolved = _resolve_device(device)

    audio_duration = _get_duration_seconds(used_input) or _get_duration_seconds(input_path) or 0.0
    torch_ver = installed_torch_version() or "?"
    if device_resolved == "cuda":
        speed_hint = f"GPU(CUDA) · torch {torch_ver}"
    elif needs_cuda_torch_reinstall():
        speed_hint = (
            f"CPU로 동작 · torch {torch_ver} (GPU wheel 미적용 — 준비를 다시 실행하세요)"
        )
    elif needs_cpu_torch_reinstall():
        speed_hint = (
            f"CPU로 동작 · torch {torch_ver} (CUDA wheel 잔존 — 준비를 다시 실행하세요)"
        )
    else:
        speed_hint = f"CPU · torch {torch_ver}"
    report(8.0, f"Demucs 분리를 시작합니다… ({speed_hint})")

    runner = demucs_runner_script()
    if not runner.is_file():
        raise RuntimeError(f"demucs_runner.py 없음: {runner}")
    if not Path(sys.executable).is_file():
        raise RuntimeError(f"Python 실행 파일 없음: {sys.executable}")

    command = [
        sys.executable,
        "-u",
        str(runner),
        "-n",
        MODEL_NAME,
        "-d",
        device_resolved,
        "--two-stems",
        "vocals",
        "--out",
        str(output_dir),
        str(used_input),
    ]
    jobs = _demucs_jobs_count()
    if jobs > 1:
        command.extend(["-j", str(jobs)])
    overlap = os.environ.get("ITMATZIP_DEMUCS_OVERLAP", "").strip()
    if overlap:
        command.extend(["--overlap", overlap])
    if os.environ.get("ITMATZIP_DEMUCS_NO_SPLIT", "").strip() in {"1", "true", "yes"}:
        command.append("--no-split")

    returncode, stdout, stderr = _run_demucs_with_progress(
        command,
        timeout_sec,
        report,
        duration_sec=float(audio_duration),
        device_label=device_resolved,
    )
    if returncode != 0:
        detail = _format_demucs_failure(returncode, stdout, stderr, command)
        msg = "Demucs 분리 실행에 실패했습니다.\n" + detail
        combined = stdout + stderr
        if "AssertionError" in combined or "pad1d" in combined:
            msg += "\n(짧은 오디오·모델 불일치일 수 있습니다. 더 긴 파일로 시도해 보세요.)"
        raise RuntimeError(msg)

    report(90.0, "분리 결과 파일을 찾는 중…")
    stem_key = used_input.stem
    instrumental_wav = _find_demucs_output(output_dir, stem_key, "no_vocals")
    vocals_wav = _find_demucs_output(output_dir, stem_key, "vocals")
    if instrumental_wav is None or vocals_wav is None:
        raise RuntimeError("분리 결과(MR·보컬) 파일을 찾을 수 없습니다.")

    report(93.0, "MR·보컬 wav 파일을 저장하는 중…")
    stamp = int(time.time() * 1000)
    inst_out = WORKSPACE_ROOT / f"{input_path.stem}-{stamp}-mr.wav"
    voc_out = WORKSPACE_ROOT / f"{input_path.stem}-{stamp}-vocals.wav"
    shutil.copy2(instrumental_wav, inst_out)
    shutil.copy2(vocals_wav, voc_out)

    try:
        if used_input != input_path and used_input.exists():
            used_input.unlink(missing_ok=True)
    except Exception:
        pass

    report(96.0, "다운로드용 MR 파일을 변환하는 중…")
    export_path = _export_stem_wav(inst_out, output_format, f"{input_path.stem}-{stamp}-mr-export")
    duration = _get_duration_seconds(input_path) or _get_duration_seconds(inst_out) or 0.0
    report(99.0, "마무리 중…")
    report(100.0, "MR·보컬 분리가 완료되었습니다.")

    return SeparationResult(
        instrumental_path=inst_out,
        vocals_path=voc_out,
        original_path=input_path.resolve(),
        export_path=export_path,
        duration_sec=float(duration),
    )


def _run_separation_job(
    input_path: Path,
    output_format: str,
    timeout_sec: float,
    device: str | None,
) -> None:
    try:
        result = separate_stems(
            input_path,
            output_format,
            timeout_sec=timeout_sec,
            device=device,
            on_progress=lambda p, m: _set_separation_job("running", p, m),
        )
        _set_separation_job("ready", 100.0, "MR·보컬 분리가 완료되었습니다.", result)
    except subprocess.TimeoutExpired:
        _set_separation_job("failed", 0.0, "분리 작업 시간 초과", None)
    except Exception as exc:
        _set_separation_job("failed", 0.0, f"분리 중 오류: {exc}", None)


def start_separation_job(
    input_path: Path,
    output_format: str,
    timeout_sec: float = 3600.0,
    device: str | None = None,
) -> SeparationJobStatus:
    global _separate_thread

    with _separate_lock:
        if _separate_thread is not None and _separate_thread.is_alive():
            return get_separation_job_status()

        _separate_job.result = None
        _separate_job.phase = "running"
        _separate_job.progress = 3.0
        _separate_job.message = "분리 작업을 시작합니다…"
        _separate_thread = threading.Thread(
            target=_run_separation_job,
            args=(input_path, output_format, timeout_sec, device),
            daemon=True,
        )
        _separate_thread.start()

    return get_separation_job_status()


def separate_audio(
    input_path: Path,
    output_format: str,
    timeout_sec: float = 3600.0,
    device: str | None = None,
) -> Path:
    return separate_stems(input_path, output_format, timeout_sec=timeout_sec, device=device).export_path
