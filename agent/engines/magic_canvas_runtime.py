"""Magic Canvas 전용 Python 3.12 venv — SDXL + rembg."""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Callable

from common.runtime_site_packages import TOOL_MAGIC_CANVAS
from common.subprocess_util import no_window_creationflags, run_hidden
from engines.codeformer_runtime import (
    _merge_split_zip_parts,
    _verify_zip_archive,
    codeformer_venv_dir,
    find_python312,
)

logger = logging.getLogger(__name__)

PrepareProgressCallback = Callable[[float, str, str], None]

SDXL_BASE_REPO = "stabilityai/stable-diffusion-xl-base-1.0"
CONTROLNET_INPAINT_REPO = "destitech/controlnet-inpaint-dreamer-sdxl"

HF_GATED_MODEL_PAGES = (
    ("stabilityai/stable-diffusion-xl-base-1.0", "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0"),
)

MAGIC_CANVAS_LIB_BASE = os.environ.get(
    "ITMATZIP_MAGIC_CANVAS_LIB_BASE",
    "https://github.com/infohelpful/library-hub/releases/download/Magic_Canvas_Lib",
)

_SDXL_FP16_PATTERNS = (
    "model_index.json",
    "scheduler/*",
    "tokenizer/*",
    "tokenizer_2/*",
    "text_encoder/config.json",
    "text_encoder/model.fp16.safetensors",
    "text_encoder_2/config.json",
    "text_encoder_2/model.fp16.safetensors",
    "unet/config.json",
    "unet/diffusion_pytorch_model.fp16.safetensors",
    "vae/config.json",
    "vae/diffusion_pytorch_model.fp16.safetensors",
)
_CONTROLNET_FP16_PATTERNS = ("config.json", "diffusion_pytorch_model.fp16.safetensors")

TORCH_CPU_INDEX = os.environ.get(
    "ITMATZIP_MAGIC_CANVAS_TORCH_CPU_INDEX",
    "https://download.pytorch.org/whl/cpu",
)
TORCH_CUDA_INDEX = os.environ.get(
    "ITMATZIP_MAGIC_CANVAS_TORCH_CUDA_INDEX",
    "https://download.pytorch.org/whl/cu124",
)

MAGIC_CANVAS_PIP_PACKAGES = (
    "numpy>=1.26.0,<3",
    "Pillow>=10.0.0",
    "opencv-python-headless>=4.8.0",
    "huggingface-hub>=0.26.0",
    "safetensors>=0.4.0",
    "transformers>=4.44.0",
    "accelerate>=0.33.0",
    "diffusers>=0.30.0",
    "rembg>=2.0.50",
    "onnxruntime>=1.17.0",
)

_TORCH_PROBE_SCRIPT = """
import json
d = {'version': '', 'variant': None, 'cuda_available': False, 'error': None}
try:
    import torch
    d['version'] = str(torch.__version__)
    vl = d['version'].lower()
    if '+cpu' in vl:
        d['variant'] = 'cpu'
    elif '+cu' in vl:
        d['variant'] = 'gpu'
    else:
        d['variant'] = 'cpu'
    d['cuda_available'] = bool(getattr(torch, 'cuda', None) and torch.cuda.is_available())
except Exception as e:
    d['error'] = str(e)
print(json.dumps(d))
"""

