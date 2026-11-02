"""Engine status, one-time preparation and the transcription job (port of desktop src/main/index.ts
`deps:*`, `gpu:*` and `video-drop-path` handlers, plus src/main/deps-prepare.ts)."""
from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from typing import Any

from . import alignment, media, paths
from .sidecar_client import SidecarError, client

PREPARE_MODEL_TIMEOUT_SEC = 60 * 60
TRANSCRIBE_TIMEOUT_SEC = 2 * 60 * 60
# Pinned like the desktop sidecar's requirements.txt.
SIDECAR_PIP_SPECS = ("faster-whisper==1.2.1", "av==18.0.0", "huggingface_hub>=0.26.0", "tqdm>=4.66.0")
_IMPORT_CHECK = ("import faster_whisper, av, huggingface_hub, tqdm; "
                 "assert faster_whisper.__version__ == '1.2.1', faster_whisper.__version__; "
                 "assert av.__version__.startswith('18.'), av.__version__")
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


def _sidecar_packages_ready() -> bool:
    from .sidecar_client import python_command

    env = client()._env()  # same interpreter and sys.path as the sidecar itself
    try:
        proc = subprocess.run(python_command(code=_IMPORT_CHECK), env=env, capture_output=True,
                              timeout=120, creationflags=_NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return proc.returncode == 0


def _model_status() -> dict[str, Any]:
    try:
        return client().call("get_model_status") or {}
    except SidecarError:
        return {}


def deps_status() -> dict[str, Any]:
    ffmpeg_ok = paths.ffmpeg_paths() is not None
    packages_ok = _sidecar_packages_ready()
    status = _model_status() if packages_ok else {}
    loaded, present = bool(status.get("loaded")), bool(status.get("model_present"))
    if not packages_ok:
        present = (paths.models_dir() / "deepdml-faster-whisper-large-v3-turbo-ct2" / "model.bin").is_file()
    return {"ffmpegOk": ffmpeg_ok, "modelLoaded": loaded, "modelPresent": present,
            "engineReady": ffmpeg_ok and packages_ok and (loaded or present), "packagesOk": packages_ok}


# -- one-time preparation ----------------------------------------------------------------
_prepare_lock = threading.Lock()
_prepare_state: dict[str, Any] = {"state": "idle", "percent": 0.0, "step": "", "error": None, "modelReady": False}


def prepare_state() -> dict[str, Any]:
    with _prepare_lock:
        return dict(_prepare_state)


def _set_prepare(**kw: Any) -> None:
    with _prepare_lock:
        if "percent" in kw:  # never move backwards within one run
            kw["percent"] = max(_prepare_state["percent"], min(100.0, float(kw["percent"])))
        _prepare_state.update(kw)


def _pip_install() -> None:
    from common.runtime_site_packages import finalize_runtime_pip, pip_install_cmd, pip_subprocess_env

    cmd = [*pip_install_cmd(paths.TOOL_ID), *SIDECAR_PIP_SPECS]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                            errors="replace", creationflags=_NO_WINDOW,
                            env=pip_subprocess_env({"ITMATZIP_RUNTIME_TOOL": paths.TOOL_ID}))
    tail: list[str] = []
    assert proc.stdout
    for line in proc.stdout:
        line = line.strip()
        if line:
            tail = (tail + [line])[-20:]
            _set_prepare(percent=min(19.0, prepare_state()["percent"] + 0.2), step=f"Python 패키지 설치: {line[:80]}")
    proc.wait()
    finalize_runtime_pip(paths.TOOL_ID)
    if proc.returncode != 0:
        raise RuntimeError("pip install 실패: " + (tail[-1] if tail else f"exit {proc.returncode}"))


