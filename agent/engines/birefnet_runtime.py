"""BiRefNet — MSI engine Python 3.12 + engine-runtime/background-remover (library-hub wheels)."""

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
    TOOL_BACKGROUND_REMOVER,
    ensure_runtime_tree_acl,
    finalize_runtime_pip,
    pip_subprocess_env,
    pip_target_args,
    purge_runtime_site_entries,
    runtime_site_packages_dir,
)
from common.subprocess_util import no_window_creationflags, run_hidden

logger = logging.getLogger(__name__)

PrepareProgressCallback = Callable[[float, str, str], None]

BACKGROUND_REMOVER_LIB_BASE = (
    "https://github.com/infohelpful/library-hub/releases/download/background-remover-lib"
)

DEFAULT_WHEELS_CPU_URL = f"{BACKGROUND_REMOVER_LIB_BASE}/birefnet-wheels.zip"
DEFAULT_WHEELS_GPU_PART_URLS = (
    f"{BACKGROUND_REMOVER_LIB_BASE}/birefnet-wheels_gpu.zip.001",
    f"{BACKGROUND_REMOVER_LIB_BASE}/birefnet-wheels_gpu.zip.002",
)

# BiRefNet 변형 — general(1024) / hr(2048). 코드(.py)와 가중치를 hub에 미러해 오프라인 설치.
MODEL_VARIANTS: tuple[str, ...] = ("general", "hr")
DEFAULT_MODEL_VARIANT = "general"

MODEL_ASSET_URLS: dict[str, dict[str, str]] = {
    "general": {
        "code": f"{BACKGROUND_REMOVER_LIB_BASE}/birefnet-general-code.zip",
        "weights": f"{BACKGROUND_REMOVER_LIB_BASE}/birefnet-general-model.safetensors",
    },
    "hr": {
        "code": f"{BACKGROUND_REMOVER_LIB_BASE}/birefnet-hr-code.zip",
        "weights": f"{BACKGROUND_REMOVER_LIB_BASE}/birefnet-hr-model.safetensors",
    },
}

# 변형별 추론 해상도 (BiRefNet 학습 해상도와 일치해야 품질이 나옴)
MODEL_INPUT_SIZES: dict[str, int] = {"general": 1024, "hr": 2048}

# hub 자산이 같은 파일명으로 교체될 때 캐시 무효화
BIREFNET_WHEELS_BUNDLE_REVISION = "cp312-complete-v1"

BIREFNET_PIP_PACKAGES = (
    "transformers",
    "tokenizers",
    "huggingface-hub",
    "safetensors",
    "timm",
    "kornia",
    "kornia-rs",
    "einops",
    "regex",
    "numpy",
    "Pillow",
    "requests",
    "pyyaml",
    "regex",
    "tqdm",
    "packaging",
)

# torch/torchvision --no-deps 해제 후 번들에서 맞춰 설치
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

# 디스크만 보고 준비 여부를 판단할 때 쓰는 최소 패키지 (import 프로브 없이)
_RUNTIME_MARKER_DIRS = ("torch", "transformers", "timm", "kornia", "einops", "safetensors")

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


def background_remover_root() -> Path:
    return (
        Path(os.environ.get("APPDATA", Path.home() / ".itmatzip"))
        / "ItMatZip"
        / "background-remover"
    )


def birefnet_site_packages() -> Path:
    """pip --target / 추론 site-packages (engine-runtime)."""
    return runtime_site_packages_dir(TOOL_BACKGROUND_REMOVER)


def birefnet_python() -> Path:
    """추론·probe용 실행 파일 — MSI/엔진 python (3.12)."""
    explicit = os.environ.get("ITMATZIP_BACKGROUND_REMOVER_PYTHON", "").strip()
    if explicit:
        candidate = Path(explicit)
        if candidate.is_file():
            return candidate.resolve()
    return Path(sys.executable).resolve()


def hf_home_dir() -> Path:
    """transformers 동적 모듈(trust_remote_code) 캐시 — 사용자 홈 오염 방지."""
    path = background_remover_root() / "hf-home"
    path.mkdir(parents=True, exist_ok=True)
    return path


def models_root() -> Path:
    path = background_remover_root() / "models"
    path.mkdir(parents=True, exist_ok=True)
    return path


def model_dir(variant: str) -> Path:
    return models_root() / normalize_variant(variant)


def normalize_variant(variant: str | None) -> str:
    value = (variant or "").strip().lower()
    if value in MODEL_VARIANTS:
        return value
    return DEFAULT_MODEL_VARIANT


def model_input_size(variant: str) -> int:
    return MODEL_INPUT_SIZES.get(normalize_variant(variant), 1024)


