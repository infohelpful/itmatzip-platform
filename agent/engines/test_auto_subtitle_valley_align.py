"""Valley word boundary align — auto_subtitle_valley_align."""

from __future__ import annotations

import math
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np

from common.subprocess_util import no_window_creationflags
from engines.auto_subtitle_valley_align import apply_valley_word_align
from engines.auto_subtitle_zero_cross import SR, resolve_ffmpeg


def _tone_burst(
    samples: np.ndarray,
    t0: float,
    t1: float,
    freq: float = 300.0,
    amp: float = 0.35,
) -> None:
    i0 = max(0, int(t0 * SR))
    i1 = min(len(samples), int(t1 * SR))
    for i in range(i0, i1):
        t = i / SR
        env = min(1.0, (i - i0) / max(1, SR // 200), (i1 - i) / max(1, SR // 200))
        samples[i] = amp * env * math.sin(2.0 * math.pi * freq * t)


def _write_wav(samples: np.ndarray, wav: Path, ff: str) -> None:
    r = subprocess.run(
        [
            ff,
            "-nostdin",
            "-y",
            "-f",
            "f32le",
            "-ar",
            str(SR),
            "-ac",
            "1",
            "-i",
            "-",
            str(wav),
        ],
        input=samples.astype(np.float32).tobytes(),
        capture_output=True,
        creationflags=no_window_creationflags(),
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode(errors="replace"))


class ValleyWordAlignTests(unittest.TestCase):
    def test_aligns_at_energy_valley_between_words(self) -> None:
        dur = 2.0
        samples = np.zeros(int(dur * SR), dtype=np.float32)
        _tone_burst(samples, 0.52, 0.72, freq=280.0)
        _tone_burst(samples, 1.02, 1.28, freq=360.0)

        cues = [
            {
                "start": 0.52,
                "end": 0.92,
                "text": "alpha beta",
                "words": [
                    {"word": "alpha", "start": 0.52, "end": 0.92},
                    {"word": "beta", "start": 0.86, "end": 1.28},
                ],
            }
        ]

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "t.wav"
            ff = resolve_ffmpeg()
            _write_wav(samples, wav, ff)
            out, stats = apply_valley_word_align(cues, str(wav), ff)
            self.assertTrue(stats.get("applied"), stats)
            w0, w1 = out[0]["words"][0], out[0]["words"][1]
            self.assertAlmostEqual(float(w0["end"]), float(w1["start"]), delta=0.002)
            self.assertGreater(float(w0["end"]), 0.80)
            self.assertLess(float(w0["end"]), 1.02)

    def test_extends_through_trailing_syllable_peak(self) -> None:
        """Whisper end가 꼬리 음절(~습니다) 앞이면 — tail peak 뒤 V까지 연장."""
        dur = 2.0
        samples = np.zeros(int(dur * SR), dtype=np.float32)
        _tone_burst(samples, 0.52, 0.68, freq=280.0, amp=0.40)
        _tone_burst(samples, 0.78, 0.88, freq=300.0, amp=0.28)
        _tone_burst(samples, 1.02, 1.28, freq=360.0, amp=0.35)

        cues = [
            {
                "start": 0.52,
                "end": 0.72,
                "text": "alpha beta",
                "words": [
                    {"word": "alpha", "start": 0.52, "end": 0.72},
                    {"word": "beta", "start": 0.86, "end": 1.28},
                ],
            }
        ]

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "t.wav"
            ff = resolve_ffmpeg()
            _write_wav(samples, wav, ff)
            out, stats = apply_valley_word_align(cues, str(wav), ff)
            self.assertTrue(stats.get("applied"), stats)
            w0, w1 = out[0]["words"][0], out[0]["words"][1]
            boundary = float(w0["end"])
            self.assertAlmostEqual(boundary, float(w1["start"]), delta=0.002)
            self.assertGreater(boundary, 0.88, "꼬리 peak(0.78~0.88) 뒤 V에서 잘라야 함")
            self.assertLess(boundary, 1.02)

    def test_skips_inner_valley_when_rise_before_next_valley(self) -> None:
        """되었(V₁)▁습니다(V₂)▁예전 — V₁ 스킵, V₂에서 경계."""
        dur = 2.0
        samples = np.zeros(int(dur * SR), dtype=np.float32)
        _tone_burst(samples, 0.52, 0.66, freq=280.0, amp=0.42)
        _tone_burst(samples, 0.74, 0.84, freq=300.0, amp=0.30)
        _tone_burst(samples, 1.02, 1.28, freq=360.0, amp=0.35)

        cues = [
            {
                "start": 0.52,
                "end": 0.72,
                "text": "되었습니다 예전",
                "words": [
                    {"word": "되었습니다.", "start": 0.52, "end": 0.72},
                    {"word": "예전에는", "start": 0.86, "end": 1.28},
                ],
            }
        ]

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "t.wav"
            ff = resolve_ffmpeg()
            _write_wav(samples, wav, ff)
            out, stats = apply_valley_word_align(cues, str(wav), ff)
            self.assertTrue(stats.get("applied"), stats)
            w0, w1 = out[0]["words"][0], out[0]["words"][1]
            boundary = float(w0["end"])
            self.assertAlmostEqual(boundary, float(w1["start"]), delta=0.002)
            self.assertGreater(
                boundary,
                0.86,
                "V₁(되었|습니다)이 아니라 V₂(습니다|예전)에서 잘라야 함",
            )
            self.assertLess(boundary, 1.02)

    def test_whisper_stuck_at_v1_extends_to_v2(self) -> None:
        """Whisper end/start가 모두 V₁(0.72)에 박힌 경우 → V₂(~0.90)로 연장."""
        dur = 2.5
        samples = np.zeros(int(dur * SR), dtype=np.float32)
        _tone_burst(samples, 0.52, 0.66, freq=280.0, amp=0.42)
        _tone_burst(samples, 0.74, 0.84, freq=300.0, amp=0.30)
        _tone_burst(samples, 1.02, 1.28, freq=360.0, amp=0.35)

        cues = [
            {
                "start": 0.52,
                "end": 0.72,
                "text": "되었습니다.",
                "words": [
                    {"word": "되었습니다.", "start": 0.52, "end": 0.72},
                    {"word": "예전에는", "start": 0.72, "end": 1.28},
                ],
            }
        ]

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "t.wav"
            ff = resolve_ffmpeg()
            _write_wav(samples, wav, ff)
            out, stats = apply_valley_word_align(cues, str(wav), ff)
            self.assertTrue(stats.get("applied"), stats)
            w0, w1 = out[0]["words"][0], out[0]["words"][1]
            boundary = float(w0["end"])
            self.assertAlmostEqual(boundary, float(w1["start"]), delta=0.002)
            self.assertGreater(boundary, 0.86)
            self.assertLess(boundary, 1.02)

    def test_v652_whisper_stuck_cross_cue(self) -> None:
        """실제 케이스 근사 — a_e=b_s=6.52(V₁) → V₂(~6.90) 연장."""
        dur = 10.0
        samples = np.zeros(int(dur * SR), dtype=np.float32)
        _tone_burst(samples, 5.59, 6.35, freq=280.0, amp=0.42)
        _tone_burst(samples, 6.55, 6.85, freq=300.0, amp=0.30)
        _tone_burst(samples, 7.05, 7.35, freq=360.0, amp=0.35)

        cues = [
            {
                "start": 5.59,
                "end": 6.52,
                "text": "수 있는 시대가 되었습니다.",
                "words": [
                    {"word": "되었습니다.", "start": 5.59, "end": 6.52},
                ],
            },
            {
                "start": 6.52,
                "end": 7.35,
                "text": "예전에는 이런",
                "words": [
                    {"word": "예전에는", "start": 6.52, "end": 7.35},
                ],
            },
        ]

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "t.wav"
            ff = resolve_ffmpeg()
            _write_wav(samples, wav, ff)
            out, stats = apply_valley_word_align(cues, str(wav), ff)
            self.assertTrue(stats.get("applied"), stats)
            w0 = out[0]["words"][0]
            w1 = out[1]["words"][0]
            boundary = float(w0["end"])
            self.assertAlmostEqual(boundary, float(w1["start"]), delta=0.002)
            self.assertGreater(boundary, 6.86, "V₂(습니다|예전)에서 잘라야 함 — 6.52(V₁) 아님")
            self.assertLess(boundary, 7.05)
            patch = stats.get("patches", [{}])[0]
            self.assertIsNotNone(patch.get("next_word_peak_sec"))
            self.assertGreater(float(patch["next_word_peak_sec"]), 6.95)

    def test_cross_cue_doesseumnida_yejon(self) -> None:
        """블록 경계 — 되었습니다.|예전에는 (Whisper end가 V₁에 있을 때 V₂로 연장)."""
        dur = 2.5
        samples = np.zeros(int(dur * SR), dtype=np.float32)
        _tone_burst(samples, 0.52, 0.66, freq=280.0, amp=0.42)
        _tone_burst(samples, 0.74, 0.84, freq=300.0, amp=0.30)
        _tone_burst(samples, 1.02, 1.28, freq=360.0, amp=0.35)

        cues = [
            {
                "start": 0.52,
                "end": 0.72,
                "text": "수 있는 시대가 되었습니다.",
                "words": [
                    {"word": "되었습니다.", "start": 0.52, "end": 0.72},
                ],
            },
            {
                "start": 0.86,
                "end": 1.28,
                "text": "예전에는 이런",
                "words": [
                    {"word": "예전에는", "start": 0.86, "end": 1.28},
                ],
            },
        ]

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "t.wav"
            ff = resolve_ffmpeg()
            _write_wav(samples, wav, ff)
            out, stats = apply_valley_word_align(cues, str(wav), ff)
            self.assertTrue(stats.get("applied"), stats)
            w0 = out[0]["words"][0]
            w1 = out[1]["words"][0]
            boundary = float(w0["end"])
            self.assertAlmostEqual(boundary, float(w1["start"]), delta=0.002)
            self.assertGreater(boundary, 0.86, "습니다 꼬리 peak 뒤 V₂에서 잘라야 함")
            self.assertLess(boundary, 1.02)

    def test_skips_continuous_speech_without_valley(self) -> None:
        dur = 1.5
        samples = np.zeros(int(dur * SR), dtype=np.float32)
        _tone_burst(samples, 0.20, 1.20, freq=300.0, amp=0.35)

        cues = [
            {
                "start": 0.20,
                "end": 1.20,
                "text": "one two",
                "words": [
                    {"word": "one", "start": 0.20, "end": 0.75},
                    {"word": "two", "start": 0.70, "end": 1.20},
                ],
            }
        ]

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "t.wav"
            ff = resolve_ffmpeg()
            _write_wav(samples, wav, ff)
            _out, stats = apply_valley_word_align(cues, str(wav), ff)
            self.assertEqual(int(stats.get("pairs_adjusted") or 0), 0)
            self.assertGreater(
                int(stats.get("skip_reasons", {}).get("no_valley", 0))
                + int(stats.get("skip_reasons", {}).get("already_ok", 0))
                + int(stats.get("skip_reasons", {}).get("whisper_ok", 0)),
                0,
            )

    def test_syllable_target_korean_early_valley(self) -> None:
        """기술이|발전 — Whisper end가 늦어도 t_target 근처 V(≈1.15)에서 경계."""
        dur = 3.0
        samples = np.zeros(int(dur * SR), dtype=np.float32)
        _tone_burst(samples, 0.98, 1.12, freq=300.0, amp=0.40)
        _tone_burst(samples, 1.22, 1.67, freq=340.0, amp=0.38)

        cues = [
            {
                "start": 0.98,
                "end": 1.67,
                "text": "인공지능 기술이 발전하면서",
                "words": [
                    {"word": "기술이", "start": 0.98, "end": 1.67},
                    {"word": "발전하면서", "start": 1.67, "end": 2.20},
                ],
            }
        ]

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "t.wav"
            ff = resolve_ffmpeg()
            _write_wav(samples, wav, ff)
            out, stats = apply_valley_word_align(cues, str(wav), ff)
            self.assertTrue(stats.get("applied"), stats)
            w0, w1 = out[0]["words"][0], out[0]["words"][1]
            boundary = float(w0["end"])
            self.assertAlmostEqual(boundary, float(w1["start"]), delta=0.002)
            self.assertGreater(boundary, 1.10, "기술이|발전 사이 V에서 잘라야 함")
            self.assertLess(boundary, 1.22, "발전 onset(1.22) 전이어야 함")
            patch = stats.get("patches", [{}])[0]
            self.assertEqual(patch.get("syllable_count"), 3)
            self.assertIsNotNone(patch.get("syllable_target_sec"))

    def test_yejon_ireon_boundary_at_valley_not_b_peak(self) -> None:
        """예전에는|이런 — B onset peak(7.63)가 아니라 t_target(≈7.46) 근처 V."""
        dur = 10.0
        samples = np.zeros(int(dur * SR), dtype=np.float32)
        _tone_burst(samples, 6.90, 7.30, freq=300.0, amp=0.40)
        _tone_burst(samples, 7.63, 7.85, freq=340.0, amp=0.38)

        cues = [
            {
                "start": 6.90,
                "end": 7.63,
                "text": "예전에는 이런",
                "words": [
                    {"word": "예전에는", "start": 6.90, "end": 7.63},
                    {"word": "이런", "start": 7.63, "end": 8.01},
                ],
            }
        ]

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "t.wav"
            ff = resolve_ffmpeg()
            _write_wav(samples, wav, ff)
            out, stats = apply_valley_word_align(cues, str(wav), ff)
            self.assertTrue(stats.get("applied"), stats)
            w0, w1 = out[0]["words"][0], out[0]["words"][1]
            boundary = float(w0["end"])
            self.assertAlmostEqual(boundary, float(w1["start"]), delta=0.002)
            self.assertLess(boundary, 7.63, "이런 onset(7.63) 전 V/silence")
            self.assertGreater(boundary, 7.28, "예전 발화(7.30) 뒤")

    def test_ireon_end_near_syllable_target(self) -> None:
        """이런|기술 — 2글×0.14 후 V (start≈7.40 → t_target≈7.68)."""
        dur = 10.0
        samples = np.zeros(int(dur * SR), dtype=np.float32)
        _tone_burst(samples, 7.40, 7.58, freq=320.0, amp=0.38)
        _tone_burst(samples, 7.78, 8.05, freq=360.0, amp=0.40)

        cues = [
            {
                "start": 7.40,
                "end": 8.05,
                "text": "이런 기술을",
                "words": [
                    {"word": "이런", "start": 7.40, "end": 7.78},
                    {"word": "기술을", "start": 7.78, "end": 8.05},
                ],
            }
        ]

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "t.wav"
            ff = resolve_ffmpeg()
            _write_wav(samples, wav, ff)
            out, stats = apply_valley_word_align(cues, str(wav), ff)
            self.assertTrue(stats.get("applied"), stats)
            w0, w1 = out[0]["words"][0], out[0]["words"][1]
            boundary = float(w0["end"])
            self.assertAlmostEqual(boundary, float(w1["start"]), delta=0.002)
            self.assertGreater(boundary, 7.55, "이런 끝 — peak(7.58) 뒤 V")
            self.assertLess(boundary, 7.78, "기술 onset 전")

    def test_voicebox_end_at_valley_not_peak(self) -> None:
        """보이스박스입니다.|다음 — end가 peak(22.88)가 아니라 V(≈22.66)."""
        dur = 30.0
        samples = np.zeros(int(dur * SR), dtype=np.float32)
        _tone_burst(samples, 21.80, 22.55, freq=300.0, amp=0.40)
        _tone_burst(samples, 22.85, 23.10, freq=340.0, amp=0.38)

        cues = [
            {
                "start": 21.80,
                "end": 22.88,
                "text": "소개할 보이스박스입니다. 다음",
                "words": [
                    {"word": "보이스박스입니다.", "start": 21.80, "end": 22.88},
                    {"word": "다음", "start": 22.88, "end": 23.10},
                ],
            }
        ]

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "t.wav"
            ff = resolve_ffmpeg()
            _write_wav(samples, wav, ff)
            out, stats = apply_valley_word_align(cues, str(wav), ff)
            self.assertTrue(stats.get("applied"), stats)
            w0, w1 = out[0]["words"][0], out[0]["words"][1]
            boundary = float(w0["end"])
            self.assertAlmostEqual(boundary, float(w1["start"]), delta=0.002)
            self.assertLess(boundary, 22.84, "peak/slope(22.88) 전 V에서 잘라야 함")
            self.assertGreater(boundary, 22.50, "보이스박스 발화 뒤")

    def test_single_syllable_nae_near_target(self) -> None:
        """내|목소리 — 1글(≈0.14s)인데 0.4s 먹으면 t_target 근처 최저점으로."""
        dur = 10.0
        samples = np.zeros(int(dur * SR), dtype=np.float32)
        _tone_burst(samples, 2.06, 2.20, freq=320.0, amp=0.38)
        _tone_burst(samples, 2.40, 2.70, freq=360.0, amp=0.40)

        cues = [
            {
                "start": 2.06,
                "end": 2.50,
                "text": "발전하면서 내 목소리를",
                "words": [
                    {"word": "내", "start": 2.06, "end": 2.46},
                    {"word": "목소리를", "start": 2.46, "end": 2.90},
                ],
            }
        ]

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "t.wav"
            ff = resolve_ffmpeg()
            _write_wav(samples, wav, ff)
            out, stats = apply_valley_word_align(cues, str(wav), ff)
            self.assertTrue(stats.get("applied"), stats)
            w0, w1 = out[0]["words"][0], out[0]["words"][1]
            boundary = float(w0["end"])
            dur_a = boundary - float(w0["start"])
            self.assertAlmostEqual(boundary, float(w1["start"]), delta=0.002)
            self.assertLess(dur_a, 0.28, "1음절 '내' — 0.4s 넘게 먹으면 안 됨")
            self.assertGreater(dur_a, 0.08, "너무 짧지 않게")
            t_target = float(w0["start"]) + 0.14
            self.assertLess(abs(boundary - t_target), 0.20, "t_target±WIN 안에서 자름")

    def test_five_char_word_over_one_sec_gets_trimmed(self) -> None:
        """5글자인데 1초 넘으면 — 글자수×0.14(≈0.7s) 기준 과다 → t_target 근처 V/최저 볼륨."""
        dur = 4.0
        samples = np.zeros(int(dur * SR), dtype=np.float32)
        _tone_burst(samples, 1.00, 1.18, freq=300.0, amp=0.40)
        _tone_burst(samples, 1.28, 1.42, freq=320.0, amp=0.28)
        _tone_burst(samples, 1.52, 1.66, freq=340.0, amp=0.26)
        _tone_burst(samples, 1.76, 1.90, freq=360.0, amp=0.24)
        _tone_burst(samples, 2.05, 2.35, freq=380.0, amp=0.38)

        cues = [
            {
                "start": 1.00,
                "end": 2.05,
                "text": "안녕하세요 다음",
                "words": [
                    {"word": "안녕하세요", "start": 1.00, "end": 2.05},
                    {"word": "다음", "start": 2.05, "end": 2.35},
                ],
            }
        ]

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "t.wav"
            ff = resolve_ffmpeg()
            _write_wav(samples, wav, ff)
            out, stats = apply_valley_word_align(cues, str(wav), ff)
            self.assertTrue(stats.get("applied"), stats)
            w0, w1 = out[0]["words"][0], out[0]["words"][1]
            boundary = float(w0["end"])
            dur_a = boundary - float(w0["start"])
            self.assertAlmostEqual(boundary, float(w1["start"]), delta=0.002)
            self.assertLess(dur_a, 1.0, "5글×0.14≈0.7s — 1초 넘게 먹으면 안 됨")
            self.assertGreater(dur_a, 0.55, "발화 구간은 유지")
            t_target = float(w0["start"]) + 5 * 0.14
            self.assertLess(abs(boundary - t_target), 0.35, "t_target±WIN 안에서 자름")


    def test_nae_diag_like_not_at_251(self) -> None:
        """실제 diag — 내(1글) start 2.06, 잘못된 end 2.51 → t_target≈2.20 근처 V, 2.51 아님."""
        dur = 10.0
        samples = np.zeros(int(dur * SR), dtype=np.float32)
        _tone_burst(samples, 2.06, 2.18, freq=320.0, amp=0.40)
        _tone_burst(samples, 2.34, 2.44, freq=330.0, amp=0.22)
        _tone_burst(samples, 2.56, 2.90, freq=360.0, amp=0.40)

        cues = [
            {
                "start": 1.97,
                "end": 2.90,
                "text": "발전하면서 내 목소리를",
                "words": [
                    {"word": "발전하면서", "start": 1.97, "end": 2.06},
                    {"word": "내", "start": 2.06, "end": 2.51},
                    {"word": "목소리를", "start": 2.51, "end": 2.90},
                ],
            }
        ]

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "t.wav"
            ff = resolve_ffmpeg()
            _write_wav(samples, wav, ff)
            out, stats = apply_valley_word_align(cues, str(wav), ff)
            self.assertTrue(stats.get("applied"), stats)
            w_nae = out[0]["words"][1]
            boundary = float(w_nae["end"])
            dur_nae = boundary - float(w_nae["start"])
            self.assertLess(boundary, 2.50, "2.51(다음 onset) 아님")
            self.assertGreaterEqual(dur_nae, 0.11, "1글 최소 ≈0.14−0.03=0.11s")
            self.assertLess(dur_nae, 0.35, "1글×0.14 — 0.4s 넘으면 안 됨")

    def test_nae_prefers_right_valley_when_left_too_short(self) -> None:
        """diag v6 — 2.11(0.05s) 같은 왼쪽 V 대신 t_target 오른쪽 V(~2.28) 선택."""
        dur = 10.0
        samples = np.zeros(int(dur * SR), dtype=np.float32)
        _tone_burst(samples, 2.06, 2.16, freq=320.0, amp=0.42)
        _tone_burst(samples, 2.24, 2.30, freq=330.0, amp=0.20)
        _tone_burst(samples, 2.38, 2.48, freq=340.0, amp=0.18)
        _tone_burst(samples, 2.56, 2.90, freq=360.0, amp=0.40)

        cues = [
            {
                "start": 2.06,
                "end": 2.90,
                "text": "내 목소리를",
                "words": [
                    {"word": "내", "start": 2.06, "end": 2.51},
                    {"word": "목소리를", "start": 2.51, "end": 2.90},
                ],
            }
        ]

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "t.wav"
            ff = resolve_ffmpeg()
            _write_wav(samples, wav, ff)
            out, stats = apply_valley_word_align(cues, str(wav), ff)
            self.assertTrue(stats.get("applied"), stats)
            w_nae = out[0]["words"][0]
            boundary = float(w_nae["end"])
            dur_nae = boundary - float(w_nae["start"])
            self.assertGreaterEqual(boundary, 2.17, "min 1×(0.14−0.03)=0.11s → start+0.11")
            self.assertGreaterEqual(dur_nae, 0.11)
            self.assertGreaterEqual(boundary, 2.20, "2.11 같은 왼쪽 V 아님 — t_target 이상")

    def test_rate_global_gisurri_trim_near_t_target(self) -> None:
        """rate_global 0.136 — 기술이(3자) Whisper 1.64 → t_target≈1.54 V에서 trim."""
        from engines.auto_subtitle_valley_align import _RateScale, _whisper_duration_too_long

        scale = _RateScale(0.136)
        word = {"word": "기술이", "start": 1.13, "end": 1.64}
        self.assertTrue(_whisper_duration_too_long(word, scale))
        self.assertAlmostEqual(scale.t_target_end(word, 1.13), 1.538, places=2)

        dur = 4.0
        samples = np.zeros(int(dur * SR), dtype=np.float32)
        _tone_burst(samples, 1.13, 1.28, freq=300.0, amp=0.40)
        _tone_burst(samples, 1.60, 1.95, freq=340.0, amp=0.38)

        cues = [
            {
                "start": 1.13,
                "end": 2.0,
                "text": "기술이 발전하면",
                "words": [
                    {"word": "기술이", "start": 1.13, "end": 1.64},
                    {"word": "발전하면", "start": 1.64, "end": 2.0},
                ],
            }
        ]

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "t.wav"
            ff = resolve_ffmpeg()
            _write_wav(samples, wav, ff)
            out, stats = apply_valley_word_align(cues, str(wav), ff)
            self.assertTrue(stats.get("applied"), stats)
            w0, w1 = out[0]["words"][0], out[0]["words"][1]
            boundary = float(w0["end"])
            self.assertAlmostEqual(boundary, float(w1["start"]), delta=0.002)
            self.assertGreater(boundary, 1.48, "t_target(≈1.54) 근처 V — Whisper 1.64 유지 아님")
            self.assertLess(boundary, 1.60, "다음 단어 onset(1.60) 전")
            patch = stats.get("patches", [{}])[0]
            self.assertIn(
                patch.get("contamination"),
                ("a_tail_eats_b_head", "whisper_stuck_inner"),
            )
            self.assertLess(boundary, 1.64, "Whisper end(1.64)보다 앞에서 잘림")
            self.assertAlmostEqual(
                float(patch.get("syllable_target_sec") or 0),
                1.55,
                delta=0.05,
            )

    def test_baldohnhamyeonseo_extends_to_right_valley(self) -> None:
        """발전하면서(5자) — Whisper end가 너무 이르면 t_target 오른쪽 V까지 연장."""
        from engines.auto_subtitle_valley_align import _RateScale, _whisper_duration_too_short

        scale = _RateScale(0.136)
        word = {"word": "발전하면서", "start": 1.47, "end": 1.84}
        self.assertTrue(_whisper_duration_too_short(word, scale))
        self.assertAlmostEqual(scale.t_target_end(word, 1.47), 2.148, places=2)

        dur = 4.5
        samples = np.zeros(int(dur * SR), dtype=np.float32)
        _tone_burst(samples, 1.47, 2.02, freq=300.0, amp=0.40)
        _tone_burst(samples, 2.18, 2.45, freq=360.0, amp=0.35)

        cues = [
            {
                "start": 1.47,
                "end": 2.45,
                "text": "발전하면서 내",
                "words": [
                    {"word": "발전하면서", "start": 1.47, "end": 1.84},
                    {"word": "내", "start": 1.84, "end": 2.45},
                ],
            }
        ]

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "t.wav"
            ff = resolve_ffmpeg()
            _write_wav(samples, wav, ff)
            out, stats = apply_valley_word_align(cues, str(wav), ff)
            self.assertTrue(stats.get("applied"), stats)
            w0, w1 = out[0]["words"][0], out[0]["words"][1]
            boundary = float(w0["end"])
            self.assertAlmostEqual(boundary, float(w1["start"]), delta=0.002)
            self.assertGreater(
                boundary,
                1.95,
                "Whisper 1.84(중간) 아님 — t_target(≈2.15) 쪽 오른쪽 V",
            )
            self.assertLess(boundary, 2.18, "다음 단어 onset(2.18) 전")
            patch = stats.get("patches", [{}])[0]
            self.assertEqual(patch.get("contamination"), "a_tail_stolen")

    def test_yojeum_snaps_from_peak_to_right_valley(self) -> None:
        """요즘(2자) — peak 위 조기 cut(0.24) → B onset 전 오른쪽 V(~0.46)."""
        dur = 3.0
        samples = np.zeros(int(dur * SR), dtype=np.float32)
        _tone_burst(samples, 0.0, 0.44, freq=300.0, amp=0.40)
        _tone_burst(samples, 0.52, 1.05, freq=340.0, amp=0.35)

        cues = [
            {
                "start": 0.0,
                "end": 1.05,
                "text": "요즘 인공지능",
                "words": [
                    {"word": "요즘", "start": 0.0, "end": 0.24},
                    {"word": "인공지능", "start": 0.24, "end": 1.05},
                ],
            }
        ]

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "t.wav"
            ff = resolve_ffmpeg()
            _write_wav(samples, wav, ff)
            out, stats = apply_valley_word_align(cues, str(wav), ff)
            self.assertTrue(stats.get("applied"), stats)
            w0, w1 = out[0]["words"][0], out[0]["words"][1]
            boundary = float(w0["end"])
            self.assertAlmostEqual(boundary, float(w1["start"]), delta=0.002)
            self.assertGreater(boundary, 0.40, "peak(0.24) 아님 — 오른쪽 V")
            self.assertLess(boundary, 0.52, "인공지능 onset 전")


if __name__ == "__main__":
    unittest.main()
