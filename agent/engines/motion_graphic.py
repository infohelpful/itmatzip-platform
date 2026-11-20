"""모션그래픽도구 엔진 — 런타임 격리 설치(/prepare), 영상·SRT 전처리(분석), MP4 렌더.

docs/motion-graphic-spec.md 참고. 설계(AI)는 engines/motion_graphic_design.py.

- 고정 엔진: %APPDATA%/ItMatZip/engine-runtime/motion-graphic/{node, premotion-core}
  (최초 /prepare 때 1회 설치, 이후 템플릿 해시가 바뀔 때만 동기화)
- 프로젝트: %LOCALAPPDATA%/ItMatZip/motion-projects/{project_id}/
  assets/source.srt · analysis.json · waveform.json · design.json · segments.json · output.mp4
- 렌더: premotion-core(Remotion)가 설계서대로 원본 + 모션그래픽 + 오디오를 한 번에 H.264 MP4 로 (미리보기와 같은 mg-core.js)
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from common.bin_manager import ensure_ffmpeg, get_ffmpeg_exe, get_ffprobe_exe, is_ffmpeg_ready
from engines import motion_graphic_analyze as mga
from common.subprocess_util import no_window_creationflags
from engines import motion_graphic_ctx as mgx

TOOL_ID = "motion-graphic"
NODE_VERSION = "24.22.1"
NODE_ZIP = f"node-v{NODE_VERSION}-win-x64.zip"
NODE_URL = f"https://nodejs.org/dist/v{NODE_VERSION}/{NODE_ZIP}"
NODE_ZIP_SHA256 = "d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5"

TEMPLATE_DIR = Path(__file__).resolve().parent / "motion_graphic_core"
_TEMPLATE_FILES = (
    "package.json", "package-lock.json", "render.mjs",
    "src/index.ts", "src/Root.tsx", "src/Main.tsx", "src/mg-core.js", "src/components/NodeTree.tsx",
)

ProgressFn = Callable[[float, str, str], None]


# ── 경로 ───────────────────────────────────────────────────────────────

def _appdata() -> Path:
    return Path(os.environ.get("APPDATA") or (Path.home() / "AppData" / "Roaming"))


def _localappdata() -> Path:
    return Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))


def runtime_root() -> Path:
    return _appdata() / "ItMatZip" / "engine-runtime" / TOOL_ID


def node_dir() -> Path:
    return runtime_root() / "node"


def node_exe() -> Path:
    return node_dir() / "node.exe"


def core_dir() -> Path:
    return runtime_root() / "premotion-core"


def projects_root() -> Path:
    override = os.environ.get("ITMATZIP_MOTION_PROJECTS", "").strip()
    return Path(override) if override else _localappdata() / "ItMatZip" / "motion-projects"


def _ready_file() -> Path:
    return runtime_root() / ".ready.json"


# ── 공통 유틸 ──────────────────────────────────────────────────────────

def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{secrets.token_hex(3)}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for attempt in range(6):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 5:
                raise
            time.sleep(0.05 * (attempt + 1))


def _read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _popen(cmd: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None,
           stdout: int | None = subprocess.PIPE, stderr: int | None = subprocess.PIPE) -> subprocess.Popen:
    return subprocess.Popen(
        cmd, cwd=str(cwd) if cwd else None, env=env, stdout=stdout, stderr=stderr,
        stdin=subprocess.DEVNULL, creationflags=no_window_creationflags(),
    )


def _node_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PATH"] = str(node_dir()) + os.pathsep + env.get("PATH", "")
    env["npm_config_cache"] = str(runtime_root() / "npm-cache")
    env["npm_config_update_notifier"] = "false"
    env["npm_config_fund"] = "false"
    env["npm_config_audit"] = "false"
    env["ITMATZIP_RUNTIME_TOOL"] = TOOL_ID
    env.pop("NODE_OPTIONS", None)
    return env


def template_hash() -> str:
    h = hashlib.sha256()
    for rel in _TEMPLATE_FILES:
        h.update(rel.encode())
        h.update((TEMPLATE_DIR / rel).read_bytes())
    return h.hexdigest()[:16]


def _lock_hash() -> str:
    return hashlib.sha256((TEMPLATE_DIR / "package-lock.json").read_bytes()).hexdigest()[:16]


# ── 준비 상태 ──────────────────────────────────────────────────────────

def readiness() -> dict[str, Any]:
    ready = _read_json(_ready_file(), {}) or {}
    node_ok = node_exe().is_file() and ready.get("node") == NODE_VERSION
    core_ok = (core_dir() / "node_modules" / "remotion" / "package.json").is_file() and ready.get("core") == template_hash()
    browser_ok = bool(ready.get("browser")) and core_ok
    ffmpeg_ok = is_ffmpeg_ready()
    return {
        "ffmpeg": ffmpeg_ok,
        "node": node_ok,
        "premotion_core": core_ok,
        "browser": browser_ok,
        "ready": ffmpeg_ok and node_ok and core_ok and browser_ok,
        "node_version": NODE_VERSION,
        "runtime_dir": str(runtime_root()),
    }


def is_ready() -> bool:
    return bool(readiness()["ready"])


# ── /prepare ───────────────────────────────────────────────────────────

def _download(url: str, dest: Path, on_pct: Callable[[float], None], timeout: float = 60.0) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "ItMatZip-Agent"})
    with urllib.request.urlopen(req, timeout=timeout) as resp, tmp.open("wb") as fh:
        total = int(resp.headers.get("Content-Length") or 0)
        got = 0
        last = -1.0
        while True:
            block = resp.read(1 << 20)
            if not block:
                break
            fh.write(block)
            got += len(block)
            if total:
                pct = got * 100.0 / total
                if pct - last >= 1:
                    last = pct
                    on_pct(pct)
    os.replace(tmp, dest)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _install_node(report: ProgressFn) -> None:
    root = runtime_root()
    zip_path = root / "downloads" / NODE_ZIP
    if not (zip_path.is_file() and _sha256(zip_path) == NODE_ZIP_SHA256):
        _download(NODE_URL, zip_path, lambda p: report(12 + p * 0.2, "Node.js 포터블", f"다운로드 {p:.0f}%"))
    if _sha256(zip_path) != NODE_ZIP_SHA256:
        zip_path.unlink(missing_ok=True)
        raise RuntimeError("Node.js 다운로드 파일의 SHA-256 이 일치하지 않습니다. 다시 시도해 주세요.")
    report(33, "Node.js 포터블", "압축 해제 중…")
    staging = root / "node.staging"
    shutil.rmtree(staging, ignore_errors=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(staging)
    inner = next((p for p in staging.iterdir() if p.is_dir() and (p / "node.exe").is_file()), None)
    if inner is None:
        raise RuntimeError("Node.js 압축 파일에서 node.exe 를 찾지 못했습니다.")
    shutil.rmtree(node_dir(), ignore_errors=True)
    os.replace(inner, node_dir())
    shutil.rmtree(staging, ignore_errors=True)
    zip_path.unlink(missing_ok=True)


def _sync_template() -> None:
    """템플릿 파일만 덮어쓴다. node_modules 와 src/presets(사용자 프리셋)는 보존."""
    core = core_dir()
    for rel in _TEMPLATE_FILES:
        dst = core / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(TEMPLATE_DIR / rel, dst)
    for old in ("builtin-presets.json", "src/DynamicComposer.tsx"):  # v1 잔재
        (core / old).unlink(missing_ok=True)


def _run_streaming(cmd: list[str], cwd: Path, on_line: Callable[[str], None], timeout: float) -> int:
    proc = _popen(cmd, cwd=cwd, env=_node_env(), stderr=subprocess.STDOUT)
    deadline = time.monotonic() + timeout
    assert proc.stdout is not None
    for raw in proc.stdout:
        on_line(raw.decode("utf-8", "replace").rstrip())
        if time.monotonic() > deadline:
            proc.kill()
            raise RuntimeError("시간 초과")
    return proc.wait()


def _npm_ci(report: ProgressFn) -> None:
    npm_cli = node_dir() / "node_modules" / "npm" / "bin" / "npm-cli.js"
    if not npm_cli.is_file():
        raise RuntimeError("포터블 Node.js 에 npm 이 없습니다. 환경 준비를 다시 실행해 주세요.")
    tail: list[str] = []
    ticks = [0]

    def on_line(line: str) -> None:
        if line:
            tail.append(line)
            del tail[:-20]
        ticks[0] += 1
        report(min(78.0, 42 + ticks[0] * 0.5), "Premotion 엔진", "npm 패키지 설치 중 (Remotion)…")

    code = _run_streaming(
        [str(node_exe()), str(npm_cli), "ci", "--no-audit", "--no-fund", "--loglevel=error", "--omit=dev"],
        core_dir(), on_line, timeout=1800,
    )
    if code != 0:
        raise RuntimeError("npm ci 실패: " + " / ".join(tail[-5:]))


def _ensure_browser(report: ProgressFn) -> None:
    errors: list[str] = []

    def on_line(line: str) -> None:
        try:
            msg = json.loads(line)
        except ValueError:
            return
        if msg.get("type") == "progress":
            report(80 + float(msg.get("pct") or 0) * 0.17, "렌더 브라우저", f"Chrome Headless Shell {msg.get('pct', 0):.0f}%")
        elif msg.get("type") == "error":
            errors.append(str(msg.get("message", ""))[:400])

    code = _run_streaming([str(node_exe()), "render.mjs", "ensure-browser"], core_dir(), on_line, timeout=1800)
    if code != 0:
        raise RuntimeError("렌더 브라우저 설치 실패: " + (errors[-1] if errors else f"exit {code}"))


def prepare(report: ProgressFn) -> None:
    root = runtime_root()
    root.mkdir(parents=True, exist_ok=True)
    report(3, "FFmpeg", "FFmpeg 확인 중…")
    ensure_ffmpeg(download_timeout_sec=900.0)
    ready = _read_json(_ready_file(), {}) or {}

    if not (node_exe().is_file() and ready.get("node") == NODE_VERSION):
        report(12, "Node.js 포터블", f"Node.js {NODE_VERSION} 설치 (PC 전역 Node 와 무관)")
        _install_node(report)
        ready = {"node": NODE_VERSION}
        _write_json(_ready_file(), ready)

    current = template_hash()
    lock = _lock_hash()
    if ready.get("core") != current or not (core_dir() / "node_modules" / "remotion").is_dir():
        report(40, "Premotion 엔진", "엔진 파일 배포 중…")
        _sync_template()
        if ready.get("lock") != lock or not (core_dir() / "node_modules" / "remotion").is_dir():
            _npm_ci(report)
        ready.update({"core": current, "lock": lock, "browser": False})
        _write_json(_ready_file(), ready)

    if not ready.get("browser"):
        report(80, "렌더 브라우저", "Chrome Headless Shell 확인 중…")
        _ensure_browser(report)
        ready["browser"] = True
        _write_json(_ready_file(), ready)
    ready["prepared_at"] = datetime.now().isoformat(timespec="seconds")
    _write_json(_ready_file(), ready)
    report(100, "완료", "모션그래픽 엔진 준비 완료")


# ── 프로젝트 ───────────────────────────────────────────────────────────

_PID_RE = re.compile(r"^mg_\d{8}_\d{6}_[0-9a-f]{4}$")
_project_locks: dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()
_active_project: str | None = None


def _lock(pid: str) -> threading.RLock:
    with _locks_guard:
        return _project_locks.setdefault(pid, threading.RLock())


def project_dir(pid: str) -> Path:
    if not _PID_RE.match(pid or ""):
        raise ValueError("잘못된 project_id 입니다.")
    return projects_root() / pid


def project_exists(pid: str) -> bool:
    try:
        return (project_dir(pid) / "project.json").is_file()
    except ValueError:
        return False


def load_project(pid: str) -> dict[str, Any]:
    data = _read_json(project_dir(pid) / "project.json")
    if not isinstance(data, dict):
        raise FileNotFoundError(f"프로젝트를 찾을 수 없습니다: {pid}")
    return data


def _save_project(pid: str, data: dict[str, Any]) -> None:
    _write_json(project_dir(pid) / "project.json", data)


def _update_project(pid: str, **fields: Any) -> dict[str, Any]:
    with _lock(pid):
        data = load_project(pid)
        data.update(fields)
        _save_project(pid, data)
        return data


def set_active_project(pid: str) -> None:
    global _active_project
    if not project_exists(pid):
        raise FileNotFoundError(f"프로젝트를 찾을 수 없습니다: {pid}")
    _active_project = pid
    try:
        (projects_root() / "active.txt").write_text(pid, encoding="utf-8")
    except OSError:
        pass


def active_project() -> str | None:
    if _active_project and project_exists(_active_project):
        return _active_project
    try:
        pid = (projects_root() / "active.txt").read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return pid if project_exists(pid) else None


def resolve_project(pid: str | None) -> str:
    pid = (pid or "").strip() or active_project()
    if not pid:
        raise FileNotFoundError("열린 모션그래픽 프로젝트가 없습니다. 웹 화면에서 영상과 SRT 를 먼저 불러오세요.")
    if not project_exists(pid):
        raise FileNotFoundError(f"프로젝트를 찾을 수 없습니다: {pid}")
    return pid


def list_projects(limit: int = 20) -> list[dict[str, Any]]:
    root = projects_root()
    if not root.is_dir():
        return []
    items = []
    for d in root.iterdir():
        meta = _read_json(d / "project.json") if d.is_dir() else None
        if isinstance(meta, dict) and meta.get("id") == d.name:
            items.append({k: meta.get(k) for k in ("id", "created", "video_name", "phase", "duration_sec", "total_frames")})
    items.sort(key=lambda m: m.get("created") or "", reverse=True)
    return items[:limit]


def _ffprobe(video: Path) -> dict[str, Any]:
    proc = subprocess.run(
        [str(get_ffprobe_exe()), "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(video)],
        capture_output=True, timeout=60, creationflags=no_window_creationflags(),
    )
    if proc.returncode != 0:
        raise RuntimeError("ffprobe 로 영상을 읽지 못했습니다: " + proc.stderr.decode("utf-8", "replace")[-300:])
    data = json.loads(proc.stdout.decode("utf-8", "replace") or "{}")
    vstream = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    astream = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    if not vstream:
        raise RuntimeError("영상 스트림이 없는 파일입니다.")
    w, h = int(vstream.get("width") or 0), int(vstream.get("height") or 0)
    rotation = 0
    for side in vstream.get("side_data_list") or []:
        if "rotation" in side:
            rotation = int(side.get("rotation") or 0)
    if abs(rotation) in (90, 270):
        w, h = h, w
    duration = float(data.get("format", {}).get("duration") or vstream.get("duration") or 0)
    if duration <= 0:
        raise RuntimeError("영상 길이를 확인하지 못했습니다.")
    return {"w": w, "h": h, "duration": duration, "has_audio": bool(astream),
            "acodec": (astream or {}).get("codec_name"), "src_fps": vstream.get("avg_frame_rate")}


def _audio_levels(video: Path) -> list[float]:
    sr = 8000
    proc = subprocess.run(
        [str(get_ffmpeg_exe()), "-hide_banner", "-loglevel", "error", "-i", str(video), "-vn", "-ac", "1",
         "-ar", str(sr), "-f", "s16le", "pipe:1"],
        capture_output=True, timeout=1800, creationflags=no_window_creationflags(),
    )
    if proc.returncode != 0 or not proc.stdout:
        return []
    return mgx.frame_levels_db(proc.stdout, sr, mgx.FPS)


def create_project(video_path: Path, srt_text: str, srt_name: str = "source.srt") -> str:
    if not is_ffmpeg_ready():
        raise RuntimeError("FFmpeg 가 준비되지 않았습니다. 「환경 준비」를 먼저 실행해 주세요.")
    cues = mgx.parse_srt(srt_text)
    if not cues:
        raise ValueError("SRT 에서 자막 줄을 찾지 못했습니다. 올바른 .srt 파일인지 확인해 주세요.")
    pid = datetime.now().strftime("mg_%Y%m%d_%H%M%S_") + secrets.token_hex(2)
    pdir = project_dir(pid)
    (pdir / "assets").mkdir(parents=True, exist_ok=True)
    # 줄바꿈을 \n 하나로 맞춰 저장 (Windows 텍스트 모드가 \r\n 을 \r\r\n 으로 겹치지 않게)
    clean = srt_text.replace("\r\n", "\n").replace("\r", "\n")
    (pdir / "assets" / "source.srt").write_text(clean, encoding="utf-8", newline="\n")
    _save_project(pid, {
        "id": pid, "created": datetime.now().isoformat(timespec="seconds"),
        "video_path": str(video_path), "video_name": video_path.name, "srt_name": srt_name,
        "phase": "preprocessing", "progress": 2.0, "message": "전처리 대기 중…",
    })
    _write_json(pdir / "blueprint.json", {"project_id": pid, "theme": None, "theme_locked": False, "revision": 0, "tracks": []})
    threading.Thread(target=_preprocess, args=(pid, cues), daemon=True, name=f"mg-init-{pid}").start()
    set_active_project(pid)
    return pid


def _preprocess(pid: str, cues: list[mgx.Cue]) -> None:
    pdir = project_dir(pid)
    try:
        meta = load_project(pid)
        video = Path(meta["video_path"])
        _update_project(pid, progress=8.0, message="영상 정보 확인 중 (ffprobe)…")
        probe = _ffprobe(video)
        fps = mga.parse_fps(probe["src_fps"])
        total = mga.to_frame(probe["duration"], fps)

        _update_project(pid, progress=25.0, message="화면 움직임 분석 중 (정지 구간·화면 급변·로고 위치)…")
        series = mga.measure_motion(get_ffmpeg_exe(), video, creationflags=no_window_creationflags())
        analysis = mga.analyze(cues, series, fps=fps, duration=probe["duration"])
        analysis["width"], analysis["height"] = probe["w"], probe["h"]
        _write_json(pdir / "analysis.json", analysis)

        _update_project(pid, progress=70.0, message="오디오 파형 분석 중…")
        levels = _audio_levels(video) if probe["has_audio"] else []
        _write_json(pdir / "waveform.json", {"fps": mgx.FPS, "levels": mgx.waveform_u8(levels)})
        _update_project(pid, phase="ready", progress=100.0, message="전처리 완료", w=probe["w"], h=probe["h"],
                        duration_sec=probe["duration"], total_frames=total, has_audio=probe["has_audio"],
                        acodec=probe["acodec"], src_fps=probe["src_fps"],
                        fps={"num": fps.numerator, "den": fps.denominator, "value": round(float(fps), 5)},
                        lines=len(analysis["subs"]))
    except Exception as exc:  # noqa: BLE001 — 상태로 노출
        try:
            _update_project(pid, phase="failed", progress=0.0, message=f"전처리 실패: {exc}")
        except Exception:
            pass


# ── 렌더 (Premotion = Remotion) ────────────────────────────────────────

_node_lock = threading.Lock()  # 렌더·썸네일 Node 작업은 한 번에 하나 (Chrome 다운로드/CPU 경합 방지)


def _node_job(cmd: str, job: dict[str, Any], workdir: Path, on_msg: Callable[[dict[str, Any]], None] | None = None,
              cancel: threading.Event | None = None, timeout: float = 7200) -> None:
    with _node_lock:
        _node_job_locked(cmd, job, workdir, on_msg, cancel, timeout)


def _node_job_locked(cmd: str, job: dict[str, Any], workdir: Path, on_msg: Callable[[dict[str, Any]], None] | None,
                     cancel: threading.Event | None, timeout: float) -> None:
    job_path = workdir / f"{cmd}-job.json"
    _write_json(job_path, job)
    proc = _popen([str(node_exe()), "render.mjs", cmd, str(job_path)], cwd=core_dir(), env=_node_env(),
                  stderr=subprocess.STDOUT)
    if cancel is not None:
        _current_procs.append(proc)
    errors: list[str] = []
    deadline = time.monotonic() + timeout
    try:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.decode("utf-8", "replace").strip()
            try:
                msg = json.loads(line)
            except ValueError:
                if line:
                    errors.append(line[-300:])
                continue
            if msg.get("type") == "error":
                errors.append(str(msg.get("message", ""))[:600])
            elif on_msg:
                on_msg(msg)
            if (cancel is not None and cancel.is_set()) or time.monotonic() > deadline:
                proc.kill()
                break
        code = proc.wait()
    finally:
        if proc in _current_procs:
            _current_procs.remove(proc)
    if cancel is not None and cancel.is_set():
        raise RuntimeError("사용자가 렌더를 취소했습니다.")
    if code != 0:
        raise RuntimeError("Premotion 렌더 실패: " + (errors[-1] if errors else f"exit {code}"))


_render_lock = threading.Lock()
_render_jobs: dict[str, dict[str, Any]] = {}
_render_cancel: dict[str, threading.Event] = {}
_current_procs: list[subprocess.Popen] = []


def render_status(job_id: str) -> dict[str, Any]:
    job = _render_jobs.get(job_id)
    if job is None:
        raise KeyError(f"렌더 작업을 찾을 수 없습니다: {job_id}")
    return dict(job)


def cancel_render(job_id: str) -> bool:
    ev = _render_cancel.get(job_id)
    if ev is None:
        return False
    ev.set()
    for proc in list(_current_procs):
        try:
            proc.kill()
        except Exception:
            pass
    return True


def start_render(pid: str, media_url: str) -> dict[str, Any]:
    """설계서(design.json)가 적용된 상태에서만 렌더한다 — 설계 없이 렌더 금지."""
    if not is_ready():
        raise RuntimeError("모션그래픽 엔진이 준비되지 않았습니다. 「환경 준비」를 먼저 실행해 주세요.")
    design = _read_json(project_dir(pid) / "design.json")
    if not isinstance(design, dict) or not design.get("segments"):
        raise RuntimeError("설계서가 없습니다. 먼저 「설계하기」를 실행하세요.")
    if not design.get("applied"):
        raise RuntimeError("설계서를 아직 적용하지 않았습니다. 「설계대로 적용」으로 미리보기를 확인한 뒤 내보내세요.")
    if not _render_lock.acquire(blocking=False):
        raise RuntimeError("다른 렌더가 진행 중입니다.")
    job_id = "r_" + secrets.token_hex(5)
    _render_jobs[job_id] = {"job_id": job_id, "project_id": pid, "phase": "running", "progress": 1.0,
                            "message": "렌더 준비 중…", "output_path": None, "encoder": "Remotion · libx264",
                            "revision": design.get("revision")}
    _render_cancel[job_id] = threading.Event()
    threading.Thread(target=_render_worker, args=(job_id, pid, design, media_url), daemon=True,
                     name=f"mg-render-{job_id}").start()
    return dict(_render_jobs[job_id])


def _set_job(job_id: str, **fields: Any) -> None:
    _render_jobs[job_id].update(fields)


def _duration(path: Path) -> float:
    proc = subprocess.run([str(get_ffprobe_exe()), "-v", "error", "-show_entries", "format=duration", "-of",
                           "default=nw=1:nk=1", str(path)], capture_output=True, timeout=60,
                          creationflags=no_window_creationflags())
    try:
        return float(proc.stdout.decode().strip())
    except ValueError:
        return 0.0


def _render_worker(job_id: str, pid: str, design: dict[str, Any], media_url: str) -> None:
    pdir = project_dir(pid)
    work = pdir / "render"
    try:
        work.mkdir(parents=True, exist_ok=True)
        meta = load_project(pid)
        tmp_out = work / "output.tmp.mp4"
        frames = int(design["durationInFrames"])

        def on_msg(msg: dict[str, Any]) -> None:
            if msg.get("type") != "progress":
                return
            stage = msg.get("stage")
            pct = float(msg.get("pct") or 0)
            if stage == "bundle":
                _set_job(job_id, progress=2 + pct * 0.03, message="엔진 준비 중 (번들)…")
            elif stage == "browser":
                _set_job(job_id, progress=5, message=f"렌더 브라우저 준비 중 {pct:.0f}%")
            else:
                done = msg.get("frames") or 0
                _set_job(job_id, progress=5 + pct * 0.9, message=f"렌더 중 {done:,} / {frames:,} 프레임")

        _node_job("render", {"publicDir": str(pdir / "assets"), "out": str(tmp_out),
                             "props": {"design": design, "mediaUrl": media_url, "startFrame": 0,
                                       "durationInFrames": frames}},
                  work, on_msg, _render_cancel[job_id])
        _set_job(job_id, progress=96, message="결과 확인 중 (길이 비교)…")
        want = float(meta.get("duration_sec") or 0)
        got = _duration(tmp_out)
        if want and abs(got - want) > 1.0:
            raise RuntimeError(f"결과 길이가 원본과 다릅니다 (원본 {want:.2f}초, 결과 {got:.2f}초).")
        output = pdir / "output.mp4"
        os.replace(tmp_out, output)
        final = output
        try:  # 작업 폴더에도 「<영상 이름>_모션그래픽_최종.mp4」 로 둔다
            src = Path(meta["video_path"])
            final = src.with_name(f"{src.stem}_모션그래픽_최종.mp4")
            shutil.copyfile(output, final)
        except OSError:
            final = output
        _set_job(job_id, phase="ready", progress=100.0, message="렌더 완료", output_path=str(final),
                 duration_sec=round(got, 2))
    except Exception as exc:  # noqa: BLE001
        _set_job(job_id, phase="failed", progress=0.0, message=str(exc)[:500])
    finally:
        _render_lock.release()


def open_project_folder(pid: str) -> bool:
    """프로젝트 폴더(설계서·받은 이미지·분석 파일이 있는 곳)를 탐색기로 연다."""
    folder = project_dir(pid)
    if not folder.is_dir() or os.name != "nt":
        return False
    subprocess.Popen(["explorer", str(folder)], creationflags=no_window_creationflags())
    return True


def open_output_folder(pid: str) -> bool:
    output = project_dir(pid) / "output.mp4"
    if not output.is_file() or os.name != "nt":
        return False
    subprocess.Popen(["explorer", "/select,", str(output)], creationflags=no_window_creationflags())
    return True
