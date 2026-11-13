"""Unit tests — Create Music AI 작곡 도우미 답 거르기, 기록에 저장하는 화면 정보."""

from __future__ import annotations

import unittest
from pathlib import Path

from engines import create_music_ai as ai
from engines.create_music import sanitize_display


class ParsePatchTests(unittest.TestCase):
    def test_keeps_only_allowed_values(self) -> None:
        patch = ai.parse_patch(
            {
                "vocal": "female",
                "genres": ["genre.citypop", "genre.nope", "genre.citypop", 3],
                "instruments": ["inst.synth"],
                "vocal_styles": ["vstyle.soft"],
                "mood": "  비 오는 밤  ",
                "tempo": "fast",
                "lyrics": "[Verse]\n밤하늘\n",
                "vocal_language": "ko",
                "duration": 180,
                "quality": "quality",
                "reply": "세팅했어요",
                "unknown": 1,
            }
        )
        self.assertEqual(
            patch,
            {
                "vocal": "female",
                "genres": ["genre.citypop"],
                "instruments": ["inst.synth"],
                "vocal_styles": ["vstyle.soft"],
                "mood": "비 오는 밤",
                "tempo": "fast",
                "lyrics": "[Verse]\n밤하늘",
                "vocal_language": "ko",
                "duration": 180,
                "quality": "quality",
            },
        )

    def test_rejects_bad_values(self) -> None:
        patch = ai.parse_patch({"vocal": "robot", "tempo": "warp", "duration": 999, "quality": "ultra", "genres": "pop"})
        self.assertEqual(patch, {})

    def test_duration_respects_gpu_limit(self) -> None:
        self.assertEqual(ai.parse_patch({"duration": 300}, max_duration=240), {})
        self.assertEqual(ai.parse_patch({"duration": -1}, max_duration=240), {"duration": -1})

    def test_instrumental_drops_lyrics_and_vocal_styles(self) -> None:
        patch = ai.parse_patch({"vocal": "none", "lyrics": "[Verse]\n가사", "vocal_styles": ["vstyle.soft"]})
        self.assertEqual(patch, {"vocal": "none"})

    def test_reply_only_answer_gives_empty_patch(self) -> None:
        self.assertEqual(ai.parse_patch({"reply": "음악 관련 요청만 도와드려요"}), {})

    def test_parse_json_accepts_fenced_and_wrapped(self) -> None:
        self.assertEqual(ai._parse_json('```json\n{"tempo": "slow"}\n```'), {"tempo": "slow"})
        self.assertEqual(ai._parse_json('네, 여기요: {"tempo": "slow"} 끝'), {"tempo": "slow"})
        with self.assertRaises(ValueError):
            ai._parse_json("JSON 없음")

    def test_start_validates_input(self) -> None:
        with self.assertRaises(ValueError):
            ai.start("gpt", "가사 써줘", {}, [])
        with self.assertRaises(ValueError):
            ai.start("claude", "   ", {}, [])

    def test_clean_form_and_history(self) -> None:
        form = ai._clean_form({"vocal": "male", "lyrics": "x" * 9000, "genres": ["a"] * 50, "duration": 120, "evil": {"a": 1}})
        self.assertEqual(form["vocal"], "male")
        self.assertEqual(len(form["lyrics"]), 4000)
        self.assertEqual(len(form["genres"]), 30)
        self.assertNotIn("evil", form)
        history = ai._clean_history([{"role": "system", "text": "x"}] + [{"role": "user", "text": str(i)} for i in range(10)])
        self.assertEqual([h["text"] for h in history], ["4", "5", "6", "7", "8", "9"])


class SanitizeDisplayTests(unittest.TestCase):
    def test_keeps_known_keys_with_limits(self) -> None:
        out = sanitize_display(
            {
                "title": "시티팝 · 밤",
                "vocal": "female",
                "genres": ["genre.citypop", {"bad": 1}],
                "lyrics": "가" * 5000,
                "duration_choice": -1,
                "script": "<b>",
                "quality": True,
            }
        )
        self.assertEqual(out["title"], "시티팝 · 밤")
        self.assertEqual(out["genres"], ["genre.citypop"])
        self.assertEqual(len(out["lyrics"]), 4000)
        self.assertEqual(out["duration_choice"], "-1")
        self.assertNotIn("script", out)
        self.assertNotIn("quality", out)

    def test_non_dict_is_empty(self) -> None:
        self.assertEqual(sanitize_display(None), {})
        self.assertEqual(sanitize_display(["x"]), {})


class DeleteHistoryTests(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile
        from unittest import mock

        from engines import create_music

        self.cm = create_music
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "history"
        self.root.mkdir()
        patcher = mock.patch.object(create_music, "history_root", lambda: self.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(lambda: setattr(create_music, "_current_job", None))

    def _make(self, name: str) -> Path:
        d = self.root / name
        d.mkdir()
        (d / "a.wav").write_bytes(b"w")
        (d / "a.mp3").write_bytes(b"m")
        (d / "meta.json").write_text("{}", encoding="utf-8")
        return d

    def test_deletes_whole_song_folder_only(self) -> None:
        keep, gone = self._make("keep1"), self._make("gone1")
        self.assertTrue(self.cm.delete_history("gone1"))
        self.assertFalse(gone.exists())
        self.assertTrue((keep / "a.wav").is_file())

    def test_missing_returns_false(self) -> None:
        self.assertFalse(self.cm.delete_history("nothere"))

    def test_rejects_path_tricks(self) -> None:
        outside = Path(self.tmp.name) / "outside"
        outside.mkdir()
        for bad in ("..", "../outside", "a/b", "a\b", "", "x" * 80, ".", "..%2f"):
            with self.assertRaises(ValueError):
                self.cm.delete_history(bad)
        self.assertTrue(outside.is_dir())

    def test_refuses_running_job(self) -> None:
        self._make("busy1")
        self.cm._current_job = self.cm.GenerationJob(id="busy1", status="running")
        with self.assertRaises(RuntimeError):
            self.cm.delete_history("busy1")
        self.assertTrue((self.root / "busy1").is_dir())


class SanitizeLyricsTests(unittest.TestCase):
    def test_keeps_tags_and_removes_symbols(self) -> None:
        from engines.create_music import sanitize_lyrics

        raw = "[Verse 1]\n밤하늘 아래서~ (Yeah)\n우리 둘이... 걷던 길?!\n\n\n\n[Chorus]\n  사랑해   너를 *  "
        self.assertEqual(
            sanitize_lyrics(raw),
            "[Verse 1]\n밤하늘 아래서\n우리 둘이 걷던 길\n\n[Chorus]\n사랑해 너를",
        )

    def test_keeps_plain_text_and_commas(self) -> None:
        from engines.create_music import sanitize_lyrics

        self.assertEqual(sanitize_lyrics("[Verse]\n그날, 그 거리에서"), "[Verse]\n그날, 그 거리에서")
        self.assertEqual(sanitize_lyrics(""), "")
        self.assertEqual(sanitize_lyrics(None), "")  # type: ignore[arg-type]

    def test_drops_lines_that_become_empty(self) -> None:
        from engines.create_music import sanitize_lyrics

        self.assertEqual(sanitize_lyrics("[Verse]\n(Yeah)\n~~~\n가사"), "[Verse]\n가사")

    def test_ai_patch_lyrics_are_cleaned(self) -> None:
        patch = ai.parse_patch({"vocal": "female", "lyrics": "[Verse]\n안녕~ (hey)\n잘 가요..."})
        self.assertEqual(patch["lyrics"], "[Verse]\n안녕\n잘 가요")


if __name__ == "__main__":
    unittest.main()
