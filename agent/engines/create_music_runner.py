"""ACE-Step 음악 생성 (3.12 venv 전용 — 직접 실행하지 마세요)."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def _write_progress(path: str, progress: float, message: str) -> None:
    if not path:
        return
    Path(path).write_text(
        json.dumps({"progress": progress, "message": message}, ensure_ascii=False),
        encoding="utf-8",
    )


def _collect_output_files(result, save_dir: Path) -> list[str]:
    """저장된 파일 경로 수집. MP3 등 실패 시 텐서에서 WAV로 재저장."""
    output_files: list[str] = []
    save_dir.mkdir(parents=True, exist_ok=True)

    for idx, audio in enumerate(result.audios or []):
        path = audio.get("path")
        if path and Path(path).is_file():
            output_files.append(str(Path(path).resolve()))
            continue

        tensor = audio.get("tensor")
        if tensor is None:
            continue

        key = audio.get("key") or f"output_{idx}"
        sr = int(audio.get("sample_rate") or 48000)
        fallback = save_dir / f"{key}.wav"
        try:
            import soundfile as sf
            import torch

            t = tensor.detach().cpu().float() if hasattr(tensor, "detach") else tensor
            arr = t.numpy()
            if arr.ndim == 2 and arr.shape[0] <= 8 and arr.shape[0] < arr.shape[1]:
                arr = arr.T
            sf.write(str(fallback), arr, sr, subtype="FLOAT")
            output_files.append(str(fallback.resolve()))
        except Exception:
            continue

    return output_files


def main() -> int:
    req = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    progress_path = req.get("progress_path", "")
    result_path = req.get("result_path", "")

    os.environ["ACESTEP_PROJECT_ROOT"] = req["project_root"]
    os.environ["ACESTEP_CHECKPOINTS_DIR"] = req["checkpoints_dir"]

    try:
        from acestep.handler import AceStepHandler
        from acestep.inference import GenerationConfig, GenerationParams, generate_music
        from acestep.llm_inference import LLMHandler

        _write_progress(progress_path, 8, "DiT 모델 로딩 중…")
        dit = AceStepHandler()
        quant = req.get("quantization")
        if quant in ("int8", "INT8"):
            quant = "int8_weight_only"
        compile_model = req.get("compile_model")
        if compile_model is None:
            compile_model = bool(quant)
        status, ok = dit.initialize_service(
            project_root=req["project_root"],
            config_path=req["config_path"],
            device=req.get("device", "auto"),
            offload_to_cpu=bool(req.get("offload_cpu")),
            offload_dit_to_cpu=bool(req.get("offload_dit")),
            quantization=quant,
            compile_model=bool(compile_model),
        )
        if not ok:
            raise RuntimeError(status)

        llm = LLMHandler()
        lm_ckpt = req.get("lm_checkpoint")
        if lm_ckpt:
            _write_progress(progress_path, 22, f"LM 로딩 중… ({lm_ckpt})")
            lm_status, lm_ok = llm.initialize(
                checkpoint_dir=req["checkpoints_dir"],
                lm_model_path=lm_ckpt,
                backend=req.get("lm_backend", "pt"),
                device=req.get("device", "auto"),
                offload_to_cpu=bool(req.get("offload_cpu")),
            )
            if not lm_ok:
                raise RuntimeError(lm_status)

        _write_progress(progress_path, 35, "음악 생성 중…")
        p = req["params"]
        params = GenerationParams(
            task_type=p.get("task_type", "text2music"),
            caption=p.get("caption", ""),
            lyrics=p.get("lyrics", ""),
            vocal_language=p.get("vocal_language", "ko"),
            duration=p.get("duration") if p.get("duration", -1) > 0 else None,
            bpm=p.get("bpm"),
            keyscale=p.get("keyscale") or "",
            timesignature=p.get("timesignature") or "",
            inference_steps=int(p.get("inference_steps", 8)),
            guidance_scale=float(p.get("guidance_scale", 5.0)),
            shift=float(p.get("shift", 3.0)),
            seed=int(p.get("seed", -1)),
            infer_method=p.get("infer_method", "ode"),
            thinking=bool(req.get("thinking", False)),
            src_audio=p.get("src_audio_path"),
            reference_audio=p.get("reference_audio_path"),
            repainting_start=p.get("repainting_start"),
            repainting_end=p.get("repainting_end") if p.get("repainting_end", -1) > 0 else None,
            audio_cover_strength=float(p.get("cover_strength", 1.0)),
        )

        seed = params.seed
        use_random = seed is None or seed < 0
        config = GenerationConfig(
            batch_size=int(p.get("batch_size", 1)),
            use_random_seed=use_random,
            seeds=None if use_random else [seed],
            audio_format=p.get("audio_format", "wav"),
        )

        save_dir = Path(req["output_dir"])
        save_dir.mkdir(parents=True, exist_ok=True)

        result = generate_music(dit, llm, params, config, save_dir=str(save_dir))

        if not result.success:
            raise RuntimeError(result.error or result.status_message or "생성 실패")

        _write_progress(progress_path, 90, "결과 정리 중…")
        output_files = _collect_output_files(result, save_dir)
        if not output_files:
            raise RuntimeError(
                "오디오 파일을 저장하지 못했습니다. "
                "MP3·Opus·AAC는 ffmpeg가 PATH에 있어야 합니다. "
                "출력 형식을 WAV 또는 FLAC로 선택한 뒤 다시 생성하세요."
            )

        out = {
            "ok": True,
            "output_files": output_files,
            "seed": result.audios[0].get("params", {}).get("seed") if result.audios else seed,
            "status_message": result.status_message,
        }
        _write_progress(progress_path, 100, "생성 완료")
    except Exception as e:
        out = {"ok": False, "error": str(e)}
        _write_progress(progress_path, 0, f"실패: {e}")

    if result_path:
        Path(result_path).write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
