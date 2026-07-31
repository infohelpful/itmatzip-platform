"""ACE-Step 1.5 — MSI engine Python 3.12 + engine-runtime/create-music (library-hub wheels)."""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
import re
from pathlib import Path
from typing import Any, Callable, Optional

from common.subprocess_util import no_window_creationflags, run_hidden
from common.runtime_site_packages import (
    TOOL_CREATE_MUSIC,
    agent_data_root,
    create_music_data_root,
    engine_python_c_prefix,
    ensure_runtime_tree_acl,
    finalize_runtime_pip,
    pip_subprocess_env,
    pip_target_args,
    purge_runtime_site_entries,
    runtime_site_packages_dir,
)

logger = logging.getLogger(__name__)

# ACE-Step 1.5 공식 Windows CUDA 12.8 스택 — +cu128 필수 (완전 wheel 번들)
PYTORCH_CU128_INDEX = "https://download.pytorch.org/whl/cu128"
PYTORCH_CUDA_PACKAGES = (
    "torch==2.7.1+cu128",
    "torchvision==0.22.1+cu128",
    "torchaudio==2.7.1+cu128",
)

FLASH_ATTN_WIN_CP312_CU128 = (
    "https://huggingface.co/lldacing/flash-attention-windows-wheel/resolve/main/"
    "flash_attn-2.7.4.post1+cu128torch2.7.0cxx11abiFALSE-cp312-cp312-win_amd64.whl"
)

CREATE_MUSIC_LIB_BASE = (
    "https://github.com/infohelpful/library-hub/releases/download/Create_Music_Lib"
)
DEFAULT_ACESTEP_SOURCE_ZIP_URL = f"{CREATE_MUSIC_LIB_BASE}/ACE-Step-1.5.zip"
DEFAULT_NANO_VLLM_ZIP_URL = ""
DEFAULT_WHEELS_PART_URLS = (
    f"{CREATE_MUSIC_LIB_BASE}/wheels_create_music.zip.001",
    f"{CREATE_MUSIC_LIB_BASE}/wheels_create_music.zip.002",
)
# Hub zip 교체 시 캐시 무효화 (파일명 동일)
CREATE_MUSIC_WHEELS_BUNDLE_REVISION = "cp312-cu128-complete-v3"

_NANO_VLLM_VERIFY_SCRIPT = """
import importlib.util
import triton  # noqa: F401
import triton.language  # noqa: F401
import nanovllm  # noqa: F401
print("ok")
"""

_TORCH_VERIFY_SCRIPT = """
import sys
import torch
if not hasattr(torch, "_utils"):
    raise RuntimeError("torch._utils missing — broken PyTorch install")
print(torch.__version__)
"""


def _data_root() -> Path:
    return agent_data_root()


def acestep_checkpoints_dir() -> Path:
    env = os.environ.get("ITMATZIP_ACESTEP_CHECKPOINTS", "").strip()
    if env:
        p = Path(env).expanduser()
    else:
        p = create_music_data_root() / "checkpoints"
    p.mkdir(parents=True, exist_ok=True)
    return p.resolve()


def acestep_site_packages() -> Path:
    """pip --target / wheel 해제 대상 (engine-runtime)."""
    return runtime_site_packages_dir(TOOL_CREATE_MUSIC)


def acestep_venv_dir() -> Path:
    """레거시 venv 경로 — prepare 시 purge."""
    return (create_music_data_root() / ".venv-acestep").resolve()


def legacy_acestep_venv_dir() -> Path:
    return acestep_venv_dir()


def purge_legacy_acestep_venv(
    *,
    message_cb: Callable[[str], None] | None = None,
) -> None:
    legacy = legacy_acestep_venv_dir()
    if not legacy.exists():
        return
    if message_cb:
        message_cb("구 .venv-acestep 삭제 중…")
    shutil.rmtree(legacy, ignore_errors=True)


def nano_vllm_cache_dir() -> Path:
    p = create_music_data_root() / "nano-vllm-source"
    p.mkdir(parents=True, exist_ok=True)
    return p.resolve()


def wheels_cache_dir() -> Path:
    p = create_music_data_root() / "wheels-cache"
    p.mkdir(parents=True, exist_ok=True)
    return p.resolve()


def wheels_extract_dir() -> Path:
    d = wheels_cache_dir() / "wheel"
    d.mkdir(parents=True, exist_ok=True)
    return d


def acestep_source_cache_dir() -> Path:
    p = create_music_data_root() / "acestep-source"
    p.mkdir(parents=True, exist_ok=True)
    return p.resolve()


