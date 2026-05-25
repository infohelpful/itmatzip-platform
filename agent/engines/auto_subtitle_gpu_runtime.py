"""Auto Subtitle GPU 런타임 (cuBLAS DLL) — AutoSubtitle Electron gpu-runtime.ts 와 동일 소스."""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable

from common.subprocess_util import no_window_creationflags, run_hidden
from runtime_paths import agent_package_root

PrepareProgressCallback = Callable[[float, str, str], None]

# AutoSubtitle README / index.ts DEFAULT_GPU_DLL_ZIP_URL
DEFAULT_GPU_DLL_ZIP_URL = (
    os.environ.get("ITMATZIP_GPU_DLL_ZIP_URL", "").strip()
    or os.environ.get("AUTOSUB_GPU_DLL_ZIP_URL", "").strip()
    or "https://github.com/infohelpful/1.-AutoSubtitle/releases/download/v1.0.0/runtime_dlls.zip"
)

REQUIRED_DLLS: tuple[str, ...] = ("cublas64_12.dll",)


def _agent_data_root() -> Path:
    data = os.environ.get("ITMATZIP_AGENT_DATA", "").strip()
    if data:
        return Path(data)
    appdata = os.environ.get("APPDATA", "").strip()
    if appdata:
        return Path(appdata) / "ItMatZip"
    return Path.home() / ".itmatzip"


def gpu_runtime_dir() -> Path:
    return _agent_data_root() / "auto-subtitle" / "dll"


def is_gpu_runtime_installed() -> bool:
    directory = gpu_runtime_dir()
    return all((directory / name).is_file() for name in REQUIRED_DLLS)


def _has_required_dlls(directory: Path) -> bool:
    return all((directory / name).is_file() for name in REQUIRED_DLLS)


