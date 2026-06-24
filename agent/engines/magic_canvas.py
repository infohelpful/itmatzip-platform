"""Magic Canvas orchestrator — persistent worker, staging, job IPC."""

from __future__ import annotations

import base64
import json
import logging
import os
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from common.subprocess_util import no_window_creationflags
from engines import magic_canvas_runtime as rt
from runtime_paths import agent_package_root

logger = logging.getLogger(__name__)

save_hf_token = rt.save_hf_token

ALLOWED_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".jfif"}
MAX_MASK_B64_BYTES = 16 * 1024 * 1024  # ~4K RGBA PNG upper bound
IDLE_SHUTDOWN_SEC = int(os.environ.get("ITMATZIP_MAGIC_CANVAS_IDLE_SEC", "600"))
OOM_RETRY_USER_MESSAGE = (
    "GPU 메모리가 부족하여 작업에 실패했습니다. "
    "해상도를 낮추거나 다른 GPU 사용 앱을 종료한 후 다시 시도하세요."
)

WORKER_ACTIONS = frozenset({"outpaint", "remove", "compose"})

ProgressCallback = Callable[[float, str | None], None]


@dataclass
class JobState:
    status: str = "idle"
    progress: float = 0.0
    message: str = ""
    output_path: str | None = None
    error: str | None = None
    action: str | None = None


_current_job = JobState()
_job_lock = threading.RLock()
_gpu_lock = threading.Lock()
_gpu_lock_held = False
_orchestrator: MagicCanvasOrchestrator | None = None


def get_current_job() -> JobState:
    with _job_lock:
        return JobState(
            status=_current_job.status,
            progress=_current_job.progress,
            message=_current_job.message,
            output_path=_current_job.output_path,
            error=_current_job.error,
            action=_current_job.action,
        )


def _set_job(**kwargs: Any) -> None:
    with _job_lock:
        for k, v in kwargs.items():
            setattr(_current_job, k, v)


def workspace_root() -> Path:
    return rt.workspace_root()


def ensure_workspace() -> Path:
    return workspace_root()


def is_workspace_path(path: Path) -> bool:
    try:
        resolved = path.resolve()
        root = workspace_root().resolve()
        return resolved == root or root in resolved.parents
    except OSError:
        return False


def validate_workspace_file(raw: str, *, must_exist: bool = True) -> Path:
    cleaned = raw.strip().strip('"').strip("'")
    p = Path(cleaned)
    if not p.is_absolute():
        p = workspace_root() / p
    p = p.resolve()
    if not is_workspace_path(p):
        raise ValueError(f"workspace 외부 경로는 허용되지 않습니다: {p}")
    if must_exist and not p.is_file():
        raise ValueError(f"파일을 찾을 수 없습니다: {p}")
    suffix = p.suffix.lower()
    if suffix == ".jfif":
        suffix = ".jpeg"
    if suffix not in ALLOWED_IMAGE_SUFFIXES and suffix != ".png":
        if must_exist:
            raise ValueError(f"지원하지 않는 확장자입니다: {p.suffix}")
    return p


def stage_to_workspace(src_path: str, *, prefix: str = "ws_image") -> str:
    """비ASCII 경로 방어 — 바이트 복사로 UUID ASCII-safe 파일 생성."""
    src = Path(src_path.strip().strip('"').strip("'"))
    if not src.is_file():
        raise FileNotFoundError(f"원본 파일 없음: {src}")
    suffix = src.suffix.lower()
    if suffix not in ALLOWED_IMAGE_SUFFIXES:
        raise ValueError(f"지원하지 않는 이미지 형식: {suffix}")
    ensure_workspace()
    safe_name = f"{prefix}_{uuid.uuid4().hex[:12]}{suffix}"
    dest = workspace_root() / safe_name
    with open(src, "rb") as rf, open(dest, "wb") as wf:
        while True:
            chunk = rf.read(1024 * 1024)
            if not chunk:
                break
            wf.write(chunk)
    return str(dest.resolve())


