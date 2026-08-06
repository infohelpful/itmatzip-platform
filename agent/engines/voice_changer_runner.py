"""Seed-VC zero-shot voice conversion subprocess entry.

MSI engine python + engine-runtime/voice-changer + Seed-VC source (path inject).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
import warnings
from pathlib import Path


def _bootstrap_import_paths() -> None:
    agent = os.environ.get("ITMATZIP_AGENT_DIR", "").strip()
    if not agent:
        install = os.environ.get("ITMATZIP_AGENT_INSTALL_ROOT", "").strip()
        if install:
            agent = str(Path(install) / "agent")
    if agent and agent not in sys.path:
        sys.path.insert(0, agent)
    try:
        from common.runtime_site_packages import (
            TOOL_VOICE_CHANGER,
            activate_runtime_site_packages,
        )

        os.environ.setdefault("ITMATZIP_RUNTIME_TOOL", TOOL_VOICE_CHANGER)
        activate_runtime_site_packages(TOOL_VOICE_CHANGER)
    except Exception as exc:
        print(f"warning: runtime site-packages bootstrap failed: {exc}", file=sys.stderr)


_bootstrap_import_paths()


def _report(pct: float, message: str) -> None:
    print(f"ITZ_PROGRESS {pct:.1f} {message}", flush=True)


def _str2bool(value: str) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def _resolve_seedvc_root() -> Path:
    env_root = os.environ.get("ITMATZIP_SEEDVC_ROOT", "").strip()
    if env_root:
        root = Path(env_root)
        if (root / "inference.py").is_file():
            return root.resolve()
    raise RuntimeError("ITMATZIP_SEEDVC_ROOT 가 설정되지 않았거나 inference.py 가 없습니다.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed-VC voice conversion runner")
    parser.add_argument("--source", required=True)
    parser.add_argument("--reference", required=True)
    parser.add_argument("--output", required=True, help="출력 WAV 경로")
    parser.add_argument("--device", default="cuda", choices=("cpu", "cuda"))
    parser.add_argument("--diffusion-steps", type=int, default=25)
    parser.add_argument("--length-adjust", type=float, default=1.0)
    parser.add_argument("--inference-cfg-rate", type=float, default=0.7)
    parser.add_argument("--f0-condition", type=_str2bool, default=False)
    parser.add_argument("--auto-f0-adjust", type=_str2bool, default=False)
    parser.add_argument("--semi-tone-shift", type=int, default=0)
    parser.add_argument("--fp16", type=_str2bool, default=True)
    args = parser.parse_args()

    source = Path(args.source)
    reference = Path(args.reference)
    output = Path(args.output)
    if not source.is_file():
        print(f"source not found: {source}", file=sys.stderr)
        return 2
    if not reference.is_file():
        print(f"reference not found: {reference}", file=sys.stderr)
        return 2
    output.parent.mkdir(parents=True, exist_ok=True)

    if args.device == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = ""

    seedvc_root = _resolve_seedvc_root()
    os.chdir(seedvc_root)
    if str(seedvc_root) not in sys.path:
        sys.path.insert(0, str(seedvc_root))

    # Seed-VC inference.py 기본값 덮어쓰기 — 우리 HF 캐시 사용
    hub_cache = os.environ.get("HF_HUB_CACHE", "").strip()
    if not hub_cache:
        hub_cache = str(Path(os.environ.get("APPDATA", "")) / "ItMatZip" / "voice-changer" / "checkpoints" / "hf_cache")
        os.environ["HF_HUB_CACHE"] = hub_cache
    Path(hub_cache).mkdir(parents=True, exist_ok=True)

    _report(5.0, "Seed-VC 모듈 로드 중…")
    warnings.simplefilter("ignore")

    try:
        import numpy as np
        import torch
        import torchaudio
        import librosa
        import yaml
        from modules.commons import build_model, load_checkpoint, recursive_munch
        from hf_utils import load_custom_model_from_hf
    except Exception as exc:
        print(f"import failed: {exc}", file=sys.stderr)
        traceback.print_exc()
        return 3

    # device
    if args.device == "cuda" and torch.cuda.is_available():
        device = torch.device("cuda")
    else:
        device = torch.device("cpu")
        args.fp16 = False

    _report(12.0, f"장치: {device}")

    # --- load_models (speech VC, non-f0 by default) mirrored from inference.py ---
    fp16 = bool(args.fp16)
    f0_condition = bool(args.f0_condition)

    ckpt_env = os.environ.get("ITMATZIP_SEEDVC_CHECKPOINT", "").strip()
    cfg_env = os.environ.get("ITMATZIP_SEEDVC_CONFIG", "").strip()

    try:
        if not f0_condition:
            if ckpt_env and cfg_env and Path(ckpt_env).is_file() and Path(cfg_env).is_file():
                dit_checkpoint_path = ckpt_env
                dit_config_path = cfg_env
            else:
                dit_checkpoint_path, dit_config_path = load_custom_model_from_hf(
                    "Plachta/Seed-VC",
                    "DiT_seed_v2_uvit_whisper_small_wavenet_bigvgan_pruned.pth",
                    "config_dit_mel_seed_uvit_whisper_small_wavenet.yml",
                )
            f0_fn = None
        else:
            dit_checkpoint_path, dit_config_path = load_custom_model_from_hf(
                "Plachta/Seed-VC",
                "DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema_v2.pth",
                "config_dit_mel_seed_uvit_whisper_base_f0_44k.yml",
            )
            from modules.rmvpe import RMVPE

            model_path = load_custom_model_from_hf("lj1995/VoiceConversionWebUI", "rmvpe.pt", None)
            f0_extractor = RMVPE(model_path, is_half=False, device=device)
            f0_fn = f0_extractor.infer_from_audio

        _report(25.0, "체크포인트 로드…")
        config = yaml.safe_load(open(dit_config_path, "r", encoding="utf-8"))
        model_params = recursive_munch(config["model_params"])
        model_params.dit_type = "DiT"
        model = build_model(model_params, stage="DiT")
        sr = int(config["preprocess_params"]["sr"])

        model, _, _, _ = load_checkpoint(
            model,
            None,
            dit_checkpoint_path,
            load_only_params=True,
            ignore_modules=[],
            is_distributed=False,
        )
        for key in model:
            model[key].eval()
            model[key].to(device)
        model.cfm.estimator.setup_caches(max_batch_size=1, max_seq_length=8192)

        from modules.campplus.DTDNN import CAMPPlus

        campplus_env = os.environ.get("ITMATZIP_SEEDVC_CAMPPLUS", "").strip()
        if campplus_env and Path(campplus_env).is_file():
            campplus_ckpt_path = campplus_env
        else:
            campplus_ckpt_path = load_custom_model_from_hf(
                "funasr/campplus", "campplus_cn_common.bin", config_filename=None
            )
        campplus_model = CAMPPlus(feat_dim=80, embedding_size=192)
        campplus_model.load_state_dict(torch.load(campplus_ckpt_path, map_location="cpu"))
        campplus_model.eval()
        campplus_model.to(device)

        vocoder_type = model_params.vocoder.type
        if vocoder_type == "bigvgan":
            from modules.bigvgan import bigvgan

            bigvgan_name = model_params.vocoder.name
            bigvgan_model = bigvgan.BigVGAN.from_pretrained(bigvgan_name, use_cuda_kernel=False)
            bigvgan_model.remove_weight_norm()
            vocoder_fn = bigvgan_model.eval().to(device)
        else:
            raise RuntimeError(f"지원하지 않는 vocoder: {vocoder_type}")

        from transformers import AutoFeatureExtractor, WhisperModel

        whisper_name = model_params.speech_tokenizer.name
        whisper_model = WhisperModel.from_pretrained(whisper_name, torch_dtype=torch.float16).to(device)
        del whisper_model.decoder
        whisper_feature_extractor = AutoFeatureExtractor.from_pretrained(whisper_name)

        def semantic_fn(waves_16k):
            ori_inputs = whisper_feature_extractor(
                [waves_16k.squeeze(0).detach().cpu().numpy()],
                sampling_rate=16000,
                return_tensors="pt",
                return_attention_mask=True,
            )
            ori_input_features = whisper_model._mask_input_features(
                ori_inputs.input_features, attention_mask=ori_inputs.attention_mask
            ).to(device)
            with torch.no_grad():
                ori_outputs = whisper_model.encoder(
                    ori_input_features.to(whisper_model.encoder.dtype),
                    head_mask=None,
                    output_attentions=False,
                    output_hidden_states=False,
                    return_dict=True,
                )
            S_ori = ori_outputs.last_hidden_state.to(torch.float32)
            S_ori = S_ori[:, : waves_16k.size(-1) // 320 + 1]
            return S_ori

        from modules.audio import mel_spectrogram

        mel_fn_args = {
            "n_fft": config["preprocess_params"]["spect_params"]["n_fft"],
            "win_size": config["preprocess_params"]["spect_params"]["win_length"],
            "hop_size": config["preprocess_params"]["spect_params"]["hop_length"],
            "num_mels": config["preprocess_params"]["spect_params"]["n_mels"],
            "sampling_rate": sr,
            "fmin": config["preprocess_params"]["spect_params"].get("fmin", 0),
            "fmax": None
            if config["preprocess_params"]["spect_params"].get("fmax", "None") == "None"
            else 8000,
            "center": False,
        }
        mel_fn = lambda x: mel_spectrogram(x, **mel_fn_args)

        _report(40.0, "오디오 로드…")
        source_audio = librosa.load(str(source), sr=sr)[0]
        ref_audio = librosa.load(str(reference), sr=sr)[0]

        # Seed-VC inference.py 와 동일: 로드 후 유효 샘플레이트·hop 고정
        sr = 22050 if not f0_condition else 44100
        hop_length = 256 if not f0_condition else 512
        max_context_window = sr // hop_length * 30
        overlap_frame_len = 16
        overlap_wave_len = overlap_frame_len * hop_length

        source_audio = torch.tensor(source_audio).unsqueeze(0).float().to(device)
        ref_audio = torch.tensor(ref_audio[: sr * 25]).unsqueeze(0).float().to(device)

        _report(50.0, "음성 변환 추론…")
        converted_waves_16k = torchaudio.functional.resample(source_audio, sr, 16000)
        if converted_waves_16k.size(-1) <= 16000 * 30:
            S_alt = semantic_fn(converted_waves_16k)
        else:
            overlapping_time = 5
            S_alt_list = []
            buffer = None
            traversed_time = 0
            while traversed_time < converted_waves_16k.size(-1):
                if buffer is None:
                    chunk = converted_waves_16k[:, traversed_time : traversed_time + 16000 * 30]
                else:
                    chunk = torch.cat(
                        [
                            buffer,
                            converted_waves_16k[
                                :,
                                traversed_time : traversed_time + 16000 * (30 - overlapping_time),
                            ],
                        ],
                        dim=-1,
                    )
                S_alt = semantic_fn(chunk)
                if traversed_time == 0:
                    S_alt_list.append(S_alt)
                else:
                    S_alt_list.append(S_alt[:, 50 * overlapping_time :])
                buffer = chunk[:, -16000 * overlapping_time :]
                traversed_time += (
                    30 * 16000 if traversed_time == 0 else chunk.size(-1) - 16000 * overlapping_time
                )
            S_alt = torch.cat(S_alt_list, dim=1)

        ori_waves_16k = torchaudio.functional.resample(ref_audio, sr, 16000)
        S_ori = semantic_fn(ori_waves_16k)

        mel = mel_fn(source_audio.to(device).float())
        mel2 = mel_fn(ref_audio.to(device).float())

        length_adjust = float(args.length_adjust)
        target_lengths = torch.LongTensor([int(mel.size(2) * length_adjust)]).to(mel.device)
        target2_lengths = torch.LongTensor([mel2.size(2)]).to(mel2.device)

        feat2 = torchaudio.compliance.kaldi.fbank(
            ori_waves_16k, num_mel_bins=80, dither=0, sample_frequency=16000
        )
        feat2 = feat2 - feat2.mean(dim=0, keepdim=True)
        style2 = campplus_model(feat2.unsqueeze(0))

        if f0_condition and f0_fn is not None:
            F0_ori = torch.from_numpy(f0_fn(ori_waves_16k[0], thred=0.03)).to(device)[None]
            F0_alt = torch.from_numpy(f0_fn(converted_waves_16k[0], thred=0.03)).to(device)[None]
            log_f0_alt = torch.log(F0_alt + 1e-5)
            voiced_F0_ori = F0_ori[F0_ori > 1]
            voiced_F0_alt = F0_alt[F0_alt > 1]
            median_log_f0_ori = torch.median(torch.log(voiced_F0_ori + 1e-5))
            median_log_f0_alt = torch.median(torch.log(voiced_F0_alt + 1e-5))
            shifted_log_f0_alt = log_f0_alt.clone()
            if args.auto_f0_adjust:
                shifted_log_f0_alt[F0_alt > 1] = (
                    log_f0_alt[F0_alt > 1] - median_log_f0_alt + median_log_f0_ori
                )
            shifted_f0_alt = torch.exp(shifted_log_f0_alt)
            if args.semi_tone_shift != 0:
                factor = 2 ** (args.semi_tone_shift / 12)
                shifted_f0_alt[F0_alt > 1] = shifted_f0_alt[F0_alt > 1] * factor
        else:
            F0_ori = None
            shifted_f0_alt = None

        cond, _, _, _, _ = model.length_regulator(
            S_alt, ylens=target_lengths, n_quantizers=3, f0=shifted_f0_alt
        )
        prompt_condition, _, _, _, _ = model.length_regulator(
            S_ori, ylens=target2_lengths, n_quantizers=3, f0=F0_ori
        )

        def crossfade(chunk1, chunk2, overlap):
            fade_out = np.cos(np.linspace(0, np.pi / 2, overlap)) ** 2
            fade_in = np.cos(np.linspace(np.pi / 2, 0, overlap)) ** 2
            if len(chunk2) < overlap:
                chunk2[:overlap] = chunk2[:overlap] * fade_in[: len(chunk2)] + (
                    chunk1[-overlap:] * fade_out
                )[: len(chunk2)]
            else:
                chunk2[:overlap] = chunk2[:overlap] * fade_in + chunk1[-overlap:] * fade_out
            return chunk2

        max_source_window = max_context_window - mel2.size(2)
        processed_frames = 0
        generated_wave_chunks = []
        previous_chunk = None
        diffusion_steps = int(args.diffusion_steps)
        inference_cfg_rate = float(args.inference_cfg_rate)

        while processed_frames < cond.size(1):
            chunk_cond = cond[:, processed_frames : processed_frames + max_source_window]
            is_last_chunk = processed_frames + max_source_window >= cond.size(1)
            cat_condition = torch.cat([prompt_condition, chunk_cond], dim=1)
            with torch.no_grad():
                with torch.autocast(device_type=device.type, dtype=torch.float16 if fp16 else torch.float32):
                    vc_target = model.cfm.inference(
                        cat_condition,
                        torch.LongTensor([cat_condition.size(1)]).to(mel2.device),
                        mel2,
                        style2,
                        None,
                        diffusion_steps,
                        inference_cfg_rate=inference_cfg_rate,
                    )
                    vc_target = vc_target[:, :, mel2.size(-1) :]
                    vc_wave = vocoder_fn(vc_target.float()).squeeze()
                    vc_wave = vc_wave[None, :]
            if processed_frames == 0:
                if is_last_chunk:
                    generated_wave_chunks.append(vc_wave[0].detach().cpu().numpy())
                    break
                generated_wave_chunks.append(vc_wave[0, :-overlap_wave_len].detach().cpu().numpy())
                previous_chunk = vc_wave[0, -overlap_wave_len:]
                processed_frames += vc_target.size(2) - overlap_frame_len
            elif is_last_chunk:
                generated_wave_chunks.append(
                    crossfade(
                        previous_chunk.detach().cpu().numpy(),
                        vc_wave[0].detach().cpu().numpy(),
                        overlap_wave_len,
                    )
                )
                break
            else:
                generated_wave_chunks.append(
                    crossfade(
                        previous_chunk.detach().cpu().numpy(),
                        vc_wave[0, :-overlap_wave_len].detach().cpu().numpy(),
                        overlap_wave_len,
                    )
                )
                previous_chunk = vc_wave[0, -overlap_wave_len:]
                processed_frames += vc_target.size(2) - overlap_frame_len

            pct = 50.0 + min(40.0, 40.0 * processed_frames / max(1, cond.size(1)))
            _report(pct, "변환 청크 처리 중…")

        vc_wave = torch.tensor(np.concatenate(generated_wave_chunks))[None, :].float()
        _report(92.0, "WAV 저장…")
        torchaudio.save(str(output), vc_wave.cpu(), sr)
        duration_sec = float(vc_wave.size(-1) / sr)
        payload = {
            "ok": True,
            "output_path": str(output.resolve()),
            "duration_sec": duration_sec,
            "sample_rate": sr,
            "device": str(device),
        }
        print(f"ITZ_RESULT {json.dumps(payload, ensure_ascii=False)}", flush=True)
        _report(100.0, "완료")
        return 0
    except Exception as exc:
        print(f"conversion failed: {exc}", file=sys.stderr)
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
