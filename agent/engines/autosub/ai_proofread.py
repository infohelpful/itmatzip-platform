"""AI proofreading of AutoSubtitle captions with Claude or ChatGPT (the user picks one).

Only text goes to the model: the transcript as numbered words plus where each caption line starts.
It answers with word-level corrections, new line starts, words it is unsure about and
(optionally) words to emphasize. Word timings never leave the PC and are never changed: the
editor applies the answer onto its existing words (web-src .../aiProofread.ts).

The answer is validated here; anything out of range or out of order is dropped rather than trusted.
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

# Engines from an older MSI may lack these: only AI proofreading is then unavailable.
try:
    import anthropic
except ImportError:
    anthropic = None  # type: ignore[assignment]
try:
    import openai
except ImportError:
    openai = None  # type: ignore[assignment]

from engines.autosub import ai_settings

MAX_WORDS = 40_000
MAX_WORD_LENGTH = 200
MAX_REASON_LENGTH = 200

SYSTEM_PROMPT = """You proofread Korean video subtitles produced by speech recognition (Whisper).

The transcript is a numbered list of words in speaking order, and `line_starts` lists the word id
that begins each caption line. Every word already carries the exact time it was spoken; you never
see or change timing. You change only the text of words and where caption lines begin.

1. Corrections. Fix misrecognized words, spelling, spacing inside a word, numbers and English or
   product names, and punctuation, using the surrounding context. Keep the speaker's own wording,
   tone and spoken style; do not rewrite sentences, summarize, translate or make them more formal.
   Return a correction only for a word whose text should change, as {"id", "text"}. Keep one word
   per id: when two recognized words are really one ("1" ".05" -> "1.05"), put the joined text on
   the first id and "" on the second. Never move text between distant ids.
2. Line starts. Re-split the transcript into short caption lines that are easy to read at a
   glance, the way a careful human subtitler would. Each caption is shown as a single screen line,
   and a full-width line is hard to read, so break every sentence into phrase-sized chunks at
   natural pauses in meaning: after a connective ending (-고, -는데, -서, -면, -지만, -며, -니까),
   after a comma, before a new clause, after an adverbial or object phrase that completes a thought.
   Aim for about `target_units` per line; a line may be shorter when the phrase is, and longer only
   when there is no natural break, but never longer than `max_units` (one full screen line).
   Never break inside a word, between a number and its unit, or between a modifier and the word it
   modifies, and avoid one-word lines unless the sentence is that short.
   Width counts a Hangul or other full-width character as 1 and an ASCII letter, digit, space or
   punctuation as 0.5.
   Example - one sentence:
     여러분 예전에 공들여 만들었던 영상을 다시 꺼내서 쓰고 싶은데 원본 프로젝트 파일이 어디로 갔는지 안 보여서 난감했던 적 있으신가요?
   becomes four lines:
     여러분 예전에 공들여 만들었던 영상을
     다시 꺼내서 쓰고 싶은데
     원본 프로젝트 파일이 어디로 갔는지
     안 보여서 난감했던 적 있으신가요?
   `pauses` lists the words (`before_id`) that come after a stretch with no speech (an intro,
   music, a long pause), with its length in seconds: always start a new line at each of them, so
   speech on either side of a silence never shares a line. Return the full list of starting word
   ids, beginning with the first id, strictly increasing.
3. Uncertain words. When a word is probably misheard but the context does not show the right text
   (a name, a number, a word that would also make sense), leave its text unchanged and list it in
   `uncertain` with a short Korean reason for the editor (under 60 characters).
4. Glossary. Terms in `glossary` are the correct spellings for names and terms in this video.
   When a recognized word is clearly one of them, correct it to that exact spelling.
