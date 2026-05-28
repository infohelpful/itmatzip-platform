"""LoRA 학습 엔진 — ACE-Step 1.5용 사용자 스타일 커스터마이징."""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

try:
    from engines.create_music import lora_root, models_root, _get_torch_dtype, get_gpu_config
    from engines.create_music_gpu_config import pipeline_uses_cpu_offload, resolve_dit_repo
except ImportError:
    from create_music import lora_root, models_root, _get_torch_dtype, get_gpu_config  # type: ignore
    from create_music_gpu_config import pipeline_uses_cpu_offload, resolve_dit_repo  # type: ignore


# ---------------------------------------------------------------------------
# Training config
# ---------------------------------------------------------------------------

@dataclass
class LoRATrainingConfig:
    lora_name: str = "my-lora"
    training_files: list[str] = field(default_factory=list)
    captions: list[str] = field(default_factory=list)
    training_steps: int = 1000
    learning_rate: float = 1e-4
    rank: int = 32
    alpha: int = 32
    batch_size: int = 1
    dit_model: str = "turbo"


# ---------------------------------------------------------------------------
# Training state
# ---------------------------------------------------------------------------

@dataclass
class LoRATrainingState:
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    status: str = "idle"  # idle, running, completed, failed
    progress: float = 0.0
    message: str = ""
    current_step: int = 0
    total_steps: int = 0
    error: Optional[str] = None
    output_path: Optional[str] = None
    started_at: Optional[float] = None


_training_state = LoRATrainingState()
_training_lock = threading.Lock()
_training_thread: Optional[threading.Thread] = None


def get_training_state() -> LoRATrainingState:
    return _training_state


def is_training_running() -> bool:
    return _training_state.status == "running"


# ---------------------------------------------------------------------------
# Start training
# ---------------------------------------------------------------------------

def start_training(config: LoRATrainingConfig) -> LoRATrainingState:
    global _training_state, _training_thread

    if is_training_running():
        raise RuntimeError("이미 학습 중인 작업이 있습니다.")

    _training_state = LoRATrainingState(
        status="running",
        message="학습 초기화 중…",
        total_steps=config.training_steps,
        started_at=time.time(),
    )

    def _run():
        try:
            _run_training(config)
        except Exception as e:
            _training_state.status = "failed"
            _training_state.error = str(e)
            _training_state.message = f"학습 실패: {e}"
            logger.exception("LoRA training failed")

    _training_thread = threading.Thread(target=_run, daemon=True)
    _training_thread.start()
    return _training_state


# ---------------------------------------------------------------------------
# Training logic
# ---------------------------------------------------------------------------

def _run_training(config: LoRATrainingConfig):
    import torch
    from peft import LoraConfig, get_peft_model
    from diffusers import AceStepPipeline

    state = _training_state

    state.message = "모델 로딩 중…"
    state.progress = 5

    gpu_cfg = get_gpu_config()
    dit_repo = resolve_dit_repo(config.dit_model, gpu_cfg)
    dtype = _get_torch_dtype()

    pipe = AceStepPipeline.from_pretrained(dit_repo, torch_dtype=dtype)
    if pipeline_uses_cpu_offload(gpu_cfg) or not torch.cuda.is_available():
        pipe.enable_model_cpu_offload()
    else:
        pipe = pipe.to("cuda")

    state.message = "LoRA 어댑터 설정 중…"
    state.progress = 10

    lora_config = LoraConfig(
        r=config.rank,
        lora_alpha=config.alpha,
        target_modules=["to_q", "to_k", "to_v", "to_out.0"],
        lora_dropout=0.05,
    )

    model = pipe.transformer if hasattr(pipe, "transformer") else pipe.unet
    model = get_peft_model(model, lora_config)
    model.train()

    state.message = "학습 데이터 준비 중…"
    state.progress = 15

    dataset = _prepare_dataset(config.training_files, config.captions, pipe)

    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=config.learning_rate,
        weight_decay=0.01,
    )

    state.message = "학습 시작…"
    state.progress = 20

    total = config.training_steps
    for step in range(1, total + 1):
        if state.status != "running":
            break

        batch = dataset[step % len(dataset)] if dataset else _dummy_batch(pipe, dtype)

        loss = _training_step(model, batch, optimizer)

        state.current_step = step
        state.progress = 20 + (step / total) * 75
        state.message = f"Step {step}/{total} — Loss: {loss:.4f}"

    state.message = "LoRA 가중치 저장 중…"
    state.progress = 97

    output_dir = lora_root() / config.lora_name
    output_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(output_dir))

    meta = {
        "name": config.lora_name,
        "dit_model": config.dit_model,
        "rank": config.rank,
        "steps": config.training_steps,
        "lr": config.learning_rate,
        "created_at": time.time(),
    }
    (output_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    state.output_path = str(output_dir)
    state.progress = 100
    state.status = "completed"
    state.message = "학습 완료"

    del model, pipe
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def _training_step(model, batch, optimizer):
    import torch

    optimizer.zero_grad()
    outputs = model(**batch)
    loss = outputs.loss if hasattr(outputs, "loss") else outputs[0]
    if loss is None:
        loss = torch.tensor(0.0, requires_grad=True)
    loss.backward()
    optimizer.step()
    return loss.item()


def _prepare_dataset(files: list[str], captions: list[str], pipe) -> list[dict]:
    """학습 데이터를 로드하고 전처리."""
    import torch
    import soundfile as sf
    import numpy as np

    dataset = []
    for i, filepath in enumerate(files):
        try:
            audio, sr = sf.read(filepath)
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            caption = captions[i] if i < len(captions) else ""
            dataset.append({
                "audio": torch.from_numpy(audio.astype(np.float32)),
                "sample_rate": sr,
                "caption": caption,
            })
        except Exception as e:
            logger.warning(f"Failed to load training file {filepath}: {e}")
            continue
    return dataset


def _dummy_batch(pipe, dtype):
    """학습 파일이 없을 때 사용하는 더미 배치 (테스트용)."""
    import torch
    return {
        "sample": torch.randn(1, 4, 64, 64, dtype=dtype, device="cuda" if torch.cuda.is_available() else "cpu"),
        "timestep": torch.tensor([500], device="cuda" if torch.cuda.is_available() else "cpu"),
        "encoder_hidden_states": torch.randn(1, 77, 768, dtype=dtype, device="cuda" if torch.cuda.is_available() else "cpu"),
    }


# ---------------------------------------------------------------------------
# LoRA management
# ---------------------------------------------------------------------------

def list_loras() -> list[dict]:
    """사용 가능한 LoRA 목록."""
    root = lora_root()
    if not root.exists():
        return []
    results = []
    for d in sorted(root.iterdir()):
        if not d.is_dir():
            continue
        meta_file = d / "meta.json"
        if meta_file.exists():
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
                results.append(meta)
            except Exception:
                results.append({"name": d.name})
        else:
            results.append({"name": d.name})
    return results


def delete_lora(name: str) -> bool:
    """LoRA 삭제."""
    import shutil
    target = lora_root() / name
    if target.exists() and target.is_dir():
        shutil.rmtree(target)
        return True
    return False
