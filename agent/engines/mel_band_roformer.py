"""Mel-Band RoFormer (추론 전용) — PyTorch + einops 만 사용.

원본: lucidrains/BS-RoFormer (MIT) · ZFTurbo/Music-Source-Separation-Training (MIT) ·
python-audio-separator (MIT). 학습/손실·MPS/DirectML 분기·beartype·librosa·
rotary-embedding-torch 의존성을 제거하고 체크포인트 state_dict 키 구조는 그대로 유지했습니다.
"""
from __future__ import annotations

import math
from functools import partial

import numpy as np
import torch
import torch.nn.functional as F
from einops import pack, rearrange, reduce, repeat, unpack
from torch import nn
from torch.nn import Module, ModuleList


# ---------------------------------------------------------------------------
# librosa.filters.mel(htk=False, norm="slaney") 와 동일한 멜 필터뱅크
# ---------------------------------------------------------------------------

_F_SP = 200.0 / 3
_MIN_LOG_HZ = 1000.0
_MIN_LOG_MEL = _MIN_LOG_HZ / _F_SP
_LOGSTEP = math.log(6.4) / 27.0


def _hz_to_mel(f: np.ndarray) -> np.ndarray:
    f = np.asanyarray(f, dtype=np.float64)
    mels = f / _F_SP
    log_t = f >= _MIN_LOG_HZ
    mels = np.where(log_t, _MIN_LOG_MEL + np.log(np.maximum(f, 1e-10) / _MIN_LOG_HZ) / _LOGSTEP, mels)
    return mels


def _mel_to_hz(m: np.ndarray) -> np.ndarray:
    m = np.asanyarray(m, dtype=np.float64)
    freqs = _F_SP * m
    log_t = m >= _MIN_LOG_MEL
    return np.where(log_t, _MIN_LOG_HZ * np.exp(_LOGSTEP * (m - _MIN_LOG_MEL)), freqs)


