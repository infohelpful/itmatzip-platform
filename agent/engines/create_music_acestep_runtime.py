"""ACE-Step 1.5 전용 Python 3.12 런타임 (에이전트 3.14와 분리)."""
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

from common.subprocess_util import run_hidden

logger = logging.getLogger(__name__)

PYTHON_312_CANDIDATES = (
    "py -3.12",
    r"C:\Users\MyComputer\AppData\Local\Programs\Python\Python312\python.exe",
)

DEFAULT_ACESTEP_ROOTS = (
    Path(r"c:\Users\MyComputer\Desktop\ACE-Step-1.5-main\ACE-Step-1.5-main"),
    Path(r"c:\Users\MyComputer\Desktop\ACE-Step-1.5-main"),
)

# ACE-Step 1.5 공식 Windows CUDA 12.8 스택 (pyproject.toml) — +cu128 필수
PYTORCH_CU128_INDEX = "https://download.pytorch.org/whl/cu128"
PYTORCH_CUDA_PACKAGES = (
    "torch==2.7.1+cu128",
    "torchvision==0.22.1+cu128",
    "torchaudio==2.7.1+cu128",
)

# Windows + Py3.12 + torch 2.7.1+cu128 (선택 — 없어도 vllm은 SDPA eager 모드로 동작)
FLASH_ATTN_WIN_CP312_CU128 = (
    "https://huggingface.co/lldacing/flash-attention-windows-wheel/resolve/main/"
    "flash_attn-2.7.4.post1+cu128torch2.7.0cxx11abiFALSE-cp312-cp312-win_amd64.whl"
)

# library-hub Create_Music_Lib Release
CREATE_MUSIC_LIB_BASE = (
    "https://github.com/infohelpful/library-hub/releases/download/Create_Music_Lib"
)
DEFAULT_ACESTEP_SOURCE_ZIP_URL = f"{CREATE_MUSIC_LIB_BASE}/ACE-Step-1.5.zip"
# nano-vllm은 ACE-Step 소스 안의 third_parts를 기본으로 사용.
# zip 다운로드는 사용자가 URL을 명시한 경우에만 수행한다.
DEFAULT_NANO_VLLM_ZIP_URL = ""
DEFAULT_WHEELS_PART_URLS = (
    f"{CREATE_MUSIC_LIB_BASE}/wheels_create_music.zip.001",
    f"{CREATE_MUSIC_LIB_BASE}/wheels_create_music.zip.002",
)

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
    return Path(os.environ.get("ITMATZIP_DATA_ROOT", r"C:\ProgramData\itmatzip-agent"))


def acestep_checkpoints_dir() -> Path:
    env = os.environ.get("ITMATZIP_ACESTEP_CHECKPOINTS", "").strip()
    if env:
        p = Path(env).expanduser()
    else:
        p = _data_root() / "create-music" / "checkpoints"
    p.mkdir(parents=True, exist_ok=True)
    return p.resolve()


def acestep_venv_dir() -> Path:
    return (_data_root() / "create-music" / ".venv-acestep").resolve()


def nano_vllm_cache_dir() -> Path:
    """GitHub zip 등으로 받은 nano-vllm 소스 캐시."""
    p = _data_root() / "create-music" / "nano-vllm-source"
    p.mkdir(parents=True, exist_ok=True)
    return p.resolve()


def wheels_cache_dir() -> Path:
    """Create Music wheel 번들 캐시 (분할 zip · 압축 해제)."""
    p = _data_root() / "create-music" / "wheels-cache"
    p.mkdir(parents=True, exist_ok=True)
    return p.resolve()


def wheels_extract_dir() -> Path:
    d = wheels_cache_dir() / "wheel"
    d.mkdir(parents=True, exist_ok=True)
    return d


def acestep_source_cache_dir() -> Path:
    """ACE-Step 소스 zip 캐시 (다운로드/압축 해제)."""
    p = _data_root() / "create-music" / "acestep-source"
    p.mkdir(parents=True, exist_ok=True)
    return p.resolve()


