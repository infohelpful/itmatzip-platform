"""MDX-Net (UVR) ONNX 보컬 분리 runner — PyTorch 없이 numpy + onnxruntime 만 사용.

vocal_remover.py 가 별도 Python 프로세스로 실행합니다 (Demucs runner 와 동일 패턴).

    python mdx_runner.py --model <onnx> --input <audio> --vocals <wav> --instrumental <wav>
                         [--device auto|cpu|gpu] [--overlap 0.25] [--ffmpeg <exe>]

stdout 프로토콜 (한 줄씩):
    PROGRESS <0~100> <message>
    PROVIDER <onnxruntime execution provider>
    DONE
stderr 에는 오류 traceback 이 남습니다.

STFT 파라미터·청크·compensate 는 UVR model_data (Voc_FT: n_fft 7680, dim_f 3072,
dim_t 256, compensate 1.021) 및 python-audio-separator MDXSeparator 와 동일하게 맞췄습니다.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import traceback
import wave
from pathlib import Path


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from vocal_runner_boot import bootstrap_import_paths

    bootstrap_import_paths()

import numpy as np  # noqa: E402

SAMPLE_RATE = 44100


def emit(kind: str, *parts: object) -> None:
    """프로토콜 한 줄을 항상 UTF-8 로 출력 (Windows 파이프 기본 cp949 → 에이전트 쪽 한글 깨짐 방지)."""
    line = " ".join(str(p) for p in (kind, *parts)) + "\n"
    stream = getattr(sys.stdout, "buffer", None)
    if stream is not None:
        sys.stdout.flush()
        stream.write(line.encode("utf-8", errors="replace"))
        stream.flush()
    else:
        print(line, end="", flush=True)


# ---------------------------------------------------------------------------
# Audio I/O (FFmpeg pipe — soundfile/librosa 불필요)
# ---------------------------------------------------------------------------

def _no_window() -> int:
    return 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW


def decode_audio(path: Path, ffmpeg: str) -> np.ndarray:
    """임의 오디오 → float32 (2, N) 44.1 kHz 스테레오."""
    proc = subprocess.run(
        [
            ffmpeg, "-v", "error", "-nostdin", "-i", str(path),
            "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "2", "-ar", str(SAMPLE_RATE), "-",
        ],
        capture_output=True,
        creationflags=_no_window(),
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "FFmpeg 디코딩 실패: " + proc.stderr.decode("utf-8", errors="replace")[-1500:]
        )
    data = np.frombuffer(proc.stdout, dtype=np.float32)
    if data.size < 2:
        raise RuntimeError("오디오 데이터가 비어 있습니다.")
    return data[: data.size - data.size % 2].reshape(-1, 2).T.copy()


def write_wav16(path: Path, audio: np.ndarray) -> None:
    """(2, N) float → 16-bit PCM wav (기존 Demucs 결과물과 동일 포맷)."""
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).round().astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(pcm.shape[0])
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(np.ascontiguousarray(pcm.T).tobytes())


# ---------------------------------------------------------------------------
# STFT (torch.stft center=True / reflect pad / periodic hann 과 동일)
# ---------------------------------------------------------------------------

def hann_periodic(n: int) -> np.ndarray:
    return (0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(n) / n)).astype(np.float32)


def stft(x: np.ndarray, n_fft: int, hop: int, window: np.ndarray) -> np.ndarray:
    """x: (C, T) → complex64 (C, n_fft//2+1, frames)."""
    pad = n_fft // 2
    xp = np.pad(x, ((0, 0), (pad, pad)), mode="reflect")
    frames = 1 + (xp.shape[-1] - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(frames)[:, None]
    seg = xp[:, idx] * window  # (C, frames, n_fft)
    return np.fft.rfft(seg, axis=-1).transpose(0, 2, 1).astype(np.complex64)


def istft(spec: np.ndarray, n_fft: int, hop: int, window: np.ndarray, length: int) -> np.ndarray:
    """spec: (C, bins, frames) → (C, length)."""
    c, _, frames = spec.shape
    seg = np.fft.irfft(spec.transpose(0, 2, 1), n=n_fft, axis=-1).astype(np.float32) * window
    total = n_fft + hop * (frames - 1)
    out = np.zeros((c, total), dtype=np.float32)
    norm = np.zeros(total, dtype=np.float32)
    wsq = window * window
    for f in range(frames):
        s = f * hop
        out[:, s:s + n_fft] += seg[:, f]
        norm[s:s + n_fft] += wsq
    pad = n_fft // 2
    out = out[:, pad:pad + length]
    norm = norm[pad:pad + length]
    return out / np.maximum(norm, 1e-8)


# ---------------------------------------------------------------------------
# MDX-Net
# ---------------------------------------------------------------------------

class MdxNet:
    def __init__(
        self,
        model_path: Path,
        *,
        n_fft: int = 7680,
        hop: int = 1024,
        dim_f: int = 3072,
        dim_t: int = 256,
        compensate: float = 1.021,
        device: str = "auto",
    ) -> None:
        import onnxruntime as ort

        self.n_fft = n_fft
        self.hop = hop
        self.dim_f = dim_f
        self.dim_t = dim_t
        self.compensate = compensate
        self.n_bins = n_fft // 2 + 1
        self.trim = n_fft // 2
        self.chunk_size = hop * (dim_t - 1)
        self.gen_size = self.chunk_size - 2 * self.trim
        self.window = hann_periodic(n_fft)

        available = ort.get_available_providers()
        providers: list = []
        if device != "cpu":
            if "CUDAExecutionProvider" in available:
                providers.append("CUDAExecutionProvider")
            if "DmlExecutionProvider" in available:
                providers.append("DmlExecutionProvider")
        providers.append("CPUExecutionProvider")

        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        if "DmlExecutionProvider" in providers:
            # DirectML EP 는 메모리 패턴·병렬 실행을 지원하지 않음
            opts.enable_mem_pattern = False
            opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        try:
            self.session = ort.InferenceSession(str(model_path), opts, providers=providers)
        except Exception:
            if providers == ["CPUExecutionProvider"]:
                raise
            # GPU 초기화 실패(드라이버 등) → CPU 로 재시도
            self.session = ort.InferenceSession(
                str(model_path), ort.SessionOptions(), providers=["CPUExecutionProvider"]
            )
        self.provider = self.session.get_providers()[0]
        self.input_name = self.session.get_inputs()[0].name

    def _run_chunk(self, mix_part: np.ndarray) -> np.ndarray:
        """mix_part: (2, chunk_size) → 보컬 파형 (2, chunk_size)."""
        spec = stft(mix_part, self.n_fft, self.hop, self.window)  # (2, n_bins, dim_t)
        x = np.stack([spec.real, spec.imag], axis=1).reshape(4, self.n_bins, -1)
        x = x[:, : self.dim_f, : self.dim_t].astype(np.float32)
        x[:, :3, :] = 0.0  # UVR: DC 근처 3개 bin 제거
        pred = self.session.run(None, {self.input_name: x[None]})[0][0]  # (4, dim_f, dim_t)
        full = np.zeros((4, self.n_bins, pred.shape[-1]), dtype=np.float32)
        full[:, : self.dim_f] = pred
        full = full.reshape(2, 2, self.n_bins, -1)
        cplx = (full[:, 0] + 1j * full[:, 1]).astype(np.complex64)
        return istft(cplx, self.n_fft, self.hop, self.window, self.chunk_size)

    def separate(self, mix: np.ndarray, overlap: float = 0.25, on_progress=None) -> np.ndarray:
        """mix: (2, N) → 보컬 (2, N). 반주는 mix - vocals."""
        n = mix.shape[-1]
        pad = self.gen_size + self.trim - (n % self.gen_size)
        mixture = np.concatenate(
            [np.zeros((2, self.trim), np.float32), mix, np.zeros((2, pad), np.float32)], axis=1
        )
        total = mixture.shape[-1]
        step = max(1, int((1.0 - overlap) * self.chunk_size))
        result = np.zeros((2, total), dtype=np.float32)
        divider = np.zeros((2, total), dtype=np.float32)
        starts = list(range(0, total, step))
        for k, start in enumerate(starts):
            end = min(start + self.chunk_size, total)
            actual = end - start
            window = np.hanning(actual).astype(np.float32)[None, :]
            part = mixture[:, start:end]
            if actual < self.chunk_size:
                part = np.pad(part, ((0, 0), (0, self.chunk_size - actual)))
            wav = self._run_chunk(part)
            result[:, start:end] += wav[:, :actual] * window
            divider[:, start:end] += window
            if on_progress:
                on_progress(k + 1, len(starts))
        out = result / np.maximum(divider, 1e-8)
        return out[:, self.trim:self.trim + n] * self.compensate


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--input", required=True)
    ap.add_argument("--vocals", required=True)
    ap.add_argument("--instrumental", required=True)
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "gpu", "cuda"])
    ap.add_argument("--overlap", type=float, default=0.25)
    ap.add_argument("--ffmpeg", default=os.environ.get("ITMATZIP_FFMPEG", "ffmpeg"))
    ap.add_argument("--save-npy", default="", help="앙상블용: 보컬 float32 (2,N) 를 .npy 로도 저장")
    args = ap.parse_args(argv)

    try:
        emit("PROGRESS", 2, "오디오 디코딩 중")
        mix = decode_audio(Path(args.input), args.ffmpeg)
        emit("PROGRESS", 6, "MDX-Net 모델 로드 중")
        model = MdxNet(Path(args.model), device="cpu" if args.device == "cpu" else "auto")
        emit("PROVIDER", model.provider)

        def on_chunk(done: int, total: int) -> None:
            emit("PROGRESS", round(8 + 84 * done / total, 1), f"MDX-Net 분리 중 ({done}/{total})")

        vocals = model.separate(mix, overlap=args.overlap, on_progress=on_chunk)
        emit("PROGRESS", 94, "결과 저장 중")
        if args.save_npy:
            np.save(args.save_npy, vocals.astype(np.float32))
        write_wav16(Path(args.vocals), vocals)
        write_wav16(Path(args.instrumental), mix - vocals)
        emit("PROGRESS", 100, "완료")
        emit("DONE")
        return 0
    except Exception:
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
