"""Unit + integration tests — Silence Remover 컷 렌더러 (docs/silence-remover-cut-editor-spec.md §8)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from fractions import Fraction
from pathlib import Path

from engines import silence_remover_render as r


def _find_ffmpeg() -> tuple[str, str] | None:
    candidates = [
        os.environ.get("ITZ_TEST_FFMPEG_DIR", ""),
        r"C:\ProgramData\itmatzip-agent\bin\gpl-shared",
        r"C:\ProgramData\itmatzip-agent\bin",
    ]
    for folder in candidates:
        if folder and (Path(folder) / "ffmpeg.exe").is_file() and (Path(folder) / "ffprobe.exe").is_file():
            return str(Path(folder) / "ffmpeg.exe"), str(Path(folder) / "ffprobe.exe")
    ff, fp = shutil.which("ffmpeg"), shutil.which("ffprobe")
    return (ff, fp) if ff and fp else None


FF = _find_ffmpeg()
SRC = r.SourceInfo(duration=10.0, origin=0.0, has_video=True, has_audio=True, width=640, height=360)


class FpsAndKeepTests(unittest.TestCase):
    def test_parse_fps_rational_and_float(self) -> None:
        self.assertEqual(r.parse_fps("30000/1001"), Fraction(30000, 1001))
        self.assertEqual(r.parse_fps(29.97), Fraction(30000, 1001))
        self.assertEqual(r.parse_fps("23.976"), Fraction(24000, 1001))
        self.assertEqual(r.parse_fps(59.94), Fraction(60000, 1001))
        self.assertEqual(r.parse_fps(30), Fraction(30))
        self.assertEqual(r.parse_fps("2997/100"), Fraction(30000, 1001))
        self.assertEqual(r.parse_fps("25/1"), Fraction(25))
        self.assertEqual(r.parse_fps("25"), Fraction(25))
        for bad in ("", "0/1", "abc", "30/0", None, "500"):
            with self.assertRaises(ValueError):
                r.parse_fps(bad)

    def test_normalize_keeps_validates_and_clamps(self) -> None:
        self.assertEqual(r.normalize_keeps([(0, 10), (20, 400)], 300), [(0, 10), (20, 300)])
        self.assertEqual(r.normalize_keeps([(0, 10), (310, 400)], 300), [(0, 10)])
        with self.assertRaises(ValueError):
            r.normalize_keeps([(10, 5)], 300)
        with self.assertRaises(ValueError):
            r.normalize_keeps([(0, 10), (5, 20)], 300)  # overlap
        with self.assertRaises(ValueError):
            r.normalize_keeps([(0, 10.5)], 300)  # not integer
        with self.assertRaises(ValueError):
            r.normalize_keeps([], 300)
        with self.assertRaises(ValueError):
            r.normalize_keeps([(400, 500)], 300)

    def test_audio_sample_plan_has_no_cumulative_drift(self) -> None:
        fps = Fraction(30000, 1001)
        keeps = [(i * 7, i * 7 + 3) for i in range(600)]  # 600 short clips (≈0.1s each)
        plan = r.audio_sample_plan(keeps, fps)
        total_samples = sum(length for _, length in plan)
        expected = round(Fraction(r.total_frames(keeps)) * r.AUDIO_RATE / fps)
        self.assertEqual(total_samples, expected)
        self.assertEqual(plan[1][0], round(Fraction(7) * r.AUDIO_RATE / fps))

    def test_available_frames(self) -> None:
        self.assertEqual(r.available_frames(10.0, Fraction(30)), 300)
        self.assertEqual(r.available_frames(10.0, Fraction(30000, 1001)), 299)


class GraphTests(unittest.TestCase):
    def test_video_filter_selects_frames_once(self) -> None:
        g = r.build_video_filter([(0, 30), (60, 90)], Fraction(30), SRC)
        self.assertIn("fps=fps=30/1:start_time=0", g)
        self.assertIn("select='if(lt(n,60),between(n,0,29),between(n,60,89))'", g)
        self.assertIn("setpts=N/(30/1)/TB,format=yuv420p[vout]", g)
        self.assertEqual(g.count("select="), 1)

    def test_select_expr_is_a_correct_binary_search(self) -> None:
        keeps = [(i * 7, i * 7 + 3) for i in range(37)]

        def evaluate(expr: str, n: int) -> int:
            py = expr.replace("if(", "_if(").replace("lt(", "_lt(").replace("between(", "_between(")
            return eval(py, {"n": n, "_if": lambda c, a, b: a if c else b, "_lt": lambda x, y: int(x < y),
                             "_between": lambda x, a, b: int(a <= x <= b)})

        expr = r.build_select_expr(keeps)
        for n in range(0, 37 * 7 + 5):
            want = int(any(a <= n < b for a, b in keeps))
            self.assertEqual(evaluate(expr, n), want, n)
        self.assertLessEqual(r.build_select_expr([(i * 3, i * 3 + 1) for i in range(5000)]).count("if(lt"), 5000)

    def test_origin_is_subtracted(self) -> None:
        src = r.SourceInfo(10.0, 1.5, True, True, 640, 360)
        self.assertIn("setpts=PTS-1.500000/TB", r.build_video_filter([(0, 30)], Fraction(30), src))

    def test_fade_ramps(self) -> None:
        from array import array
        loud = array("h", [10000, -10000] * 4).tobytes()
        faded_in = array("h")
        faded_in.frombytes(r._fade(loud, 2, True))
        self.assertEqual(list(faded_in[:2]), [2500, -2500])
        self.assertEqual(list(faded_in[-2:]), [10000, -10000])
        faded_out = array("h")
        faded_out.frombytes(r._fade(loud, 2, False))
        self.assertEqual(list(faded_out[:2]), [10000, -10000])
        self.assertEqual(list(faded_out[-2:]), [2500, -2500])

    def test_encoder_args_and_argv(self) -> None:
        self.assertEqual(r.video_encode_args("libx264", "standard"), ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"])
        with self.assertRaises(ValueError):
            r.video_encode_args("libx264", "ultra")
        argv = r.build_ffmpeg_argv("ffmpeg", Path("in.mp4"), ["-filter_complex", "x"], SRC, Fraction(30000, 1001),
                                   "h264_nvenc", "high", 5.0, Path("out.mp4"), Path("a.wav"))
        self.assertEqual(argv.count("-i"), 2)
        self.assertIn("[vout]", argv)
        self.assertEqual(argv[argv.index("[vout]") + 1 :].count("1:a:0"), 1)
        self.assertIn("30000/1001", argv)
        self.assertIn("h264_nvenc", argv)
        self.assertEqual(argv[argv.index("-t") + 1], "5.500000")
        audio_only = r.SourceInfo(10.0, 0.0, False, True, 0, 0)
        argv = r.build_ffmpeg_argv("ffmpeg", Path("in.wav"), [], audio_only, Fraction(25), None, "standard",
                                   3.0, Path("out.m4a"), Path("a.wav"))
        self.assertEqual(argv.count("-i"), 1)
        self.assertIn("0:a:0", argv)
        self.assertNotIn("[vout]", argv)

    def test_progress_percent(self) -> None:
        self.assertEqual(r.progress_percent("out_time_us=5000000", 10.0), 50)
        self.assertEqual(r.progress_percent("out_time_ms=20000000", 10.0), 99)
        self.assertIsNone(r.progress_percent("frame=1", 10.0))
        self.assertIsNone(r.progress_percent("out_time_us=-1", 10.0))


class SourceInfoTests(unittest.TestCase):
    def test_parse_skips_cover_art_and_reads_origin(self) -> None:
        data = {
            "streams": [
                {"codec_type": "video", "disposition": {"attached_pic": 1}, "width": 300, "height": 300},
                {"codec_type": "audio", "start_time": "0.023", "duration": "12.5"},
            ],
            "format": {"start_time": "0.023", "duration": "12.5"},
        }
        info = r.parse_source_info(data)
        self.assertFalse(info.has_video)
        self.assertTrue(info.has_audio)
        self.assertAlmostEqual(info.origin, 0.023)
        self.assertAlmostEqual(info.duration, 12.5)

    def test_parse_falls_back_to_format_duration(self) -> None:
        data = {"streams": [{"codec_type": "video", "start_time": "0", "width": 1920, "height": 1080}],
                "format": {"start_time": "0", "duration": "33.3"}}
        info = r.parse_source_info(data)
        self.assertAlmostEqual(info.duration, 33.3)
        self.assertEqual((info.width, info.height), (1920, 1080))


class OutputPathTests(unittest.TestCase):
    def test_numbered_and_temp_root_redirect(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "강의 영상.mp4"
            src.write_bytes(b"x")
            first = r.resolve_output_path(src, ".mp4")
            self.assertEqual(first.name, "강의 영상_cut.mp4")
            first.write_bytes(b"x")
            self.assertEqual(r.resolve_output_path(src, ".mp4").name, "강의 영상_cut (2).mp4")
            redirected = r.resolve_output_path(src, ".mp4", temp_root=Path(tmp))
            self.assertNotEqual(redirected.parent, Path(tmp))


@unittest.skipUnless(FF, "ffmpeg/ffprobe not found")
class RenderIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        ffmpeg = FF[0]
        cls.cfr = cls.dir / "cfr.mp4"
        subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30000/1001",
                        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "12",
                        "-c:v", "libx264", "-preset", "ultrafast", "-g", "250", "-c:a", "aac", "-shortest",
                        str(cls.cfr)], check=True)
        # VFR: 프레임을 불규칙하게 버린 영상
        cls.vfr = cls.dir / "vfr.mkv"
        subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
                        "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000", "-t", "12",
                        "-vf", "select='not(eq(mod(n\\,7)\\,3))*not(eq(mod(n\\,11)\\,5))'", "-fps_mode", "vfr",
                        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(cls.vfr)],
                       check=True)
        cls.audio = cls.dir / "voice.wav"
        subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100",
                        "-t", "6", str(cls.audio)], check=True)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def _frames(self, path: Path) -> int:
        out = subprocess.run([FF[1], "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                              "stream=nb_read_frames", "-of", "json", str(path)], capture_output=True, check=True)
        return int(json.loads(out.stdout)["streams"][0]["nb_read_frames"])

    def _render(self, src: Path, fps: str, keeps: list[tuple[int, int]], name: str) -> r.RenderJob:
        out = self.dir / name
        job = r.start_render(ffmpeg=FF[0], ffprobe=FF[1], source_path=src, fps_value=fps, keeps=keeps,
                             quality="fast", output_path=out, wait=True)
        self.assertEqual(job.state, "done", job.error)
        self.assertTrue(out.is_file())
        self.assertTrue(r.was_exported(str(out)))
        return job

    def _stream_durations(self, path: Path) -> dict[str, float]:
        out = subprocess.run([FF[1], "-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json",
                              str(path)], capture_output=True, check=True)
        return {s["codec_type"]: float(s["duration"]) for s in json.loads(out.stdout)["streams"]}

    def test_cfr_many_cuts_exact_frames(self) -> None:
        keeps = [(i * 9, i * 9 + 5) for i in range(38)]  # 38 clips, 190 frames
        job = self._render(self.cfr, "30000/1001", keeps, "cfr_out.mp4")
        info = r.probe_source(FF[1], job.output)
        self.assertTrue(info.has_audio)
        self.assertEqual(self._frames(job.output), 190)
        self.assertAlmostEqual(info.duration, 190 * 1001 / 30000, delta=0.06)
        durations = self._stream_durations(job.output)
        # 오디오와 영상 길이가 1프레임 안에서 같아야 한다 (AAC 프라이밍 여유 포함).
        self.assertAlmostEqual(durations["audio"], durations["video"], delta=0.05)

    def test_hundreds_of_cuts(self) -> None:
        keeps = [(i * 3, i * 3 + 2) for i in range(115)]  # 115 clips of 2 frames out of ~12s
        job = self._render(self.cfr, "30000/1001", keeps, "many_out.mp4")
        self.assertEqual(self._frames(job.output), 230)
        durations = self._stream_durations(job.output)
        self.assertAlmostEqual(durations["audio"], durations["video"], delta=0.05)

    def test_vfr_source_normalized_to_cfr(self) -> None:
        keeps = [(0, 60), (90, 150), (200, 330)]  # 250 frames at 30fps
        job = self._render(self.vfr, "30", keeps, "vfr_out.mp4")
        self.assertEqual(self._frames(job.output), 250)
        self.assertAlmostEqual(r.probe_source(FF[1], job.output).duration, 250 / 30, delta=0.06)

    def test_audio_only_to_m4a(self) -> None:
        job = self._render(self.audio, "25", [(0, 25), (50, 100)], "voice_out.m4a")
        info = r.probe_source(FF[1], job.output)
        self.assertFalse(info.has_video)
        self.assertAlmostEqual(info.duration, 3.0, delta=0.06)

    def test_cancel(self) -> None:
        out = self.dir / "cancel.mp4"
        job = r.start_render(ffmpeg=FF[0], ffprobe=FF[1], source_path=self.cfr, fps_value="30000/1001",
                             keeps=[(0, 350)], quality="high", output_path=out)
        r.cancel_job(job.id)
        deadline = time.monotonic() + 30
        while job.state == "running" and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertIn(job.state, ("canceled", "done"))
        if job.state == "canceled":
            self.assertFalse(out.exists())
        self.assertEqual(list(self.dir.glob("*.partial*")), [])

    def test_rejects_concurrent_job(self) -> None:
        job = r.start_render(ffmpeg=FF[0], ffprobe=FF[1], source_path=self.cfr, fps_value="30000/1001",
                             keeps=[(0, 350)], quality="high", output_path=self.dir / "busy.mp4")
        try:
            if job.state == "running":
                with self.assertRaises(RuntimeError):
                    r.start_render(ffmpeg=FF[0], ffprobe=FF[1], source_path=self.cfr, fps_value="30000/1001",
                                   keeps=[(0, 10)], output_path=self.dir / "busy2.mp4")
        finally:
            r.cancel_job(job.id)
            deadline = time.monotonic() + 30
            while job.state == "running" and time.monotonic() < deadline:
                time.sleep(0.05)


if __name__ == "__main__":
    unittest.main()
