"""
FFmpeg가 있는지 확인하고 없으면 다운로드하는 '설치 관리자' 역할을 합니다.

모든 엔진은 `get_ffmpeg_executable()` / `get_ffprobe_executable()` 또는 `ensure_ffmpeg()`로 준비된 경로를 사용하세요.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

# torchcodec는 avcodec*.dll 등 shared FFmpeg가 필요합니다. gpl(정적) 빌드는 DLL이 없습니다.
# BtbN는 /latest/ffmpeg-master-latest-*.zip 고정 URL을 더 이상 제공하지 않음 → GitHub API로 조회.
_GITHUB_FFMPEG_RELEASES_API = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest"
_FFMPEG_URL_CACHE_FILE = ".ffmpeg_release_urls.json"
_FFMPEG_URL_CACHE_TTL_SEC = 6 * 3600.0
# 레거시 호환 — ITMATZIP_FFMPEG_URL 미설정 시 API 결과 사용.
DEFAULT_FFMPEG_BUNDLE_URL = _GITHUB_FFMPEG_RELEASES_API
FFMPEG_BUNDLE_URL = os.environ.get("ITMATZIP_FFMPEG_URL", "").strip()
FFMPEG_BUNDLE_URL_FALLBACKS: tuple[str, ...] = ()

_STALE_LOCK_SEC = 600.0
_DEFAULT_DOWNLOAD_TIMEOUT_SEC = 900.0
_DOWNLOAD_MAX_ATTEMPTS = 3
_CONNECT_TIMEOUT_SEC = 60.0
_READ_TIMEOUT_SEC = 180.0
_STALL_IDLE_SEC = 300.0
_MIN_ARCHIVE_BYTES = 25 * 1024 * 1024
_bundle_archive_name = "ffmpeg_bundle.zip"
_extract_dir_name = "_ffmpeg_extract"
_FFMPEG_SHARED_SUBDIR = "gpl-shared"


def is_file_locked_error(exc: BaseException) -> bool:
    if isinstance(exc, PermissionError):
        return True
    winerr = getattr(exc, "winerror", None)
    return winerr == 32


def _copy2_with_retry(src: Path, dst: Path, *, retries: int = 8) -> None:
    last: BaseException | None = None
    for attempt in range(retries):
        try:
            shutil.copy2(src, dst)
            return
        except OSError as exc:
            last = exc
            if not is_file_locked_error(exc):
                raise
            time.sleep(0.35 * (attempt + 1))
    if last:
        raise last


def get_ffmpeg_shared_dir() -> Path:
    """실행 중인 구형 ffmpeg.exe와 분리된 shared DLL 런타임 폴더."""
    return get_bin_root() / _FFMPEG_SHARED_SUBDIR


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
    if _ffmpeg_shared_runtime_complete():
        return get_ffmpeg_shared_dir() / "ffmpeg.exe"
    return get_bin_root() / "ffmpeg.exe"


def get_ffprobe_exe() -> Path:
    if _ffmpeg_shared_runtime_complete():
        return get_ffmpeg_shared_dir() / "ffprobe.exe"
    return get_bin_root() / "ffprobe.exe"


def get_download_lock() -> Path:
    return get_bin_root() / ".ffmpeg_download.lock"


def is_ffmpeg_ready() -> bool:
    """ffmpeg·ffprobe·shared DLL이 준비됐는지 (다운로드 없이 확인)."""
    return _ffmpeg_runtime_complete()


def _ffmpeg_download_urls(*, force_refresh: bool = False) -> list[str]:
    urls: list[str] = []
    env_url = os.environ.get("ITMATZIP_FFMPEG_URL", "").strip()
    if env_url:
        urls.append(env_url)

    api_urls: list[str] = []
    if not force_refresh:
        api_urls = _read_ffmpeg_url_cache()
    if not api_urls:
        try:
            api_urls = _fetch_ffmpeg_urls_from_github_api()
            if api_urls:
                _write_ffmpeg_url_cache(api_urls)
        except Exception:
            api_urls = _read_ffmpeg_url_cache(ignore_ttl=True)

    for candidate in api_urls:
        if candidate and candidate not in urls:
            urls.append(candidate)
    return urls


def _ffmpeg_url_cache_path() -> Path:
    return get_bin_root() / _FFMPEG_URL_CACHE_FILE


def _read_ffmpeg_url_cache(*, ignore_ttl: bool = False) -> list[str]:
    path = _ffmpeg_url_cache_path()
    if not path.is_file():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        fetched_at = float(payload.get("fetched_at") or 0)
        if not ignore_ttl and fetched_at > 0:
            if time.time() - fetched_at > _FFMPEG_URL_CACHE_TTL_SEC:
                return []
        urls = payload.get("urls") or []
        return [str(u).strip() for u in urls if str(u).strip()]
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return []


def _write_ffmpeg_url_cache(urls: list[str], *, tag: str = "") -> None:
    path = _ffmpeg_url_cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "tag": tag,
        "fetched_at": time.time(),
        "urls": urls,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _rank_ffmpeg_asset_name(name: str) -> tuple[int, str]:
    """낮을수록 우선 — n7.1 stable → n8.1 → master(N-)."""
    n = name.lower()
    if "win64-gpl-shared" not in n or not n.endswith(".zip"):
        return (99, name)
    if "-n7.1" in n or n.startswith("ffmpeg-n7.1"):
        return (0, name)
    if "-n8.1" in n or n.startswith("ffmpeg-n8.1"):
        return (1, name)
    if n.startswith("ffmpeg-n-"):
        return (2, name)
    return (3, name)


def _fetch_ffmpeg_urls_from_github_api() -> list[str]:
    """BtbN FFmpeg-Builds latest release에서 win64-gpl-shared zip URL 목록."""
    request = urllib.request.Request(
        _GITHUB_FFMPEG_RELEASES_API,
        headers={
            "User-Agent": "ItMatZip-Agent/1.0 (FFmpeg bootstrap)",
            "Accept": "application/vnd.github+json",
        },
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        data = json.loads(response.read().decode("utf-8"))

    tag = str(data.get("tag_name") or "").strip()
    assets: list[tuple[str, str]] = []
    for asset in data.get("assets") or []:
        name = str(asset.get("name") or "").strip()
        url = str(asset.get("browser_download_url") or "").strip()
        if not url or not name:
            continue
        if "win64-gpl-shared" not in name.lower() or not name.lower().endswith(".zip"):
            continue
        assets.append((name, url))

    if not assets:
        raise RuntimeError("GitHub release에 win64-gpl-shared zip asset이 없습니다.")

    assets.sort(key=lambda item: _rank_ffmpeg_asset_name(item[0]))
    urls = [url for _, url in assets]
    _write_ffmpeg_url_cache(urls, tag=tag)
    return urls


def _install_root_candidates() -> list[Path]:
    roots: list[Path] = []
    install = os.environ.get("ITMATZIP_AGENT_INSTALL_ROOT", "").strip()
    if install:
        roots.append(Path(install))
    return roots


def _vendor_ffmpeg_shared_dir(install_root: Path) -> Path:
    return install_root / "vendor" / "ffmpeg" / _FFMPEG_SHARED_SUBDIR


def bootstrap_ffmpeg_from_install_bundle() -> bool:
    """MSI에 포함된 vendor/ffmpeg/gpl-shared를 ProgramData bin으로 복사 (네트워크 없음)."""
    if _ffmpeg_runtime_complete():
        return True
    bin_root = get_bin_root()
    bin_root.mkdir(parents=True, exist_ok=True)
    for root in _install_root_candidates():
        vendor = _vendor_ffmpeg_shared_dir(root)
        if not vendor.is_dir():
            continue
        if not (vendor / "ffmpeg.exe").is_file() or not (vendor / "ffprobe.exe").is_file():
            continue
        if not any(vendor.glob("*.dll")):
            continue
        try:
            _publish_ffmpeg_runtime_files(vendor)
        except OSError:
            continue
        if _ffmpeg_runtime_complete():
            return True
    return _ffmpeg_runtime_complete()


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
        _publish_ffmpeg_runtime_files(legacy, dest_dir=get_ffmpeg_shared_dir())
    else:
        shared = get_ffmpeg_shared_dir()
        shared.mkdir(parents=True, exist_ok=True)
        _copy2_with_retry(leg_ff, shared / "ffmpeg.exe")
        _copy2_with_retry(leg_fp, shared / "ffprobe.exe")


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
    source_dir = Path(ffmpeg_on_path).resolve().parent
    if not any(source_dir.glob("*.dll")):
        return
    try:
        _publish_ffmpeg_runtime_files(source_dir, dest_dir=get_ffmpeg_shared_dir())
    except FileNotFoundError:
        pass


def _ffmpeg_shared_runtime_complete() -> bool:
    d = get_ffmpeg_shared_dir()
    if not (d / "ffmpeg.exe").is_file() or not (d / "ffprobe.exe").is_file():
        return False
    return any(d.glob("*.dll"))


def _ffmpeg_runtime_complete() -> bool:
    """torchcodec/Demucs가 로드하는 FFmpeg shared DLL(avcodec 등)이 준비됐는지 확인."""
    if _ffmpeg_shared_runtime_complete():
        return True
    bin_root = get_bin_root()
    if not (bin_root / "ffmpeg.exe").is_file() or not (bin_root / "ffprobe.exe").is_file():
        return False
    return any(bin_root.glob("*.dll"))


def _publish_ffmpeg_runtime_files(source_dir: Path, *, dest_dir: Path | None = None) -> None:
    """ffmpeg.exe가 있는 폴더의 exe·dll을 dest_dir(기본 gpl-shared)로 복사."""
    bin_root = dest_dir or get_ffmpeg_shared_dir()
    bin_root.mkdir(parents=True, exist_ok=True)
    if not source_dir.is_dir():
        raise FileNotFoundError(f"FFmpeg source dir missing: {source_dir}")
    files = [item for item in source_dir.iterdir() if item.is_file()]
    dlls = [f for f in files if f.suffix.lower() == ".dll"]
    exes = [f for f in files if f.suffix.lower() == ".exe"]
    copied = 0
    for item in dlls + exes:
        dest = bin_root / item.name
        try:
            _copy2_with_retry(item, dest)
            copied += 1
        except OSError as exc:
            if item.suffix.lower() == ".exe" and is_file_locked_error(exc) and any(bin_root.glob("*.dll")):
                continue
            raise
    if not (bin_root / "ffmpeg.exe").is_file() or not (bin_root / "ffprobe.exe").is_file():
        raise FileNotFoundError(
            f"ffmpeg/ffprobe not found after publishing from {source_dir}",
        )
    if not any(bin_root.glob("*.dll")):
        raise FileNotFoundError(
            f"FFmpeg DLL not found in {source_dir}. torchcodec requires avcodec*.dll next to ffmpeg.exe.",
        )


def prepend_ffmpeg_bin_to_env(env: dict[str, str] | None = None) -> str:
    """Demucs/torchcodec subprocess용 PATH 앞에 FFmpeg bin을 붙입니다."""
    if env is None:
        env = os.environ
    bin_dir = str(get_ffmpeg_shared_dir() if _ffmpeg_shared_runtime_complete() else get_bin_root())
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
        _release_download_lock()
        return

    pid = _read_download_lock_pid(lock)
    part_path = get_bin_root() / f"{_bundle_archive_name}.part"
    part_active = False
    if part_path.is_file():
        try:
            part_active = (time.time() - part_path.stat().st_mtime) < 180.0
        except OSError:
            part_active = False

    if pid is not None and _pid_is_alive(pid):
        if part_active:
            return
        if age < _STALE_LOCK_SEC:
            return
    elif age < 90.0:
        return
    elif age < _STALE_LOCK_SEC and part_active:
        return
    _release_download_lock()


def _read_download_lock_pid(lock: Path) -> int | None:
    try:
        raw = lock.read_text(encoding="utf-8").strip()
        if not raw:
            return None
        return int(raw.split()[0])
    except (OSError, ValueError):
        return None


def _pid_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if sys.platform == "win32":
        import ctypes

        synchronize = 0x00100000
        handle = ctypes.windll.kernel32.OpenProcess(synchronize, False, pid)
        if handle:
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def ensure_ffmpeg(
    *,
    bundle_url: str | None = None,
    download_timeout_sec: float = _DEFAULT_DOWNLOAD_TIMEOUT_SEC,
    on_progress: "PrepareProgressCallback | None" = None,
) -> Path:
    """
    `ITMATZIP_AGENT_DATA/bin` 또는 `%APPDATA%/ItMatZip/bin/`에 ffmpeg·ffprobe를 둡니다.
    없으면 zip 번들을 내려받아 설치합니다.
    """
    _migrate_legacy_binaries()
    _adopt_system_path_binaries()
    bin_root = get_bin_root()
    bin_root.mkdir(parents=True, exist_ok=True)

    if _ffmpeg_runtime_complete():
        return get_ffmpeg_exe()

    if bootstrap_ffmpeg_from_install_bundle():
        return get_ffmpeg_exe()

    # 예전 static(gpl) 설치: exe만 있고 DLL 없음 → gpl-shared/ 로 새로 받기 (bin 루트 exe는 건드리지 않음).
    if (bin_root / "ffmpeg.exe").is_file() and not _ffmpeg_shared_runtime_complete():
        stale_archive = bin_root / _bundle_archive_name
        if stale_archive.is_file():
            try:
                stale_archive.unlink()
            except OSError:
                pass

    _clear_stale_download_lock()

    wait_deadline = time.monotonic() + max(120.0, float(download_timeout_sec))
    held_lock = False

    while time.monotonic() < wait_deadline:
        if _ffmpeg_runtime_complete():
            return get_ffmpeg_exe()
        _clear_stale_download_lock()
        if _try_acquire_download_lock():
            held_lock = True
            break
        time.sleep(0.75)

    if not held_lock:
        if _ffmpeg_runtime_complete():
            return get_ffmpeg_exe()
        raise TimeoutError(
            "FFmpeg 다운로드가 다른 작업에서 진행 중이거나 잠금을 해제하지 못했습니다. "
            "에이전트를 재시작한 뒤 다시 시도하세요."
        )

    try:
        if _ffmpeg_runtime_complete():
            return get_ffmpeg_exe()

        archive_path = bin_root / _bundle_archive_name
        extract_dir = bin_root / _extract_dir_name
        urls = [bundle_url] if bundle_url else _ffmpeg_download_urls()
        urls = [u for u in urls if u]
        errors: list[str] = []
        refreshed_urls = False

        for url in urls:
            for attempt in range(_DOWNLOAD_MAX_ATTEMPTS):
                if _ffmpeg_runtime_complete():
                    return get_ffmpeg_exe()
                try:
                    if extract_dir.exists():
                        shutil.rmtree(extract_dir, ignore_errors=True)
                    extract_dir.mkdir(parents=True, exist_ok=True)

                    if on_progress:
                        label = f"FFmpeg ({attempt + 1}/{_DOWNLOAD_MAX_ATTEMPTS})"
                        on_progress(2.0, "FFmpeg", f"{label} — 번들 다운로드 중…")

                    _download_bundle_with_fallback(
                        url,
                        archive_path,
                        timeout_sec=download_timeout_sec,
                        on_progress=on_progress,
                    )

                    if on_progress:
                        on_progress(4.5, "FFmpeg", "압축 해제 중…")
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
                            f"압축 해제 후 ffprobe.exe를 찾지 못했습니다: {url}"
                        )

                    _publish_ffmpeg_runtime_files(runtime_dir, dest_dir=get_ffmpeg_shared_dir())

                    try:
                        archive_path.unlink(missing_ok=True)  # type: ignore[arg-type]
                    except OSError:
                        pass
                    shutil.rmtree(extract_dir, ignore_errors=True)
                    return get_ffmpeg_exe()
                except Exception as exc:
                    errors.append(f"{url} (시도 {attempt + 1}/{_DOWNLOAD_MAX_ATTEMPTS}): {exc}")
                    if attempt + 1 < _DOWNLOAD_MAX_ATTEMPTS:
                        time.sleep(min(30.0, 2.0**attempt))

        if not refreshed_urls and not bundle_url:
            refreshed_urls = True
            fresh_urls = _ffmpeg_download_urls(force_refresh=True)
            for url in fresh_urls:
                if url in urls:
                    continue
                urls.append(url)
                for attempt in range(_DOWNLOAD_MAX_ATTEMPTS):
                    if _ffmpeg_runtime_complete():
                        return get_ffmpeg_exe()
                    try:
                        if extract_dir.exists():
                            shutil.rmtree(extract_dir, ignore_errors=True)
                        extract_dir.mkdir(parents=True, exist_ok=True)
                        if on_progress:
                            on_progress(2.0, "FFmpeg", "GitHub 최신 URL로 재시도 중…")
                        _download_bundle_with_fallback(
                            url,
                            archive_path,
                            timeout_sec=download_timeout_sec,
                            on_progress=on_progress,
                        )
                        if on_progress:
                            on_progress(4.5, "FFmpeg", "압축 해제 중…")
                        _extract_zip_safe(archive_path, extract_dir)
                        runtime_dir = _find_ffmpeg_shared_runtime_dir(extract_dir)
                        if runtime_dir is None:
                            raise FileNotFoundError(f"shared runtime not found: {url}")
                        _publish_ffmpeg_runtime_files(runtime_dir, dest_dir=get_ffmpeg_shared_dir())
                        try:
                            archive_path.unlink(missing_ok=True)  # type: ignore[arg-type]
                        except OSError:
                            pass
                        shutil.rmtree(extract_dir, ignore_errors=True)
                        return get_ffmpeg_exe()
                    except Exception as exc:
                        errors.append(f"{url} (fresh API, 시도 {attempt + 1}): {exc}")
                        if attempt + 1 < _DOWNLOAD_MAX_ATTEMPTS:
                            time.sleep(min(30.0, 2.0**attempt))

        hint = (
            "네트워크·방화벽·GitHub 접속을 확인하거나, "
            "ITMATZIP_FFMPEG_URL 환경 변수로 미러 URL을 지정해 주세요."
        )
        raise RuntimeError(
            "FFmpeg 자동 설치에 실패했습니다.\n"
            + "\n".join(errors[-6:])
            + f"\n{hint}"
        )
    finally:
        if held_lock:
            _release_download_lock()


def _try_acquire_download_lock() -> bool:
    bin_root = get_bin_root()
    bin_root.mkdir(parents=True, exist_ok=True)
    lock = get_download_lock()
    if lock.is_file():
        pid = _read_download_lock_pid(lock)
        if pid is not None and _pid_is_alive(pid):
            return False
        _release_download_lock()
    try:
        fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        try:
            os.write(fd, f"{os.getpid()} {time.time():.0f}\n".encode("ascii"))
        finally:
            os.close(fd)
        return True
    except FileExistsError:
        return False


def _release_download_lock() -> None:
    try:
        get_download_lock().unlink(missing_ok=True)  # type: ignore[arg-type]
    except OSError:
        pass


def _download_bundle_with_fallback(
    url: str,
    dest: Path,
    *,
    timeout_sec: float,
    on_progress: "PrepareProgressCallback | None" = None,
) -> None:
    try:
        _download_file(
            url,
            dest,
            timeout_sec=timeout_sec,
            on_progress=on_progress,
            progress_label="FFmpeg",
            progress_base=2.0,
            progress_span=3.0,
        )
        return
    except Exception as urllib_err:
        if sys.platform != "win32":
            raise
        try:
            if on_progress:
                on_progress(3.0, "FFmpeg", "curl로 재시도 중…")
            _download_file_curl(url, dest, timeout_sec=timeout_sec)
        except Exception as curl_err:
            raise RuntimeError(
                f"urllib 다운로드 실패: {urllib_err}; curl 재시도 실패: {curl_err}"
            ) from curl_err


def _download_file_curl(url: str, dest: Path, *, timeout_sec: float) -> None:
    curl = shutil.which("curl") or shutil.which("curl.exe")
    if not curl:
        raise RuntimeError("curl.exe를 찾을 수 없습니다.")
    dest_part = dest.with_suffix(dest.suffix + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)
    max_time = max(120, int(timeout_sec))
    args = [
        curl,
        "-L",
        "--fail",
        "--retry",
        "5",
        "--retry-delay",
        "3",
        "--retry-all-errors",
        "--connect-timeout",
        str(int(_CONNECT_TIMEOUT_SEC)),
        "--max-time",
        str(max_time),
        "-C",
        "-",
        "-o",
        str(dest_part),
        "-A",
        "ItMatZip-Agent/1.0 (Windows; FFmpeg bundle)",
        url,
    ]
    try:
        proc = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=max_time + 120,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"curl 다운로드 시간 초과 ({max_time}s): {url}") from exc
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()
        if len(tail) > 800:
            tail = tail[-800:]
        raise RuntimeError(f"curl exit {proc.returncode}: {tail or url}")
    if not dest_part.is_file() or dest_part.stat().st_size < _MIN_ARCHIVE_BYTES:
        raise RuntimeError(
            f"curl 다운로드 크기 비정상 ({dest_part.stat().st_size if dest_part.is_file() else 0} bytes)"
        )
    for attempt in range(8):
        try:
            os.replace(dest_part, dest)
            return
        except OSError as exc:
            if not is_file_locked_error(exc) or attempt >= 7:
                raise
            time.sleep(0.35 * (attempt + 1))


def _download_file(
    url: str,
    dest: Path,
    *,
    timeout_sec: float,
    on_progress: "PrepareProgressCallback | None" = None,
    progress_label: str = "다운로드",
    progress_base: float = 0.0,
    progress_span: float = 100.0,
) -> None:
    dest_part = dest.with_suffix(dest.suffix + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)
    resume_from = dest_part.stat().st_size if dest_part.is_file() else 0
    if resume_from > 0 and resume_from < _MIN_ARCHIVE_BYTES:
        # 깨진 partial — 처음부터
        try:
            dest_part.unlink(missing_ok=True)  # type: ignore[arg-type]
        except OSError:
            pass
        resume_from = 0

    read_timeout = max(_READ_TIMEOUT_SEC, min(300.0, timeout_sec * 0.25))
    deadline = time.monotonic() + max(timeout_sec, _DEFAULT_DOWNLOAD_TIMEOUT_SEC * 0.5)
    stall_deadline = time.monotonic() + _STALL_IDLE_SEC

    headers = {"User-Agent": "ItMatZip-Agent/1.0 (Windows; FFmpeg bundle)"}
    if resume_from > 0:
        headers["Range"] = f"bytes={resume_from}-"

    try:
        request = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(request, timeout=read_timeout) as response:
            status = int(getattr(response, "status", None) or response.getcode())
            if status == 416 and resume_from > 0:
                if dest_part.stat().st_size >= _MIN_ARCHIVE_BYTES:
                    os.replace(dest_part, dest)
                    return
                resume_from = 0
                try:
                    dest_part.unlink(missing_ok=True)  # type: ignore[arg-type]
                except OSError:
                    pass
                raise RuntimeError("부분 다운로드 파일이 손상되었습니다. 다시 시도합니다.")

            total = int(response.headers.get("Content-Length") or 0)
            content_range = response.headers.get("Content-Range") or ""
            if status == 206 and "/" in content_range:
                try:
                    total = int(content_range.rsplit("/", 1)[-1])
                except ValueError:
                    pass
            elif status == 200 and resume_from > 0:
                resume_from = 0
                try:
                    dest_part.unlink(missing_ok=True)  # type: ignore[arg-type]
                except OSError:
                    pass

            downloaded = resume_from
            last_reported_pct = -1.0
            chunk_size = 512 * 1024
            mode = "ab" if resume_from > 0 else "wb"
            with dest_part.open(mode) as out:
                while True:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(
                            f"다운로드 전체 시간 초과 ({int(timeout_sec)}s): {url}"
                        )
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    out.write(chunk)
                    downloaded += len(chunk)
                    stall_deadline = time.monotonic() + _STALL_IDLE_SEC
                    if on_progress is not None:
                        if total > 0:
                            ratio = min(1.0, downloaded / total)
                            pct = progress_base + ratio * progress_span
                            if pct - last_reported_pct >= 0.5 or ratio >= 1.0:
                                last_reported_pct = pct
                                mb_done = downloaded / (1024 * 1024)
                                mb_total = total / (1024 * 1024)
                                on_progress(
                                    pct,
                                    progress_label,
                                    f"다운로드 {mb_done:.0f}/{mb_total:.0f} MB ({ratio * 100:.0f}%)",
                                )
                        elif downloaded % (2 * 1024 * 1024) < chunk_size:
                            mb_done = downloaded / (1024 * 1024)
                            on_progress(
                                progress_base + progress_span * 0.5,
                                progress_label,
                                f"다운로드 {mb_done:.0f} MB…",
                            )

        if not dest_part.is_file() or dest_part.stat().st_size < _MIN_ARCHIVE_BYTES:
            raise RuntimeError(
                f"다운로드 파일 크기 비정상 ({dest_part.stat().st_size if dest_part.is_file() else 0} bytes): {url}"
            )

        for attempt in range(8):
            try:
                os.replace(dest_part, dest)
                break
            except OSError as exc:
                if not is_file_locked_error(exc) or attempt >= 7:
                    raise
                time.sleep(0.35 * (attempt + 1))
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        # partial 유지 → 다음 시도에서 Range resume
        raise RuntimeError(
            f"다운로드에 실패했습니다 (연결·읽기 타임아웃 또는 네트워크 오류). "
            f"부분 파일은 보존되며 재시도 시 이어받기합니다: {url}"
        ) from e


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
