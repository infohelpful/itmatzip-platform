"""Vocal Remover 다중 모델 레지스트리 · 런타임 설치 · 실행.

모델별 런타임:
  - mdxnet   : ONNX Runtime(DirectML) + numpy  → PyTorch 불필요 (~105 MB)
  - demucs   : PyTorch + demucs (기존 wheel 번들) + htdemucs 가중치
  - roformer : PyTorch + einops (vendored Mel-Band RoFormer) + 가중치

앙상블은 선택한 모델들을 차례로 실행한 뒤 ensemble_runner 로 결합합니다.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import threading
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from common.runtime_site_packages import (
    TOOL_VOCAL_REMOVER,
    ensure_runtime_tree_acl,
    runtime_site_packages_dir,
)
from common.subprocess_util import no_window_creationflags

PrepareProgressCallback = Callable[[float, str, str], None]
SeparateProgressCallback = Callable[[float, str], None]

LIB_HUB = "https://github.com/infohelpful/library-hub/releases/download"


@dataclass(frozen=True)
class ModelSpec:
    id: str
    label: str
    badge: str
    runtime: str  # "onnx" | "torch"
    filename: str
    url: str
    sha256: str
    size_bytes: int
    description: str


@dataclass(frozen=True)
class WheelSpec:
    package: str  # import 이름
    filename: str
    url: str
    sha256: str
    size_bytes: int


MODELS: dict[str, ModelSpec] = {
    "mdxnet": ModelSpec(
        id="mdxnet",
        label="MDX-Net (Voc_FT)",
        badge="빠름 · 기본",
        runtime="onnx",
        filename="UVR-MDX-NET-Voc_FT.onnx",
        url=os.environ.get(
            "ITMATZIP_VOCAL_MDX_URL", f"{LIB_HUB}/DeVocal-MDXNet/UVR-MDX-NET-Voc_FT.onnx"
        ),
        sha256="534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111",
        size_bytes=66_762_490,
        description="가벼운 ONNX 모델. PyTorch 없이 GPU(DirectML)·CPU 모두에서 빠르게 동작합니다.",
    ),
    "demucs": ModelSpec(
        id="demucs",
        label="Demucs v4 (HTDemucs)",
        badge="균형",
        runtime="torch",
        filename="htdemucs.th",
        url=os.environ.get("ITMATZIP_VOCAL_DEMUCS_URL", f"{LIB_HUB}/DeVocal-Demucs/htdemucs.th"),
        sha256="8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4",
        size_bytes=84_141_911,
        description="하이브리드 트랜스포머 모델. 드럼·베이스가 강한 곡에서 반주 보존이 좋습니다.",
    ),
    "roformer": ModelSpec(
        id="roformer",
        label="Mel-Band RoFormer",
        badge="최고 음질",
        runtime="torch",
        filename="MelBandRoformer.ckpt",
        url=os.environ.get(
            "ITMATZIP_VOCAL_ROFORMER_URL", f"{LIB_HUB}/DeVocal-Roformer/MelBandRoformer.ckpt"
        ),
        sha256="87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e",
        size_bytes=913_106_900,
        description="보컬 잔여음이 가장 적은 트랜스포머 모델. NVIDIA GPU(CUDA)에서 권장합니다.",
    ),
}

DEFAULT_MODEL = "mdxnet"
ENSEMBLE_ID = "ensemble"
DEFAULT_ENSEMBLE: tuple[str, ...] = ("roformer", "mdxnet")
# 품질 순 가중치 (정규화는 사용 모델 기준으로 다시 계산)
ENSEMBLE_WEIGHTS: dict[str, float] = {"roformer": 0.5, "mdxnet": 0.3, "demucs": 0.2}

# library-hub VocalRemover-ONNX-Lib 릴리스 (PyPI 원본 wheel 을 그대로 미러, SHA-256 동일)
ONNX_RELEASE_BASE = os.environ.get(
    "ITMATZIP_VOCAL_ONNX_RELEASE_BASE", f"{LIB_HUB}/VocalRemover-ONNX-Lib"
).rstrip("/")

ONNX_WHEELS: tuple[WheelSpec, ...] = (
    WheelSpec(
        package="onnxruntime",
        filename="onnxruntime_directml-1.24.4-cp312-cp312-win_amd64.whl",
        url=f"{ONNX_RELEASE_BASE}/onnxruntime_directml-1.24.4-cp312-cp312-win_amd64.whl",
        sha256="f2ecb68b7b7b259d2ef3112ae760149f9b5a1e7c0fbb73d539da6250a648a614",
        size_bytes=25_111_930,
    ),
    WheelSpec(
        package="numpy",
        filename="numpy-2.5.4-cp312-cp312-win_amd64.whl",
        url=f"{ONNX_RELEASE_BASE}/numpy-2.5.4-cp312-cp312-win_amd64.whl",
        sha256="a7b1b6353e36a7e50de2973a38d705c88ee93adcf120673cee7f45a4a3fa223a",
        size_bytes=12_573_091,
    ),
)

# library-hub VocalRemover-Lib 릴리스 크기 (UI 안내용 추정치)
TORCH_RUNTIME_BYTES = {"gpu": 2_777_000_000, "cpu": 147_000_000}


def _vr():
    from engines import vocal_remover

    return vocal_remover


# ---------------------------------------------------------------------------
# 선택 정규화
# ---------------------------------------------------------------------------

def normalize_model(model: str | None) -> str:
    mid = (model or DEFAULT_MODEL).strip().lower()
    aliases = {"mdx": "mdxnet", "mdx-net": "mdxnet", "htdemucs": "demucs", "mel-roformer": "roformer"}
    mid = aliases.get(mid, mid)
    if mid != ENSEMBLE_ID and mid not in MODELS:
        raise ValueError(f"지원하지 않는 모델입니다: {model}")
    return mid


def resolve_models(model: str | None, ensemble_models: list[str] | None = None) -> list[str]:
    """선택(단일 모델 또는 앙상블) → 실제로 실행할 기본 모델 목록."""
    mid = normalize_model(model)
    if mid != ENSEMBLE_ID:
        return [mid]
    chosen: list[str] = []
    for item in ensemble_models or DEFAULT_ENSEMBLE:
        base = normalize_model(item)
        if base == ENSEMBLE_ID:
            raise ValueError("앙상블 안에 앙상블을 넣을 수 없습니다.")
        if base not in chosen:
            chosen.append(base)
    if len(chosen) < 2:
        raise ValueError("앙상블에는 서로 다른 모델이 2개 이상 필요합니다.")
    return chosen


# ---------------------------------------------------------------------------
# 상태
# ---------------------------------------------------------------------------

def models_root() -> Path:
    root = _vr().MODEL_ROOT
    root.mkdir(parents=True, exist_ok=True)
    return root


def weights_dir(mid: str) -> Path:
    path = models_root() / mid
    path.mkdir(parents=True, exist_ok=True)
    return path


def weights_path(mid: str) -> Path:
    return weights_dir(mid) / MODELS[mid].filename


def is_weights_ready(mid: str) -> bool:
    path = weights_path(mid)
    return path.is_file() and path.stat().st_size == MODELS[mid].size_bytes


def _site() -> Path:
    return runtime_site_packages_dir(TOOL_VOCAL_REMOVER)


def is_onnx_runtime_installed() -> bool:
    site = _site()
    capi = site / "onnxruntime" / "capi"
    has_ort = capi.is_dir() and any(capi.glob("onnxruntime_pybind11_state*.pyd"))
    has_dml = (capi / "DirectML.dll").is_file() or os.name != "nt"
    has_numpy = (site / "numpy" / "__init__.py").is_file()
    return has_ort and has_dml and has_numpy


def is_torch_runtime_ready() -> bool:
    vr = _vr()
    return (
        vr.is_demucs_installed()
        and not vr.needs_cuda_torch_reinstall()
        and not vr.needs_cpu_torch_reinstall()
    )


def is_runtime_ready(mid: str) -> bool:
    if MODELS[mid].runtime == "onnx":
        return is_onnx_runtime_installed()
    return is_torch_runtime_ready()


def is_model_ready(mid: str) -> bool:
    return is_runtime_ready(mid) and is_weights_ready(mid)


def is_selection_ready(models: list[str]) -> bool:
    return all(is_model_ready(m) for m in models)


def _runtime_download_bytes(runtime: str) -> int:
    if runtime == "onnx":
        if is_onnx_runtime_installed():
            return 0
        return sum(w.size_bytes for w in ONNX_WHEELS)
    if is_torch_runtime_ready():
        return 0
    bundle = _vr().select_wheel_bundle()
    return TORCH_RUNTIME_BYTES.get(bundle, TORCH_RUNTIME_BYTES["cpu"])


def pending_download_bytes(models: list[str]) -> int:
    runtimes = {MODELS[m].runtime for m in models}
    total = sum(_runtime_download_bytes(r) for r in runtimes)
    total += sum(MODELS[m].size_bytes for m in models if not is_weights_ready(m))
    return total


def model_catalog() -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    torch_ready = is_torch_runtime_ready()
    onnx_ready = is_onnx_runtime_installed()
    for spec in MODELS.values():
        runtime_ready = onnx_ready if spec.runtime == "onnx" else torch_ready
        weights_ready = is_weights_ready(spec.id)
        rows.append({
            "id": spec.id,
            "label": spec.label,
            "badge": spec.badge,
            "runtime": spec.runtime,
            "description": spec.description,
            "weights_bytes": spec.size_bytes,
            "runtime_ready": runtime_ready,
            "weights_ready": weights_ready,
            "ready": runtime_ready and weights_ready,
            "download_bytes": pending_download_bytes([spec.id]),
        })
    return rows


# ---------------------------------------------------------------------------
# 설치
# ---------------------------------------------------------------------------

def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(4 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _download_verified(
    url: str,
    dest: Path,
    *,
    sha256: str,
    size_bytes: int,
    on_progress: PrepareProgressCallback | None,
    pct_range: tuple[float, float],
    label: str,
) -> None:
    vr = _vr()
    if dest.is_file() and dest.stat().st_size == size_bytes:
        if on_progress:
            on_progress(pct_range[1], label, f"{dest.name} 이미 있음")
        return
    dest.unlink(missing_ok=True)
    for attempt in (1, 2):
        vr._download_wheel_archive(url, dest, on_progress=on_progress, progress_pct_range=pct_range, label=label)
        if on_progress:
            on_progress(pct_range[1], label, f"{dest.name} 무결성 확인 중")
        if dest.stat().st_size == size_bytes and (not sha256 or _sha256(dest) == sha256):
            return
        dest.unlink(missing_ok=True)
        if attempt == 2:
            raise RuntimeError(f"{dest.name} 다운로드 파일이 손상되었습니다 (크기/SHA-256 불일치).")


def _onnx_cache_dir() -> Path:
    path = _vr().VOCAL_REMOVER_ROOT / "onnx-cache"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _probe_onnx_runtime() -> str:
    """별도 프로세스에서 onnxruntime import 확인 → 사용 가능한 provider 목록."""
    from common.runtime_site_packages import engine_python_c_prefix
    from common.subprocess_util import run_hidden

    script = (
        engine_python_c_prefix(TOOL_VOCAL_REMOVER)
        + "import onnxruntime as o, numpy; print('ORT_OK', ','.join(o.get_available_providers()))"
    )
    proc = run_hidden([sys.executable, "-c", script], capture_output=True, text=True, timeout=120)
    out = (proc.stdout or "").strip()
    if proc.returncode != 0 or "ORT_OK" not in out:
        detail = (proc.stderr or out or "unknown").strip()
        raise RuntimeError(f"ONNX Runtime 확인 실패: {detail[-1500:]}")
    return out.split("ORT_OK", 1)[1].strip()


def install_onnx_runtime(
    on_progress: PrepareProgressCallback | None = None,
    pct_range: tuple[float, float] = (5.0, 40.0),
) -> None:
    """onnxruntime-directml + numpy wheel 을 vocal-remover runtime site 에 직접 해제."""
    if is_onnx_runtime_installed():
        return
    site = _site()
    ensure_runtime_tree_acl(TOOL_VOCAL_REMOVER)
    wheels = [w for w in ONNX_WHEELS if not (w.package == "numpy" and (site / "numpy" / "__init__.py").is_file())]
    total = sum(w.size_bytes for w in wheels) or 1
    lo, hi = pct_range
    span_dl = (hi - lo) * 0.85
    cursor = lo
    cache = _onnx_cache_dir()
    paths: list[Path] = []
    for w in wheels:
        share = span_dl * w.size_bytes / total
        dest = cache / w.filename
        _download_verified(
            w.url,
            dest,
            sha256=w.sha256,
            size_bytes=w.size_bytes,
            on_progress=on_progress,
            pct_range=(cursor, cursor + share),
            label="ONNX 실행 환경 다운로드",
        )
        cursor += share
        paths.append(dest)

    if on_progress:
        on_progress(cursor, "ONNX 실행 환경 설치", "wheel 을 runtime site-packages 에 해제합니다")
    for path in paths:
        with zipfile.ZipFile(path) as zf:
            zf.extractall(site)
    ensure_runtime_tree_acl(TOOL_VOCAL_REMOVER)

    if on_progress:
        on_progress(hi - 1, "ONNX 실행 환경 확인", "onnxruntime import 검증 중")
    providers = _probe_onnx_runtime()
    shutil.rmtree(cache, ignore_errors=True)
    if on_progress:
        on_progress(hi, "ONNX 실행 환경 설치 완료", providers)


def download_weights(
    mid: str,
    on_progress: PrepareProgressCallback | None = None,
    pct_range: tuple[float, float] = (40.0, 99.0),
) -> None:
    spec = MODELS[mid]
    _download_verified(
        spec.url,
        weights_path(mid),
        sha256=spec.sha256,
        size_bytes=spec.size_bytes,
        on_progress=on_progress,
        pct_range=pct_range,
        label=f"AI 모델 다운로드 · {spec.label}",
    )


# ---------------------------------------------------------------------------
# 실행
# ---------------------------------------------------------------------------

def _run_runner(
    command: list[str],
    *,
    timeout_sec: float,
    on_progress: SeparateProgressCallback,
    pct_range: tuple[float, float],
    label: str,
) -> dict[str, str]:
    """runner 서브프로세스 실행 · PROGRESS 줄을 pct_range 로 매핑 · 실패 시 stderr 포함 예외."""
    from runtime_paths import agent_package_root

    env = _vr().runner_subprocess_env()
    kwargs: dict = {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "bufsize": 1,
        "env": env,
        "cwd": str(agent_package_root()),
    }
    if os.name == "nt":
        kwargs["creationflags"] = no_window_creationflags()
    proc = subprocess.Popen(command, **kwargs)  # noqa: S603
    info: dict[str, str] = {}
    stderr_lines: list[str] = []
    timed_out = threading.Event()
    lo, hi = pct_range

    def read_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_lines.append(line)

    def kill_on_timeout() -> None:
        timed_out.set()
        proc.kill()

    err_thread = threading.Thread(target=read_stderr, daemon=True)
    err_thread.start()
    timer = threading.Timer(timeout_sec, kill_on_timeout)
    timer.start()
    try:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.strip()
            if line.startswith("PROGRESS "):
                parts = line.split(" ", 2)
                try:
                    pct = float(parts[1])
                except (IndexError, ValueError):
                    continue
                msg = parts[2] if len(parts) > 2 else ""
                # runner 문구에 모델명이 이미 들어 있고, 앙상블은 호출 측이 [i/n 모델] 접두어를 붙임
                on_progress(lo + (hi - lo) * max(0.0, min(100.0, pct)) / 100.0, msg or label)
            elif line.startswith("PROVIDER "):
                info["provider"] = line.split(" ", 1)[1]
            elif line == "DONE":
                info["done"] = "1"
        proc.wait()
    finally:
        timer.cancel()
        err_thread.join(timeout=10.0)
    if timed_out.is_set():
        raise subprocess.TimeoutExpired(command, timeout_sec)
    if proc.returncode != 0 or "done" not in info:
        tail = "".join(stderr_lines)[-3000:].strip()
        raise RuntimeError(f"{label} 실행에 실패했습니다 (exit {proc.returncode}).\n{tail}")
    return info


def _runner_script(name: str) -> Path:
    from runtime_paths import agent_package_root

    return agent_package_root() / "engines" / name


def _onnx_device_arg(device: str | None) -> str:
    return "cpu" if (device or "").lower() == "cpu" else "auto"


def separate_mdx(
    input_path: Path,
    vocals_out: Path,
    inst_out: Path,
    *,
    device: str | None,
    timeout_sec: float,
    on_progress: SeparateProgressCallback,
    pct_range: tuple[float, float],
) -> dict[str, str]:
    from common.bin_manager import get_ffmpeg_executable

    command = [
        sys.executable, "-u", str(_runner_script("mdx_runner.py")),
        "--model", str(weights_path("mdxnet")),
        "--input", str(input_path),
        "--vocals", str(vocals_out),
        "--instrumental", str(inst_out),
        "--device", _onnx_device_arg(device),
        "--ffmpeg", str(get_ffmpeg_executable()),
    ]
    return _run_runner(command, timeout_sec=timeout_sec, on_progress=on_progress, pct_range=pct_range, label="MDX-Net")


def separate_roformer(
    input_path: Path,
    vocals_out: Path,
    inst_out: Path,
    *,
    device: str | None,
    timeout_sec: float,
    on_progress: SeparateProgressCallback,
    pct_range: tuple[float, float],
) -> dict[str, str]:
    from common.bin_manager import get_ffmpeg_executable

    dev = _vr()._resolve_device(device)
    command = [
        sys.executable, "-u", str(_runner_script("roformer_runner.py")),
        "--model", str(weights_path("roformer")),
        "--input", str(input_path),
        "--vocals", str(vocals_out),
        "--instrumental", str(inst_out),
        "--device", dev,
        "--ffmpeg", str(get_ffmpeg_executable()),
    ]
    return _run_runner(command, timeout_sec=timeout_sec, on_progress=on_progress, pct_range=pct_range, label="Roformer")


def blend_ensemble(
    mix_path: Path,
    sources: list[tuple[str, Path]],
    vocals_out: Path,
    inst_out: Path,
    *,
    timeout_sec: float,
    on_progress: SeparateProgressCallback,
    pct_range: tuple[float, float],
) -> dict[str, str]:
    from common.bin_manager import get_ffmpeg_executable

    command = [
        sys.executable, "-u", str(_runner_script("ensemble_runner.py")),
        "--mix", str(mix_path),
        "--vocals-out", str(vocals_out),
        "--instrumental-out", str(inst_out),
        "--ffmpeg", str(get_ffmpeg_executable()),
    ]
    for mid, path in sources:
        command += ["--source", f"{path}:{ENSEMBLE_WEIGHTS.get(mid, 1.0)}"]
    return _run_runner(command, timeout_sec=timeout_sec, on_progress=on_progress, pct_range=pct_range, label="앙상블 결합")


def job_dir() -> Path:
    path = _vr().WORKSPACE_ROOT / f"job-{int(time.time() * 1000)}"
    path.mkdir(parents=True, exist_ok=True)
    return path
