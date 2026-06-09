"""
stable-ts align_words — faster-whisper 세그먼트 내 단어 1차 AI 정렬 (V20).
실패·미설치 시 soft fallback — Job 중단 없이 Whisper 타임스탬프 유지.
"""

from __future__ import annotations

import logging
from copy import deepcopy
from typing import Any

logger = logging.getLogger(__name__)

STABLE_TS_PACKAGE = "stable-ts[fw]>=2.19.0,<2.20.0"
MIN_WORD_SEC = 0.05
FAILURE_THRESHOLD = 0.5


def is_stable_ts_installed() -> bool:
    try:
        import stable_whisper  # noqa: F401

        return True
    except ImportError:
        return False


def _is_silence_cue(cue: dict[str, Any]) -> bool:
    if cue.get("isSilence") is True or cue.get("is_silence") is True:
        return True
    text = str(cue.get("text") or "").strip()
    if text == "--":
        return True
    words = cue.get("words")
    if isinstance(words, list) and words:
        only_sil = all(
            isinstance(w, dict)
            and (
                w.get("isSilence") is True
                or w.get("is_silence") is True
                or str(w.get("word") or "").strip() in ("--", "-- ")
            )
            for w in words
        )
        if only_sil:
            return True
    return False


def _word_ts_abnormal(start: float, end: float) -> bool:
    if end + 1e-9 < start:
        return True
    return (end - start) < MIN_WORD_SEC - 1e-9


def _snapshot_word_times(cues: list[dict[str, Any]]) -> dict[tuple[int, int], tuple[float, float]]:
    snap: dict[tuple[int, int], tuple[float, float]] = {}
    for ci, cue in enumerate(cues):
        if not isinstance(cue, dict):
            continue
        words = cue.get("words")
        if not isinstance(words, list):
            continue
        for wi, w in enumerate(words):
            if not isinstance(w, dict):
                continue
            try:
                snap[(ci, wi)] = (float(w.get("start", 0)), float(w.get("end", 0)))
            except (TypeError, ValueError):
                continue
    return snap


def wrap_faster_whisper_for_stable(model: Any, model_path: str) -> Any:
    """이미 로드된 CT2 WhisperModel에 stable-ts align_words 메서드를 부착 (이중 로드 방지)."""
    if getattr(model, "_stable_ts_patched", False):
        return model

    from types import MethodType

    from faster_whisper import BatchedInferencePipeline
    from stable_whisper.alignment import align, align_words, refine
    from stable_whisper.whisper_word_level.faster_whisper import (
        deprecated_transcribe,
        faster_transcribe,
    )

    model.model_size_or_path = model_path
    if not hasattr(model, "transcribe_original"):
        model.transcribe_original = model.transcribe
    model.transcribe = MethodType(faster_transcribe, model)
    model.transcribe_stable = MethodType(deprecated_transcribe, model)
    if not hasattr(model, "batch_inference_pipeline"):
        model.batch_inference_pipeline = BatchedInferencePipeline(model)
    model.align = MethodType(align, model)
    model.align_words = MethodType(align_words, model)
    model.refine = MethodType(refine, model)
    model._stable_ts_patched = True
    return model


def _cues_to_align_segments(cues: list[dict[str, Any]]) -> tuple[list[int], list[dict[str, Any]]]:
    """무음 cue는 제외하고 align_words 입력 세그먼트 생성."""
    indices: list[int] = []
    segments: list[dict[str, Any]] = []
    for ci, cue in enumerate(cues):
        if not isinstance(cue, dict) or _is_silence_cue(cue):
            continue
        try:
            start = float(cue.get("start", 0))
            end = float(cue.get("end", 0))
        except (TypeError, ValueError):
            continue
        text = str(cue.get("text") or "").strip()
        if not text:
            continue
        seg: dict[str, Any] = {"start": start, "end": end, "text": text}
        raw_words = cue.get("words")
        if isinstance(raw_words, list) and raw_words:
            words_out: list[dict[str, Any]] = []
            for w in raw_words:
                if not isinstance(w, dict):
                    continue
                ww = str(w.get("word") or "").strip()
                if not ww or ww == "--":
                    continue
                try:
                    words_out.append(
                        {
                            "start": float(w.get("start", start)),
                            "end": float(w.get("end", end)),
                            "word": ww,
                        }
                    )
                except (TypeError, ValueError):
                    continue
            if words_out:
                seg["words"] = words_out
        indices.append(ci)
        segments.append(seg)
    return indices, segments


def _apply_word_level_fallback(
    cues: list[dict[str, Any]],
    aligned_segments: list[dict[str, Any]],
    cue_indices: list[int],
    original_times: dict[tuple[int, int], tuple[float, float]],
) -> int:
    """비정상 align 단어만 원본 Whisper 타임스탬프로 복원."""
    restored = 0
    for seg_i, ci in enumerate(cue_indices):
        if seg_i >= len(aligned_segments):
            break
        seg = aligned_segments[seg_i]
        if not isinstance(seg, dict):
            continue
        aligned_words = seg.get("words")
        if not isinstance(aligned_words, list):
            continue
        cue = cues[ci]
        if not isinstance(cue, dict):
            continue
        cue_words = cue.get("words")
        if not isinstance(cue_words, list):
            continue

        aw_i = 0
        for wi, cw in enumerate(cue_words):
            if not isinstance(cw, dict):
                continue
            if str(cw.get("word") or "").strip() in ("", "--"):
                continue
            if aw_i >= len(aligned_words):
                break
            aw = aligned_words[aw_i]
            aw_i += 1
            if not isinstance(aw, dict):
                continue
            try:
                ns = float(aw.get("start", cw.get("start", 0)))
                ne = float(aw.get("end", cw.get("end", 0)))
            except (TypeError, ValueError):
                orig = original_times.get((ci, wi))
                if orig:
                    cw["start"], cw["end"] = orig
                    restored += 1
                continue
            if _word_ts_abnormal(ns, ne):
                orig = original_times.get((ci, wi))
                if orig:
                    cw["start"], cw["end"] = orig
                    restored += 1
                else:
                    cw["start"], cw["end"] = ns, ne
            else:
                cw["start"], cw["end"] = round(ns, 3), round(ne, 3)
    return restored


