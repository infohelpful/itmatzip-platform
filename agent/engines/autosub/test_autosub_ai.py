"""AI proofreading: request/answer validation, key storage, and the job flow with fake Claude/ChatGPT clients."""
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


class _SettingsCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / "ai-settings.json"
        patcher = mock.patch.dict(os.environ, {"ITMATZIP_AUTOSUB_AI_SETTINGS": str(self.path)})
        patcher.start()
        self.addCleanup(patcher.stop)


@unittest.skipUnless(sys.platform == "win32", "DPAPI is Windows-only")
class SettingsTests(_SettingsCase):
    def test_keys_per_provider_are_encrypted_and_never_in_status(self):
        claude = "sk-ant-api03-" + "x" * 40 + "AbCd"
        gpt = "sk-proj-" + "y" * 40 + "WxYz"
        ai_settings.set_api_key("claude", claude)
        ai_settings.set_api_key("openai", gpt)
        raw = self.path.read_text(encoding="utf-8")
        self.assertNotIn(claude, raw)
        self.assertNotIn(gpt, raw)
        self.assertEqual(ai_settings.api_key("claude"), claude)
        self.assertEqual(ai_settings.api_key("openai"), gpt)
        status = ai_settings.status()
        self.assertEqual(status["provider"], "claude")
        self.assertEqual(status["providers"]["claude"]["keyHint"], "AbCd")
        self.assertEqual(status["providers"]["openai"]["keyHint"], "WxYz")
        self.assertNotIn(claude, json.dumps(status))
        ai_settings.delete_api_key("claude")
        self.assertIsNone(ai_settings.api_key("claude"))
        self.assertEqual(ai_settings.api_key("openai"), gpt)

    def test_old_single_key_file_is_read_as_claude(self):
        sealed = __import__("base64").b64encode(ai_settings._dpapi(b"sk-ant-old-key-1234", True)).decode()
        self.path.write_text(json.dumps({"apiKey": sealed, "apiKeyHint": "1234"}), encoding="utf-8")
        self.assertEqual(ai_settings.api_key("claude"), "sk-ant-old-key-1234")
        self.assertTrue(ai_settings.status()["providers"]["claude"]["configured"])


class ProviderSettingsTests(_SettingsCase):
    def test_provider_and_model_choice(self):
        self.assertEqual(ai_settings.model("claude"), "claude-haiku-5-5")
        self.assertEqual(ai_settings.model("openai"), "gpt-6-luna")
        ai_settings.set_model("openai", "gpt-6.1-sol")
        ai_settings.set_provider("openai")
        self.assertEqual(ai_settings.provider(), "openai")
        self.assertEqual(ai_settings.status()["providers"]["openai"]["model"], "gpt-6.1-sol")
        with self.assertRaises(ValueError):
            ai_settings.set_model("openai", "gpt-4o-mini")
        with self.assertRaises(ValueError):
            ai_settings.check_provider("gemini")

    def test_key_format_and_glossary(self):
        with self.assertRaises(ValueError):
            ai_settings.normalize_key("claude", "sk-proj-abc")
        with self.assertRaises(ValueError):
            ai_settings.normalize_key("openai", "sk-ant-abc")
        with self.assertRaises(ValueError):
            ai_settings.normalize_key("claude", "sk-ant-a b")
        self.assertEqual(ai_settings.normalize_key("openai", " sk-proj-abc "), "sk-proj-abc")
        self.assertEqual(ai_settings.normalize_glossary(["  이지 캡처 ", "이지 캡처", "", 3, "JPEG XL"]),
                         ["이지 캡처", "JPEG XL"])
        ai_settings.set_glossary(["JPEG XL"])
        self.assertEqual(ai_settings.status()["glossary"], ["JPEG XL"])


class _FakeStream:
    def __init__(self, text: str, stop_reason: str = "end_turn"):
        self.text, self.stop_reason = text, stop_reason

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