_MODEL_DOWNLOAD_SCRIPT = """
import json
import os
import sys

def emit(pct, msg):
    print(json.dumps({"type": "progress", "progress": pct, "message": msg}), flush=True)

def fail(code, message, repo=""):
    print(json.dumps({"type": "error", "code": code, "message": message, "repo": repo}), flush=True)
    sys.exit(1)

models = os.environ.get("ITMATZIP_MAGIC_CANVAS_MODELS", "")
if not models:
    fail("config", "ITMATZIP_MAGIC_CANVAS_MODELS not set")
os.environ["HF_HOME"] = models
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

from huggingface_hub import snapshot_download

token = (
    os.environ.get("HF_TOKEN", "").strip()
    or os.environ.get("HUGGING_FACE_HUB_TOKEN", "").strip()
    or None
)

fp16 = [
  'model_index.json', 'scheduler/*', 'tokenizer/*', 'tokenizer_2/*',
  'text_encoder/config.json', 'text_encoder/model.fp16.safetensors',
  'text_encoder_2/config.json', 'text_encoder_2/model.fp16.safetensors',
  'unet/config.json', 'unet/diffusion_pytorch_model.fp16.safetensors',
  'vae/config.json', 'vae/diffusion_pytorch_model.fp16.safetensors',
]
repos = [
    ("destitech/controlnet-inpaint-dreamer-sdxl", 15, 55, ['config.json','diffusion_pytorch_model.fp16.safetensors']),
    ("stabilityai/stable-diffusion-xl-base-1.0", 55, 95, fp16),
]
for repo, lo, hi, patterns in repos:
    emit(lo, f"Downloading {repo}…")
    try:
        snapshot_download(repo, token=token, allow_patterns=patterns)
    except Exception as exc:
        err = str(exc)
        if "401" in err or "Unauthorized" in err or "GatedRepoError" in err:
            fail("hf_auth", err, repo)
        raise
    emit(hi, f"Downloaded {repo}")
emit(100, "Models ready")
print(json.dumps({"type": "done"}), flush=True)
"""


def magic_canvas_root() -> Path:
    return Path(os.environ.get("APPDATA", Path.home() / ".itmatzip")) / "ItMatZip" / "magic-canvas"


def huggingface_token_file() -> Path:
    return Path(os.environ.get("APPDATA", Path.home() / ".itmatzip")) / "ItMatZip" / "huggingface.token"


def _hf_cli_token_file_paths() -> list[Path]:
    """huggingface-cli login · HF Hub 기본 캐시 위치."""
    paths: list[Path] = []
    hf_home = os.environ.get("HF_HOME", "").strip()
    if hf_home:
        paths.append(Path(hf_home) / "token")
    xdg = os.environ.get("XDG_CACHE_HOME", "").strip()
    if xdg:
        paths.append(Path(xdg) / "huggingface" / "token")
    else:
        paths.append(Path.home() / ".cache" / "huggingface" / "token")
    paths.append(Path.home() / ".huggingface" / "token")
    return paths


def _read_token_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    try:
        val = path.read_text(encoding="utf-8").strip()
        return val or None
    except OSError:
        return None