def save_mask_base64(data_b64: str) -> str:
    raw = data_b64.strip()
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[-1]
    try:
        blob = base64.b64decode(raw, validate=True)
    except Exception as exc:
        raise ValueError(f"Base64 디코딩 실패: {exc}") from exc
    if len(blob) > MAX_MASK_B64_BYTES:
        raise ValueError(f"마스크 페이로드가 너무 큽니다 (max {MAX_MASK_B64_BYTES} bytes)")
    ensure_workspace()
    dest = workspace_root() / f"ws_mask_{uuid.uuid4().hex[:12]}.png"
    dest.write_bytes(blob)
    return str(dest.resolve())


def new_output_path(*, suffix: str = ".png") -> str:
    ensure_workspace()
    out = workspace_root() / f"out_{uuid.uuid4().hex[:12]}{suffix}"
    return str(out.resolve())


def build_worker_command(action: str, params: dict[str, Any]) -> dict[str, Any]:
    """MAGIC-CANVAS.MD stdin 스키마 검증 및 worker cmd 조립."""
    act = action.strip().lower()
    if act not in WORKER_ACTIONS:
        raise ValueError(f"지원하지 않는 action: {action}")

    output_raw = params.get("output_path")
    if not output_raw:
        raise ValueError("output_path가 필요합니다.")
    output_p = validate_workspace_file(str(output_raw), must_exist=False)

    cmd: dict[str, Any] = {"cmd": act, "output_path": str(output_p)}

    if act == "outpaint":
        for key in ("image_path", "target_width", "target_height"):
            if params.get(key) is None:
                raise ValueError(f"outpaint: {key} 필요")
        img = validate_workspace_file(str(params["image_path"]))
        cmd.update(
            {
                "image_path": str(img),
                "target_width": int(params["target_width"]),
                "target_height": int(params["target_height"]),
                "prompt": str(params.get("prompt") or ""),
            }
        )
    elif act == "remove":
        if not params.get("image_path") or not params.get("mask_path"):
            raise ValueError("remove: image_path, mask_path 필요")
        img = validate_workspace_file(str(params["image_path"]))
        mask = validate_workspace_file(str(params["mask_path"]))
        cmd.update({"image_path": str(img), "mask_path": str(mask)})
    elif act == "compose":
        for key in ("bg_image_path", "fg_image_path", "x", "y", "fg_width", "fg_height"):
            if params.get(key) is None:
                raise ValueError(f"compose: {key} 필요")
        bg = validate_workspace_file(str(params["bg_image_path"]))
        fg = validate_workspace_file(str(params["fg_image_path"]))
        cmd.update(
            {
                "bg_image_path": str(bg),
                "fg_image_path": str(fg),
                "x": int(params["x"]),
                "y": int(params["y"]),
                "fg_width": int(params["fg_width"]),
                "fg_height": int(params["fg_height"]),
                "prompt": str(params.get("prompt") or ""),
            }
        )
    return cmd