def _create_music_config() -> dict[str, Any]:
    cfg = _data_root() / "create-music" / "config.json"
    if not cfg.is_file():
        return {}
    try:
        return json.loads(cfg.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_create_music_config(update: dict[str, Any]) -> None:
    """create-music config.json에 런타임 설정을 병합 저장."""
    cfg_path = _data_root() / "create-music" / "config.json"
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


def _wheel_bundle_cache_valid(urls: tuple[str, str]) -> bool:
    wheel_dir = wheels_extract_dir()
    marker = _wheel_bundle_marker_path()
    if not marker.is_file():
        return False
    if marker.read_text(encoding="utf-8").strip() != "\n".join(urls):
        return False
    try:
        _find_wheel_file(wheel_dir, "torch", must_contain=("cu128", "2.7.1"))
    except RuntimeError:
        return False
    return any(wheel_dir.glob("*.whl"))


def ensure_wheels_bundle_extracted(
    *,
    message_cb: Callable[[str], None] | None = None,
    force: bool = False,
) -> Path:
    """wheels_create_music.zip.001·002 다운로드 → 병합 → 압축 해제."""
    urls = _wheels_part_urls()
    wheel_dir = wheels_extract_dir()
    cache = wheels_cache_dir()

    if not force and _wheel_bundle_cache_valid(urls):
        if message_cb:
            message_cb("wheel 번들 캐시 사용")
        return wheel_dir

    if force and wheel_dir.is_dir():
        for whl in wheel_dir.glob("*.whl"):
            whl.unlink(missing_ok=True)  # type: ignore[arg-type]

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

    _wheel_bundle_marker_path().write_text("\n".join(urls), encoding="utf-8")
    return wheel_dir


def _pip_uninstall_torch_stack() -> None:
    py = _venv_python_exe()
    run_hidden(
        [str(py), "-m", "pip", "uninstall", "-y", "torch", "torchvision", "torchaudio"],
        capture_output=True,
        text=True,
        timeout=600,
    )


def install_pytorch_from_wheels(
    wheel_dir: Path,
    *,
    force: bool = False,
    message_cb: Callable[[str], None] | None = None,
) -> None:
    torch_whl = _find_wheel_file(wheel_dir, "torch", must_contain=("cu128", "2.7.1"))
    vision_whl = _find_wheel_file(wheel_dir, "torchvision", must_contain=("cu128",))
    audio_whl = _find_wheel_file(wheel_dir, "torchaudio", must_contain=("cu128",))
    if message_cb:
        message_cb("PyTorch (CUDA) wheel 설치 중…")
    _pip_uninstall_torch_stack()
    py = _venv_python_exe()
    cmd = [
        str(py),
        "-m",
        "pip",
        "install",
        "--force-reinstall",
        "--no-deps",
        str(torch_whl),
        str(vision_whl),
        str(audio_whl),
    ]
    proc = run_hidden(cmd, capture_output=True, text=True, timeout=3600, env={**os.environ, **_acestep_env()})
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "")[-2000:])
    ok, detail = verify_torch_installation()
    if not ok:
        raise RuntimeError(f"PyTorch wheel 설치 검증 실패: {detail}")


def _pip_install_one(
    package: str,
    *,
    wheel_dir: Path | None = None,
    force: bool = False,
    message_cb: Callable[[str], None] | None = None,
) -> None:
    """wheel → find-links+PyPI → PyPI 순으로 단일 패키지 설치."""
    attempts: list[list[str]] = []
    if wheel_dir and any(wheel_dir.glob("*.whl")):
        attempts.append(
            ["install", "--no-index", "--find-links", str(wheel_dir), package]
        )
        attempts.append(
            ["install", "--no-cache-dir", "--find-links", str(wheel_dir), package]
        )
    attempts.append(["install", "--no-cache-dir", package])

    last_exc: RuntimeError | None = None
    for args in attempts:
        cmd = list(args)
        if force and cmd[0] == "install":
            cmd.insert(1, "--force-reinstall")
        try:
            _run_pip(cmd, message_cb=message_cb)
            return
        except RuntimeError as exc:
            last_exc = exc
    if last_exc is not None:
        raise last_exc
    raise RuntimeError(f"pip install failed: {package}")


