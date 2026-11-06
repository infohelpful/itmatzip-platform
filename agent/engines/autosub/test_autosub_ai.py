"""AI proofreading: request/answer validation, key storage, and the job flow with a fake Claude client."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engines.autosub import ai_proofread, ai_settings  # noqa: E402


def _req(words: list[str], starts: list[int], emphasize: bool = False) -> ai_proofread.ProofreadRequest:
    return ai_proofread.parse_request({"words": words, "lineStarts": starts, "maxUnits": 20, "emphasize": emphasize})


class RequestTests(unittest.TestCase):
    def test_line_starts_are_cleaned(self):
        req = _req(["a", "b", "c"], [2, 2, 9, -1])
        self.assertEqual(req.line_starts, [0, 2])

    def test_rejects_bad_input(self):
        for body in ({"words": [], "lineStarts": [0], "maxUnits": 20},
                     {"words": ["a", " "], "lineStarts": [0], "maxUnits": 20},
                     {"words": ["a"], "lineStarts": [0], "maxUnits": 2},
                     {"words": ["a"], "lineStarts": ["0"], "maxUnits": 20}):
            with self.assertRaises(ValueError):
                ai_proofread.parse_request(body)

    def test_pauses_are_cleaned_and_sent(self):
        req = ai_proofread.parse_request({"words": ["a", "b", "c"], "lineStarts": [0], "maxUnits": 20,
                                          "pauses": [{"id": 2, "sec": 12.34}, {"id": 0, "sec": 3}, {"id": 1, "sec": -1}, "x"]})
        self.assertEqual(req.pauses, [{"before_id": 2, "sec": 12.3}])
        self.assertEqual(json.loads(ai_proofread.build_user_message(req, []))["pauses"], [{"before_id": 2, "sec": 12.3}])

    def test_user_message_carries_ids_and_glossary(self):
        msg = json.loads(ai_proofread.build_user_message(_req(["가", "나"], [0]), ["이지캡처"]))
        self.assertEqual(msg["words"], [{"id": 0, "text": "가"}, {"id": 1, "text": "나"}])
        self.assertEqual(msg["glossary"], ["이지캡처"])


class AnswerTests(unittest.TestCase):
    def test_keeps_valid_items_and_drops_the_rest(self):
        req = _req(["크롬", "1", ".05", "버전"], [0], emphasize=True)
        out = ai_proofread.validate_answer({
            "corrections": [{"id": 1, "text": "1.05"}, {"id": 2, "text": ""}, {"id": 0, "text": "크롬"},
                            {"id": 9, "text": "x"}, {"id": True, "text": "x"}],
            "line_starts": [0, 2, 2, 99],
            "uncertain": [{"id": 3, "reason": " 숫자 확인 "}, {"id": -1, "reason": "x"}],
            "emphasis": [3, 3, 7],
        }, req)
        self.assertEqual(out["corrections"], [{"id": 1, "text": "1.05"}, {"id": 2, "text": ""}])
        self.assertEqual(out["lineStarts"], [0, 2])
        self.assertEqual(out["uncertain"], [{"id": 3, "reason": "숫자 확인"}])
        self.assertEqual(out["emphasis"], [3])

    def test_never_blanks_a_whole_line(self):
        req = _req(["a", "b", "c"], [0, 2])
        out = ai_proofread.validate_answer({"corrections": [{"id": 2, "text": ""}, {"id": 0, "text": "A"}],
                                            "line_starts": [0, 2], "uncertain": [], "emphasis": [1]}, req)
        self.assertEqual(out["corrections"], [{"id": 0, "text": "A"}])
        self.assertEqual(out["emphasis"], [])  # emphasize was off

    def test_unusable_line_starts_keep_current(self):
        req = _req(["a", "b", "c"], [0, 2])
        out = ai_proofread.validate_answer({"corrections": [], "line_starts": [], "uncertain": [], "emphasis": []}, req)
        self.assertEqual(out["lineStarts"], [0, 2])


@unittest.skipUnless(sys.platform == "win32", "DPAPI is Windows-only")
class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / "ai-settings.json"
        patcher = mock.patch.dict(os.environ, {"ITMATZIP_AUTOSUB_AI_SETTINGS": str(self.path)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_key_round_trip_is_encrypted_and_never_in_status(self):
        key = "sk-ant-api03-" + "x" * 40 + "AbCd"
        ai_settings.set_api_key(key)
        self.assertNotIn(key, self.path.read_text(encoding="utf-8"))
        self.assertEqual(ai_settings.api_key(), key)
        status = ai_settings.status()
        self.assertEqual(status, {"configured": True, "keyHint": "AbCd", "glossary": []})
        self.assertNotIn(key, json.dumps(status))
        ai_settings.delete_api_key()
        self.assertIsNone(ai_settings.api_key())
        self.assertFalse(ai_settings.status()["configured"])

    def test_key_format_and_glossary(self):
        with self.assertRaises(ValueError):
            ai_settings.normalize_key("sk-proj-abc")
        with self.assertRaises(ValueError):
            ai_settings.normalize_key("sk-ant-a b")
        self.assertEqual(ai_settings.normalize_glossary(["  이지 캡처 ", "이지 캡처", "", 3, "JPEG XL"]),
                         ["이지 캡처", "JPEG XL"])
        ai_settings.set_glossary(["JPEG XL"])
        self.assertEqual(ai_settings.status()["glossary"], ["JPEG XL"])


class _FakeStream:
    def __init__(self, text: str, stop_reason: str = "end_turn"):
        self.text, self.stop_reason = text, stop_reason
        self.kwargs: dict = {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __iter__(self):
        yield SimpleNamespace(type="text", text=self.text)

    def get_final_message(self):
        usage = SimpleNamespace(input_tokens=100, output_tokens=20, cache_read_input_tokens=0)
        return SimpleNamespace(stop_reason=self.stop_reason, usage=usage,
                               content=[SimpleNamespace(type="text", text=self.text)])


class JobTests(unittest.TestCase):
    def _run(self, stream: _FakeStream) -> dict:
        calls = {}

        def fake_stream(**kwargs):
            calls.update(kwargs)
            return stream

        client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=fake_stream)))
        with mock.patch.object(ai_settings, "api_key", return_value="sk-ant-test"), \
                mock.patch.object(ai_settings, "glossary", return_value=["JPEG XL"]), \
                mock.patch.object(ai_proofread, "_client", return_value=client):
            job_id = ai_proofread.start({"words": ["제이펙", "엑셀"], "lineStarts": [0], "maxUnits": 20})
            result = ai_proofread.status(job_id, wait_sec=5)
        result["_calls"] = calls
        return result

    def test_done_with_validated_result(self):
        answer = {"corrections": [{"id": 0, "text": "JPEG"}, {"id": 1, "text": "XL"}], "line_starts": [0],
                  "uncertain": [], "emphasis": []}
        out = self._run(_FakeStream(json.dumps(answer)))
        self.assertEqual(out["state"], "done")
        self.assertEqual(out["result"]["corrections"], [{"id": 0, "text": "JPEG"}, {"id": 1, "text": "XL"}])
        calls = out["_calls"]
        self.assertEqual(calls["model"], "claude-opus-5-5")
        self.assertEqual(calls["fallbacks"], "default")
        self.assertEqual(calls["output_config"]["format"]["type"], "json_schema")
        self.assertIn("JPEG XL", calls["messages"][0]["content"])

    def test_refusal_and_bad_json_are_errors(self):
        self.assertEqual(self._run(_FakeStream("{}", stop_reason="refusal"))["state"], "error")
        self.assertIn("해석", self._run(_FakeStream("not json"))["error"])

    def test_no_key(self):
        with mock.patch.object(ai_settings, "api_key", return_value=None):
            with self.assertRaises(ai_proofread.ProofreadError):
                ai_proofread.start({"words": ["a"], "lineStarts": [0], "maxUnits": 20})


if __name__ == "__main__":
    unittest.main()