def _create_music_config() -> dict[str, Any]:
    cfg = create_music_data_root() / "config.json"
    if not cfg.is_file():
        return {}
    try:
        return json.loads(cfg.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_create_music_config(update: dict[str, Any]) -> None:
    cfg_path = create_music_data_root() / "config.json"
    data = _create_music_config()
    data.update(update)
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _use_offline_wheels() -> bool:
    return os.environ.get("ITMATZIP_ACESTEP_SKIP_WHEELS", "").strip().lower() not in (
        "1",
        "true",
        "yes",
    )


def _wheels_part_urls() -> tuple[str, str]:
    u1 = os.environ.get("ITMATZIP_ACESTEP_WHEELS_PART1_URL", "").strip()
    u2 = os.environ.get("ITMATZIP_ACESTEP_WHEELS_PART2_URL", "").strip()
    if u1 and u2:
        return u1, u2
    cfg = _create_music_config()
    c1 = str(cfg.get("wheels_create_music_part1_url") or "").strip()
    c2 = str(cfg.get("wheels_create_music_part2_url") or "").strip()
    if c1 and c2:
        return c1, c2
    return DEFAULT_WHEELS_PART_URLS


def _acestep_source_zip_url() -> str:
    raw = os.environ.get("ITMATZIP_ACESTEP_SOURCE_ZIP_URL", "").strip()
    if raw:
        return raw
    cfg = _create_music_config()
    c = str(cfg.get("acestep_source_zip_url") or "").strip()
    if c:
        return c
    return DEFAULT_ACESTEP_SOURCE_ZIP_URL


def _download_http_file(
    url: str,
    dest: Path,
    *,
    message_cb: Callable[[str], None] | None = None,
    label: str = "다운로드",
) -> None:
    headers = {
        "User-Agent": "ItMatZip-Agent-CreateMusic/1.0",
        "Accept": "application/octet-stream,*/*",
    }
    token = (
        os.environ.get("ITMATZIP_CREATE_MUSIC_LIB_TOKEN", "").strip()
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


def _is_valid_acestep_root(path: Path) -> bool:
    return path.is_dir() and (path / "pyproject.toml").is_file() and (path / "acestep").is_dir()


def _find_acestep_project_root(base: Path, *, max_depth: int = 6) -> Path | None:
    """zip 압축 해제 결과에서 ACE-Step 프로젝트 루트(pyproject+acestep) 탐색."""
    if not base.is_dir():
        return None
    if _is_valid_acestep_root(base):
        return base
    if max_depth <= 0:
        return None
    for child in sorted(base.iterdir()):
        if not child.is_dir():
            continue
        found = _find_acestep_project_root(child, max_depth=max_depth - 1)
        if found is not None:
            return found
    return None


def _persist_acestep_root_config(root: Path, zip_url: str) -> None:
    try:
        _save_create_music_config(
            {"acestep_root": str(root.resolve()), "acestep_source_zip_url": zip_url}
        )
    except Exception as exc:
        logger.warning("failed to persist acestep_root config: %s", exc)


def ensure_acestep_source_from_zip(
    *,
    message_cb: Callable[[str], None] | None = None,
    force: bool = False,
) -> Path:
    """ACE-Step 소스 zip 다운로드 후 프로젝트 루트 반환."""
    url = _acestep_source_zip_url()
    cache = acestep_source_cache_dir()
    extract_dir = cache / "extracted"
    marker = cache / "source_url.txt"
    zip_path = cache / "ACE-Step-1.5.zip"

    if not force:
        root = _find_acestep_project_root(extract_dir)
        if root is not None:
            marker.write_text(url, encoding="utf-8")
            _persist_acestep_root_config(root, url)
            return root.resolve()

    need_download = force or not zip_path.is_file()
    if not need_download:
        try:
            _verify_zip_archive(zip_path)
        except RuntimeError as exc:
            logger.warning("cached ACE-Step zip invalid, re-downloading: %s", exc)
            zip_path.unlink(missing_ok=True)
            need_download = True

    if need_download:
        _download_http_file(url, zip_path, message_cb=message_cb, label="ACE-Step 소스 다운로드")
        try:
            _verify_zip_archive(zip_path)
        except RuntimeError as exc:
            zip_path.unlink(missing_ok=True)
            raise RuntimeError(f"다운로드한 ACE-Step zip이 손상되었습니다: {exc}") from exc

    if force and extract_dir.exists():
        shutil.rmtree(extract_dir, ignore_errors=True)
    if not _find_acestep_project_root(extract_dir):
        if extract_dir.exists():
            shutil.rmtree(extract_dir, ignore_errors=True)
        extract_dir.mkdir(parents=True, exist_ok=True)
        if message_cb:
            message_cb("ACE-Step 소스 압축 해제 중…")
        _extract_zip(zip_path, extract_dir)

    root = _find_acestep_project_root(extract_dir)
    if root is None:
        raise RuntimeError(
            f"ACE-Step 소스 루트를 찾을 수 없습니다 ({extract_dir}). "
            "zip 안에 pyproject.toml + acestep 폴더가 있어야 합니다."
        )
    marker.write_text(url, encoding="utf-8")
    _persist_acestep_root_config(root, url)
    return root.resolve()


def _wheel_matches_py312_win(filename: str) -> bool:
    lowered = filename.lower()
    if "py3-none-any" in lowered or "py2.py3-none-any" in lowered:
        return True
    # soundfile 등: py2.py3-none-win_amd64
    if "none-win_amd64" in lowered:
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


def _find_wheel_file(wheel_dir: Path, package: str, *, must_contain: tuple[str, ...] = ()) -> Path:
    prefix = f"{package.lower()}-"
    candidates = [
        p
        for p in wheel_dir.glob("*.whl")
        if p.is_file() and p.name.lower().startswith(prefix) and _wheel_matches_py312_win(p.name)
    ]
    for token in must_contain:
        candidates = [p for p in candidates if token.lower() in p.name.lower()]
    if not candidates:
        found = ", ".join(sorted(p.name for p in wheel_dir.glob("*.whl"))[:8]) or "(없음)"
        raise RuntimeError(f"wheel 없음: {package} {must_contain} · 폴더: {found}")
    return sorted(candidates, key=lambda p: p.name)[-1]


def _wheel_bundle_marker_path() -> Path:
    return wheels_cache_dir() / "bundle_urls.txt"


def _wheel_bundle_marker_payload(urls: tuple[str, str]) -> str:
    return f"{CREATE_MUSIC_WHEELS_BUNDLE_REVISION}\n" + "\n".join(urls)


def _normalize_marker_text(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n").strip()


def _wheel_bundle_cache_valid(urls: tuple[str, str]) -> bool:
    wheel_dir = wheels_extract_dir()
    marker = _wheel_bundle_marker_path()
    if not marker.is_file():
        return False
    if _normalize_marker_text(marker.read_text(encoding="utf-8")) != _normalize_marker_text(
        _wheel_bundle_marker_payload(urls)
    ):
        return False
    try:
        _find_wheel_file(wheel_dir, "torch", must_contain=("cu128", "2.7.1"))
    except RuntimeError:
        return False
    # 완전 번들 최소 검증
    for name in ("transformers", "safetensors", "diffusers", "numpy"):
        if not any(
            p.name.lower().replace("_", "-").startswith(name.replace("_", "-") + "-")
            for p in wheel_dir.glob("*.whl")
        ):
            return False
    return True


def ensure_wheels_bundle_extracted(
    *,
    message_cb: Callable[[str], None] | None = None,
    force: bool = False,
) -> Path:
    """wheels_create_music.zip.001·002 다운로드 → 병합 → 압축 해제.

    force=True 여도 로컬 완전 캐시가 있으면 hub 재다운로드하지 않습니다.
    (site-packages 재설치는 install_*_from_wheels 쪽에서 처리)
    """
    del force  # 캐시 무효일 때만 hub fetch — 유효 캐시 삭제는 금지
    urls = _wheels_part_urls()
    wheel_dir = wheels_extract_dir()
    cache = wheels_cache_dir()

    if _wheel_bundle_cache_valid(urls):
        if message_cb:
            message_cb("wheel 번들 캐시 사용")
        return wheel_dir

    parts_dir = cache / "parts"
    parts_dir.mkdir(parents=True, exist_ok=True)
    part_paths = [parts_dir / f"wheels_create_music.zip.{i:03d}" for i in (1, 2)]

    for idx, (url, part_path) in enumerate(zip(urls, part_paths, strict=True), start=1):
        _download_http_file(
            url,
            part_path,
            message_cb=message_cb,
            label=f"Create Music wheel 다운로드 ({idx}/2)",
        )

    if message_cb:
        message_cb("wheel zip 병합 중…")
    merged = cache / "wheels_create_music.zip"
    _merge_split_zip_parts(part_paths, merged)
    _verify_zip_archive(merged)

    if message_cb:
        message_cb("wheel zip 압축 해제 중…")
    if wheel_dir.exists():
        shutil.rmtree(wheel_dir, ignore_errors=True)
    wheel_dir.mkdir(parents=True, exist_ok=True)
    _extract_wheel_archive(merged, wheel_dir)
    pruned = _prune_incompatible_wheels(wheel_dir)
    if pruned and message_cb:
        message_cb(f"미호환 wheel 제외: {', '.join(pruned[:3])}")

    _wheel_bundle_marker_path().write_text(
        _wheel_bundle_marker_payload(urls), encoding="utf-8"
    )
    return wheel_dir


def _extract_wheel_into_site(wheel_path: Path, site: Path) -> None:
    """pip 없이 .whl → site-packages 직접 해제."""
    if not wheel_path.is_file():
        raise FileNotFoundError(str(wheel_path))
    site.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(wheel_path, "r") as zf:
        zf.extractall(site)


def _pip_uninstall_torch_stack() -> None:
    try:
        _run_pip(["uninstall", "-y", "torch", "torchvision", "torchaudio"], timeout=600)
    except RuntimeError:
        pass
    purge_runtime_site_entries(
        TOOL_CREATE_MUSIC, "torch", "torchvision", "torchaudio", "functorch"
    )


def install_pytorch_from_wheels(
    wheel_dir: Path,
    *,
    force: bool = False,
    message_cb: Callable[[str], None] | None = None,
) -> None:
    del force
    torch_whl = _find_wheel_file(wheel_dir, "torch", must_contain=("cu128", "2.7.1"))
    vision_whl = _find_wheel_file(wheel_dir, "torchvision", must_contain=("cu128",))
    audio_whl = _find_wheel_file(wheel_dir, "torchaudio", must_contain=("cu128",))
    if message_cb:
        message_cb("PyTorch (CUDA) wheel 해제 중…")
    _pip_uninstall_torch_stack()
    site = acestep_site_packages()
    t0 = time.monotonic()
    for whl in (torch_whl, vision_whl, audio_whl):
        if message_cb:
            message_cb(f"해제: {whl.name}")
        _extract_wheel_into_site(whl, site)
    # torch runtime deps from bundle
    for dep in (
        "typing_extensions",
        "sympy",
        "mpmath",
        "networkx",
        "jinja2",
        "markupsafe",
        "fsspec",
        "filelock",
    ):
        for whl in sorted(wheel_dir.glob(f"{dep}-*.whl")) + sorted(
            wheel_dir.glob(f"{dep.replace('-', '_')}-*.whl")
        ):
            if _wheel_matches_py312_win(whl.name):
                _extract_wheel_into_site(whl, site)
                break
    finalize_runtime_pip(TOOL_CREATE_MUSIC)
    logger.info("extracted torch stack in %.1fs", time.monotonic() - t0)
    ok, detail = verify_torch_installation()
    if not ok:
        raise RuntimeError(f"PyTorch wheel 설치 검증 실패: {detail}")


def _package_name_from_spec(spec: str) -> str:
    name = spec.strip()
    for sep in ("==", ">=", "<=", "!=", "~=", "<", ">", "["):
        if sep in name:
            return name.split(sep, 1)[0].strip()
    return name


def _wheel_package_key(filename: str) -> str:
    """wheel 파일명 → 패키지 키.

    modelscope-1.39.0-….whl → modelscope
    modelscope_hub-0.1.8-….whl → modelscope-hub
    (단순 split('-')[0] 은 modelscope_hub 가 modelscope 를 덮어씀)
    """
    name = filename[:-4] if filename.lower().endswith(".whl") else filename
    name = name.lower().replace("_", "-")
    parts = name.split("-")
    pkg: list[str] = []
    for part in parts:
        if part and part[0].isdigit():
            break
        pkg.append(part)
    return "-".join(pkg) if pkg else (parts[0] if parts else name)


def install_runtime_packages_from_wheels(
    wheel_dir: Path,
    *,
    force: bool = False,
    message_cb: Callable[[str], None] | None = None,
) -> None:
    """완전 wheel 세트 → site-packages 직접 해제 (오프라인, PyPI 없음)."""
    del force
    if message_cb:
        message_cb("런타임 library-hub wheel 해제 (오프라인)…")
    site = acestep_site_packages()
    skip_prefixes = (
        "torch-",
        "torchvision-",
        "torchaudio-",
    )
    best: dict[str, Path] = {}
    for whl in sorted(wheel_dir.glob("*.whl"), key=lambda p: p.name):
        if not _wheel_matches_py312_win(whl.name):
            continue
        lowered = whl.name.lower().replace("_", "-")
        if any(lowered.startswith(p) for p in skip_prefixes):
            continue
        pkg_key = _wheel_package_key(whl.name)
        if not pkg_key:
            continue
        best[pkg_key] = whl
    # 필수 패키지 존재 검증
    required_keys = {
        _package_name_from_spec(p).lower().replace("_", "-").split("[", 1)[0]
        for p in ACESTEP_RUNTIME_PACKAGES
    }
    # uvicorn[standard] → uvicorn
    missing = sorted(k for k in required_keys if k not in best and k.replace("-", "") not in {x.replace("-", "") for x in best})
    # soft check: allow aliases
    soft_missing: list[str] = []
    for k in required_keys:
        aliases = {k, k.replace("-", "_")}
        if k == "pyyaml":
            aliases.add("yaml")
        if k == "pillow":
            aliases.add("pil")
        if not any(
            any(b.startswith(a) or b == a for a in aliases)
            for b in best
        ):
            # also check filename start
            if not any(
                p.name.lower().replace("_", "-").startswith(k + "-")
                for p in wheel_dir.glob("*.whl")
            ):
                soft_missing.append(k)
    if soft_missing:
        raise RuntimeError(
            "불완전한 Create Music wheel 번들 — 누락: "
            + ", ".join(soft_missing[:12])
            + ". library-hub Create_Music_Lib 의 wheels_create_music 을 완전 세트로 교체하세요."
        )

    total = len(best)
    for i, (_key, whl) in enumerate(sorted(best.items()), start=1):
        if message_cb and (i == 1 or i == total or i % 5 == 0):
            message_cb(f"wheel 해제 {i}/{total}: {whl.name}")
        _extract_wheel_into_site(whl, site)
    finalize_runtime_pip(TOOL_CREATE_MUSIC)


def _runtime_wheel_dir() -> Path | None:
    d = wheels_extract_dir()
    if d.is_dir() and any(d.glob("*.whl")):
        return d
    return None


_MODEL_DOWNLOAD_IMPORT_CHECK = """
import importlib
for name in ("huggingface_hub", "modelscope", "loguru"):
    importlib.import_module(name)
print("ok")
"""

_RUNTIME_IMPORT_CHECK = """
import importlib
import warnings
warnings.filterwarnings("ignore", message="Failed to find CUDA")
mods = (
    "loguru",
    "transformers",
    "diffusers",
    "safetensors",
    "soundfile",
    "huggingface_hub",
    "modelscope",
    "modelscope_hub",
    "einops",
)
missing = []
for name in mods:
    try:
        importlib.import_module(name)
    except ImportError:
        missing.append(name)
if missing:
    raise SystemExit("missing: " + ", ".join(missing))
print("ok")
"""


def verify_model_download_packages() -> tuple[bool, str]:
    try:
        acestep_python()
    except RuntimeError as exc:
        return False, str(exc)
    proc = _run_acestep_python(["-c", _MODEL_DOWNLOAD_IMPORT_CHECK], timeout=60)
    if proc.returncode == 0:
        return True, ""
    detail = (proc.stderr or proc.stdout or "model download import check failed").strip()
    # triton CUDA UserWarning 등은 stderr 에 섞여 본 오류를 가림
    lines = [
        ln
        for ln in detail.splitlines()
        if "UserWarning" not in ln and "warnings.warn" not in ln and "Failed to find CUDA" not in ln
    ]
    cleaned = "\n".join(lines).strip() or detail
    return False, cleaned[-500:]


# HF / ModelScope 가중치 다운로드에 필수 (wheel 번들에 없을 수 있음)
ACESTEP_MODEL_DOWNLOAD_PACKAGES = (
    "huggingface_hub>=0.26.0",
    "modelscope>=1.22.0",
    "loguru>=0.7.3",
)


def ensure_model_download_packages(
    *,
    wheel_dir: Path | None = None,
    force: bool = False,
    message_cb: Callable[[str], None] | None = None,
) -> None:
    """가중치 다운로드 전 huggingface_hub · modelscope · loguru — 번들 wheel만."""
    ok, _ = verify_model_download_packages()
    if ok and not force:
        return
    wheel_dir = wheel_dir or _runtime_wheel_dir()
    if wheel_dir is None:
        raise RuntimeError(
            "모델 다운로드용 wheel 번들이 없습니다. Create_Music_Lib wheels를 준비한 뒤 "
            "환경 준비를 다시 실행하세요."
        )
    if message_cb:
        message_cb("모델 다운로드용 패키지 wheel 해제…")
    install_runtime_packages_from_wheels(wheel_dir, force=force, message_cb=message_cb)
    ok, detail = verify_model_download_packages()
    if not ok:
        raise RuntimeError(f"모델 다운로드 의존성 설치 실패: {detail}")


def verify_runtime_packages() -> tuple[bool, str]:
    try:
        py = acestep_python()
    except RuntimeError as exc:
        return False, str(exc)
    proc = _run_acestep_python(["-c", _RUNTIME_IMPORT_CHECK], timeout=120)
    if proc.returncode == 0:
        return True, ""
    detail = (proc.stderr or proc.stdout or "runtime import check failed").strip()
    lines = [
        ln
        for ln in detail.splitlines()
        if "UserWarning" not in ln
        and "warnings.warn" not in ln
        and "Failed to find CUDA" not in ln
    ]
    cleaned = "\n".join(lines).strip() or detail
    return False, cleaned[-500:]


def ensure_runtime_packages(
    *,
    wheel_dir: Path | None = None,
    force: bool = False,
    message_cb: Callable[[str], None] | None = None,
) -> None:
    """ACE-Step 런타임 의존성 — library-hub 완전 wheel만 (PyPI 없음)."""
    if not _use_offline_wheels():
        raise RuntimeError(
            "Create Music는 library-hub wheel 번들 설치만 지원합니다. "
            "ITMATZIP_ACESTEP_SKIP_WHEELS 를 끄세요."
        )
    wheel_dir = wheel_dir or ensure_wheels_bundle_extracted(message_cb=message_cb)
    ok, _ = verify_runtime_packages()
    if ok and not force:
        if message_cb:
            message_cb("런타임 패키지 이미 설치됨")
        return
    install_runtime_packages_from_wheels(wheel_dir, force=force, message_cb=message_cb)
    ok, detail = verify_runtime_packages()
    if not ok:
        raise RuntimeError(f"런타임 의존성 설치 실패: {detail}")


def install_create_music_wheels_bundle(
    *,
    force: bool = False,
    message_cb: Callable[[str], None] | None = None,
) -> Path:
    """library-hub wheel 번들 → site-packages 해제."""
    wheel_dir = ensure_wheels_bundle_extracted(message_cb=message_cb, force=force)
    need_torch = force or not verify_torch_installation()[0]
    if need_torch:
        install_pytorch_from_wheels(wheel_dir, force=force, message_cb=message_cb)
    elif message_cb:
        message_cb("PyTorch 이미 설치됨 — 건너뜀")
    ensure_runtime_packages(wheel_dir=wheel_dir, force=force, message_cb=message_cb)
    return wheel_dir


def _nano_vllm_zip_url() -> str:
    for key in ("ITMATZIP_NANO_VLLM_ZIP_URL", "NANO_VLLM_ZIP_URL"):
        raw = os.environ.get(key, "").strip()
        if raw:
            return raw
    cfg = str(_create_music_config().get("nano_vllm_zip_url") or "").strip()
    if cfg:
        return cfg
    return DEFAULT_NANO_VLLM_ZIP_URL


def _find_nano_vllm_package_root(base: Path) -> Path | None:
    """압축 해제 루트 또는 하위 폴더에서 pip install -e 대상 찾기."""
    if not base.is_dir():
        return None
    if (base / "pyproject.toml").is_file():
        return base
    for child in sorted(base.iterdir()):
        if child.is_dir() and (child / "pyproject.toml").is_file():
            return child
    return None


def _download_nano_vllm_zip(url: str, dest: Path, *, message_cb: Callable[[str], None] | None = None) -> None:
    headers = {
        "User-Agent": "ItMatZip-Agent-CreateMusic/1.0",
        "Accept": "application/octet-stream,*/*",
    }
    token = (
        os.environ.get("ITMATZIP_NANO_VLLM_ZIP_TOKEN", "").strip()
        or os.environ.get("GITHUB_TOKEN", "").strip()
        or os.environ.get("GH_TOKEN", "").strip()
    )
    if token:
        headers["Authorization"] = f"token {token}"
    part = dest.with_suffix(dest.suffix + ".part")
    if message_cb:
        message_cb("nano-vllm zip 다운로드 중…")
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            with part.open("wb") as out:
                while True:
                    chunk = response.read(256 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
        os.replace(part, dest)
    except (urllib.error.URLError, OSError) as exc:
        part.unlink(missing_ok=True)
        raise RuntimeError(f"nano-vllm zip 다운로드 실패: {url}") from exc


def _extract_zip(zip_path: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(out_dir)
    except zipfile.BadZipFile as exc:
        raise RuntimeError(f"zip 압축 해제 실패 ({zip_path}): {exc}") from exc


def ensure_nano_vllm_from_zip(
    url: str,
    *,
    message_cb: Callable[[str], None] | None = None,
    force: bool = False,
) -> Path:
    """GitHub 등에 올린 nano-vllm.zip 다운로드 후 캐시에 압축 해제."""
    cache = nano_vllm_cache_dir()
    extract_dir = cache / "extracted"
    marker = cache / "source_url.txt"
    zip_path = cache / "nano-vllm.zip"

    if not force and marker.is_file() and marker.read_text(encoding="utf-8").strip() == url:
        root = _find_nano_vllm_package_root(extract_dir)
        if root is not None:
            return root

    if extract_dir.is_dir():
        shutil.rmtree(extract_dir, ignore_errors=True)
    extract_dir.mkdir(parents=True, exist_ok=True)

    _download_nano_vllm_zip(url, zip_path, message_cb=message_cb)
    if message_cb:
        message_cb("nano-vllm zip 압축 해제 중…")
    _extract_zip(zip_path, extract_dir)

    root = _find_nano_vllm_package_root(extract_dir)
    if root is None:
        raise RuntimeError(
            f"nano-vllm 패키지 루트를 찾을 수 없습니다 ({extract_dir}). "
            "zip 안에 pyproject.toml 이 있는 nano-vllm 폴더가 있어야 합니다."
        )
    marker.write_text(url, encoding="utf-8")
    return root


def resolve_nano_vllm_dir(
    acestep_root: Path | None = None,
    *,
    message_cb: Callable[[str], None] | None = None,
) -> Path:
    """
    nano-vllm 소스 경로 (우선순위):
    1) ITMATZIP_NANO_VLLM_DIR
    2) ProgramData 캐시 (이전 zip 설치)
    3) ACE-Step 번들 third_parts/nano-vllm
    4) ITMATZIP_NANO_VLLM_ZIP_URL / config nano_vllm_zip_url
    """
    override = os.environ.get("ITMATZIP_NANO_VLLM_DIR", "").strip()
    if override:
        p = Path(override).expanduser().resolve()
        root = _find_nano_vllm_package_root(p)
        if root is None:
            raise FileNotFoundError(f"ITMATZIP_NANO_VLLM_DIR 에 pyproject.toml 없음: {p}")
        return root

    cache = nano_vllm_cache_dir() / "extracted"
    root = _find_nano_vllm_package_root(cache)
    if root is not None:
        return root

    acestep_root = acestep_root or resolve_acestep_root()
    # ACE-Step 소스에 번들된 nano-vllm 우선 탐색 (폴더명이 버전마다 다를 수 있음)
    bundled_candidates = (
        acestep_root / "acestep" / "third_parts" / "nano-vllm",
        acestep_root / "acestep" / "third_part" / "nano-vllm",
        acestep_root / "acestep" / "third_party" / "nano-vllm",
        acestep_root / "acestep" / "third-party" / "nano-vllm",
    )
    for cand in bundled_candidates:
        root = _find_nano_vllm_package_root(cand)
        if root is not None:
            return root

    zip_url = _nano_vllm_zip_url()
    if zip_url:
        try:
            return ensure_nano_vllm_from_zip(zip_url, message_cb=message_cb)
        except Exception as exc:
            raise FileNotFoundError(f"nano-vllm zip 다운로드 실패: {zip_url} ({exc})") from exc

    raise FileNotFoundError(
        "nano-vllm 소스를 찾을 수 없습니다. 환경 준비로 zip 다운로드를 시도하거나 "
        "ACE-Step third_parts/nano-vllm, ITMATZIP_NANO_VLLM_DIR 을 확인하세요."
    )


def _engines_dir() -> Path:
    return Path(__file__).resolve().parent


def resolve_acestep_root(
    *,
    message_cb: Callable[[str], None] | None = None,
    force_download: bool = False,
) -> Path:
    """ACE-Step 소스 루트 (acestep 패키지 + pyproject.toml)."""
    for key in ("ITMATZIP_ACESTEP_ROOT", "ACESTEP_PROJECT_ROOT"):
        raw = os.environ.get(key, "").strip()
        if not raw:
            continue
        p = Path(raw).expanduser().resolve()
        if _is_valid_acestep_root(p):
            return p
        logger.warning("%s is set but not a valid ACE-Step root: %s", key, p)

    cfg = _create_music_config()
    raw = str(cfg.get("acestep_root") or "").strip()
    if raw:
        p = Path(raw).expanduser().resolve()
        if _is_valid_acestep_root(p):
            return p
        logger.warning("stale acestep_root in config.json, ignoring: %s", p)
        try:
            _save_create_music_config({"acestep_root": ""})
        except Exception:
            pass

    extract_dir = acestep_source_cache_dir() / "extracted"
    cached = _find_acestep_project_root(extract_dir)
    if cached is not None:
        _persist_acestep_root_config(cached, _acestep_source_zip_url())
        return cached.resolve()

    url = _acestep_source_zip_url()
    try:
        return ensure_acestep_source_from_zip(
            message_cb=message_cb,
            force=force_download,
        )
    except Exception as exc:
        cache = acestep_source_cache_dir()
        raise FileNotFoundError(
            "ACE-Step 소스를 자동으로 준비하지 못했습니다. "
            f"원인: {exc}. "
            f"캐시 경로: {cache}. "
            f"소스 zip URL 접근·방화벽·프록시를 확인하거나, "
            f"환경 준비 완료 후 ITMATZIP_ACESTEP_ROOT 를 설정하세요. ({url})"
        ) from exc


def find_python312() -> str:
    """MSI engine / 현재 인터프리터 (3.12)."""
    return str(acestep_python())


def acestep_python() -> Path:
    """추론·probe용 — MSI engine python."""
    explicit = os.environ.get("ITMATZIP_ACESTEP_PYTHON", "").strip()
    if explicit:
        p = Path(explicit)
        if p.is_file():
            return p.resolve()
    return Path(sys.executable).resolve()


def venv_python() -> Path:
    """하위 호환 alias → acestep_python()."""
    return acestep_python()


def is_nano_vllm_ready() -> bool:
    """로컬 nano-vllm + Triton (선택)."""
    if not is_venv_ready_fast():
        return False
    env = _acestep_env(lm_backend="pt")
    proc = _run_acestep_python(
        ["-c", _NANO_VLLM_VERIFY_SCRIPT],
        timeout=120,
        env=env,
        include_nano=True,
    )
    return proc.returncode == 0


def resolve_lm_backend(*, prefer_vllm: bool = False) -> str:
    """
    LM 백엔드: auto(기본) | pt | vllm
    ITMATZIP_ACESTEP_LM_BACKEND 환경 변수로 강제 가능.
    """
    pref = os.environ.get("ITMATZIP_ACESTEP_LM_BACKEND", "auto").strip().lower()
    if pref == "pt":
        return "pt"
    if pref == "vllm":
        return "vllm" if is_nano_vllm_ready() else "pt"
    # auto
    if prefer_vllm and is_nano_vllm_ready():
        return "vllm"
    return "pt"


def _acestep_env(extra: Optional[dict[str, str]] = None, *, lm_backend: str = "pt") -> dict[str, str]:
    ckpt = str(acestep_checkpoints_dir())
    base = os.environ.copy()
    try:
        from common.bin_manager import ensure_ffmpeg, prepend_ffmpeg_bin_to_env

        ensure_ffmpeg()
        prepend_ffmpeg_bin_to_env(base)
    except Exception as exc:
        logger.warning("ffmpeg PATH not added to acestep env: %s", exc)
    root = ""
    try:
        root = str(resolve_acestep_root())
    except Exception:
        root = ""
    env = {
        "ACESTEP_CHECKPOINTS_DIR": ckpt,
        "ITMATZIP_ACESTEP_CHECKPOINTS": ckpt,
        "ITMATZIP_RUNTIME_TOOL": TOOL_CREATE_MUSIC,
        "PYTHONNOUSERSITE": "1",
        "PYTHONSAFEPATH": "1",
        "ACESTEP_DISABLE_TQDM": "1",
        "HF_HUB_DISABLE_PROGRESS_BARS": "0",
        "ACESTEP_LM_BACKEND": lm_backend,
    }
    if root:
        env["ACESTEP_PROJECT_ROOT"] = root
        env["ITMATZIP_ACESTEP_ROOT"] = root
    site = str(acestep_site_packages())
    parts = [site]
    if root:
        parts.insert(0, root)
        nano = _nano_vllm_path_hint(Path(root))
        if nano:
            parts.insert(0, nano)
    prev = base.get("PYTHONPATH", "")
    if prev:
        parts.append(prev)
    env["PYTHONPATH"] = os.pathsep.join(parts)
    base.update(env)
    if extra:
        base.update(extra)
    return pip_subprocess_env(base)


def _nano_vllm_path_hint(ace_root: Path) -> str | None:
    bundled = ace_root / "third_parts" / "nano-vllm"
    if (bundled / "nanovllm").is_dir() or (bundled / "setup.py").is_file() or (
        bundled / "pyproject.toml"
    ).is_file():
        return str(bundled.resolve())
    cached = nano_vllm_cache_dir()
    for cand in cached.rglob("nanovllm"):
        if cand.is_dir():
            return str(cand.parent.resolve())
    return None


def _path_bootstrap_prefix(*, include_acestep: bool = True, include_nano: bool = False) -> str:
    """Embeddable Python: inject engine-runtime (+ ACE-Step source) into sys.path."""
    parts: list[str] = [engine_python_c_prefix(TOOL_CREATE_MUSIC)]
    if include_acestep:
        try:
            root = str(resolve_acestep_root().resolve())
            parts.append(
                f"_v={root!r}; sys.path.insert(0, _v) if _v not in sys.path else None; "
            )
            if include_nano:
                nano = _nano_vllm_path_hint(Path(root))
                if nano:
                    parts.append(
                        f"_n={nano!r}; sys.path.insert(0, _n) if _n not in sys.path else None; "
                    )
        except Exception:
            pass
    return "".join(parts)


def _run_acestep_python(
    args: list[str],
    *,
    cwd: Path | None = None,
    timeout: float = 3600.0,
    env: dict[str, str] | None = None,
    include_nano: bool = False,
) -> subprocess.CompletedProcess:
    merged = _acestep_env() if env is None else env
    cmd_args = list(args)
    if cmd_args[:1] == ["-c"] and len(cmd_args) >= 2:
        prefix = _path_bootstrap_prefix(include_acestep=True, include_nano=include_nano)
        if prefix and not str(cmd_args[1]).startswith("import sys"):
            cmd_args[1] = "import sys; " + prefix + str(cmd_args[1])
        elif prefix and "sys.path.insert" not in str(cmd_args[1])[:80]:
            cmd_args[1] = prefix + str(cmd_args[1])
    return run_hidden(
        [str(acestep_python()), *cmd_args],
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        timeout=timeout,
        creationflags=no_window_creationflags(),
        env=merged,
    )


def verify_torch_installation() -> tuple[bool, str]:
    """PyTorch CUDA 설치 검증."""
    if not is_venv_ready_fast():
        return False, "engine-runtime site-packages 없음"
    proc = _run_acestep_python(["-c", _TORCH_VERIFY_SCRIPT], timeout=120)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-500:]
        return False, tail or "torch import 실패"
    version = (proc.stdout or "").strip().splitlines()[-1] if proc.stdout else ""
    if "+cu" not in version.lower() and "cu128" not in version.lower():
        # still accept if cuda available
        pass
    return True, version


def install_pytorch_stack(*, force: bool = False, message_cb: Callable[[str], None] | None = None) -> None:
    """오프라인 wheel만 — 온라인 CUDA index 금지."""
    del force
    if not _use_offline_wheels():
        raise RuntimeError("Create Music는 library-hub wheel만 지원합니다.")
    if message_cb:
        message_cb("PyTorch — library-hub wheel 번들 사용")
    install_create_music_wheels_bundle(force=True, message_cb=message_cb)


def is_venv_ready() -> bool:
    torch_ok, _ = verify_torch_installation()
    if not torch_ok:
        return False
    proc = _run_acestep_python(
        ["-c", "import acestep; print(acestep.__file__)"],
        timeout=120,
    )
    return proc.returncode == 0


def is_venv_ready_fast() -> bool:
    """디스크만 확인 (페이지 로드용)."""
    site = acestep_site_packages()
    if not site.is_dir():
        return False
    if (site / "torch").is_dir():
        return True
    return any(site.glob("torch*"))


def is_models_ready(*, require_venv: bool = True) -> bool:
    if require_venv and not is_venv_ready():
        return False
    ckpt = acestep_checkpoints_dir()
    turbo = ckpt / "acestep-v15-turbo"
    vae = ckpt / "vae"
    for p in (turbo, vae):
        if not p.is_dir():
            return False
        if not any(p.glob("*.safetensors")) and not any(p.glob("*.bin")):
            if not (p / "model.safetensors.index.json").is_file():
                return False
    return True


def runtime_status_fast() -> dict[str, Any]:
    """페이지 접속·quick readiness 전용 — subprocess import 검증 없음."""
    root_ok = False
    root_path = ""
    root_err = ""
    try:
        root_path = str(resolve_acestep_root())
        root_ok = True
    except Exception as e:
        root_err = str(e)

    py312 = ""
    py_err = ""
    try:
        py312 = find_python312()
    except Exception as e:
        py_err = str(e)

    venv_fast = is_venv_ready_fast()
    models_fast = is_models_ready(require_venv=False)
    lm_backend = resolve_lm_backend(prefer_vllm=False)

    return {
        "acestep_root": root_path,
        "acestep_root_ok": root_ok,
        "acestep_root_error": root_err,
        "checkpoints_dir": str(acestep_checkpoints_dir()),
        "venv_dir": str(acestep_site_packages()),
        "torch_ok": venv_fast,
        "torch_version": "",
        "torch_error": "" if venv_fast else "engine-runtime·PyTorch 미확인",
        "venv_ready": venv_fast,
        "models_ready": models_fast,
        "python312": py312,
        "python312_error": py_err,
        "runner_python": str(acestep_python()) if venv_fast else "",
        "runtime": "create-music-engine-runtime",
        "nano_vllm_ready": False,
        "nano_vllm_zip_url": _nano_vllm_zip_url(),
        "nano_vllm_cache_dir": str(nano_vllm_cache_dir()),
        "wheels_bundle_urls": list(_wheels_part_urls()),
        "wheels_cache_dir": str(wheels_cache_dir()),
        "wheels_bundle_cached": _wheel_bundle_cache_valid(_wheels_part_urls()),
        "offline_wheels_enabled": _use_offline_wheels(),
        "lm_backend": lm_backend,
        "lm_backend_env": os.environ.get("ITMATZIP_ACESTEP_LM_BACKEND", "auto"),
        "quick_status": True,
    }


def runtime_status() -> dict[str, Any]:
    root_ok = False
    root_path = ""
    root_err = ""
    try:
        root_path = str(resolve_acestep_root())
        root_ok = True
    except Exception as e:
        root_err = str(e)

    py312 = ""
    py_err = ""
    try:
        py312 = find_python312()
    except Exception as e:
        py_err = str(e)

    torch_ok, torch_detail = verify_torch_installation()
    nano_ok = is_nano_vllm_ready()
    lm_backend = resolve_lm_backend(prefer_vllm=nano_ok)

    return {
        "acestep_root": root_path,
        "acestep_root_ok": root_ok,
        "acestep_root_error": root_err,
        "checkpoints_dir": str(acestep_checkpoints_dir()),
        "venv_dir": str(acestep_site_packages()),
        "torch_ok": torch_ok,
        "torch_version": torch_detail if torch_ok else "",
        "torch_error": "" if torch_ok else torch_detail,
        "venv_ready": is_venv_ready(),
        "models_ready": is_models_ready(),
        "python312": py312,
        "python312_error": py_err,
        "runner_python": str(acestep_python()) if is_venv_ready_fast() else "",
        "runtime": "create-music-engine-runtime",
        "nano_vllm_ready": nano_ok,
        "nano_vllm_zip_url": _nano_vllm_zip_url(),
        "nano_vllm_cache_dir": str(nano_vllm_cache_dir()),
        "wheels_bundle_urls": list(_wheels_part_urls()),
        "wheels_cache_dir": str(wheels_cache_dir()),
        "wheels_bundle_cached": _wheel_bundle_cache_valid(_wheels_part_urls()),
        "offline_wheels_enabled": _use_offline_wheels(),
        "lm_backend": lm_backend,
        "lm_backend_env": os.environ.get("ITMATZIP_ACESTEP_LM_BACKEND", "auto"),
    }


def _venv_python_exe() -> Path:
    return acestep_python()


# pip install -e 대신 runner path inject — 런타임 deps만 wheel
ACESTEP_RUNTIME_PACKAGES = [
    "safetensors==0.7.0",
    "transformers>=4.51.0,<4.58.0",
    "diffusers>=0.37.0",
    "matplotlib>=3.7.5",
    "scipy>=1.10.1",
    "soundfile>=0.13.1",
    "loguru>=0.7.3",
    "einops>=0.8.1",
    "accelerate>=1.12.0",
    "fastapi>=0.110.0",
    "diskcache",
    "uvicorn[standard]>=0.27.0",
    "numba>=0.63.1",
    "vector-quantize-pytorch>=1.27.15",
    "einx",
    "frozendict",
    "torchcodec>=0.9.1",
    "torchao>=0.16.0,<0.17.0",
    "toml",
    "modelscope",
    "modelscope_hub",
    "peft>=0.18.0",
    "setuptools<72",
    "huggingface_hub>=0.34.0,<1.0",
    "httpx",
    "httpcore",
    "tokenizers>=0.22.0,<0.23.0",
    "sentencepiece",
    "protobuf",
    "tqdm",
    "pyyaml",
    "omegaconf",
    "librosa",
    "av",
]


def _install_acestep_package(
    root: Path,
    *,
    message_cb: Callable[[str], None] | None = None,
    wheel_dir: Path | None = None,
) -> None:
    """ACE-Step 소스 경로 설정 + 런타임 wheel (editable pip 없음)."""
    forced_js_files = (
        root / "acestep" / "ui" / "gradio" / "interfaces" / "audio_player_preferences.js",
        root / "acestep" / "ui" / "gradio" / "interfaces" / "user_preferences.js",
    )
    for js_path in forced_js_files:
        if not js_path.is_file():
            js_path.parent.mkdir(parents=True, exist_ok=True)
            js_path.write_text("// autogenerated placeholder for packaging\n", encoding="utf-8")
            logger.warning("ACE-Step force-include placeholder created: %s", js_path)
    _persist_acestep_root_config(root, _acestep_source_zip_url())
    if message_cb:
        message_cb(f"ACE-Step 소스 경로: {root}")
    ensure_runtime_packages(wheel_dir=wheel_dir, message_cb=message_cb)


def install_nano_vllm_stack(
    root: Path | None = None,
    *,
    message_cb: Callable[[str], None] | None = None,
    install_flash_attn: bool = True,
) -> tuple[bool, str]:
    """
    nano-vllm: path inject + 선택 wheel(triton/xxhash/flash_attn) 해제.
    PyPI / pip -e 없음. 실패해도 LM pt 백엔드로 동작.
    """
    ace_root: Path | None = None
    try:
        ace_root = root or resolve_acestep_root()
    except FileNotFoundError:
        ace_root = None

    try:
        nano_dir = resolve_nano_vllm_dir(ace_root, message_cb=message_cb)
    except FileNotFoundError as exc:
        return False, str(exc)

    def step(msg: str) -> None:
        if message_cb:
            message_cb(msg)
        logger.info("[nano-vllm] %s", msg)

    wheel_dir = wheels_extract_dir() if wheels_extract_dir().is_dir() else None
    site = acestep_site_packages()

    if wheel_dir:
        step("Triton / xxhash wheel 해제 (있으면)…")
        for pattern in ("triton_windows-*.whl", "triton-*.whl", "xxhash-*.whl"):
            for whl in wheel_dir.glob(pattern):
                if _wheel_matches_py312_win(whl.name):
                    try:
                        _extract_wheel_into_site(whl, site)
                    except Exception as exc:
                        logger.warning("optional wheel extract failed %s: %s", whl.name, exc)
        if install_flash_attn:
            flash_local = list(wheel_dir.glob("flash_attn*.whl"))
            if flash_local:
                try:
                    _extract_wheel_into_site(flash_local[0], site)
                except Exception as exc:
                    logger.warning("flash-attn extract skipped: %s", exc)
        finalize_runtime_pip(TOOL_CREATE_MUSIC)

    step(f"nano-vllm 경로 사용: {nano_dir}")
    if is_nano_vllm_ready():
        return True, f"nano-vllm 준비됨 ({nano_dir}) — LM vllm 사용 가능"
    return False, "nano-vllm 검증 실패 — LM은 pt 백엔드로 동작"


def _run_pip(
    args: list[str],
    *,
    message_cb: Callable[[str], None] | None = None,
    timeout: float = 7200.0,
) -> None:
    """engine-runtime --target pip (ACL finalize). 가능하면 wheel 해제 경로를 쓸 것."""
    py = acestep_python()
    cmd = [str(py), "-m", "pip", *args]
    if "install" in cmd and "--target" not in cmd and "uninstall" not in cmd:
        # insert --target after install
        i = cmd.index("install") + 1
        for flag in reversed(pip_target_args(TOOL_CREATE_MUSIC)):
            cmd.insert(i, flag)
    if message_cb:
        message_cb(f"pip {' '.join(args[:4])}…")
    env = pip_subprocess_env(_acestep_env())
    proc = run_hidden(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
        creationflags=no_window_creationflags(),
    )
    finalize_runtime_pip(TOOL_CREATE_MUSIC)
    if proc.returncode == 0:
        return
    raise RuntimeError(f"pip 실패: {(proc.stderr or proc.stdout or '')[-2000:]}")


def _terminate_venv_python_processes() -> None:
    """레거시 — no-op (engine-runtime)."""
    return


def ensure_venv(
    *,
    on_message: Callable[[str], None] | None = None,
    on_progress: Callable[[float, str], None] | None = None,
    force_repair_torch: bool = False,
) -> None:
    """engine-runtime + library-hub 완전 wheel (하위 호환 이름 ensure_venv)."""
    ensure_runtime(
        on_message=on_message,
        on_progress=on_progress,
        force_repair_torch=force_repair_torch,
    )


def ensure_runtime(
    *,
    on_message: Callable[[str], None] | None = None,
    on_progress: Callable[[float, str], None] | None = None,
    force_repair_torch: bool = False,
) -> None:
    """MSI engine python + engine-runtime/create-music + offline wheels."""

    def notify(pct: float, text: str) -> None:
        if on_progress:
            on_progress(pct, text)
        elif on_message:
            on_message(text)

    purge_legacy_acestep_venv(message_cb=lambda m: notify(12, m))
    acestep_site_packages()
    ensure_runtime_tree_acl(TOOL_CREATE_MUSIC)

    notify(13, "ACE-Step 소스 확인…")
    root = resolve_acestep_root(message_cb=lambda m: notify(14, m))

    torch_ok, _ = verify_torch_installation()
    acestep_ok = False
    if torch_ok:
        try:
            acestep_ok = is_venv_ready()
        except Exception:
            acestep_ok = False

    install_nv = os.environ.get("ITMATZIP_INSTALL_NANO_VLLM", "1").strip().lower() not in (
        "0",
        "false",
        "no",
    )

    if torch_ok and acestep_ok and not force_repair_torch:
        notify(30, "런타임 의존성 확인 중…")
        ensure_runtime_packages(
            wheel_dir=_runtime_wheel_dir(),
            message_cb=lambda m: notify(30, m),
        )
        if install_nv and not is_nano_vllm_ready():
            notify(32, "nano-vllm (선택) 준비 중…")
            ok_nv, msg_nv = install_nano_vllm_stack(
                root,
                message_cb=lambda m: notify(32, m),
            )
            logger.info("nano-vllm install: ok=%s %s", ok_nv, msg_nv)
        notify(34, "ACE-Step 환경 이미 준비됨")
        return

    if not _use_offline_wheels():
        raise RuntimeError(
            "Create Music는 library-hub wheel 번들만 지원합니다. "
            "ITMATZIP_ACESTEP_SKIP_WHEELS 를 끄세요."
        )

    notify(16, "Create Music wheel 번들 다운로드·해제 중…")
    wheel_dir = install_create_music_wheels_bundle(
        force=force_repair_torch or not torch_ok,
        message_cb=lambda m: notify(22, m),
    )
    notify(28, "wheel 번들 설치 완료")

    notify(29, "ACE-Step 소스 연결…")
    _install_acestep_package(
        root,
        message_cb=lambda m: notify(30, m),
        wheel_dir=wheel_dir,
    )

    if install_nv and not is_nano_vllm_ready():
        notify(32, "nano-vllm (선택) 준비 중…")
        ok_nv, msg_nv = install_nano_vllm_stack(
            root,
            message_cb=lambda m: notify(32, m),
        )
        logger.info("nano-vllm install: ok=%s %s", ok_nv, msg_nv)
        if ok_nv:
            notify(33, msg_nv)
        else:
            notify(33, f"{msg_nv}")

    if not is_venv_ready():
        raise RuntimeError("ACE-Step 설치 후 검증에 실패했습니다.")


def _run_subprocess_script(
    script_name: str,
    payload: dict[str, Any],
    *,
    on_progress: Callable[[float, str], None] | None = None,
    timeout_sec: float = 7200,
) -> dict[str, Any]:
    """engine python에서 runner 스크립트 실행 (embeddable path bootstrap)."""
    py = acestep_python()
    script = _engines_dir() / script_name
    if not script.is_file():
        raise FileNotFoundError(script)

    with tempfile.TemporaryDirectory(prefix="itmatzip-cm-") as tmp:
        req_path = Path(tmp) / "request.json"
        prog_path = Path(tmp) / "progress.json"
        out_path = Path(tmp) / "result.json"
        payload = {**payload, "progress_path": str(prog_path), "result_path": str(out_path)}
        req_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

        lm = str(payload.get("lm_backend") or resolve_lm_backend())
        env = _acestep_env(lm_backend=lm)
        # agent package root for imports
        agent_pkg = str(Path(__file__).resolve().parents[1])
        env["ITMATZIP_AGENT_PACKAGE_ROOT"] = agent_pkg
        env["ITMATZIP_AGENT_DIR"] = agent_pkg
        prev = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = os.pathsep.join(
            [p for p in (agent_pkg, prev) if p]
        )

        proc = run_hidden(
            [str(py), str(script), str(req_path)],
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            env=env,
            creationflags=no_window_creationflags(),
        )

        stop = threading.Event()

        def _poll():
            while not stop.is_set():
                if prog_path.is_file():
                    try:
                        data = json.loads(prog_path.read_text(encoding="utf-8"))
                        if on_progress:
                            on_progress(float(data.get("progress", 0)), str(data.get("message", "")))
                    except Exception:
                        pass
                time.sleep(0.8)

        poll_t = threading.Thread(target=_poll, daemon=True)
        poll_t.start()
        try:
            if proc.returncode != 0:
                err = (proc.stderr or proc.stdout or "")[-3000:]
                if out_path.is_file():
                    data = json.loads(out_path.read_text(encoding="utf-8"))
                    if data.get("error"):
                        raise RuntimeError(data["error"])
                raise RuntimeError(err or f"ACE-Step runner 실패 (exit {proc.returncode})")
        finally:
            stop.set()
            poll_t.join(timeout=2)

        if not out_path.is_file():
            raise RuntimeError("ACE-Step runner 결과 파일이 없습니다.")
        return json.loads(out_path.read_text(encoding="utf-8"))


def prepare_models(
    *,
    force: bool = False,
    dit_configs: list[str] | None = None,
    lm_models: list[str] | None = None,
    on_progress: Callable[[float, str], None] | None = None,
) -> None:
    if not force and is_models_ready(require_venv=False):
        pkg_ok, _ = verify_model_download_packages()
        if pkg_ok:
            if on_progress:
                on_progress(95, "모델 이미 설치됨 — 다운로드 생략")
            return

    if not verify_torch_installation()[0]:
        if on_progress:
            on_progress(18, "PyTorch 복구 중…")
        install_pytorch_stack(force=True, message_cb=lambda m: on_progress(18, m) if on_progress else None)
    if on_progress:
        on_progress(33, "모델 다운로드 의존성 확인 중…")
    wheel_dir = _runtime_wheel_dir()
    ensure_model_download_packages(
        wheel_dir=wheel_dir,
        force=force,
        message_cb=lambda m: on_progress(33, m) if on_progress else None,
    )
    ensure_runtime_packages(
        wheel_dir=wheel_dir,
        force=force,
        message_cb=lambda m: on_progress(34, m) if on_progress else None,
    )
    payload = {
        "force": force,
        "project_root": str(resolve_acestep_root()),
        "checkpoints_dir": str(acestep_checkpoints_dir()),
        "dit_configs": dit_configs or ["acestep-v15-turbo"],
        "lm_models": lm_models or [],
    }
    result = _run_subprocess_script(
        "create_music_prepare_runner.py",
        payload,
        on_progress=on_progress,
        timeout_sec=14400,
    )
    if not result.get("ok"):
        raise RuntimeError(result.get("error") or "모델 준비 실패")


def run_generation(payload: dict[str, Any], *, on_progress: Callable[[float, str], None] | None = None) -> dict[str, Any]:
    torch_ok, detail = verify_torch_installation()
    if not torch_ok:
        install_pytorch_stack(force=True)
    if not is_models_ready():
        raise RuntimeError("모델이 준비되지 않았습니다. 환경 준비를 실행하세요.")
    return _run_subprocess_script(
        "create_music_runner.py",
        payload,
        on_progress=on_progress,
        timeout_sec=14400,
    )