def resolve_hf_token() -> str | None:
    for key in ("ITMATZIP_HF_TOKEN", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
        val = os.environ.get(key, "").strip()
        if val:
            return val
    val = _read_token_file(huggingface_token_file())
    if val:
        return val
    for path in _hf_cli_token_file_paths():
        val = _read_token_file(path)
        if val:
            return val
    try:
        from huggingface_hub.utils import get_token

        val = get_token()
        if val:
            return str(val).strip()
    except Exception:
        pass
    return None


def save_hf_token(token: str) -> None:
    cleaned = token.strip()
    if not cleaned:
        raise ValueError("Hugging Face 토큰이 비어 있습니다.")
    if not cleaned.startswith("hf_"):
        raise ValueError("Hugging Face Access Token(hf_...) 형식이 아닙니다.")
    path = huggingface_token_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(cleaned + "\n", encoding="utf-8")


def format_hf_auth_error(repo: str = "") -> str:
    pages = "\n".join(f"   · {url}" for _, url in HF_GATED_MODEL_PAGES)
    token_path = huggingface_token_file()
    return (
        "Hugging Face 모델 다운로드 인증이 필요합니다.\n\n"
        "SDXL 베이스 모델은 라이선스 동의 후 토큰이 있어야 받을 수 있습니다.\n"
        "(ControlNet 인페인트 모델은 공개 다운로드)\n\n"
        "1) https://huggingface.co 에 로그인\n"
        "2) 아래 모델 페이지에서 Agree and access 클릭:\n"
        f"{pages}\n"
        "3) Access Token 발급: https://huggingface.co/settings/tokens (Read 권한)\n"
        "4) 토큰 저장 (하나만 하면 됨):\n"
        f"   · 파일: {token_path}\n"
        "   · 또는 터미널: huggingface-cli login\n"
        "   · 또는 Magic Canvas 화면의 HF 토큰 입력\n\n"
        f"실패한 모델: {repo or CONTROLNET_INPAINT_REPO}"
    )


def is_hf_auth_error_text(text: str) -> bool:
    lowered = text.lower()
    return (
        "401" in text
        or "unauthorized" in lowered
        or "gatedrepoerror" in lowered
        or "hf_auth" in lowered
    )


def models_dir() -> Path:
    p = magic_canvas_root() / "models"
    p.mkdir(parents=True, exist_ok=True)
    return p.resolve()


def models_cache_dir() -> Path:
    p = magic_canvas_root() / "model-cache"
    p.mkdir(parents=True, exist_ok=True)
    return p.resolve()


def bundle_dir() -> Path:
    return models_dir() / "bundle"


def sdxl_bundle_dir() -> Path:
    return bundle_dir() / "sdxl-base"


def controlnet_bundle_dir() -> Path:
    return bundle_dir() / "controlnet"


def _models_bundle_marker_path() -> Path:
    return models_cache_dir() / "bundle_urls.txt"


def _models_bundle_part_urls() -> list[str]:
    override = os.environ.get("ITMATZIP_MAGIC_CANVAS_MODELS_PART_URLS", "").strip()
    if override:
        return [u.strip() for u in override.splitlines() if u.strip()]
    return [f"{MAGIC_CANVAS_LIB_BASE.rstrip('/')}/magic-canvas-models.zip.{i:03d}" for i in range(1, 6)]


def _lib_download_token() -> str:
    return (
        os.environ.get("ITMATZIP_MAGIC_CANVAS_LIB_TOKEN", "").strip()
        or os.environ.get("GITHUB_TOKEN", "").strip()
        or os.environ.get("GH_TOKEN", "").strip()
    )


def _download_lib_file(
    url: str,
    dest: Path,
    *,
    bytes_cb: Callable[[int, int], None] | None = None,
    label: str = "다운로드",
) -> int:
    """HTTP 다운로드. bytes_cb(downloaded, total) — total=0 이면 크기 미상."""
    headers = {
        "User-Agent": "ItMatZip-Agent-MagicCanvas/1.0",
        "Accept": "application/octet-stream,*/*",
    }
    token = _lib_download_token()
    if token:
        headers["Authorization"] = f"token {token}"
    part = dest.with_suffix(dest.suffix + ".part")
    if bytes_cb:
        bytes_cb(0, 0)
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=3600) as response:
            total = int(response.headers.get("Content-Length") or 0)
            downloaded = 0
            last_cb_at = 0
            with part.open("wb") as out:
                while True:
                    chunk = response.read(256 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
                    downloaded += len(chunk)
                    if bytes_cb and downloaded - last_cb_at >= 512 * 1024:
                        bytes_cb(downloaded, total)
                        last_cb_at = downloaded
            if bytes_cb:
                bytes_cb(downloaded, total or downloaded)
        os.replace(part, dest)
        return downloaded
    except (urllib.error.URLError, OSError) as exc:
        part.unlink(missing_ok=True)
        raise RuntimeError(f"{label} 실패: {url}") from exc


def is_bundle_ready() -> bool:
    sdxl = sdxl_bundle_dir()
    cn = controlnet_bundle_dir()
    sdxl_ok = (sdxl / "model_index.json").is_file() and (
        sdxl / "unet" / "diffusion_pytorch_model.fp16.safetensors"
    ).is_file()
    cn_ok = (cn / "config.json").is_file() and (cn / "diffusion_pytorch_model.fp16.safetensors").is_file()
    return sdxl_ok and cn_ok


def _models_bundle_cache_valid() -> bool:
    marker = _models_bundle_marker_path()
    if not marker.is_file():
        return False
    if marker.read_text(encoding="utf-8").strip() != "\n".join(_models_bundle_part_urls()):
        return False
    return is_bundle_ready()


def _relocate_bundle_tree(src: Path, dest: Path) -> None:
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dest))


