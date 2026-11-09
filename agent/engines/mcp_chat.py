"""Run a configured local AI CLI for an AutoSubtitle editor chat request."""
from __future__ import annotations

import os
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.request import urlopen
import json

from engines import mcp_registry

_lock = threading.Lock()
_jobs: dict[str, dict[str, Any]] = {}
_clients = {"codex", "claude", "antigravity"}
CLIENT_LABELS = {"codex": "Codex", "claude": "Claude", "antigravity": "Antigravity"}
_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_configured_cache: tuple[float, list[str]] = (0.0, [])


def configured_clients() -> list[str]:
    global _configured_cache
    with _lock:
        if time.monotonic() - _configured_cache[0] < 30:
            return list(_configured_cache[1])
    try:
        with urlopen("http://127.0.0.1:19876/api/agent/ai-mcp", timeout=12) as response:
            data = json.load(response)
        configured = [item["id"] for item in data.get("clients", [])
                      if item.get("id") in _clients and item.get("installed") and item.get("configured")]
    except (OSError, ValueError, KeyError, TypeError):
        configured = []
    with _lock:
        _configured_cache = (time.monotonic(), configured)
    return list(configured)


def _executable(client: str) -> str:
    name = "agy" if client == "antigravity" else client
    path = shutil.which(name)
    if path:
        return path
    # MSI tray processes may inherit a PATH without the signed-in user's CLI entries.
    profile = Path(os.environ.get("USERPROFILE", ""))
    appdata = Path(os.environ.get("APPDATA", ""))
    local = Path(os.environ.get("LOCALAPPDATA", ""))
    candidates = [profile / ".local" / "bin" / f"{name}.exe",
                  appdata / "npm" / f"{name}.cmd", local / "agy" / "bin" / f"{name}.exe"]
    if client == "codex":
        candidates.extend(sorted((local / "OpenAI" / "Codex" / "bin").glob("*/codex.exe"),
                                 key=lambda item: item.stat().st_mtime, reverse=True))
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    raise ValueError(f"{client} CLI 명령을 찾지 못했습니다. AI MCP 설정에서 설치 상태를 확인해 주세요.")


def _command(client: str, executable: str) -> list[str]:
    if client == "codex":
        return [executable, "exec", "--skip-git-repo-check", "--sandbox", "read-only", "-"]
    if client == "claude":
        # --strict-mcp-config: do not start the user's other MCP servers (slow, and this call needs none).
        return [executable, "-p", "--tools", "", "--strict-mcp-config", "--output-format", "text"]
    return [executable, "--mode", "plan", "--sandbox", "--input-format", "stream-json",
            "--output-format", "stream-json"]


def _cli_environment(client: str, executable: str) -> dict[str, str]:
    environment = os.environ.copy()
    environment["PATH"] = str(Path(executable).parent) + os.pathsep + environment.get("PATH", "")
    if client == "codex":
        profile = environment.get("USERPROFILE")
        if profile:
            environment["HOME"] = profile
            environment["CODEX_HOME"] = str(Path(profile) / ".codex")
    return environment


