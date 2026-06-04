"""CodeFormer 전용 Python 3.12 venv — library-hub image-enhancer-lib wheel 번들."""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Callable

from common.subprocess_util import no_window_creationflags, run_hidden
from common.runtime_site_packages import TOOL_IMAGE_ENHANCER

logger = logging.getLogger(__name__)

PrepareProgressCallback = Callable[[float, str, str], None]

IMAGE_ENHANCER_LIB_BASE = (
    "https://github.com/infohelpful/library-hub/releases/download/image-enhancer-lib"
)

DEFAULT_CODEFORMER_SOURCE_ZIP_URL = f"{IMAGE_ENHANCER_LIB_BASE}/CodeFormer-master.zip"
DEFAULT_WHEELS_CPU_URL = f"{IMAGE_ENHANCER_LIB_BASE}/codeformer-wheels.zip"
DEFAULT_WHEELS_GPU_PART_URLS = (
    f"{IMAGE_ENHANCER_LIB_BASE}/codeformer-wheels_gpu.zip.001",
    f"{IMAGE_ENHANCER_LIB_BASE}/codeformer-wheels_gpu.zip.002",
)
DEFAULT_CODEFORMER_WEIGHT_URL = f"{IMAGE_ENHANCER_LIB_BASE}/codeformer.pth"
DEFAULT_REALESRGAN_WEIGHT_URL = f"{IMAGE_ENHANCER_LIB_BASE}/RealESRGAN_x2plus.pth"

TORCH_CPU_INDEX = os.environ.get(
    "ITMATZIP_CODEFORMER_TORCH_CPU_INDEX",
    "https://download.pytorch.org/whl/cpu",
)
TORCH_CUDA_INDEX = os.environ.get(
    "ITMATZIP_CODEFORMER_TORCH_CUDA_INDEX",
    "https://download.pytorch.org/whl/cu124",
)