5. Emphasis. Only when `emphasize` is true: list the ids of the few words a viewer should notice
   (key numbers, product names, the main point of a sentence), at most about one per line on
   average. Otherwise return an empty list."""

OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "corrections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "integer"}, "text": {"type": "string"}},
                "required": ["id", "text"],
                "additionalProperties": False,
            },
        },
        "line_starts": {"type": "array", "items": {"type": "integer"}},
        "uncertain": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "integer"}, "reason": {"type": "string"}},
                "required": ["id", "reason"],
                "additionalProperties": False,
            },
        },
        "emphasis": {"type": "array", "items": {"type": "integer"}},
    },
    "required": ["corrections", "line_starts", "uncertain", "emphasis"],
    "additionalProperties": False,
}


# -- request validation ------------------------------------------------------------------
@dataclass
class ProofreadRequest:
    words: list[str]
    line_starts: list[int]
    max_units: int
    emphasize: bool
    target_units: int = 18
    pauses: list[dict[str, Any]] = field(default_factory=list)


def parse_request(body: dict[str, Any]) -> ProofreadRequest:
    words = body.get("words")
    if not isinstance(words, list) or not words:
        raise ValueError("교정할 자막이 없습니다.")
    if len(words) > MAX_WORDS:
        raise ValueError(f"자막이 너무 깁니다(단어 {len(words)}개, 최대 {MAX_WORDS}개).")
    texts: list[str] = []
    for w in words:
        if not isinstance(w, str) or not w.strip() or len(w) > MAX_WORD_LENGTH:
            raise ValueError("자막 단어 형식이 올바르지 않습니다.")
        texts.append(w.strip())
    starts = body.get("lineStarts")
    if not isinstance(starts, list) or not all(isinstance(s, int) and not isinstance(s, bool) for s in starts):
        raise ValueError("줄 정보 형식이 올바르지 않습니다.")
    max_units = body.get("maxUnits")
    if not isinstance(max_units, int) or isinstance(max_units, bool) or not 4 <= max_units <= 80:
        raise ValueError("줄당 글자 수는 4~80 사이여야 합니다.")
    target = body.get("targetUnits")
    valid_target = isinstance(target, int) and not isinstance(target, bool) and 4 <= target <= max_units
    target_units = target if valid_target else min(18, max_units)
    return ProofreadRequest(texts, _clean_starts(starts, len(texts)), max_units, body.get("emphasize") is True,
                            target_units, _clean_pauses(body.get("pauses"), len(texts)))


def _clean_pauses(raw: Any, n: int) -> list[dict[str, Any]]:
    out: dict[int, float] = {}
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        g, sec = item.get("id"), item.get("sec")
        if isinstance(g, int) and not isinstance(g, bool) and 0 < g < n and isinstance(sec, (int, float)) and sec > 0:
            out[g] = round(float(sec), 1)
    return [{"before_id": g, "sec": sec} for g, sec in sorted(out.items())]


def _clean_starts(starts: list[Any], n: int) -> list[int]:
    clean = sorted({s for s in starts if isinstance(s, int) and not isinstance(s, bool) and 0 <= s < n})
    if not clean or clean[0] != 0:
        clean.insert(0, 0)
    return clean


def build_user_message(req: ProofreadRequest, terms: list[str]) -> str:
    payload = {
        "target_units": req.target_units,
        "max_units": req.max_units,
        "emphasize": req.emphasize,
        "glossary": terms,
        "line_starts": req.line_starts,
        "pauses": req.pauses,
        "words": [{"id": i, "text": t} for i, t in enumerate(req.words)],
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def validate_answer(raw: Any, req: ProofreadRequest) -> dict[str, Any]:
    """Keep only well-formed, in-range items. Line starts fall back to the current ones if unusable."""
    n = len(req.words)
    data = raw if isinstance(raw, dict) else {}

    def valid_id(value: Any) -> bool:
        return isinstance(value, int) and not isinstance(value, bool) and 0 <= value < n

    corrections: dict[int, str] = {}
    for item in data.get("corrections") or []:
        if not isinstance(item, dict) or not valid_id(item.get("id")) or not isinstance(item.get("text"), str):
            continue
        text = " ".join(item["text"].split())
        if len(text) > MAX_WORD_LENGTH or text == req.words[item["id"]]:
            continue
        corrections[item["id"]] = text
    # A word may be emptied only when a neighbour absorbed it; never blank a whole line.
    starts_raw = data.get("line_starts")
    starts = _clean_starts(starts_raw, n) if isinstance(starts_raw, list) and starts_raw else list(req.line_starts)
    bounds = starts + [n]
    for a, b in zip(bounds, bounds[1:]):
        if all(corrections.get(i, req.words[i]) == "" for i in range(a, b)):
            for i in range(a, b):
                corrections.pop(i, None)

    uncertain: dict[int, str] = {}
    for item in data.get("uncertain") or []:
        if isinstance(item, dict) and valid_id(item.get("id")) and isinstance(item.get("reason"), str):
            uncertain[item["id"]] = item["reason"].strip()[:MAX_REASON_LENGTH] or "확인이 필요합니다."
    emphasis = sorted({i for i in (data.get("emphasis") or []) if valid_id(i)}) if req.emphasize else []
    return {
        "corrections": [{"id": i, "text": t} for i, t in sorted(corrections.items())],
        "lineStarts": starts,
        "uncertain": [{"id": i, "reason": r} for i, r in sorted(uncertain.items())],
        "emphasis": emphasis,
    }


# -- model calls -------------------------------------------------------------------------
class ProofreadError(RuntimeError):
    pass


PROVIDER_LABEL = {"claude": "Claude", "openai": "ChatGPT"}
_OUTDATED = "AI 교정을 쓰려면 ItMatZip 에이전트를 최신 버전으로 업데이트해 주세요."


def _sdk(provider: str) -> Any:
    sdk = anthropic if provider == "claude" else openai
    if sdk is None:
        raise ProofreadError(_OUTDATED)
    return sdk


def explain_api_error(error: Exception) -> str:
    """Same wording for both SDKs; they share the error class names."""
    for sdk in (anthropic, openai):
        if sdk is None or not isinstance(error, sdk.APIError):
            continue
        if isinstance(error, sdk.AuthenticationError):
            return "API 키가 올바르지 않습니다. 키를 다시 확인해 주세요."
        if isinstance(error, sdk.PermissionDeniedError):
            return "이 API 키로는 이 모델을 쓸 수 없습니다(권한 없음)."
        if isinstance(error, sdk.NotFoundError):
            return "모델을 찾지 못했습니다. 이 키로 쓸 수 있는 모델인지 확인해 주세요."
        if isinstance(error, sdk.RateLimitError):
            message = str(getattr(error, "message", "") or error).lower()
            if "quota" in message or "credit" in message or "billing" in message:
                return "API 크레딧(잔액)이 부족합니다. 결제 상태를 확인해 주세요."
            return "요청이 많아 잠시 막혔습니다. 잠시 뒤 다시 시도해 주세요."
        if isinstance(error, sdk.BadRequestError):
            message = str(getattr(error, "message", "") or error)
            if "credit" in message.lower() or "billing" in message.lower():
                return "API 크레딧(잔액)이 부족합니다. 결제 상태를 확인해 주세요."
            return f"AI가 요청을 거부했습니다: {message[:300]}"
        if isinstance(error, sdk.APIStatusError):
            return f"AI API 오류({error.status_code}). 잠시 뒤 다시 시도해 주세요."
        if isinstance(error, sdk.APIConnectionError):
            return "AI API에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요."
    return str(error)


def _api_errors() -> tuple[type[BaseException], ...]:
    return tuple(sdk.APIError for sdk in (anthropic, openai) if sdk is not None)


def _client(provider: str, key: str) -> Any:
    sdk = _sdk(provider)
    if provider == "claude":
        return sdk.Anthropic(api_key=key, max_retries=2)
    return sdk.OpenAI(api_key=key, max_retries=2, timeout=900)


def test_key(provider: str, key: str, model: str) -> None:
    """Free check (no tokens): the key can see the model we will call."""
    client = _client(provider, key)
    try:
        client.models.retrieve(model)
    except _api_errors() as error:
        raise ProofreadError(explain_api_error(error)) from error


@dataclass
class _Job:
    id: str
    cancel: threading.Event = field(default_factory=threading.Event)
    done: threading.Event = field(default_factory=threading.Event)
    started: float = field(default_factory=time.monotonic)
    output_chars: int = 0
    result: dict[str, Any] | None = None
    error: str | None = None
    usage: dict[str, int] | None = None
    provider: str = "claude"
    model: str = ""


_jobs: dict[str, _Job] = {}
_jobs_lock = threading.Lock()


def _ask_claude(job: _Job, client: Any, user: str) -> str:
    params: dict[str, Any] = {
        "model": job.model,
        "max_tokens": 64000,
        "output_config": {"effort": "medium", "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
        "system": [{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
        "messages": [{"role": "user", "content": user}],
    }
    if job.model != "claude-haiku-5-5":  # Haiku has no server-side refusal fallback
        params.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    with client.beta.messages.stream(**params) as stream:
        for event in stream:
            if job.cancel.is_set():
                raise ProofreadError("취소했습니다.")
            if getattr(event, "type", "") == "text":
                job.output_chars += len(getattr(event, "text", "") or "")
        message = stream.get_final_message()
    if message.stop_reason == "refusal":
        raise ProofreadError("AI가 이 자막의 교정을 거절했습니다.")
    if message.stop_reason == "max_tokens":
        raise ProofreadError("자막이 너무 길어 결과가 잘렸습니다. 영상을 나눠 다시 시도해 주세요.")
    u = message.usage
    job.usage = {"input": int(u.input_tokens or 0), "output": int(u.output_tokens or 0),
                 "cacheRead": int(getattr(u, "cache_read_input_tokens", 0) or 0)}
    return "".join(b.text for b in message.content if getattr(b, "type", "") == "text")


def _ask_openai(job: _Job, client: Any, user: str) -> str:
    response = client.responses.create(
        model=job.model,
        instructions=SYSTEM_PROMPT,
        input=[{"role": "user", "content": user}],
        reasoning={"effort": "medium"},
        max_output_tokens=64000,
        prompt_cache_key="itmatzip-autosub-proofread",
        text={"format": {"type": "json_schema", "name": "subtitle_proofread", "schema": OUTPUT_SCHEMA,
                         "strict": True}},
    )
    if job.cancel.is_set():
        raise ProofreadError("취소했습니다.")
    for item in getattr(response, "output", None) or []:
        for part in getattr(item, "content", None) or []:
            if getattr(part, "type", "") == "refusal":
                raise ProofreadError("AI가 이 자막의 교정을 거절했습니다.")
    if getattr(response, "status", "") == "incomplete":
        raise ProofreadError("자막이 너무 길어 결과가 잘렸습니다. 영상을 나눠 다시 시도해 주세요.")
    u = getattr(response, "usage", None)
    details = getattr(u, "input_tokens_details", None)
    job.usage = {"input": int(getattr(u, "input_tokens", 0) or 0), "output": int(getattr(u, "output_tokens", 0) or 0),
                 "cacheRead": int(getattr(details, "cached_tokens", 0) or 0)}
    return response.output_text or ""


def _run(job: _Job, req: ProofreadRequest, key: str) -> None:
    try:
        client = _client(job.provider, key)
        user = build_user_message(req, ai_settings.glossary())
        text = _ask_claude(job, client, user) if job.provider == "claude" else _ask_openai(job, client, user)
        try:
            raw = json.loads(text)
        except ValueError as error:
            raise ProofreadError("AI 응답을 해석하지 못했습니다. 다시 시도해 주세요.") from error
        job.result = validate_answer(raw, req)
    except ProofreadError as error:
        job.error = str(error)
    except Exception as error:  # noqa: BLE001 - reported to the editor
        api = _api_errors()
        job.error = explain_api_error(error) if api and isinstance(error, api) else f"AI 교정 실패: {error}"
    finally:
        job.done.set()


def start(body: dict[str, Any]) -> str:
    req = parse_request(body)
    raw = body.get("provider")
    provider = ai_settings.check_provider(raw) if raw is not None else ai_settings.provider()
    key = ai_settings.api_key(provider)
    if not key:
        raise ProofreadError(f"먼저 AI 연동에서 {PROVIDER_LABEL[provider]} API 키를 등록해 주세요.")
    job = _Job(uuid.uuid4().hex, provider=provider, model=ai_settings.model(provider))
    with _jobs_lock:
        for other in _jobs.values():
            other.cancel.set()
        _jobs.clear()
        _jobs[job.id] = job
    threading.Thread(target=_run, args=(job, req, key), name="autosub-ai-proofread", daemon=True).start()
    return job.id


def status(job_id: str, wait_sec: float = 0.0) -> dict[str, Any]:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None:
        return {"state": "unknown"}
    if wait_sec > 0:
        job.done.wait(wait_sec)
    elapsed = round(time.monotonic() - job.started, 1)
    if not job.done.is_set():
        if job.cancel.is_set():  # an OpenAI request cannot be interrupted; stop reporting it
            with _jobs_lock:
                _jobs.pop(job_id, None)
            return {"state": "error", "error": "취소했습니다.", "elapsedSec": elapsed}
        return {"state": "running", "elapsedSec": elapsed, "outputChars": job.output_chars}
    with _jobs_lock:
        _jobs.pop(job_id, None)
    if job.error is not None:
        return {"state": "error", "error": job.error, "elapsedSec": elapsed}
    return {"state": "done", "result": job.result, "usage": job.usage, "elapsedSec": elapsed,
            "provider": job.provider, "model": job.model}


def cancel(job_id: str) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job:
        job.cancel.set()
