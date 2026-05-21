"""
FFmpeg가 있는지 확인하고 없으면 다운로드하는 '설치 관리자' 역할을 합니다.

모든 엔진은 `get_ffmpeg_executable()` / `get_ffprobe_executable()` 또는 `ensure_ffmpeg()`로 준비된 경로를 사용하세요.
"""

from __future__ import annotations

import os
import shutil
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

# 프로덕션 배포 시 실제 번들 URL로 교체하세요. 로컬 테스트는 환경 변수로 덮어쓸 수 있습니다.
DEFAULT_FFMPEG_BUNDLE_URL = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
FFMPEG_BUNDLE_URL = os.environ.get("ITMATZIP_FFMPEG_URL", DEFAULT_FFMPEG_BUNDLE_URL)

_STALE_LOCK_SEC = 600.0
_bundle_archive_name = "ffmpeg_bundle.zip"
_extract_dir_name = "_ffmpeg_extract"


def _resolve_bin_root() -> Path:
    data = os.environ.get("ITMATZIP_AGENT_DATA", "").strip()
    if data:
        return Path(data) / "bin"
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "ItMatZip" / "bin"
    raise RuntimeError(
        "APPDATA 또는 ITMATZIP_AGENT_DATA가 없습니다. Windows에서 에이전트를 실행해 주세요."
    )


def get_bin_root() -> Path:
    """현재 환경 변수 기준 FFmpeg 설치 폴더 (모듈 import 시점이 아닌 호출 시점에 결정)."""
    return _resolve_bin_root()


def get_ffmpeg_exe() -> Path:
    return get_bin_root() / "ffmpeg.exe"


def get_ffprobe_exe() -> Path:
    return get_bin_root() / "ffprobe.exe"


def get_download_lock() -> Path:
    return get_bin_root() / ".ffmpeg_download.lock"


def _legacy_appdata_bin() -> Path | None:
    appdata = os.environ.get("APPDATA", "").strip()
    if not appdata:
        return None
    return Path(appdata) / "ItMatZip" / "bin"


def _migrate_legacy_binaries() -> None:
    """MSI(ProgramData) 이전에 %APPDATA%\\ItMatZip\\bin 에 받아 둔 경우 새 경로로 복사."""
    target = get_bin_root()
    if get_ffmpeg_exe().is_file() and get_ffprobe_exe().is_file():
        return
    legacy = _legacy_appdata_bin()
    if legacy is None or legacy.resolve() == target.resolve():
        return
    leg_ff = legacy / "ffmpeg.exe"
    leg_fp = legacy / "ffprobe.exe"
    if not (leg_ff.is_file() and leg_fp.is_file()):
        return
    target.mkdir(parents=True, exist_ok=True)
    shutil.copy2(leg_ff, get_ffmpeg_exe())
    shutil.copy2(leg_fp, get_ffprobe_exe())


def get_ffmpeg_executable() -> Path:
    """엔진에서 FFmpeg 실행 파일 경로가 필요할 때 사용합니다. 사전에 `ensure_ffmpeg()`가 성공한 상태여야 합니다."""
    path = get_ffmpeg_exe()
    if not path.is_file():
        raise FileNotFoundError(
            f"FFmpeg가 준비되지 않았습니다: {path}. POST /api/tools/silence-remover/prepare 를 호출했는지 확인하세요."
        )
    return path


def get_ffprobe_executable() -> Path:
    """ffprobe 실행 파일 경로입니다. `ensure_ffmpeg()`가 번들에서 `ffmpeg.exe`와 함께 설치합니다."""
    path = get_ffprobe_exe()
    if not path.is_file():
        raise FileNotFoundError(
            f"ffprobe가 준비되지 않았습니다: {path}. ensure_ffmpeg()로 번들을 다시 설치해 주세요."
        )
    return path


def _clear_stale_download_lock() -> None:
    lock = get_download_lock()
    if not lock.is_file():
        return
    try:
        age = time.time() - lock.stat().st_mtime
    except OSError:
        return
    if age >= _STALE_LOCK_SEC:
        _release_download_lock()