CODEFORMER_PIP_PACKAGES = (
    "basicsr==1.4.2",  # CodeFormer-master는 vendor/basicsr editable 사용 (아래 제외)
    "facexlib==0.3.0",
    "opencv-python-headless>=4.8.0",
    "lmdb",
    "pyyaml",
    "scipy",
    "tqdm",
    "yapf",
    "addict",
    "future",
    "einops",
    "lpips",
    "gdown",
    "scikit-image",
    "requests",
    "numpy>=1.26.0,<3",
    "Pillow>=10.0.0",
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

_torch_probe_cache: tuple[float, dict[str, object]] | None = None


def image_enhancer_root() -> Path:
    return Path(os.environ.get("APPDATA", Path.home() / ".itmatzip")) / "ItMatZip" / "image-enhancer"


def codeformer_venv_dir() -> Path:
    return (image_enhancer_root() / ".venv-codeformer").resolve()


def wheels_cache_dir() -> Path:
    p = image_enhancer_root() / "wheels-cache"
    p.mkdir(parents=True, exist_ok=True)
    return p.resolve()


def wheels_extract_dir(bundle: str) -> Path:
    sub = "gpu" if bundle == "gpu" else "cpu"
    d = wheels_cache_dir() / sub / "wheel"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _config_path() -> Path:
    return image_enhancer_root() / "config.json"


def _load_config() -> dict[str, Any]:
    cfg = _config_path()
    if not cfg.is_file():
        return {}
    try:
        return json.loads(cfg.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_config(update: dict[str, Any]) -> None:
    data = _load_config()
    data.update(update)
    _config_path().parent.mkdir(parents=True, exist_ok=True)
    _config_path().write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _use_offline_wheels() -> bool:
    return os.environ.get("ITMATZIP_CODEFORMER_SKIP_WHEELS", "").strip().lower() not in (
        "1",
        "true",
        "yes",
    )


def _wheels_cpu_url() -> str:
    raw = os.environ.get("ITMATZIP_CODEFORMER_WHEELS_CPU_URL", "").strip()
    if raw:
        return raw
    cfg = _load_config()
    c = str(cfg.get("codeformer_wheels_cpu_url") or "").strip()
    return c or DEFAULT_WHEELS_CPU_URL


def _wheels_gpu_part_urls() -> tuple[str, str]:
    u1 = os.environ.get("ITMATZIP_CODEFORMER_WHEELS_GPU_PART1_URL", "").strip()
    u2 = os.environ.get("ITMATZIP_CODEFORMER_WHEELS_GPU_PART2_URL", "").strip()
    if u1 and u2:
        return u1, u2
    cfg = _load_config()
    c1 = str(cfg.get("codeformer_wheels_gpu_part1_url") or "").strip()
    c2 = str(cfg.get("codeformer_wheels_gpu_part2_url") or "").strip()
    if c1 and c2:
        return c1, c2
    return DEFAULT_WHEELS_GPU_PART_URLS


def _wheel_bundle_marker_path(bundle: str) -> Path:
    return wheels_cache_dir() / ("gpu" if bundle == "gpu" else "cpu") / "bundle_urls.txt"


def _download_http_file(
    url: str,
    dest: Path,
    *,
    message_cb: Callable[[str], None] | None = None,
    label: str = "다운로드",
) -> None:
    headers = {
        "User-Agent": "ItMatZip-Agent-ImageEnhancer/1.0",
        "Accept": "application/octet-stream,*/*",
    }
    token = (
        os.environ.get("ITMATZIP_IMAGE_ENHANCER_LIB_TOKEN", "").strip()
        or os.environ.get("GITHUB_TOKEN", "").strip()
        or os.environ.get("GH_TOKEN", "").strip()
    )
    if token:
        headers["Authorization"] = f"token {token}"
    part = dest.with_suffix(dest.suffix + ".part")
    if message_cb:
        message_cb(f"{label}…")
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=3600) as response:
            total = int(response.headers.get("Content-Length") or 0)
            downloaded = 0
            with part.open("wb") as out:
                while True:
                    chunk = response.read(256 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
                    downloaded += len(chunk)
                    if message_cb and total > 0 and downloaded % (8 * 1024 * 1024) < 256 * 1024:
                        pct = min(100, int(downloaded * 100 / total))
                        mb = downloaded / (1024 * 1024)
                        mb_t = total / (1024 * 1024)
                        message_cb(f"{label} {mb:.0f}/{mb_t:.0f} MB ({pct}%)")
        os.replace(part, dest)
    except (urllib.error.URLError, OSError) as exc:
        part.unlink(missing_ok=True)
        raise RuntimeError(f"{label} 실패: {url}") from exc


def _merge_split_zip_parts(parts: list[Path], dest: Path) -> None:
    with dest.open("wb") as outfile:
        for part in parts:
            if not part.is_file():
                raise FileNotFoundError(f"분할 zip 없음: {part}")
            with part.open("rb") as infile:
                shutil.copyfileobj(infile, outfile, length=16 * 1024 * 1024)


def _verify_zip_archive(path: Path) -> None:
    if not zipfile.is_zipfile(path):
        raise RuntimeError(f"유효한 zip이 아닙니다: {path}")
    with zipfile.ZipFile(path, "r") as zf:
        if zf.testzip() is not None:
            raise RuntimeError(f"손상된 zip: {path}")


def _extract_wheel_archive(archive: Path, dest: Path) -> None:
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
        if artifact.suffix.lower() == ".whl" or artifact.name.endswith(".tar.gz"):
            target = dest / artifact.name
            if target.exists():
                target.unlink()
            shutil.copy2(artifact, target)
    shutil.rmtree(staging, ignore_errors=True)


def _wheel_matches_py312_win(filename: str) -> bool:
    lowered = filename.lower()
    if "py3-none-any" in lowered or "py2.py3-none-any" in lowered:
        return True
    if "abi3" in lowered and "win_amd64" in lowered:
        return True
    return "cp312" in lowered and "win_amd64" in lowered


def _prune_incompatible_wheels(wheel_dir: Path) -> list[str]:
    removed: list[str] = []
    for whl in wheel_dir.glob("*.whl"):
        if not _wheel_matches_py312_win(whl.name):
            removed.append(whl.name)
            whl.unlink(missing_ok=True)  # type: ignore[arg-type]
    return removed


def _wheel_bundle_cache_valid(bundle: str) -> bool:
    wheel_dir = wheels_extract_dir(bundle)
    marker = _wheel_bundle_marker_path(bundle)
    if not marker.is_file():
        return False
    expected = _wheels_cpu_url() if bundle == "cpu" else "\n".join(_wheels_gpu_part_urls())
    if marker.read_text(encoding="utf-8").strip() != expected:
        return False
    return any(wheel_dir.glob("*.whl"))


def ensure_wheels_bundle_extracted(
    bundle: str,
    *,
    on_progress: PrepareProgressCallback | None = None,
    force: bool = False,
) -> Path:
    """library-hub wheel zip 다운로드 → 압축 해제 (CPU 단일 / GPU 분할)."""
    bundle = bundle if bundle in {"cpu", "gpu"} else select_torch_bundle()
    wheel_dir = wheels_extract_dir(bundle)
    cache = wheels_cache_dir() / ("gpu" if bundle == "gpu" else "cpu")

    if not force and _wheel_bundle_cache_valid(bundle):
        _emit(on_progress, 16.0, "wheel 번들", "캐시 사용")
        return wheel_dir

    if force and wheel_dir.is_dir():
        for whl in wheel_dir.glob("*.whl"):
            whl.unlink(missing_ok=True)  # type: ignore[arg-type]

    def msg(text: str) -> None:
        _emit(on_progress, 17.0, "wheel 번들", text)

    if bundle == "cpu":
        zip_path = cache / "codeformer-wheels.zip"
        url = _wheels_cpu_url()
        _download_http_file(url, zip_path, message_cb=msg, label="CodeFormer CPU wheel")
        _verify_zip_archive(zip_path)
        if wheel_dir.exists():
            shutil.rmtree(wheel_dir, ignore_errors=True)
        wheel_dir.mkdir(parents=True, exist_ok=True)
        msg("wheel 압축 해제 중…")
        _extract_wheel_archive(zip_path, wheel_dir)
        _wheel_bundle_marker_path(bundle).write_text(url, encoding="utf-8")
    else:
        parts_dir = cache / "parts"
        parts_dir.mkdir(parents=True, exist_ok=True)
        urls = _wheels_gpu_part_urls()
        part_paths = [parts_dir / f"codeformer-wheels_gpu.zip.{i:03d}" for i in (1, 2)]
        for idx, (url, part_path) in enumerate(zip(urls, part_paths, strict=True), start=1):
            _download_http_file(
                url,
                part_path,
                message_cb=msg,
                label=f"CodeFormer GPU wheel ({idx}/2)",
            )
        msg("wheel zip 병합 중…")
        merged = cache / "codeformer-wheels_gpu.zip"
        _merge_split_zip_parts(part_paths, merged)
        _verify_zip_archive(merged)
        if wheel_dir.exists():
            shutil.rmtree(wheel_dir, ignore_errors=True)
        wheel_dir.mkdir(parents=True, exist_ok=True)
        msg("wheel 압축 해제 중…")
        _extract_wheel_archive(merged, wheel_dir)
        _wheel_bundle_marker_path(bundle).write_text("\n".join(urls), encoding="utf-8")

    pruned = _prune_incompatible_wheels(wheel_dir)
    if pruned:
        logger.info("pruned incompatible wheels: %s", pruned[:5])
    if not any(wheel_dir.glob("*.whl")):
        raise RuntimeError("wheel zip에 .whl 파일이 없습니다.")
    return wheel_dir


def _find_wheel_file(
    wheel_dir: Path,
    package: str,
    *,
    must_contain: tuple[str, ...] = (),
    must_not_contain: tuple[str, ...] = (),
) -> Path:
    prefix = f"{package.lower()}-"
    candidates = [
        p
        for p in wheel_dir.glob("*.whl")
        if p.is_file()
        and p.name.lower().startswith(prefix)
        and _wheel_matches_py312_win(p.name)
    ]
    for token in must_contain:
        candidates = [p for p in candidates if token.lower() in p.name.lower()]
    for token in must_not_contain:
        candidates = [p for p in candidates if token.lower() not in p.name.lower()]
    if not candidates:
        found = ", ".join(sorted(p.name for p in wheel_dir.glob(f"{prefix}*"))[:6]) or "(없음)"
        raise RuntimeError(f"wheel 없음: {package} {must_contain} · 후보: {found}")
    return sorted(candidates, key=lambda p: p.name)[-1]


# torch/torchvision --no-deps 설치 후 wheel 번들에서 맞춰 설치
TORCH_RUNTIME_DEPS = (
    "typing_extensions",
    "sympy",
    "networkx",
    "jinja2",
    "fsspec",
    "filelock",
)


def _pip_uninstall_torch_stack() -> None:
    _run_pip(
        ["uninstall", "-y", "torch", "torchvision", "torchaudio"],
        timeout=600,
    )


def _package_name_from_spec(spec: str) -> str:
    name = spec.strip()
    for sep in ("==", ">=", "<=", "!=", "~=", "<", ">"):
        if sep in name:
            return name.split(sep, 1)[0].strip()
    return name


# PyPI basicsr 1.4.2는 CodeFormer-master inference와 API 불일치 — vendor/basicsr editable 사용
CODEFORMER_PIP_PACKAGES_NO_BASICSR = tuple(
    p for p in CODEFORMER_PIP_PACKAGES if _package_name_from_spec(p) != "basicsr"
)


def _has_wheel_for_package(wheel_dir: Path, package: str) -> bool:
    pkg = package.lower().replace("_", "-")
    return any(
        p.name.lower().startswith(f"{pkg}-") and _wheel_matches_py312_win(p.name)
        for p in wheel_dir.glob("*.whl")
    )


def _opencv_wheel_in_bundle(wheel_dir: Path) -> bool:
    return _has_wheel_for_package(wheel_dir, "opencv-python-headless") or _has_wheel_for_package(
        wheel_dir, "opencv-python"
    )


def _install_torch_runtime_deps_from_wheels(
    wheel_dir: Path,
    on_progress: PrepareProgressCallback | None = None,
) -> None:
    """torch --no-deps 설치 뒤 typing_extensions 등 보완."""
    _emit(on_progress, 24.0, "PyTorch", "런타임 의존성 (typing_extensions 등)")
    failed: list[str] = []
    for pkg in TORCH_RUNTIME_DEPS:
        in_bundle = _has_wheel_for_package(wheel_dir, pkg)
        try:
            # zip에 없으면 PyPI로 보완 (torch/vision 본체만 wheel 고정)
            _pip_install_one(
                pkg,
                wheel_dir=wheel_dir,
                allow_online_fallback=not in_bundle,
            )
        except RuntimeError as exc:
            logger.warning("torch dep install failed for %s: %s", pkg, exc)
            failed.append(pkg)
    if "typing_extensions" in failed:
        raise RuntimeError(
            "typing_extensions 설치 실패. wheel zip에 포함하거나 인터넷 연결 후 "
            "환경 준비를 다시 실행하세요."
        )


def _pip_install_one(
    package: str,
    *,
    wheel_dir: Path | None = None,
    allow_online_fallback: bool = True,
) -> None:
    attempts: list[list[str]] = []
    if wheel_dir and any(wheel_dir.glob("*.whl")):
        attempts.append(["install", "--no-index", "--find-links", str(wheel_dir), package])
        attempts.append(["install", "--no-cache-dir", "--find-links", str(wheel_dir), package])
    if allow_online_fallback:
        attempts.append(["install", "--no-cache-dir", package])

    last_exc: RuntimeError | None = None
    for args in attempts:
        proc = _run_pip(args)
        if proc.returncode == 0:
            return
        last_exc = RuntimeError((proc.stderr or proc.stdout or "pip failed")[-1200:])
    if last_exc is not None:
        raise last_exc
    raise RuntimeError(f"pip install failed: {package}")


def install_pytorch_from_wheels(
    wheel_dir: Path,
    on_progress: PrepareProgressCallback | None = None,
    *,
    bundle: str | None = None,
) -> None:
    bundle = bundle if bundle in {"cpu", "gpu"} else select_torch_bundle()
    label = "GPU(CUDA)" if bundle == "gpu" else "CPU"
    _emit(on_progress, 20.0, "PyTorch", f"library-hub wheel · {label}")

    if bundle == "gpu":
        torch_whl = _find_wheel_file(wheel_dir, "torch", must_contain=("+cu",))
        vision_whl = _find_wheel_file(wheel_dir, "torchvision", must_contain=("+cu",))
    else:
        torch_whl = _find_wheel_file(
            wheel_dir,
            "torch",
            must_not_contain=("+cu124", "+cu128", "+cu"),
        )
        vision_whl = _find_wheel_file(
            wheel_dir,
            "torchvision",
            must_not_contain=("+cu124", "+cu128", "+cu"),
        )

    _pip_uninstall_torch_stack()
    proc = _run_pip(
        [
            "install",
            "--no-index",
            "--force-reinstall",
            "--no-deps",
            str(torch_whl),
            str(vision_whl),
        ],
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "PyTorch wheel 설치 실패: " + (proc.stderr or proc.stdout or "")[-1500:]
        )
    _install_torch_runtime_deps_from_wheels(wheel_dir, on_progress)
    invalidate_torch_probe_cache()
    probe = probe_torch()
    if probe.get("error"):
        raise RuntimeError(f"PyTorch wheel 설치 검증 실패: {probe.get('error')}")
    if bundle == "gpu" and not probe.get("cuda_available"):
        raise RuntimeError(
            "CUDA PyTorch는 설치됐지만 GPU를 사용할 수 없습니다. "
            "NVIDIA 드라이버를 확인한 뒤 환경 준비를 다시 실행하세요."
        )


def _pip_install_codeformer_package(spec: str, wheel_dir: Path) -> None:
    """wheel zip에 있으면 오프라인, 없으면 PyPI 보완 (GPU zip은 torch 위주)."""
    name = _package_name_from_spec(spec)
    if name == "opencv-python-headless":
        in_bundle = _opencv_wheel_in_bundle(wheel_dir)
    else:
        in_bundle = _has_wheel_for_package(wheel_dir, name)
    allow_online = not in_bundle
    try:
        _pip_install_one(spec, wheel_dir=wheel_dir, allow_online_fallback=allow_online)
    except RuntimeError:
        if name != "opencv-python-headless":
            raise
        # headless wheel 없을 때 일반 opencv-python 허용
        _pip_install_one(
            "opencv-python>=4.8.0",
            wheel_dir=wheel_dir,
            allow_online_fallback=True,
        )


def _patch_basicsr_degradations_file(target: Path) -> bool:
    if not target.is_file():
        return False
    text = target.read_text(encoding="utf-8")
    old = "from torchvision.transforms.functional_tensor import rgb_to_grayscale"
    new = (
        "try:\n"
        "    from torchvision.transforms.functional_tensor import rgb_to_grayscale\n"
        "except ImportError:\n"
        "    from torchvision.transforms.functional import rgb_to_grayscale"
    )
    if old not in text:
        return "functional_tensor import rgb_to_grayscale" not in text
    if new in text:
        return True
    target.write_text(text.replace(old, new, 1), encoding="utf-8")
    return True


def patch_basicsr_torchvision_compat(vendor_root: Path | None = None) -> bool:
    """basicsr + torchvision 0.21+ 호환 (functional_tensor 제거 대응)."""
    ok = False
    site = codeformer_venv_dir() / "Lib" / "site-packages" / "basicsr" / "data" / "degradations.py"
    if _patch_basicsr_degradations_file(site):
        ok = True
    if vendor_root is not None:
        vend = vendor_root / "basicsr" / "data" / "degradations.py"
        if _patch_basicsr_degradations_file(vend):
            ok = True
    if ok:
        logger.info("patched basicsr degradations.py for torchvision>=0.18")
    return ok


def patch_vendor_basicsr_package(vendor_root: Path) -> None:
    """CodeFormer zip 내 basicsr — version import·torchvision 패치."""
    basicsr_dir = vendor_root / "basicsr"
    if not basicsr_dir.is_dir():
        raise RuntimeError(f"vendor basicsr 없음: {basicsr_dir}")
    init_py = basicsr_dir / "__init__.py"
    if init_py.is_file():
        text = init_py.read_text(encoding="utf-8")
        old = "from .version import __gitsha__, __version__"
        new = "__version__ = '1.4.2'\n__gitsha__ = ''  # patched by itmatzip-agent"
        if old in text:
            init_py.write_text(text.replace(old, new, 1), encoding="utf-8")
    patch_basicsr_torchvision_compat(vendor_root)


def configure_vendor_basicsr(
    vendor_root: Path,
    on_progress: PrepareProgressCallback | None = None,
) -> None:
    """PyPI basicsr 제거 + vendor basicsr 패치 (inference 시 PYTHONPATH 우선)."""
    _emit(on_progress, 46.0, "basicsr", "CodeFormer vendor basicsr")
    patch_vendor_basicsr_package(vendor_root)
    _run_pip(["uninstall", "-y", "basicsr"], timeout=120)


def codeformer_inference_env(
    vendor_root: Path,
    *,
    agent_package_root: Path | None = None,
) -> dict[str, str]:
    """추론 subprocess — vendor basicsr + venv site-packages (cwd shadow 방지)."""
    env = os.environ.copy()
    env["PYTHONNOUSERSITE"] = "1"
    env["PYTHONSAFEPATH"] = "1"
    site = codeformer_venv_dir() / "Lib" / "site-packages"
    parts: list[str] = [str(vendor_root.resolve())]
    if site.is_dir():
        parts.append(str(site))
    if agent_package_root is not None:
        parts.append(str(agent_package_root.resolve()))
    prev = env.get("PYTHONPATH", "")
    if prev:
        parts.append(prev)
    env["PYTHONPATH"] = os.pathsep.join(parts)
    return env


def install_pip_packages_from_wheels(
    wheel_dir: Path,
    on_progress: PrepareProgressCallback | None = None,
) -> None:
    _emit(on_progress, 38.0, "pip 패키지", "library-hub wheel · PyPI 보완")
    failed: list[str] = []
    for pkg in CODEFORMER_PIP_PACKAGES_NO_BASICSR:
        try:
            _pip_install_codeformer_package(pkg, wheel_dir)
        except RuntimeError as exc:
            logger.warning("pip install failed for %s: %s", pkg, exc)
            failed.append(pkg)
    if failed:
        raise RuntimeError(
            "일부 패키지 설치 실패: " + ", ".join(failed[:6])
            + (" …" if len(failed) > 6 else "")
            + ". 인터넷 연결을 확인하거나 codeformer-wheels.zip에 해당 wheel을 추가하세요."
        )


def install_runtime_dependencies(
    on_progress: PrepareProgressCallback | None = None,
    *,
    bundle: str | None = None,
) -> str:
    """venv + wheel(기본) 또는 온라인 pip."""
    bundle = bundle or select_torch_bundle()
    ensure_venv(on_progress)

    if _use_offline_wheels():
        wheel_dir = ensure_wheels_bundle_extracted(bundle, on_progress=on_progress)
        variant = installed_torch_variant()
        need_torch = not is_torch_installed()
        if bundle == "gpu":
            need_torch = need_torch or not is_cuda_available()
        if variant and variant != bundle:
            need_torch = True
        if need_torch:
            if variant and variant != bundle:
                _emit(on_progress, 22.0, "PyTorch", f"번들 전환 ({variant}→{bundle})")
            install_pytorch_from_wheels(wheel_dir, on_progress, bundle=bundle)
        else:
            _emit(
                on_progress,
                28.0,
                "PyTorch",
                f"이미 설치됨 · {installed_torch_version() or '?'}",
            )
        if not is_pip_stack_ready():
            install_pip_packages_from_wheels(wheel_dir, on_progress)
        else:
            _emit(on_progress, 45.0, "pip 패키지", "basicsr · facexlib 이미 설치됨")
    else:
        if not is_torch_installed():
            install_pytorch(on_progress, bundle=bundle)
        else:
            _emit(
                on_progress,
                28.0,
                "PyTorch",
                f"이미 설치됨 · {installed_torch_version() or '?'}",
            )
        if not is_pip_stack_ready():
            install_pip_packages(on_progress)
        else:
            _emit(on_progress, 45.0, "pip 패키지", "basicsr · facexlib 이미 설치됨")
    return bundle


def _python312_candidates() -> tuple[str, ...]:
    local = os.environ.get("LOCALAPPDATA", "")
    program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
    candidates: list[str] = ["py -3.12"]
    if local:
        candidates.append(str(Path(local) / "Programs/Python/Python312/python.exe"))
    candidates.append(str(Path(program_files) / "Python312/python.exe"))
    candidates.append(r"C:\Python312\python.exe")
    return tuple(candidates)


def find_python312() -> str:
    for cand in _python312_candidates():
        if cand.startswith("py "):
            try:
                proc = run_hidden(
                    cand.split() + ["-c", "import sys; print(sys.executable)"],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                if proc.returncode == 0:
                    exe = (proc.stdout or "").strip().splitlines()[-1].strip()
                    if exe and Path(exe).is_file():
                        return exe
            except Exception:
                continue
        elif Path(cand).is_file():
            return cand
    raise RuntimeError(
        "Python 3.12가 필요합니다. https://www.python.org/downloads/ 에서 3.12를 설치하거나 "
        "'py -3.12'가 동작하는지 확인하세요."
    )


def venv_python() -> Path:
    explicit = os.environ.get("ITMATZIP_CODEFORMER_PYTHON", "").strip()
    if explicit:
        p = Path(explicit)
        if p.is_file():
            return p.resolve()
    py = codeformer_venv_dir() / "Scripts" / "python.exe"
    if not py.is_file():
        raise RuntimeError(
            "CodeFormer 가상환경이 없습니다. Image Enhancer에서 '환경 준비'를 먼저 실행하세요."
        )
    return py


def _venv_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONNOUSERSITE"] = "1"
    env["ITMATZIP_RUNTIME_TOOL"] = TOOL_IMAGE_ENHANCER
    return env


def _run_venv_python(
    args: list[str],
    *,
    cwd: Path | None = None,
    timeout: float = 3600.0,
) -> subprocess.CompletedProcess:
    return run_hidden(
        [str(venv_python()), *args],
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        timeout=timeout,
        creationflags=no_window_creationflags(),
        env=_venv_env(),
    )


def _run_pip(pip_args: list[str], *, timeout: float = 3600.0) -> subprocess.CompletedProcess:
    return _run_venv_python(["-m", "pip", *pip_args], timeout=timeout)


def _emit(on_progress: PrepareProgressCallback | None, pct: float, step: str, detail: str = "") -> None:
    if on_progress is not None:
        on_progress(pct, step, detail)


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


def select_torch_bundle() -> str:
    variant = os.environ.get("ITMATZIP_CODEFORMER_TORCH_VARIANT", "auto").strip().lower()
    if variant == "cpu":
        return "cpu"
    if variant == "gpu":
        return "gpu"
    return "gpu" if has_nvidia_gpu() else "cpu"


def probe_torch(timeout: float = 90.0) -> dict[str, object]:
    try:
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


def _probe_torch_cached(max_age_sec: float = 4.0) -> dict[str, object]:
    global _torch_probe_cache
    now = time.monotonic()
    if _torch_probe_cache is not None and now - _torch_probe_cache[0] < max_age_sec:
        return _torch_probe_cache[1]
    data = probe_torch()
    _torch_probe_cache = (now, data)
    return data


def invalidate_torch_probe_cache() -> None:
    global _torch_probe_cache
    _torch_probe_cache = None


def is_venv_ready_fast() -> bool:
    py = codeformer_venv_dir() / "Scripts" / "python.exe"
    if not py.is_file():
        return False
    site = codeformer_venv_dir() / "Lib" / "site-packages"
    if not site.is_dir():
        return False
    return (site / "torch").is_dir() or any(site.glob("torch*"))


def codeformer_importable(module_name: str, *, vendor_root: Path | None = None) -> bool:
    if module_name == "basicsr" and vendor_root is not None:
        patch_basicsr_torchvision_compat(vendor_root)
    env = _venv_env()
    extra: list[str] = ["-P", "-c", f"import {module_name}"]
    if vendor_root is not None and vendor_root.is_dir():
        env = codeformer_inference_env(vendor_root)
        extra = ["-P", "-c", f"import {module_name}"]
    proc = run_hidden(
        [str(venv_python()), *extra],
        capture_output=True,
        text=True,
        timeout=120,
        creationflags=no_window_creationflags(),
        env=env,
    )
    return proc.returncode == 0


def is_torch_installed() -> bool:
    if not is_venv_ready_fast():
        return False
    probe = _probe_torch_cached()
    return not probe.get("error") and bool(probe.get("version"))


def installed_torch_version() -> str | None:
    probe = _probe_torch_cached()
    ver = probe.get("version")
    return str(ver) if ver else None


def installed_torch_variant() -> str | None:
    probe = _probe_torch_cached()
    variant = probe.get("variant")
    return str(variant) if variant in {"cpu", "gpu"} else None


def is_cuda_available() -> bool:
    if not is_venv_ready_fast():
        return False
    return bool(_probe_torch_cached().get("cuda_available"))


def is_cuda_available_fast() -> bool:
    """readiness용 — 캐시된 torch probe만 사용 (없으면 False)."""
    if not is_venv_ready_fast():
        return False
    probe = _probe_torch_cached(max_age_sec=120.0)
    if probe.get("error") or not probe.get("version"):
        return False
    return bool(probe.get("cuda_available"))


def is_pip_stack_ready_fast(*, vendor_root: Path | None = None) -> bool:
    """readiness용 — subprocess import 없이 디스크만 확인."""
    if not is_venv_ready_fast():
        return False
    site = codeformer_venv_dir() / "Lib" / "site-packages"
    if not site.is_dir():
        return False
    has_basicsr = bool(vendor_root and (vendor_root / "basicsr").is_dir())
    if not has_basicsr:
        has_basicsr = (site / "basicsr").is_dir() or any(site.glob("basicsr*"))
    has_facexlib = (site / "facexlib").is_dir() or any(site.glob("facexlib*"))
    has_cv2 = (site / "cv2").is_dir() or any(site.glob("cv2*"))
    return bool(has_basicsr and has_facexlib and has_cv2)


def is_pip_stack_ready(*, vendor_root: Path | None = None) -> bool:
    if not is_venv_ready_fast():
        return False
    if is_pip_stack_ready_fast() and vendor_root is None:
        return True
    try:
        return (
            codeformer_importable("basicsr", vendor_root=vendor_root)
            and codeformer_importable("facexlib", vendor_root=vendor_root)
            and codeformer_importable("cv2", vendor_root=vendor_root)
        )
    except (OSError, subprocess.TimeoutExpired, RuntimeError) as exc:
        logger.warning("pip stack import check failed: %s", exc)
        return False


def is_venv_ready(*, vendor_root: Path | None = None) -> bool:
    return is_torch_installed() and is_pip_stack_ready(vendor_root=vendor_root)


def ensure_venv(on_progress: PrepareProgressCallback | None = None) -> None:
    venv = codeformer_venv_dir()
    py_exe = venv / "Scripts" / "python.exe"
    if py_exe.is_file() and is_venv_ready_fast():
        _emit(on_progress, 12.0, "가상환경", "이미 존재함")
        return

    py312 = find_python312()
    _emit(on_progress, 8.0, "Python 3.12", py312)
    venv.parent.mkdir(parents=True, exist_ok=True)
    if venv.exists():
        shutil.rmtree(venv, ignore_errors=True)

    _emit(on_progress, 10.0, "가상환경", "venv 생성 중…")
    proc = run_hidden(
        [py312, "-m", "venv", str(venv)],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "venv 생성 실패")[-800:])

    _emit(on_progress, 11.0, "pip", "pip · setuptools · wheel")
    proc = _run_pip(["install", "--upgrade", "pip", "setuptools", "wheel"])
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "pip bootstrap 실패")[-800:])