def install_runtime_packages_from_wheels(
    wheel_dir: Path,
    *,
    force: bool = False,
    message_cb: Callable[[str], None] | None = None,
) -> None:
    if message_cb:
        message_cb("런타임 라이브러리 wheel 설치 중…")
    failed: list[str] = []
    for pkg in ACESTEP_RUNTIME_PACKAGES:
        try:
            _pip_install_one(
                pkg,
                wheel_dir=wheel_dir,
                force=force,
                message_cb=message_cb,
            )
        except RuntimeError as exc:
            logger.warning("runtime wheel install failed for %s: %s", pkg, exc)
            failed.append(pkg)
    if failed:
        raise RuntimeError(
            "일부 런타임 패키지 wheel 설치 실패: " + ", ".join(failed[:8])
            + (" …" if len(failed) > 8 else "")
        )


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
mods = (
    "loguru",
    "transformers",
    "diffusers",
    "safetensors",
    "soundfile",
    "huggingface_hub",
    "modelscope",
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
        py = venv_python()
    except RuntimeError as exc:
        return False, str(exc)
    proc = run_hidden(
        [str(py), "-c", _MODEL_DOWNLOAD_IMPORT_CHECK],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode == 0:
        return True, ""
    detail = (proc.stderr or proc.stdout or "model download import check failed").strip()
    return False, detail[-500:]


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
    """가중치 다운로드 전 huggingface_hub · modelscope · loguru 보장."""
    ok, _ = verify_model_download_packages()
    if ok and not force:
        return
    wheel_dir = wheel_dir or _runtime_wheel_dir()
    if message_cb:
        message_cb("모델 다운로드용 패키지 설치 중 (huggingface_hub, modelscope)…")
    for pkg in ACESTEP_MODEL_DOWNLOAD_PACKAGES:
        _pip_install_one(pkg, wheel_dir=wheel_dir, force=force, message_cb=message_cb)
    ok, detail = verify_model_download_packages()
    if not ok:
        raise RuntimeError(
            f"모델 다운로드 의존성 설치 실패: {detail}. "
            "인터넷 연결·pip 프록시를 확인한 뒤 환경 준비를 다시 실행하세요."
        )


def verify_runtime_packages() -> tuple[bool, str]:
    try:
        py = venv_python()
    except RuntimeError as exc:
        return False, str(exc)
    proc = run_hidden(
        [str(py), "-c", _RUNTIME_IMPORT_CHECK],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode == 0:
        return True, ""
    detail = (proc.stderr or proc.stdout or "runtime import check failed").strip()
    return False, detail[-500:]


def ensure_runtime_packages(
    *,
    wheel_dir: Path | None = None,
    force: bool = False,
    message_cb: Callable[[str], None] | None = None,
) -> None:
    """loguru 등 ACE-Step 런타임 의존성 — wheel 번들 사용 시에도 반드시 설치."""
    wheel_dir = wheel_dir or _runtime_wheel_dir()
    ensure_model_download_packages(wheel_dir=wheel_dir, force=force, message_cb=message_cb)

    ok, _ = verify_runtime_packages()
    if ok and not force:
        return
    if wheel_dir:
        try:
            install_runtime_packages_from_wheels(wheel_dir, force=force, message_cb=message_cb)
        except RuntimeError as exc:
            logger.warning("runtime packages from wheels failed: %s", exc)
    ok, detail = verify_runtime_packages()
    if not ok:
        if message_cb:
            message_cb("런타임 의존성 PyPI 보완 설치 중…")
        for pkg in ACESTEP_RUNTIME_PACKAGES:
            try:
                _pip_install_one(pkg, wheel_dir=wheel_dir, force=force, message_cb=message_cb)
            except RuntimeError as exc:
                logger.warning("runtime PyPI install failed for %s: %s", pkg, exc)
    ok, detail = verify_runtime_packages()
    if not ok:
        raise RuntimeError(f"런타임 의존성 설치 실패: {detail}")


def install_create_music_wheels_bundle(
    *,
    force: bool = False,
    message_cb: Callable[[str], None] | None = None,
) -> Path:
    """library-hub wheel 번들로 PyTorch + 런타임 의존성 설치."""
    wheel_dir = ensure_wheels_bundle_extracted(message_cb=message_cb, force=force)
    install_pytorch_from_wheels(wheel_dir, force=force, message_cb=message_cb)
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

    for p in DEFAULT_ACESTEP_ROOTS:
        if _is_valid_acestep_root(p):
            return p.resolve()

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
    """시스템 Python 3.12 실행 파일."""
    for cand in PYTHON_312_CANDIDATES:
        if cand.startswith("py "):
            try:
                proc = run_hidden(
                    cand.split() + ["-c", "import sys; print(sys.executable)"],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                if proc.returncode == 0:
                    exe = proc.stdout.strip().splitlines()[-1].strip()
                    if exe and Path(exe).is_file():
                        return exe
            except Exception:
                continue
        else:
            if Path(cand).is_file():
                return cand
    raise RuntimeError(
        "Python 3.12가 필요합니다. https://www.python.org/downloads/ 에서 3.12를 설치하거나 "
        "'py -3.12'가 동작하는지 확인하세요."
    )


def venv_python() -> Path:
    py = acestep_venv_dir() / "Scripts" / "python.exe"
    if not py.is_file():
        raise RuntimeError("ACE-Step 가상환경이 없습니다. 환경 준비를 먼저 실행하세요.")
    return py


def is_nano_vllm_ready() -> bool:
    """로컬 nano-vllm + Triton 설치 여부."""
    py = acestep_venv_dir() / "Scripts" / "python.exe"
    if not py.is_file():
        return False
    env = os.environ.copy()
    env.update(_acestep_env(lm_backend="pt"))
    proc = run_hidden(
        [str(py), "-c", _NANO_VLLM_VERIFY_SCRIPT],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
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
    root = str(resolve_acestep_root())
    ckpt = str(acestep_checkpoints_dir())
    base = os.environ.copy()
    try:
        from common.bin_manager import ensure_ffmpeg, prepend_ffmpeg_bin_to_env

        ensure_ffmpeg()
        prepend_ffmpeg_bin_to_env(base)
    except Exception as exc:
        logger.warning("ffmpeg PATH not added to acestep env: %s", exc)
    env = {
        "ACESTEP_PROJECT_ROOT": root,
        "ACESTEP_CHECKPOINTS_DIR": ckpt,
        "ITMATZIP_ACESTEP_ROOT": root,
        "ITMATZIP_ACESTEP_CHECKPOINTS": ckpt,
        "PYTHONNOUSERSITE": "1",
        "ACESTEP_DISABLE_TQDM": "1",
        "HF_HUB_DISABLE_PROGRESS_BARS": "0",
        "ACESTEP_LM_BACKEND": lm_backend,
    }
    base.update(env)
    if extra:
        base.update(extra)
    return base


def verify_torch_installation() -> tuple[bool, str]:
    """PyTorch CUDA 설치가 올바른지 검증 (torch._utils 등)."""
    venv = acestep_venv_dir()
    py = venv / "Scripts" / "python.exe"
    if not py.is_file():
        return False, "가상환경 없음"
    env = os.environ.copy()
    env.update(_acestep_env())
    proc = run_hidden(
        [str(py), "-c", _TORCH_VERIFY_SCRIPT],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
    )
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-500:]
        return False, tail or "torch import 실패"
    version = (proc.stdout or "").strip().splitlines()[-1] if proc.stdout else ""
    return True, version


def install_pytorch_stack(*, force: bool = False, message_cb: Callable[[str], None] | None = None) -> None:
    """CUDA 12.8용 PyTorch/torchvision/torchaudio 설치 (ACE-Step 공식 버전)."""
    args = ["install"]
    if force:
        args.append("--force-reinstall")
    args.extend(PYTORCH_CUDA_PACKAGES)
    args.extend(["--index-url", PYTORCH_CU128_INDEX])
    _run_pip(args, message_cb=message_cb)
    ok, detail = verify_torch_installation()
    if not ok:
        raise RuntimeError(
            f"PyTorch 설치 검증 실패: {detail}. "
            "NVIDIA 드라이버·CUDA 호환을 확인한 뒤 환경 준비를 다시 실행하세요."
        )


def is_venv_ready() -> bool:
    torch_ok, _ = verify_torch_installation()
    if not torch_ok:
        return False
    try:
        py = venv_python()
    except RuntimeError:
        return False
    env = os.environ.copy()
    env.update(_acestep_env())
    proc = run_hidden(
        [str(py), "-c", "import acestep; print(acestep.__file__)"],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
    )
    return proc.returncode == 0


def is_venv_ready_fast() -> bool:
    """디스크·venv 구조만 확인 (import subprocess 없음, 페이지 로드용)."""
    py = acestep_venv_dir() / "Scripts" / "python.exe"
    if not py.is_file():
        return False
    site = acestep_venv_dir() / "Lib" / "site-packages"
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
        "venv_dir": str(acestep_venv_dir()),
        "torch_ok": venv_fast,
        "torch_version": "",
        "torch_error": "" if venv_fast else "가상환경·PyTorch 패키지 미확인",
        "venv_ready": venv_fast,
        "models_ready": models_fast,
        "python312": py312,
        "python312_error": py_err,
        "runner_python": str(acestep_venv_dir() / "Scripts" / "python.exe") if venv_fast else "",
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
        "venv_dir": str(acestep_venv_dir()),
        "torch_ok": torch_ok,
        "torch_version": torch_detail if torch_ok else "",
        "torch_error": "" if torch_ok else torch_detail,
        "venv_ready": is_venv_ready(),
        "models_ready": is_models_ready(),
        "python312": py312,
        "python312_error": py_err,
        "runner_python": str(venv_python()) if is_venv_ready() else "",
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
    py = acestep_venv_dir() / "Scripts" / "python.exe"
    if not py.is_file():
        raise RuntimeError("ACE-Step 가상환경 python.exe를 찾을 수 없습니다.")
    return py


# pip install -e ace-step 시 PyPI에 없는 nano-vllm 때문에 실패하므로 --no-deps + 수동 설치
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
    "torchcodec>=0.9.1",
    "torchao>=0.16.0,<0.17.0",
    "toml",
    "modelscope",
    "peft>=0.18.0",
    "setuptools<72",
    "huggingface_hub",
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
    """ace-step editable + 런타임 의존성 (nano-vllm 제외)."""
    # 일부 배포 zip에서 hatchling force-include 대상 JS가 누락되어 editable 빌드가 실패한다.
    # 누락 시 최소 placeholder를 만들어 metadata-generation 실패를 방지한다.
    forced_js_files = (
        root / "acestep" / "ui" / "gradio" / "interfaces" / "audio_player_preferences.js",
        root / "acestep" / "ui" / "gradio" / "interfaces" / "user_preferences.js",
    )
    for js_path in forced_js_files:
        if not js_path.is_file():
            js_path.parent.mkdir(parents=True, exist_ok=True)
            js_path.write_text("// autogenerated placeholder for packaging\n", encoding="utf-8")
            logger.warning("ACE-Step force-include placeholder created: %s", js_path)

    if wheel_dir and any(wheel_dir.glob("hatchling*.whl")):
        _run_pip(
            ["install", "--no-index", "--find-links", str(wheel_dir), "hatchling"],
            message_cb=message_cb,
        )
    else:
        _run_pip(["install", "hatchling"], message_cb=message_cb)
    _run_pip(["install", "-e", str(root), "--no-deps"], message_cb=message_cb)
    ensure_runtime_packages(wheel_dir=wheel_dir, message_cb=message_cb)


def install_nano_vllm_stack(
    root: Path | None = None,
    *,
    message_cb: Callable[[str], None] | None = None,
    install_flash_attn: bool = True,
) -> tuple[bool, str]:
    """
    nano-vllm 로컬 설치 (PyPI에 없음).
    소스: ACE-Step 번들 / GitHub zip / ITMATZIP_NANO_VLLM_DIR.
    성공 시 LM 백엔드 vllm 사용 가능.
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
    links = [str(wheel_dir)] if wheel_dir and any(wheel_dir.glob("*.whl")) else []

    step("Triton (Windows) 설치 중…")
    py = _venv_python_exe()
    run_hidden(
        [str(py), "-m", "pip", "uninstall", "-y", "triton", "triton-windows"],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if links:
        try:
            _run_pip(
                ["install", "--no-index", "--find-links", links[0], "triton-windows>=3.2.0,<3.7"],
                message_cb=message_cb,
            )
        except RuntimeError:
            _run_pip(["install", "triton-windows>=3.2.0,<3.7"], message_cb=message_cb)
    else:
        _run_pip(["install", "triton-windows>=3.2.0,<3.7"], message_cb=message_cb)

    step("xxhash 설치 중…")
    if links:
        try:
            _run_pip(["install", "--no-index", "--find-links", links[0], "xxhash"], message_cb=message_cb)
        except RuntimeError:
            _run_pip(["install", "xxhash"], message_cb=message_cb)
    else:
        _run_pip(["install", "xxhash"], message_cb=message_cb)

    if install_flash_attn:
        step("flash-attn 설치 시도 중… (선택, 실패 시 SDPA 모드)")
        flash_local = list(wheel_dir.glob("flash_attn*.whl")) if wheel_dir else []
        try:
            if flash_local:
                _run_pip(
                    ["install", "--force-reinstall", "--no-deps", str(flash_local[0])],
                    message_cb=message_cb,
                )
            else:
                _run_pip(["install", FLASH_ATTN_WIN_CP312_CU128], message_cb=message_cb)
        except Exception as exc:
            logger.warning("flash-attn install skipped: %s", exc)

    step("nano-vllm 로컬 패키지 설치 중…")
    _run_pip(["install", "-e", str(nano_dir), "--no-deps"], message_cb=message_cb)

    if is_nano_vllm_ready():
        return True, f"nano-vllm 설치 완료 ({nano_dir}) — LM vllm 사용 가능"
    return False, "nano-vllm 설치 후 검증 실패 — Triton/flash-attn 확인 필요"


def _run_pip(args: list[str], *, message_cb: Callable[[str], None] | None = None) -> None:
    """pip 호출은 Windows에서 python -m pip 로 실행 (pip.exe 직접 호출 시 self-upgrade 오류)."""
    py = _venv_python_exe()
    cmd = [str(py), "-m", "pip", *args]
    if message_cb:
        message_cb(f"pip {' '.join(args[:4])}…")
    env = os.environ.copy()
    env.update(_acestep_env())
    proc = run_hidden(cmd, capture_output=True, text=True, timeout=7200, env=env)
    if proc.returncode == 0:
        return

    output = (proc.stderr or proc.stdout or "")
    tail = output[-2000:]
    lower = output.lower()
    is_lock_error = (
        "winerror 5" in lower
        or "access is denied" in lower
        or "액세스가 거부" in lower
        or "asmjit.dll" in lower
    )
    if is_lock_error:
        if message_cb:
            message_cb("파일 잠금 감지 — 관련 python 프로세스 정리 후 pip 재시도…")
        _terminate_venv_python_processes()
        time.sleep(1.0)
        retry = run_hidden(cmd, capture_output=True, text=True, timeout=7200, env=env)
        if retry.returncode == 0:
            return
        tail = (retry.stderr or retry.stdout or "")[-2000:]
    raise RuntimeError(f"pip 실패: {tail}")


def _terminate_venv_python_processes() -> None:
    """
    WinError 5(파일 잠금) 복구용.
    create-music venv를 커맨드라인에 포함한 python.exe만 종료한다.
    """
    if sys.platform != "win32":
        return
    venv = str(acestep_venv_dir()).lower().replace("\\", "\\\\")
    script = (
        "$p='" + venv + "';"
        "Get-CimInstance Win32_Process "
        "| Where-Object { $_.Name -ieq 'python.exe' -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($p) } "
        "| ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }"
    )
    try:
        run_hidden(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except Exception:
        pass


def ensure_venv(
    *,
    on_message: Callable[[str], None] | None = None,
    on_progress: Callable[[float, str], None] | None = None,
    force_repair_torch: bool = False,
) -> None:
    """Python 3.12 venv 생성 + ace-step 패키지 설치."""
    def notify(pct: float, text: str) -> None:
        if on_progress:
            on_progress(pct, text)
        elif on_message:
            on_message(text)

    venv = acestep_venv_dir()
    root = resolve_acestep_root()
    py312 = find_python312()

    if not (venv / "Scripts" / "python.exe").is_file():
        notify(14, "Python 3.12 가상환경 생성 중…")
        venv.parent.mkdir(parents=True, exist_ok=True)
        proc = run_hidden(
            [py312, "-m", "venv", str(venv)],
            capture_output=True,
            text=True,
            timeout=300,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr[-500:] or "venv 생성 실패")

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
            notify(32, "nano-vllm (vLLM LM) 설치 중…")
            ok_nv, msg_nv = install_nano_vllm_stack(
                root,
                message_cb=lambda m: notify(32, m),
            )
            logger.info("nano-vllm install: ok=%s %s", ok_nv, msg_nv)
        notify(34, "ACE-Step 환경 이미 준비됨")
        return

    notify(16, "pip 업그레이드 중…")
    try:
        _run_pip(["install", "--upgrade", "pip", "setuptools", "wheel"], message_cb=lambda m: notify(18, m))
    except RuntimeError as exc:
        msg = str(exc).lower()
        if ("winerror 5" in msg or "액세스가 거부" in msg or "asmjit.dll" in msg) and venv.exists():
            notify(17, "venv 파일 잠금 복구 — 가상환경 재생성 중…")
            _terminate_venv_python_processes()
            shutil.rmtree(venv, ignore_errors=True)
            proc = run_hidden(
                [py312, "-m", "venv", str(venv)],
                capture_output=True,
                text=True,
                timeout=300,
            )
            if proc.returncode != 0:
                raise RuntimeError(proc.stderr[-500:] or "venv 재생성 실패")
            _run_pip(["install", "--upgrade", "pip", "setuptools", "wheel"], message_cb=lambda m: notify(18, m))
        else:
            raise

    wheel_dir: Path | None = None
    use_wheels = _use_offline_wheels()
    if use_wheels:
        try:
            notify(20, "Create Music wheel 번들 다운로드·설치 중…")
            wheel_dir = install_create_music_wheels_bundle(
                force=force_repair_torch or not torch_ok,
                message_cb=lambda m: notify(22, m),
            )
            notify(28, "wheel 번들 설치 완료")
        except Exception as exc:
            logger.warning("wheel 번들 설치 실패, PyPI 폴백: %s", exc)
            notify(20, f"wheel 실패 — 온라인 설치로 전환 ({exc})")
            use_wheels = False

    if not use_wheels:
        notify(20, "PyTorch (CUDA 12.8) 설치 중… (수 분 소요)")
        install_pytorch_stack(
            force=force_repair_torch or not torch_ok,
            message_cb=lambda m: notify(24, m),
        )

    if not acestep_ok:
        if wheel_dir is None and _use_offline_wheels() and _wheel_bundle_cache_valid(_wheels_part_urls()):
            wheel_dir = wheels_extract_dir()
        notify(26, "ACE-Step 패키지 설치 중…")
        _install_acestep_package(
            root,
            message_cb=lambda m: notify(27, m),
            wheel_dir=wheel_dir,
        )
        if not use_wheels:
            notify(30, "PyTorch CUDA 버전 재확인 중…")
            install_pytorch_stack(force=True, message_cb=lambda m: notify(31, m))
        else:
            ok_torch, detail = verify_torch_installation()
            if not ok_torch:
                raise RuntimeError(f"PyTorch 검증 실패: {detail}")

    if install_nv and not is_nano_vllm_ready():
        notify(32, "nano-vllm (vLLM LM) 설치 중…")
        ok_nv, msg_nv = install_nano_vllm_stack(
            root,
            message_cb=lambda m: notify(32, m),
        )
        logger.info("nano-vllm install: ok=%s %s", ok_nv, msg_nv)
        if ok_nv:
            notify(33, msg_nv)
        else:
            notify(33, f"{msg_nv} — LM은 pt 백엔드로 동작")

    if not is_venv_ready():
        raise RuntimeError("ACE-Step 설치 후 검증에 실패했습니다.")


def _run_subprocess_script(
    script_name: str,
    payload: dict[str, Any],
    *,
    on_progress: Callable[[float, str], None] | None = None,
    timeout_sec: float = 7200,
) -> dict[str, Any]:
    """3.12 venv에서 runner 스크립트 실행."""
    py = venv_python()
    script = _engines_dir() / script_name
    if not script.is_file():
        raise FileNotFoundError(script)

    with tempfile.TemporaryDirectory(prefix="itmatzip-cm-") as tmp:
        req_path = Path(tmp) / "request.json"
        prog_path = Path(tmp) / "progress.json"
        out_path = Path(tmp) / "result.json"
        payload = {**payload, "progress_path": str(prog_path), "result_path": str(out_path)}
        req_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

        env = os.environ.copy()
        lm = str(payload.get("lm_backend") or resolve_lm_backend())
        env.update(_acestep_env(lm_backend=lm))
        proc = run_hidden(
            [str(py), str(script), str(req_path)],
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            env=env,
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
