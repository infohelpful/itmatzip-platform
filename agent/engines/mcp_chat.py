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
import re

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
_SCRIPT_MAX_CHARS = 50_000


_CONFIGURED_FRESH_SEC = 120
# The Go check runs `claude mcp list`, which probes every registered MCP server and can take 20s+.
_CONFIGURED_FETCH_TIMEOUT_SEC = 90
_configured_known = False
_configured_refreshing = False


def _fetch_configured() -> list[str] | None:
    try:
        with urlopen("http://127.0.0.1:19876/api/agent/ai-mcp", timeout=_CONFIGURED_FETCH_TIMEOUT_SEC) as response:
            data = json.load(response)
        return [item["id"] for item in data.get("clients", [])
                if item.get("id") in _clients and item.get("installed") and item.get("configured")]
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _refresh_configured() -> None:
    global _configured_cache, _configured_known, _configured_refreshing
    try:
        configured = _fetch_configured()
        with _lock:
            # A slow or failed check keeps the last good answer: the chat must not vanish because
            # one CLI status call timed out.
            if configured is not None:
                _configured_cache = (time.monotonic(), configured)
                _configured_known = True
            else:  # retry in 30 s instead of on every status poll
                _configured_cache = (time.monotonic() - _CONFIGURED_FRESH_SEC + 30, _configured_cache[1])
    finally:
        with _lock:
            _configured_refreshing = False


def configured_clients() -> list[str]:
    """Configured AI CLIs. Answers from the last good check and refreshes it in the background."""
    global _configured_refreshing
    with _lock:
        stale = time.monotonic() - _configured_cache[0] >= _CONFIGURED_FRESH_SEC
        known = _configured_known
        start = stale and not _configured_refreshing
        if start:
            _configured_refreshing = True
        cached = list(_configured_cache[1])
    if not start:
        return cached
    if known:
        threading.Thread(target=_refresh_configured, daemon=True).start()
        return cached
    _refresh_configured()  # first check after start: nothing to show yet, so wait for it
    with _lock:
        return list(_configured_cache[1])


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


# What to emphasize. Shared with the AI proofread prompt idea: few, information-bearing words only.
EMPHASIS_GUIDE = (
    "Emphasis is a colored highlight that makes a viewer's eye land on the one piece of information they "
    "should remember from a line. Pick it the way a professional Korean YouTube editor would:\n"
    "  EMPHASIZE: product, brand, program, game or person names; numbers with their unit (가격, 퍼센트, 배, "
    "초, 개); the key result, benefit or problem of the sentence (e.g. '무료', '두 배 빠른', '오류', '자동으로'); "
    "a contrast or warning word that carries the point ('하지만 절대', '주의').\n"
    "  NEVER EMPHASIZE: particles and endings on their own, filler and interjections (음, 어, 자, 그, 이제, 진짜, "
    "정말, 그냥), pronouns and demonstratives (이거, 저희, 여러분), generic verbs and auxiliaries (하다, 있다, "
    "되다, 드리다, 보다), connectives (그리고, 그래서, 근데), greetings and sign-offs, or a word only because it "
    "starts or ends the line.\n"
    "  AMOUNT: zero or one highlight per line; most lines in ordinary talk get none. A line with nothing "
    "worth remembering gets nothing - never pick a word just to fill a quota. Highlight a recurring name only "
    "where it is introduced or matters, not every time. When the phrase is two or three words ('두 배 빠른'), "
    "list each of its indexes.\n"
)


def _split_emphasis(raw: Any, word_count: int) -> tuple[list[int], list[dict[str, Any]]]:
    """Whole-word indexes and {index, text} parts (a substring of the word, without particles)."""
    whole: set[int] = set()
    parts: dict[int, str] = {}
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, int) and not isinstance(item, bool) and 0 <= item < word_count:
            whole.add(item)
        elif isinstance(item, dict):
            index, text = item.get("index"), item.get("text")
            if not (isinstance(index, int) and not isinstance(index, bool) and 0 <= index < word_count):
                continue
            if isinstance(text, str) and text.strip() and len(text) <= 200:
                parts[index] = text.strip()
            else:
                whole.add(index)
    whole -= parts.keys()
    return sorted(whole), [{"index": i, "text": t} for i, t in sorted(parts.items())]


