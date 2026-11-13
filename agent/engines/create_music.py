"""ACE-Step 1.5 음악 생성 엔진 — Python 3.12 전용 venv + 공식 acestep 패키지."""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

try:
    from engines.create_music_gpu_config import (
        DIT_MODEL_KEYS,
        clamp_generation_params,
        detect_gpu_vram_mb,
        estimate_duration_from_lyrics,
        get_gpu_config,
        gpu_config_for_api,
        inference_runtime_options,
        normalize_quantization,
        recommend_models as _recommend_models_for_config,
        resolve_config_path,
        resolve_lm_checkpoint,
    )
    from engines import create_music_acestep_runtime as ace_rt
except ImportError:
    from create_music_gpu_config import (  # type: ignore[no-redef]
        DIT_MODEL_KEYS,
        clamp_generation_params,
        detect_gpu_vram_mb,
        estimate_duration_from_lyrics,
        get_gpu_config,
        gpu_config_for_api,
        inference_runtime_options,
        normalize_quantization,
        recommend_models as _recommend_models_for_config,
        resolve_config_path,
        resolve_lm_checkpoint,
    )
    import create_music_acestep_runtime as ace_rt  # type: ignore


def _data_root() -> Path:
    return Path(os.environ.get("ITMATZIP_DATA_ROOT", r"C:\ProgramData\itmatzip-agent"))


def workspace_root() -> Path:
    p = _data_root() / "create-music" / "workspace"
    p.mkdir(parents=True, exist_ok=True)
    return p


def models_root() -> Path:
    return ace_rt.acestep_checkpoints_dir()


def lora_root() -> Path:
    p = _data_root() / "create-music" / "lora"
    p.mkdir(parents=True, exist_ok=True)
    return p


def history_root() -> Path:
    p = _data_root() / "create-music" / "history"
    p.mkdir(parents=True, exist_ok=True)
    return p


def recommend_models(vram_mb: int | None = None) -> dict[str, str]:
    return _recommend_models_for_config(get_gpu_config(vram_mb))


def check_dependencies() -> dict[str, bool]:
    st = ace_rt.runtime_status()
    return {
        "python312": bool(st.get("python312")),
        "acestep_source": bool(st.get("acestep_root_ok")),
        "pytorch": bool(st.get("torch_ok")),
        "acestep_venv": bool(st.get("venv_ready")),
        "acestep_models": bool(st.get("models_ready")),
    }


def check_dependencies_fast() -> dict[str, bool]:
    """경로·가중치 폴더만 확인 — 접속 시 즉시 응답."""
    root_ok = False
    try:
        ace_rt.resolve_acestep_root()
        root_ok = True
    except Exception:
        root_ok = False
    py312 = False
    try:
        ace_rt.find_python312()
        py312 = True
    except Exception:
        py312 = False
    venv_fast = ace_rt.is_venv_ready_fast()
    models_fast = ace_rt.is_models_ready(require_venv=False)
    return {
        "python312": py312,
        "acestep_source": root_ok,
        "pytorch": venv_fast,
        "acestep_venv": venv_fast,
        "acestep_models": models_fast,
    }


def all_dependencies_ready() -> bool:
    return ace_rt.is_venv_ready() and ace_rt.is_models_ready()


def all_dependencies_ready_fast() -> bool:
    return ace_rt.is_venv_ready_fast() and ace_rt.is_models_ready(require_venv=False)


# ---------------------------------------------------------------------------
# Generation params
# ---------------------------------------------------------------------------


@dataclass
class GenerationParams:
    task_type: str = "text2music"
    caption: str = ""
    lyrics: str = ""
    vocal_language: str = "ko"
    vocal_type: str = "female"
    instrumental: bool = False
    duration: float = -1.0
    bpm: Optional[int] = None
    keyscale: str = ""
    timesignature: str = ""
    batch_size: int = 1

    dit_model: str = "turbo"
    lm_model: str = "none"  # 사용하지 않음 (하위 호환용 필드)
    inference_steps: int = 10
    guidance_scale: float = 5.0
    shift: float = 3.0
    seed: int = -1
    infer_method: str = "ode"
    audio_format: str = "wav"
    lora_name: Optional[str] = None
    # 화면 표시·「설정 다시 쓰기」용 정보 (제목·장르·보컬·가사 등) — 기록(meta.json)에 그대로 저장
    display: Optional[dict] = None

    src_audio_path: Optional[str] = None
    reference_audio_path: Optional[str] = None
    repainting_start: float = 0.0
    repainting_end: float = -1.0
    cover_strength: float = 1.0