def _run_prepare() -> None:
    try:
        if not _sidecar_packages_ready():
            _set_prepare(step="Python 패키지 설치")
            client().stop("restarting after package install")
            _pip_install()
            if not _sidecar_packages_ready():
                raise RuntimeError("자막 엔진 패키지를 불러오지 못했습니다. 다시 시도해 주세요.")
        _set_prepare(percent=20.0, step="FFmpeg 준비")
        if paths.ffmpeg_paths() is None:
            from common.bin_manager import ensure_ffmpeg

            ensure_ffmpeg(on_progress=lambda pct, step="", detail="": _set_prepare(
                percent=20.0 + 10.0 * float(pct) / 100.0, step=f"FFmpeg {detail or step}".strip()))
        _set_prepare(percent=29.0, step="파형 도구 준비")
        ensure_audiowaveform(quiet=True)
        _set_prepare(percent=30.0, step="Whisper 모델 준비")
        sc = client()
        sc.stop("restart with FFmpeg/GPU paths")  # pick up new PATH entries

        def on_event(event: dict[str, Any]) -> None:
            if event.get("type") == "download_progress":
                _set_prepare(percent=30.0 + 0.7 * float(event.get("value") or 0), step="Whisper 모델 다운로드")

        sc.on_event = on_event
        try:
            sc.call("prepare_model", {}, PREPARE_MODEL_TIMEOUT_SEC)
        finally:
            sc.on_event = None
        _set_prepare(percent=100.0, step="완료", state="done", modelReady=True)
    except Exception as error:  # noqa: BLE001 - reported to the UI
        _set_prepare(state="error", error=str(error))


def start_prepare() -> dict[str, Any]:
    with _prepare_lock:
        if _prepare_state["state"] == "running":
            raise RuntimeError("이미 필수 엔진을 준비하는 중입니다. 완료될 때까지 기다려 주세요.")
        _prepare_state.update(state="running", percent=0.0, step="시작", error=None, modelReady=False)
    threading.Thread(target=_run_prepare, name="autosub-prepare-engines", daemon=True).start()
    return prepare_state()


# -- GPU runtime -------------------------------------------------------------------------
def gpu_status() -> dict[str, Any]:
    from . import gpu_runtime as gpu

    raw = gpu.gpu_runtime_status()
    nvidia = _has_nvidia_gpu()
    installed = bool(raw.get("installed"))
    url = bool(raw.get("zip_url_configured"))
    local = bool(raw.get("local_candidates"))
    return {"installed": installed, "canInstall": nvidia and not installed and (url or local), "nvidiaPresent": nvidia,
            "urlConfigured": url, "localCandidate": local, "dllDir": str(raw.get("dll_dir") or "")}


def _has_nvidia_gpu() -> bool:
    try:
        proc = subprocess.run(["nvidia-smi", "-L"], capture_output=True, timeout=10, creationflags=_NO_WINDOW)
        return proc.returncode == 0 and b"GPU" in proc.stdout
    except (OSError, subprocess.TimeoutExpired):
        return False


_gpu_lock = threading.Lock()
_gpu_state: dict[str, Any] = {"state": "idle", "pct": 0.0, "stage": "", "error": None, "result": None}


def gpu_install_state() -> dict[str, Any]:
    with _gpu_lock:
        return dict(_gpu_state)


def start_gpu_install() -> dict[str, Any]:
    from . import gpu_runtime as gpu

    with _gpu_lock:
        if _gpu_state["state"] == "running":
            raise RuntimeError("GPU 런타임 설치가 이미 진행 중입니다.")
        _gpu_state.update(state="running", pct=0.0, stage="시작", error=None, result=None)

    def report(pct: float, step: str, detail: str = "") -> None:
        with _gpu_lock:
            _gpu_state.update(pct=max(_gpu_state["pct"], float(pct)), stage=detail or step)

    def work() -> None:
        try:
            result = gpu.install_gpu_runtime(on_progress=report)
            client().stop("restart with GPU runtime")
            with _gpu_lock:
                _gpu_state.update(state="done", pct=100.0,
                                  result={"ok": True, "source": result.get("source"), "dir": result.get("dir")})
        except Exception as error:  # noqa: BLE001
            with _gpu_lock:
                _gpu_state.update(state="error", error=str(error))

    threading.Thread(target=work, name="autosub-gpu-install", daemon=True).start()
    return gpu_install_state()


# -- transcription -----------------------------------------------------------------------
def _mode(device: Any) -> str:
    return "gpu" if str(device or "").lower() == "cuda" else "cpu"


def _mode_label(device: Any) -> str:
    return "GPU(CUDA)" if _mode(device) == "gpu" else "CPU"