def wheels_cache_dir() -> Path:
    path = background_remover_root() / "wheels-cache"
    path.mkdir(parents=True, exist_ok=True)
    return path.resolve()


def wheels_extract_dir(bundle: str) -> Path:
    sub = "gpu" if bundle == "gpu" else "cpu"
    path = wheels_cache_dir() / sub / "wheel"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _config_path() -> Path:
    return background_remover_root() / "config.json"


def _load_config() -> dict[str, Any]:
    cfg = _config_path()
    if not cfg.is_file():
        return {}
    try:
        return json.loads(cfg.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _wheels_cpu_url() -> str:
    raw = os.environ.get("ITMATZIP_BIREFNET_WHEELS_CPU_URL", "").strip()
    if raw:
        return raw
    cfg = str(_load_config().get("birefnet_wheels_cpu_url") or "").strip()
    return cfg or DEFAULT_WHEELS_CPU_URL


def _wheels_gpu_part_urls() -> tuple[str, str]:
    part1 = os.environ.get("ITMATZIP_BIREFNET_WHEELS_GPU_PART1_URL", "").strip()
    part2 = os.environ.get("ITMATZIP_BIREFNET_WHEELS_GPU_PART2_URL", "").strip()
    if part1 and part2:
        return part1, part2
    cfg = _load_config()
    cfg1 = str(cfg.get("birefnet_wheels_gpu_part1_url") or "").strip()
    cfg2 = str(cfg.get("birefnet_wheels_gpu_part2_url") or "").strip()
    if cfg1 and cfg2:
        return cfg1, cfg2
    return DEFAULT_WHEELS_GPU_PART_URLS


def model_asset_url(variant: str, kind: str) -> str:
    name = normalize_variant(variant)
    env_key = f"ITMATZIP_BIREFNET_{name.upper()}_{kind.upper()}_URL"
    raw = os.environ.get(env_key, "").strip()
    if raw:
        return raw
    cfg = str(_load_config().get(f"birefnet_{name}_{kind}_url") or "").strip()
    return cfg or MODEL_ASSET_URLS[name][kind]


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
        "User-Agent": "ItMatZip-Agent-BackgroundRemover/1.0",
        "Accept": "application/octet-stream,*/*",
    }
    token = (
        os.environ.get("ITMATZIP_BACKGROUND_REMOVER_LIB_TOKEN", "").strip()
        or os.environ.get("GITHUB_TOKEN", "").strip()
        or os.environ.get("GH_TOKEN", "").strip()
    )
    if token:
        headers["Authorization"] = f"token {token}"
    dest.parent.mkdir(parents=True, exist_ok=True)
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
            whl.unlink(missing_ok=True)
    return removed


def _wheel_bundle_marker_path(bundle: str) -> Path:
    return wheels_cache_dir() / ("gpu" if bundle == "gpu" else "cpu") / "bundle_urls.txt"


def _wheel_bundle_marker_payload(bundle: str) -> str:
    body = _wheels_cpu_url() if bundle == "cpu" else "\n".join(_wheels_gpu_part_urls())
    return f"{BIREFNET_WHEELS_BUNDLE_REVISION}\n{body}"


def _normalize_marker_text(text: str) -> str:
    """PowerShell(CRLF)이 쓴 마커와 Python(LF) payload 비교 — 개행 차이로 재다운로드 방지."""
    return text.replace("\r\n", "\n").replace("\r", "\n").strip()


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
    for probe in ("torch", "transformers", "timm", "kornia", "numpy"):
        if not _has_wheel_for_package(wheel_dir, probe):
            return False
    return True


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

    if _wheel_bundle_cache_valid(bundle):
        _emit(on_progress, 16.0, "wheel 번들", "캐시 사용")
        return wheel_dir

    if force and wheel_dir.is_dir():
        for whl in wheel_dir.glob("*.whl"):
            whl.unlink(missing_ok=True)

    def msg(text: str) -> None:
        _emit(on_progress, 17.0, "wheel 번들", text)

    if bundle == "cpu":
        zip_path = cache / "birefnet-wheels.zip"
        download_http_file(_wheels_cpu_url(), zip_path, message_cb=msg, label="BiRefNet CPU wheel")
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
        part_paths = [parts_dir / f"birefnet-wheels_gpu.zip.{i:03d}" for i in (1, 2)]
        for idx, (url, part_path) in enumerate(zip(urls, part_paths, strict=True), start=1):
            download_http_file(
                url,
                part_path,
                message_cb=msg,
                label=f"BiRefNet GPU wheel ({idx}/2)",
            )
        msg("wheel zip 병합 중…")
        merged = cache / "birefnet-wheels_gpu.zip"
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
    """pip 없이 .whl → site-packages 직접 해제 (Vocal Remover·Image Enhancer와 동일)."""
    if not wheel_path.is_file():
        raise FileNotFoundError(str(wheel_path))
    site.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(wheel_path, "r") as zf:
        zf.extractall(site)


