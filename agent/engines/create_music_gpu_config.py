"""
ACE-Step 1.5 GPU 티어 구성 (공식 gpu_config.py / docs/ko/GPU_COMPATIBILITY.md 기준).

itmatzip Create-Music은 ACE-Step 공식 패키지(Python 3.12 venv)로 추론하며,
티어별로 길이·배치·모델 선택·CPU 오프로드를 제한합니다.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Optional

_SECTION_TAG_RE = re.compile(r"^\[([^\]]+)\]\s*$", re.IGNORECASE)
_INSTRUMENTAL_HINTS = frozenset(
    {"instrumental", "inst", "break", "solo", "interlude", "pad"}
)
_BLOCK_HINTS = frozenset({"intro", "outro", "bridge", "pre-chorus", "post-chorus"})

# 16GB급 GPU가 15.5GB 등으로 보고되는 경우 (공식과 동일)
VRAM_16GB_MIN_GB = 15.5
VRAM_AUTO_OFFLOAD_THRESHOLD_GB = 20.0

DEBUG_MAX_CUDA_VRAM_ENV = "MAX_CUDA_VRAM"

DIT_MODEL_KEYS = ("turbo", "sft", "base", "xl-turbo", "xl-sft", "xl-base")

# UI dit 키 → ACE-Step config_path (checkpoints 하위 폴더명)
DIT_MODEL_TO_CONFIG: dict[str, str] = {
    "turbo": "acestep-v15-turbo",
    "sft": "acestep-v15-sft",
    "base": "acestep-v15-base",
    "xl-turbo": "acestep-v15-xl-turbo",
    "xl-sft": "acestep-v15-xl-sft",
    "xl-base": "acestep-v15-xl-base",
}

LM_KEY_TO_CHECKPOINT: dict[str, str] = {
    "0.6B": "acestep-5Hz-lm-0.6B",
    "1.7B": "acestep-5Hz-lm-1.7B",
    "4B": "acestep-5Hz-lm-4B",
}
XL_DIT_KEYS = frozenset({"xl-turbo", "xl-sft", "xl-base"})
DIT_2B_KEYS = frozenset({"turbo", "sft", "base"})

LM_MODEL_KEYS = ("none", "0.6B", "1.7B", "4B")

TIER_LABELS_KO = {
    "tier1": "티어 1 — 초저 VRAM (≤4GB)",
    "tier2": "티어 2 — 저 VRAM (4–6GB)",
    "tier3": "티어 3 — 6–8GB",
    "tier4": "티어 4 — 8–12GB",
    "tier5": "티어 5 — 12–16GB",
    "tier6a": "티어 6a — 16–20GB",
    "tier6b": "티어 6b — 20–24GB",
    "unlimited": "제한 없음 (≥24GB)",
    "cpu": "CPU 전용",
}


@dataclass
class GpuTierSettings:
    max_duration_with_lm: int
    max_duration_without_lm: int
    max_batch_size_with_lm: int
    max_batch_size_without_lm: int
    init_lm_default: bool
    available_lm_models: list[str]
    recommended_lm_model: str
    offload_to_cpu_default: bool
    offload_dit_to_cpu_default: bool
    quantization_default: bool
    xl_supported: bool  # ❌ / ⚠️ / ✅
    xl_limited: bool  # 12–16GB: 오프로드 필수


GPU_TIER_CONFIGS: dict[str, GpuTierSettings] = {
    "tier1": GpuTierSettings(
        240, 360, 1, 1, False, [], "", True, True, True, False, False,
    ),
    "tier2": GpuTierSettings(
        480, 600, 1, 1, False, [], "", True, True, True, False, False,
    ),
    "tier3": GpuTierSettings(
        480, 600, 2, 2, True, ["0.6B"], "0.6B", True, True, True, False, False,
    ),
    "tier4": GpuTierSettings(
        480, 600, 2, 4, True, ["0.6B"], "0.6B", True, True, True, False, False,
    ),
    "tier5": GpuTierSettings(
        480, 600, 4, 4, True, ["0.6B", "1.7B"], "1.7B", True, False, True, True, True,
    ),
    "tier6a": GpuTierSettings(
        480, 600, 4, 8, True, ["0.6B", "1.7B"], "1.7B", True, False, True, True, False,
    ),
    "tier6b": GpuTierSettings(
        480, 480, 8, 8, True, ["0.6B", "1.7B", "4B"], "1.7B", False, False, False, True, False,
    ),
    "unlimited": GpuTierSettings(
        600, 600, 8, 8, True, ["0.6B", "1.7B", "4B"], "4B", False, False, False, True, False,
    ),
    "cpu": GpuTierSettings(
        240, 360, 1, 1, False, [], "", True, True, True, False, False,
    ),
}


@dataclass
class GpuConfig:
    tier: str
    vram_gb: float
    vram_mb: int
    settings: GpuTierSettings
    tier_label: str = ""

    def __post_init__(self) -> None:
        self.tier_label = TIER_LABELS_KO.get(self.tier, self.tier)


def detect_gpu_vram_mb() -> int:
    """GPU VRAM(MB). CUDA > nvidia-smi > 0."""
    debug = os.environ.get(DEBUG_MAX_CUDA_VRAM_ENV)
    if debug is not None:
        try:
            return int(float(debug) * 1024)
        except ValueError:
            pass

    try:
        import torch

        if torch.cuda.is_available():
            total = torch.cuda.get_device_properties(0).total_memory
            return int(total / (1024 * 1024))
    except Exception:
        pass

    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            text=True,
            timeout=5,
        )
        return int(out.strip().splitlines()[0])
    except Exception:
        return 0


def get_gpu_tier(vram_gb: float) -> str:
    if vram_gb <= 0:
        return "cpu"
    if vram_gb <= 4:
        return "tier1"
    if vram_gb <= 6:
        return "tier2"
    if vram_gb <= 8:
        return "tier3"
    if vram_gb <= 12:
        return "tier4"
    if vram_gb < VRAM_16GB_MIN_GB:
        return "tier5"
    if vram_gb < VRAM_AUTO_OFFLOAD_THRESHOLD_GB:
        return "tier6a"
    if vram_gb <= 24:
        return "tier6b"
    return "unlimited"


def get_gpu_config(vram_mb: Optional[int] = None) -> GpuConfig:
    if vram_mb is None:
        vram_mb = detect_gpu_vram_mb()
    vram_gb = vram_mb / 1024.0 if vram_mb > 0 else 0.0
    tier = get_gpu_tier(vram_gb)
    settings = GPU_TIER_CONFIGS[tier]
    return GpuConfig(tier=tier, vram_gb=vram_gb, vram_mb=vram_mb, settings=settings)


def resolve_config_path(dit_model: str) -> str:
    return DIT_MODEL_TO_CONFIG.get(dit_model, DIT_MODEL_TO_CONFIG["turbo"])


def resolve_lm_checkpoint(lm_model: str, config: GpuConfig) -> Optional[str]:
    lm = resolve_lm_model(lm_model, config)
    if lm == "none":
        return None
    return LM_KEY_TO_CHECKPOINT.get(lm)


def recommended_lm_backend(config: GpuConfig) -> str:
    """nano-vllm 설치 시 티어 4+는 vllm, 아니면 pt."""
    try:
        from engines import create_music_acestep_runtime as ace_rt

        prefer_vllm = config.tier in ("tier4", "tier5", "tier6a", "tier6b", "unlimited")
        return ace_rt.resolve_lm_backend(prefer_vllm=prefer_vllm)
    except Exception:
        return "pt"


def available_dit_models(config: GpuConfig) -> list[str]:
    """티어에서 선택 가능한 DiT 키 (UI용)."""
    s = config.settings
    if s.xl_supported:
        return list(DIT_MODEL_KEYS)
    return [k for k in DIT_MODEL_KEYS if k in DIT_2B_KEYS]


def recommend_models(config: GpuConfig) -> dict[str, str]:
    """VRAM 티어에 따른 추천 DiT/LM (README·GPU 가이드)."""
    s = config.settings
    if not s.xl_supported:
        dit = "turbo"
    elif config.tier in ("tier6b", "unlimited"):
        dit = "xl-turbo" if config.tier == "tier6b" else "xl-sft"
    elif s.xl_limited:
        dit = "xl-turbo"
    else:
        dit = "turbo"

    if not s.available_lm_models:
        lm = "none"
    elif s.recommended_lm_model in ("0.6B", "1.7B", "4B"):
        lm = s.recommended_lm_model
    else:
        lm = "none"

    return {"dit": dit, "lm": lm}


def estimate_duration_from_lyrics(
    lyrics: str,
    *,
    bpm: Optional[int] = None,
    max_sec: int = 480,
    min_sec: int = 30,
) -> float:
    """
    가사 줄·섹션 태그로 목표 길이(초)를 추정.
    ACE-Step LM CoT가 종종 60초로 고정하는 경우를 보완해 -1(자동) 시 DiT에 전달한다.
    """
    text = (lyrics or "").strip()
    if not text:
        return 60.0

    bpm_val = 120
    if bpm is not None:
        try:
            bpm_val = max(60, min(200, int(bpm)))
        except (TypeError, ValueError):
            pass
    sec_per_line = 3.5 * (120.0 / bpm_val)
    instrumental_sec = 16.0

    total = 0.0
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = _SECTION_TAG_RE.match(line)
        if m:
            tag = m.group(1).lower()
            if any(h in tag for h in _INSTRUMENTAL_HINTS):
                total += instrumental_sec
            elif any(h in tag for h in _BLOCK_HINTS):
                total += instrumental_sec * 0.75
            else:
                total += sec_per_line * 2.0
            continue
        if line.startswith("[") and "]" in line:
            head = line[1 : line.index("]")].lower()
            if any(h in head for h in _INSTRUMENTAL_HINTS):
                total += instrumental_sec
                continue
        total += sec_per_line

    total = max(float(min_sec), min(float(max_sec), total))
    return float(int((total + 2.5) // 5) * 5)


def resolve_lm_model(lm_model: str, config: GpuConfig) -> str:
    """auto / LM 키 → 실제 LM (티어에서 허용되지 않으면 none)."""
    s = config.settings
    if lm_model in ("", "auto", "none"):
        if lm_model == "auto":
            return recommend_models(config)["lm"]
        return "none"
    if lm_model not in s.available_lm_models:
        return "none"
    return lm_model


def clamp_generation_params(
    *,
    dit_model: str,
    lm_model: str,
    duration: float,
    batch_size: int,
    inference_steps: int,
    config: GpuConfig,
    use_lm: bool,
) -> tuple[str, str, float, int, int, list[str]]:
    """
    티어 한도에 맞게 파라미터 조정.
    반환: (dit, lm, duration, batch, steps, warnings)
    """
    s = config.settings
    warnings: list[str] = []

    dit = dit_model or "turbo"
    if dit in XL_DIT_KEYS and not s.xl_supported:
        dit = "turbo"
        warnings.append("현재 GPU에서는 XL DiT를 권장하지 않아 Turbo 설정으로 조정했습니다.")
    elif dit in XL_DIT_KEYS and s.xl_limited:
        warnings.append("XL DiT는 CPU 오프로드 모드로 실행됩니다 (12–16GB VRAM).")

    lm = resolve_lm_model(lm_model, config)
    if use_lm and lm == "none" and s.init_lm_default and s.available_lm_models:
        lm = s.recommended_lm_model
    if lm != "none" and lm not in s.available_lm_models:
        warnings.append(f"VRAM 티어({config.tier_label})에서 LM {lm}을 사용할 수 없어 LM을 끕니다.")
        lm = "none"

    max_dur = s.max_duration_with_lm if lm != "none" else s.max_duration_without_lm
    if duration <= 0:
        # UI -1: clamp 단계에서는 sentinel 유지 (create_music에서 가사 추정 후 양수로 변환)
        duration = -1.0
    elif duration > max_dur:
        warnings.append(f"최대 길이 {max_dur}초로 제한했습니다 (GPU 티어).")
        duration = float(max_dur)

    max_batch = s.max_batch_size_with_lm if lm != "none" else s.max_batch_size_without_lm
    if batch_size > max_batch:
        warnings.append(f"배치 크기를 {max_batch}로 제한했습니다 (GPU 티어).")
        batch_size = max_batch
    batch_size = max(1, batch_size)

    # Turbo diffusers: 공식 turbo는 8스텝 권장
    if dit in ("turbo", "xl-turbo") and inference_steps > 16:
        pass  # 사용자 프리셋 허용
    elif dit in ("sft", "base", "xl-sft", "xl-base") and inference_steps < 20:
        inference_steps = max(inference_steps, 20)

    return dit, lm, duration, batch_size, inference_steps, warnings


def pipeline_uses_cpu_offload(config: GpuConfig) -> bool:
    s = config.settings
    return s.offload_to_cpu_default or s.offload_dit_to_cpu_default or config.tier in (
        "tier1",
        "tier2",
        "tier3",
        "tier4",
        "cpu",
    )


# ACE-Step torchao 양자화 모드 (init_service_loader._build_quantization_config)
ACESTEP_QUANTIZATION_MODES = frozenset(
    {"int8_weight_only", "fp8_weight_only", "w8a8_dynamic"}
)


def normalize_quantization(value: str | bool | None) -> str | None:
    """UI/레거시 값을 ACE-Step이 인식하는 양자화 문자열로 변환."""
    if value is None or value is False:
        return None
    if value is True:
        return "int8_weight_only"
    raw = str(value).strip()
    if not raw or raw.lower() in ("none", "false", "0", "off", "no"):
        return None
    lowered = raw.lower()
    if lowered in ("int8", "int8_weight_only"):
        return "int8_weight_only"
    if lowered in ACESTEP_QUANTIZATION_MODES:
        return lowered
    return None


def inference_runtime_options(config: GpuConfig) -> dict:
    """ACE-Step initialize_service / LLM 옵션."""
    s = config.settings
    quant = normalize_quantization("int8_weight_only" if s.quantization_default else None)
    return {
        "offload_cpu": s.offload_to_cpu_default,
        "offload_dit": s.offload_dit_to_cpu_default,
        "quantization": quant,
        "compile_model": bool(quant),
        "lm_backend": recommended_lm_backend(config),
    }


def gpu_config_for_api(config: GpuConfig) -> dict:
    s = config.settings
    rec = recommend_models(config)
    return {
        "tier": config.tier,
        "tier_label": config.tier_label,
        "vram_mb": config.vram_mb,
        "vram_gb": round(config.vram_gb, 2),
        "xl_supported": s.xl_supported,
        "xl_limited": s.xl_limited,
        "recommended": rec,
        "limits": {
            "max_duration_with_lm_sec": s.max_duration_with_lm,
            "max_duration_without_lm_sec": s.max_duration_without_lm,
            "max_batch_with_lm": s.max_batch_size_with_lm,
            "max_batch_without_lm": s.max_batch_size_without_lm,
        },
        "defaults": {
            "init_lm": s.init_lm_default,
            "offload_cpu": s.offload_to_cpu_default,
            "offload_dit": s.offload_dit_to_cpu_default,
            "quantization": s.quantization_default,
        },
        "available_lm_models": list(s.available_lm_models),
        "available_dit_models": available_dit_models(config),
        "lm_implemented": True,
        "lm_note": (
            "LM: auto=가능 시 vllm(nano-vllm), 아니면 pt. "
            "환경 변수 ITMATZIP_ACESTEP_LM_BACKEND=vllm|pt|auto. "
            "6GB 이하에서는 LM 없이 DiT만 권장."
        ),
        "runtime": "acestep-3.12-venv",
        "docs": "https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/ko/GPU_COMPATIBILITY.md",
    }
