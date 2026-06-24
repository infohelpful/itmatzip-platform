"""
Magic Canvas persistent inference worker — stdin JSON commands, stdout JSONL IPC.

Run inside %APPDATA%\\ItMatZip\\magic-canvas\\.venv-magiccanvas
"""

from __future__ import annotations

import json
import math
import os
import sys
import threading
import traceback
import gc
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# --- bootstrap env before heavy imports ---
def _bootstrap_env() -> None:
    models = os.environ.get("ITMATZIP_MAGIC_CANVAS_MODELS", "").strip()
    if models:
        os.environ["HF_HOME"] = models
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    os.environ.setdefault("PYTHONUTF8", "1")


def _configure_stdio_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
            except Exception:
                pass


_bootstrap_env()
_configure_stdio_utf8()

import numpy as np  # noqa: E402
from PIL import Image, ImageFilter, ImageOps  # noqa: E402

SDXL_BASE = "stabilityai/stable-diffusion-xl-base-1.0"
CONTROLNET_INPAINT = "destitech/controlnet-inpaint-dreamer-sdxl"
DEFAULT_STEPS = 30
DEFAULT_STRENGTH = 0.95
MAX_SDXL_SIDE = 1024
NEGATIVE_PROMPT = (
    "low quality, blurry, distorted, watermark, text, logo, artifacts, deformed"
)
# 사용자 프롬프트 없이 토큰화·CFG용 최소 문구만 사용 (장면 설명은 이미지 맥락에 의존)
OUTPAINT_AUTO_PROMPT = (
    "photograph, seamless natural extension of the same scene, continue landscape sky and ground, "
    "photorealistic, consistent lighting, matching texture and atmosphere"
)
OUTPAINT_NEGATIVE_EXTRA = (
    ", tree, fence, building, architecture, window, grid, wall, road, person, vehicle, cartoon, "
    "illustration, 3d render, painting, anime, different style, unrelated scenery, artificial, "
    "oversaturated, new objects, stripes, artifacts, seams"
)
OUTPAINT_CONTEXT = 192
OUTPAINT_STRIP_MAX = 128
OUTPAINT_GUIDANCE = 2.8
OUTPAINT_STRENGTH = 0.58
OUTPAINT_STEPS = 12
OUTPAINT_MASK_FEATHER = 48
OUTPAINT_SEAM_BLEND = 32
OUTPAINT_INFER_MAX_SIDE = 512
OUTPAINT_STRIP_EXPECT_SEC = 20.0
COMPOSE_DEFAULT_PROMPT = (
    "natural lighting, realistic shadows, seamless photo composite"
)
REMOVE_DEFAULT_PROMPT = (
    "clean background, seamless texture, high resolution, photorealistic"
)
INPAINT_DEFAULT_PROMPT = "high quality, photorealistic, detailed image"

# 모듈 1: 스마트 엣지 필 상수
SMART_FILL_SAMPLE_DEPTH = 16        # 가장자리 샘플링 깊이 (px)
SMART_FILL_FADE_WIDTH = 32          # 경계 페이드 폭 (px)
SMART_FILL_NOISE_BASE = 10          # 기본 노이즈 sigma
SMART_FILL_TEXTURE_THRESHOLD = 15   # 단순/복잡 텍스처 분류 임계값

# 모듈 2: 페더링 마스크 상수
OUTPAINT_INWARD_FEATHER = 24        # 원본 안쪽 침범 페더 (px)
OUTPAINT_OUTWARD_FEATHER = 48       # 확장 영역 페더 (px)
OUTPAINT_FEATHER_GAMMA_IN = 0.7     # 내부 페더 감마 (< 1 = 원본 우선)
OUTPAINT_FEATHER_GAMMA_OUT = 1.3    # 외부 페더 감마 (> 1 = 생성 우선)

_REMBG_SESSION = None
_PIPE = None
_VRAM_TIER = 0


def emit(payload: dict[str, Any]) -> None:
    line = json.dumps(payload, ensure_ascii=False) + "\n"
    try:
        sys.stdout.buffer.write(line.encode("utf-8"))
        sys.stdout.buffer.flush()
    except Exception:
        sys.stdout.write(line)
        sys.stdout.flush()


def emit_progress(progress: float, message: str = "") -> None:
    emit({"type": "progress", "progress": round(max(0.0, min(100.0, progress)), 1), "message": message})


def emit_error(message: str) -> None:
    emit({"type": "error", "message": message})




def _round_sdxl_side(value: int) -> int:
    return max(8, int(value) // 8 * 8)


def normalize_prompt(value: Any, *, default: str) -> str:
    """SDXL tokenizer는 빈 문자열·중첩 list 등에 실패할 수 있어 항상 plain str로 정규화."""
    if value is None:
        return default
    if isinstance(value, str):
        text = value.strip()
        return text or default
    if isinstance(value, (list, tuple)):
        parts: list[str] = []
        for item in value:
            if item is None:
                continue
            if isinstance(item, (list, tuple)):
                parts.extend(
                    str(part).strip()
                    for part in item
                    if part is not None and str(part).strip()
                )
            else:
                text = str(item).strip()
                if text:
                    parts.append(text)
        joined = ", ".join(parts)
        return joined or default
    text = str(value).strip()
    return text or default


def detect_vram_mb() -> int:
    try:
        import torch

        if torch.cuda.is_available():
            return int(torch.cuda.get_device_properties(0).total_memory / (1024 * 1024))
    except Exception:
        pass
    try:
        import subprocess

        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            text=True,
            timeout=5,
        )
        return int(out.strip().splitlines()[0])
    except Exception:
        return 0


def apply_vram_tier(pipe: Any, vram_mb: int, *, force_tier1: bool = False) -> int:
    global _VRAM_TIER
    if force_tier1 or vram_mb <= 6500:
        _VRAM_TIER = 1
        pipe.enable_sequential_cpu_offload()
    elif vram_mb <= 8500:
        _VRAM_TIER = 2
        pipe.enable_model_cpu_offload()
        pipe.enable_attention_slicing()
        pipe.enable_vae_tiling()
    elif vram_mb >= 12000:
        _VRAM_TIER = 3
        pipe.to("cuda")
        try:
            pipe.enable_attention_slicing(1)
            pipe.enable_vae_slicing()
        except Exception:
            pass
    else:
        _VRAM_TIER = 3
        pipe.enable_model_cpu_offload()
        pipe.enable_attention_slicing()
        pipe.enable_vae_tiling()
    return _VRAM_TIER


def _magic_canvas_root() -> Path:
    appdata = os.environ.get("APPDATA", "").strip()
    if appdata:
        return Path(appdata) / "ItMatZip" / "magic-canvas"
    return Path.home() / ".itmatzip" / "ItMatZip" / "magic-canvas"


def _local_controlnet_bundle() -> Path | None:
    cn = _magic_canvas_root() / "models" / "bundle" / "controlnet"
    if (cn / "config.json").is_file() and (cn / "diffusion_pytorch_model.fp16.safetensors").is_file():
        return cn
    return None


def _local_sdxl_bundle() -> Path | None:
    sdxl = _magic_canvas_root() / "models" / "bundle" / "sdxl-base"
    if (sdxl / "model_index.json").is_file() and (
        sdxl / "unet" / "diffusion_pytorch_model.fp16.safetensors"
    ).is_file():
        return sdxl
    return None


def _resolve_controlnet_source() -> str:
    explicit = os.environ.get("ITMATZIP_MAGIC_CANVAS_CONTROLNET_DIR", "").strip()
    if explicit and Path(explicit).is_dir():
        return explicit
    local = _local_controlnet_bundle()
    if local is not None:
        return str(local)
    return CONTROLNET_INPAINT


