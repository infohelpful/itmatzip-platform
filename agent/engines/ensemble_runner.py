"""여러 모델의 보컬 결과를 결합하는 앙상블 runner (numpy 만 사용).

    python ensemble_runner.py --mix <audio> --vocals-out <wav> --instrumental-out <wav>
                              --source <wav>:<weight> [--source ...] [--reference 0]

알고리즘 (DeVocal EnsembleSeparator 와 동일):
  1. 각 모델 보컬의 STFT 크기(magnitude)를 가중 평균
  2. 위상(phase)은 기준 모델(가중치가 가장 큰 모델) 것을 사용 — 위상 혼합 시 생기는 뭉개짐 방지
  3. 반주 = 원곡 - 앙상블 보컬 (시간 영역 차감, 보컬+반주 = 원곡)

긴 곡도 메모리가 일정하도록 STFT 프레임을 블록 단위로 처리합니다.
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

import numpy as np  # noqa: E402

from engines.mdx_runner import decode_audio, emit, hann_periodic, write_wav16  # noqa: E402

N_FFT = 2048
HOP = 512
BLOCK_FRAMES = 1024


def blend(
    sources: list[np.ndarray],
    weights: list[float],
    reference: int,
    on_progress=None,
) -> np.ndarray:
    """sources: (2, N) 보컬 배열 목록 → 앙상블 보컬 (2, N)."""
    n = min(s.shape[-1] for s in sources)
    total_w = sum(weights)
    weights = [w / total_w for w in weights]
    pad = N_FFT // 2
    padded = [np.pad(s[:, :n], ((0, 0), (pad, pad)), mode="reflect") for s in sources]
    window = hann_periodic(N_FFT)
    wsq = window * window
    frames = 1 + (padded[0].shape[-1] - N_FFT) // HOP
    out_len = N_FFT + HOP * (frames - 1)
    out = np.zeros((2, out_len), dtype=np.float32)
    norm = np.zeros(out_len, dtype=np.float32)
    blocks = list(range(0, frames, BLOCK_FRAMES))

    for b, f0 in enumerate(blocks):
        f1 = min(frames, f0 + BLOCK_FRAMES)
        idx = np.arange(N_FFT)[None, :] + HOP * np.arange(f0, f1)[:, None]
        mag = None
        phase = None
        for k, (src, w) in enumerate(zip(padded, weights)):
            spec = np.fft.rfft(src[:, idx] * window, axis=-1)  # (2, frames, bins)
            m = np.abs(spec).astype(np.float32)
            mag = w * m if mag is None else mag + w * m
            if k == reference:
                phase = np.angle(spec).astype(np.float32)
        seg = np.fft.irfft(mag * np.exp(1j * phase), n=N_FFT, axis=-1).astype(np.float32) * window
        for j, f in enumerate(range(f0, f1)):
            s = f * HOP
            out[:, s:s + N_FFT] += seg[:, j]
            norm[s:s + N_FFT] += wsq
        if on_progress:
            on_progress(b + 1, len(blocks))

    out = out[:, pad:pad + n]
    return out / np.maximum(norm[pad:pad + n], 1e-8)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mix", required=True)
    ap.add_argument("--vocals-out", required=True)
    ap.add_argument("--instrumental-out", required=True)
    ap.add_argument("--source", action="append", required=True, help="<wav>:<weight>")
    ap.add_argument("--reference", type=int, default=-1, help="위상 기준 source 인덱스 (기본: 최대 가중치)")
    ap.add_argument("--ffmpeg", default=os.environ.get("ITMATZIP_FFMPEG", "ffmpeg"))
    args = ap.parse_args(argv)

    try:
        paths: list[Path] = []
        weights: list[float] = []
        for item in args.source:
            path, _, weight = item.rpartition(":")
            if not path:
                raise ValueError(f"--source 형식 오류: {item}")
            paths.append(Path(path))
            weights.append(float(weight))
        if len(paths) < 2:
            raise ValueError("앙상블에는 2개 이상의 결과가 필요합니다.")
        reference = args.reference if 0 <= args.reference < len(paths) else int(np.argmax(weights))

        emit("PROGRESS", 5, "원곡·모델 결과 읽는 중")
        mix = decode_audio(Path(args.mix), args.ffmpeg)
        sources = [decode_audio(p, args.ffmpeg) for p in paths]

        def on_block(done: int, total: int) -> None:
            emit("PROGRESS", round(10 + 80 * done / total, 1), f"앙상블 결합 중 ({done}/{total})")

        vocals = blend(sources, weights, reference, on_progress=on_block)
        n = min(mix.shape[-1], vocals.shape[-1])
        mix, vocals = mix[:, :n], vocals[:, :n]
        emit("PROGRESS", 94, "결과 저장 중")
        write_wav16(Path(args.vocals_out), vocals)
        write_wav16(Path(args.instrumental_out), mix - vocals)
        emit("PROGRESS", 100, "완료")
        emit("DONE")
        return 0
    except Exception:
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
