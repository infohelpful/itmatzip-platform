"""ACE-Step 1.5 음악 생성 엔진 — Python 3.12 전용 venv + 공식 acestep 패키지."""
from __future__ import annotations

import json
import logging
import os
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
    duration: float = -1.0
    bpm: Optional[int] = None
    keyscale: str = ""
    timesignature: str = ""
    batch_size: int = 1

    dit_model: str = "turbo"
    lm_model: str = "auto"
    inference_steps: int = 10
    guidance_scale: float = 5.0
    shift: float = 3.0
    seed: int = -1
    infer_method: str = "ode"
    audio_format: str = "wav"
    lora_name: Optional[str] = None

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


def start_prepare(force: bool = False) -> PrepareState:
    global _prepare_thread, _prepare_state
    if is_prepare_running():
        return _prepare_state

    if not force and all_dependencies_ready():
        _prepare_state = PrepareState(
            phase="done",
            progress=100.0,
            message="이미 설치되어 있습니다.",
        )
        return _prepare_state

    def _run():
        global _prepare_state
        try:
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

            root = ace_rt.resolve_acestep_root(
                message_cb=_on_acestep_src,
                force_download=force,
            )
            _set_progress(10, f"가상환경 준비 중… ({root})")

            _set_progress(12, "Python 3.12 가상환경·패키지 설치 중…")
            ace_rt.ensure_venv(on_progress=_set_progress)
            _set_progress(35, "가상환경 준비 완료")
            _prepare_state.phase = "downloading_model"
            _prepare_state.message = "모델 가중치 다운로드 중… (첫 실행 시 수 GB, 수 분~수십 분)"

            gpu_cfg = get_gpu_config()
            rec = recommend_models()
            dit_cfg = resolve_config_path(rec["dit"])
            lm_list: list[str] = []
            lm_ckpt = resolve_lm_checkpoint(rec["lm"], gpu_cfg)
            if lm_ckpt:
                lm_list.append(lm_ckpt)

            def _on_prog(pct: float, msg: str) -> None:
                mapped = 35 + (pct / 100.0) * 64
                _set_progress(mapped, msg)

            ace_rt.prepare_models(
                force=force,
                dit_configs=[dit_cfg, "acestep-v15-turbo"],
                lm_models=lm_list,
                on_progress=_on_prog,
            )

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

    if not all_dependencies_ready():
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
    use_lm = params.lm_model not in ("", "none") or params.lm_model == "auto"
    dit_model, lm_key, duration, batch_size, steps, tier_warnings = clamp_generation_params(
        dit_model=params.dit_model,
        lm_model=params.lm_model,
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
        "lm_backend": ace_rt.resolve_lm_backend(
            prefer_vllm=gpu_cfg.tier in ("tier4", "tier5", "tier6a", "tier6b", "unlimited"),
        ),
        "thinking": False,
        "params": {
            "task_type": params.task_type,
            "caption": params.caption,
            "lyrics": params.lyrics,
            "vocal_language": params.vocal_language,
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
    }
    (output_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    job.progress = 100
    job.status = "completed"
    job.message = "생성 완료"


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
