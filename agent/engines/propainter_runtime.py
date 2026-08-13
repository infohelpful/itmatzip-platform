"""ProPainter — MSI engine Python 3.12 + engine-runtime/watermark-remover (library-hub wheels).

prepare = library-hub zip 다운로드 → site-packages 직접 해제 (PyPI pip 없음).
소스·가중치도 watermark-remover-lib 릴리스에서 받는다.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Callable

from common.runtime_site_packages import (
    TOOL_WATERMARK_REMOVER,
    ensure_runtime_tree_acl,
    finalize_runtime_pip,
    purge_runtime_site_entries,
    runtime_site_packages_dir,
    watermark_remover_data_root,
)
from common.subprocess_util import no_window_creationflags, run_hidden

logger = logging.getLogger(__name__)

PrepareProgressCallback = Callable[[float, str, str], None]

WATERMARK_REMOVER_LIB_BASE = (
    "https://github.com/infohelpful/library-hub/releases/download/watermark-remover-lib"
)

DEFAULT_WHEELS_CPU_URL = f"{WATERMARK_REMOVER_LIB_BASE}/propainter-wheels.zip"
DEFAULT_WHEELS_GPU_PART_URLS = (
    f"{WATERMARK_REMOVER_LIB_BASE}/propainter-wheels_gpu.zip.001",
    f"{WATERMARK_REMOVER_LIB_BASE}/propainter-wheels_gpu.zip.002",
)
DEFAULT_SOURCE_ZIP_URL = f"{WATERMARK_REMOVER_LIB_BASE}/propainter-source.zip"
DEFAULT_MODELS_ZIP_URL = f"{WATERMARK_REMOVER_LIB_BASE}/propainter-models.zip"

PROPAINTER_WHEELS_BUNDLE_REVISION = "cp312-propainter-v1"
PROPAINTER_SOURCE_REVISION = "propainter-source-v1"
PROPAINTER_MODELS_REVISION = "propainter-models-v1"

WEIGHT_FILES = (
    ("ProPainter.pth", 20_000_000),
    ("raft-things.pth", 4_000_000),
    ("recurrent_flow_completion.pth", 3_000_000),
)

PROPAINTER_PIP_PACKAGES = (
    "numpy",
    "Pillow",
    "opencv-python-headless",
    "scipy",
    "einops",
    "imageio",
    "imageio-ffmpeg",
    "av",
    "scikit-image",
    "timm",
)

TORCH_RUNTIME_DEPS = (
    "typing_extensions",
    "sympy",
    "mpmath",
    "networkx",
    "jinja2",
    "markupsafe",
    "fsspec",
    "filelock",
)

_RUNTIME_MARKER_DIRS = ("torch", "numpy", "cv2", "PIL", "einops", "scipy")

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


def watermark_remover_root() -> Path:
    return watermark_remover_data_root()


def propainter_site_packages() -> Path:
    return runtime_site_packages_dir(TOOL_WATERMARK_REMOVER)


def propainter_python() -> Path:
    explicit = os.environ.get("ITMATZIP_WATERMARK_REMOVER_PYTHON", "").strip()
    if explicit:
        candidate = Path(explicit)
        if candidate.is_file():
            return candidate.resolve()
    return Path(sys.executable).resolve()


def models_dir() -> Path:
    path = watermark_remover_root() / "models"
    path.mkdir(parents=True, exist_ok=True)
    return path


def source_root() -> Path:
    path = watermark_remover_root() / "propainter-source"
    path.mkdir(parents=True, exist_ok=True)
    return path


def workspace_root() -> Path:
    path = watermark_remover_root() / "workspace"
    path.mkdir(parents=True, exist_ok=True)
    return path


def wheels_cache_dir() -> Path:
    path = watermark_remover_root() / "wheels-cache"
    path.mkdir(parents=True, exist_ok=True)
    return path.resolve()


def wheels_extract_dir(bundle: str) -> Path:
    sub = "gpu" if bundle == "gpu" else "cpu"
    path = wheels_cache_dir() / sub / "wheel"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _config_path() -> Path:
    return watermark_remover_root() / "config.json"


def _load_config() -> dict[str, Any]:
    cfg = _config_path()
    if not cfg.is_file():
        return {}
    try:
        return json.loads(cfg.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _wheels_cpu_url() -> str:
    raw = os.environ.get("ITMATZIP_PROPAINTER_WHEELS_CPU_URL", "").strip()
    if raw:
        return raw
    cfg = str(_load_config().get("propainter_wheels_cpu_url") or "").strip()
    return cfg or DEFAULT_WHEELS_CPU_URL


def _wheels_gpu_part_urls() -> tuple[str, str]:
    part1 = os.environ.get("ITMATZIP_PROPAINTER_WHEELS_GPU_PART1_URL", "").strip()
    part2 = os.environ.get("ITMATZIP_PROPAINTER_WHEELS_GPU_PART2_URL", "").strip()
    if part1 and part2:
        return part1, part2
    cfg = _load_config()
    cfg1 = str(cfg.get("propainter_wheels_gpu_part1_url") or "").strip()
    cfg2 = str(cfg.get("propainter_wheels_gpu_part2_url") or "").strip()
    if cfg1 and cfg2:
        return cfg1, cfg2
    return DEFAULT_WHEELS_GPU_PART_URLS


def _source_zip_url() -> str:
    raw = os.environ.get("ITMATZIP_PROPAINTER_SOURCE_ZIP_URL", "").strip()
    if raw:
        return raw
    cfg = str(_load_config().get("propainter_source_zip_url") or "").strip()
    return cfg or DEFAULT_SOURCE_ZIP_URL


def _models_zip_url() -> str:
    raw = os.environ.get("ITMATZIP_PROPAINTER_MODELS_ZIP_URL", "").strip()
    if raw:
        return raw
    cfg = str(_load_config().get("propainter_models_zip_url") or "").strip()
    return cfg or DEFAULT_MODELS_ZIP_URL


def _emit(
    on_progress: PrepareProgressCallback | None,
    pct: float,
    step: str,
    detail: str = "",
) -> None:
    if on_progress is not None:
        on_progress(pct, step, detail)


def download_http_file(
    url: str,
    dest: Path,
    *,
    message_cb: Callable[[str], None] | None = None,
    label: str = "다운로드",
) -> None:
    headers = {
        "User-Agent": "ItMatZip-Agent-WatermarkRemover/1.0",
        "Accept": "application/octet-stream,*/*",
    }
    token = (
        os.environ.get("ITMATZIP_WATERMARK_REMOVER_LIB_TOKEN", "").strip()
        or os.environ.get("GITHUB_TOKEN", "").strip()
        or os.environ.get("GH_TOKEN", "").strip()
    )
    if token:
        headers["Authorization"] = f"token {token}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_file() and dest.stat().st_size > 0:
        if message_cb:
            message_cb(f"{label} (캐시)")
        return
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
                        mb_total = total / (1024 * 1024)
                        message_cb(f"{label} {mb:.0f}/{mb_total:.0f} MB ({pct}%)")
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
    """cp312/win 또는 플랫폼 독립·win_amd64 pure/abi3 wheel 허용.

    imageio-ffmpeg 등은 ``py3-none-win_amd64`` 태그를 쓰므로
    ``py3-none-any`` 만 보면 잘못 prune 된다.
    """
    lowered = filename.lower()
    if "py3-none-any" in lowered or "py2.py3-none-any" in lowered:
        return True
    if "win_amd64" not in lowered:
        return False
    if "abi3" in lowered or "cp312" in lowered:
        return True
    return "none-win_amd64" in lowered


def _prune_incompatible_wheels(wheel_dir: Path) -> list[str]:
    removed: list[str] = []
    for whl in wheel_dir.glob("*.whl"):
        if not _wheel_matches_py312_win(whl.name):
            removed.append(whl.name)
            whl.unlink(missing_ok=True)
    return removed


def _normalize_marker_text(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n").strip()


def _wheel_bundle_marker_path(bundle: str) -> Path:
    return wheels_cache_dir() / ("gpu" if bundle == "gpu" else "cpu") / "bundle_urls.txt"


def _wheel_bundle_marker_payload(bundle: str) -> str:
    body = _wheels_cpu_url() if bundle == "cpu" else "\n".join(_wheels_gpu_part_urls())
    return f"{PROPAINTER_WHEELS_BUNDLE_REVISION}\n{body}"


def _has_wheel_for_package(wheel_dir: Path, package: str) -> bool:
    pkg = package.lower().replace("_", "-")
    return any(
        p.name.lower().replace("_", "-").startswith(f"{pkg}-")
        and _wheel_matches_py312_win(p.name)
        for p in wheel_dir.glob("*.whl")
    )


def _wheel_bundle_cache_valid(bundle: str) -> bool:
    wheel_dir = wheels_extract_dir(bundle)
    marker = _wheel_bundle_marker_path(bundle)
    if not marker.is_file():
        return False
    if _normalize_marker_text(marker.read_text(encoding="utf-8")) != _normalize_marker_text(
        _wheel_bundle_marker_payload(bundle)
    ):
        return False
    for probe in ("torch", "numpy", "opencv-python-headless", "imageio-ffmpeg"):
        if not _has_wheel_for_package(wheel_dir, probe):
            return False
    return True


def ensure_wheels_bundle_extracted(
    bundle: str,
    *,
    on_progress: PrepareProgressCallback | None = None,
    force: bool = False,
) -> Path:
    bundle = bundle if bundle in {"cpu", "gpu"} else select_torch_bundle()
    wheel_dir = wheels_extract_dir(bundle)
    cache = wheels_cache_dir() / ("gpu" if bundle == "gpu" else "cpu")

    if _wheel_bundle_cache_valid(bundle):
        _emit(on_progress, 16.0, "wheel 번들", "캐시 사용")
        return wheel_dir

    if force and wheel_dir.is_dir():
        for whl in wheel_dir.glob("*.whl"):
            whl.unlink(missing_ok=True)

    def msg(text: str) -> None:
        _emit(on_progress, 17.0, "wheel 번들", text)

    if bundle == "cpu":
        zip_path = cache / "propainter-wheels.zip"
        download_http_file(_wheels_cpu_url(), zip_path, message_cb=msg, label="ProPainter CPU wheel")
        _verify_zip_archive(zip_path)
        if wheel_dir.exists():
            shutil.rmtree(wheel_dir, ignore_errors=True)
        wheel_dir.mkdir(parents=True, exist_ok=True)
        msg("wheel 압축 해제 중…")
        _extract_wheel_archive(zip_path, wheel_dir)
    else:
        parts_dir = cache / "parts"
        parts_dir.mkdir(parents=True, exist_ok=True)
        urls = _wheels_gpu_part_urls()
        part_paths = [parts_dir / f"propainter-wheels_gpu.zip.{i:03d}" for i in (1, 2)]
        for idx, (url, part_path) in enumerate(zip(urls, part_paths, strict=True), start=1):
            download_http_file(
                url,
                part_path,
                message_cb=msg,
                label=f"ProPainter GPU wheel ({idx}/2)",
            )
        msg("wheel zip 병합 중…")
        merged = cache / "propainter-wheels_gpu.zip"
        _merge_split_zip_parts(part_paths, merged)
        _verify_zip_archive(merged)
        if wheel_dir.exists():
            shutil.rmtree(wheel_dir, ignore_errors=True)
        wheel_dir.mkdir(parents=True, exist_ok=True)
        msg("wheel 압축 해제 중…")
        _extract_wheel_archive(merged, wheel_dir)
        merged.unlink(missing_ok=True)

    _wheel_bundle_marker_path(bundle).write_text(
        _wheel_bundle_marker_payload(bundle), encoding="utf-8"
    )
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


def _extract_wheel_into_site(wheel_path: Path, site: Path) -> None:
    if not wheel_path.is_file():
        raise FileNotFoundError(str(wheel_path))
    site.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(wheel_path, "r") as zf:
        zf.extractall(site)


def _wheel_package_key(filename: str) -> str:
    name = filename[:-4] if filename.lower().endswith(".whl") else filename
    name = name.lower().replace("_", "-")
    parts = name.split("-")
    pkg: list[str] = []
    for part in parts:
        if part and part[0].isdigit():
            break
        pkg.append(part)
    return "-".join(pkg) if pkg else (parts[0] if parts else name)


def _pick_best_wheel(wheel_dir: Path, package: str) -> Path | None:
    pkg = package.lower().replace("_", "-").replace(".", "-")
    candidates = [
        whl
        for whl in wheel_dir.glob("*.whl")
        if _wheel_matches_py312_win(whl.name) and _wheel_package_key(whl.name) == pkg
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda p: p.name)
    return candidates[-1]


def _package_name_from_spec(spec: str) -> str:
    name = spec.strip()
    for sep in ("==", ">=", "<=", "!=", "~=", "<", ">"):
        if sep in name:
            return name.split(sep, 1)[0].strip()
    return name


def _install_named_wheels_into_site(
    wheel_dir: Path,
    packages: tuple[str, ...],
    *,
    on_progress: PrepareProgressCallback | None = None,
    progress_pct: float = 24.0,
    label: str = "패키지",
) -> None:
    site = propainter_site_packages()
    missing: list[str] = []
    for pkg in packages:
        whl = _pick_best_wheel(wheel_dir, _package_name_from_spec(pkg))
        if whl is None:
            missing.append(pkg)
            continue
        _emit(on_progress, progress_pct, label, whl.name)
        _extract_wheel_into_site(whl, site)
    if missing:
        raise RuntimeError(
            "wheel 번들에 필수 패키지가 없습니다: "
            + ", ".join(missing)
            + f". library-hub watermark-remover-lib 번들을 갱신하세요. (dir={wheel_dir})"
        )
    finalize_runtime_pip(TOOL_WATERMARK_REMOVER)


def _purge_torch_stack() -> None:
    purge_runtime_site_entries(
        TOOL_WATERMARK_REMOVER, "torch", "torchvision", "torchaudio", "functorch"
    )
    finalize_runtime_pip(TOOL_WATERMARK_REMOVER)


def install_pytorch_from_wheels(
    wheel_dir: Path,
    on_progress: PrepareProgressCallback | None = None,
    *,
    bundle: str | None = None,
) -> None:
    bundle = bundle if bundle in {"cpu", "gpu"} else select_torch_bundle()
    label = "GPU(CUDA)" if bundle == "gpu" else "CPU"
    _emit(on_progress, 20.0, "PyTorch", f"library-hub wheel 해제 · {label}")

    if bundle == "gpu":
        torch_whl = _find_wheel_file(wheel_dir, "torch", must_contain=("+cu",))
        vision_whl = _find_wheel_file(wheel_dir, "torchvision", must_contain=("+cu",))
    else:
        torch_whl = _find_wheel_file(wheel_dir, "torch", must_not_contain=("+cu",))
        vision_whl = _find_wheel_file(wheel_dir, "torchvision", must_not_contain=("+cu",))

    _purge_torch_stack()
    site = propainter_site_packages()
    _extract_wheel_into_site(torch_whl, site)
    _extract_wheel_into_site(vision_whl, site)
    finalize_runtime_pip(TOOL_WATERMARK_REMOVER)
    _emit(on_progress, 24.0, "PyTorch", "런타임 의존성 (typing_extensions 등)")
    _install_named_wheels_into_site(
        wheel_dir,
        TORCH_RUNTIME_DEPS,
        on_progress=on_progress,
        progress_pct=24.0,
        label="PyTorch deps",
    )
    invalidate_torch_probe_cache()
    probe = probe_torch()
    if probe.get("error"):
        raise RuntimeError(f"PyTorch wheel 설치 검증 실패: {probe.get('error')}")
    if bundle == "gpu" and not probe.get("cuda_available"):
        raise RuntimeError(
            "CUDA PyTorch는 설치됐지만 GPU를 사용할 수 없습니다. "
            "NVIDIA 드라이버를 확인한 뒤 환경 준비를 다시 실행하세요."
        )


def install_pip_packages_from_wheels(
    wheel_dir: Path,
    on_progress: PrepareProgressCallback | None = None,
) -> None:
    _emit(on_progress, 38.0, "pip 패키지", "library-hub wheel 해제 (오프라인)")
    required = [_package_name_from_spec(p) for p in PROPAINTER_PIP_PACKAGES]
    missing = [
        name for name in (*required, *TORCH_RUNTIME_DEPS) if not _has_wheel_for_package(wheel_dir, name)
    ]
    if missing:
        raise RuntimeError(
            "불완전한 wheel 번들 — 누락: "
            + ", ".join(sorted(set(missing)))
            + ". library-hub watermark-remover-lib 의 propainter-wheels 를 완전 세트로 교체하세요."
        )

    site = propainter_site_packages()
    skip_prefixes = ("torch-", "torchvision-", "torchaudio-")
    best: dict[str, Path] = {}
    for whl in sorted(wheel_dir.glob("*.whl"), key=lambda p: p.name):
        if not _wheel_matches_py312_win(whl.name):
            continue
        lowered = whl.name.lower().replace("_", "-")
        if any(lowered.startswith(prefix) for prefix in skip_prefixes):
            continue
        best[_wheel_package_key(whl.name)] = whl

    total = len(best)
    for index, (_key, whl) in enumerate(sorted(best.items()), start=1):
        pct = 38.0 + (12.0 * index / max(total, 1))
        _emit(on_progress, pct, "wheel 해제", f"{index}/{total} {whl.name}")
        _extract_wheel_into_site(whl, site)

    finalize_runtime_pip(TOOL_WATERMARK_REMOVER)


_UTILS_MATPLOTLIB_IMPORT = (
    "import matplotlib\n"
    "import matplotlib.patches as patches\n"
    "from matplotlib.path import Path\n"
    "from matplotlib import pyplot as plt\n"
)


def _patch_propainter_source_for_inference(root: Path | None = None) -> None:
    """inference는 matplotlib가 필요 없다. 학습용 get_random_shape 만 쓰므로 lazy import."""
    script = (root or source_root()) / "inference_propainter.py"
    if not script.is_file():
        matches = list((root or source_root()).rglob("inference_propainter.py"))
        if not matches:
            return
        script = matches[0]
    utils = script.parent / "core" / "utils.py"
    if not utils.is_file():
        return
    raw = utils.read_text(encoding="utf-8")
    newline = "\r\n" if "\r\n" in raw else "\n"
    text = raw.replace("\r\n", "\n")
    if "import matplotlib\n" not in text:
        return
    patched = text.replace(_UTILS_MATPLOTLIB_IMPORT, "", 1)
    needle = "def get_random_shape(edge_num=9, ratio=0.7, width=432, height=240):\n"
    lazy = (
        needle
        + "    import matplotlib.patches as patches\n"
        + "    from matplotlib.path import Path\n"
        + "    from matplotlib import pyplot as plt\n"
    )
    body = patched.split("def get_random_shape", 1)[-1][:400] if "def get_random_shape" in patched else ""
    if needle in patched and "import matplotlib.patches as patches" not in body:
        patched = patched.replace(needle, lazy, 1)
    if patched != text:
        utils.write_text(patched.replace("\n", newline), encoding="utf-8")
        logger.info("patched ProPainter core/utils.py to lazy-import matplotlib")


def find_inference_script() -> Path:
    _patch_propainter_source_for_inference()
    direct = source_root() / "inference_propainter.py"
    if direct.is_file():
        return direct
    matches = list(source_root().rglob("inference_propainter.py"))
    return matches[0] if matches else direct


def propainter_cwd() -> Path:
    script = find_inference_script()
    return script.parent if script.is_file() else source_root()


def weight_path(filename: str) -> Path:
    cwd_weights = propainter_cwd() / "weights" / filename
    if cwd_weights.is_file():
        return cwd_weights
    return models_dir() / filename


def is_source_ready() -> bool:
    return find_inference_script().is_file()


def is_weights_ready() -> bool:
    for name, min_bytes in WEIGHT_FILES:
        path = weight_path(name)
        try:
            if not path.is_file() or path.stat().st_size < min_bytes:
                return False
        except OSError:
            return False
    return True


def _site_has(site: Path, name: str) -> bool:
    return (site / name).is_dir() or any(site.glob(f"{name}*"))


def is_runtime_ready_fast() -> bool:
    site = propainter_site_packages()
    if not site.is_dir():
        return False
    return _site_has(site, "torch")


def is_pip_stack_ready_fast() -> bool:
    site = propainter_site_packages()
    if not site.is_dir():
        return False
    return all(_site_has(site, name) for name in _RUNTIME_MARKER_DIRS)


def is_model_ready_fast() -> bool:
    return is_runtime_ready_fast() and is_pip_stack_ready_fast() and is_source_ready() and is_weights_ready()


def runtime_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONNOUSERSITE"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["ITMATZIP_RUNTIME_TOOL"] = TOOL_WATERMARK_REMOVER
    return env


def _run_propainter_python(
    args: list[str],
    *,
    cwd: Path | None = None,
    timeout: float = 900.0,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    from common.runtime_site_packages import engine_python_c_prefix

    merged = runtime_env()
    if env:
        merged.update(env)
    cmd_args = list(args)
    if cmd_args[:1] == ["-c"] and len(cmd_args) >= 2:
        prefix = engine_python_c_prefix(TOOL_WATERMARK_REMOVER)
        if prefix and not str(cmd_args[1]).startswith("import sys; _rt="):
            cmd_args[1] = prefix + str(cmd_args[1])
    return run_hidden(
        [str(propainter_python()), *cmd_args],
        cwd=str(cwd) if cwd else None,
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


def select_torch_bundle() -> str:
    variant = os.environ.get("ITMATZIP_WATERMARK_REMOVER_TORCH_VARIANT", "auto").strip().lower()
    if variant == "cpu":
        return "cpu"
    if variant == "gpu":
        return "gpu"
    return "gpu" if has_nvidia_gpu() else "cpu"


def probe_torch(timeout: float = 90.0) -> dict[str, object]:
    try:
        proc = _run_propainter_python(["-c", _TORCH_PROBE_SCRIPT], timeout=timeout)
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


def is_torch_installed() -> bool:
    if not is_runtime_ready_fast():
        return False
    probe = _probe_torch_cached()
    return not probe.get("error") and bool(probe.get("version"))


def installed_torch_version() -> str | None:
    version = _probe_torch_cached().get("version")
    return str(version) if version else None


def installed_torch_variant() -> str | None:
    variant = _probe_torch_cached().get("variant")
    return str(variant) if variant in {"cpu", "gpu"} else None


def is_cuda_available() -> bool:
    if not is_runtime_ready_fast():
        return False
    return bool(_probe_torch_cached().get("cuda_available"))


def is_cuda_available_fast() -> bool:
    if not is_runtime_ready_fast():
        return False
    probe = _probe_torch_cached(max_age_sec=120.0)
    if probe.get("error") or not probe.get("version"):
        return False
    return bool(probe.get("cuda_available"))


def _source_marker_path() -> Path:
    return source_root() / "source_revision.txt"


def _models_marker_path() -> Path:
    return models_dir() / "models_revision.txt"


def _extract_source_zip(archive: Path, dest: Path) -> None:
    staging = dest / "_extract_staging"
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "r") as zf:
        zf.extractall(staging)
    script = None
    for candidate in staging.rglob("inference_propainter.py"):
        script = candidate
        break
    if script is None:
        shutil.rmtree(staging, ignore_errors=True)
        raise RuntimeError("ProPainter zip에 inference_propainter.py 가 없습니다.")
    inner = script.parent
    dest.mkdir(parents=True, exist_ok=True)
    for child in list(dest.iterdir()):
        if child.name in {"_extract_staging", "source_revision.txt"}:
            continue
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
        else:
            child.unlink(missing_ok=True)
    for item in inner.iterdir():
        target = dest / item.name
        if item.is_dir():
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)
    shutil.rmtree(staging, ignore_errors=True)


def _link_or_copy_weight(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        if dest.resolve() == src.resolve():
            return
        dest.unlink()
    try:
        os.link(src, dest)
    except OSError:
        shutil.copy2(src, dest)


def ensure_source(on_progress: PrepareProgressCallback | None = None) -> Path:
    marker = _source_marker_path()
    if is_source_ready() and marker.is_file():
        if marker.read_text(encoding="utf-8").strip() == PROPAINTER_SOURCE_REVISION:
            _emit(on_progress, 62.0, "ProPainter 소스", "캐시 사용")
            return find_inference_script()

    cache = watermark_remover_root() / "source-cache"
    cache.mkdir(parents=True, exist_ok=True)
    zip_path = cache / "propainter-source.zip"

    def msg(text: str) -> None:
        _emit(on_progress, 63.0, "ProPainter 소스", text)

    download_http_file(_source_zip_url(), zip_path, message_cb=msg, label="ProPainter 소스")
    _verify_zip_archive(zip_path)
    msg("소스 압축 해제 중…")
    _extract_source_zip(zip_path, source_root())
    _patch_propainter_source_for_inference(source_root())
    marker.write_text(PROPAINTER_SOURCE_REVISION, encoding="utf-8")
    script = find_inference_script()
    if not script.is_file():
        raise RuntimeError("ProPainter 소스 해제 후에도 inference 스크립트가 없습니다.")
    return script


def ensure_weights(on_progress: PrepareProgressCallback | None = None) -> None:
    marker = _models_marker_path()
    if is_weights_ready() and marker.is_file():
        if marker.read_text(encoding="utf-8").strip() == PROPAINTER_MODELS_REVISION:
            _emit(on_progress, 78.0, "ProPainter 모델", "캐시 사용")
            cwd_weights = propainter_cwd() / "weights"
            cwd_weights.mkdir(parents=True, exist_ok=True)
            for name, _min in WEIGHT_FILES:
                _link_or_copy_weight(models_dir() / name, cwd_weights / name)
            return

    zip_path = models_dir() / "propainter-models.zip"

    def msg(text: str) -> None:
        _emit(on_progress, 80.0, "ProPainter 모델", text)

    download_http_file(_models_zip_url(), zip_path, message_cb=msg, label="ProPainter 모델")
    _verify_zip_archive(zip_path)
    msg("모델 압축 해제 중…")
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(models_dir())

    cwd_weights = propainter_cwd() / "weights"
    cwd_weights.mkdir(parents=True, exist_ok=True)
    for name, min_bytes in WEIGHT_FILES:
        dest = models_dir() / name
        if not dest.is_file():
            matches = list(models_dir().rglob(name))
            if matches:
                dest = matches[0]
                if dest != models_dir() / name:
                    shutil.copy2(dest, models_dir() / name)
                    dest = models_dir() / name
        if not dest.is_file() or dest.stat().st_size < min_bytes:
            raise RuntimeError(f"모델 파일이 없거나 너무 작습니다: {name}")
        _link_or_copy_weight(dest, cwd_weights / name)

    marker.write_text(PROPAINTER_MODELS_REVISION, encoding="utf-8")
    _emit(on_progress, 92.0, "ProPainter 모델", "가중치 준비 완료")


def ensure_runtime(on_progress: PrepareProgressCallback | None = None) -> None:
    watermark_remover_root().mkdir(parents=True, exist_ok=True)
    workspace_root()
    models_dir()
    source_root()
    site = propainter_site_packages()
    ensure_runtime_tree_acl(TOOL_WATERMARK_REMOVER)
    _emit(on_progress, 10.0, "런타임", f"engine-runtime · {site}")


def install_runtime_dependencies(
    on_progress: PrepareProgressCallback | None = None,
    *,
    bundle: str | None = None,
) -> str:
    bundle = bundle or select_torch_bundle()
    ensure_runtime(on_progress)

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

    if is_pip_stack_ready_fast():
        _emit(on_progress, 45.0, "pip 패키지", "opencv · scipy · einops 이미 설치됨")
    else:
        install_pip_packages_from_wheels(wheel_dir, on_progress)
    return bundle


def download_models(on_progress: PrepareProgressCallback | None = None) -> None:
    ensure_source(on_progress)
    ensure_weights(on_progress)


def is_runtime_ready() -> bool:
    try:
        return is_runtime_ready_fast() and is_pip_stack_ready_fast()
    except Exception:
        return False


def is_model_ready() -> bool:
    return is_runtime_ready() and is_source_ready() and is_weights_ready()


def runtime_status_fast() -> dict[str, Any]:
    bundle = select_torch_bundle()
    ready_fast = is_runtime_ready_fast()
    return {
        "site_packages": str(propainter_site_packages()),
        "python": str(propainter_python()),
        "runtime": "watermark-remover-engine-runtime",
        "runtime_ready": ready_fast,
        "torch_ready": ready_fast,
        "pip_stack_ready": is_pip_stack_ready_fast(),
        "model_ready": is_model_ready_fast(),
        "source_ready": is_source_ready(),
        "weights_ready": is_weights_ready(),
        "msi_python_bundle": True,
        "library_hub_base": WATERMARK_REMOVER_LIB_BASE,
        "wheels_cpu_url": _wheels_cpu_url(),
        "wheels_gpu_part_urls": list(_wheels_gpu_part_urls()),
        "source_zip_url": _source_zip_url(),
        "models_zip_url": _models_zip_url(),
        "planned_torch_bundle": bundle,
        "bundle_revision": PROPAINTER_WHEELS_BUNDLE_REVISION,
        "source_revision": PROPAINTER_SOURCE_REVISION,
    }