class TranscribeJob:
    """Collects the events Electron pushed over IPC so the browser can poll them in order."""

    def __init__(self, job_id: str) -> None:
        self.id = job_id
        self.events: list[dict[str, Any]] = []
        self.done = False
        self.cancelled = threading.Event()
        self._lock = threading.Lock()

    def emit(self, kind: str, payload: Any = None) -> None:
        if self.cancelled.is_set() and kind not in ("error",):
            return
        with self._lock:
            self.events.append({"seq": len(self.events), "type": kind, "payload": payload})

    def since(self, seq: int) -> dict[str, Any]:
        with self._lock:
            return {"jobId": self.id, "done": self.done, "events": self.events[max(0, seq):]}


_tx_lock = threading.Lock()
_tx_job: TranscribeJob | None = None


def transcribe_events(job_id: str, seq: int) -> dict[str, Any]:
    with _tx_lock:
        job = _tx_job
    if job is None or job.id != job_id:
        return {"jobId": job_id, "done": True, "events": [], "unknown": True}
    return job.since(seq)


def cancel_transcription() -> None:
    global _tx_job
    with _tx_lock:
        job, _tx_job = _tx_job, None
    if job and not job.done:
        job.cancelled.set()
        client().stop("Transcription cancelled")  # the desktop app also kills the sidecar


def start_transcription(path: str, alignment_mode: str | None, job_id: str) -> None:
    global _tx_job
    abs_path = media.existing_media_file(path)
    cancel_transcription()
    job = TranscribeJob(job_id)
    with _tx_lock:
        _tx_job = job

    def work() -> None:
        sc = client()
        started = time.monotonic()
        try:
            # First, because installing it restarts the sidecar (which would drop a loaded model).
            ensure_audiowaveform(quiet=True)
            status = sc.call("get_model_status") or {}
            if job.cancelled.is_set():
                return
            if not status.get("loaded"):
                prep = sc.call("prepare_model", {}, PREPARE_MODEL_TIMEOUT_SEC) or {}
                load = prep.get("load") or {}
                job.emit("modelReady")
                job.emit("mode", _mode(load.get("device")))
                job.emit("diag", {"message": f"[진단] 모델 로드: {_mode_label(load.get('device'))}"})
            else:
                job.emit("mode", _mode(status.get("device")))
                job.emit("diag", {"message": f"[진단] 기존 모델 사용: {_mode_label(status.get('device'))}"})

            def on_event(event: dict[str, Any]) -> None:
                if event.get("type") == "progress" and isinstance(event.get("value"), (int, float)):
                    job.emit("progress", event["value"])
                elif event.get("type") == "transcribe_device":
                    job.emit("mode", _mode(event.get("device")))
                    if event.get("reason"):
                        job.emit("diag", {"message": event["reason"]})

            sc.on_event = on_event
            params: dict[str, Any] = {"path": str(abs_path)}
            prepared = media.prepare_blocking(str(abs_path))
            if job.cancelled.is_set():
                return
            params["prepared_audio_path"] = prepared["audioPath"]
            if alignment_mode in ("accurate", "fast"):
                params["alignment_mode"] = alignment_mode
            align_python = alignment.python_path()
            if align_python:
                params["alignment_python"] = align_python
            params["waveform_out_json_path"] = media.waveform_cache_json_path(str(abs_path))["cachePath"]
            result = sc.call("transcribe", params, TRANSCRIBE_TIMEOUT_SEC) or {}
            if job.cancelled.is_set():
                return
            job.emit("mode", _mode(result.get("device")))
            total_ms = int((time.monotonic() - started) * 1000)
            tx_ms = result.get("transcribe_ms")
            tx_text = str(max(0, round(tx_ms))) if isinstance(tx_ms, (int, float)) else "-"
            if result.get("fallback_to_cpu"):
                job.emit("diag", {"message": "[진단] GPU 오류로 CPU 모드로 자동 전환됨"})
            job.emit("diag", {"message": f"[진단] 장치: {_mode_label(result.get('device'))} · 추출 {tx_text}ms · 전체 {total_ms}ms"})
            align = result.get("alignmentSummary")
            if isinstance(align, dict):
                reasons = ", ".join(align.get("reviewReasons") or [])
                counted = ""
                if align.get("appliedEngine") == "whisperx" and isinstance(align.get("totalWords"), int):
                    counted = (f" · 정렬됨 {(align.get('counts') or {}).get('aligned', 0)}/{align['totalWords']}"
                               f" · 검토 필요 {align.get('reviewWords', 0)}")
                requested = align.get("requestedEngine")
                applied = align.get("appliedEngine") or "-"
                job.emit("diag", {"message": f"[진단] 단어 정렬: {applied}"
                                  + (f" (요청: {requested})" if requested and requested != applied else "")
                                  + counted + (f" · 사유: {reasons}" if reasons else "")})
            waveform = result.get("waveform_peaks")
            if isinstance(waveform, dict) and waveform.get("path"):
                media.allow_path(waveform["path"])
            job.emit("complete", result)
        except Exception as error:  # noqa: BLE001 - reported to the UI
            if not job.cancelled.is_set():
                job.emit("error", {"message": str(error)})
        finally:
            sc.on_event = None
            job.done = True

    threading.Thread(target=work, name="autosub-transcribe", daemon=True).start()