def _find_directory_containing_required_dlls(root_dir: Path) -> Path | None:
    stack = [root_dir]
    while stack:
        current = stack.pop()
        if _has_required_dlls(current):
            return current
        try:
            entries = list(current.iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.is_dir():
                stack.append(entry)
    return None


def local_dll_candidates() -> list[Path]:
    """로컬 복사 후보 (MSI·개발 트리·AutoSubtitle 소스 dll 폴더)."""
    candidates: list[Path] = []
    install = os.environ.get("ITMATZIP_AGENT_INSTALL_ROOT", "").strip()
    if install:
        candidates.append(Path(install) / "dll")
    try:
        candidates.append(agent_package_root().parent / "dll")
    except RuntimeError:
        pass
    autosub_src = os.environ.get("AUTOSUBTITLE_SOURCE_ROOT", "").strip()
    if autosub_src:
        candidates.append(Path(autosub_src) / "dll")
    dev_hint = Path(r"e:\Develop Program\1. AutoSubtitle\dll")
    if dev_hint.is_dir():
        candidates.append(dev_hint)
    seen: set[str] = set()
    unique: list[Path] = []
    for path in candidates:
        key = str(path.resolve()) if path.exists() else str(path)
        if key in seen:
            continue
        seen.add(key)
        unique.append(path)
    return unique


def _download_headers() -> dict[str, str]:
    headers = {
        "User-Agent": "ItMatZip-Agent-GPU-Runtime/1.0",
        "Accept": "application/octet-stream,*/*",
    }
    token = (
        os.environ.get("ITMATZIP_GPU_DLL_ZIP_TOKEN", "").strip()
        or os.environ.get("AUTOSUB_GPU_DLL_ZIP_TOKEN", "").strip()
        or os.environ.get("GITHUB_TOKEN", "").strip()
        or os.environ.get("GH_TOKEN", "").strip()
    )
    auth = os.environ.get("ITMATZIP_GPU_DLL_ZIP_AUTH", "").strip() or os.environ.get(
        "AUTOSUB_GPU_DLL_ZIP_AUTH", ""
    ).strip()
    if auth:
        headers["Authorization"] = auth
    elif token:
        headers["Authorization"] = f"token {token}"
    return headers


def _download_file(
    url: str,
    dest: Path,
    *,
    timeout_sec: float = 600.0,
    on_progress: PrepareProgressCallback | None = None,
    progress_label: str = "GPU 런타임",
    progress_base: float = 2.0,
    progress_span: float = 53.0,
) -> None:
    dest_part = dest.with_suffix(dest.suffix + ".part")
    request = urllib.request.Request(url, headers=_download_headers(), method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout_sec) as response:
            total = int(response.headers.get("Content-Length") or 0)
            downloaded = 0
            chunk_size = 256 * 1024
            with dest_part.open("wb") as out:
                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    out.write(chunk)
                    downloaded += len(chunk)
                    if on_progress is not None:
                        if total > 0:
                            ratio = min(1.0, downloaded / total)
                            pct = progress_base + ratio * progress_span
                            mb_done = downloaded / (1024 * 1024)
                            mb_total = total / (1024 * 1024)
                            on_progress(
                                pct,
                                progress_label,
                                f"다운로드 {mb_done:.1f}/{mb_total:.1f} MB ({ratio * 100:.0f}%)",
                            )
                        else:
                            mb_done = downloaded / (1024 * 1024)
                            on_progress(
                                progress_base + progress_span * 0.5,
                                progress_label,
                                f"다운로드 {mb_done:.1f} MB…",
                            )
        os.replace(dest_part, dest)
    except (urllib.error.URLError, OSError) as exc:
        try:
            dest_part.unlink(missing_ok=True)  # type: ignore[arg-type]
        except OSError:
            pass
        raise RuntimeError(f"GPU 런타임 다운로드 실패: {url}") from exc


def _extract_zip_windows(zip_path: Path, out_dir: Path) -> None:
    if sys.platform == "win32":
        script = (
            f"Expand-Archive -LiteralPath '{str(zip_path).replace(chr(39), chr(39)*2)}' "
            f"-DestinationPath '{str(out_dir).replace(chr(39), chr(39)*2)}' -Force"
        )
        proc = run_hidden(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=300,
        )
        if proc.returncode == 0:
            return
        err = (proc.stderr or proc.stdout or "").strip()
        if err:
            raise RuntimeError(f"GPU ZIP 압축 해제 실패: {err}")
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(out_dir)


def _copy_runtime_dlls(source_dir: Path, target_dir: Path) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    for name in REQUIRED_DLLS:
        src = source_dir / name
        if not src.is_file():
            raise FileNotFoundError(f"필수 GPU DLL 없음: {src}")
        dest = target_dir / name
        for attempt in range(8):
            try:
                shutil.copy2(src, dest)
                break
            except OSError:
                if attempt >= 7:
                    raise
                time.sleep(0.35 * (attempt + 1))
    for entry in source_dir.iterdir():
        if not entry.is_file() or entry.suffix.lower() != ".dll":
            continue
        if entry.name in REQUIRED_DLLS:
            continue
        try:
            shutil.copy2(entry, target_dir / entry.name)
        except OSError:
            pass


def install_gpu_runtime(
    on_progress: PrepareProgressCallback | None = None,
    *,
    zip_url: str | None = None,
) -> dict[str, object]:
    """
    AutoSubtitle runtime_dlls.zip 과 동일 방식으로 cuBLAS DLL 설치.
    반환: {source: 'existing'|'local'|'download', dir: str}
    """
    def report(pct: float, step: str, detail: str = "") -> None:
        if on_progress is not None:
            on_progress(max(0.0, min(100.0, pct)), step, detail)

    target = gpu_runtime_dir()
    target.mkdir(parents=True, exist_ok=True)

    if is_gpu_runtime_installed():
        report(100.0, "GPU 런타임", "이미 설치됨")
        return {"source": "existing", "dir": str(target.resolve())}

    for local in local_dll_candidates():
        if local.is_dir() and _has_required_dlls(local):
            report(20.0, "GPU 런타임", f"로컬 DLL 복사 · {local}")
            _copy_runtime_dlls(local, target)
            if not is_gpu_runtime_installed():
                raise RuntimeError("로컬 GPU DLL 복사 후 검증에 실패했습니다.")
            report(100.0, "GPU 런타임", "로컬 복사 완료")
            return {"source": "local", "dir": str(target.resolve())}

    url = (zip_url or DEFAULT_GPU_DLL_ZIP_URL).strip()
    if not url:
        raise RuntimeError(
            "GPU 런타임 ZIP URL이 없습니다. ITMATZIP_GPU_DLL_ZIP_URL 환경 변수를 설정하세요."
        )

    report(2.0, "GPU 런타임", "runtime_dlls.zip 다운로드")
    base_tmp = Path(tempfile.mkdtemp(prefix="itmatzip-gpu-"))
    zip_path = base_tmp / "runtime_dlls.zip"
    extracted = base_tmp / "expanded"
    extracted.mkdir(parents=True, exist_ok=True)
    try:
        _download_file(
            url,
            zip_path,
            timeout_sec=900.0,
            on_progress=on_progress,
            progress_label="GPU 런타임",
            progress_base=2.0,
            progress_span=53.0,
        )
        report(55.0, "GPU 런타임", "압축 해제")
        _extract_zip_windows(zip_path, extracted)
        source_dir = _find_directory_containing_required_dlls(extracted)
        if source_dir is None:
            raise RuntimeError(
                "다운로드한 ZIP에서 cublas64_12.dll 을 찾지 못했습니다. "
                "릴리스 에셋 runtime_dlls.zip 을 확인하세요."
            )
        report(80.0, "GPU 런타임", "DLL 설치 경로로 복사")
        _copy_runtime_dlls(source_dir, target)
        if not is_gpu_runtime_installed():
            raise RuntimeError("GPU 런타임 설치 후 필수 DLL 검증에 실패했습니다.")
        report(100.0, "GPU 런타임", "다운로드 설치 완료")
        return {"source": "download", "dir": str(target.resolve()), "zip_url": url}
    finally:
        shutil.rmtree(base_tmp, ignore_errors=True)


def gpu_runtime_status() -> dict[str, object]:
    zip_url = DEFAULT_GPU_DLL_ZIP_URL
    return {
        "installed": is_gpu_runtime_installed(),
        "dll_dir": str(gpu_runtime_dir().resolve()),
        "nvidia_gpu": False,  # filled by caller
        "zip_url": zip_url,
        "zip_url_configured": bool(zip_url),
        "local_candidates": [str(p) for p in local_dll_candidates()],
    }