def _install_models_bundle_from_archive(archive: Path) -> None:
    staging = models_cache_dir() / "_bundle_extract"
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "r") as zf:
        zf.extractall(staging)

    roots = [staging / "magic-canvas-models", staging]
    sdxl_src = None
    cn_src = None
    for root in roots:
        if not root.is_dir():
            continue
        sdxl_candidate = root / "sdxl-base"
        cn_candidate = root / "controlnet"
        if sdxl_candidate.is_dir() and cn_candidate.is_dir():
            sdxl_src = sdxl_candidate
            cn_src = cn_candidate
            break
    if sdxl_src is None or cn_src is None:
        raise RuntimeError("magic-canvas-models.zip 안에 sdxl-base / controlnet 폴더를 찾지 못했습니다.")

    _relocate_bundle_tree(sdxl_src, sdxl_bundle_dir())
    _relocate_bundle_tree(cn_src, controlnet_bundle_dir())
    shutil.rmtree(staging, ignore_errors=True)

    if not is_bundle_ready():
        raise RuntimeError("모델 번들 설치 후 검증에 실패했습니다.")


def ensure_models_bundle_from_lib(
    *,
    on_progress: PrepareProgressCallback | None = None,
    force: bool = False,
) -> None:
    """library-hub Magic_Canvas_Lib 분할 zip → bundle/sdxl-base · controlnet."""
    if not force and _models_bundle_cache_valid():
        _emit(on_progress, 96.0, "모델 준비", "library-hub 번들 (캐시)")
        return

    urls = _models_bundle_part_urls()
    part_count = len(urls)
    cache = models_cache_dir()
    parts_dir = cache / "parts"
    parts_dir.mkdir(parents=True, exist_ok=True)
    part_paths = [parts_dir / f"magic-canvas-models.zip.{i:03d}" for i in range(1, part_count + 1)]

    # 전체 prepare 중 모델 구간 58% ~ 98%
    span_lo = 58.0
    span_hi = 98.0
    download_hi = 92.0
    part_span = (download_hi - span_lo) / max(part_count, 1)
    part_bytes: list[int] = []

    def fmt_mb(n: int) -> str:
        return f"{n / (1024 * 1024):.0f} MB"

    def emit_model_progress(overall_pct: float, detail: str) -> None:
        _emit(on_progress, overall_pct, "모델 다운로드", detail)

    for idx, (url, part_path) in enumerate(zip(urls, part_paths, strict=True), start=1):
        part_lo = span_lo + (idx - 1) * part_span

        def on_part_bytes(downloaded: int, total: int, *, i: int = idx, lo: float = part_lo) -> None:
            if total > 0:
                frac = min(1.0, downloaded / total)
                overall = lo + frac * part_span
                part_pct = int(frac * 100)
                detail = (
                    f"파트 {i}/{part_count} · {fmt_mb(downloaded)} / {fmt_mb(total)} ({part_pct}%)"
                )
            else:
                overall = lo + part_span * 0.5
                detail = f"파트 {i}/{part_count} · {fmt_mb(downloaded)} (크기 확인 중…)"
            emit_model_progress(overall, detail)

        _download_lib_file(
            url,
            part_path,
            bytes_cb=on_part_bytes,
            label=f"파트 {idx}/{part_count}",
        )
        try:
            part_bytes.append(part_path.stat().st_size)
        except OSError:
            part_bytes.append(0)
        emit_model_progress(span_lo + idx * part_span, f"파트 {idx}/{part_count} 완료")

    if part_bytes:
        total_mb = sum(part_bytes) / (1024 * 1024)
        emit_model_progress(download_hi, f"다운로드 완료 · 총 {total_mb:.0f} MB ({part_count}개 파트)")

    merged = cache / "magic-canvas-models.zip"
    emit_model_progress(93.0, "분할 zip 병합 중…")
    _merge_split_zip_parts(part_paths, merged)
    _verify_zip_archive(merged)
    emit_model_progress(95.0, "모델 압축 해제 중…")
    _install_models_bundle_from_archive(merged)
    _models_bundle_marker_path().write_text("\n".join(urls), encoding="utf-8")
    _emit(on_progress, 98.0, "모델 준비", "library-hub 모델 설치 완료")


def workspace_root() -> Path:
    p = magic_canvas_root() / "workspace"
    p.mkdir(parents=True, exist_ok=True)
    return p.resolve()


def venv_dir() -> Path:
    return (magic_canvas_root() / ".venv-magiccanvas").resolve()


