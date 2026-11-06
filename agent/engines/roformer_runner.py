"""Mel-Band RoFormer 보컬 분리 runner (PyTorch).

    python roformer_runner.py --model <ckpt> --input <audio> --vocals <wav> --instrumental <wav>
                              [--device auto|cpu|cuda] [--overlap 2] [--ffmpeg <exe>]

stdout 프로토콜은 mdx_runner 와 동일 (PROGRESS / PROVIDER / DONE).
청크·페이드 처리는 ZFTurbo Music-Source-Separation-Training demix_track 과 동일합니다.
"""
from __future__ import annotations

import argparse
import os
import sys
import traceback
from pathlib import Path

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from vocal_runner_boot import bootstrap_import_paths

    bootstrap_import_paths()

from engines.mdx_runner import decode_audio, emit, write_wav16  # noqa: E402


def _windowing_array(size: int, fade: int):
    import torch

    window = torch.ones(size)
    window[:fade] = torch.linspace(0, 1, fade)
    window[-fade:] = torch.linspace(1, 0, fade)
    return window


def demix(model, mix, *, chunk_size: int, num_overlap: int, device, use_fp16: bool, on_progress=None):
    """mix: torch (2, N) cpu float32 → vocals (2, N) cpu float32."""
    import torch
    import torch.nn.functional as F

    c = chunk_size
    fade = c // 10
    step = c // num_overlap
    border = c - step
    length_init = mix.shape[-1]
    if length_init > 2 * border and border > 0:
        mix = F.pad(mix[None], (border, border), mode="reflect")[0]
    total = mix.shape[-1]
    base_window = _windowing_array(c, fade).to(device)
    result = torch.zeros((2, total), dtype=torch.float32, device=device)
    counter = torch.zeros((2, total), dtype=torch.float32, device=device)
    starts = list(range(0, total, step))

    with torch.inference_mode():
        for k, i in enumerate(starts):
            part = mix[:, i:i + c].to(device)
            length = part.shape[-1]
            if length < c:
                mode = "reflect" if length > c // 2 + 1 else "constant"
                part = F.pad(part[None], (0, c - length), mode=mode)[0]
            if use_fp16:
                with torch.autocast("cuda", dtype=torch.float16):
                    out = model(part[None]).float()[0]
            else:
                out = model(part[None])[0]
            window = base_window.clone()
            if i == 0:
                window[:fade] = 1
            elif i + c >= total:
                window[-fade:] = 1
            result[..., i:i + length] += out[..., :length] * window[..., :length]
            counter[..., i:i + length] += window[..., :length]
            if on_progress:
                on_progress(k + 1, len(starts))

    est = torch.nan_to_num(result / counter, nan=0.0, posinf=0.0, neginf=0.0)
    if length_init > 2 * border and border > 0:
        est = est[..., border:-border]
    return est.cpu()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--input", required=True)
    ap.add_argument("--vocals", required=True)
    ap.add_argument("--instrumental", required=True)
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda", "gpu"])
    ap.add_argument("--overlap", type=int, default=2)
    ap.add_argument("--no-fp16", action="store_true")
    ap.add_argument("--ffmpeg", default=os.environ.get("ITMATZIP_FFMPEG", "ffmpeg"))
    args = ap.parse_args(argv)

    try:
        emit("PROGRESS", 2, "오디오 디코딩 중")
        import numpy as np
        import torch

        from engines.mel_band_roformer import KIM_CHUNK_SIZE, load_kim_vocal_model

        mix_np = decode_audio(Path(args.input), args.ffmpeg)
        want_cuda = args.device in {"auto", "cuda", "gpu"} and torch.cuda.is_available()
        if args.device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA를 사용할 수 없습니다. PyTorch CUDA 빌드와 NVIDIA 드라이버를 확인하세요.")
        device = torch.device("cuda" if want_cuda else "cpu")
        if device.type == "cpu":
            torch.set_num_threads(max(1, (os.cpu_count() or 2) - 1))

        emit("PROGRESS", 5, "Roformer 모델 로드 중")
        model = load_kim_vocal_model(args.model, device)
        emit("PROVIDER", "cuda" if want_cuda else "cpu")

        def on_chunk(done: int, total: int) -> None:
            emit("PROGRESS", round(10 + 82 * done / total, 1), f"Roformer 분리 중 ({done}/{total})")

        vocals = demix(
            model,
            torch.from_numpy(mix_np),
            chunk_size=KIM_CHUNK_SIZE,
            num_overlap=max(1, args.overlap),
            device=device,
            use_fp16=want_cuda and not args.no_fp16,
            on_progress=on_chunk,
        ).numpy().astype(np.float32)
        emit("PROGRESS", 94, "결과 저장 중")
        write_wav16(Path(args.vocals), vocals)
        write_wav16(Path(args.instrumental), mix_np - vocals)
        emit("PROGRESS", 100, "완료")
        emit("DONE")
        return 0
    except Exception:
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