@dataclass
class GenerationJob:
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    status: str = "pending"
    progress: float = 0.0
    message: str = ""
    output_paths: list[str] = field(default_factory=list)
    params: Optional[GenerationParams] = None
    created_at: float = field(default_factory=time.time)


_current_job: Optional[GenerationJob] = None
_job_lock = threading.Lock()
_generation_thread: Optional[threading.Thread] = None


def get_current_job() -> Optional[GenerationJob]:
    return _current_job


# ---------------------------------------------------------------------------
# Prepare
# ---------------------------------------------------------------------------


@dataclass
class PrepareState:
    phase: str = "idle"
    progress: float = 0.0
    message: str = ""
    error: Optional[str] = None


_prepare_state = PrepareState()
_prepare_thread: Optional[threading.Thread] = None


def get_prepare_state() -> PrepareState:
    return _prepare_state


def is_prepare_running() -> bool:
    return _prepare_state.phase not in ("idle", "done", "error")


def _fmt_bytes(done: int, total: int) -> str:
    if total >= 1024**3:
        return f"{done / 1024**3:.1f}/{total / 1024**3:.1f}GB"
    return f"{done / 1024**2:.0f}/{total / 1024**2:.0f}MB"


class _InstallBoard:
    """PyTorch·패키지·모델을 동시에 받을 때 진행률과 메시지를 하나로 합칩니다."""

    _LABELS = {"torch": "PyTorch", "packages": "패키지"}

    def __init__(self, publish) -> None:
        self._publish = publish  # (progress, message)
        self._lock = threading.Lock()
        self._bytes: dict[str, tuple[int, int]] = {}
        self._step = ""
        self._runtime_done = False
        self._model_frac = 0.0
        self._model_msg = ""

    def on_bytes(self, key: str, done: int, total: int) -> None:
        with self._lock:
            self._bytes[key] = (done, total)
        self._render()

    def on_step(self, _pct: float, msg: str) -> None:
        with self._lock:
            self._step = msg
        self._render()

    def runtime_done(self) -> None:
        with self._lock:
            self._runtime_done = True
            self._step = ""
        self._render()

    def on_model(self, pct: float, msg: str) -> None:
        # runner 진행률: 45(메인 모델) → 95(완료)
        with self._lock:
            self._model_frac = max(self._model_frac, min(1.0, max(0.0, (pct - 45.0) / 50.0)))
            self._model_msg = msg
        self._render()

    def _render(self) -> None:
        with self._lock:
            done = sum(d for d, _t in self._bytes.values())
            total = sum(t for _d, t in self._bytes.values())
            if self._runtime_done:
                rt_frac = 1.0
            elif total > 0:
                rt_frac = min(0.95, done / total)
            else:
                rt_frac = 0.0
            progress = 10.0 + 30.0 * rt_frac + 59.0 * self._model_frac
            parts: list[str] = []
            if not self._runtime_done:
                for key, (d, t) in self._bytes.items():
                    if t > 0 and d < t:
                        parts.append(f"{self._LABELS.get(key, key)} {_fmt_bytes(d, t)}")
                if not parts and self._step:
                    parts.append(self._step)
            if self._model_msg:
                parts.append(f"모델: {self._model_msg}")
            message = " · ".join(parts)
        if message:
            self._publish(progress, message)


def _cleanup_install_cache_async() -> None:
    def _run() -> None:
        try:
            ace_rt.cleanup_install_cache()
        except Exception as exc:
            logger.warning("install cache cleanup failed: %s", exc)

    threading.Thread(target=_run, name="cm-cache-cleanup", daemon=True).start()


