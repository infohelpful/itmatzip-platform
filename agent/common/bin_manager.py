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

# torchcodec는 avcodec*.dll 등 shared FFmpeg가 필요합니다. gpl(정적) 빌드는 DLL이 없습니다.
DEFAULT_FFMPEG_BUNDLE_URL = (
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
    "ffmpeg-master-latest-win64-gpl-shared.zip"
)
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
    if any(legacy.glob("*.dll")):
        _publish_ffmpeg_runtime_files(legacy)
    else:
        target.mkdir(parents=True, exist_ok=True)
        shutil.copy2(leg_ff, get_ffmpeg_exe())
        shutil.copy2(leg_fp, get_ffprobe_exe())


def _adopt_system_path_binaries() -> None:
    """
    에이전트 전용 폴더가 비어 있으면 시스템 PATH의 ffmpeg/ffprobe를 가져와 복사합니다.
    오프라인 환경 등에서 번들 다운로드가 막힌 경우의 안전한 폴백입니다.
    """
    if _ffmpeg_runtime_complete():
        return
    ffmpeg_on_path = shutil.which("ffmpeg")
    ffprobe_on_path = shutil.which("ffprobe")
    if not ffmpeg_on_path or not ffprobe_on_path:
        return
    _publish_ffmpeg_runtime_files(Path(ffmpeg_on_path).parent)


def _ffmpeg_runtime_complete() -> bool:
    """torchcodec/Demucs가 로드하는 FFmpeg shared DLL(avcodec 등)이 bin에 있는지 확인."""
    bin_root = get_bin_root()
    if not get_ffmpeg_exe().is_file() or not get_ffprobe_exe().is_file():
        return False
    return any(bin_root.glob("*.dll"))


def _publish_ffmpeg_runtime_files(source_dir: Path) -> None:
    """ffmpeg.exe가 있는 폴더의 exe·dll을 agent bin으로 복사 (torchcodec용 DLL 포함)."""
    bin_root = get_bin_root()
    bin_root.mkdir(parents=True, exist_ok=True)
    if not source_dir.is_dir():
        raise FileNotFoundError(f"FFmpeg source dir missing: {source_dir}")
    copied = 0
    for item in source_dir.iterdir():
        if not item.is_file():
            continue
        ext = item.suffix.lower()
        if ext not in {".exe", ".dll"}:
            continue
        shutil.copy2(item, bin_root / item.name)
        copied += 1
    if not get_ffmpeg_exe().is_file() or not get_ffprobe_exe().is_file():
        raise FileNotFoundError(
            f"ffmpeg/ffprobe not found after publishing from {source_dir}",
        )
    if not any(bin_root.glob("*.dll")):
        raise FileNotFoundError(
            f"FFmpeg DLL not found in {source_dir}. torchcodec requires avcodec*.dll next to ffmpeg.exe.",
        )


def prepend_ffmpeg_bin_to_env(env: dict[str, str]) -> str:
    """Demucs/torchcodec subprocess용 PATH 앞에 FFmpeg bin을 붙입니다."""
    bin_dir = str(get_bin_root())
    old = env.get("PATH", "")
    parts = [p for p in old.split(os.pathsep) if p]
    if bin_dir not in parts:
        parts.insert(0, bin_dir)
    new_path = os.pathsep.join(parts)
    env["PATH"] = new_path
    return new_path


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
    _adopt_system_path_binaries()
    bin_root = get_bin_root()
    bin_root.mkdir(parents=True, exist_ok=True)
    ffmpeg_exe = get_ffmpeg_exe()
    ffprobe_exe = get_ffprobe_exe()

    if _ffmpeg_runtime_complete():
        return ffmpeg_exe

    # 예전 static(gpl) 설치: exe만 있고 DLL 없음 → shared 번들로 다시 받기
    if get_ffmpeg_exe().is_file() and not any(bin_root.glob("*.dll")):
        for stale in bin_root.iterdir():
            if stale.is_file():
                stale.unlink(missing_ok=True)
        stale_archive = bin_root / _bundle_archive_name
        if stale_archive.is_file():
            stale_archive.unlink(missing_ok=True)

    _clear_stale_download_lock()

    url = bundle_url or FFMPEG_BUNDLE_URL
    deadline = time.monotonic() + 120.0
    held_lock = False

    while time.monotonic() < deadline:
        if _ffmpeg_runtime_complete():
            return ffmpeg_exe
        if _try_acquire_download_lock():
            held_lock = True
            break
        time.sleep(0.2)
        _clear_stale_download_lock()

    if not held_lock:
        if _ffmpeg_runtime_complete():
            return ffmpeg_exe
        raise TimeoutError("FFmpeg 다운로드 잠금을 획득하지 못했습니다. 잠시 후 다시 시도하세요.")

    try:
        if _ffmpeg_runtime_complete():
            return ffmpeg_exe

        archive_path = bin_root / _bundle_archive_name
        extract_dir = bin_root / _extract_dir_name

        if extract_dir.exists():
            shutil.rmtree(extract_dir, ignore_errors=True)
        extract_dir.mkdir(parents=True, exist_ok=True)

        _download_file(url, archive_path, timeout_sec=download_timeout_sec)
        _extract_zip_safe(archive_path, extract_dir)

        runtime_dir = _find_ffmpeg_shared_runtime_dir(extract_dir)
        if runtime_dir is None:
            raise FileNotFoundError(
                "압축 해제 후 shared FFmpeg(avcodec*.dll + ffmpeg.exe)를 찾지 못했습니다. "
                f"win64-gpl-shared 번들 URL인지 확인하세요: {url}"
            )

        found_ffmpeg = runtime_dir / "ffmpeg.exe"
        found_probe = runtime_dir / "ffprobe.exe"
        if not found_probe.is_file():
            found_probe = _find_ffprobe_beside_or_under(found_ffmpeg, extract_dir)
        if not found_probe:
            raise FileNotFoundError(
                f"압축 해제 후 ffprobe.exe를 찾지 못했습니다. 동일 번들에 ffprobe가 포함되어 있는지 확인하세요: {url}"
            )

        _publish_ffmpeg_runtime_files(runtime_dir)

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


def _find_ffmpeg_shared_runtime_dir(root: Path) -> Path | None:
    """ffmpeg.exe와 같은 폴더에 *.dll이 있는 경로 (BtbN gpl-shared 등)."""
    candidates: list[Path] = []
    for ffmpeg in root.rglob("ffmpeg.exe"):
        parent = ffmpeg.parent
        if any(parent.glob("*.dll")):
            candidates.append(parent)
    if not candidates:
        return None
    return min(candidates, key=lambda p: len(p.parts))


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