def _wheel_package_key(filename: str) -> str:
    """wheel 파일명 → 패키지 키 (kornia_rs 가 kornia 를 덮어쓰지 않도록 버전 앞까지 사용)."""
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
    site = birefnet_site_packages()
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
            + f". library-hub background-remover-lib 번들을 갱신하세요. (dir={wheel_dir})"
        )
    finalize_runtime_pip(TOOL_BACKGROUND_REMOVER)


def _purge_torch_stack() -> None:
    purge_runtime_site_entries(
        TOOL_BACKGROUND_REMOVER, "torch", "torchvision", "torchaudio", "functorch"
    )
    finalize_runtime_pip(TOOL_BACKGROUND_REMOVER)


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
    site = birefnet_site_packages()
    started = time.monotonic()
    _extract_wheel_into_site(torch_whl, site)
    _extract_wheel_into_site(vision_whl, site)
    finalize_runtime_pip(TOOL_BACKGROUND_REMOVER)
    logger.info(
        "extracted torch stack in %.1fs (%s, %s)",
        time.monotonic() - started,
        torch_whl.name,
        vision_whl.name,
    )
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
    """library-hub 완전 wheel 세트 → site-packages 직접 해제 (오프라인)."""
    _emit(on_progress, 38.0, "pip 패키지", "library-hub wheel 해제 (오프라인)")
    required = [_package_name_from_spec(p) for p in BIREFNET_PIP_PACKAGES]
    missing = [name for name in (*required, *TORCH_RUNTIME_DEPS) if not _has_wheel_for_package(wheel_dir, name)]
    if missing:
        raise RuntimeError(
            "불완전한 wheel 번들 — 누락: "
            + ", ".join(sorted(set(missing)))
            + ". library-hub background-remover-lib 의 birefnet-wheels 를 완전 세트로 교체하세요."
        )

    site = birefnet_site_packages()
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

    finalize_runtime_pip(TOOL_BACKGROUND_REMOVER)


def install_runtime_dependencies(
    on_progress: PrepareProgressCallback | None = None,
    *,
    bundle: str | None = None,
) -> str:
    """engine-runtime + library-hub 완전 wheel 번들 (오프라인)."""
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
        _emit(on_progress, 45.0, "pip 패키지", "transformers · timm · kornia 이미 설치됨")
    else:
        install_pip_packages_from_wheels(wheel_dir, on_progress)
    return bundle


def _insert_pip_target(cmd: list[str]) -> list[str]:
    if "install" not in cmd or "--target" in cmd:
        return cmd
    out = list(cmd)
    index = out.index("install") + 1
    flags_with_value = {
        "--find-links",
        "-f",
        "--index-url",
        "-i",
        "--extra-index-url",
        "--constraint",
        "-c",
        "--requirement",
        "-r",
        "--no-binary",
        "--only-binary",
        "--report",
        "--config-settings",
    }
    while index < len(out):
        arg = out[index]
        if arg in flags_with_value and index + 1 < len(out):
            index += 2
            continue
        if arg.startswith("-"):
            index += 1
            continue
        break
    for arg in reversed(pip_target_args(TOOL_BACKGROUND_REMOVER)):
        out.insert(index, arg)
    return out


def _run_pip(pip_args: list[str], *, timeout: float = 3600.0) -> subprocess.CompletedProcess:
    """항상 engine-runtime --target. uninstall 은 runtime purge 로 대체."""
    ensure_runtime_tree_acl(TOOL_BACKGROUND_REMOVER)
    env = pip_subprocess_env({"ITMATZIP_RUNTIME_TOOL": TOOL_BACKGROUND_REMOVER})
    if pip_args and pip_args[0] == "uninstall":
        packages = [a for a in pip_args[1:] if not a.startswith("-") and a != "-y"]
        if packages:
            purge_runtime_site_entries(TOOL_BACKGROUND_REMOVER, *packages)
        finalize_runtime_pip(TOOL_BACKGROUND_REMOVER)
        return subprocess.CompletedProcess(
            args=[sys.executable, "-m", "pip", *pip_args],
            returncode=0,
            stdout="",
            stderr="",
        )

    cmd = _insert_pip_target([sys.executable, "-m", "pip", *pip_args])
    if "--target" not in cmd:
        raise RuntimeError("BiRefNet pip install 에 --target 이 없습니다 (engine 오염 방지)")
    proc = run_hidden(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        creationflags=no_window_creationflags(),
        env=env,
    )
    finalize_runtime_pip(TOOL_BACKGROUND_REMOVER)
    return proc


