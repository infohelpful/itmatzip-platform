"""Line Mode v4 — Phase C reflow (greedy window + scoring)."""

from __future__ import annotations

from typing import Any, Literal

JOSA_SET = frozenset({"은", "는", "이", "가", "을", "를", "에", "의", "와", "과"})
THRESHOLD_EARLY = 10.0
EARLY_MIN_CHAR_RATIO = 0.9
GAP_MIN_SEC = 0.35
GAP_MULTIPLIER = 6.0
MIN_SPLIT_SCORE = 5.0
MAX_DURATION_SEC = 6.5
MAX_CHARS_HORIZONTAL = 28
MAX_CHARS_VERTICAL = 20


def normalize_text_ssot(tokens: list[str]) -> str:
    parts = [str(t).strip() for t in tokens if str(t).strip()]
    return " ".join(parts)


def _word_text(word: dict[str, Any]) -> str:
    return str(word.get("text") or word.get("word") or "").strip()


def _hint_start(word: dict[str, Any]) -> float:
    raw = word.get("hintStart", word.get("hint_start", word.get("start")))
    try:
        return float(raw) if raw is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _hint_end(word: dict[str, Any]) -> float:
    hs = _hint_start(word)
    raw = word.get("hintEnd", word.get("hint_end", word.get("end")))
    try:
        return float(raw) if raw is not None else hs
    except (TypeError, ValueError):
        return hs


