"""Seed-VC — MSI engine Python 3.12 + engine-runtime/voice-changer (library-hub wheels)."""

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
    TOOL_VOICE_CHANGER,
    ensure_runtime_tree_acl,
    finalize_runtime_pip,
    purge_runtime_site_entries,
    runtime_site_packages_dir,
    voice_changer_data_root,
)
from common.subprocess_util import no_window_creationflags, run_hidden

logger = logging.getLogger(__name__)

PrepareProgressCallback = Callable[[float, str, str], None]

VOICE_CHANGER_LIB_BASE = (
    "https://github.com/infohelpful/library-hub/releases/download/voice-changer-lib"
)

DEFAULT_WHEELS_CPU_URL = f"{VOICE_CHANGER_LIB_BASE}/seedvc-wheels.zip"
DEFAULT_WHEELS_GPU_PART_URLS = (
    f"{VOICE_CHANGER_LIB_BASE}/seedvc-wheels_gpu.zip.001",
    f"{VOICE_CHANGER_LIB_BASE}/seedvc-wheels_gpu.zip.002",
)
DEFAULT_SOURCE_ZIP_URL = f"{VOICE_CHANGER_LIB_BASE}/seedvc-source.zip"
DEFAULT_MODELS_ZIP_URL = f"{VOICE_CHANGER_LIB_BASE}/seedvc-models.zip"

SEEDVC_WHEELS_BUNDLE_REVISION = "cp312-seedvc-v3"
SEEDVC_SOURCE_REVISION = "seedvc-source-v1"
SEEDVC_MODELS_REVISION = "seedvc-models-v1"

SEEDVC_CHECKPOINT_NAME = "DiT_seed_v2_uvit_whisper_small_wavenet_bigvgan_pruned.pth"
SEEDVC_CONFIG_NAME = "config_dit_mel_seed_uvit_whisper_small_wavenet.yml"
SEEDVC_CAMPPLUS_NAME = "campplus_cn_common.bin"