def _resolve_sdxl_source() -> str:
    explicit = os.environ.get("ITMATZIP_MAGIC_CANVAS_SDXL_DIR", "").strip()
    if explicit and Path(explicit).is_dir():
        return explicit
    local = _local_sdxl_bundle()
    if local is not None:
        return str(local)
    return SDXL_BASE


def _is_local_model_source(source: str) -> bool:
    return Path(source).is_dir()


def load_pipeline(*, force_tier1: bool = False) -> Any:
    global _PIPE
    env_force = os.environ.get("ITMATZIP_MAGIC_CANVAS_FORCE_TIER1", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )
    force_tier1 = force_tier1 or env_force
    if _PIPE is not None and not force_tier1:
        return _PIPE
    if force_tier1:
        _PIPE = None
    emit_progress(5, "PyTorch · CUDA 확인")
    import torch
    from diffusers import ControlNetModel, StableDiffusionXLControlNetInpaintPipeline

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA GPU가 필요합니다.")

    emit_progress(12, "ControlNet 로드")
    cn_source = _resolve_controlnet_source()
    controlnet = ControlNetModel.from_pretrained(
        cn_source,
        torch_dtype=torch.float16,
        variant="fp16",
        use_safetensors=True,
        local_files_only=_is_local_model_source(cn_source),
    )
    emit_progress(35, "SDXL Inpaint 파이프라인 로드")
    sdxl_source = _resolve_sdxl_source()
    pipe = StableDiffusionXLControlNetInpaintPipeline.from_pretrained(
        sdxl_source,
        controlnet=controlnet,
        torch_dtype=torch.float16,
        variant="fp16",
        use_safetensors=True,
        local_files_only=_is_local_model_source(sdxl_source),
    )
    vram = detect_vram_mb()
    tier = apply_vram_tier(pipe, vram, force_tier1=force_tier1)
    emit_progress(55, f"VRAM Tier {tier} ({vram}MB)" + (" [forced]" if force_tier1 else ""))
    _PIPE = pipe
    emit_progress(60, "모델 로드 완료")
    return pipe


def rembg_session():
    global _REMBG_SESSION
    if _REMBG_SESSION is None:
        from rembg import new_session

        _REMBG_SESSION = new_session()
    return _REMBG_SESSION


def load_rgb_image(path: str | Path) -> Image.Image:
    return ImageOps.exif_transpose(Image.open(path)).convert("RGB")


def load_mask_image(path: str | Path) -> Image.Image:
    mask = Image.open(path).convert("L")
    return mask


def _binarize_mask(mask: Image.Image) -> Image.Image:
    return mask.convert("L").point(lambda p: 255 if p > 127 else 0, mode="L")


def build_inpaint_control(canvas: Image.Image, mask: Image.Image, *, outpaint: bool) -> Image.Image:
    """ControlNet inpaint dreamer: 흰 영역=생성, 보존 영역=원본 픽셀."""
    canvas_rgb = canvas.convert("RGB")
    mask_bin = _binarize_mask(mask)
    if not outpaint:
        return mask_bin
    preserve = mask_bin.point(lambda p: 255 if p < 128 else 0, mode="L")
    control = Image.new("RGB", canvas_rgb.size, (255, 255, 255))
    control.paste(canvas_rgb, mask=preserve)
    return control


def feather_mask(mask: Image.Image, radius: int = 12) -> Image.Image:
    if radius <= 0:
        return mask
    return _binarize_mask(mask).filter(ImageFilter.GaussianBlur(radius))


def composite_preserve(original: Image.Image, generated: Image.Image, mask: Image.Image) -> Image.Image:
    """mask 흰=생성, 검정=원본 픽셀 그대로 복원."""
    preserve = _binarize_mask(mask).point(lambda p: 255 if p < 128 else 0, mode="L")
    out = generated.convert("RGB")
    out.paste(original.convert("RGB"), mask=preserve)
    return out


def preprocess_inpaint_inputs(
    image: Image.Image,
    mask: Image.Image,
    *,
    outpaint: bool = False,
) -> tuple[Image.Image, Image.Image, Image.Image]:
    """mask: white=inpaint, black=preserve."""
    image_rgb = image.convert("RGB")
    mask_bin = _binarize_mask(mask)
    control = build_inpaint_control(image_rgb, mask_bin, outpaint=outpaint)
    return image_rgb, mask_bin, control


def analyze_edge_texture(arr: np.ndarray, edge_box: tuple[int, int, int, int], 
                         sample_depth: int = SMART_FILL_SAMPLE_DEPTH) -> dict:
    """
    가장자리 텍스처 분석 — 단순/복잡 분류
    
    입력:
      arr: RGB numpy array (H, W, 3)
      edge_box: (x0, y0, x1, y1) — 샘플링할 가장자리 영역
      sample_depth: 샘플링 깊이 (px)
    
    출력:
      {
        'complexity': float,  # std_color.mean()
        'mean_color': np.ndarray (3,),
        'std_color': np.ndarray (3,),
        'is_simple': bool  # complexity < SMART_FILL_TEXTURE_THRESHOLD
      }
    """
    x0, y0, x1, y1 = edge_box
    
    # 가장자리 영역 추출
    edge_region = arr[y0:y1, x0:x1, :].astype(np.float32)
    
    if edge_region.size == 0:
        return {
            'complexity': 0.0,
            'mean_color': np.array([128.0, 128.0, 128.0]),
            'std_color': np.array([0.0, 0.0, 0.0]),
            'is_simple': True
        }
    
    mean_color = edge_region.mean(axis=(0, 1))
    std_color = edge_region.std(axis=(0, 1))
    complexity = std_color.mean()
    
    return {
        'complexity': float(complexity),
        'mean_color': mean_color,
        'std_color': std_color,
        'is_simple': complexity < SMART_FILL_TEXTURE_THRESHOLD
    }