def venv_python() -> Path:
    explicit = os.environ.get("ITMATZIP_MAGIC_CANVAS_PYTHON", "").strip()
    if explicit:
        p = Path(explicit)
        if p.is_file():
            return p.resolve()
    py = venv_dir() / "Scripts" / "python.exe"
    if not py.is_file():
        raise RuntimeError(
            "Magic Canvas 가상환경이 없습니다. '환경 준비'(/prepare)를 먼저 실행하세요."
        )
    return py


def resolved_worker_script() -> Path:
    """%APPDATA%\\ItMatZip\\magic-canvas\\magic_canvas_worker.py 우선 (핫픽스)."""
    appdata = os.environ.get("APPDATA", "").strip()
    if appdata:
        override = Path(appdata) / "ItMatZip" / "magic-canvas" / "magic_canvas_worker.py"
        if override.is_file():
            return override.resolve()
    explicit = os.environ.get("ITMATZIP_MAGIC_CANVAS_WORKER_SCRIPT", "").strip()
    if explicit:
        p = Path(explicit)
        if p.is_file():
            return p.resolve()
    from runtime_paths import magic_canvas_worker_script

    return magic_canvas_worker_script()


def worker_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONNOUSERSITE"] = "1"
    env["PYTHONSAFEPATH"] = "1"
    env["ITMATZIP_RUNTIME_TOOL"] = TOOL_MAGIC_CANVAS
    env["ITMATZIP_MAGIC_CANVAS_MODELS"] = str(models_dir())
    env["HF_HOME"] = str(models_dir())
    env["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
    env.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    if is_bundle_ready():
        env["ITMATZIP_MAGIC_CANVAS_SDXL_DIR"] = str(sdxl_bundle_dir())
        env["ITMATZIP_MAGIC_CANVAS_CONTROLNET_DIR"] = str(controlnet_bundle_dir())
    token = resolve_hf_token()
    if token:
        env["HF_TOKEN"] = token
        env["HUGGING_FACE_HUB_TOKEN"] = token
    return env


def _base_python_for_venv() -> str:
    """Magic Canvas venv 생성에 쓸 Python 3.12 실행 파일 (전체 경로)."""
    explicit = os.environ.get("ITMATZIP_MAGIC_CANVAS_VENV_PYTHON", "").strip()
    if explicit:
        p = Path(explicit)
        if p.is_file():
            return str(p.resolve())
    codeformer_py = codeformer_venv_dir() / "Scripts" / "python.exe"
    if codeformer_py.is_file():
        return str(codeformer_py.resolve())
    return find_python312()


def ensure_venv() -> Path:
    py = venv_dir() / "Scripts" / "python.exe"
    if py.is_file():
        return py
    base_py = _base_python_for_venv()
    venv_dir().parent.mkdir(parents=True, exist_ok=True)
    proc = run_hidden(
        [base_py, "-m", "venv", str(venv_dir())],
        capture_output=True,
        text=True,
        timeout=300,
        creationflags=no_window_creationflags(),
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "venv 생성 실패")[-800:])
    if not py.is_file():
        raise RuntimeError(f"venv 생성 실패: {venv_dir()}")
    bootstrap = run_hidden(
        [str(py), "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
        capture_output=True,
        text=True,
        timeout=300,
        creationflags=no_window_creationflags(),
    )
    if bootstrap.returncode != 0:
        raise RuntimeError((bootstrap.stderr or bootstrap.stdout or "pip bootstrap 실패")[-800:])
    return py


def _run_venv_python(args: list[str], *, timeout: float = 7200.0, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    merged = worker_env()
    if env:
        merged.update(env)
    return run_hidden(
        [str(venv_python()), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        creationflags=no_window_creationflags(),
        env=merged,
    )


def has_nvidia_gpu() -> bool:
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


def detect_gpu_vram_mb() -> int:
    from engines.create_music_gpu_config import detect_gpu_vram_mb as _detect

    return _detect()


def select_torch_bundle() -> str:
    variant = os.environ.get("ITMATZIP_MAGIC_CANVAS_TORCH_VARIANT", "auto").strip().lower()
    if variant == "cpu":
        return "cpu"
    if variant == "gpu":
        return "gpu"
    return "gpu" if has_nvidia_gpu() else "cpu"


def probe_torch(timeout: float = 90.0) -> dict[str, Any]:
    try:
        with _pip_import_lock:
            proc = _run_venv_python(["-c", _TORCH_PROBE_SCRIPT], timeout=timeout)
    except (OSError, subprocess.TimeoutExpired, RuntimeError) as exc:
        return {"error": str(exc)}
    if proc.returncode != 0:
        return {"error": (proc.stderr or proc.stdout or "torch probe failed").strip()}
    line = (proc.stdout or "").strip().splitlines()[-1] if proc.stdout else ""
    try:
        data = json.loads(line)
        return data if isinstance(data, dict) else {"error": "invalid probe json"}
    except json.JSONDecodeError:
        return {"error": f"torch probe parse failed: {line[:200]}"}


_pip_import_lock = threading.Lock()
_torch_probe_cache: tuple[float, dict[str, Any]] | None = None


def _probe_torch_cached(max_age_sec: float = 120.0) -> dict[str, Any]:
    global _torch_probe_cache
    now = time.monotonic()
    if _torch_probe_cache is not None and now - _torch_probe_cache[0] < max_age_sec:
        return _torch_probe_cache[1]
    data = probe_torch()
    _torch_probe_cache = (now, data)
    return data


def is_cuda_available() -> bool:
    if not is_venv_ready():
        return False
    return bool(_probe_torch_cached().get("cuda_available"))


def is_venv_ready() -> bool:
    return (venv_dir() / "Scripts" / "python.exe").is_file()


def is_pip_stack_ready_fast() -> bool:
    """subprocess import 없이 site-packages 디스크만 확인 (prepare/readiness용)."""
    if not is_venv_ready():
        return False
    site = venv_dir() / "Lib" / "site-packages"
    if not site.is_dir():
        return False
    has_torch = (site / "torch").is_dir() or any(site.glob("torch-*.dist-info"))
    has_diffusers = (site / "diffusers").is_dir() or any(site.glob("diffusers-*.dist-info"))
    has_rembg = (site / "rembg").is_dir() or any(site.glob("rembg-*.dist-info"))
    has_cv2 = (site / "cv2").is_dir() or any(site.glob("opencv_python*.dist-info"))
    return bool(has_torch and has_diffusers and has_rembg and has_cv2)


def is_pip_stack_ready() -> bool:
    if not is_venv_ready():
        return False
    if is_pip_stack_ready_fast():
        return True
    script = (
        "import diffusers, rembg, cv2, torch\n"
        "print('ok')"
    )
    try:
        with _pip_import_lock:
            proc = _run_venv_python(["-c", script], timeout=120)
        return proc.returncode == 0
    except Exception:
        return False


def _model_snapshot_ready(repo: str) -> bool:
    """HF cache hub layout — models--org--name/snapshots/<hash>."""
    hub = models_dir() / "hub"
    if not hub.is_dir():
        return False
    slug = "models--" + repo.replace("/", "--")
    snap_root = hub / slug / "snapshots"
    if not snap_root.is_dir():
        return False
    for child in snap_root.iterdir():
        if child.is_dir() and any(child.iterdir()):
            return True
    return False


def is_model_ready() -> bool:
    if is_bundle_ready():
        return True
    return _model_snapshot_ready(SDXL_BASE_REPO) and _model_snapshot_ready(CONTROLNET_INPAINT_REPO)


def is_model_ready_fast() -> bool:
    return is_model_ready()


def all_ready() -> bool:
    return is_pip_stack_ready_fast() and is_model_ready() and has_nvidia_gpu()


def all_ready_fast() -> bool:
    return all_ready()


def _emit(on_progress: PrepareProgressCallback | None, pct: float, step: str, detail: str = "") -> None:
    if on_progress is not None:
        on_progress(pct, step, detail)


def install_dependencies(*, on_progress: PrepareProgressCallback | None = None) -> None:
    _emit(on_progress, 2.0, "환경 설치", "Python 3.12 가상환경 확인")
    ensure_venv()
    if is_pip_stack_ready_fast():
        _emit(on_progress, 55.0, "환경 설치", "PyTorch · diffusers · rembg (이미 설치됨 — 건너뜀)")
        return
    bundle = select_torch_bundle()
    _emit(
        on_progress,
        8.0,
        "환경 설치",
        f"PyTorch ({bundle}) 다운로드 중… (~2.5GB, 네트워크에 따라 10~40분)",
    )
    if bundle == "gpu":
        _run_venv_python(
            ["-m", "pip", "install", "torch", "torchvision", "--index-url", TORCH_CUDA_INDEX],
            timeout=3600,
        )
    else:
        _run_venv_python(
            ["-m", "pip", "install", "torch", "torchvision", "--index-url", TORCH_CPU_INDEX],
            timeout=3600,
        )
    _emit(on_progress, 35.0, "환경 설치", "diffusers · rembg · opencv 설치 중… (5~15분)")
    _run_venv_python(
        ["-m", "pip", "install", *MAGIC_CANVAS_PIP_PACKAGES],
        timeout=3600,
    )
    if bundle == "gpu":
        try:
            _run_venv_python(
                ["-m", "pip", "install", "onnxruntime-gpu"],
                timeout=600,
            )
        except Exception:
            pass
    _emit(on_progress, 55.0, "환경 설치", "의존성 설치 완료")


def download_models(*, on_progress: PrepareProgressCallback | None = None) -> None:
    if is_model_ready():
        _emit(on_progress, 100.0, "models", "모델이 이미 준비되어 있습니다.")
        return

    skip_lib = os.environ.get("ITMATZIP_MAGIC_CANVAS_SKIP_LIB", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )
    if not skip_lib:
        _emit(on_progress, 58.0, "모델 다운로드", "library-hub 모델 번들 다운로드 시작")
        try:
            ensure_models_bundle_from_lib(on_progress=on_progress)
            if is_model_ready():
                _emit(on_progress, 100.0, "models", "모델 준비 완료")
                return
        except Exception as exc:
            logger.warning("library-hub model bundle failed: %s", exc)
            _emit(on_progress, 58.0, "모델 다운로드", f"library-hub 실패 — Hugging Face 시도")

    _emit(on_progress, 58.0, "models", "Hugging Face fp16 모델 다운로드")
    env = worker_env()
    proc = subprocess.Popen(
        [str(venv_python()), "-u", "-c", _MODEL_DOWNLOAD_SCRIPT],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        creationflags=no_window_creationflags(),
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("type") == "progress":
            pct = float(msg.get("progress", 0))
            _emit(on_progress, max(58.0, min(98.0, pct)), "models", str(msg.get("message", "")))
        elif msg.get("type") == "error":
            if msg.get("code") == "hf_auth":
                raise RuntimeError(format_hf_auth_error(str(msg.get("repo") or "")))
            detail = str(msg.get("message", "model download failed"))
            if is_hf_auth_error_text(detail):
                raise RuntimeError(format_hf_auth_error(str(msg.get("repo") or "")))
            raise RuntimeError(detail)
    proc.wait(timeout=7200)
    if proc.returncode != 0:
        err = (proc.stderr.read() if proc.stderr else "")[:2000]
        if is_hf_auth_error_text(err):
            repo = CONTROLNET_INPAINT_REPO
            for repo_id, _ in HF_GATED_MODEL_PAGES:
                if repo_id in err:
                    repo = repo_id
                    break
            raise RuntimeError(format_hf_auth_error(repo))
        raise RuntimeError(f"모델 다운로드 실패 (exit {proc.returncode}): {err}")
    if not is_model_ready():
        raise RuntimeError("모델 다운로드 후 캐시 검증에 실패했습니다.")
    _emit(on_progress, 100.0, "models", "모델 준비 완료")


def run_prepare(*, force: bool = False, on_progress: PrepareProgressCallback | None = None) -> None:
    _emit(on_progress, 1.0, "준비", "환경 상태 확인 중…")
    if not force and all_ready_fast():
        _emit(on_progress, 100.0, "ready", "이미 준비되어 있습니다.")
        return
    if not has_nvidia_gpu():
        raise RuntimeError("NVIDIA GPU가 필요합니다. Magic Canvas는 GPU 전용입니다.")
    install_dependencies(on_progress=on_progress)
    download_models(on_progress=on_progress)
