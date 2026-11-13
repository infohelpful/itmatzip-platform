"""Create Music AI 작곡 도우미 — 사용자의 AI CLI(Claude·Codex·Antigravity)로 입력 칸 수정안을 만든다.

AutoSubtitle 채팅(`mcp_chat`)과 같은 CLI 실행 방식을 쓰고, 답은 화면 입력 칸에 넣을 값(patch)으로 돌려준다.
화면이 값을 다시 확인하므로 여기서는 형식만 걸러낸다.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from engines import mcp_chat

_lock = threading.Lock()
_jobs: dict[str, dict[str, Any]] = {}
_CLIENTS = ("codex", "claude", "antigravity")
_TIMEOUT_SEC = 300
_MAX_LYRICS = 4000

# 화면의 선택지 (web-ui/tools/create-music/music-compose.js 와 같은 키)
GENRES = {
    "genre.kpop": "K-pop", "genre.pop": "Pop", "genre.ballad": "Ballad", "genre.rnb": "R&B",
    "genre.hiphop": "Hip-hop", "genre.rock": "Rock", "genre.lofi": "Lo-fi", "genre.edm": "EDM",
    "genre.jazz": "Jazz", "genre.citypop": "City pop", "genre.acoustic": "Acoustic",
    "genre.orchestral": "Orchestral", "genre.cinematic": "Cinematic", "genre.newage": "New Age",
    "genre.ambient": "Ambient", "genre.indie": "Indie", "genre.trot": "Trot (Korean)",
    "genre.synthwave": "Synthwave", "genre.retro": "Retro", "genre.soul": "Soul", "genre.funk": "Funk",
}
INSTRUMENTS = {
    "inst.piano": "piano", "inst.synth": "synthesizer", "inst.epiano": "electric piano",
    "inst.acguitar": "acoustic guitar", "inst.eguitar": "electric guitar", "inst.bass": "bass",
    "inst.violin": "violin", "inst.cello": "cello", "inst.strings": "string ensemble",
    "inst.drums": "drum kit", "inst.perc": "epic percussion", "inst.beat": "beat machine",
    "inst.brass": "brass", "inst.sax": "saxophone", "inst.flute": "flute",
}
VOCAL_STYLES = {
    "vstyle.soft": "soft", "vstyle.powerful": "powerful", "vstyle.breathy": "breathy",
    "vstyle.raspy": "raspy/husky", "vstyle.falsetto": "high/falsetto", "vstyle.choir": "choir",
    "vstyle.whisper": "whispered", "vstyle.emotional": "emotional",
}
VOCALS = ("female", "male", "duet", "none")
TEMPOS = ("slow", "medium", "fast")
LANGS = ("ko", "en", "ja", "zh")
DURATIONS = (-1, 60, 120, 180, 300)
QUALITIES = ("speed", "quality")


def _clean_form(form: Any) -> dict[str, Any]:
    """화면에서 보낸 현재 입력 상태 (CLI에 문맥으로만 전달)."""
    if not isinstance(form, dict):
        return {}
    out: dict[str, Any] = {}
    for key in ("vocal", "mood", "tempo", "vocal_language", "quality"):
        if isinstance(form.get(key), str):
            out[key] = form[key][:200]
    if isinstance(form.get("lyrics"), str):
        out["lyrics"] = form["lyrics"][:_MAX_LYRICS]
    for key in ("genres", "instruments", "vocal_styles"):
        if isinstance(form.get(key), list):
            out[key] = [str(v)[:40] for v in form[key]][:30]
    for key in ("duration", "max_duration"):
        value = form.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            out[key] = int(value)
    return out


def _clean_history(history: Any) -> list[dict[str, str]]:
    if not isinstance(history, list):
        return []
    out = []
    for item in history[-6:]:
        if isinstance(item, dict) and item.get("role") in ("user", "assistant") and isinstance(item.get("text"), str):
            out.append({"role": item["role"], "text": item["text"][:1500]})
    return out


def _pick_keys(raw: Any, allowed: dict[str, str]) -> list[str] | None:
    if not isinstance(raw, list):
        return None
    picked: list[str] = []
    for value in raw:
        if isinstance(value, str) and value in allowed and value not in picked:
            picked.append(value)
    return picked[:6]


def parse_patch(answer: dict[str, Any], max_duration: int = 600) -> dict[str, Any]:
    """CLI 답 → 화면에 넣을 값. 모르는 키·틀린 값은 버린다."""
    patch: dict[str, Any] = {}
    if answer.get("vocal") in VOCALS:
        patch["vocal"] = answer["vocal"]
    for key, allowed in (("genres", GENRES), ("instruments", INSTRUMENTS), ("vocal_styles", VOCAL_STYLES)):
        picked = _pick_keys(answer.get(key), allowed)
        if picked is not None:
            patch[key] = picked
    if isinstance(answer.get("mood"), str):
        patch["mood"] = answer["mood"].strip()[:120]
    if answer.get("tempo") in TEMPOS:
        patch["tempo"] = answer["tempo"]
    if isinstance(answer.get("lyrics"), str):
        patch["lyrics"] = answer["lyrics"].strip()[:_MAX_LYRICS]
    if answer.get("vocal_language") in LANGS:
        patch["vocal_language"] = answer["vocal_language"]
    duration = answer.get("duration")
    if isinstance(duration, (int, float)) and not isinstance(duration, bool):
        duration = int(duration)
        if duration in DURATIONS and (duration <= 0 or duration <= max_duration):
            patch["duration"] = duration
    if answer.get("quality") in QUALITIES:
        patch["quality"] = answer["quality"]
    if patch.get("vocal") == "none":
        patch.pop("lyrics", None)
        patch.pop("vocal_styles", None)
    return patch


def _prompt(instruction: str, form: dict[str, Any], history: list[dict[str, str]]) -> str:
    max_duration = int(form.get("max_duration") or 600)
    options = {
        "vocal": list(VOCALS),
        "genres": GENRES,
        "instruments": INSTRUMENTS,
        "vocal_styles": VOCAL_STYLES,
        "tempo": {"slow": "~70 BPM", "medium": "~110 BPM", "fast": "~140 BPM"},
        "vocal_language": list(LANGS),
        "duration": [d for d in DURATIONS if d <= 0 or d <= max_duration],
        "quality": {"speed": "fast draft (default)", "quality": "slower, higher quality"},
    }
    return (
        "You help a user fill in the form of Create Music, a local AI music generator (ACE-Step 1.5). "
        "Do not call tools or read files. Answer with ONE JSON object only.\n"
        "The form fields and their allowed values are listed in OPTIONS (genres/instruments/vocal_styles "
        "use the KEYS of those maps, e.g. \"genre.citypop\"). Return only the fields you want to change; "
        "a list field replaces the whole list. \"duration\" is seconds, -1 = automatic from the lyrics.\n"
        "LYRICS: when the song has vocals (vocal is female/male/duet) and the request asks for lyrics, "
        "or the lyrics are empty and the user wants a sung song, write singable lyrics in the vocal "
        "language (Korean by default). Structure them with section tags on their own lines, using exactly "
        "these tags: [Verse], [Pre-Chorus], [Chorus], [Bridge], [Instrumental], [Outro]. Keep lines short "
        "(about 6-14 Korean syllables), make the chorus memorable and repeat it, and fit the length to the "
        "duration (about 2 verses + 2 choruses for 2-3 minutes). Never put stage directions or "
        "descriptions inside the lyrics; put the feel into \"mood\" instead. Write original lyrics; do not "
        "copy existing songs. When the user asks to change only part of the lyrics, return the complete "
        "new lyrics with that part changed. For an instrumental (vocal \"none\") return no lyrics.\n"
        "MOOD: a short phrase in the user's language describing atmosphere, scene and sound (max ~60 chars).\n"
        "Also return \"reply\": one or two short sentences in the user's language telling what you set "
        "(do not repeat the lyrics). If the request is not about making music, set only \"reply\" and "
        "explain politely what you can help with.\n\n"
        "OPTIONS: " + json.dumps(options, ensure_ascii=False) + "\n\n"
        "CURRENT FORM: " + json.dumps(form, ensure_ascii=False) + "\n\n"
        + ("RECENT CHAT: " + json.dumps(history, ensure_ascii=False) + "\n\n" if history else "")
        + "User request: " + instruction
    )


def _run(job_id: str, client: str, instruction: str, form: dict[str, Any], history: list[dict[str, str]]) -> None:
    started = time.monotonic()
    try:
        executable = mcp_chat._executable(client)
        prompt = _prompt(instruction, form, history)
        cli_input = (json.dumps({"event": "user", "message": {"content": prompt}}, ensure_ascii=False) + "\n"
                     if client == "antigravity" else prompt)
        work_dir = Path(tempfile.gettempdir()) / "itmatzip-create-music-ai"
        work_dir.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            mcp_chat._command(client, executable), input=cli_input, text=True, encoding="utf-8",
            errors="replace", capture_output=True, timeout=_TIMEOUT_SEC, cwd=str(work_dir),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            env=mcp_chat._cli_environment(client, executable), check=False,
        )
        print(f"[create_music_ai] {client} prompt={len(prompt)}chars output={len(result.stdout)}chars "
              f"{time.monotonic() - started:.1f}s exit={result.returncode}", file=sys.stderr, flush=True)
        if result.returncode:
            detail = result.stderr.strip()[-400:] or result.stdout.strip()[-400:]
            raise RuntimeError(f"{mcp_chat.CLIENT_LABELS[client]} 실행이 실패했습니다. {detail}")
        raw = result.stdout.strip()
        if client == "antigravity":
            events = [json.loads(line) for line in raw.splitlines() if line.strip().startswith("{")]
            final = next((e.get("result", {}) for e in reversed(events) if e.get("event") == "result"), None)
            if not final or final.get("status") != "SUCCESS":
                raise RuntimeError("Antigravity 응답 실패: " + str((final or {}).get("error", "결과가 없습니다."))[:300])
            raw = str(final.get("response", "")).strip()
        answer = _parse_json(raw)
        patch = parse_patch(answer, int(form.get("max_duration") or 600))
        reply = answer.get("reply") if isinstance(answer.get("reply"), str) else ""
        state = {"status": "done", "message": reply.strip()[:600], "patch": patch}
    except subprocess.TimeoutExpired:
        state = {"status": "error", "message": "AI 응답이 너무 오래 걸렸습니다. 다시 요청해 주세요."}
    except (OSError, ValueError, RuntimeError) as error:
        state = {"status": "error", "message": str(error)}
    with _lock:
        if job_id in _jobs:
            _jobs[job_id].update(state)


def _parse_json(raw: str) -> dict[str, Any]:
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    try:
        answer = json.loads(text)
    except ValueError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("AI가 입력 칸 형식의 답을 주지 않았습니다. 다시 요청해 주세요.") from None
        try:
            answer = json.loads(text[start:end + 1])
        except ValueError:
            raise ValueError("AI가 입력 칸 형식의 답을 주지 않았습니다. 다시 요청해 주세요.") from None
    if not isinstance(answer, dict):
        raise ValueError("AI 답 형식이 올바르지 않습니다.")
    return answer


def configured_clients() -> list[str]:
    return [c for c in mcp_chat.configured_clients() if c in _CLIENTS]


def start(client: str, instruction: str, form: Any, history: Any) -> str:
    if client not in _CLIENTS:
        raise ValueError("지원하지 않는 AI CLI입니다.")
    instruction = (instruction or "").strip()
    if not instruction or len(instruction) > 2000:
        raise ValueError("요청은 1~2,000자로 입력해 주세요.")
    if client not in configured_clients():
        raise ValueError("선택한 AI가 연결되어 있지 않습니다. 트레이의 AI MCP 설정을 확인해 주세요.")
    job_id = str(uuid.uuid4())
    with _lock:
        now = time.monotonic()
        for key, value in list(_jobs.items()):
            if now - value["created"] > 3600:
                _jobs.pop(key, None)
        _jobs[job_id] = {"status": "running", "message": "", "patch": {}, "created": now}
    threading.Thread(target=_run, args=(job_id, client, instruction, _clean_form(form), _clean_history(history)),
                     daemon=True).start()
    return job_id


def get(job_id: str) -> dict[str, Any]:
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            raise ValueError("요청을 찾지 못했습니다.")
        return {"status": job["status"], "message": job["message"], "patch": job.get("patch", {})}