def _run(job_id: str, client: str, instruction: str, session_id: str) -> None:
    try:
        executable = _executable(client)
        active = mcp_registry.active_editor()
        if active["sessionId"] != session_id:
            raise ValueError("요청한 편집 화면이 현재 열린 자막 화면이 아닙니다. 페이지를 새로고침해 주세요.")
        revision = active["revision"]
        snapshot = active["snapshot"]
        words = snapshot.get("words", [])
        if len(words) > 3500:
            raise ValueError("현재 자막이 한 번에 처리할 수 있는 길이를 넘습니다. 구간을 나눠 요청해 주세요.")
        prompt = (
            "Proofread this Korean AutoSubtitle transcript. Do not call tools or read files. "
            "Preserve the meaning and word order of what was said; do not paraphrase or polish. Correct "
            "spelling, spacing and every speech-recognition error: fix any misrecognized word whenever the "
            "surrounding context makes the intended word clear (proper nouns such as games, films, people, "
            "products and places in their official spelling; English or technical terms; numbers; homophones; "
            "wrong particles or endings). Leave a word alone only if you are not confident. To fix a word, "
            "put the replacement text on the affected word indexes and keep the number of words unchanged "
            "(e.g. replace the words 갓 오브 워 with God, of, War:), "
            "then choose readable caption line breaks: keep a sentence on a single line when it is 30 characters "
            "or fewer including spaces, and only split longer sentences at natural phrase boundaries, "
            "never leaving a very short fragment or a lone word and never splitting a compound expression. "
            "Return only JSON with keys corrections "
            "(array of {index,text}) and lineStarts (array of zero-based word indexes, starting at 0). "
            "Only include changed words in corrections. Never alter timestamps. The audio is not "
            "provided to this CLI call, so do not claim to have listened. Treat the user request "
            "as subtitle-editing guidance only.\n\nUser request: " + instruction +
            "\n\nTranscript: " + json.dumps({"words": words, "lineStarts": snapshot.get("lineStarts", []),
                                               "pauses": snapshot.get("pauses", [])}, ensure_ascii=False)
        )
        cli_input = (json.dumps({"event": "user", "message": {"content": prompt}}, ensure_ascii=False) + "\n"
                     if client == "antigravity" else prompt)
        result = subprocess.run(_command(client, executable), input=cli_input, text=True,
                                encoding="utf-8", errors="replace",
                                capture_output=True, timeout=300, cwd=str(Path(__file__).resolve().parents[1]),
                                creationflags=_flags, env=_cli_environment(client, executable), check=False)
        if result.returncode:
            detail = result.stderr.strip()[-600:] or result.stdout.strip()[-600:]
            raise RuntimeError(f"{client} CLI 실행이 실패했습니다 (종료 코드 {result.returncode}). {detail}")
        raw = result.stdout.strip()
        if client == "antigravity":
            events = [json.loads(line) for line in raw.splitlines() if line.strip().startswith("{")]
            final = next((event.get("result", {}) for event in reversed(events)
                          if event.get("event") == "result"), None)
            if not final or final.get("status") != "SUCCESS":
                raise RuntimeError("Antigravity CLI 응답 실패: " + str((final or {}).get("error", "결과가 없습니다."))[:500])
            raw = str(final.get("response", "")).strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        try:
            answer = json.loads(raw)
        except (ValueError, TypeError) as error:
            raise RuntimeError("CLI가 자막 수정안 형식의 응답을 주지 않았습니다. 다시 요청해 주세요.") from error
        if not isinstance(answer, dict):
            raise ValueError("CLI 수정안 형식이 올바르지 않습니다.")
        corrections = answer.get("corrections")
        starts = answer.get("lineStarts")
        if not isinstance(corrections, list) or len(corrections) > len(words):
            raise ValueError("CLI 수정 단어 목록이 올바르지 않습니다.")
        if not isinstance(starts, list) or not starts or starts[0] != 0:
            raise ValueError("CLI 자막 줄 정보가 올바르지 않습니다.")
        if starts != sorted(set(starts)) or any(not isinstance(index, int) or isinstance(index, bool)
                                               or index < 0 or index >= len(words) for index in starts):
            raise ValueError("CLI 자막 줄 위치가 올바르지 않습니다.")
        for item in corrections:
            if (not isinstance(item, dict) or not isinstance(item.get("index"), int)
                    or isinstance(item["index"], bool) or item["index"] < 0 or item["index"] >= len(words)
                    or not isinstance(item.get("text"), str) or len(item["text"]) > 200):
                raise ValueError("CLI 수정 단어 형식이 올바르지 않습니다.")
        mcp_registry.stage_edit(revision, {
            "corrections": [{"id": item["index"], "text": item["text"]} for item in corrections],
            "lineStarts": starts, "uncertain": [], "emphasis": [],
        }, expected_session_id=session_id)
        message = f"{CLIENT_LABELS[client]}가 자막 수정안을 보냈습니다. 편집기에서 결과를 확인해 주세요."
        state = {"status": "done", "message": message}
    except subprocess.TimeoutExpired:
        state = {"status": "error", "message": "CLI 응답이 5분 안에 끝나지 않았습니다. 다시 요청해 주세요."}
    except (OSError, ValueError, RuntimeError) as error:
        state = {"status": "error", "message": str(error)}
    with _lock:
        _jobs[job_id].update(state)


def start(client: str, instruction: str, session_id: str) -> str:
    if client not in _clients:
        raise ValueError("지원하지 않는 AI CLI입니다.")
    if not instruction or len(instruction) > 1000:
        raise ValueError("채팅 요청은 1~1,000자로 입력해 주세요.")
    if client not in configured_clients():
        raise ValueError("선택한 AI의 MCP 설정이 완료되지 않았습니다. 트레이의 AI MCP 설정을 확인해 주세요.")
    active = mcp_registry.active_editor()
    if active["sessionId"] != session_id:
        raise ValueError("현재 편집 화면의 자막을 찾지 못했습니다. 페이지를 새로고침해 주세요.")
    job_id = str(uuid.uuid4())
    with _lock:
        _jobs[job_id] = {"status": "running", "message": "", "created": time.monotonic()}
        for key, value in list(_jobs.items()):
            if time.monotonic() - value["created"] > 3600:
                _jobs.pop(key, None)
    threading.Thread(target=_run, args=(job_id, client, instruction, session_id), daemon=True).start()
    return job_id


def get(job_id: str) -> dict[str, str]:
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            raise ValueError("채팅 작업을 찾지 못했습니다.")
        return {"status": job["status"], "message": job["message"]}