def map_whisper_words(raw_words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Whisper word stream → hint-isolated tokens (filters -- and blanks)."""
    out: list[dict[str, Any]] = []
    for w in raw_words or []:
        text = _word_text(w)
        if not text or text == "--":
            continue
        hs = _hint_start(w)
        he = _hint_end(w)
        if he < hs:
            he = hs
        out.append(
            {
                "word": text,
                "text": text,
                "start": hs,
                "end": he,
                "hintStart": hs,
                "hintEnd": he,
            }
        )
    prev_end: float | None = None
    for item in out:
        if prev_end is not None:
            item["gap"] = max(0.0, item["hintStart"] - prev_end)
        else:
            item["gap"] = 0.0
        prev_end = item["hintEnd"]
    return out


def flatten_words_from_subtitles(subtitles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    stream: list[dict[str, Any]] = []
    for cue in subtitles or []:
        words = cue.get("words") or []
        if words:
            stream.extend(map_whisper_words(words))
        else:
            text = str(cue.get("text") or "").strip()
            if not text or text == "--":
                continue
            hs = _hint_start(cue)
            he = _hint_end(cue)
            stream.append(
                {
                    "word": text,
                    "text": text,
                    "start": hs,
                    "end": he,
                    "hintStart": hs,
                    "hintEnd": he,
                }
            )
    return map_whisper_words(stream)


def _char_count_window(window: list[dict[str, Any]]) -> int:
    return len(normalize_text_ssot([_word_text(w) for w in window]))


def _window_duration(window: list[dict[str, Any]]) -> float:
    if not window:
        return 0.0
    return max(0.0, _hint_end(window[-1]) - _hint_start(window[0]))


def calculate_split_score(prev: dict[str, Any], next_word: dict[str, Any]) -> float:
    gap = max(0.0, _hint_start(next_word) - _hint_end(prev))
    score = max(0.0, gap - GAP_MIN_SEC) * GAP_MULTIPLIER
    pt = _word_text(prev)
    if pt and pt[-1] in ".?!":
        score += 5.0
    nt = _word_text(next_word).strip()
    if nt in JOSA_SET:
        score -= 10.0
    return score


def _pick_forced_cut(window: list[dict[str, Any]], max_chars: int) -> int:
    """강제 분할 시 호흡이 약하면 max_chars·duration 한도까지 단어를 묶는다."""
    n = len(window)
    if n <= 1:
        return 0
    best_i = 0
    best_score = float("-inf")
    for i in range(n - 1):
        s = calculate_split_score(window[i], window[i + 1])
        if s > best_score or (s == best_score and i > best_i):
            best_score = s
            best_i = i
    if best_score >= MIN_SPLIT_SCORE:
        return best_i
    for i in range(n - 1, -1, -1):
        left = window[: i + 1]
        if _char_count_window(left) <= max_chars and _window_duration(left) <= MAX_DURATION_SEC:
            return i
    return 0


def _window_exceeds(window: list[dict[str, Any]], max_chars: int) -> bool:
    if not window:
        return False
    if len(window) == 1:
        return _char_count_window(window) > max_chars
    return _char_count_window(window) > max_chars or _window_duration(window) > MAX_DURATION_SEC


def create_cue_object(words: list[dict[str, Any]], *, auto_reflow: bool = False) -> dict[str, Any]:
    if not words:
        raise ValueError("empty cue window")
    start = _hint_start(words[0])
    end = _hint_end(words[-1])
    out_words: list[dict[str, Any]] = []
    for w in words:
        hs = _hint_start(w)
        he = _hint_end(w)
        out_words.append(
            {
                "word": _word_text(w),
                "start": hs,
                "end": he,
                "hintStart": hs,
                "hintEnd": he,
            }
        )
    return {
        "start": start,
        "end": end,
        "text": normalize_text_ssot([_word_text(w) for w in words]),
        "words": out_words,
        "flags": {"userMoved": False, "autoReflow": auto_reflow},
    }


def emit_one_cue(
    window: list[dict[str, Any]], max_chars: int
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    n = len(window)
    if n == 0:
        return None, []
    if n == 1:
        auto = _char_count_window(window) > max_chars
        return create_cue_object(window, auto_reflow=auto), []

    score_early = calculate_split_score(window[-2], window[-1])
    chars = _char_count_window(window)
    if (
        n >= 2
        and score_early >= THRESHOLD_EARLY
        and chars >= max_chars * EARLY_MIN_CHAR_RATIO
    ):
        cut = n - 2
        left = window[: cut + 1]
        remain = window[cut + 1 :]
        return create_cue_object(left), remain

    dur = _window_duration(window)
    if chars <= max_chars and dur <= MAX_DURATION_SEC:
        return create_cue_object(window), []

    cut = _pick_forced_cut(window, max_chars)
    left = window[: cut + 1]
    remain = window[cut + 1 :]
    auto = chars > max_chars or dur > MAX_DURATION_SEC
    return create_cue_object(left, auto_reflow=auto), remain


def group_words_into_cues(
    words: list[dict[str, Any]],
    mode: Literal["horizontal", "vertical"] = "horizontal",
) -> list[dict[str, Any]]:
    max_chars = MAX_CHARS_HORIZONTAL if mode == "horizontal" else MAX_CHARS_VERTICAL
    cues: list[dict[str, Any]] = []
    window: list[dict[str, Any]] = []
    for w in words:
        window.append(w)
        while _window_exceeds(window, max_chars):
            cue, remain = emit_one_cue(window, max_chars)
            if cue is None:
                break
            cues.append(cue)
            window = remain
            if not window:
                break
    if window:
        cues.append(create_cue_object(window))
    return cues


def apply_line_mode_reflow(
    subtitles: list[dict[str, Any]],
    *,
    mode: Literal["horizontal", "vertical"] = "horizontal",
) -> list[dict[str, Any]]:
    words = flatten_words_from_subtitles(subtitles)
    if not words:
        return []
    return group_words_into_cues(words, mode=mode)


def reflow_cues_skip_user_moved(
    cues: list[dict[str, Any]],
    *,
    mode: Literal["horizontal", "vertical"] = "horizontal",
) -> list[dict[str, Any]]:
    """POST /reflow — preserve cues with flags.userMoved."""
    out: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []

    def flush_pending() -> None:
        nonlocal pending
        if not pending:
            return
        reflowed = group_words_into_cues(pending, mode=mode)
        out.extend(reflowed)
        pending = []

    for cue in cues or []:
        flags = cue.get("flags") if isinstance(cue.get("flags"), dict) else {}
        if flags.get("userMoved") is True:
            flush_pending()
            out.append(cue)
            continue
        for w in cue.get("words") or []:
            pending.append(w)
        if not (cue.get("words") or []):
            text = str(cue.get("text") or "").strip()
            if text and text != "--":
                pending.append(
                    {
                        "word": text,
                        "text": text,
                        "start": _hint_start(cue),
                        "end": _hint_end(cue),
                        "hintStart": _hint_start(cue),
                        "hintEnd": _hint_end(cue),
                    }
                )
    flush_pending()
    return out