def _merge_aligned_segments_into_cues(
    cues: list[dict[str, Any]],
    aligned_segments: list[dict[str, Any]],
    cue_indices: list[int],
    original_times: dict[tuple[int, int], tuple[float, float]],
) -> list[dict[str, Any]]:
    out = deepcopy(cues)
    for seg_i, ci in enumerate(cue_indices):
        if seg_i >= len(aligned_segments):
            break
        seg = aligned_segments[seg_i]
        if not isinstance(seg, dict):
            continue
        cue = out[ci]
        if not isinstance(cue, dict):
            continue
        try:
            cue["start"] = round(float(seg.get("start", cue.get("start", 0))), 3)
            cue["end"] = round(float(seg.get("end", cue.get("end", 0))), 3)
        except (TypeError, ValueError):
            pass
        text = str(seg.get("text") or "").strip()
        if text:
            cue["text"] = text

        aligned_words = seg.get("words")
        if not isinstance(aligned_words, list):
            continue
        cue_words = cue.get("words")
        if not isinstance(cue_words, list):
            cue_words = []
            cue["words"] = cue_words

        aw_i = 0
        new_words: list[dict[str, Any]] = []
        for wi, cw in enumerate(cue_words):
            if not isinstance(cw, dict):
                continue
            ww = str(cw.get("word") or "").strip()
            if cw.get("isSilence") is True or cw.get("is_silence") is True or ww == "--":
                new_words.append(dict(cw))
                continue
            if not ww:
                continue
            if aw_i >= len(aligned_words):
                new_words.append(dict(cw))
                continue
            aw = aligned_words[aw_i]
            aw_i += 1
            entry = dict(cw)
            if isinstance(aw, dict):
                try:
                    ns = float(aw.get("start", entry.get("start", 0)))
                    ne = float(aw.get("end", entry.get("end", 0)))
                except (TypeError, ValueError):
                    ns, ne = original_times.get((ci, wi), (float(entry.get("start", 0)), float(entry.get("end", 0))))
                else:
                    if _word_ts_abnormal(ns, ne):
                        orig = original_times.get((ci, wi))
                        if orig:
                            ns, ne = orig
                    entry["start"] = round(ns, 3)
                    entry["end"] = round(ne, 3)
                aw_word = str(aw.get("word") or "").strip()
                if aw_word:
                    entry["word"] = aw_word
            new_words.append(entry)
        while aw_i < len(aligned_words):
            aw = aligned_words[aw_i]
            aw_i += 1
            if isinstance(aw, dict):
                try:
                    new_words.append(
                        {
                            "start": round(float(aw.get("start", 0)), 3),
                            "end": round(float(aw.get("end", 0)), 3),
                            "word": str(aw.get("word") or "").strip(),
                        }
                    )
                except (TypeError, ValueError):
                    pass
        new_words.sort(key=lambda x: float(x.get("start", 0)))
        cue["words"] = new_words
        if new_words:
            cue["start"] = round(min(float(w["start"]) for w in new_words), 3)
            cue["end"] = round(max(float(w["end"]) for w in new_words), 3)

    _apply_word_level_fallback(out, aligned_segments, cue_indices, original_times)
    return out


def apply_stable_align_words(
    cues: list[dict[str, Any]],
    audio_path: str,
    fw_model: Any | None,
    *,
    language: str | None,
    model_path: str,
    failure_threshold: float = FAILURE_THRESHOLD,
) -> list[dict[str, Any]]:
    """
    stable-ts align_words — soft fallback: import/런타임 실패 시 cues 그대로 반환.
    """
    if not cues:
        return cues
    if fw_model is None:
        logger.warning("stable-ts align skipped: whisper model not loaded")
        return cues
    if not is_stable_ts_installed():
        logger.warning("stable-ts align skipped: package not installed")
        return cues

    cue_indices, segments = _cues_to_align_segments(cues)
    if not segments:
        return cues

    original_times = _snapshot_word_times(cues)

    try:
        wrapped = wrap_faster_whisper_for_stable(fw_model, model_path)
        aligned = wrapped.align_words(
            audio_path,
            segments,
            language=language,
            verbose=False,
            inplace=False,
            nonspeech_skip=0,
            failure_threshold=failure_threshold,
            suppress_silence=False,
            suppress_word_ts=False,
        )
        if hasattr(aligned, "to_dict"):
            aligned_dict = aligned.to_dict()
            aligned_segments = aligned_dict.get("segments") or []
        elif isinstance(aligned, dict):
            aligned_segments = aligned.get("segments") or []
        elif isinstance(aligned, list):
            aligned_segments = aligned
        else:
            logger.warning("stable-ts align returned unexpected type: %s", type(aligned))
            return cues
    except Exception as exc:
        logger.error(
            "stable-ts align_words failed (soft fallback to whisper TS): %s",
            exc,
            exc_info=True,
        )
        return cues

    merged = _merge_aligned_segments_into_cues(cues, aligned_segments, cue_indices, original_times)
    logger.debug(
        "stable-ts align_words: segments=%d cues=%d",
        len(aligned_segments),
        len(cue_indices),
    )
    return merged
