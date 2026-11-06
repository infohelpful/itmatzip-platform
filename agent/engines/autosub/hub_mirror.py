"""library-hub mirror for every file the AutoSubtitle engine downloads.

The originals live on PyPI, download.pytorch.org, Hugging Face (personal accounts) and GitHub
(BBC audiowaveform). Any of them can disappear, so a pinned copy of
each one is kept in the `auto-subtitle-web-lib` release of infohelpful/library-hub. Callers try the
mirror first and fall back to the original source when the mirror fails. FFmpeg is shared by every
tool, so its pinned copy lives in common.bin_manager (library-hub release `ffmpeg-lib`).

Every asset is pinned by size and SHA-256: a file that does not match is rejected, so the mirror can
never install something other than the versions the agent was tested with.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import sys
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable

HUB_BASE_URL = "https://github.com/infohelpful/library-hub/releases/download/auto-subtitle-web-lib/"

# key -> (file name, size in bytes, sha256). Rebuild with the release when any pinned version changes.
ASSETS: dict[str, tuple[str, int, str]] = {
    # faster-whisper 1.2.1 sidecar packages, CPython 3.12 win_amd64 (sidecar/requirements-sidecar-cp312-win.lock.txt)
    "base_wheels": ("autosub-base-wheels-cp312-win64.zip", 86025702,
                    "2d2332ab4cefbcfe5de52323b1db2e7a5d82d6efe26bf4d8d5cf86946266ddcc"),
    # WhisperX 3.8.6 + torch 2.8.0+cpu, CPython 3.12 win_amd64 (sidecar/requirements-alignment-cpu-win.lock.txt)
    "align_wheels": ("autosub-align-wheels-cp312-win64.zip", 838629735,
                     "9290a4540f0460921c584becdba3ea99ed383b31e51c6e7682fee0892ca486ba"),
    # deepdml/faster-whisper-large-v3-turbo-ct2 @ 4df90f75321148c3a29a9e2351b7ddf8f5b115a8 (MIT)
    "whisper_model": ("autosub-whisper-large-v3-turbo-ct2.zip", 1621670702,
                      "71385ca6d79bf7c94117559a0f73a56c4b9f52002a6141bc734e403d4af11a20"),
    # kresnik/wav2vec2-large-xlsr-korean @ 629c9a3501c10ba128bf3fa1eebb12af3be03f61 (Apache-2.0)
    "align_model": ("autosub-align-model-kresnik-629c9a3.zip", 1267281088,
                    "efc4de7555a66bbca2f9e27aaa606745547b54a24a9f767764d88c92afd3ba2e"),
    # BBC audiowaveform 1.10.2 official release zip, byte-identical (GPL-3.0)
    "audiowaveform": ("audiowaveform-1.10.2-win64.zip", 1468190,
                      "17ab4657b9482ffa063d88d367598208060400af91c2c3e2b04723f98b418ad1"),
}

Progress = Callable[[float], None]  # 0.0 .. 1.0 of the download

_CHUNK = 1 << 20
_ATTEMPTS = 3
_TIMEOUT_SEC = 60


def wheels_supported() -> bool:
    """The wheel bundles are built for the MSI engine (CPython 3.12, 64-bit Windows)."""
    return sys.platform == "win32" and sys.version_info[:2] == (3, 12) and sys.maxsize > 2**32


def asset_url(key: str) -> str:
    base = os.environ.get("ITMATZIP_AUTOSUB_HUB_BASE_URL", "").strip() or HUB_BASE_URL
    return base.rstrip("/") + "/" + ASSETS[key][0]


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(8 * _CHUNK), b""):
            h.update(block)
    return h.hexdigest()


def _download_once(url: str, part: Path, size: int, on_progress: Progress | None) -> None:
    have = part.stat().st_size if part.exists() else 0
    if have > size:
        part.unlink()
        have = 0
    headers = {"User-Agent": "ItMatZip-Agent/1.0 (AutoSubtitle engine mirror)"}
    if have:
        headers["Range"] = f"bytes={have}-"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=_TIMEOUT_SEC) as resp:  # noqa: S310 - pinned https URL
        if have and resp.status != 206:  # server ignored the range: start over
            have = 0
        with part.open("ab" if have else "wb") as out:
            done = have
            last = 0.0
            while True:
                block = resp.read(_CHUNK)
                if not block:
                    break
                out.write(block)
                done += len(block)
                if on_progress and time.monotonic() - last > 0.5:
                    last = time.monotonic()
                    on_progress(min(1.0, done / size))


def fetch(key: str, dest_dir: Path, on_progress: Progress | None = None) -> Path:
    """Download one pinned asset into dest_dir and verify it. Raises on any mismatch or network error."""
    name, size, sha = ASSETS[key]
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / name
    if target.is_file() and target.stat().st_size == size and _sha256(target) == sha:
        return target
    part = target.with_name(name + ".part")
    url = asset_url(key)
    last_error: Exception | None = None
    for attempt in range(_ATTEMPTS):
        try:
            _download_once(url, part, size, on_progress)
            if part.stat().st_size != size:
                raise RuntimeError(f"크기가 맞지 않습니다 ({part.stat().st_size} != {size})")
            if _sha256(part) != sha:
                part.unlink(missing_ok=True)
                raise RuntimeError("SHA-256이 맞지 않습니다")
            os.replace(part, target)
            if on_progress:
                on_progress(1.0)
            return target
        except Exception as error:  # noqa: BLE001 - retried, then reported
            last_error = error
            if attempt + 1 < _ATTEMPTS:
                time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"library-hub 에서 {name} 을(를) 받지 못했습니다: {last_error}")


def extract(archive: Path, dest: Path) -> None:
    """Extract into dest (replaced atomically-ish: extracted next to it, then renamed)."""
    tmp = dest.with_name(dest.name + ".extract")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    root = tmp.resolve()
    with zipfile.ZipFile(archive) as zf:
        for member in zf.infolist():
            out = (tmp / member.filename).resolve()
            if root not in out.parents and out != root:
                raise RuntimeError(f"잘못된 압축 경로: {member.filename}")
        zf.extractall(tmp)
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    os.replace(tmp, dest)


def downloads_dir() -> Path:
    from . import paths

    return paths.data_root() / "hub-downloads"


def discard(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


# -- assets larger than GitHub's 2GB release-asset limit, stored as numbered parts -------------
# key -> (joined file name, joined size, joined sha256, [(part name, part size, part sha256), ...])
SPLIT_ASSETS: dict[str, tuple[str, int, str, list[tuple[str, int, str]]]] = {
    # torch 2.8.0+cu128, torchaudio 2.8.0+cu128, torchvision 0.23.0+cu128, CPython 3.12 win_amd64
    # (download.pytorch.org/whl/cu128, byte-identical wheels) - GPU alignment on NVIDIA PCs; mirror first,
    # like every other asset, then the official index
    "align_cuda_wheels": (
        "autosub-align-cuda-wheels-cp312-win64.zip", 3473598565,
        "2b6a6bfbc2190c9b0331db7d7738f64f7135ee7913cbd85e29b0465e8139916c",
        [
            ("autosub-align-cuda-wheels-cp312-win64.zip.001", 1900000000,
             "f2e146a41b7964167a5cc0600fc102c1d9860dc8d2e15f057602d58ecc2d2132"),
            ("autosub-align-cuda-wheels-cp312-win64.zip.002", 1573598565,
             "ef7466414b922ee3d36e3e2f9435022fce61a15f8f54a8f5afa0f955b1ab0992"),
        ],
    ),
}


def split_asset_url(part_name: str) -> str:
    base = os.environ.get("ITMATZIP_AUTOSUB_HUB_BASE_URL", "").strip() or HUB_BASE_URL
    return base.rstrip("/") + "/" + part_name


def _fetch_file(url: str, target: Path, size: int, sha: str, on_progress: Progress | None) -> None:
    if target.is_file() and target.stat().st_size == size and _sha256(target) == sha:
        return
    part = target.with_name(target.name + ".part")
    last_error: Exception | None = None
    for attempt in range(_ATTEMPTS):
        try:
            _download_once(url, part, size, on_progress)
            if part.stat().st_size != size:
                raise RuntimeError(f"크기가 맞지 않습니다 ({part.stat().st_size} != {size})")
            if _sha256(part) != sha:
                part.unlink(missing_ok=True)
                raise RuntimeError("SHA-256이 맞지 않습니다")
            os.replace(part, target)
            return
        except Exception as error:  # noqa: BLE001 - retried, then reported
            last_error = error
            if attempt + 1 < _ATTEMPTS:
                time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"library-hub 에서 {target.name} 을(를) 받지 못했습니다: {last_error}")


def fetch_split(key: str, dest_dir: Path, on_progress: Progress | None = None) -> Path:
    """Download every part (each size + SHA-256 checked), join them and verify the whole file."""
    name, size, sha, parts = SPLIT_ASSETS[key]
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / name
    if target.is_file() and target.stat().st_size == size and _sha256(target) == sha:
        return target
    done = 0
    paths: list[Path] = []
    for part_name, part_size, part_sha in parts:
        base = done

        def report(f: float, base: int = base, part_size: int = part_size) -> None:
            if on_progress:
                on_progress(min(1.0, (base + f * part_size) / size))

        piece = dest_dir / part_name
        _fetch_file(split_asset_url(part_name), piece, part_size, part_sha, report)
        paths.append(piece)
        done += part_size
    joined = target.with_name(name + ".join")
    with joined.open("wb") as out:
        for piece in paths:
            with piece.open("rb") as src:
                shutil.copyfileobj(src, out, 8 * _CHUNK)
    for piece in paths:
        discard(piece)
    if joined.stat().st_size != size or _sha256(joined) != sha:
        discard(joined)
        raise RuntimeError(f"library-hub 의 {name} 조각을 합친 파일이 맞지 않습니다")
    os.replace(joined, target)
    if on_progress:
        on_progress(1.0)
    return target