def _is_recoverable_oom(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return any(
        token in msg
        for token in (
            "oom",
            "out of memory",
            "cuda",
            "재시작",
            "워커가 종료",
            "시간 초과",
        )
    )


def try_codeformer_upscale_skeleton(input_path: Path, output_path: Path) -> bool:
    """image-enhancer venv 크로스 호출 뼈대 (준비된 경우에만)."""
    try:
        from engines import image_enhancer
        from runtime_paths import codeformer_python_executable, codeformer_runner_script

        if not image_enhancer.is_model_ready_fast():
            return False
        out_dir = output_path.parent
        out_dir.mkdir(parents=True, exist_ok=True)
        vendor = str(image_enhancer.VENDOR_ROOT)
        run_env = rt.worker_env()
        run_env["ITMATZIP_CODEFORMER_ROOT"] = vendor
        proc = subprocess.run(
            [
                str(codeformer_python_executable()),
                str(codeformer_runner_script()),
                "--input",
                str(input_path),
                "--output-dir",
                str(out_dir),
                "--fidelity",
                "0.5",
                "--upscale",
                "2",
            ],
            capture_output=True,
            text=True,
            timeout=1800,
            env=run_env,
            creationflags=no_window_creationflags(),
        )
        if proc.returncode != 0:
            return False
        candidates = sorted(out_dir.glob("*.png"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not candidates:
            return False
        shutil.copy2(candidates[0], output_path)
        return output_path.is_file()
    except Exception as exc:
        logger.debug("codeformer upscale skeleton skipped: %s", exc)
        return False


class MagicCanvasOrchestrator:
    """Persistent worker daemon + JSONL IPC."""

    _instance: MagicCanvasOrchestrator | None = None
    _singleton_lock = threading.Lock()

    def __init__(self) -> None:
        self._proc: subprocess.Popen[str] | None = None
        self._stdin_lock = threading.Lock()
        self._reader_thread: threading.Thread | None = None
        self._respawn_lock = threading.Lock()
        self._pending_result: dict[str, Any] | None = None
        self._pending_error: str | None = None
        self._cmd_event = threading.Event()
        self._progress_cb: ProgressCallback | None = None
        self._worker_ready = threading.Event()
        self._shutdown = False
        self._intentional_shutdown = False
        self._last_activity = time.monotonic()
        self._idle_shutdown_sec = IDLE_SHUTDOWN_SEC
        threading.Thread(
            target=self._idle_watchdog,
            daemon=True,
            name="magic-canvas-idle-watchdog",
        ).start()

    def touch_activity(self) -> None:
        self._last_activity = time.monotonic()

    @classmethod
    def instance(cls) -> MagicCanvasOrchestrator:
        with cls._singleton_lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    def _worker_cmd(self) -> list[str]:
        return [str(rt.venv_python()), "-u", str(rt.resolved_worker_script())]

    def _start_worker(self, *, force_tier1: bool = False) -> None:
        with self._respawn_lock:
            self._terminate_worker_locked()
            env = rt.worker_env()
            pkg = agent_package_root()
            env["ITMATZIP_AGENT_PACKAGE_ROOT"] = str(pkg)
            if force_tier1:
                env["ITMATZIP_MAGIC_CANVAS_FORCE_TIER1"] = "1"
            else:
                env.pop("ITMATZIP_MAGIC_CANVAS_FORCE_TIER1", None)
            self._intentional_shutdown = False
            self._proc = subprocess.Popen(
                self._worker_cmd(),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env=env,
                creationflags=no_window_creationflags(),
            )
            self._worker_ready.clear()
            self._reader_thread = threading.Thread(
                target=self._stdout_loop,
                daemon=True,
                name="magic-canvas-worker-ipc",
            )
            self._reader_thread.start()
            self.touch_activity()
            self._send_raw({"cmd": "ping"})
            if not self._worker_ready.wait(timeout=30.0):
                raise RuntimeError("워커 시작 시간 초과")

    def _terminate_worker_locked(self) -> None:
        self._intentional_shutdown = True
        if self._proc is not None and self._proc.poll() is None:
            try:
                self._send_raw({"cmd": "shutdown"}, wait=False)
            except Exception:
                pass
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        self._proc = None

    def respawn_worker(self, *, reason: str = "", force_tier1: bool = False) -> None:
        logger.warning(
            "magic-canvas worker respawn: %s (force_tier1=%s)",
            reason or "unknown",
            force_tier1,
        )
        self._start_worker(force_tier1=force_tier1)
        self._send_command({"cmd": "load", "force_tier1": force_tier1}, timeout=600.0)
        self.touch_activity()

    def shutdown_idle_worker(self) -> None:
        """Idle 600s — VRAM 회수용 graceful shutdown."""
        with self._respawn_lock:
            if self._proc is None or self._proc.poll() is not None:
                return
            if is_job_busy():
                return
            logger.info("magic-canvas worker idle shutdown (%ss)", self._idle_shutdown_sec)
            self._terminate_worker_locked()

    def _idle_watchdog(self) -> None:
        while not self._shutdown:
            time.sleep(30.0)
            if is_job_busy():
                continue
            if self._proc is None or self._proc.poll() is not None:
                continue
            idle_for = time.monotonic() - self._last_activity
            if idle_for < self._idle_shutdown_sec:
                continue
            try:
                self.shutdown_idle_worker()
            except Exception as exc:
                logger.warning("idle watchdog: %s", exc)

    def ensure_worker(self) -> None:
        if self._proc is None or self._proc.poll() is not None:
            self.respawn_worker(reason="not running")
            return
        if not self._worker_ready.is_set():
            self._send_raw({"cmd": "ping"})

    def _send_raw(self, payload: dict[str, Any], *, wait: bool = True) -> None:
        if self._proc is None or self._proc.stdin is None:
            raise RuntimeError("워커 프로세스가 없습니다.")
        line = json.dumps(payload, ensure_ascii=False) + "\n"
        with self._stdin_lock:
            self._proc.stdin.write(line)
            self._proc.stdin.flush()

    def _stdout_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        try:
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError as exc:
                    logger.debug("worker stdout non-json line skipped: %s (%s)", line[:120], exc)
                    continue
                if not isinstance(msg, dict):
                    logger.debug("worker stdout ignored non-object json")
                    continue
                self._handle_ipc(msg)
        except Exception as exc:
            logger.warning("worker stdout loop ended: %s", exc)
        finally:
            code = proc.poll()
            if code not in (None, 0) and not self._shutdown and not self._intentional_shutdown:
                logger.warning("worker exited with code %s (job thread handles retry)", code)

    def _handle_ipc(self, msg: dict[str, Any]) -> None:
        mtype = msg.get("type")
        if mtype == "ready":
            self._worker_ready.set()
        elif mtype == "pong":
            self._worker_ready.set()
        elif mtype == "progress":
            pct = float(msg.get("progress", 0))
            detail = str(msg.get("message") or "").strip()
            updates: dict[str, Any] = {"progress": pct}
            if detail:
                updates["message"] = detail
            _set_job(**updates)
            if self._progress_cb:
                self._progress_cb(pct, detail or None)
        elif mtype == "result":
            self._pending_result = msg
            self._cmd_event.set()
        elif mtype == "error":
            self._pending_error = str(msg.get("message", "worker error"))
            self._cmd_event.set()
        elif mtype == "loaded":
            self._cmd_event.set()

    def _send_command(self, payload: dict[str, Any], *, timeout: float = 3600.0) -> dict[str, Any]:
        self.ensure_worker()
        self._pending_result = None
        self._pending_error = None
        self._cmd_event.clear()
        self._send_raw(payload)
        deadline = time.monotonic() + timeout
        while not self._cmd_event.wait(timeout=0.5):
            if self._proc is not None and self._proc.poll() is not None:
                raise RuntimeError("OOM 발생으로 워커가 종료되었습니다.")
            if time.monotonic() >= deadline:
                self.respawn_worker(reason="command timeout")
                raise RuntimeError("추론 시간 초과")
        if self._pending_error:
            err = self._pending_error
            if _is_recoverable_oom(RuntimeError(err)):
                raise RuntimeError(err)
            raise RuntimeError(err)
        if self._pending_result is None and payload.get("cmd") not in ("load", "ping"):
            raise RuntimeError("워커 응답 없음")
        self.touch_activity()
        return self._pending_result or {}

    def run_action(
        self,
        action: str,
        params: dict[str, Any],
        *,
        on_progress: ProgressCallback | None = None,
    ) -> str:
        self._progress_cb = on_progress
        cmd = build_worker_command(action, params)
        timeout = float(params.get("timeout_sec", 3600))
        last_exc: BaseException | None = None

        for attempt in range(2):
            try:
                result = self._send_command(cmd, timeout=timeout)
                out = str(result.get("output_path", cmd.get("output_path", "")))
                if not out:
                    raise RuntimeError("출력 경로가 비어 있습니다.")
                return out
            except Exception as exc:
                last_exc = exc
                if attempt == 0 and _is_recoverable_oom(exc):
                    logger.warning("OOM recoverable — tier1 retry (attempt %s): %s", attempt + 1, exc)
                    self.respawn_worker(reason=str(exc), force_tier1=True)
                    continue
                break

        if last_exc is not None:
            if _is_recoverable_oom(last_exc):
                raise RuntimeError(OOM_RETRY_USER_MESSAGE) from last_exc
            raise last_exc
        raise RuntimeError("작업 실패")


def get_orchestrator() -> MagicCanvasOrchestrator:
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = MagicCanvasOrchestrator.instance()
    return _orchestrator


_prepare_lock = threading.RLock()


@dataclass
class PrepareState:
    phase: str = "idle"
    progress: float = 0.0
    message: str = ""
    error: str | None = None


_prepare_state = PrepareState()
_prepare_thread: threading.Thread | None = None


def get_prepare_state() -> PrepareState:
    with _prepare_lock:
        return PrepareState(
            phase=_prepare_state.phase,
            progress=_prepare_state.progress,
            message=_prepare_state.message,
            error=_prepare_state.error,
        )


def is_prepare_running() -> bool:
    with _prepare_lock:
        return _prepare_state.phase not in ("idle", "done", "error")


def reset_prepare_for_force() -> None:
    """환경 재확인(force) — 멈춘·진행 중 prepare를 끊고 idle로."""
    global _prepare_thread, _prepare_state
    with _prepare_lock:
        if _prepare_thread is not None and _prepare_thread.is_alive():
            logger.warning("magic-canvas prepare force reset (was %s)", _prepare_state.phase)
        _prepare_thread = None
        _prepare_state = PrepareState(phase="idle")


def start_prepare(*, force: bool = False) -> PrepareState:
    global _prepare_thread, _prepare_state
    with _prepare_lock:
        if _prepare_thread is not None and not _prepare_thread.is_alive():
            if _prepare_state.phase in ("installing_dependencies", "downloading_models"):
                logger.warning("magic-canvas prepare thread ended without done/error — resetting")
                _prepare_state = PrepareState(phase="idle")
            _prepare_thread = None

        if is_prepare_running():
            return get_prepare_state()

        if not force and rt.all_ready_fast():
            _prepare_state = PrepareState(
                phase="done",
                progress=100.0,
                message="이미 설치되어 있습니다.",
            )
            return get_prepare_state()

        _prepare_state = PrepareState(
            phase="installing_dependencies",
            progress=4.0,
            message="환경 상태 확인 중…" if force else "Python 3.12 · PyTorch · 패키지 설치 중…",
        )

    def _run() -> None:
        global _prepare_state

        def report(pct: float, step: str, detail: str = "") -> None:
            msg = (detail or step).strip() or step
            with _prepare_lock:
                _prepare_state.progress = max(_prepare_state.progress, min(99.0, float(pct)))
                if msg:
                    _prepare_state.message = msg
                step_l = step.lower()
                if "모델" in step or "model" in step_l or "다운" in step:
                    _prepare_state.phase = "downloading_models"
                elif _prepare_state.phase != "downloading_models":
                    _prepare_state.phase = "installing_dependencies"

        try:
            if not rt.has_nvidia_gpu():
                raise RuntimeError("NVIDIA GPU가 필요합니다. Magic Canvas는 GPU 전용입니다.")
            rt.run_prepare(force=force, on_progress=report)
            with _prepare_lock:
                _prepare_state.phase = "done"
                _prepare_state.progress = 100.0
                _prepare_state.message = "준비 완료" if not force else "환경 재확인 완료"
            try:
                get_orchestrator().respawn_worker(reason="post-prepare load")
            except Exception as exc:
                logger.warning("worker warm-load after prepare: %s", exc)
        except Exception as exc:
            with _prepare_lock:
                _prepare_state.phase = "error"
                _prepare_state.error = str(exc)
                _prepare_state.message = f"준비 실패: {exc}"
            logger.exception("magic-canvas prepare failed")

    with _prepare_lock:
        _prepare_thread = threading.Thread(
            target=_run,
            daemon=True,
            name="magic-canvas-prepare",
        )
        _prepare_thread.start()
    return get_prepare_state()


_job_thread: threading.Thread | None = None


def try_acquire_gpu_lock() -> bool:
    global _gpu_lock_held
    if _gpu_lock_held:
        return False
    acquired = _gpu_lock.acquire(blocking=False)
    if acquired:
        _gpu_lock_held = True
    return acquired


def release_gpu_lock() -> None:
    global _gpu_lock_held
    if not _gpu_lock_held:
        return
    _gpu_lock.release()
    _gpu_lock_held = False


def is_job_busy() -> bool:
    with _job_lock:
        return _current_job.status in ("pending", "processing")


def submit_job(action: str, payload: dict[str, Any]) -> None:
    global _job_thread

    def worker() -> None:
        try:
            _set_job(status="processing", progress=2.0, error=None, action=action)

            def on_prog(pct: float, msg: str | None) -> None:
                updates: dict[str, Any] = {"progress": pct, "error": None}
                if msg:
                    updates["message"] = msg
                _set_job(**updates)

            orch = get_orchestrator()
            params = dict(payload)
            out = orch.run_action(action, params, on_progress=on_prog)

            if action == "outpaint":
                out_p = Path(out)
                tw = int(payload.get("target_width", 0))
                th = int(payload.get("target_height", 0))
                if tw > 1024 or th > 1024:
                    try_codeformer_upscale_skeleton(out_p, out_p)

            _set_job(status="completed", progress=100.0, output_path=out, error=None)
            get_orchestrator().touch_activity()
        except Exception as exc:
            msg = str(exc)
            if _is_recoverable_oom(exc) and "GPU 메모리" not in msg:
                msg = OOM_RETRY_USER_MESSAGE
            _set_job(status="failed", progress=0.0, error=msg)
        finally:
            release_gpu_lock()

    with _job_lock:
        if _job_thread is not None and _job_thread.is_alive():
            raise RuntimeError("다른 이미지 편집 작업이 진행 중입니다.")
        _set_job(status="pending", progress=0.0, output_path=None, error=None, action=action)
        get_orchestrator().touch_activity()
        _job_thread = threading.Thread(target=worker, daemon=True, name="magic-canvas-job")
        _job_thread.start()


def readiness_payload(*, quick: bool = False) -> dict[str, Any]:
    vram_mb = rt.detect_gpu_vram_mb()
    gpu_ok = rt.has_nvidia_gpu()
    pip_ok = rt.is_pip_stack_ready_fast() if quick else rt.is_pip_stack_ready()
    model_ok = rt.is_model_ready_fast()
    hf_token = rt.resolve_hf_token()
    models_source = None
    if rt.is_bundle_ready():
        models_source = "library-hub"
    elif model_ok:
        models_source = "huggingface"
    all_ready = bool(gpu_ok and pip_ok and model_ok)
    dependencies = {
        "python312": rt.is_venv_ready(),
        "venv": rt.is_venv_ready(),
        "pip_stack": pip_ok,
        "models": model_ok,
        "cuda": gpu_ok,
    }
    return {
        "ok": all_ready,
        "all_ready": all_ready,
        "tool": "magic-canvas",
        "gpu_required": True,
        "gpu_detected": gpu_ok,
        "vram_mb": vram_mb,
        "hf_token_configured": bool(hf_token),
        "models_source": models_source,
        "hf_gated_models": [repo for repo, _ in rt.HF_GATED_MODEL_PAGES],
        "dependencies": dependencies,
        "binaries": {
            "venv": rt.is_venv_ready(),
            "pip_stack": pip_ok,
            "models": model_ok,
            "cuda_available": rt.is_cuda_available() if not quick else False,
        },
        "message": None
        if gpu_ok
        else "NVIDIA GPU가 필요합니다.",
    }


def cleanup_workspace() -> dict[str, Any]:
    root = ensure_workspace()
    if is_job_busy():
        return {"ok": False, "files_removed": 0, "errors": ["작업 진행 중에는 정리할 수 없습니다."]}
    removed = 0
    errors: list[str] = []
    for p in root.iterdir():
        try:
            if p.is_file():
                p.unlink()
                removed += 1
        except OSError as exc:
            errors.append(str(exc))
    return {"ok": not errors, "files_removed": removed, "errors": errors}