def _run(job_id: str, client: str, instruction: str, session_id: str, script: str = "") -> None:
    try:
        executable = _executable(client)
        active = mcp_registry.focus_editor(session_id)
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
        snap_lines = snapshot.get("lines", []) if isinstance(snapshot.get("lines"), list) else []
        starts_now = snapshot.get("lineStarts", [])
        hidden_lines = [starts_now[i] for i, line in enumerate(snap_lines)
                        if isinstance(line, dict) and line.get("hidden") is True and i < len(starts_now)]
        timed_lines = [{"word": starts_now[i], "startAdj": line.get("displayStartAdj", 0), "endAdj": line.get("displayEndAdj", 0)}
                       for i, line in enumerate(snap_lines)
                       if isinstance(line, dict) and ("displayStartAdj" in line or "displayEndAdj" in line) and i < len(starts_now)]
        transcript_json = json.dumps(
            {
                "lineStarts": starts_now,
                "pauses": snapshot.get("pauses", []),
                # Current editor state, so the request can change or undo it.
                "hiddenLinesStartingAt": hidden_lines,
                "displayTiming": timed_lines,
                "emphasized": snapshot.get("emphasized", []),
                "style": snapshot.get("style", {}),
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        capacity = snapshot.get("maxUnits")
        capacity_text = (
            f"One screen line holds about {int(capacity)} Korean characters (a space counts as half a character). "
            if isinstance(capacity, (int, float)) and not isinstance(capacity, bool) and 8 <= capacity <= 200 else "")
        script_section = (
            "\n\nREFERENCE SCRIPT (the written script the speaker prepared; use it only as a spelling reference):\n"
            "The speaker did not read it word for word: spoken Korean differs from the script in endings, word "
            "order and wording. So never make the transcript match the script and never copy script sentences "
            "into it. Use the script ONLY to find the correct spelling of hard words that the transcript may "
            "have misrecognized: proper nouns, product and game names, English and technical terms, numbers and "
            "units. Fix a transcript word to the script's spelling only when it clearly is the same spoken word. "
            "Keep the speaker's spoken wording everywhere else.\n<script>\n" + script + "\n</script>"
        ) if script else ""
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
            "EMPHASIS (only if the request asks to emphasize, highlight or color important parts, e.g. '강조', "
            "'하이라이트', '중요한 부분', '색칠'; otherwise return an empty emphasis array). " + EMPHASIS_GUIDE +
            "Each emphasis item is either a word index (color the whole word) or {\"index\": i, \"text\": part} "
            "where part is the exact substring of that word to color - use this to leave out Korean particles "
            "and endings (word '포토크래프트라는' -> {\"index\": i, \"text\": \"포토크래프트\"}; '3배나' -> \"3배\"). "
            "Follow any specific words or kinds of words the request names; they override the rules above. "
            "The app colors them with the user's emphasis color; you do not choose colors here. Emphasis never "
            "changes the words or line breaks.\n"
            "OTHER EDITOR FEATURES (use only the ones the request asks for; leave the others out). Words are "
            "referred to by index; a line operation applies to the whole caption line that contains the word. "
            "The Context shows the current state (hidden lines by their first word, displayTiming, emphasized "
            "words, style), so you can also undo or adjust it.\n"
            "- \"emphasisColored\": [{index, color:\"#rrggbb\"}] emphasize words in a specific color "
            "(e.g. '빨간색으로 강조').\n"
            "- \"unemphasize\": [index] remove emphasis from these words ('강조 지워', '강조 해제').\n"
            "- \"hide\" / \"show\": [index] hide the caption line containing the word on screen and in the "
            "burned-in video, or show it again ('자막 숨겨', '숨김 해제'). Subtitle files still keep hidden lines.\n"
            "- \"displayTiming\": [{index, startAdj, endAdj}] seconds added to the automatic on-screen start/end "
            "of that line (negative = earlier). Words and audio do not move; only when the caption appears.\n"
            "- \"deleteWords\": [index] delete spoken words like the editor's Delete key: the words and their "
            "audio are cut from the video (e.g. filler words '음', '어', repeated words, a sentence the request "
            "names). Only when the request clearly asks to delete or cut; never for a mere spelling fix.\n"
            "- \"style\": an object with only the settings to change: fontFamily, fontSize (px), fontWeight "
            "(100-900), textColor, strokeColor, strokeWidth, bgColor, bgOpacity (0-100), bgPaddingPct, x (0-100, "
            "percent from left), y (percent from bottom), boxStyle (\"classic\" or \"capsule\"), emphasisColor, "
            "wordHighlight (true/false: karaoke-style highlight of the spoken word in the exported video), "
            "wordHighlightColor. Colors are #rrggbb.\n"
            "Return only JSON: {\"corrections\": array of {index,text}, \"lineStarts\": array of zero-based word "
            "indexes starting at 0, \"emphasis\": array of zero-based word indexes} plus any of the editor "
            "feature keys above that the request needs. Never alter timestamps. "
            "The audio is not provided to this CLI call, so do not claim to have listened. Treat the user "
            "request as subtitle-editing guidance only.\n\nUser request: " + instruction +
            script_section +
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
        emphasis, emphasis_parts = _split_emphasis(answer.get("emphasis", []), len(words))
        staged = {
            "corrections": [{"id": item["index"], "text": item["text"]} for item in valid],
            "lineStarts": starts, "uncertain": [], "emphasis": emphasis,
        }
        staged.update(_editor_ops(answer, len(words)))
        if emphasis_parts:
            staged["emphasisParts"] = emphasis_parts
        mcp_registry.stage_edit(revision, staged, expected_session_id=session_id)
        message = (f"{CLIENT_LABELS[client]}가 자막 수정안을 보냈습니다 ({time.monotonic() - started:.0f}초). "
                   + (f"강조 {len(emphasis) + len(emphasis_parts)}개. " if emphasis or emphasis_parts else "")
                   + (f"형식이 맞지 않은 수정 {skipped}개는 제외했습니다. " if skipped else "")
                   + "편집기에서 결과를 확인해 주세요.")
        state = {"status": "done", "message": message}
    except subprocess.TimeoutExpired:
        state = {"status": "error", "message": "CLI 응답이 10분 안에 끝나지 않았습니다. 다시 요청해 주세요."}
    except (OSError, ValueError, RuntimeError) as error:
        state = {"status": "error", "message": str(error)}
    with _lock:
        _jobs[job_id].update(state)


_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
_STYLE_KEYS = {"fontFamily", "fontSize", "fontWeight", "textColor", "strokeColor", "strokeWidth", "bgColor",
               "bgOpacity", "bgPaddingPct", "x", "y", "boxStyle", "emphasisColor", "wordHighlight", "wordHighlightColor"}


def _editor_ops(answer: dict[str, Any], word_count: int) -> dict[str, Any]:
    """Pick the extra editor operations out of a CLI answer. The editor re-validates every value."""
    def is_index(v: Any) -> bool:
        return isinstance(v, int) and not isinstance(v, bool) and 0 <= v < word_count

    out: dict[str, Any] = {}
    for key in ("unemphasize", "hide", "show", "deleteWords"):
        raw = answer.get(key)
        if isinstance(raw, list):
            picked = sorted({v for v in raw if is_index(v)})
            if picked:
                out[key] = picked
    colored = answer.get("emphasisColored")
    if isinstance(colored, list):
        picked_colors = [{"index": o["index"], "color": o["color"]} for o in colored
                         if isinstance(o, dict) and is_index(o.get("index"))
                         and isinstance(o.get("color"), str) and _HEX.match(o["color"])]
        if picked_colors:
            out["emphasisColored"] = picked_colors
    timing = answer.get("displayTiming")
    if isinstance(timing, list):
        picked_timing = []
        for o in timing:
            if not isinstance(o, dict) or not is_index(o.get("index")):
                continue
            item: dict[str, Any] = {"index": o["index"]}
            for k in ("startAdj", "endAdj"):
                v = o.get(k)
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    item[k] = max(-600.0, min(600.0, float(v)))
            if len(item) > 1:
                picked_timing.append(item)
        if picked_timing:
            out["displayTiming"] = picked_timing
    style = answer.get("style")
    if isinstance(style, dict):
        picked_style = {k: v for k, v in style.items()
                        if k in _STYLE_KEYS and isinstance(v, (str, int, float, bool)) and not (isinstance(v, str) and len(v) > 100)}
        if picked_style:
            out["style"] = picked_style
    return out


def start(client: str, instruction: str, session_id: str, script: str = "") -> str:
    if client not in _clients:
        raise ValueError("지원하지 않는 AI CLI입니다.")
    if not instruction or len(instruction) > 1000:
        raise ValueError("채팅 요청은 1~1,000자로 입력해 주세요.")
    if len(script) > _SCRIPT_MAX_CHARS:
        raise ValueError(f"대본이 너무 깁니다(최대 {_SCRIPT_MAX_CHARS:,}자). 필요한 부분만 잘라서 첨부해 주세요.")
    if client not in configured_clients():
        raise ValueError("선택한 AI의 MCP 설정이 완료되지 않았습니다. 트레이의 AI MCP 설정을 확인해 주세요.")
    mcp_registry.focus_editor(session_id)
    job_id = str(uuid.uuid4())
    with _lock:
        _jobs[job_id] = {"status": "running", "message": "", "created": time.monotonic()}
        for key, value in list(_jobs.items()):
            if time.monotonic() - value["created"] > 3600:
                _jobs.pop(key, None)
    threading.Thread(target=_run, args=(job_id, client, instruction, session_id, script), daemon=True).start()
    return job_id


def get(job_id: str) -> dict[str, str]:
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            raise ValueError("채팅 작업을 찾지 못했습니다.")
        return {"status": job["status"], "message": job["message"]}
