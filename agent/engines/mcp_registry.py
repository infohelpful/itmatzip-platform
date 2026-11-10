"""Tracks active local MCP stdio client sessions for web UI feature gating."""
from __future__ import annotations

import threading
import time
import uuid
from typing import Any

_lock = threading.Lock()
_sessions: dict[str, float] = {}
_TTL_SECONDS = 35
_EDITORS: dict[str, dict[str, Any]] = {}
# The editor tab that last started an AI chat. Several AutoSubtitle tabs can be open at once and each
# heartbeats every 10 s, so "most recently updated" alone flips between tabs; the focused one wins.
_focus: str | None = None


def heartbeat(session_id: str) -> None:
    with _lock:
        _sessions[session_id] = time.monotonic()


def disconnect(session_id: str) -> None:
    with _lock:
        _sessions.pop(session_id, None)


def status() -> dict[str, int | bool]:
    now = time.monotonic()
    with _lock:
        stale = [key for key, seen in _sessions.items() if now - seen > _TTL_SECONDS]
        for key in stale:
            _sessions.pop(key, None)
        return {"connected": bool(_sessions), "activeClients": len(_sessions)}


def publish_editor(session_id: str, basis: str, snapshot: dict[str, Any]) -> dict[str, Any]:
    now = time.monotonic()
    with _lock:
        editor = _EDITORS.get(session_id)
        revision = (editor["revision"] if editor and editor["basis"] == basis else
                    (editor["revision"] + 1 if editor else 1))
        pending = editor.get("pending") if editor else None
        _EDITORS[session_id] = {
            "basis": basis, "snapshot": snapshot, "revision": revision,
            "updated": now, "pending": pending,
            "lastEditId": editor.get("lastEditId") if editor else None,
        }
        stale = [key for key, value in _EDITORS.items() if now - value["updated"] > _TTL_SECONDS]
        for key in stale:
            _EDITORS.pop(key, None)
        return {"sessionId": session_id, "revision": revision}


def heartbeat_editor(session_id: str) -> bool:
    with _lock:
        editor = _EDITORS.get(session_id)
        if not editor:
            return False
        editor["updated"] = time.monotonic()
        return True


def _pick_active(now: float) -> tuple[str, dict[str, Any]] | None:
    """Caller holds `_lock`. The focused editor if it is still alive, else the most recently updated one."""
    active = [(key, value) for key, value in _EDITORS.items() if now - value["updated"] <= _TTL_SECONDS]
    if not active:
        return None
    for key, value in active:
        if key == _focus:
            return key, value
    return max(active, key=lambda item: item[1]["updated"])


def _editor_view(session_id: str, editor: dict[str, Any]) -> dict[str, Any]:
    return {"sessionId": session_id, "revision": editor["revision"],
            "snapshot": editor["snapshot"], "basis": editor["basis"]}


def active_editor() -> dict[str, Any]:
    with _lock:
        picked = _pick_active(time.monotonic())
        if not picked:
            raise ValueError("AutoSubtitle 편집 페이지가 열려 있지 않거나 자막이 준비되지 않았습니다.")
        return _editor_view(*picked)


def focus_editor(session_id: str) -> dict[str, Any]:
    """Makes this tab the active editor (an AI chat started from it) and returns its snapshot."""
    global _focus
    now = time.monotonic()
    with _lock:
        editor = _EDITORS.get(session_id)
        if not editor or now - editor["updated"] > _TTL_SECONDS:
            raise ValueError("현재 편집 화면의 자막을 에이전트에 보내지 못했습니다. 잠시 뒤 다시 시도하고, 계속되면 페이지를 새로고침해 주세요.")
        editor["updated"] = now
        _focus = session_id
        return _editor_view(session_id, editor)


def stage_edit(revision: int, answer: dict[str, Any], expected_session_id: str | None = None) -> dict[str, Any]:
    now = time.monotonic()
    with _lock:
        if expected_session_id is not None:
            # The chat job edits the tab it was started from, whichever tab heartbeated last.
            target = _EDITORS.get(expected_session_id)
            if not target or now - target["updated"] > _TTL_SECONDS:
                raise ValueError("요청한 자막 편집 화면이 닫혔거나 연결이 끊겼습니다. 페이지를 새로고침한 뒤 다시 요청해 주세요.")
            picked: tuple[str, dict[str, Any]] | None = (expected_session_id, target)
        else:
            picked = _pick_active(now)
        if not picked:
            raise ValueError("연결된 AutoSubtitle 편집 페이지가 없습니다.")
        session_id, editor = picked
        if editor["revision"] != revision:
            raise ValueError("자막이 MCP로 전달된 뒤 변경됐습니다. 최신 자막을 다시 가져와 수정해 주세요.")
        if editor.get("pending"):
            raise ValueError("이전 수정안이 아직 페이지에서 처리 중입니다. 잠시 기다려 주세요.")
        edit_id = str(uuid.uuid4())
        editor["pending"] = {"editId": edit_id, "revision": revision, "answer": answer}
        editor["lastEditId"] = edit_id
        return {"sessionId": session_id, "editId": edit_id, "revision": revision}


def latest_edit_id(session_id: str) -> str | None:
    with _lock:
        editor = _EDITORS.get(session_id)
        return editor.get("lastEditId") if editor else None


def active_editor_audio() -> dict[str, Any]:
    active = active_editor()
    snapshot = active["snapshot"]
    audio_path = snapshot.get("audioPath")
    if not isinstance(audio_path, str) or not audio_path:
        raise ValueError("현재 영상의 준비된 오디오가 없습니다. AutoSubtitle에서 미디어 준비가 끝난 뒤 다시 요청해 주세요.")
    return {"sessionId": active["sessionId"], "revision": active["revision"],
            "audioPath": audio_path, "duration": snapshot.get("duration")}


def pending_edit(session_id: str) -> dict[str, Any] | None:
    now = time.monotonic()
    with _lock:
        editor = _EDITORS.get(session_id)
        if not editor or now - editor["updated"] > _TTL_SECONDS:
            return None
        return editor.get("pending")


def acknowledge_edit(session_id: str, edit_id: str) -> bool:
    with _lock:
        editor = _EDITORS.get(session_id)
        if not editor or not editor.get("pending") or editor["pending"].get("editId") != edit_id:
            return False
        editor["pending"] = None
        return True
