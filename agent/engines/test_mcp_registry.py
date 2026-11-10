"""Several AutoSubtitle tabs heartbeat at once; the AI chat must still edit the tab it was started from."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engines import mcp_registry  # noqa: E402


def _snapshot(text: str) -> dict:
    return {"words": [{"index": 0, "id": "w0", "text": text}], "lineStarts": [0]}


class FocusTests(unittest.TestCase):
    def setUp(self) -> None:
        mcp_registry._EDITORS.clear()
        mcp_registry._focus = None

    tearDown = setUp

    def test_chat_tab_stays_active_when_another_tab_heartbeats_later(self) -> None:
        mcp_registry.publish_editor("chat-tab", "a", _snapshot("chat"))
        mcp_registry.publish_editor("other-tab", "b", _snapshot("other"))
        # Before the fix the chat was rejected because "other-tab" was updated last.
        self.assertEqual(mcp_registry.focus_editor("chat-tab")["sessionId"], "chat-tab")
        mcp_registry.heartbeat_editor("other-tab")
        self.assertEqual(mcp_registry.active_editor()["sessionId"], "chat-tab")

    def test_stage_edit_targets_the_requested_tab(self) -> None:
        mcp_registry.publish_editor("chat-tab", "a", _snapshot("chat"))
        revision = mcp_registry.focus_editor("chat-tab")["revision"]
        mcp_registry.publish_editor("other-tab", "b", _snapshot("other"))
        mcp_registry.heartbeat_editor("other-tab")
        staged = mcp_registry.stage_edit(revision, {"corrections": []}, expected_session_id="chat-tab")
        self.assertEqual(staged["sessionId"], "chat-tab")
        self.assertIsNotNone(mcp_registry.pending_edit("chat-tab"))
        self.assertIsNone(mcp_registry.pending_edit("other-tab"))

    def test_unknown_or_expired_tab_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            mcp_registry.focus_editor("missing")
        mcp_registry.publish_editor("old-tab", "a", _snapshot("x"))
        mcp_registry._EDITORS["old-tab"]["updated"] -= mcp_registry._TTL_SECONDS + 1
        with self.assertRaises(ValueError):
            mcp_registry.focus_editor("old-tab")
        with self.assertRaises(ValueError):
            mcp_registry.stage_edit(1, {}, expected_session_id="old-tab")

    def test_without_focus_most_recent_tab_is_active(self) -> None:
        mcp_registry.publish_editor("first", "a", _snapshot("1"))
        mcp_registry.publish_editor("second", "b", _snapshot("2"))
        # time.monotonic() is ~15 ms coarse on Windows; make the order explicit.
        mcp_registry._EDITORS["first"]["updated"] -= 5
        self.assertEqual(mcp_registry.active_editor()["sessionId"], "second")


if __name__ == "__main__":
    unittest.main()