def mel_filter_bank(sr: int, n_fft: int, n_mels: int) -> np.ndarray:
    fmax = sr / 2.0
    fftfreqs = np.fft.rfftfreq(n=n_fft, d=1.0 / sr)
    mel_f = _mel_to_hz(np.linspace(_hz_to_mel(0.0), _hz_to_mel(fmax), n_mels + 2))
    fdiff = np.diff(mel_f)
    ramps = np.subtract.outer(mel_f, fftfreqs)
    weights = np.zeros((n_mels, 1 + n_fft // 2), dtype=np.float32)
    for i in range(n_mels):
        lower = -ramps[i] / fdiff[i]
        upper = ramps[i + 2] / fdiff[i + 1]
        weights[i] = np.maximum(0, np.minimum(lower, upper))
    enorm = 2.0 / (mel_f[2: n_mels + 2] - mel_f[:n_mels])
    weights *= enorm[:, None].astype(np.float32)
    return weights


# ---------------------------------------------------------------------------
# Rotary embedding (rotary-embedding-torch 0.6.x, freqs_for="lang" 와 동일)
# ---------------------------------------------------------------------------

class RotaryEmbedding(Module):
    def __init__(self, dim: int, theta: float = 10000.0):
        super().__init__()
        freqs = 1.0 / (theta ** (torch.arange(0, dim, 2)[: dim // 2].float() / dim))
        self.freqs = nn.Parameter(freqs, requires_grad=False)
        self._cache: dict[tuple, torch.Tensor] = {}

    def angles(self, seq_len: int, device: torch.device) -> torch.Tensor:
        key = (seq_len, str(device))
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        pos = torch.arange(seq_len, device=device, dtype=torch.float32)
        ang = torch.einsum("n, f -> n f", pos, self.freqs.to(device=device, dtype=torch.float32))
        ang = torch.repeat_interleave(ang, 2, dim=-1)
        self._cache[key] = ang
        return ang


def _rotate_half(x: torch.Tensor) -> torch.Tensor:
    x = rearrange(x, "... (d r) -> ... d r", r=2)
    x1, x2 = x.unbind(dim=-1)
    return rearrange(torch.stack((-x2, x1), dim=-1), "... d r -> ... (d r)")


def _apply_rotary(rotary: RotaryEmbedding, t: torch.Tensor) -> torch.Tensor:
    dtype = t.dtype
    ang = rotary.angles(t.shape[-2], t.device)
    tf = t.float()
    out = tf * ang.cos() + _rotate_half(tf) * ang.sin()
    return out.to(dtype)


# ---------------------------------------------------------------------------
# Building blocks
# ---------------------------------------------------------------------------

class RMSNorm(Module):
    def __init__(self, dim: int):
        super().__init__()
        self.scale = dim ** 0.5
        self.gamma = nn.Parameter(torch.ones(dim))

    def forward(self, x):
        if x.dtype in (torch.float16, torch.bfloat16):
            normalized = F.normalize(x.float(), dim=-1).to(x.dtype)
        else:
            normalized = F.normalize(x, dim=-1)
        return normalized * self.scale * self.gamma


class FeedForward(Module):
    def __init__(self, dim, mult=4, dropout=0.0):
        super().__init__()
        inner = int(dim * mult)
        self.net = nn.Sequential(
            RMSNorm(dim), nn.Linear(dim, inner), nn.GELU(), nn.Dropout(dropout),
            nn.Linear(inner, dim), nn.Dropout(dropout),
        )

    def forward(self, x):
        return self.net(x)


class Attention(Module):
    def __init__(self, dim, heads=8, dim_head=64, dropout=0.0, rotary_embed=None):
        super().__init__()
        self.heads = heads
        inner = heads * dim_head
        self.rotary_embed = rotary_embed
        self.norm = RMSNorm(dim)
        self.to_qkv = nn.Linear(dim, inner * 3, bias=False)
        self.to_gates = nn.Linear(dim, heads)
        self.to_out = nn.Sequential(nn.Linear(inner, dim, bias=False), nn.Dropout(dropout))

    def forward(self, x):
        x = self.norm(x)
        q, k, v = rearrange(self.to_qkv(x), "b n (qkv h d) -> qkv b h n d", qkv=3, h=self.heads)
        if self.rotary_embed is not None:
            q = _apply_rotary(self.rotary_embed, q)
            k = _apply_rotary(self.rotary_embed, k)
        out = F.scaled_dot_product_attention(q, k, v)
        gates = self.to_gates(x)
        out = out * rearrange(gates, "b n h -> b h n 1").sigmoid()
        out = rearrange(out, "b h n d -> b n (h d)")
        return self.to_out(out)


class Transformer(Module):
    def __init__(self, *, dim, depth, dim_head=64, heads=8, attn_dropout=0.0, ff_dropout=0.0,
                 ff_mult=4, norm_output=True, rotary_embed=None):
        super().__init__()
        self.layers = ModuleList([])
        for _ in range(depth):
            self.layers.append(ModuleList([
                Attention(dim=dim, dim_head=dim_head, heads=heads, dropout=attn_dropout, rotary_embed=rotary_embed),
                FeedForward(dim=dim, mult=ff_mult, dropout=ff_dropout),
            ]))
        self.norm = RMSNorm(dim) if norm_output else nn.Identity()

    def forward(self, x):
        for attn, ff in self.layers:
            x = attn(x) + x
            x = ff(x) + x
        return self.norm(x)


class BandSplit(Module):
    def __init__(self, dim, dim_inputs):
        super().__init__()
        self.dim_inputs = tuple(dim_inputs)
        self.to_features = ModuleList([nn.Sequential(RMSNorm(d), nn.Linear(d, dim)) for d in self.dim_inputs])

    def forward(self, x):
        parts = x.split(self.dim_inputs, dim=-1)
        return torch.stack([f(p) for p, f in zip(parts, self.to_features)], dim=-2)


def _mlp(dim_in, dim_out, dim_hidden, depth, activation=nn.Tanh):
    dims = (dim_in, *((dim_hidden,) * depth), dim_out)
    net = []
    for i, (a, b) in enumerate(zip(dims[:-1], dims[1:])):
        net.append(nn.Linear(a, b))
        if i != len(dims) - 2:
            net.append(activation())
    return nn.Sequential(*net)


class MaskEstimator(Module):
    def __init__(self, dim, dim_inputs, depth, mlp_expansion_factor=4):
        super().__init__()
        self.dim_inputs = tuple(dim_inputs)
        hidden = dim * mlp_expansion_factor
        self.to_freqs = ModuleList([
            nn.Sequential(_mlp(dim, d * 2, hidden, depth), nn.GLU(dim=-1)) for d in self.dim_inputs
        ])

    def forward(self, x):
        return torch.cat([mlp(band) for band, mlp in zip(x.unbind(dim=-2), self.to_freqs)], dim=-1)


class MelBandRoformer(Module):
    def __init__(
        self,
        dim,
        *,
        depth,
        stereo=False,
        num_stems=1,
        time_transformer_depth=2,
        freq_transformer_depth=2,
        num_bands=60,
        dim_head=64,
        heads=8,
        attn_dropout=0.0,
        ff_dropout=0.0,
        mlp_expansion_factor=4,
        dim_freqs_in=1025,
        sample_rate=44100,
        stft_n_fft=2048,
        stft_hop_length=512,
        stft_win_length=2048,
        stft_normalized=False,
        mask_estimator_depth=1,
        **_ignored,
    ):
        super().__init__()
        self.stereo = stereo
        self.audio_channels = 2 if stereo else 1
        self.num_stems = num_stems
        self.layers = ModuleList([])
        tk = dict(dim=dim, heads=heads, dim_head=dim_head, attn_dropout=attn_dropout, ff_dropout=ff_dropout)
        time_rot = RotaryEmbedding(dim=dim_head)
        freq_rot = RotaryEmbedding(dim=dim_head)
        for _ in range(depth):
            self.layers.append(nn.ModuleList([
                Transformer(depth=time_transformer_depth, rotary_embed=time_rot, **tk),
                Transformer(depth=freq_transformer_depth, rotary_embed=freq_rot, **tk),
            ]))

        self.stft_window_fn = partial(torch.hann_window, stft_win_length)
        self.stft_kwargs = dict(
            n_fft=stft_n_fft, hop_length=stft_hop_length, win_length=stft_win_length, normalized=stft_normalized,
        )
        freqs = stft_n_fft // 2 + 1

        fb = torch.from_numpy(mel_filter_bank(sample_rate, stft_n_fft, num_bands))
        fb[0][0] = 1.0
        fb[-1, -1] = 1.0
        freqs_per_band = fb > 0
        assert freqs_per_band.any(dim=0).all(), "all frequencies need to be covered by all bands"

        freq_indices = repeat(torch.arange(freqs), "f -> b f", b=num_bands)[freqs_per_band]
        if stereo:
            freq_indices = repeat(freq_indices, "f -> f s", s=2)
            freq_indices = freq_indices * 2 + torch.arange(2)
            freq_indices = rearrange(freq_indices, "f s -> (f s)")
        self.register_buffer("freq_indices", freq_indices, persistent=False)
        self.register_buffer("freqs_per_band", freqs_per_band, persistent=False)
        num_freqs_per_band = reduce(freqs_per_band, "b f -> b", "sum")
        num_bands_per_freq = reduce(freqs_per_band, "b f -> f", "sum")
        self.register_buffer("num_freqs_per_band", num_freqs_per_band, persistent=False)
        self.register_buffer("num_bands_per_freq", num_bands_per_freq, persistent=False)

        dims_c = tuple(2 * f * self.audio_channels for f in num_freqs_per_band.tolist())
        self.band_split = BandSplit(dim=dim, dim_inputs=dims_c)
        self.mask_estimators = nn.ModuleList([
            MaskEstimator(dim=dim, dim_inputs=dims_c, depth=mask_estimator_depth,
                          mlp_expansion_factor=mlp_expansion_factor)
            for _ in range(num_stems)
        ])

    def forward(self, raw_audio: torch.Tensor) -> torch.Tensor:
        device = raw_audio.device
        if raw_audio.ndim == 2:
            raw_audio = rearrange(raw_audio, "b t -> b 1 t")
        batch, channels, _ = raw_audio.shape
        raw_audio, packed_shape = pack([raw_audio], "* t")

        window = self.stft_window_fn(device=device)
        stft_repr = torch.view_as_real(
            torch.stft(raw_audio.float(), **self.stft_kwargs, window=window, return_complex=True)
        )
        stft_repr = unpack(stft_repr, packed_shape, "* f t c")[0]
        stft_repr = rearrange(stft_repr, "b s f t c -> b (f s) t c")

        batch_arange = torch.arange(batch, device=device)[..., None]
        x = stft_repr[batch_arange, self.freq_indices]
        x = rearrange(x, "b f t c -> b t (f c)")
        x = x.to(next(self.band_split.parameters()).dtype)
        x = self.band_split(x)

        for time_tf, freq_tf in self.layers:
            x = rearrange(x, "b t f d -> b f t d")
            x, ps = pack([x], "* t d")
            x = time_tf(x)
            (x,) = unpack(x, ps, "* t d")
            x = rearrange(x, "b f t d -> b t f d")
            x, ps = pack([x], "* f d")
            x = freq_tf(x)
            (x,) = unpack(x, ps, "* f d")

        masks = torch.stack([fn(x) for fn in self.mask_estimators], dim=1)
        masks = rearrange(masks, "b n t (f c) -> b n f t c", c=2).float()

        stft_repr = rearrange(stft_repr, "b f t c -> b 1 f t c")
        stft_c = torch.view_as_complex(stft_repr.contiguous())
        masks_c = torch.view_as_complex(masks.contiguous())

        scatter_idx = repeat(self.freq_indices, "f -> b n f t", b=batch, n=self.num_stems, t=stft_c.shape[-1])
        expanded = repeat(stft_c, "b 1 ... -> b n ...", n=self.num_stems)
        masks_summed = torch.zeros_like(expanded).scatter_add_(2, scatter_idx, masks_c)
        denom = repeat(self.num_bands_per_freq, "f -> (f r) 1", r=channels)
        masks_avg = masks_summed / denom.clamp(min=1e-8)

        stft_c = stft_c * masks_avg
        stft_c = rearrange(stft_c, "b n (f s) t -> (b n s) f t", s=self.audio_channels)
        recon = torch.istft(stft_c, **self.stft_kwargs, window=window, return_complex=False)
        recon = rearrange(recon, "(b n s) t -> b n s t", b=batch, s=self.audio_channels, n=self.num_stems)
        if self.num_stems == 1:
            recon = rearrange(recon, "b 1 s t -> b s t")
        return recon


# Kim Jensen MelBandRoformer.ckpt (보컬) 설정
KIM_VOCAL_CONFIG = dict(
    dim=384,
    depth=6,
    stereo=True,
    num_stems=1,
    time_transformer_depth=1,
    freq_transformer_depth=1,
    num_bands=60,
    dim_head=64,
    heads=8,
    attn_dropout=0.0,
    ff_dropout=0.0,
    dim_freqs_in=1025,
    sample_rate=44100,
    stft_n_fft=2048,
    stft_hop_length=441,
    stft_win_length=2048,
    stft_normalized=False,
    mask_estimator_depth=2,
)
KIM_CHUNK_SIZE = 352800  # hop 441 * (dim_t 801 - 1)


def load_kim_vocal_model(ckpt_path: str, device: torch.device) -> MelBandRoformer:
    model = MelBandRoformer(**KIM_VOCAL_CONFIG)
    state = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    if isinstance(state, dict) and "state_dict" in state and isinstance(state["state_dict"], dict):
        state = state["state_dict"]
    if isinstance(state, dict) and any(k.startswith("model.") for k in state):
        state = {k[len("model."):] if k.startswith("model.") else k: v for k, v in state.items()}
    missing, unexpected = model.load_state_dict(state, strict=False)
    # rotary freqs 는 결정적 상수라 체크포인트에 없어도 무방
    missing = [k for k in missing if not k.endswith("rotary_embed.freqs")]
    if missing or unexpected:
        raise RuntimeError(
            f"Roformer 체크포인트 키 불일치 (missing={missing[:5]}, unexpected={list(unexpected)[:5]})"
        )
    return model.to(device).eval()