_waveform_lock = threading.Lock()
_waveform_workers: dict[str, Any] = {}


def cancel_waveform(request_id: str) -> None:
    with _waveform_lock:
        worker = _waveform_workers.pop(request_id, None)
    if worker:
        worker.stop("파형 생성을 취소했습니다.")


def generate_waveform(params: dict[str, Any]) -> dict[str, Any]:
    """Port of desktop `generateWaveform`: peaks from the prepared WAV, in a worker of its own."""
    from .sidecar_client import SidecarClient

    request_id, raw_path = params.get("requestId"), params.get("path")
    if not isinstance(request_id, str) or not request_id or not isinstance(raw_path, str) or not raw_path.strip():
        return {"ok": False, "path": None, "reason": "유효한 파형 요청 ID와 영상 경로가 필요합니다."}
    with _waveform_lock:
        others = list(_waveform_workers)
    for other in others:
        cancel_waveform(other)
    worker = SidecarClient()
    with _waveform_lock:
        _waveform_workers[request_id] = worker
    scratch: str | None = None
    try:
        cache = media.waveform_cache_json_path(raw_path)
        prepared = media.prepare_blocking(raw_path)
        scratch = f"{cache['cachePath']}.{request_id}.work.json"
        result = worker.call("waveform_peaks", {"requestId": request_id, "path": prepared["audioPath"],
                                                "out_json_path": scratch}, TRANSCRIBE_TIMEOUT_SEC)
        if isinstance(result, dict) and result.get("ok"):
            os.replace(scratch, cache["cachePath"])
            media.allow_path(cache["cachePath"])
            return {**result, "path": cache["cachePath"]}
        return result
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "path": None, "reason": str(error)}
    finally:
        worker.stop()
        with _waveform_lock:
            _waveform_workers.pop(request_id, None)
        if scratch:
            for leftover in (scratch, scratch + ".part"):
                try:
                    os.unlink(leftover)
                except OSError:
                    pass


def sidecar_call(method: str, params: dict[str, Any]) -> Any:
    """Renderer `sidecarCall` passthrough, limited to what the UI actually calls."""
    if method == "waveform_peaks":
        return generate_waveform(params)
    raise PermissionError(f"허용되지 않은 sidecar 메서드입니다: {method}")


# -- audiowaveform -----------------------------------------------------------------------
# Official BBC release, identical to the exe the desktop app bundles (GPL-3.0, run as a separate program).
AUDIOWAVEFORM_URL = "https://github.com/bbc/audiowaveform/releases/download/1.10.2/audiowaveform-1.10.2-win64.zip"
AUDIOWAVEFORM_ZIP_SHA256 = "17ab4657b9482ffa063d88d367598208060400af91c2c3e2b04723f98b418ad1"
AUDIOWAVEFORM_EXE_SHA256 = "a5de21b75fe2d9f5e1ac756b7dd7a14bfd18918821f3a389097521354c7c418c"
_aw_lock = threading.Lock()