def runtime_env() -> dict[str, str]:
    """추론 subprocess 공통 env — engine-runtime site-packages + 오프라인 HF."""
    env = os.environ.copy()
    env["PYTHONNOUSERSITE"] = "1"
    # 파이프로 연결된 stdout 은 기본이 로케일 인코딩(cp949)이라 한글 진행 메시지가 깨진다.
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["ITMATZIP_RUNTIME_TOOL"] = TOOL_BACKGROUND_REMOVER
    env["HF_HOME"] = str(hf_home_dir())
    env["HF_HUB_OFFLINE"] = "1"
    env["TRANSFORMERS_OFFLINE"] = "1"
    return env


def _run_birefnet_python(
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
    # Embeddable Python: PYTHONPATH 무시 → -c 앞에 runtime path 주입
    if cmd_args[:1] == ["-c"] and len(cmd_args) >= 2:
        prefix = engine_python_c_prefix(TOOL_BACKGROUND_REMOVER)
        if prefix and not str(cmd_args[1]).startswith("import sys; _rt="):
            cmd_args[1] = prefix + str(cmd_args[1])
    return run_hidden(
        [str(birefnet_python()), *cmd_args],
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
    variant = os.environ.get("ITMATZIP_BIREFNET_TORCH_VARIANT", "auto").strip().lower()
    if variant == "cpu":
        return "cpu"
    if variant == "gpu":
        return "gpu"
    return "gpu" if has_nvidia_gpu() else "cpu"


def probe_torch(timeout: float = 90.0) -> dict[str, object]:
    try:
        proc = _run_birefnet_python(["-c", _TORCH_PROBE_SCRIPT], timeout=timeout)
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


def _site_has(site: Path, name: str) -> bool:
    return (site / name).is_dir() or any(site.glob(f"{name}*"))


def is_runtime_ready_fast() -> bool:
    site = birefnet_site_packages()
    if not site.is_dir():
        return False
    return _site_has(site, "torch")


def is_pip_stack_ready_fast() -> bool:
    """readiness용 — subprocess import 없이 디스크만 확인."""
    site = birefnet_site_packages()
    if not site.is_dir():
        return False
    return all(_site_has(site, name) for name in _RUNTIME_MARKER_DIRS)


def birefnet_importable(module_name: str) -> bool:
    proc = _run_birefnet_python(["-c", f"import {module_name}"], timeout=180)
    return proc.returncode == 0


def is_pip_stack_ready() -> bool:
    if not is_pip_stack_ready_fast():
        return False
    try:
        return all(
            birefnet_importable(name) for name in ("transformers", "timm", "kornia", "einops")
        )
    except (OSError, subprocess.TimeoutExpired, RuntimeError) as exc:
        logger.warning("pip stack import check failed: %s", exc)
        return False


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


def is_runtime_ready() -> bool:
    return is_torch_installed() and is_pip_stack_ready()


def ensure_runtime(on_progress: PrepareProgressCallback | None = None) -> None:
    """engine-runtime/background-remover 준비."""
    background_remover_root().mkdir(parents=True, exist_ok=True)
    site = birefnet_site_packages()
    ensure_runtime_tree_acl(TOOL_BACKGROUND_REMOVER)
    _emit(on_progress, 10.0, "런타임", f"engine-runtime · {site}")
    if is_runtime_ready_fast():
        _emit(on_progress, 12.0, "런타임", "이미 준비됨")
        return
    _emit(on_progress, 11.0, "런타임", str(birefnet_python()))


def runtime_status_fast() -> dict[str, Any]:
    bundle = select_torch_bundle()
    ready_fast = is_runtime_ready_fast()
    return {
        "site_packages": str(birefnet_site_packages()),
        "python": str(birefnet_python()),
        "runtime": "birefnet-engine-runtime",
        "runtime_ready": ready_fast,
        "torch_ready": ready_fast,
        "pip_stack_ready": is_pip_stack_ready_fast(),
        "msi_python_bundle": True,
        "library_hub_base": BACKGROUND_REMOVER_LIB_BASE,
        "wheels_cpu_url": _wheels_cpu_url(),
        "wheels_gpu_part_urls": list(_wheels_gpu_part_urls()),
        "wheels_bundle_cached": _wheel_bundle_cache_valid(bundle),
        "planned_torch_bundle": bundle,
        "bundle_revision": BIREFNET_WHEELS_BUNDLE_REVISION,
    }
