"""LaMa (TorchScript) erase-only inference subprocess entry.

Sanster/IOPaint 의 `iopaint/model/lama.py` 추론 로직을 그대로 미러링한다
(패딩·정규화·블렌딩 방식 포함). 전체 iopaint 패키지는 설치하지 않고
big-lama.pt TorchScript 가중치만 직접 로드해서 사용한다.

MSI engine python + engine-runtime/magic-eraser (library-hub wheels)
"""

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
            TOOL_MAGIC_ERASER,
            activate_runtime_site_packages,
        )

        os.environ.setdefault("ITMATZIP_RUNTIME_TOOL", TOOL_MAGIC_ERASER)
        activate_runtime_site_packages(TOOL_MAGIC_ERASER)
    except Exception as exc:
        print(f"warning: runtime site-packages bootstrap failed: {exc}", file=sys.stderr)


_bootstrap_import_paths()

PAD_MOD = 8


def _report(pct: float, message: str) -> None:
    print(f"ITZ_PROGRESS {pct:.1f} {message}", flush=True)


def _ceil_modulo(x: int, mod: int) -> int:
    if x % mod == 0:
        return x
    return (x // mod + 1) * mod


def _pad_img_to_modulo(img, mod: int):
    """IOPaint `pad_img_to_modulo` 미러 — symmetric padding, HxW(xC)."""
    import numpy as np

    if img.ndim == 2:
        img = img[:, :, np.newaxis]
    height, width = img.shape[:2]
    out_height = _ceil_modulo(height, mod)
    out_width = _ceil_modulo(width, mod)
    return np.pad(
        img,
        ((0, out_height - height), (0, out_width - width), (0, 0)),
        mode="symmetric",
    )


def _norm_img(np_img):
    """IOPaint `norm_img` 미러 — HWC uint8 → CHW float32 [0,1]."""
    import numpy as np

    if np_img.ndim == 2:
        np_img = np_img[:, :, np.newaxis]
    np_img = np.transpose(np_img, (2, 0, 1))
    np_img = np_img.astype("float32") / 255.0
    return np_img


def _load_model(model_path: Path, device: str):
    import torch

    torch.set_grad_enabled(False)
    model = torch.jit.load(str(model_path), map_location="cpu")
    model = model.to(device)
    model.eval()
    return model


def _forward(pad_image, pad_mask, model, device: str):
    """IOPaint LaMa.forward 미러. image: RGB HWC, mask: L HW(1). return: BGR HWC uint8."""
    import cv2
    import numpy as np
    import torch

    image = _norm_img(pad_image)
    mask = _norm_img(pad_mask)
    mask = (mask > 0).astype("float32")

    image_t = torch.from_numpy(image).unsqueeze(0).to(device)
    mask_t = torch.from_numpy(mask).unsqueeze(0).to(device)

    with torch.no_grad():
        inpainted = model(image_t, mask_t)

    cur_res = inpainted[0].permute(1, 2, 0).detach().cpu().numpy()
    cur_res = np.clip(cur_res * 255, 0, 255).astype("uint8")
    cur_res_bgr = cv2.cvtColor(cur_res, cv2.COLOR_RGB2BGR)
    return cur_res_bgr


def erase_image(image_rgb, mask_gray, model, device: str):
    """IOPaint InpaintModel._pad_forward 미러.

    image_rgb: HxWx3 uint8 RGB (정규화 전 원본)
    mask_gray: HxW uint8, white(255)=erase 영역
    return: HxWx3 uint8 RGB (지우기 결과가 합성된 최종 이미지)
    """
    import numpy as np

    origin_height, origin_width = image_rgb.shape[:2]
    pad_image = _pad_img_to_modulo(image_rgb, PAD_MOD)
    pad_mask = _pad_img_to_modulo(mask_gray, PAD_MOD)

    result_bgr = _forward(pad_image, pad_mask, model, device)
    result_bgr = result_bgr[0:origin_height, 0:origin_width, :]

    mask_weight = mask_gray[:, :, np.newaxis].astype("float32") / 255.0
    image_bgr = image_rgb[:, :, ::-1].astype("float32")
    blended = result_bgr.astype("float32") * mask_weight + image_bgr * (1.0 - mask_weight)
    blended = np.clip(blended, 0, 255).astype("uint8")
    return blended[:, :, ::-1]


def main() -> int:
    parser = argparse.ArgumentParser(description="Run LaMa erase-only inpainting")
    parser.add_argument("--input", required=True)
    parser.add_argument("--mask", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    mask_path = Path(args.mask).resolve()
    output_path = Path(args.output).resolve()
    model_path = Path(args.model_path).resolve()

    if not input_path.is_file():
        print(f"error: input file not found: {input_path}", file=sys.stderr)
        return 1
    if not mask_path.is_file():
        print(f"error: mask file not found: {mask_path}", file=sys.stderr)
        return 1
    if not model_path.is_file():
        print(f"error: model file not found: {model_path}", file=sys.stderr)
        return 1
    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        import numpy as np
        from PIL import Image, ImageOps

        _report(5.0, "이미지 불러오는 중")
        with Image.open(input_path) as raw:
            source = ImageOps.exif_transpose(raw).convert("RGB")
        image_rgb = np.asarray(source, dtype=np.uint8)

        _report(12.0, "마스크 불러오는 중")
        with Image.open(mask_path) as raw_mask:
            mask_img = raw_mask.convert("L")
            if mask_img.size != source.size:
                mask_img = mask_img.resize(source.size, Image.LANCZOS)
        mask_gray = np.asarray(mask_img, dtype=np.uint8)

        _report(20.0, f"LaMa 모델 로드 중 ({args.device.upper()})")
        model = _load_model(model_path, args.device)

        _report(45.0, "지우기 추론 중")
        result_rgb = erase_image(image_rgb, mask_gray, model, args.device)

        _report(90.0, "결과 저장 중")
        Image.fromarray(result_rgb, mode="RGB").save(output_path, format="PNG", optimize=True)

        _report(98.0, "결과 저장 완료")
        print(
            "ITZ_RESULT "
            + json.dumps(
                {
                    "output_path": str(output_path),
                    "width": int(source.width),
                    "height": int(source.height),
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
