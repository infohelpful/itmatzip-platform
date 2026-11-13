"""Unit tests — Create Music AI 작곡 도우미 답 거르기, 기록에 저장하는 화면 정보."""

from __future__ import annotations

import unittest

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


if __name__ == "__main__":
    unittest.main()