def start_prepare(force: bool = False) -> PrepareState:
    global _prepare_thread, _prepare_state
    if is_prepare_running():
        return _prepare_state

    if not force and all_dependencies_ready_fast():
        _prepare_state = PrepareState(
            phase="done",
            progress=100.0,
            message="이미 설치되어 있습니다.",
        )
        # 예전 방식으로 설치된 PC에 남은 임시 파일(최대 11GB) 정리
        _cleanup_install_cache_async()
        return _prepare_state

    def _run():
        global _prepare_state
        try:
            if not force and all_dependencies_ready_fast():
                _prepare_state = PrepareState(
                    phase="done",
                    progress=100.0,
                    message="이미 설치되어 있습니다.",
                )
                return

            def _set_progress(pct: float, msg: str | None = None) -> None:
                _prepare_state.progress = max(_prepare_state.progress, min(99.0, float(pct)))
                if msg:
                    _prepare_state.message = msg

            _prepare_state = PrepareState(
                phase="installing_dependencies",
                progress=4,
                message="FFmpeg 설치 중…",
            )

            def _on_ff(msg: str) -> None:
                _set_progress(max(_prepare_state.progress, 5.0), msg)

            try:
                from common.bin_manager import ensure_ffmpeg

                ensure_ffmpeg(on_progress=lambda _p, _phase, msg: _on_ff(msg) if msg else None)
                _set_progress(8, "FFmpeg 준비 완료")
            except Exception as exc:
                logger.warning("ffmpeg prepare failed: %s", exc)
                _set_progress(8, f"FFmpeg 설치 실패 (MP3 다운로드 제한): {exc}")

            _prepare_state = PrepareState(
                phase="installing_dependencies",
                progress=5,
                message="ACE-Step 소스 확인·다운로드 중…",
            )

            def _on_acestep_src(msg: str) -> None:
                _set_progress(max(_prepare_state.progress, 6.0), msg)

            ace_rt.resolve_acestep_root(
                message_cb=_on_acestep_src,
                force_download=force,
            )

            # 화면에서 고를 수 있는 turbo(빠르게)·sft(고품질)만 받음.
            # LM은 받지 않음 — 생성에 thinking/CoT를 쓰지 않아 LM이 쓰이지 않음 (약 3.5GB 절약)
            model_kwargs = {
                "force": force,
                "dit_configs": list(ace_rt.REQUIRED_DIT_CONFIGS),
                "lm_models": [],
            }

            board = _InstallBoard(_set_progress)
            models: dict[str, Any] = {"thread": None, "error": None, "done": False}

            def _download_models() -> None:
                try:
                    ace_rt.prepare_models(
                        **model_kwargs, on_progress=board.on_model, runtime_ready=False
                    )
                    models["done"] = True
                except Exception as exc:
                    # 예: HuggingFace 대신 ModelScope로 받다가 PyTorch가 필요한 경우
                    # → 런타임 설치가 끝난 뒤 한 번 더 시도
                    logger.warning("parallel model download failed, will retry: %s", exc)
                    models["error"] = exc

            def _start_models() -> None:
                if models["thread"] is not None:
                    return
                t = threading.Thread(target=_download_models, name="cm-models", daemon=True)
                models["thread"] = t
                t.start()

            # PyTorch(공식 서버)·패키지(library-hub)·모델(HuggingFace)을 동시에 받기
            _set_progress(10, "PyTorch·패키지 받는 중…")
            try:
                ace_rt.ensure_venv(
                    on_progress=board.on_step,
                    force_repair_torch=force,
                    on_bytes=board.on_bytes,
                    on_packages_ready=_start_models,
                )
                board.runtime_done()
                _prepare_state.phase = "downloading_model"
            finally:
                # 실패해도 모델 다운로드 스레드가 끝날 때까지 기다림 (재시도 시 중복 다운로드 방지)
                t = models["thread"]
                if t is not None:
                    t.join()

            if not models["done"]:
                ace_rt.prepare_models(
                    **model_kwargs, on_progress=board.on_model, runtime_ready=True
                )

            _set_progress(99, "설치 임시 파일 정리 중…")
            ace_rt.cleanup_install_cache()

            _prepare_state.phase = "done"
            _prepare_state.progress = 100
            _prepare_state.message = "준비 완료"
        except Exception as e:
            _prepare_state.phase = "error"
            _prepare_state.error = str(e)
            _prepare_state.message = f"준비 실패: {e}"
            logger.exception("prepare failed")

    _prepare_thread = threading.Thread(target=_run, daemon=True)
    _prepare_thread.start()
    return _prepare_state


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------


