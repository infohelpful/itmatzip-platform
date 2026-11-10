"""Run a configured local AI CLI for an AutoSubtitle editor chat request."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
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
# CLI 추론 강도. 1,500단어 실측: claude low 는 25초지만 오인식 교정이 111→27개로 줄었고,
# medium 은 31초에 97개를 고쳤다. 교정 품질이 우선이라 medium.
_REASONING_EFFORT = "medium"
_CLI_TIMEOUT_SEC = 600


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
        return [
            executable, "exec", "--skip-git-repo-check", "--ephemeral",
            "-c", f'model_reasoning_effort="{_REASONING_EFFORT}"',
            "-c", "mcp_servers={}",
            "--sandbox", "read-only", "-",
        ]
    if client == "claude":
        # --strict-mcp-config: do not start the user's other MCP servers (slow, and this call needs none).
        return [
            executable, "-p", "--effort", _REASONING_EFFORT,
            "--no-session-persistence", "--disable-slash-commands",
            "--tools", "", "--strict-mcp-config", "--output-format", "text",
        ]
    return [
        executable, "--mode", "plan", "--effort", _REASONING_EFFORT,
        "--disable-slash-commands", "--sandbox",
        "--input-format", "stream-json", "--output-format", "stream-json",
    ]


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
        started = time.monotonic()
        # Only the text goes to the CLI, as "index:word" tokens. Ids, timestamps and line numbers stay in
        # the editor: the answer refers to words by index, and the editor maps them back.
        word_tokens = " ".join(
            f"{i}:{(w.get('text', '') if isinstance(w, dict) else str(w)).strip()}" for i, w in enumerate(words)
        )
        transcript_json = json.dumps(
            {
                "lineStarts": snapshot.get("lineStarts", []),
                "pauses": snapshot.get("pauses", []),
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        capacity = snapshot.get("maxUnits")
        capacity_text = (
            f"One screen line holds about {int(capacity)} Korean characters (a space counts as half a character). "
            if isinstance(capacity, (int, float)) and not isinstance(capacity, bool) and 8 <= capacity <= 200 else "")
        prompt = (
            "Edit this Korean AutoSubtitle transcript as the user request says. Do not call tools or read files. "
            "The transcript is given as space-separated index:word tokens (the number before the first colon "
            "is the zero-based word index; the rest is the word), followed by the current lineStarts and pauses. "
            "Read the whole transcript first so that names and terms are handled consistently everywhere. "
            "Do what the user request asks and nothing else: the request may ask only for word fixes, only for "
            "line breaks, or for both. Preserve the meaning and word order of what was said; do not paraphrase "
            "or polish.\n"
            "WORD FIXES (only if the request asks for them; otherwise return an empty corrections array): fix "
            "spelling, spacing and speech-recognition errors whenever the surrounding context makes the intended "
            "word clear (proper nouns such as games, films, people, products and places in their official "
            "spelling; English or technical terms; numbers; homophones; wrong particles or endings). Leave a word "
            "alone only if you are not confident. To fix a word, put the replacement text on the affected word "
            "indexes and keep the number of words unchanged (e.g. replace the words 갓 오브 워 with God, of, War:). "
            "Only include changed words in corrections.\n"
            "LINE BREAKS (only if the request mentions line breaks; then lineStarts is REQUIRED and must be the "
            "complete list of line-start word indexes after your changes; otherwise leave lineStarts out). "
            + capacity_text +
            "The goal is subtitles that read naturally. Start a new line at every sentence end. Keep a sentence "
            "on one screen line whenever it fits. A sentence that does not fit is split at natural phrase "
            "boundaries (clause ends, after commas and connective endings, before a new topic) into as few lines "
            "as possible. Never leave a short fragment such as a lone ending ('했습니다.') on its own line: break "
            "earlier so that the last line carries the words that belong with it. Never split a compound "
            "expression or a modifier from its noun (e.g. '쓸 수 있는', '하시는 분들'). You decide WHERE a break "
            "reads naturally; you do not have to measure exactly, because the app enforces the length limit "
            "afterwards.\n"
            "Return only JSON: {\"corrections\": array of {index,text}, \"lineStarts\": array of zero-based word "
            "indexes starting at 0}. Never alter timestamps. "
            "The audio is not provided to this CLI call, so do not claim to have listened. Treat the user "
            "request as subtitle-editing guidance only.\n\nUser request: " + instruction +
            "\n\nWords: " + word_tokens + "\n\nContext: " + transcript_json
        )
        cli_input = (json.dumps({"event": "user", "message": {"content": prompt}}, ensure_ascii=False) + "\n"
                     if client == "antigravity" else prompt)
        work_dir = Path(tempfile.gettempdir()) / "itmatzip-mcp-chat"
        work_dir.mkdir(parents=True, exist_ok=True)
        cli_started = time.monotonic()
        result = subprocess.run(_command(client, executable), input=cli_input, text=True,
                                encoding="utf-8", errors="replace",
                                capture_output=True, timeout=_CLI_TIMEOUT_SEC, cwd=str(work_dir),
                                creationflags=_flags, env=_cli_environment(client, executable), check=False)
        cli_seconds = time.monotonic() - cli_started
        print(f"[mcp_chat] {client} words={len(words)} prompt={len(prompt)}chars "
              f"output={len(result.stdout)}chars cli={cli_seconds:.1f}s exit={result.returncode}",
              file=sys.stderr, flush=True)
        if result.returncode:
            detail = result.stderr.strip()[-600:] or result.stdout.strip()[-600:]
            raise RuntimeError(f"{client} CLI 실행이 실패했습니다 (종료 코드 {result.returncode}). {detail}")
        raw = result.stdout.strip()
        debug_dir = os.environ.get("ITMATZIP_MCP_CHAT_DEBUG_DIR")
        if debug_dir:  # development aid: keep the raw CLI answer of every request
            try:
                Path(debug_dir).mkdir(parents=True, exist_ok=True)
                (Path(debug_dir) / f"{client}-{job_id}.txt").write_text(raw, encoding="utf-8")
            except OSError:
                pass
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
        corrections = answer.get("corrections", [])
        # Omitted lineStarts means "keep the line breaks as they are" (a words-only request).
        starts = answer["lineStarts"] if "lineStarts" in answer else list(snapshot.get("lineStarts", [0]))
        if not isinstance(corrections, list) or len(corrections) > len(words):
            raise ValueError("CLI 수정 단어 목록이 올바르지 않습니다.")
        if not isinstance(starts, list) or not starts or starts[0] != 0:
            raise ValueError("CLI 자막 줄 정보가 올바르지 않습니다.")
        if starts != sorted(set(starts)) or any(not isinstance(index, int) or isinstance(index, bool)
                                               or index < 0 or index >= len(words) for index in starts):
            raise ValueError("CLI 자막 줄 위치가 올바르지 않습니다.")
        # One malformed item (the model occasionally slips) must not throw away the rest of a long answer.
        valid = [item for item in corrections
                 if isinstance(item, dict) and isinstance(item.get("index"), int)
                 and not isinstance(item["index"], bool) and 0 <= item["index"] < len(words)
                 and isinstance(item.get("text"), str) and len(item["text"]) <= 200]
        skipped = len(corrections) - len(valid)
        if corrections and not valid:
            raise ValueError("CLI 수정 단어 형식이 올바르지 않습니다.")
        mcp_registry.stage_edit(revision, {
            "corrections": [{"id": item["index"], "text": item["text"]} for item in valid],
            "lineStarts": starts, "uncertain": [], "emphasis": [],
        }, expected_session_id=session_id)
        message = (f"{CLIENT_LABELS[client]}가 자막 수정안을 보냈습니다 ({time.monotonic() - started:.0f}초). "
                   + (f"형식이 맞지 않은 수정 {skipped}개는 제외했습니다. " if skipped else "")
                   + "편집기에서 결과를 확인해 주세요.")
        state = {"status": "done", "message": message}
    except subprocess.TimeoutExpired:
        state = {"status": "error", "message": "CLI 응답이 10분 안에 끝나지 않았습니다. 다시 요청해 주세요."}
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