def install_pytorch(on_progress: PrepareProgressCallback | None = None, *, bundle: str | None = None) -> str:
    bundle = bundle or select_torch_bundle()
    label = "GPU(CUDA)" if bundle == "gpu" else "CPU"
    index = TORCH_CUDA_INDEX if bundle == "gpu" else TORCH_CPU_INDEX
    _emit(on_progress, 14.0, "PyTorch", f"{label} · {index}")
    proc = _run_pip(
        [
            "install",
            "--upgrade",
            "torch",
            "torchvision",
            "--index-url",
            index,
        ],
    )
    if proc.returncode != 0:
        raise RuntimeError("CodeFormer PyTorch 설치 실패: " + (proc.stderr or proc.stdout or "")[-1500:])
    invalidate_torch_probe_cache()
    probe = probe_torch()
    if probe.get("error"):
        raise RuntimeError(f"PyTorch 설치 후 확인 실패: {probe.get('error')}")
    return bundle


def install_pip_packages(on_progress: PrepareProgressCallback | None = None) -> None:
    _emit(on_progress, 38.0, "pip 패키지", "basicsr · facexlib · opencv …")
    proc = _run_pip(["install", "--upgrade", *CODEFORMER_PIP_PACKAGES_NO_BASICSR])
    if proc.returncode != 0:
        raise RuntimeError("CodeFormer pip 설치 실패: " + (proc.stderr or proc.stdout or "")[-1500:])