def start_generation(params: GenerationParams) -> GenerationJob:
    global _current_job, _generation_thread

    if not all_dependencies_ready_fast():
        raise RuntimeError("환경 준비가 필요합니다. '환경 준비' 버튼을 먼저 실행하세요.")

    with _job_lock:
        if _current_job and _current_job.status == "running":
            raise RuntimeError("이미 생성 중인 작업이 있습니다.")
        job = GenerationJob(params=params, status="running", message="생성 시작…")
        _current_job = job

    def _run():
        try:
            _run_generation(job)
        except Exception as e:
            job.status = "failed"
            job.message = str(e)
            logger.exception("generation failed")

    _generation_thread = threading.Thread(target=_run, daemon=True)
    _generation_thread.start()
    return job


def _run_generation(job: GenerationJob) -> None:
    params = job.params
    assert params is not None

    gpu_cfg = get_gpu_config()
    # LM은 설치하지도 쓰지도 않음 (thinking/CoT 미사용) — 요청 값과 무관하게 끔
    use_lm = False
    dit_model, lm_key, duration, batch_size, steps, tier_warnings = clamp_generation_params(
        dit_model=params.dit_model,
        lm_model="none",
        duration=params.duration,
        batch_size=params.batch_size,
        inference_steps=params.inference_steps,
        config=gpu_cfg,
        use_lm=use_lm,
    )
    if tier_warnings:
        job.message = tier_warnings[0]

    duration_requested = params.duration
    duration_auto = False
    if duration <= 0:
        max_dur = gpu_cfg.settings.max_duration_with_lm if lm_key != "none" else gpu_cfg.settings.max_duration_without_lm
        duration = estimate_duration_from_lyrics(
            params.lyrics,
            bpm=params.bpm,
            max_sec=max_dur,
        )
        duration_auto = True
        est_msg = f"가사 기준 목표 길이 약 {int(duration)}초로 설정했습니다."
        job.message = est_msg if not tier_warnings else f"{tier_warnings[0]} · {est_msg}"

    config_path = resolve_config_path(dit_model)
    lm_checkpoint = resolve_lm_checkpoint(lm_key, gpu_cfg)
    runtime = inference_runtime_options(gpu_cfg)
    quant = normalize_quantization(runtime.get("quantization"))

    output_dir = history_root() / job.id
    output_dir.mkdir(parents=True, exist_ok=True)

    audio_format = "wav"

    payload = {
        "project_root": str(ace_rt.resolve_acestep_root()),
        "checkpoints_dir": str(ace_rt.acestep_checkpoints_dir()),
        "config_path": config_path,
        "output_dir": str(output_dir),
        "device": "auto",
        "offload_cpu": runtime["offload_cpu"],
        "offload_dit": runtime["offload_dit"],
        "quantization": quant,
        "compile_model": runtime["compile_model"] if quant else False,
        "lm_checkpoint": lm_checkpoint,
        "lm_backend": ace_rt.resolve_lm_backend(),
        "select_best": batch_size > 1,  # 여러 곡을 만들면 가사 정렬 점수가 가장 높은 한 곡만 남김
        "thinking": False,
        "params": {
            "task_type": params.task_type,
            "caption": params.caption,
            "lyrics": sanitize_lyrics(params.lyrics),
            "vocal_language": params.vocal_language,
            "vocal_type": params.vocal_type,
            "instrumental": params.instrumental,
            "use_cot_caption": False,
            "use_cot_language": False,
            "use_cot_metas": False,
            "duration": duration,
            "batch_size": batch_size,
            "inference_steps": steps,
            "guidance_scale": params.guidance_scale,
            "shift": params.shift,
            "seed": params.seed,
            "infer_method": params.infer_method,
            "audio_format": audio_format,
            "bpm": params.bpm,
            "keyscale": params.keyscale,
            "timesignature": params.timesignature,
            "src_audio_path": params.src_audio_path,
            "reference_audio_path": params.reference_audio_path,
            "repainting_start": params.repainting_start,
            "repainting_end": params.repainting_end,
            "cover_strength": params.cover_strength,
        },
    }

    def _on_prog(pct: float, msg: str) -> None:
        job.progress = pct
        if msg:
            job.message = msg

    job.progress = 5
    job.message = job.message or "ACE-Step 생성 프로세스 시작…"

    result = ace_rt.run_generation(payload, on_progress=_on_prog)
    if not result.get("ok"):
        raise RuntimeError(result.get("error") or "생성 실패")

    job.output_paths = result.get("output_files") or []
    if not job.output_paths:
        raise RuntimeError(
            "생성은 끝났지만 재생할 오디오 파일이 없습니다. "
            "출력 형식을 WAV로 바꾸고 다시 생성하세요."
        )
    meta = {
        "id": job.id,
        "seed": result.get("seed"),
        "params": {
            "caption": params.caption,
            "lyrics": params.lyrics,
            "dit_model": dit_model,
            "config_path": config_path,
            "lm_model": lm_key,
            "duration": duration,
            "duration_requested": duration_requested,
            "duration_auto": duration_auto,
            "batch_size": batch_size,
            "inference_steps": steps,
            "audio_format": audio_format,
            "gpu_tier": gpu_cfg.tier,
        },
        "tier_warnings": tier_warnings,
        "output_files": job.output_paths,
        "created_at": job.created_at,
        "display": sanitize_display(params.display),
        "peaks": [float(x) for x in (result.get("peaks") or [])][:200],
        "candidate_scores": result.get("candidate_scores"),
        "score_error": result.get("score_error"),
        "candidates": batch_size,
        "audio_duration": result.get("audio_duration"),
    }
    (output_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    job.progress = 100
    job.status = "completed"
    job.message = "생성 완료"


_DISPLAY_STR_KEYS = ("title", "vocal", "mood", "tempo", "lyrics", "vocal_language", "quality", "duration_choice")
_DISPLAY_LIST_KEYS = ("genres", "instruments", "vocal_styles")


def sanitize_display(raw: Any) -> dict:
    """화면에서 보낸 표시용 정보 — 알려진 키만, 길이 제한."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for key in _DISPLAY_STR_KEYS:
        val = raw.get(key)
        if isinstance(val, (str, int, float)) and not isinstance(val, bool):
            out[key] = str(val)[: 4000 if key == "lyrics" else 200]
    for key in _DISPLAY_LIST_KEYS:
        val = raw.get(key)
        if isinstance(val, list):
            out[key] = [str(v)[:60] for v in val if isinstance(v, (str, int, float))][:30]
    return out


_TAG_LINE = re.compile(r"^\s*\[[^\]\n]{1,40}\]\s*$")
_PAREN = re.compile(r"\([^)\n]*\)|（[^）\n]*）")
_SYMBOLS = re.compile(r"[~～…?？!！*＊#♪♬♩♫\"“”‘’—–]|\.{2,}")


def sanitize_lyrics(text: str) -> str:
    """보내기 직전 가사 정리: 구간 태그([Verse] 등)는 그대로 두고, 나머지 줄에서
    괄호 문구((Yeah) 등)와 ~ … ... ? ! 같은 기호를 제거한다. 모델이 기호를 소리 내려 해서 발음이 뭉개지는 것을 막는다."""
    if not isinstance(text, str):
        return ""
    out: list[str] = []
    for raw in text.replace("\r\n", "\n").split("\n"):
        if _TAG_LINE.match(raw):
            out.append(raw.strip())
            continue
        line = _SYMBOLS.sub(" ", _PAREN.sub(" ", raw))
        line = re.sub(r"[ \t]{2,}", " ", line).strip()
        if line or not raw.strip():
            out.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


_JOB_ID_OK = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def delete_history(job_id: str) -> bool:
    """만든 곡 한 개(기록 폴더 통째로: WAV·변환한 MP3·meta.json)를 지운다. 없으면 False.

    폴더 이름 검사 + history 폴더 밖이면 거부 + 지금 만드는 중인 곡은 거부.
    """
    if not isinstance(job_id, str) or not _JOB_ID_OK.match(job_id):
        raise ValueError("잘못된 곡 번호입니다.")
    job = _current_job
    if job and job.id == job_id and job.status in ("pending", "running"):
        raise RuntimeError("지금 만드는 중인 곡은 지울 수 없습니다.")
    root = history_root().resolve()
    target = (root / job_id).resolve()
    if target.parent != root:
        raise ValueError("잘못된 경로입니다.")
    if not target.is_dir():
        return False
    shutil.rmtree(target)
    return True


def list_history(limit: int = 50) -> list[dict]:
    items = []
    root = history_root()
    if not root.exists():
        return []
    for meta_file in sorted(root.glob("*/meta.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            items.append(json.loads(meta_file.read_text(encoding="utf-8")))
        except Exception:
            continue
        if len(items) >= limit:
            break
    return items
