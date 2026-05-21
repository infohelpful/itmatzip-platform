from __future__ import annotations

import os
import sys
import traceback
import wave
from pathlib import Path


def _bootstrap_ffmpeg_dll_path() -> None:
    """torchcodec이 FFmpeg DLL을 찾도록 Demucs import 전에 PATH를 맞춥니다."""
    try:
        from common.bin_manager import ensure_ffmpeg, prepend_ffmpeg_bin_to_env

        ensure_ffmpeg()
        prepend_ffmpeg_bin_to_env(os.environ)
    except Exception as exc:
        print(f"warning: ffmpeg PATH bootstrap failed: {exc}", file=sys.stderr)


_bootstrap_ffmpeg_dll_path()

import numpy as np
import demucs.audio as demucs_audio
from demucs.separate import main as demucs_main


def _save_wav(path: str, src, sample_rate: int, **kwargs) -> None:
    """Fallback WAV save for Demucs when torchaudio/torchcodec save is unavailable."""
    if hasattr(src, "detach"):
        src = src.detach()
    if hasattr(src, "cpu"):
        src = src.cpu()

    array = src.numpy()
    if array.ndim == 1:
        array = array[np.newaxis, :]

    if array.dtype.kind == "f":
        array = (array * 32767.0).clip(-32768.0, 32767.0).astype("int16")
    else:
        array = array.astype("int16")

    frames = array.T
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(frames.shape[1] if frames.ndim > 1 else 1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(frames.tobytes())


_original_save = demucs_audio.ta.save


def _patched_save(path: str, src, sample_rate: int, **kwargs) -> None:
    try:
        return _original_save(path, src, sample_rate, **kwargs)
    except Exception:
        if Path(path).suffix.lower() == ".wav":
            return _save_wav(path, src, sample_rate, **kwargs)
        raise


demucs_audio.ta.save = _patched_save


def main() -> int:
    try:
        return demucs_main(sys.argv[1:]) or 0
    except Exception:
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