def install_basicsr_develop(vendor_root: Path, on_progress: PrepareProgressCallback | None = None) -> None:
    """미사용 — basicsr은 wheel/pip으로 설치."""
    _emit(on_progress, 48.0, "basicsr", "wheel 설치 사용 (develop 생략)")


def runtime_status_fast() -> dict[str, Any]:
    py312 = ""
    py_err = ""
    try:
        py312 = find_python312()
    except Exception as exc:
        py_err = str(exc)

    bundle = select_torch_bundle()
    venv_fast = is_venv_ready_fast()
    return {
        "venv_dir": str(codeformer_venv_dir()),
        "python312": py312,
        "python312_error": py_err,
        "venv_ready": venv_fast,
        "torch_ready": venv_fast,
        "pip_stack_ready": is_pip_stack_ready_fast() if venv_fast else False,
        "runtime": "codeformer-3.12-venv",
        "msi_python_bundle": False,
        "library_hub_base": IMAGE_ENHANCER_LIB_BASE,
        "wheels_cpu_url": _wheels_cpu_url(),
        "wheels_gpu_part_urls": list(_wheels_gpu_part_urls()),
        "wheels_bundle_cached": _wheel_bundle_cache_valid(bundle),
        "offline_wheels_enabled": _use_offline_wheels(),
        "planned_torch_bundle": bundle,
    }