# torch/torchvision/torchaudio --no-deps 해제 후 번들에서 맞춰 설치
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
_RUNTIME_MARKER_DIRS = (
    "torch",
    "torchaudio",
    "librosa",
    "transformers",
    "huggingface_hub",
    "einops",
    "munch",
    "soundfile",
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


def voice_changer_root() -> Path:
    return voice_changer_data_root()


def seedvc_site_packages() -> Path:
    """pip --target / 추론 site-packages (engine-runtime)."""
    return runtime_site_packages_dir(TOOL_VOICE_CHANGER)


def seedvc_python() -> Path:
    """추론·probe용 실행 파일 — MSI/엔진 python (3.12)."""
    explicit = os.environ.get("ITMATZIP_VOICE_CHANGER_PYTHON", "").strip()
    if explicit:
        candidate = Path(explicit)
        if candidate.is_file():
            return candidate.resolve()
    return Path(sys.executable).resolve()


def hf_home_dir() -> Path:
    """transformers/HF 캐시 — 사용자 홈 오염 방지."""
    path = voice_changer_root() / "hf-home"
    path.mkdir(parents=True, exist_ok=True)
    return path


def hf_hub_cache_dir() -> Path:
    """Seed-VC inference.py 가 쓰는 HF_HUB_CACHE."""
    path = voice_changer_root() / "checkpoints" / "hf_cache"
    path.mkdir(parents=True, exist_ok=True)
    return path


def source_cache_dir() -> Path:
    path = voice_changer_root() / "seed-vc-source"
    path.mkdir(parents=True, exist_ok=True)
    return path


def workspace_root() -> Path:
    path = voice_changer_root() / "workspace"
    path.mkdir(parents=True, exist_ok=True)
    return path


def models_dir() -> Path:
    path = voice_changer_root() / "models"
    path.mkdir(parents=True, exist_ok=True)
    return path


def checkpoint_path() -> Path:
    direct = models_dir() / SEEDVC_CHECKPOINT_NAME
    if direct.is_file():
        return direct
    matches = list(models_dir().rglob(SEEDVC_CHECKPOINT_NAME))
    return matches[0] if matches else direct


def config_path() -> Path:
    direct = models_dir() / SEEDVC_CONFIG_NAME
    if direct.is_file():
        return direct
    matches = list(models_dir().rglob(SEEDVC_CONFIG_NAME))
    return matches[0] if matches else direct


def campplus_path() -> Path:
    direct = models_dir() / SEEDVC_CAMPPLUS_NAME
    if direct.is_file():
        return direct
    matches = list(models_dir().rglob(SEEDVC_CAMPPLUS_NAME))
    return matches[0] if matches else direct


def wheels_cache_dir() -> Path:
    path = voice_changer_root() / "wheels-cache"
    path.mkdir(parents=True, exist_ok=True)
    return path.resolve()


def wheels_extract_dir(bundle: str) -> Path:
    sub = "gpu" if bundle == "gpu" else "cpu"
    path = wheels_cache_dir() / sub / "wheel"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _config_path() -> Path:
    return voice_changer_root() / "config.json"


def _load_config() -> dict[str, Any]:
    cfg = _config_path()
    if not cfg.is_file():
        return {}
    try:
        return json.loads(cfg.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_config(data: dict[str, Any]) -> None:
    voice_changer_root().mkdir(parents=True, exist_ok=True)
    _config_path().write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _wheels_cpu_url() -> str:
    raw = os.environ.get("ITMATZIP_SEEDVC_WHEELS_CPU_URL", "").strip()
    if raw:
        return raw
    cfg = str(_load_config().get("seedvc_wheels_cpu_url") or "").strip()
    return cfg or DEFAULT_WHEELS_CPU_URL


def _wheels_gpu_part_urls() -> tuple[str, ...]:
    parts: list[str] = []
    for idx in (1, 2, 3, 4):
        raw = os.environ.get(f"ITMATZIP_SEEDVC_WHEELS_GPU_PART{idx}_URL", "").strip()
        if raw:
            parts.append(raw)
    if len(parts) >= 2:
        return tuple(parts)
    cfg = _load_config()
    cfg_parts = [
        str(cfg.get(f"seedvc_wheels_gpu_part{i}_url") or "").strip() for i in (1, 2, 3, 4)
    ]
    cfg_parts = [p for p in cfg_parts if p]
    if len(cfg_parts) >= 2:
        return tuple(cfg_parts)
    return DEFAULT_WHEELS_GPU_PART_URLS


def _source_zip_url() -> str:
    raw = os.environ.get("ITMATZIP_SEEDVC_SOURCE_ZIP_URL", "").strip()
    if raw:
        return raw
    cfg = str(_load_config().get("seedvc_source_zip_url") or "").strip()
    return cfg or DEFAULT_SOURCE_ZIP_URL


def _models_zip_url() -> str:
    raw = os.environ.get("ITMATZIP_SEEDVC_MODELS_ZIP_URL", "").strip()
    if raw:
        return raw
    cfg = str(_load_config().get("seedvc_models_zip_url") or "").strip()
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
        "User-Agent": "ItMatZip-Agent-VoiceChanger/1.0",
        "Accept": "application/octet-stream,*/*",
    }
    token = (
        os.environ.get("ITMATZIP_VOICE_CHANGER_LIB_TOKEN", "").strip()
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


def _extract_zip_to_dir(archive: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "r") as zf:
        zf.extractall(dest)


def _wheel_matches_py312_win(filename: str) -> bool:
    """cp312/win 또는 플랫폼 독립·win_amd64 pure/abi3 wheel 허용.

    soundfile 등은 ``py2.py3-none-win_amd64`` 태그를 쓰므로
    ``py2.py3-none-any`` 만 보면 잘못 prune 된다.
    """
    lowered = filename.lower()
    if "py3-none-any" in lowered or "py2.py3-none-any" in lowered:
        return True
    if "win_amd64" not in lowered:
        return False
    if "abi3" in lowered or "cp312" in lowered:
        return True
    # pure-python Windows wheels: soundfile-*-py2.py3-none-win_amd64.whl
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
    return f"{SEEDVC_WHEELS_BUNDLE_REVISION}\n{body}"


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
    for probe in ("torch", "torchaudio", "librosa", "transformers", "soundfile"):
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
        zip_path = cache / "seedvc-wheels.zip"
        download_http_file(_wheels_cpu_url(), zip_path, message_cb=msg, label="Seed-VC CPU wheel")
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
        part_paths = [
            parts_dir / f"seedvc-wheels_gpu.zip.{i:03d}" for i in range(1, len(urls) + 1)
        ]
        for idx, (url, part_path) in enumerate(zip(urls, part_paths, strict=True), start=1):
            download_http_file(
                url,
                part_path,
                message_cb=msg,
                label=f"Seed-VC GPU wheel ({idx}/{len(urls)})",
            )
        msg("wheel zip 병합 중…")
        merged = cache / "seedvc-wheels_gpu.zip"
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


def _find_seedvc_project_root(extract_root: Path) -> Path | None:
    if (extract_root / "inference.py").is_file() and (extract_root / "modules").is_dir():
        return extract_root
    for child in extract_root.iterdir():
        if child.is_dir() and (child / "inference.py").is_file() and (child / "modules").is_dir():
            return child
    for path in extract_root.rglob("inference.py"):
        parent = path.parent
        if (parent / "modules").is_dir():
            return parent
    return None


def _source_marker_path() -> Path:
    return source_cache_dir() / "source_urls.txt"


def _source_marker_payload() -> str:
    return f"{SEEDVC_SOURCE_REVISION}\n{_source_zip_url()}"


def _source_cache_valid() -> bool:
    marker = _source_marker_path()
    if not marker.is_file():
        return False
    if _normalize_marker_text(marker.read_text(encoding="utf-8")) != _normalize_marker_text(
        _source_marker_payload()
    ):
        return False
    extract_dir = source_cache_dir() / "extracted"
    return _find_seedvc_project_root(extract_dir) is not None


def resolve_seedvc_root(*, force_download: bool = False) -> Path:
    """Seed-VC 소스 루트 — library-hub seedvc-source.zip."""
    cfg = _load_config()
    saved = str(cfg.get("seedvc_root") or "").strip()
    if saved and not force_download:
        candidate = Path(saved)
        if (candidate / "inference.py").is_file() and (candidate / "modules").is_dir():
            return candidate.resolve()

    extract_dir = source_cache_dir() / "extracted"
    if not force_download:
        found = _find_seedvc_project_root(extract_dir) if extract_dir.is_dir() else None
        if found is not None and _source_cache_valid():
            cfg["seedvc_root"] = str(found.resolve())
            _save_config(cfg)
            return found.resolve()

    if force_download and extract_dir.is_dir():
        shutil.rmtree(extract_dir, ignore_errors=True)

    zip_path = source_cache_dir() / "seedvc-source.zip"
    download_http_file(
        _source_zip_url(),
        zip_path,
        label="Seed-VC 소스",
    )
    _verify_zip_archive(zip_path)
    extract_dir.mkdir(parents=True, exist_ok=True)
    _extract_zip_to_dir(zip_path, extract_dir)
    found = _find_seedvc_project_root(extract_dir)
    if found is None:
        raise RuntimeError("Seed-VC 소스에서 inference.py 를 찾지 못했습니다.")
    _source_marker_path().write_text(_source_marker_payload(), encoding="utf-8")
    cfg["seedvc_root"] = str(found.resolve())
    _save_config(cfg)
    return found.resolve()


def is_seedvc_source_ready() -> bool:
    try:
        root = resolve_seedvc_root(force_download=False)
    except Exception:
        return False
    return (root / "inference.py").is_file() and (root / "modules").is_dir()


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


def _install_named_wheels_into_site(
    wheel_dir: Path,
    packages: tuple[str, ...],
    *,
    on_progress: PrepareProgressCallback | None = None,
    progress_pct: float = 24.0,
    label: str = "패키지",
) -> None:
    site = seedvc_site_packages()
    missing: list[str] = []
    for pkg in packages:
        whl = _pick_best_wheel(wheel_dir, pkg)
        if whl is None:
            missing.append(pkg)
            continue
        _emit(on_progress, progress_pct, label, whl.name)
        _extract_wheel_into_site(whl, site)
    if missing:
        raise RuntimeError(
            "wheel 번들에 필수 패키지가 없습니다: "
            + ", ".join(missing)
            + f". library-hub voice-changer-lib 번들을 갱신하세요. (dir={wheel_dir})"
        )
    finalize_runtime_pip(TOOL_VOICE_CHANGER)


def _purge_torch_stack() -> None:
    purge_runtime_site_entries(
        TOOL_VOICE_CHANGER, "torch", "torchvision", "torchaudio", "functorch"
    )
    finalize_runtime_pip(TOOL_VOICE_CHANGER)


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
        audio_whl = _find_wheel_file(wheel_dir, "torchaudio", must_contain=("+cu",))
    else:
        torch_whl = _find_wheel_file(wheel_dir, "torch", must_not_contain=("+cu",))
        vision_whl = _find_wheel_file(wheel_dir, "torchvision", must_not_contain=("+cu",))
        audio_whl = _find_wheel_file(wheel_dir, "torchaudio", must_not_contain=("+cu",))

    _purge_torch_stack()
    site = seedvc_site_packages()
    started = time.monotonic()
    _extract_wheel_into_site(torch_whl, site)
    _extract_wheel_into_site(vision_whl, site)
    _extract_wheel_into_site(audio_whl, site)
    finalize_runtime_pip(TOOL_VOICE_CHANGER)
    logger.info(
        "extracted torch stack in %.1fs (%s, %s, %s)",
        time.monotonic() - started,
        torch_whl.name,
        vision_whl.name,
        audio_whl.name,
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
    required = list(_RUNTIME_MARKER_DIRS)
    missing = [
        name for name in (*required, *TORCH_RUNTIME_DEPS) if not _has_wheel_for_package(wheel_dir, name)
    ]
    if missing:
        raise RuntimeError(
            "불완전한 wheel 번들 — 누락: "
            + ", ".join(sorted(set(missing)))
            + ". library-hub voice-changer-lib 의 seedvc-wheels 를 완전 세트로 교체하세요."
        )

    site = seedvc_site_packages()
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

    finalize_runtime_pip(TOOL_VOICE_CHANGER)


def install_runtime_dependencies(
    on_progress: PrepareProgressCallback | None = None,
    *,
    bundle: str | None = None,
) -> str:
    """engine-runtime + library-hub 완전 wheel 번들 (오프라인)."""
    bundle = bundle or select_torch_bundle()
    ensure_runtime_tree_acl(TOOL_VOICE_CHANGER)
    voice_changer_root().mkdir(parents=True, exist_ok=True)

    _emit(on_progress, 4.0, "Seed-VC 소스", "library-hub 다운로드·압축 해제…")
    root = resolve_seedvc_root(force_download=False)
    _emit(on_progress, 7.0, "Seed-VC 소스", str(root))

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
        _emit(on_progress, 45.0, "pip 패키지", "librosa · transformers · soundfile 이미 설치됨")
    else:
        install_pip_packages_from_wheels(wheel_dir, on_progress)

    finalize_runtime_pip(TOOL_VOICE_CHANGER)
    return bundle


def _models_marker_path() -> Path:
    return models_dir() / "models_urls.txt"


def _models_marker_payload() -> str:
    return f"{SEEDVC_MODELS_REVISION}\n{_models_zip_url()}"


def _models_cache_valid() -> bool:
    marker = _models_marker_path()
    if not marker.is_file():
        return False
    if _normalize_marker_text(marker.read_text(encoding="utf-8")) != _normalize_marker_text(
        _models_marker_payload()
    ):
        return False
    return checkpoint_path().is_file() and config_path().is_file()


def download_models(on_progress: PrepareProgressCallback | None = None) -> None:
    """library-hub seedvc-models.zip → models_dir() (오프라인)."""
    if is_model_ready_fast():
        _emit(on_progress, 90.0, "AI 모델", "이미 다운로드됨")
        return

    _emit(on_progress, 58.0, "AI 모델", "seedvc-models.zip 다운로드…")
    zip_path = models_dir() / "seedvc-models.zip"
    download_http_file(
        _models_zip_url(),
        zip_path,
        message_cb=lambda text: _emit(on_progress, 62.0, "AI 모델", text),
        label="Seed-VC 모델",
    )
    _verify_zip_archive(zip_path)

    staging = models_dir() / "_extract_staging"
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)
    _emit(on_progress, 72.0, "AI 모델", "압축 해제 중…")
    _extract_zip_to_dir(zip_path, staging)

    for artifact in staging.rglob("*"):
        if not artifact.is_file():
            continue
        target = models_dir() / artifact.relative_to(staging)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            target.unlink()
        shutil.copy2(artifact, target)
    shutil.rmtree(staging, ignore_errors=True)

    _models_marker_path().write_text(_models_marker_payload(), encoding="utf-8")

    if not is_model_ready_fast():
        raise RuntimeError(
            f"Seed-VC 모델 설치를 확인할 수 없습니다. "
            f"필요: {SEEDVC_CHECKPOINT_NAME}, {SEEDVC_CONFIG_NAME} in {models_dir()}"
        )
    _emit(on_progress, 92.0, "AI 모델", "다운로드 완료")


def runtime_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """추론 subprocess 공통 env — engine-runtime site-packages + Seed-VC 경로."""
    from common.runtime_site_packages import prepend_runtime_pythonpath
    from common.subprocess_util import agent_subprocess_env

    env = agent_subprocess_env({"ITMATZIP_RUNTIME_TOOL": TOOL_VOICE_CHANGER})
    prepend_runtime_pythonpath(env)
    env["PYTHONNOUSERSITE"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    hf_home = str(hf_home_dir())
    hub_cache = str(hf_hub_cache_dir())
    env["HF_HOME"] = hf_home
    env["HUGGINGFACE_HUB_CACHE"] = hub_cache
    env["HF_HUB_CACHE"] = hub_cache
    env["TRANSFORMERS_CACHE"] = str(Path(hf_home) / "transformers")
    env["TORCH_HOME"] = str(voice_changer_root() / "torch-home")
    Path(env["TORCH_HOME"]).mkdir(parents=True, exist_ok=True)
    try:
        root = resolve_seedvc_root(force_download=False)
        env["ITMATZIP_SEEDVC_ROOT"] = str(root)
    except Exception:
        pass
    ckpt = checkpoint_path()
    if ckpt.is_file():
        env["ITMATZIP_SEEDVC_CHECKPOINT"] = str(ckpt.resolve())
    cfg = config_path()
    if cfg.is_file():
        env["ITMATZIP_SEEDVC_CONFIG"] = str(cfg.resolve())
    campplus = campplus_path()
    if campplus.is_file():
        env["ITMATZIP_SEEDVC_CAMPPLUS"] = str(campplus.resolve())
    if extra:
        env.update(extra)
    return env


def _run_seedvc_python(
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
        prefix = engine_python_c_prefix(TOOL_VOICE_CHANGER)
        if prefix and not str(cmd_args[1]).startswith("import sys; _rt="):
            cmd_args[1] = prefix + str(cmd_args[1])
    return run_hidden(
        [str(seedvc_python()), *cmd_args],
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
    variant = os.environ.get("ITMATZIP_VOICE_CHANGER_TORCH_VARIANT", "auto").strip().lower()
    if variant == "cpu":
        return "cpu"
    if variant == "gpu":
        return "gpu"
    return "gpu" if has_nvidia_gpu() else "cpu"


def probe_torch(timeout: float = 90.0) -> dict[str, object]:
    try:
        proc = _run_seedvc_python(["-c", _TORCH_PROBE_SCRIPT], timeout=timeout)
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


def is_pip_stack_ready_fast() -> bool:
    site = seedvc_site_packages()
    if not site.is_dir():
        return False
    return all(_site_has(site, name) for name in _RUNTIME_MARKER_DIRS)


def seedvc_importable(module_name: str) -> bool:
    proc = _run_seedvc_python(["-c", f"import {module_name}"], timeout=180)
    return proc.returncode == 0


def is_pip_stack_ready() -> bool:
    if not is_pip_stack_ready_fast():
        return False
    try:
        return all(
            seedvc_importable(name)
            for name in ("torchaudio", "librosa", "transformers", "einops", "soundfile")
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


def is_runtime_ready_fast() -> bool:
    site = seedvc_site_packages()
    if not site.is_dir():
        return False
    return _site_has(site, "torch")


def is_runtime_ready() -> bool:
    return is_seedvc_source_ready() and is_torch_installed() and is_pip_stack_ready()


def is_model_ready_fast() -> bool:
    return checkpoint_path().is_file() and config_path().is_file()


def is_model_ready() -> bool:
    if not is_model_ready_fast():
        return False
    return is_runtime_ready()


def ensure_runtime(on_progress: PrepareProgressCallback | None = None) -> None:
    """engine-runtime/voice-changer 준비."""
    voice_changer_root().mkdir(parents=True, exist_ok=True)
    site = seedvc_site_packages()
    ensure_runtime_tree_acl(TOOL_VOICE_CHANGER)
    _emit(on_progress, 10.0, "런타임", f"engine-runtime · {site}")
    if is_runtime_ready_fast():
        _emit(on_progress, 12.0, "런타임", "이미 준비됨")
        return
    _emit(on_progress, 11.0, "런타임", str(seedvc_python()))


def runtime_status_fast() -> dict[str, Any]:
    bundle = select_torch_bundle()
    ready_fast = is_runtime_ready_fast()
    return {
        "tool": TOOL_VOICE_CHANGER,
        "site_packages": str(seedvc_site_packages()),
        "python": str(seedvc_python()),
        "data_root": str(voice_changer_root()),
        "runtime": "voice-changer-engine-runtime",
        "runtime_ready": ready_fast,
        "torch_ready": ready_fast,
        "pip_stack_ready": is_pip_stack_ready_fast(),
        "source_ready": is_seedvc_source_ready(),
        "model_ready": is_model_ready_fast(),
        "msi_python_bundle": True,
        "library_hub_base": VOICE_CHANGER_LIB_BASE,
        "wheels_cpu_url": _wheels_cpu_url(),
        "wheels_gpu_part_urls": list(_wheels_gpu_part_urls()),
        "source_zip_url": _source_zip_url(),
        "models_zip_url": _models_zip_url(),
        "wheels_bundle_cached": _wheel_bundle_cache_valid(bundle),
        "source_cached": _source_cache_valid(),
        "models_cached": _models_cache_valid(),
        "planned_torch_bundle": bundle,
        "bundle_revision": SEEDVC_WHEELS_BUNDLE_REVISION,
        "checkpoint_path": str(checkpoint_path()),
        "config_path": str(config_path()),
        "campplus_path": str(campplus_path()),
    }