def smart_edge_fill(canvas: Image.Image, px0: int, py0: int, px1: int, py1: int) -> Image.Image:
    """
    스마트 엣지 필 — OpenCV 기반 고속 미러링 및 주파수 분리
    
    입력:
      canvas: RGB 이미지 (확장 영역이 검은색으로 채워진 상태)
      px0, py0, px1, py1: 원본 영역 경계 좌표
    
    출력:
      filled_canvas: 확장 영역이 자연스럽게 채워진 이미지
    """
    import cv2

    arr = np.array(canvas.convert("RGB"), dtype=np.uint8)
    h, w = arr.shape[:2]

    # 원본 영역 추출
    original_region = arr[py0:py1, px0:px1, :].astype(np.uint8)
    oh, ow = original_region.shape[:2]

    # cv2.copyMakeBorder를 사용한 자연스러운 미러링 확장 (행렬 연산)
    border_left = px0
    border_right = w - px1
    border_top = py0
    border_bottom = h - py1

    extended = cv2.copyMakeBorder(
        original_region,
        border_top,
        border_bottom,
        border_left,
        border_right,
        cv2.BORDER_REFLECT_101,
    )

    # 주파수 분리: 저주파(거대한 색조 흐름) 추출
    low_freq = cv2.GaussianBlur(extended, (21, 21), 0).astype(np.float32)

    # 고주파(미세 질감) 추출: extended - low_freq
    high_freq = extended.astype(np.float32) - low_freq

    # 원본 영역의 고주파 통계로 노이즈 생성
    orig_low = cv2.GaussianBlur(original_region, (21, 21), 0).astype(np.float32)
    orig_high = original_region.astype(np.float32) - orig_low
    texture_std = max(orig_high.std(), 1.0)

    # 미세 노이즈: 원본 고주파 표준편차를 기반으로 생성 (NumPy 벡터화)
    rng = np.random.default_rng()
    noise = rng.normal(0.0, texture_std * 0.8, size=high_freq.shape).astype(np.float32)

    # 기본 저주파 + 노이즈(고주파 유사성) 결합
    base = low_freq + noise

    # 중앙(원본) 영역에는 원본의 고주파 질감을 다시 적용하여 텍스처 앵커링
    center_y0, center_y1 = border_top, border_top + oh
    center_x0, center_x1 = border_left, border_left + ow
    base_center = base[center_y0:center_y1, center_x0:center_x1]
    # 원본 고주파를 약간 강조하여 경계 질감을 유지
    anchored_center = (orig_low + orig_high * 1.0)
    base[center_y0:center_y1, center_x0:center_x1] = anchored_center

    # 페이드(알파) 맵 생성: 원본 영역에서 fade_width 픽셀 만큼 선형 감쇠
    fade_w = max(1, SMART_FILL_FADE_WIDTH)
    mask = np.zeros((base.shape[0], base.shape[1]), dtype=np.uint8)
    mask[center_y0:center_y1, center_x0:center_x1] = 255

    # distanceTransform을 사용해 각 픽셀이 원본에서 얼마나 떨어져 있는지 계산
    inv_mask = cv2.bitwise_not(mask)
    dist = cv2.distanceTransform(inv_mask, cv2.DIST_L2, 5)

    alpha_outside = np.clip(1.0 - (dist / float(fade_w)), 0.0, 1.0)
    alpha = alpha_outside
    alpha[mask == 255] = 1.0

    # 소프트 마스크 3채널로 확장
    alpha_3 = np.repeat(alpha[:, :, np.newaxis], 3, axis=2).astype(np.float32)

    # source: 저주파 + 원본 고주파 앵커(이미 base에 적용됨)
    source = base.astype(np.float32)

    # final: base(저주파+노이즈)와 source(원본 텍스처가 앵커된 버전)에 alpha로 블렌드
    final = base * (1.0 - alpha_3) + source * alpha_3
    final = np.clip(final, 0, 255).astype(np.uint8)

    return Image.fromarray(final)


def _prefill_outpaint_edges(canvas: Image.Image, px0: int, py0: int, px1: int, py1: int) -> Image.Image:
    """스마트 엣지 필로 교체 — smart_edge_fill() 호출"""
    return smart_edge_fill(canvas, px0, py0, px1, py1)


