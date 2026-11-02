"""Line-delimited JSON-RPC client for the AutoSubtitle sidecar (port of desktop src/main/sidecar.ts).

Requests go to stdin one per line; responses come back on stdout. Progress arrives on stderr as
JSON lines ({"type": "progress" | "download_progress" | "transcribe_device" | "export_progress"}).
Calls are serialized, like the Electron client, because the sidecar handles one request at a time.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import uuid
from typing import Any, Callable

from . import paths

DEFAULT_TIMEOUT_SEC = 30.0
ProgressHandler = Callable[[dict[str, Any]], None]
# The installed agent runs an embeddable Python whose ._pth file makes it ignore PYTHONPATH,
# so the sidecar folder and the tool's runtime site-packages are put on sys.path explicitly.
_BOOTSTRAP = ("import os, runpy, sys; "
              "sys.path[0:0] = [p for p in os.environ.get('AUTOSUB_SYS_PATH', '').split(os.pathsep) if p]; "
              "sys.argv = [os.environ['AUTOSUB_ENTRY']]; "
              "runpy.run_path(os.environ['AUTOSUB_ENTRY'], run_name='__main__')")


def python_command(entry: str | None = None, code: str | None = None) -> list[str]:
    """Command running the sidecar entry script (or `code`) with AUTOSUB_SYS_PATH applied."""
    if code is not None:
        boot = ("import os, sys; "
                "sys.path[0:0] = [p for p in os.environ.get('AUTOSUB_SYS_PATH', '').split(os.pathsep) if p]; "
                + code)
        return [paths.sidecar_python(), "-c", boot]
    return [paths.sidecar_python(), "-u", "-c", _BOOTSTRAP]


class SidecarError(RuntimeError):
    pass


class SidecarClient:
    def __init__(self, extra_env: dict[str, str] | None = None) -> None:
        self._extra_env = dict(extra_env or {})
        self._proc: subprocess.Popen[bytes] | None = None
        self._call_lock = threading.Lock()  # one RPC at a time, in order
        self._state_lock = threading.Lock()
        self._pending: dict[str, dict[str, Any]] = {}
        self._stderr_tail = ""
        self.on_event: ProgressHandler | None = None

    # -- process -----------------------------------------------------------------
    def _env(self) -> dict[str, str]:
        env = dict(os.environ)
        env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", AUTOSUBTITLE_MODELS_DIR=str(paths.models_dir()))
        site_dirs: list[str] = []
        try:
            from common.runtime_site_packages import runtime_site_packages_dir

            site_dirs.append(str(runtime_site_packages_dir(paths.TOOL_ID)))
        except Exception:  # noqa: BLE001 - dev interpreter may already have the packages
            pass
        env["AUTOSUB_SYS_PATH"] = os.pathsep.join([str(paths.SIDECAR_DIR), *site_dirs])
        env["AUTOSUB_ENTRY"] = str(paths.SIDECAR_DIR / "main.py")
        env["PYTHONPATH"] = os.pathsep.join([str(paths.SIDECAR_DIR), *site_dirs, env.get("PYTHONPATH", "")])
        prefix: list[str] = []
        ff = paths.ffmpeg_paths()
        if ff:
            env["AUTOSUBTITLE_FFMPEG_PATH"] = ff[0]
            prefix.append(os.path.dirname(ff[0]))
        try:
            from engines import auto_subtitle_gpu_runtime as gpu

            if gpu.is_gpu_runtime_installed():
                prefix.append(str(gpu.gpu_runtime_dir()))
        except Exception:  # noqa: BLE001
            pass
        aw = paths.audiowaveform_exe()
        if aw:
            env["AUTOSUBTITLE_AUDIOWAVEFORM_PATH"] = aw
        env["PATH"] = os.pathsep.join([*prefix, env.get("PATH", "")])
        env.update(self._extra_env)
        return env

    def _start(self) -> subprocess.Popen[bytes]:
        if self._proc and self._proc.poll() is None:
            return self._proc
        paths.models_dir().mkdir(parents=True, exist_ok=True)
        self._stderr_tail = ""
        proc = subprocess.Popen(
            python_command(),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self._env(),
            cwd=str(paths.SIDECAR_DIR),
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
        self._proc = proc
        threading.Thread(target=self._read_stdout, args=(proc,), daemon=True).start()
        threading.Thread(target=self._read_stderr, args=(proc,), daemon=True).start()
        return proc

    def stop(self, reason: str = "Sidecar stopped") -> None:
        with self._state_lock:
            proc, self._proc = self._proc, None
        if proc and proc.poll() is None:
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True,
                               creationflags=subprocess.CREATE_NO_WINDOW, timeout=10)
            else:
                proc.kill()
        self._fail_all(reason)

    @property
    def running(self) -> bool:
        return bool(self._proc and self._proc.poll() is None)

    # -- streams -----------------------------------------------------------------
    def _read_stdout(self, proc: subprocess.Popen[bytes]) -> None:
        assert proc.stdout
        for raw in proc.stdout:
            try:
                msg = json.loads(raw.decode("utf-8"))
            except ValueError:
                continue
            with self._state_lock:
                slot = self._pending.get(str(msg.get("id")))
            if slot is not None:
                slot["msg"] = msg
                slot["event"].set()
        tail = self._stderr_tail.strip()[-6000:]
        hint = f"\n\n--- Python stderr ---\n{tail}" if tail else ""
        if self._proc is proc:
            self._fail_all(f"Python sidecar exited with code {proc.wait()}{hint}")

    def _read_stderr(self, proc: subprocess.Popen[bytes]) -> None:
        assert proc.stderr
        for raw in proc.stderr:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            self._stderr_tail = (self._stderr_tail + line + "\n")[-14000:]
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict) and event.get("type") and self.on_event:
                try:
                    self.on_event(event)
                except Exception:  # noqa: BLE001 - a UI callback must not kill the reader
                    pass

    def _fail_all(self, message: str) -> None:
        with self._state_lock:
            slots = list(self._pending.values())
            self._pending.clear()
        for slot in slots:
            slot["msg"] = {"error": {"message": message}}
            slot["event"].set()

    # -- calls -------------------------------------------------------------------
    def call(self, method: str, params: dict[str, Any] | None = None,
             timeout: float = DEFAULT_TIMEOUT_SEC) -> Any:
        with self._call_lock:
            proc = self._start()
            request_id = str(uuid.uuid4())
            slot: dict[str, Any] = {"event": threading.Event(), "msg": None}
            with self._state_lock:
                self._pending[request_id] = slot
            line = json.dumps({"id": request_id, "method": method, "params": params or {}}, ensure_ascii=False)
            try:
                assert proc.stdin
                proc.stdin.write((line + "\n").encode("utf-8"))
                proc.stdin.flush()
            except OSError as error:
                with self._state_lock:
                    self._pending.pop(request_id, None)
                raise SidecarError(f"Sidecar stdin not available: {error}") from error
            if not slot["event"].wait(timeout):
                with self._state_lock:
                    self._pending.pop(request_id, None)
                raise SidecarError(f"Sidecar timeout ({method}, {timeout:.0f}s)")
            with self._state_lock:
                self._pending.pop(request_id, None)
            msg = slot["msg"] or {}
            if "error" in msg:
                err = msg["error"]
                raise SidecarError(err.get("message") if isinstance(err, dict) else str(err))
            return msg.get("result")


_client: SidecarClient | None = None
_client_lock = threading.Lock()


def client() -> SidecarClient:
    global _client
    with _client_lock:
        if _client is None:
            _client = SidecarClient()
        return _client