ANSWER = {"corrections": [{"id": 0, "text": "JPEG"}, {"id": 1, "text": "XL"}], "line_starts": [0],
          "uncertain": [], "emphasis": []}


class JobTests(unittest.TestCase):
    def _run(self, provider: str, client: object, model: str) -> dict:
        with mock.patch.object(ai_settings, "api_key", return_value="sk-test"), \
                mock.patch.object(ai_settings, "glossary", return_value=["JPEG XL"]), \
                mock.patch.object(ai_settings, "model", return_value=model), \
                mock.patch.object(ai_proofread, "_client", return_value=client):
            job_id = ai_proofread.start({"words": ["제이펙", "엑셀"], "lineStarts": [0], "maxUnits": 20,
                                         "provider": provider})
            return ai_proofread.status(job_id, wait_sec=5)

    def _claude(self, stream: _FakeStream, calls: dict) -> object:
        def fake_stream(**kwargs):
            calls.update(kwargs)
            return stream
        return SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=fake_stream)))

    def test_claude_haiku_default(self):
        calls: dict = {}
        out = self._run("claude", self._claude(_FakeStream(json.dumps(ANSWER)), calls), "claude-haiku-5-5")
        self.assertEqual(out["state"], "done")
        self.assertEqual(out["result"]["corrections"], ANSWER["corrections"])
        self.assertEqual(calls["model"], "claude-haiku-5-5")
        self.assertNotIn("fallbacks", calls)  # Haiku has no server-side fallback
        self.assertEqual(calls["output_config"]["format"]["type"], "json_schema")
        self.assertIn("JPEG XL", calls["messages"][0]["content"])

    def test_claude_opus_uses_fallbacks(self):
        calls: dict = {}
        self._run("claude", self._claude(_FakeStream(json.dumps(ANSWER)), calls), "claude-opus-5-5")
        self.assertEqual(calls["fallbacks"], "default")

    def test_openai_responses_call(self):
        calls: dict = {}

        def create(**kwargs):
            calls.update(kwargs)
            usage = SimpleNamespace(input_tokens=80, output_tokens=10, input_tokens_details=SimpleNamespace(cached_tokens=0))
            return SimpleNamespace(status="completed", output=[], usage=usage, output_text=json.dumps(ANSWER))

        out = self._run("openai", SimpleNamespace(responses=SimpleNamespace(create=create)), "gpt-6-luna")
        self.assertEqual(out["state"], "done")
        self.assertEqual(out["provider"], "openai")
        self.assertEqual(calls["model"], "gpt-6-luna")
        self.assertEqual(calls["text"]["format"]["type"], "json_schema")
        self.assertTrue(calls["text"]["format"]["strict"])
        self.assertIn("JPEG XL", calls["input"][0]["content"])

    def test_openai_refusal_and_incomplete(self):
        def make(status: str, part_type: str):
            def create(**kwargs):
                part = SimpleNamespace(type=part_type)
                return SimpleNamespace(status=status, output=[SimpleNamespace(content=[part])], usage=None, output_text="")
            return SimpleNamespace(responses=SimpleNamespace(create=create))
        self.assertIn("거절", self._run("openai", make("completed", "refusal"), "gpt-6-luna")["error"])
        self.assertIn("잘렸", self._run("openai", make("incomplete", "output_text"), "gpt-6-luna")["error"])

    def test_refusal_and_bad_json_are_errors(self):
        calls: dict = {}
        self.assertEqual(self._run("claude", self._claude(_FakeStream("{}", "refusal"), calls), "claude-haiku-5-5")["state"], "error")
        self.assertIn("해석", self._run("claude", self._claude(_FakeStream("not json"), calls), "claude-haiku-5-5")["error"])

    def test_no_key(self):
        with mock.patch.object(ai_settings, "api_key", return_value=None):
            with self.assertRaises(ai_proofread.ProofreadError):
                ai_proofread.start({"words": ["a"], "lineStarts": [0], "maxUnits": 20, "provider": "openai"})


if __name__ == "__main__":
    unittest.main()