def _edge_fill_strip(canvas: Image.Image, fill_box: tuple[int, int, int, int], *, axis: str, inward: bool) -> Image.Image:
    """스트립 추론 직전, 맥락 픽셀을 이웃 열/행으로 채워 연속성 확보."""
    x0, y0, x1, y1 = fill_box
    arr = np.array(canvas.convert("RGB"), dtype=np.uint8)
    h, w = arr.shape[:2]
    import cv2

    # avoid single-column/row tiling which produces visible stripes
    if axis == "x":
        src_x = x1 if inward else x0 - 1
        src_x = int(max(0, min(w - 1, src_x)))
        # take a small multi-column patch around source to preserve texture
        left = max(0, src_x - 3)
        right = min(w, src_x + 4)
        src_patch = arr[y0:y1, left:right, :].astype(np.float32)
        if src_patch.size == 0:
            return Image.fromarray(arr)
        # average horizontally to get per-row color trend, then tile across fill width
        row_avg = src_patch.mean(axis=1, keepdims=True)  # shape (H,1,3)
        fill_w = x1 - x0
        tiled = np.tile(row_avg, (1, fill_w, 1)).astype(np.float32)
        # apply horizontal-leaning blur to break repetition and produce smooth continuation
        kx = max(3, min(31, (fill_w // 4) | 1))
        ky = 7
        blurred = cv2.GaussianBlur(tiled.astype(np.uint8), (kx, ky), 0)
        arr[y0:y1, x0:x1, :] = blurred
    else:
        src_y = y1 if inward else y0 - 1
        src_y = int(max(0, min(h - 1, src_y)))
        top = max(0, src_y - 3)
        bot = min(h, src_y + 4)
        src_patch = arr[top:bot, x0:x1, :].astype(np.float32)
        if src_patch.size == 0:
            return Image.fromarray(arr)
        col_avg = src_patch.mean(axis=0, keepdims=True)  # shape (1,W,3)
        fill_h = y1 - y0
        tiled = np.tile(col_avg, (fill_h, 1, 1)).astype(np.float32)
        kx = 7
        ky = max(3, min(31, (fill_h // 4) | 1))
        blurred = cv2.GaussianBlur(tiled.astype(np.uint8), (kx, ky), 0)
        arr[y0:y1, x0:x1, :] = blurred
    out_img = Image.fromarray(arr)
    return out_img


def _release_gpu_memory() -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


@dataclass
class _OutpaintProgress:
    total_strips: int
    global_start: float = 18.0
    global_end: float = 92.0
    completed: int = 0
    current_label: str = field(default="아웃페인트")

    def begin_strip(self, label: str, local_idx: int, local_total: int) -> None:
        self.current_label = f"{label} {local_idx}/{local_total} (전체 {self.completed + 1}/{self.total_strips})"

    def pct_for_elapsed(self, elapsed_sec: float) -> float:
        if elapsed_sec <= OUTPAINT_STRIP_EXPECT_SEC:
            in_strip = max(0.03, elapsed_sec / OUTPAINT_STRIP_EXPECT_SEC)
        else:
            extra = elapsed_sec - OUTPAINT_STRIP_EXPECT_SEC
            in_strip = min(0.995, 0.97 + extra / 90.0)
        overall = (self.completed + in_strip) / max(1, self.total_strips)
        return self.global_start + (self.global_end - self.global_start) * overall

    def finish_strip(self) -> None:
        self.completed += 1
        overall = self.completed / max(1, self.total_strips)
        pct = self.global_start + (self.global_end - self.global_start) * overall
        emit_progress(pct, f"{self.current_label} 완료")


def _count_outpaint_strips(gap: int) -> int:
    if gap <= 0:
        return 0
    return max(1, math.ceil(gap / OUTPAINT_STRIP_MAX))


def _downscale_for_infer(
    image: Image.Image,
    mask: Image.Image,
    *,
    max_side: int = OUTPAINT_INFER_MAX_SIDE,
) -> tuple[Image.Image, Image.Image, float]:
    w, h = image.size
    side = max(w, h)
    if side <= max_side:
        return image, mask, 1.0
    scale = max_side / side
    nw = _round_sdxl_side(max(8, int(w * scale)))
    nh = _round_sdxl_side(max(8, int(h * scale)))
    return (
        image.resize((nw, nh), Image.Resampling.LANCZOS),
        mask.resize((nw, nh), Image.Resampling.NEAREST),
        scale,
    )


def _capture_horizontal_seam_band(work: Image.Image, seam_x: int, blend_px: int) -> tuple[Image.Image, int]:
    w, _h = work.size
    x0 = max(0, seam_x - blend_px)
    x1 = min(w, seam_x + blend_px)
    return work.crop((x0, 0, x1, work.size[1])).copy(), x0


def _capture_vertical_seam_band(work: Image.Image, seam_y: int, blend_px: int) -> tuple[Image.Image, int]:
    _w, h = work.size
    y0 = max(0, seam_y - blend_px)
    y1 = min(h, seam_y + blend_px)
    return work.crop((0, y0, work.size[0], y1)).copy(), y0


def _horizontal_seam_blend_band(
    work: Image.Image,
    before_band: Image.Image,
    band_x0: int,
    seam_x: int,
    blend_px: int,
) -> None:
    if blend_px <= 0:
        return
    w, h = work.size
    x0 = max(0, seam_x - blend_px)
    x1 = min(w, seam_x + blend_px)
    if x1 <= x0:
        return
    cur = np.array(work.crop((x0, 0, x1, h)).convert("RGB"), dtype=np.float32)
    prev = np.array(before_band.convert("RGB"), dtype=np.float32)
    if cur.shape != prev.shape:
        return
    span = max(1, x1 - x0 - 1)
    t = ((np.arange(x0, x1) - x0) / span).reshape(1, -1, 1)
    cur = prev * (1.0 - t) + cur * t
    work.paste(Image.fromarray(cur.clip(0, 255).astype(np.uint8)), (band_x0, 0))


def _vertical_seam_blend_band(
    work: Image.Image,
    before_band: Image.Image,
    band_y0: int,
    seam_y: int,
    blend_px: int,
) -> None:
    if blend_px <= 0:
        return
    w, h = work.size
    y0 = max(0, seam_y - blend_px)
    y1 = min(h, seam_y + blend_px)
    if y1 <= y0:
        return
    cur = np.array(work.crop((0, y0, w, y1)).convert("RGB"), dtype=np.float32)
    prev = np.array(before_band.convert("RGB"), dtype=np.float32)
    if cur.shape != prev.shape:
        return
    span = max(1, y1 - y0 - 1)
    t = ((np.arange(y0, y1) - y0) / span).reshape(-1, 1, 1)
    cur = prev * (1.0 - t) + cur * t
    work.paste(Image.fromarray(cur.clip(0, 255).astype(np.uint8)), (0, band_y0))


@dataclass
class StyleProfile:
    """이미지 스타일 분석 결과"""
    style: str                              # "vintage_sepia" | "grayscale" | ...
    complexity: str                         # "low" | "medium" | "high"
    dominant_colors: list[tuple[int,int,int]]  # 상위 5개 색상
    edge_mean_color: tuple[float,float,float]  # 가장자리 평균 색상
    saturation_mean: float
    value_mean: float


@dataclass
class InferenceParams:
    """동적 추론 파라미터"""
    prompt: str
    negative_prompt: str
    strength: float
    guidance_scale: float
    cn_scale: float
    steps: int


def analyze_image_style(image: Image.Image) -> StyleProfile:
    """
    이미지 스타일 분석
    
    입력: RGB 이미지
    출력: StyleProfile
    """
    import cv2
    
    arr = np.array(image.convert("RGB"), dtype=np.uint8)
    h, w = arr.shape[:2]
    
    # HSV 변환
    hsv = cv2.cvtColor(arr, cv2.COLOR_RGB2HSV)
    
    # 색상 통계
    saturation_mean = hsv[:, :, 1].mean() / 255.0
    value_mean = hsv[:, :, 2].mean() / 255.0
    hue_std = hsv[:, :, 0].std()
    
    # RGB 채널 평균
    r_mean = arr[:, :, 0].mean()
    g_mean = arr[:, :, 1].mean()
    b_mean = arr[:, :, 2].mean()
    
    # 스타일 분류
    if r_mean > g_mean > b_mean and saturation_mean < 0.25:
        style = "vintage_sepia"
    elif max(r_mean - g_mean, g_mean - b_mean, r_mean - b_mean) < 10 and saturation_mean < 0.08:
        style = "grayscale"
    elif saturation_mean > 0.45:
        style = "vivid_color"
    elif h > h // 3 and arr[:h//3, :, 2].mean() > 100:  # 상단이 밝음 (하늘)
        style = "landscape"
    else:
        style = "photo_realistic"
    
    # 텍스처 복잡도
    gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    laplacian_var = cv2.Laplacian(gray, cv2.CV_64F).var()
    
    if laplacian_var < 100:
        complexity = "low"
    elif laplacian_var < 500:
        complexity = "medium"
    else:
        complexity = "high"
    
    # 도미넌트 컬러 (간단한 양자화)
    resized = cv2.resize(arr, (50, 50))
    reshaped = resized.reshape(-1, 3)
    unique_colors = np.unique(reshaped, axis=0)
    dominant_colors = [tuple(c) for c in unique_colors[:5]]
    
    # 가장자리 평균 색상
    border = 32
    edge_region = np.vstack([
        arr[:border, :, :].reshape(-1, 3),
        arr[-border:, :, :].reshape(-1, 3),
        arr[:, :border, :].reshape(-1, 3),
        arr[:, -border:, :].reshape(-1, 3)
    ])
    edge_mean_color = tuple(edge_region.mean(axis=0))
    
    return StyleProfile(
        style=style,
        complexity=complexity,
        dominant_colors=dominant_colors,
        edge_mean_color=edge_mean_color,
        saturation_mean=saturation_mean,
        value_mean=value_mean
    )


def build_dynamic_params(profile: StyleProfile, user_prompt: str = "") -> InferenceParams:
    """
    스타일 프로필을 기반으로 동적 파라미터 생성
    
    입력:
      profile: StyleProfile
      user_prompt: 사용자 입력 프롬프트 (선택사항)
    
    출력:
      InferenceParams
    """
    # 프롬프트 생성
    if profile.style == "vintage_sepia":
        prompt = (
            "vintage photograph, sepia tone, aged paper texture, "
            "monochromatic warm tones, historical photo, film grain, "
            "seamless continuation of the same aged photograph"
        )
        negative = NEGATIVE_PROMPT + ", colorful, vivid colors, modern, digital art, bright colors, saturated"
    elif profile.style == "grayscale":
        prompt = (
            "black and white photograph, monochromatic, grayscale, "
            "film photography, seamless continuation"
        )
        negative = NEGATIVE_PROMPT + ", color, colorful, sepia, warm tones"
    elif profile.style == "vivid_color":
        prompt = (
            "vibrant colors, high saturation, colorful scene, "
            "seamless natural extension"
        )
        negative = NEGATIVE_PROMPT + ", desaturated, muted colors, grayscale"
    elif profile.style == "landscape":
        prompt = (
            "natural landscape, sky, horizon, outdoor scene, "
            "seamless continuation of the same environment"
        )
        negative = NEGATIVE_PROMPT + ", building, person, vehicle, indoor"
    else:
        prompt = OUTPAINT_AUTO_PROMPT
        negative = NEGATIVE_PROMPT + OUTPAINT_NEGATIVE_EXTRA
    
    # denoising_strength 계산
    strength = OUTPAINT_STRENGTH  # 0.58
    
    if profile.complexity == "low":
        strength = 0.52
    elif profile.complexity == "high":
        strength = 0.65
    
    if profile.style in ("vintage_sepia", "grayscale"):
        strength -= 0.05
    elif profile.style == "vivid_color":
        strength += 0.03
    
    strength = max(0.45, min(0.72, strength))
    
    # guidance_scale 계산
    if profile.style == "vintage_sepia":
        guidance_scale = 2.2
    elif profile.style == "grayscale":
        guidance_scale = 2.0
    elif profile.style == "vivid_color":
        guidance_scale = 3.2
    elif profile.style == "landscape":
        guidance_scale = 3.0
    else:
        guidance_scale = OUTPAINT_GUIDANCE  # 2.8
    
    # controlnet_conditioning_scale 계산
    cn_scale = 0.78
    
    if profile.complexity == "high":
        cn_scale = 0.85
    elif profile.complexity == "low":
        cn_scale = 0.70
    
    if profile.style == "vintage_sepia":
        cn_scale = 0.90
    elif profile.style == "grayscale":
        cn_scale = 0.88
    elif profile.style == "vivid_color":
        cn_scale = 0.75
    elif profile.style == "landscape":
        cn_scale = 0.80
    
    return InferenceParams(
        prompt=prompt,
        negative_prompt=negative,
        strength=strength,
        guidance_scale=guidance_scale,
        cn_scale=cn_scale,
        steps=OUTPAINT_STEPS  # 12
    )


def _run_inpaint_pipe(
    pipe: Any,
    pipe_kwargs: dict[str, Any],
    *,
    prog: _OutpaintProgress,
) -> Image.Image:
    stop = threading.Event()

    def _heartbeat() -> None:
        tick = 0
        while not stop.wait(3.0):
            tick += 1
            elapsed = tick * 3
            emit_progress(prog.pct_for_elapsed(elapsed), f"{prog.current_label} — GPU ({elapsed}초)")

    hb = threading.Thread(target=_heartbeat, daemon=True, name="magic-canvas-inpaint-hb")
    hb.start()
    try:
        try:
            pipe.set_progress_bar_config(disable=True)
        except Exception:
            pass
        import torch

        with torch.inference_mode():
            return pipe(**pipe_kwargs).images[0]
    finally:
        stop.set()
        hb.join(timeout=0.2)
        prog.finish_strip()


def run_inpaint(
    image: Image.Image,
    mask: Image.Image,
    *,
    prompt: str,
    steps: int = DEFAULT_STEPS,
    strength: float = DEFAULT_STRENGTH,
    default_prompt: str = INPAINT_DEFAULT_PROMPT,
    outpaint_mode: bool = False,
    guidance_scale: float | None = None,
    negative_prompt: str | None = None,
    progress_tracker: _OutpaintProgress | None = None,
) -> Image.Image:
    pipe = load_pipeline()
    image_rgb, mask_bin, control = preprocess_inpaint_inputs(image, mask, outpaint=outpaint_mode)
    pipe_mask = feather_mask(mask_bin, radius=OUTPAINT_MASK_FEATHER if outpaint_mode else 0)
    if outpaint_mode:
        clean_prompt = OUTPAINT_AUTO_PROMPT
        pipe_strength = OUTPAINT_STRENGTH
        steps = OUTPAINT_STEPS
    else:
        clean_prompt = normalize_prompt(prompt, default=default_prompt)
        pipe_strength = strength
    neg = negative_prompt if negative_prompt is not None else (
        NEGATIVE_PROMPT + OUTPAINT_NEGATIVE_EXTRA if outpaint_mode else NEGATIVE_PROMPT
    )
    gscale = guidance_scale if guidance_scale is not None else (OUTPAINT_GUIDANCE if outpaint_mode else 7.5)
    if not outpaint_mode:
        emit_progress(70, "SDXL 인페인트 추론")
    pipe_kwargs: dict[str, Any] = {
        "prompt": clean_prompt,
        "prompt_2": clean_prompt,
        "negative_prompt": neg,
        "negative_prompt_2": neg,
        "image": image_rgb,
        "mask_image": pipe_mask,
        "control_image": control,
        "num_inference_steps": steps,
        "strength": pipe_strength,
        "guidance_scale": gscale,
        "controlnet_conditioning_scale": 0.78 if outpaint_mode else 1.0,
    }
    if outpaint_mode and progress_tracker is not None:
        generated = _run_inpaint_pipe(pipe, pipe_kwargs, prog=progress_tracker)
    else:
        generated = pipe(**pipe_kwargs).images[0]
    result = composite_preserve(image_rgb, generated, mask_bin)
    return result


def _preserve_rect(mask: Image.Image) -> tuple[int, int, int, int]:
    arr = np.array(mask.convert("L"))
    ys, xs = np.where(arr < 128)
    if len(xs) == 0:
        w, h = mask.size
        return 0, 0, w, h
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def _strip_mask(
    size: tuple[int, int],
    *,
    global_box: tuple[int, int, int, int],
    fill_box: tuple[int, int, int, int],
) -> Image.Image:
    """crop 좌표계에서 fill_box만 흰색(생성), 나머지 검정(보존)."""
    cw, ch = size
    gx0, gy0, gx1, gy1 = global_box
    fx0, fy0, fx1, fy1 = fill_box
    m = Image.new("L", (cw, ch), 0)
    lx0 = max(0, fx0 - gx0)
    ly0 = max(0, fy0 - gy0)
    lx1 = min(cw, fx1 - gx0)
    ly1 = min(ch, fy1 - gy0)
    if lx1 > lx0 and ly1 > ly0:
        patch = Image.new("L", (lx1 - lx0, ly1 - ly0), 255)
        m.paste(patch, (lx0, ly0))
    return m


def _inpaint_outpaint_strip(
    crop: Image.Image,
    strip_mask: Image.Image,
    *,
    prog: _OutpaintProgress,
) -> Image.Image:
    orig_size = crop.size
    infer_crop, infer_mask, _scale = _downscale_for_infer(crop, strip_mask)

    result = run_inpaint(
        infer_crop,
        infer_mask,
        prompt="",
        outpaint_mode=True,
        progress_tracker=prog,
    )
    if result.size != orig_size:
        result = result.resize(orig_size, Image.Resampling.LANCZOS)
    return result


def _extend_left_strips(
    work: Image.Image,
    work_mask: Image.Image,
    px0: int,
    prog: _OutpaintProgress,
) -> None:
    if px0 <= 0:
        return
    w, h = work.size
    strips = _count_outpaint_strips(px0)
    edge = px0
    done = 0
    while edge > 0:
        strip_w = min(OUTPAINT_STRIP_MAX, edge)
        x0 = edge - strip_w
        x1 = edge
        crop_x0 = max(0, x0 - OUTPAINT_CONTEXT)
        crop_x1 = x1
        crop = work.crop((crop_x0, 0, crop_x1, h))
        crop = _edge_fill_strip(crop, (x0 - crop_x0, 0, x1 - crop_x0, h), axis="x", inward=True)
        strip_mask = _strip_mask(
            crop.size,
            global_box=(crop_x0, 0, crop_x1, h),
            fill_box=(x0, 0, x1, h),
        )
        if strip_mask.getbbox() is None:
            break
        prog.begin_strip("좌측", done + 1, strips)
        seam_band, band_x0 = _capture_horizontal_seam_band(work, x1, OUTPAINT_SEAM_BLEND)
        result = _inpaint_outpaint_strip(crop, strip_mask, prog=prog)
        work.paste(result, (crop_x0, 0))
        _horizontal_seam_blend_band(work, seam_band, band_x0, x1, OUTPAINT_SEAM_BLEND)
        work_mask.paste(Image.new("L", (strip_w, h), 0), (x0, 0))
        edge = x0
        done += 1
        _release_gpu_memory()


def _extend_right_strips(
    work: Image.Image,
    work_mask: Image.Image,
    px1: int,
    prog: _OutpaintProgress,
) -> None:
    w, h = work.size
    if px1 >= w:
        return
    strips = _count_outpaint_strips(w - px1)
    edge = px1
    done = 0
    while edge < w:
        strip_w = min(OUTPAINT_STRIP_MAX, w - edge)
        x0 = edge
        x1 = edge + strip_w
        crop_x0 = max(0, x0 - OUTPAINT_CONTEXT)
        crop_x1 = x1
        crop = work.crop((crop_x0, 0, crop_x1, h))
        fill_local = (x0 - crop_x0, 0, x1 - crop_x0, h)
        crop = _edge_fill_strip(crop, fill_local, axis="x", inward=False)
        strip_mask = _strip_mask(
            crop.size,
            global_box=(crop_x0, 0, crop_x1, h),
            fill_box=(x0, 0, x1, h),
        )
        if strip_mask.getbbox() is None:
            break
        prog.begin_strip("우측", done + 1, strips)
        seam_band, band_x0 = _capture_horizontal_seam_band(work, x0, OUTPAINT_SEAM_BLEND)
        result = _inpaint_outpaint_strip(crop, strip_mask, prog=prog)
        work.paste(result, (crop_x0, 0))
        _horizontal_seam_blend_band(work, seam_band, band_x0, x0, OUTPAINT_SEAM_BLEND)
        work_mask.paste(Image.new("L", (strip_w, h), 0), (x0, 0))
        edge = x1
        done += 1
        _release_gpu_memory()


def _extend_top_strips(
    work: Image.Image,
    work_mask: Image.Image,
    py0: int,
    prog: _OutpaintProgress,
) -> None:
    if py0 <= 0:
        return
    w, h = work.size
    strips = _count_outpaint_strips(py0)
    edge = py0
    done = 0
    while edge > 0:
        strip_h = min(OUTPAINT_STRIP_MAX, edge)
        y0 = edge - strip_h
        y1 = edge
        crop_y0 = max(0, y0 - OUTPAINT_CONTEXT)
        crop_y1 = y1
        crop = work.crop((0, crop_y0, w, crop_y1))
        crop = _edge_fill_strip(crop, (0, y0 - crop_y0, w, y1 - crop_y0), axis="y", inward=True)
        strip_mask = _strip_mask(
            crop.size,
            global_box=(0, crop_y0, w, crop_y1),
            fill_box=(0, y0, w, y1),
        )
        if strip_mask.getbbox() is None:
            break
        prog.begin_strip("상단", done + 1, strips)
        seam_band, band_y0 = _capture_vertical_seam_band(work, y1, OUTPAINT_SEAM_BLEND)
        result = _inpaint_outpaint_strip(crop, strip_mask, prog=prog)
        work.paste(result, (0, crop_y0))
        _vertical_seam_blend_band(work, seam_band, band_y0, y1, OUTPAINT_SEAM_BLEND)
        work_mask.paste(Image.new("L", (w, strip_h), 0), (0, y0))
        edge = y0
        done += 1
        _release_gpu_memory()


def _extend_bottom_strips(
    work: Image.Image,
    work_mask: Image.Image,
    py1: int,
    prog: _OutpaintProgress,
) -> None:
    w, h = work.size
    if py1 >= h:
        return
    strips = _count_outpaint_strips(h - py1)
    edge = py1
    done = 0
    while edge < h:
        strip_h = min(OUTPAINT_STRIP_MAX, h - edge)
        y0 = edge
        y1 = edge + strip_h
        crop_y0 = max(0, y0 - OUTPAINT_CONTEXT)
        crop_y1 = y1
        crop = work.crop((0, crop_y0, w, crop_y1))
        fill_local = (0, y0 - crop_y0, w, y1 - crop_y0)
        crop = _edge_fill_strip(crop, fill_local, axis="y", inward=False)
        strip_mask = _strip_mask(
            crop.size,
            global_box=(0, crop_y0, w, crop_y1),
            fill_box=(0, y0, w, y1),
        )
        if strip_mask.getbbox() is None:
            break
        prog.begin_strip("하단", done + 1, strips)
        seam_band, band_y0 = _capture_vertical_seam_band(work, y0, OUTPAINT_SEAM_BLEND)
        result = _inpaint_outpaint_strip(crop, strip_mask, prog=prog)
        work.paste(result, (0, crop_y0))
        _vertical_seam_blend_band(work, seam_band, band_y0, y0, OUTPAINT_SEAM_BLEND)
        work_mask.paste(Image.new("L", (w, strip_h), 0), (0, y0))
        edge = y1
        done += 1
        _release_gpu_memory()


def build_feathered_outpaint_mask(
    canvas_size: tuple[int, int],
    preserve_box: tuple[int, int, int, int],
    inward_feather: int = OUTPAINT_INWARD_FEATHER,
    outward_feather: int = OUTPAINT_OUTWARD_FEATHER
) -> tuple[np.ndarray, np.ndarray]:
    """
    페더링 마스크 생성 — OpenCV 거리변환 기반 고속 연산
    
    입력:
      canvas_size: (W, H)
      preserve_box: (px0, py0, px1, py1) — 원본 영역
      inward_feather: 원본 안쪽 침범 페더 (px)
      outward_feather: 확장 영역 페더 (px)
    
    출력:
      (soft_mask, hard_mask)
      - soft_mask: float32 (0.0~1.0) — AI 입력용 그라데이션
      - hard_mask: float32 (0.0/1.0) — 최종 합성용 이진
    """
    import cv2

    w, h = canvas_size
    px0, py0, px1, py1 = preserve_box

    # hard_mask: 255 = 생성(외부), 0 = 보존(내부)
    hard_mask = np.ones((h, w), dtype=np.uint8) * 255
    hard_mask[py0:py1, px0:px1] = 0

    # outside mask (non-zero for distanceTransform source)
    outside_mask = (hard_mask != 0).astype(np.uint8) * 255
    inside_mask = (hard_mask == 0).astype(np.uint8) * 255

    # 거리 변환: 외부->경계, 내부->경계 (두 번의 distanceTransform)
    dist_out = cv2.distanceTransform(outside_mask, cv2.DIST_L2, 5)
    dist_in = cv2.distanceTransform(inside_mask, cv2.DIST_L2, 5)

    # soft_mask 계산: 0.0 (원본 보존) ~ 1.0 (생성)
    soft_mask = np.zeros((h, w), dtype=np.float32)

    if inward_feather > 0:
        # 내부: 가까운 경계일수록 생성 가중치가 높아짐 (0->1)
        inside_norm = np.clip(dist_in / float(max(1, inward_feather)), 0.0, 1.0)
        inside_grad = inside_norm ** OUTPAINT_FEATHER_GAMMA_IN
        soft_mask = np.where(inside_mask == 255, inside_grad, soft_mask)

    if outward_feather > 0:
        # 외부: 경계에서 멀어질수록 생성 가중치가 작아짐 (1->0)
        outside_norm = np.clip(1.0 - (dist_out / float(max(1, outward_feather))), 0.0, 1.0)
        outside_grad = outside_norm ** OUTPAINT_FEATHER_GAMMA_OUT
        soft_mask = np.where(outside_mask == 255, outside_grad, soft_mask)

    # ensure interior preserve remains near 0
    soft_mask[py0:py1, px0:px1] = np.minimum(soft_mask[py0:py1, px0:px1], 0.0)

    # 부드러운 전환을 위한 블러 적용
    soft_mask_u8 = (np.clip(soft_mask, 0.0, 1.0) * 255.0).astype(np.uint8)
    soft_blurred = cv2.GaussianBlur(soft_mask_u8, (15, 15), 0)
    soft_mask = soft_blurred.astype(np.float32) / 255.0

    # hard_mask 반환 형식: float32 (1.0 = 원본 보존, 0.0 = 생성) — 기존 계약과 맞춤
    hard_mask_float = (hard_mask == 0).astype(np.float32)
    return soft_mask, hard_mask_float


def final_composite(
    original: Image.Image,
    generated: Image.Image,
    soft_mask: np.ndarray,
    hard_mask: np.ndarray
) -> Image.Image:
    """
    최종 합성 — soft_mask와 hard_mask를 사용하여 원본과 생성 이미지 합성
    경계면 턱 제거를 위해 마스크 외곽선에 추가 블러 적용
    
    입력:
      original: 원본 이미지
      generated: AI 생성 이미지
      soft_mask: float32 (0.0~1.0) 그라데이션
      hard_mask: float32 (0.0/1.0) 이진
    
    출력:
      합성된 이미지
    """
    import cv2

    orig_arr = np.array(original.convert("RGB"), dtype=np.float32)
    gen_arr = np.array(generated.convert("RGB"), dtype=np.float32)

    # 경계면 턱 제거: soft_mask에 가우시안 블러를 두 번 적용하여 매우 부드럽게 만듦
    soft_mask_uint8 = (np.clip(soft_mask, 0.0, 1.0) * 255.0).astype(np.uint8)
    soft_mask_blurred = cv2.GaussianBlur(soft_mask_uint8, (11, 11), 0)
    soft_mask_blurred = cv2.GaussianBlur(soft_mask_blurred, (21, 21), 0)
    soft_mask_smooth = soft_mask_blurred.astype(np.float32) / 255.0

    # soft_mask로 부드러운 블렌딩
    soft_mask_3ch = np.stack([soft_mask_smooth] * 3, axis=-1)
    blended = orig_arr * (1.0 - soft_mask_3ch) + gen_arr * soft_mask_3ch

    # hard_mask: 계약은 1.0 = 원본 보존, 0.0 = 생성
    hard_mask_3ch = np.stack([hard_mask] * 3, axis=-1)
    result = blended * (1.0 - hard_mask_3ch) + orig_arr * hard_mask_3ch

    return Image.fromarray(np.clip(result, 0, 255).astype(np.uint8))


def color_correct_strip(
    generated: np.ndarray,
    reference_edge: np.ndarray,
    style: str = "photo_realistic",
    blend_alpha: float = 0.65
) -> np.ndarray:
    """
    생성된 스트립의 색상을 원본 가장자리에 맞춤 (Color Anchoring)
    
    입력:
      generated: float32 (H, W, 3) 생성된 스트립
      reference_edge: float32 (H, W, 3) 참조 가장자리 픽셀
      style: 이미지 스타일
      blend_alpha: 보정 강도 (0.0~1.0)
    
    출력:
      color_corrected: float32 (H, W, 3)
    """
    # ensure float32
    import cv2
    gen = generated.astype(np.float32)
    ref = reference_edge.astype(np.float32)

    # 참조 색상 통계
    ref_mean = ref.mean(axis=(0, 1))
    ref_std = ref.std(axis=(0, 1))

    # 생성 스트립 색상 통계
    gen_mean = gen.mean(axis=(0, 1))
    gen_std = gen.std(axis=(0, 1))

    # 선형 색상 정규화: corrected = (gen - gen_mean) * (ref_std / (gen_std + eps)) + ref_mean
    eps = 1e-6
    scale = ref_std / (gen_std + eps)
    # clamp scale to avoid extreme color warping
    scale = np.clip(scale, 0.5, 1.5)
    corrected = (gen - gen_mean.reshape(1, 1, 3)) * scale.reshape(1, 1, 3) + ref_mean.reshape(1, 1, 3)
    corrected = np.clip(corrected, 0.0, 255.0)

    # 채도 앵커링: 참조와 생성의 평균 채도 비율을 이용해 채도 과다를 제한
    try:
        ref_hsv = cv2.cvtColor(ref.astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.float32)
        gen_hsv = cv2.cvtColor(gen.astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.float32)
        corr_hsv = cv2.cvtColor(corrected.astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.float32)
        ref_sat = (ref_hsv[:, :, 1].mean() + 1.0) / 255.0
        gen_sat = (gen_hsv[:, :, 1].mean() + 1.0) / 255.0
        sat_scale = ref_sat / max(1e-3, gen_sat)
        sat_scale = float(np.clip(sat_scale, 0.7, 1.3))
        # apply limited saturation scaling
        corr_hsv[:, :, 1] = np.clip(corr_hsv[:, :, 1] * sat_scale, 0, 255)
        corrected = cv2.cvtColor(corr_hsv.astype(np.uint8), cv2.COLOR_HSV2RGB).astype(np.float32)
    except Exception:
        # cv2 HSV conversion best-effort; ignore if it fails
        pass

    # 스타일별 블렌딩 강도 조정 (Color Anchoring)
    if style in ("vintage_sepia", "grayscale"):
        blend_alpha = max(blend_alpha, 0.95)
    elif style == "vivid_color":
        blend_alpha = max(blend_alpha, 0.5)
    else:
        blend_alpha = max(blend_alpha, 0.75)

    # 최종 블렌딩: 보정된 색상에 더 높은 가중치
    result = corrected * blend_alpha + gen * (1.0 - blend_alpha)
    return np.clip(result, 0.0, 255.0)


def progressive_outpaint(canvas: Image.Image, mask: Image.Image) -> Image.Image:
    """원본 경계에서 좁은 스트립씩 바깥으로 확장 (맥락 유지·이음새 블렌드)."""
    work = canvas.convert("RGB")
    work_mask = _binarize_mask(mask)
    px0, py0, px1, py1 = _preserve_rect(work_mask)
    w, h = work.size
    total_strips = sum(
        (
            _count_outpaint_strips(px0),
            _count_outpaint_strips(w - px1),
            _count_outpaint_strips(py0),
            _count_outpaint_strips(h - py1),
        )
    )
    prog = _OutpaintProgress(total_strips=max(1, total_strips))
    emit_progress(16, f"아웃페인트 시작 · 스트립 {prog.total_strips}개")
    _extend_left_strips(work, work_mask, px0, prog)
    _extend_right_strips(work, work_mask, px1, prog)
    _extend_top_strips(work, work_mask, py0, prog)
    _extend_bottom_strips(work, work_mask, py1, prog)
    return work


def lanczos_upscale(img: Image.Image, target_w: int, target_h: int) -> Image.Image:
    if img.size == (target_w, target_h):
        return img
    return img.resize((target_w, target_h), Image.Resampling.LANCZOS)


def outpaint(
    image_path: str,
    output_path: str,
    target_width: int,
    target_height: int,
    prompt: str,
) -> None:
    global _PIPE
    emit_progress(10, "아웃페인팅 준비")
    vram_mb = detect_vram_mb()
    emit_progress(12, f"GPU {vram_mb}MB · VRAM Tier {_VRAM_TIER or '미로드'}")
    if _PIPE is not None and vram_mb >= 12000 and _VRAM_TIER < 3:
        _PIPE = None
        _release_gpu_memory()
    src = load_rgb_image(image_path)
    tw, th = _round_sdxl_side(max(1, int(target_width))), _round_sdxl_side(max(1, int(target_height)))

    scale = min(1.0, MAX_SDXL_SIDE / max(tw, th))
    work_w = _round_sdxl_side(max(8, int(tw * scale)))
    work_h = _round_sdxl_side(max(8, int(th * scale)))
    if scale < 1.0:
        src = src.resize(
            (max(1, int(src.width * scale)), max(1, int(src.height * scale))),
            Image.Resampling.LANCZOS,
        )

    if src.width > work_w or src.height > work_h:
        fit = min(work_w / src.width, work_h / src.height)
        src = src.resize(
            (max(1, int(src.width * fit)), max(1, int(src.height * fit))),
            Image.Resampling.LANCZOS,
        )

    canvas = Image.new("RGB", (work_w, work_h), (0, 0, 0))
    ox = (work_w - src.width) // 2
    oy = (work_h - src.height) // 2
    canvas.paste(src, (ox, oy))

    mask = Image.new("L", (work_w, work_h), 255)
    preserve = Image.new("L", (src.width, src.height), 0)
    mask.paste(preserve, (ox, oy))

    px0, py0, px1, py1 = ox, oy, ox + src.width, oy + src.height
    canvas = _prefill_outpaint_edges(canvas, px0, py0, px1, py1)
    result = progressive_outpaint(canvas, mask)

    if (tw, th) != (work_w, work_h):
        emit_progress(94, "목표 해상도로 Lanczos 업스케일")
        result = lanczos_upscale(result, tw, th)

    result.save(output_path, format="PNG")
    emit_progress(100, "아웃페인팅 완료")


def _mask_bbox(mask: Image.Image) -> tuple[int, int, int, int]:
    arr = np.array(mask.convert("L"))
    ys, xs = np.where(arr > 127)
    if len(xs) == 0:
        h, w = arr.shape
        return 0, 0, w, h
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def remove_object(image_path: str, mask_path: str, output_path: str) -> None:
    emit_progress(10, "개체 제거 - 컨텍스트 크롭")
    full = load_rgb_image(image_path)
    mask_full = load_mask_image(mask_path)
    if mask_full.size != full.size:
        mask_full = mask_full.resize(full.size, Image.Resampling.NEAREST)

    x0, y0, x1, y1 = _mask_bbox(mask_full)
    pad = max(32, int(0.15 * max(x1 - x0, y1 - y0)))
    cx0 = max(0, x0 - pad)
    cy0 = max(0, y0 - pad)
    cx1 = min(full.width, x1 + pad)
    cy1 = min(full.height, y1 + pad)

    crop_w, crop_h = cx1 - cx0, cy1 - cy0
    side = min(MAX_SDXL_SIDE, max(crop_w, crop_h))
    crop = full.crop((cx0, cy0, cx1, cy1))
    crop_mask = mask_full.crop((cx0, cy0, cx1, cy1))

    if crop_w != side or crop_h != side:
        scale = side / max(crop_w, crop_h)
        new_w = max(1, int(crop_w * scale))
        new_h = max(1, int(crop_h * scale))
        crop = crop.resize((new_w, new_h), Image.Resampling.LANCZOS)
        crop_mask = crop_mask.resize((new_w, new_h), Image.Resampling.NEAREST)
        pad_img = Image.new("RGB", (side, side), (0, 0, 0))
        pad_m = Image.new("L", (side, side), 0)
        ox = (side - new_w) // 2
        oy = (side - new_h) // 2
        pad_img.paste(crop, (ox, oy))
        pad_m.paste(crop_mask, (ox, oy))
        crop, crop_mask = pad_img, pad_m

    result_crop = run_inpaint(
        crop,
        crop_mask,
        prompt=REMOVE_DEFAULT_PROMPT,
        default_prompt=REMOVE_DEFAULT_PROMPT,
    )
    emit_progress(92, "인페인트 완료")

    if result_crop.size != (cx1 - cx0, cy1 - cy0):
        result_crop = result_crop.resize((cx1 - cx0, cy1 - cy0), Image.Resampling.LANCZOS)

    out = full.copy()
    out.paste(result_crop, (cx0, cy0))
    out.save(output_path, format="PNG")
    emit_progress(100, "개체 제거 완료")


def _compose_blend_mask(alpha: Image.Image) -> Image.Image:
    import cv2

    a = np.array(alpha.convert("L"))
    _, binary = cv2.threshold(a, 16, 255, cv2.THRESH_BINARY)
    kernel = np.ones((5, 5), np.uint8)
    dilated = cv2.dilate(binary, kernel, iterations=4)
    blurred = cv2.GaussianBlur(dilated, (15, 15), 0)
    return Image.fromarray(blurred, mode="L")


def compose(
    bg_image_path: str,
    fg_image_path: str,
    output_path: str,
    x: int,
    y: int,
    fg_width: int,
    fg_height: int,
    prompt: str,
) -> None:
    emit_progress(8, "전경 누끼 처리")
    from rembg import remove

    fg_raw = Image.open(fg_image_path).convert("RGBA")
    fg_cut = remove(fg_raw, session=rembg_session())
    if isinstance(fg_cut, bytes):
        from io import BytesIO

        fg_cut = Image.open(BytesIO(fg_cut)).convert("RGBA")
    else:
        fg_cut = fg_cut.convert("RGBA")

    fw, fh = max(1, int(fg_width)), max(1, int(fg_height))
    fg_cut = fg_cut.resize((fw, fh), Image.Resampling.LANCZOS)

    bg = load_rgb_image(bg_image_path)
    init = bg.copy()
    init.paste(fg_cut, (int(x), int(y)), fg_cut)

    emit_progress(25, "블렌딩 마스크 생성")
    alpha_full = Image.new("L", bg.size, 0)
    alpha_full.paste(fg_cut.split()[3], (int(x), int(y)))
    blend_mask = _compose_blend_mask(alpha_full)

    result = run_inpaint(
        init,
        blend_mask,
        prompt=prompt,
        default_prompt=COMPOSE_DEFAULT_PROMPT,
    )
    result.save(output_path, format="PNG")
    emit_progress(100, "합성 완료")


def handle_command(req: dict[str, Any]) -> bool:
    cmd = str(req.get("cmd", "")).strip().lower()
    if cmd == "ping":
        emit({"type": "pong"})
        return True
    if cmd == "shutdown":
        emit({"type": "shutdown_ack"})
        return False
    if cmd == "load":
        force = bool(req.get("force_tier1"))
        if force:
            os.environ["ITMATZIP_MAGIC_CANVAS_FORCE_TIER1"] = "1"
        load_pipeline(force_tier1=force)
        emit({"type": "loaded", "vram_tier": _VRAM_TIER, "force_tier1": force})
        return True

    load_pipeline()

    if cmd == "outpaint":
        outpaint(
            req["image_path"],
            req["output_path"],
            int(req["target_width"]),
            int(req["target_height"]),
            str(req.get("prompt", "")),
        )
        emit({"type": "result", "output_path": req["output_path"]})
        return True
    if cmd == "remove":
        remove_object(req["image_path"], req["mask_path"], req["output_path"])
        emit({"type": "result", "output_path": req["output_path"]})
        return True
    if cmd == "compose":
        compose(
            req["bg_image_path"],
            req["fg_image_path"],
            req["output_path"],
            int(req["x"]),
            int(req["y"]),
            int(req["fg_width"]),
            int(req["fg_height"]),
            str(req.get("prompt", "")),
        )
        emit({"type": "result", "output_path": req["output_path"]})
        return True

    emit_error(f"unknown cmd: {cmd}")
    return True


def format_inference_error(exc: BaseException) -> str:
    msg = str(exc).strip()
    if "TextEncodeInput" in msg:
        return (
            "프롬프트를 SDXL이 처리하지 못했습니다. "
            "아웃페인트 프롬프트를 비우거나 짧은 설명(예: 자연스러운 하늘 배경)으로 다시 시도하세요."
        )
    return msg or exc.__class__.__name__


def main() -> int:
    emit({"type": "ready", "message": "worker started"})
    try:
        while True:
            line = sys.stdin.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError as exc:
                emit_error(f"invalid json: {exc}")
                continue
            try:
                cont = handle_command(req)
                if not cont:
                    break
            except Exception as exc:
                emit_error(format_inference_error(exc))
                traceback.print_exc(file=sys.stderr)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
