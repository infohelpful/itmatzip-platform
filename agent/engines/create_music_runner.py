"""ACE-Step 음악 생성 (engine-runtime — 직접 실행하지 마세요)."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def _bootstrap_import_paths() -> None:
    """MSI embeddable Python 은 PYTHONPATH 무시 — agent·runtime·ACE-Step 경로 삽입."""
    agent = os.environ.get("ITMATZIP_AGENT_DIR", "").strip() or os.environ.get(
        "ITMATZIP_AGENT_PACKAGE_ROOT", ""
    ).strip()
    if not agent:
        install = os.environ.get("ITMATZIP_AGENT_INSTALL_ROOT", "").strip()
        if install:
            agent = str(Path(install) / "agent")
    if agent and agent not in sys.path:
        sys.path.insert(0, agent)
    try:
        from common.runtime_site_packages import TOOL_CREATE_MUSIC, activate_runtime_site_packages

        os.environ.setdefault("ITMATZIP_RUNTIME_TOOL", TOOL_CREATE_MUSIC)
        activate_runtime_site_packages(TOOL_CREATE_MUSIC)
    except Exception as exc:
        print(f"warning: runtime site-packages bootstrap failed: {exc}", file=sys.stderr)

    root = os.environ.get("ITMATZIP_ACESTEP_ROOT", "").strip() or os.environ.get(
        "ACESTEP_PROJECT_ROOT", ""
    ).strip()
    if root and root not in sys.path:
        sys.path.insert(0, root)


_bootstrap_import_paths()


def _write_progress(path: str, progress: float, message: str) -> None:
    if not path:
        return
    Path(path).write_text(
        json.dumps({"progress": progress, "message": message}, ensure_ascii=False),
        encoding="utf-8",
    )


def _audio_summary(path: str, bars: int = 48) -> tuple[float | None, list[float]]:
    """곡 목록 파형용 구간별 최대 음량(0~1)과 실제 길이(초). 실패해도 생성은 성공으로 둠."""
    try:
        import numpy as np
        import soundfile as sf

        data, sr = sf.read(path, dtype="float32", always_2d=True)
        level = np.abs(data).max(axis=1)
        if level.size == 0 or not sr:
            return None, []
        chunks = np.array_split(level, bars)
        peaks = [float(c.max()) if c.size else 0.0 for c in chunks]
        top = max(peaks) or 1.0
        return round(level.size / float(sr), 2), [round(p / top, 3) for p in peaks]
    except Exception as exc:  # noqa: BLE001
        print(f"warning: waveform summary failed: {exc}", file=sys.stderr)
        return None, []


_SCORE_ERRORS: list[str] = []


def _ensure_numba() -> None:
    """가사 점수의 DTW 계산이 numba를 쓰는데, 설치된 NumPy(2.5)와 numba(0.66)가 맞지 않아 불러오기가 실패한다.
    그때는 numba 없이 일반 파이썬으로 계산하도록 jit 데코레이터만 흉내 낸 모듈로 대신한다 (속도만 느려짐)."""
    try:
        import numba  # noqa: F401

        return
    except Exception:  # noqa: BLE001
        pass
    import types

    for name in [m for m in sys.modules if m == "numba" or m.startswith("numba.")]:
        sys.modules.pop(name, None)
    stub = types.ModuleType("numba")

    def _jit(*args, **kwargs):
        if len(args) == 1 and callable(args[0]) and not kwargs:
            return args[0]
        return lambda fn: fn

    stub.jit = _jit  # type: ignore[attr-defined]
    stub.njit = _jit  # type: ignore[attr-defined]
    sys.modules["numba"] = stub


def _score_candidates(dit, result, vocal_language: str, steps: int) -> list[float | None] | None:
    """곡마다 ACE-Step 「DiT 가사 정렬 점수」(가사가 소리 구간에 제자리로 놓인 정도, 높을수록 좋음).

    ACE-Step이 가사 정확도를 높이려고 공식으로 권하는 방법: 여러 곡을 한꺼번에 만들어 이 점수가 높은 곡을 고른다.
    중간 데이터가 없거나(메모리 절약 모드) 계산이 실패하면 None.
    """
    extra = getattr(result, "extra_outputs", None) or {}
    keys = ("pred_latents", "encoder_hidden_states", "encoder_attention_mask", "context_latents", "lyric_token_idss")
    missing = [k for k in keys if extra.get(k) is None]
    if missing:
        _SCORE_ERRORS.append("missing tensors: " + ",".join(missing) + f" (have {sorted(extra)})")
        return None
    _ensure_numba()
    scores: list[float | None] = []
    for i in range(len(result.audios or [])):
        try:
            r = dit.get_lyric_score(
                pred_latent=extra["pred_latents"][i : i + 1],
                encoder_hidden_states=extra["encoder_hidden_states"][i : i + 1],
                encoder_attention_mask=extra["encoder_attention_mask"][i : i + 1],
                context_latents=extra["context_latents"][i : i + 1],
                lyric_token_ids=extra["lyric_token_idss"][i : i + 1],
                vocal_language=vocal_language or "en",
                inference_steps=int(steps),
                seed=42,
            )
            if not r.get("success"):
                _SCORE_ERRORS.append(f"sample {i}: {r.get('error')}")
            scores.append(float(r.get("dit_score", 0.0)) if r.get("success") else None)
        except Exception as exc:  # noqa: BLE001
            _SCORE_ERRORS.append(f"sample {i}: {type(exc).__name__}: {exc}")
            scores.append(None)
    return scores


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

        p_req = req.get("params") or {}
        # ACE-Step은 thinking 또는 CoT 옵션이 켜졌을 때만 LM을 씁니다 (inference.generate_music의 use_lm).
        lm_needed = bool(req.get("thinking", False)) or any(
            bool(p_req.get(k, False))
            for k in ("use_cot_caption", "use_cot_language", "use_cot_metas")
        )
        if not lm_needed:
            # LM을 설치하지 않으므로, ACE-Step이 LM이 없다고 기본 모델을 다시 받지 않게 함
            from engines.create_music_model_policy import exclude_bundled_lm

            exclude_bundled_lm()

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
        # 안 쓸 LM을 불러오면 생성마다 약 35초가 그냥 버려지므로 그때는 불러오지 않습니다.
        if lm_ckpt and lm_needed:
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
            instrumental=bool(p.get("instrumental", False)),
            use_cot_caption=bool(p.get("use_cot_caption", False)),
            use_cot_language=bool(p.get("use_cot_language", False)),
            use_cot_metas=bool(p.get("use_cot_metas", False)),
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

        _write_progress(progress_path, 88, "가사가 가장 잘 들어간 곡 고르는 중…")
        scores = None
        if p.get("lyrics") and not p.get("instrumental") and len(result.audios or []) > 1:
            scores = _score_candidates(dit, result, p.get("vocal_language", "ko"), int(p.get("inference_steps", 8)))

        _write_progress(progress_path, 90, "결과 정리 중…")
        output_files = _collect_output_files(result, save_dir)
        best_index = 0
        if scores and any(s is not None for s in scores) and len(scores) == len(output_files):
            best_index = max(range(len(scores)), key=lambda i: scores[i] if scores[i] is not None else float("-inf"))
            if req.get("select_best") and not os.environ.get("ITMATZIP_KEEP_ALL_CANDIDATES"):
                for i, f in enumerate(output_files):
                    if i != best_index:
                        try:
                            Path(f).unlink()
                        except OSError:
                            pass
                output_files = [output_files[best_index]]
        if not output_files:
            raise RuntimeError(
                "오디오 파일을 저장하지 못했습니다. "
                "MP3·Opus·AAC는 ffmpeg가 PATH에 있어야 합니다. "
                "출력 형식을 WAV 또는 FLAC로 선택한 뒤 다시 생성하세요."
            )

        audio_duration, peaks = _audio_summary(output_files[0])
        out = {
            "ok": True,
            "output_files": output_files,
            "audio_duration": audio_duration,
            "peaks": peaks,
            "candidate_scores": scores,
            "score_error": _SCORE_ERRORS[0] if _SCORE_ERRORS else None,
            "best_index": best_index,
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
