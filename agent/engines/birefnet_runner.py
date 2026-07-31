"""BiRefNet inference subprocess entry (MSI engine python + engine-runtime/background-remover)."""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path


def _bootstrap_import_paths() -> None:
    """MSI embeddable Python 은 PYTHONPATH 를 무시 — agent·runtime 경로를 직접 삽입."""
    agent = os.environ.get("ITMATZIP_AGENT_DIR", "").strip()
    if not agent:
        install = os.environ.get("ITMATZIP_AGENT_INSTALL_ROOT", "").strip()
        if install:
            agent = str(Path(install) / "agent")
    if agent and agent not in sys.path:
        sys.path.insert(0, agent)
    try:
        from common.runtime_site_packages import (
            TOOL_BACKGROUND_REMOVER,
            activate_runtime_site_packages,
        )

        os.environ.setdefault("ITMATZIP_RUNTIME_TOOL", TOOL_BACKGROUND_REMOVER)
        activate_runtime_site_packages(TOOL_BACKGROUND_REMOVER)
    except Exception as exc:
        print(f"warning: runtime site-packages bootstrap failed: {exc}", file=sys.stderr)


_bootstrap_import_paths()


def _report(pct: float, message: str) -> None:
    print(f"ITZ_PROGRESS {pct:.1f} {message}", flush=True)


def _load_model(model_dir: Path, device: str, use_half: bool):
    import torch
    from transformers import AutoModelForImageSegmentation

    torch.set_grad_enabled(False)
    if device == "cuda":
        torch.set_float32_matmul_precision("high")

    model = AutoModelForImageSegmentation.from_pretrained(
        str(model_dir),
        trust_remote_code=True,
        local_files_only=True,
    )
    model.eval()
    model.to(device)
    if use_half and device == "cuda":
        model.half()
    return model


def _predict_mask(model, image, input_size: int, device: str, use_half: bool):
    import numpy as np
    import torch
    from PIL import Image

    resized = image.resize((input_size, input_size), Image.BICUBIC)
    array = np.asarray(resized, dtype=np.float32) / 255.0
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    array = (array - mean) / std
    tensor = torch.from_numpy(array).permute(2, 0, 1).unsqueeze(0)
    tensor = tensor.to(device)
    if use_half and device == "cuda":
        tensor = tensor.half()

    prediction = model(tensor)[-1].sigmoid().float().cpu()
    mask = prediction[0].squeeze().numpy()
    mask = np.clip(mask, 0.0, 1.0)
    return Image.fromarray((mask * 255.0).astype(np.uint8), mode="L")


def _refine_mask(mask, *, feather: int, threshold: float):
    from PIL import Image, ImageFilter

    if threshold > 0.0:
        cutoff = int(round(max(0.0, min(1.0, threshold)) * 255))
        mask = mask.point(lambda v: 0 if v < cutoff else v)
    if feather > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(radius=feather))
    return mask.convert("L") if mask.mode != "L" else mask


def _resolve_max_size(width: int, height: int, max_size: int) -> tuple[int, int] | None:
    if max_size <= 0:
        return None
    longest = max(width, height)
    if longest <= max_size:
        return None
    scale = max_size / float(longest)
    return max(1, int(round(width * scale))), max(1, int(round(height * scale)))


def main() -> int:
    parser = argparse.ArgumentParser(description="Run BiRefNet background removal")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--input-size", type=int, default=1024)
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    parser.add_argument("--feather", type=int, default=0, help="알파 경계 블러 반경(px)")
    parser.add_argument("--threshold", type=float, default=0.0, help="이 값 미만 알파는 0 처리")
    parser.add_argument("--max-size", type=int, default=0, help="긴 변 상한(px). 0=원본")
    parser.add_argument("--half", action="store_true", help="CUDA fp16 추론")
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    output_dir = Path(args.output_dir).resolve()
    model_dir = Path(args.model_dir).resolve()
    if not input_path.is_file():
        print(f"error: input file not found: {input_path}", file=sys.stderr)
        return 1
    if not (model_dir / "config.json").is_file():
        print(f"error: model directory is incomplete: {model_dir}", file=sys.stderr)
        return 1
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        from PIL import Image, ImageOps

        _report(8.0, "이미지 불러오는 중")
        with Image.open(input_path) as raw:
            source = ImageOps.exif_transpose(raw).convert("RGB")

        resized_to = _resolve_max_size(source.width, source.height, args.max_size)
        if resized_to is not None:
            source = source.resize(resized_to, Image.LANCZOS)

        _report(20.0, "BiRefNet 모델 로드 중")
        model = _load_model(model_dir, args.device, args.half)

        _report(45.0, "배경 분리 추론 중")
        mask = _predict_mask(model, source, args.input_size, args.device, args.half)
        mask = mask.resize(source.size, Image.BILINEAR)
        mask = _refine_mask(mask, feather=args.feather, threshold=args.threshold)

        _report(85.0, "투명 PNG 합성 중")
        cutout = source.convert("RGBA")
        cutout.putalpha(mask)

        cutout_path = output_dir / "cutout.png"
        mask_path = output_dir / "mask.png"
        cutout.save(cutout_path, format="PNG", optimize=True)
        mask.save(mask_path, format="PNG", optimize=True)

        _report(98.0, "결과 저장 완료")
        print(
            "ITZ_RESULT "
            + json.dumps(
                {
                    "cutout_path": str(cutout_path),
                    "mask_path": str(mask_path),
                    "width": source.width,
                    "height": source.height,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 0
    except Exception:
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