def ensure_ffmpeg(
    *,
    bundle_url: str | None = None,
    download_timeout_sec: float = 120.0,
) -> Path:
    """
    `ITMATZIP_AGENT_DATA/bin` 또는 `%APPDATA%/ItMatZip/bin/`에 ffmpeg·ffprobe를 둡니다.
    없으면 zip 번들을 내려받아 설치합니다.
    """
    _migrate_legacy_binaries()
    bin_root = get_bin_root()
    bin_root.mkdir(parents=True, exist_ok=True)
    ffmpeg_exe = get_ffmpeg_exe()
    ffprobe_exe = get_ffprobe_exe()

    if ffmpeg_exe.is_file() and ffprobe_exe.is_file():
        return ffmpeg_exe

    _clear_stale_download_lock()

    url = bundle_url or FFMPEG_BUNDLE_URL
    deadline = time.monotonic() + 120.0
    held_lock = False

    while time.monotonic() < deadline:
        if ffmpeg_exe.is_file() and ffprobe_exe.is_file():
            return ffmpeg_exe
        if _try_acquire_download_lock():
            held_lock = True
            break
        time.sleep(0.2)
        _clear_stale_download_lock()

    if not held_lock:
        if ffmpeg_exe.is_file() and ffprobe_exe.is_file():
            return ffmpeg_exe
        raise TimeoutError("FFmpeg 다운로드 잠금을 획득하지 못했습니다. 잠시 후 다시 시도하세요.")

    try:
        if ffmpeg_exe.is_file() and ffprobe_exe.is_file():
            return ffmpeg_exe

        archive_path = bin_root / _bundle_archive_name
        extract_dir = bin_root / _extract_dir_name

        if extract_dir.exists():
            shutil.rmtree(extract_dir, ignore_errors=True)
        extract_dir.mkdir(parents=True, exist_ok=True)

        _download_file(url, archive_path, timeout_sec=download_timeout_sec)
        _extract_zip_safe(archive_path, extract_dir)

        found_ffmpeg = _find_ffmpeg_under(extract_dir)
        if not found_ffmpeg:
            raise FileNotFoundError(
                f"압축 해제 후 ffmpeg.exe를 찾지 못했습니다. URL/번들 형식을 확인하세요: {url}"
            )

        found_probe = _find_ffprobe_beside_or_under(found_ffmpeg, extract_dir)
        if not found_probe:
            raise FileNotFoundError(
                f"압축 해제 후 ffprobe.exe를 찾지 못했습니다. 동일 번들에 ffprobe가 포함되어 있는지 확인하세요: {url}"
            )

        shutil.copy2(found_ffmpeg, ffmpeg_exe)
        shutil.copy2(found_probe, ffprobe_exe)

        try:
            archive_path.unlink(missing_ok=True)  # type: ignore[arg-type]
        except OSError:
            pass
        shutil.rmtree(extract_dir, ignore_errors=True)

        return ffmpeg_exe
    finally:
        if held_lock:
            _release_download_lock()


def _try_acquire_download_lock() -> bool:
    bin_root = get_bin_root()
    bin_root.mkdir(parents=True, exist_ok=True)
    lock = get_download_lock()
    try:
        fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.close(fd)
        return True
    except FileExistsError:
        return False


def _release_download_lock() -> None:
    try:
        get_download_lock().unlink(missing_ok=True)  # type: ignore[arg-type]
    except OSError:
        pass


def _download_file(url: str, dest: Path, *, timeout_sec: float) -> None:
    dest_part = dest.with_suffix(dest.suffix + ".part")
    try:
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "ItMatZip-Agent/1.0"},
            method="GET",
        )
        with urllib.request.urlopen(request, timeout=timeout_sec) as response:
            with dest_part.open("wb") as out:
                shutil.copyfileobj(response, out, length=1024 * 256)
        os.replace(dest_part, dest)
    except (urllib.error.URLError, OSError) as e:
        try:
            dest_part.unlink(missing_ok=True)  # type: ignore[arg-type]
        except OSError:
            pass
        raise RuntimeError(f"FFmpeg 번들 다운로드에 실패했습니다: {url}") from e


def _extract_zip_safe(archive: Path, dest: Path) -> None:
    dest_root = dest.resolve()
    with zipfile.ZipFile(archive, "r") as zf:
        for info in zf.infolist():
            member_path = Path(info.filename)
            if member_path.is_absolute():
                raise ValueError(f"압축 파일에 절대 경로가 포함되어 있습니다: {info.filename}")
            target = (dest / member_path).resolve()
            if not _is_within_directory(target, dest_root):
                raise ValueError(f"Zip slip 의심 경로: {info.filename}")
        zf.extractall(dest)


def _is_within_directory(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _find_ffmpeg_under(root: Path) -> Path | None:
    for p in root.rglob("ffmpeg.exe"):
        if p.is_file():
            return p
    return None


def _find_ffprobe_beside_or_under(ffmpeg_path: Path, extract_root: Path) -> Path | None:
    """번들에서 ffmpeg와 같은 디렉터리의 ffprobe.exe를 우선 찾고, 없으면 압축 루트 이하를 검색합니다."""
    beside = ffmpeg_path.parent / "ffprobe.exe"
    if beside.is_file():
        return beside
    for p in extract_root.rglob("ffprobe.exe"):
        if p.is_file():
            return p
    return None


# --- 하위 호환: 기존 `from common.bin_manager import FFMPEG_EXE, FFPROBE_EXE, BIN_ROOT` ---

def __getattr__(name: str):
    if name == "BIN_ROOT":
        return get_bin_root()
    if name == "FFMPEG_EXE":
        return get_ffmpeg_exe()
    if name == "FFPROBE_EXE":
        return get_ffprobe_exe()
    raise AttributeError(name)
