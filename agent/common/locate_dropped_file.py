"""브라우저로 끌어다 놓은 파일의 원본 경로를 PC에서 찾는다.

브라우저는 보안상 드롭된 파일의 경로를 알려 주지 않고 이름·크기·수정 시각만 준다.
에이전트는 이 PC에서 도는 프로그램이므로 세 값이 모두 같은 파일을 디스크에서 찾아 경로를 돌려준다.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from collections import deque
from pathlib import Path

# 같은 크기·같은 이름이라도 수정 시각이 이 값(초) 안에서 다르면 다른 파일로 본다 (FAT 는 2초 단위).
MTIME_TOLERANCE_SEC = 2.5
DEFAULT_BUDGET_SEC = 15.0

_SKIP_DIR_NAMES = {
    "$recycle.bin",
    "system volume information",
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
    "appdata",
    "node_modules",
    ".git",
    "$windows.~bt",
    "windows.old",
    "recovery",
    "config.msi",
    "msocache",
    "itmatzip",
}


def _user_dirs() -> list[Path]:
    home = Path.home()
    names = ("Desktop", "Downloads", "Videos", "Movies", "Music", "Documents", "Pictures")
    roots: list[Path] = []
    for name in names:
        roots.append(home / name)
    for env in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
        base = os.environ.get(env)
        if base:
            for name in names:
                roots.append(Path(base) / name)
            roots.append(Path(base))
    public = os.environ.get("PUBLIC")
    if public:
        roots.append(Path(public))
    roots.append(home)
    return roots


def _fixed_drive_roots() -> list[Path]:
    """로컬 고정·이동식 드라이브 루트. 네트워크 드라이브는 느리고 에이전트 미지원이라 제외."""
    if sys.platform != "win32":
        return [Path("/")]
    import ctypes

    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    roots: list[Path] = []
    mask = kernel32.GetLogicalDrives()
    for i in range(26):
        if not mask & (1 << i):
            continue
        root = f"{chr(65 + i)}:\\"
        if kernel32.GetDriveTypeW(root) in (2, 3):  # 이동식, 고정
            roots.append(Path(root))
    return roots


def _norm(path: Path) -> str:
    return os.path.normcase(os.path.abspath(str(path)))


def search_roots() -> list[Path]:
    """우선순위 순서(사용자 폴더 → 홈 → 모든 드라이브)로 중복 없이 검색 시작 폴더를 만든다."""
    seen: set[str] = set()
    out: list[Path] = []
    for root in _user_dirs() + _fixed_drive_roots():
        key = _norm(root)
        if key not in seen and root.is_dir():
            seen.add(key)
            out.append(root)
    return out


def _lower_thread_priority() -> None:
    """검색 스레드를 백그라운드 모드(CPU·디스크 I/O 우선순위 모두 낮춤)로 돌려 다른 작업에 영향을 주지 않게 한다."""
    if sys.platform != "win32":
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        kernel32.SetThreadPriority(kernel32.GetCurrentThread(), 0x00010000)  # THREAD_MODE_BACKGROUND_BEGIN
    except Exception:  # noqa: BLE001 - 우선순위 조정 실패는 검색 결과와 무관
        pass


def _scan(
    roots: list[Path],
    match,
    deadline: float,
    stop: threading.Event,
    skip_keys: set[str],
) -> tuple[list[str], bool]:
    """roots 를 얕은 폴더부터(너비 우선) 훑는다. skip_keys 에 있는 폴더는 이미 훑었으므로 건너뛴다."""
    _lower_thread_priority()
    found: list[str] = []
    for root in roots:
        queue = deque([str(root)])
        while queue:
            if stop.is_set():
                return found, False
            if time.monotonic() > deadline:
                return found, True
            current = queue.popleft()
            try:
                with os.scandir(current) as it:
                    for entry in it:
                        try:
                            if match(entry):
                                found.append(entry.path)
                            elif entry.is_dir(follow_symlinks=False):
                                if os.path.normcase(entry.name) in _SKIP_DIR_NAMES:
                                    continue
                                if _norm(Path(entry.path)) in skip_keys:
                                    continue
                                queue.append(entry.path)
                        except OSError:
                            continue
            except OSError:
                continue
            if found:
                return found, False
    return found, False


def find_dropped_file(
    name: str,
    size: int,
    mtime_ms: float | None,
    *,
    budget_sec: float = DEFAULT_BUDGET_SEC,
    roots: list[Path] | None = None,
) -> dict[str, object]:
    """이름·크기(·수정 시각)가 모두 같은 파일을 찾는다.

    1) 바탕화면·다운로드 등 사용자 폴더를 순서대로 훑고,
    2) 못 찾으면 모든 드라이브를 동시에(드라이브마다 스레드, 얕은 폴더 우선) 훑는다.
    한 곳에서 찾으면 나머지는 바로 중단한다.
    """
    target_name = os.path.normcase(name)
    target_mtime = mtime_ms / 1000.0 if mtime_ms else None
    deadline = time.monotonic() + max(1.0, budget_sec)

    def match(entry: os.DirEntry[str]) -> bool:
        if os.path.normcase(entry.name) != target_name:
            return False
        try:
            if not entry.is_file(follow_symlinks=False):
                return False
            st = entry.stat(follow_symlinks=False)
        except OSError:
            return False
        if st.st_size != size:
            return False
        if target_mtime is not None and abs(st.st_mtime - target_mtime) > MTIME_TOLERANCE_SEC:
            return False
        return True

    stop = threading.Event()
    if roots is not None:
        found, timed_out = _scan(roots, match, deadline, stop, set())
        return {"found": bool(found), "candidates": found, "timed_out": timed_out and not found}

    user_roots = [r for r in _user_dirs() if r.is_dir()]
    seen: set[str] = set()
    ordered: list[Path] = []
    for r in user_roots:
        if _norm(r) not in seen:
            seen.add(_norm(r))
            ordered.append(r)
    # 1단계: 사용자 폴더(바탕화면·다운로드… → 홈). 각 폴더를 훑을 때 이미 훑은 폴더는 건너뛴다.
    done: set[str] = set()
    for r in ordered:
        found, timed_out = _scan([r], match, deadline, stop, set(done))
        if found:
            return {"found": True, "candidates": found, "timed_out": False}
        done.add(_norm(r))
        if timed_out:
            return {"found": False, "candidates": [], "timed_out": True}

    # 2단계: 모든 드라이브를 동시에.
    results: list[str] = []
    timed_flags: list[bool] = []
    lock = threading.Lock()

    def worker(drive: Path) -> None:
        found, timed = _scan([drive], match, deadline, stop, set(done))
        with lock:
            results.extend(found)
            timed_flags.append(timed)
        if found:
            stop.set()

    threads = [threading.Thread(target=worker, args=(d,), daemon=True) for d in _fixed_drive_roots()]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return {"found": bool(results), "candidates": results, "timed_out": any(timed_flags) and not results}
