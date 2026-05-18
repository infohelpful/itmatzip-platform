"""
Windows exe 자동 업데이트 — GitHub manifest 기반.

1. manifest JSON 에서 최신 version / download_url / sha256 읽음
2. 백그라운드에서 새 exe 다운로드
3. PowerShell 헬퍼가 기존 프로세스 종료 후 exe 교체·재실행
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from common.update_config import (
    AUTO_UPDATE_DISABLED,
    UPDATE_CHECK_INTERVAL_SEC,
    UPDATE_INITIAL_DELAY_SEC,
    UPDATE_MANIFEST_URL,
)
from runtime_paths import is_frozen

_log = logging.getLogger("itmatzip.agent.update")

_APPDATA = os.environ.get("APPDATA") or ""
UPDATE_ROOT = Path(_APPDATA) / "ItMatZip" / "updates" if _APPDATA else Path.home() / ".itmatzip" / "updates"
UPDATE_LOG = UPDATE_ROOT / "agent-update.log"

_lock = threading.Lock()
_state: dict[str, Any] = {
    "last_check_at": None,
    "last_error": None,
    "remote_version": None,
    "update_available": False,
    "downloading": False,
    "applying": False,
}


def _log(msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    _log.info(msg)
    try:
        UPDATE_ROOT.mkdir(parents=True, exist_ok=True)
        with UPDATE_LOG.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def parse_version(version: str) -> tuple[int, ...]:
    """'0.1.0' / 'v1.2.3-beta' → 비교용 숫자 튜플."""
    parts: list[int] = []
    for piece in re.split(r"[.\-+]", str(version).strip().lstrip("vV")):
        if not piece:
            continue
        m = re.match(r"^(\d+)", piece)
        parts.append(int(m.group(1)) if m else 0)
    return tuple(parts) if parts else (0,)


def is_remote_newer(remote: str, local: str) -> bool:
    return parse_version(remote) > parse_version(local)


@dataclass(frozen=True)
class UpdateManifest:
    version: str
    download_url: str
    sha256: str | None = None
    release_notes: str | None = None
    mandatory: bool = False


def fetch_manifest(url: str | None = None, timeout_sec: float = 25.0) -> UpdateManifest | None:
    manifest_url = (url or UPDATE_MANIFEST_URL).strip()
    if not manifest_url:
        return None
    req = urllib.request.Request(
        manifest_url,
        headers={"User-Agent": "ItMatZip-Agent-Updater", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            raw = resp.read()
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise RuntimeError(f"manifest 다운로드 실패: {e}") from e

    try:
        data = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise RuntimeError(f"manifest JSON 파싱 실패: {e}") from e

    version = str(data.get("version", "")).strip()
    download_url = str(data.get("download_url", "")).strip()
    if not version or not download_url:
        raise RuntimeError("manifest에 version 또는 download_url 이 없습니다.")

    sha = data.get("sha256")
    sha256 = str(sha).strip().lower() if sha else None
    notes = data.get("release_notes")
    release_notes = str(notes).strip() if notes else None
    mandatory = bool(data.get("mandatory", False))
    return UpdateManifest(
        version=version,
        download_url=download_url,
        sha256=sha256,
        release_notes=release_notes,
        mandatory=mandatory,
    )


def get_update_status_snapshot() -> dict[str, Any]:
    with _lock:
        return dict(_state)


def _set_state(**kwargs: Any) -> None:
    with _lock:
        _state.update(kwargs)


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest().lower()


def _download_exe(url: str, dest: Path, timeout_sec: float = 600.0) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "ItMatZip-Agent-Updater"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp, tmp.open("wb") as out:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
        tmp.replace(dest)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def _write_apply_script() -> Path:
    script = UPDATE_ROOT / "apply-agent-update.ps1"
    script.write_text(
        r"""param(
  [int]$ParentPid,
  [string]$StagedExe,
  [string]$TargetExe
)
$ErrorActionPreference = 'Stop'
try {
  $proc = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
  if ($proc) { $proc | Wait-Process -Timeout 180 }
} catch {}
Start-Sleep -Seconds 2
$bak = "$TargetExe.bak"
Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $TargetExe) {
  Move-Item -LiteralPath $TargetExe -Destination $bak -Force
}
Move-Item -LiteralPath $StagedExe -Destination $TargetExe -Force
Start-Process -FilePath $TargetExe
Start-Sleep -Seconds 1
Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue
""",
        encoding="utf-8",
    )
    return script


def _spawn_windows_updater(parent_pid: int, staged_exe: Path, target_exe: Path) -> None:
    ps1 = _write_apply_script()
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.Popen(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
            str(ps1),
            str(parent_pid),
            str(staged_exe),
            str(target_exe),
        ],
        creationflags=creationflags,
        close_fds=True,
    )


def apply_staged_update(staged_exe: Path, target_exe: Path | None = None) -> None:
    """다운로드된 exe로 교체 후 프로세스 종료(재시작은 PowerShell이 수행)."""
    target = Path(target_exe or sys.executable).resolve()
    staged = staged_exe.resolve()
    if not staged.is_file():
        raise FileNotFoundError(f"스테이징 exe 없음: {staged}")
    _set_state(applying=True)
    _log(f"업데이트 적용 예약: {staged} → {target}")
    _spawn_windows_updater(os.getpid(), staged, target)
    time.sleep(0.5)
    os._exit(0)


def check_and_apply_update(*, allow_apply: bool | None = None) -> dict[str, Any]:
    """
    manifest 확인 후 필요 시 다운로드·적용.
    allow_apply: None이면 frozen(exe)일 때만 자동 적용.
    """
    from version import AGENT_VERSION

    should_apply = allow_apply if allow_apply is not None else is_frozen()
    _set_state(last_check_at=time.time(), last_error=None)

    try:
        manifest = fetch_manifest()
    except Exception as e:
        _set_state(last_error=str(e), update_available=False)
        _log(f"manifest 확인 실패: {e}")
        return get_update_status_snapshot()

    if manifest is None:
        _set_state(update_available=False, remote_version=None)
        return get_update_status_snapshot()

    _set_state(remote_version=manifest.version)
    if not is_remote_newer(manifest.version, AGENT_VERSION):
        _set_state(update_available=False)
        _log(f"최신 버전 사용 중 ({AGENT_VERSION})")
        return get_update_status_snapshot()

    _set_state(update_available=True)
    _log(f"새 버전 발견: {manifest.version} (현재 {AGENT_VERSION})")

    if not should_apply:
        _log("개발 모드 — 다운로드·적용 생략")
        return get_update_status_snapshot()

    staged = UPDATE_ROOT / f"itmatzip-agent-{manifest.version}.exe"
    try:
        _set_state(downloading=True)
        _log(f"다운로드 시작: {manifest.download_url}")
        _download_exe(manifest.download_url, staged)
        if manifest.sha256:
            got = _sha256_file(staged)
            if got != manifest.sha256.lower():
                staged.unlink(missing_ok=True)
                raise RuntimeError(
                    f"SHA256 불일치 (기대 {manifest.sha256}, 실제 {got})",
                )
        _set_state(downloading=False)
        apply_staged_update(staged)
    except Exception as e:
        _set_state(downloading=False, applying=False, last_error=str(e))
        _log(f"업데이트 실패: {e}")
        raise

    return get_update_status_snapshot()


def _background_loop() -> None:
    time.sleep(max(5.0, UPDATE_INITIAL_DELAY_SEC))
    while True:
        try:
            check_and_apply_update()
        except Exception:
            pass
        time.sleep(max(300.0, UPDATE_CHECK_INTERVAL_SEC))


def schedule_background_update_checks() -> None:
    """기동 시 백그라운드 스레드에서 manifest 확인·자동 업데이트."""
    if AUTO_UPDATE_DISABLED:
        _log("자동 업데이트 비활성화 (ITMATZIP_DISABLE_AUTO_UPDATE)")
        return
    if not UPDATE_MANIFEST_URL:
        _log("manifest URL 없음 — 자동 업데이트 건너뜀")
        return
    t = threading.Thread(
        target=_background_loop,
        name="itmatzip-agent-auto-update",
        daemon=True,
    )
    t.start()
    _log(
        f"백그라운드 업데이트 확인 예약 (초기 {UPDATE_INITIAL_DELAY_SEC}s, "
        f"주기 {UPDATE_CHECK_INTERVAL_SEC}s)",
    )