def ensure_audiowaveform(*, quiet: bool = False) -> str | None:
    """Download audiowaveform.exe once; without it the editor still works, only peaks are slower."""
    import hashlib
    import io
    import urllib.request
    import zipfile

    with _aw_lock:
        existing = paths.audiowaveform_exe()
        if existing:
            return existing
        try:
            with urllib.request.urlopen(AUDIOWAVEFORM_URL, timeout=60) as resp:  # noqa: S310 - pinned https URL
                data = resp.read()
            if hashlib.sha256(data).hexdigest() != AUDIOWAVEFORM_ZIP_SHA256:
                raise RuntimeError("audiowaveform 다운로드 파일의 해시가 맞지 않습니다.")
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                name = next(n for n in zf.namelist() if n.lower().endswith("audiowaveform.exe"))
                exe = zf.read(name)
            if hashlib.sha256(exe).hexdigest() != AUDIOWAVEFORM_EXE_SHA256:
                raise RuntimeError("audiowaveform.exe 해시가 맞지 않습니다.")
            target = paths.tool_bin_dir() / "audiowaveform.exe"
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_suffix(".exe.part")
            tmp.write_bytes(exe)
            os.replace(tmp, target)
            client().stop("restart with audiowaveform")  # next call picks up AUTOSUBTITLE_AUDIOWAVEFORM_PATH
            return str(target)
        except Exception:  # noqa: BLE001
            if quiet:
                return None
            raise


# -- precise re-alignment ----------------------------------------------------------------
_realign_lock = threading.Lock()
_realign_jobs: dict[str, dict[str, Any]] = {}


def start_realign(request: dict[str, Any]) -> dict[str, Any]:
    """Port of desktop `alignment:realign`: WhisperX on the prepared audio in a worker of its own."""
    from .sidecar_client import SidecarClient

    if (not isinstance(request.get("requestId"), str) or not request["requestId"]
            or not isinstance(request.get("timelineId"), str) or not isinstance(request.get("revision"), int)
            or not isinstance(request.get("path"), str) or not isinstance(request.get("cues"), list)):
        return {"state": "done", "result": {"ok": False, "reason": "올바르지 않은 정렬 요청입니다."}}
    align_python = alignment.python_path()
    if not align_python:
        return {"state": "done", "result": {"ok": False, "reason": "alignment_runtime_missing"}}
    with _realign_lock:
        previous = list(_realign_jobs.values())
    for job in previous:  # a new request replaces the running one, like the desktop app
        job["cancelled"] = True
        job["worker"].stop("새 정렬 요청으로 취소했습니다.")
    worker = SidecarClient({"AUTOSUBTITLE_ALIGN_PYTHON": align_python,
                            "AUTOSUBTITLE_ALIGN_CACHE": str(paths.align_cache_dir())})
    job: dict[str, Any] = {"worker": worker, "done": threading.Event(), "result": None, "cancelled": False}
    with _realign_lock:
        _realign_jobs[request["requestId"]] = job

    def work() -> None:
        try:
            prepared = media.prepare_blocking(request["path"])
            if job["cancelled"]:
                raise RuntimeError("정렬이 취소됐습니다.")
            ff = paths.ffmpeg_paths()
            reply = worker.call("realign_words", {**request, "path": prepared["audioPath"],
                                                  "duration": prepared["duration"], "sourceOriginSec": 0,
                                                  "ffmpeg": ff[0] if ff else ""}, TRANSCRIBE_TIMEOUT_SEC)
            if job["cancelled"]:
                raise RuntimeError("정렬이 취소됐습니다.")
            job["result"] = {**(reply or {}), "ok": True}
        except Exception as error:  # noqa: BLE001
            job["result"] = {"ok": False, "reason": str(error)}
        finally:
            worker.stop()
            job["done"].set()

    threading.Thread(target=work, name="autosub-realign", daemon=True).start()
    return {"state": "running"}


def realign_status(request_id: str, wait_sec: float = 0.0) -> dict[str, Any]:
    with _realign_lock:
        job = _realign_jobs.get(request_id)
    if job is None:
        return {"state": "done", "result": {"ok": False, "reason": "정렬이 취소됐습니다."}}
    if wait_sec > 0:
        job["done"].wait(wait_sec)
    if not job["done"].is_set():
        return {"state": "running"}
    with _realign_lock:
        _realign_jobs.pop(request_id, None)
    return {"state": "done", "result": job["result"]}


def cancel_realign(request_id: str) -> None:
    with _realign_lock:
        job = _realign_jobs.get(request_id)
    if job:
        job["cancelled"] = True
        job["worker"].stop("정렬을 취소했습니다.")
