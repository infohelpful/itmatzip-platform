"""모션그래픽도구 — 순수 로직 (SRT 압축·청킹·오디오 스냅·설계서 검증). I/O 없음 → 단위 테스트 대상.

docs/motion-graphic-spec.md §5 의 초경량 입출력 규격을 구현한다.
"""

from __future__ import annotations

import math
import re
import secrets
from dataclasses import dataclass
from typing import Any, Callable, Iterable

FPS = 30
CHUNK_FRAMES = 3 * 60 * FPS  # 3분 = 5,400 프레임
CHUNK_SEARCH_WINDOW = 45 * FPS  # 경계는 목표 지점 ±45초 안의 가장 긴 SRT 휴지기
POSITIONS = ("TL", "TC", "TR", "ML", "MC", "MR", "BL", "BC", "BR")
MAX_VAR_LEN = 200
MAX_TRACKS = 400
SNAP_WINDOW = 6  # AI 가 잡은 시작 프레임 ±6(0.2초) 안의 실제 발화 시작점으로 자석 스냅
IMAGE_VARS = frozenset({"img"})
_SAFE_ASSET_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")
_TRACK_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


# ── SRT ────────────────────────────────────────────────────────────────

_TS_RE = re.compile(
    r"(?P<a>\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*"
    r"(?P<b>\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})"
)
_TAG_RE = re.compile(r"<[^>]+>|\{\\[^}]*\}")


def _ts_to_sec(raw: str) -> float:
    raw = raw.replace(",", ".")
    parts = raw.split(":")
    if len(parts) == 2:
        parts.insert(0, "0")
    hh, mm, rest = parts
    sec, _, frac = rest.partition(".")
    frac = (frac + "000")[:3]
    return int(hh) * 3600 + int(mm) * 60 + int(sec) + int(frac) / 1000.0


@dataclass(frozen=True)
class Cue:
    start: float
    end: float
    text: str


def parse_srt(text: str) -> list[Cue]:
    """SRT(및 단순 WebVTT) → 시간순 Cue 목록. 번호·서식 태그 제거, 여러 줄은 공백으로 합친다."""
    # 줄바꿈이 \r\r\n 처럼 겹쳐 번호·시간·문장 사이에 빈 줄이 생겨도 읽히도록, 빈 줄이 아니라 시간 줄을 기준으로 나눈다.
    text = (text or "").lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    marks = [(i, m) for i, ln in enumerate(lines) if (m := _TS_RE.search(ln))]
    cues: list[Cue] = []
    for k, (i, m) in enumerate(marks):
        stop = marks[k + 1][0] if k + 1 < len(marks) else len(lines)
        body_lines = [ln.strip() for ln in lines[i + 1:stop] if ln.strip()]
        if k + 1 < len(marks) and body_lines and body_lines[-1].isdigit():
            body_lines.pop()  # 다음 자막 번호
        body = re.sub(r"\s+", " ", " ".join(_TAG_RE.sub("", ln) for ln in body_lines)).strip()
        start, end = _ts_to_sec(m.group("a")), _ts_to_sec(m.group("b"))
        if body and end > start:
            cues.append(Cue(start, end, body))
    cues.sort(key=lambda c: (c.start, c.end))
    return cues


def cues_to_lines(cues: Iterable[Cue], fps: int = FPS) -> list[dict[str, Any]]:
    """시간 문자열·번호를 버리고 [시작프레임, 끝프레임] + 문장만 남긴다."""
    out: list[dict[str, Any]] = []
    for cue in cues:
        a = int(round(cue.start * fps))
        b = max(a + 1, int(round(cue.end * fps)) - 1)
        out.append({"f": [a, b], "s": cue.text})
    return out


# ── 청킹 ───────────────────────────────────────────────────────────────

def plan_chunks(lines: list[dict[str, Any]], total_frames: int,
                target: int = CHUNK_FRAMES, window: int = CHUNK_SEARCH_WINDOW) -> list[list[int]]:
    """약 3분 단위 [시작, 끝) 청크. 경계는 목표 지점 근처의 가장 긴 SRT 휴지기 한가운데."""
    total_frames = max(1, int(total_frames))
    if total_frames <= target + window // 2:
        return [[0, total_frames]]
    gaps: list[tuple[int, int]] = []  # (gap_len, mid)
    for prev, nxt in zip(lines, lines[1:]):
        gap = nxt["f"][0] - prev["f"][1]
        if gap > 0:
            gaps.append((gap, (prev["f"][1] + nxt["f"][0]) // 2))
    bounds = [0]
    cursor = 0
    while total_frames - cursor > target + window // 2:
        goal = cursor + target
        candidates = [(g, mid) for g, mid in gaps if goal - window <= mid <= goal + window and mid > cursor + target // 2]
        if candidates:
            best = max(candidates, key=lambda gm: (gm[0], -abs(gm[1] - goal)))[1]
        else:
            best = goal
        bounds.append(best)
        cursor = best
    bounds.append(total_frames)
    return [[bounds[i], bounds[i + 1]] for i in range(len(bounds) - 1)]


def chunk_of_frame(chunks: list[list[int]], frame: int) -> int:
    for idx, (a, b) in enumerate(chunks):
        if a <= frame < b:
            return idx
    return max(0, len(chunks) - 1)


# ── 키프레임 매핑 ──────────────────────────────────────────────────────

def assign_keyframes(lines: list[dict[str, Any]], keyframes: list[tuple[float, str]], fps: int = FPS) -> None:
    """각 줄에 그 시점 화면 키프레임 파일명을 붙인다. 직전 줄과 같은 화면이면 "SAME"(이미지 생략)."""
    kfs = sorted(keyframes)
    prev_name: str | None = None
    for line in lines:
        t = (line["f"][0] + 0.5 * fps) / fps
        name = None
        for kt, kname in kfs:
            if kt <= t:
                name = kname
            else:
                break
        if name is None and kfs:
            name = kfs[0][1]
        if name is None:
            continue
        line["img"] = "SAME" if name == prev_name else name
        prev_name = name


# ── 오디오 분석 (Silence Detector 와 같은 FFmpeg PCM 기반) ─────────────

def frame_levels_db(pcm: bytes, sample_rate: int, fps: int = FPS) -> list[float]:
    """s16le mono PCM → 프레임(1/fps 초)당 RMS dBFS."""
    import array
    import warnings

    pcm = pcm[: len(pcm) - (len(pcm) % 2)]
    hop = max(1, int(round(sample_rate / fps)))
    out: list[float] = []
    try:  # Python 3.12 엔진에는 audioop(C 구현)이 있다 — 15분 영상도 1초 안쪽
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            import audioop  # type: ignore[import-not-found]
        step = hop * 2
        for i in range(0, len(pcm), step):
            rms = audioop.rms(pcm[i:i + step], 2)
            out.append(20 * math.log10(rms / 32768.0) if rms > 0 else -96.0)
        return out
    except ImportError:
        pass
    samples = array.array("h")
    samples.frombytes(pcm)
    for i in range(0, len(samples), hop):
        chunk = samples[i:i + hop]
        if not chunk:
            break
        acc = 0
        for v in chunk:
            acc += v * v
        rms = math.sqrt(acc / len(chunk))
        out.append(20 * math.log10(rms / 32768.0) if rms > 0 else -96.0)
    return out


def _percentile(values: list[float], p: float) -> float:
    if not values:
        return -96.0
    s = sorted(values)
    k = min(len(s) - 1, max(0, int(round((len(s) - 1) * p))))
    return s[k]


def detect_onsets(levels: list[float], *, min_quiet: int = 5) -> list[int]:
    """조용한 구간(min_quiet 프레임 이상) 뒤 음성이 시작되는 프레임 = 발화 시작점."""
    if not levels:
        return []
    floor = _percentile(levels, 0.15)
    peak = _percentile(levels, 0.95)
    thr = max(floor + 8.0, min(-38.0, peak - 25.0))
    onsets: list[int] = []
    quiet = min_quiet
    for i, v in enumerate(levels):
        if v < thr:
            quiet += 1
            continue
        if quiet >= min_quiet:
            onsets.append(i)
        quiet = 0
    return onsets


def emphasis_peaks(levels: list[float], *, min_gap: int = 15, limit_per_minute: int = 8) -> list[int]:
    """상위 8% 음량 국소 최대 — 강조 발화 후보 프레임."""
    if len(levels) < 3:
        return []
    thr = _percentile(levels, 0.92)
    cands = [i for i in range(1, len(levels) - 1)
             if levels[i] >= thr and levels[i] >= levels[i - 1] and levels[i] >= levels[i + 1]]
    cands.sort(key=lambda i: -levels[i])
    limit = max(4, int(len(levels) / (60 * FPS) * limit_per_minute))
    chosen: list[int] = []
    for i in cands:
        if all(abs(i - c) >= min_gap for c in chosen):
            chosen.append(i)
        if len(chosen) >= limit:
            break
    return sorted(chosen)


def waveform_u8(levels: list[float]) -> list[int]:
    """-60..0 dB → 0..255 (UI 파형용)."""
    return [int(round(max(0.0, min(1.0, (v + 60.0) / 60.0)) * 255)) for v in levels]


def snap_frame(frame: int, onsets: list[int], window: int = SNAP_WINDOW) -> int:
    best = frame
    best_d = window + 1
    for o in onsets:
        d = abs(o - frame)
        if d < best_d:
            best, best_d = o, d
        elif o > frame + window:
            break
    return best if best_d <= window else frame


# ── 프리셋 카탈로그 / 설계서 검증 ──────────────────────────────────────

class BlueprintError(ValueError):
    pass


def new_track_id() -> str:
    return "t_" + secrets.token_hex(3)


def preset_index(builtin: list[dict[str, Any]], user: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    idx = {p["id"]: p for p in builtin}
    for p in user:
        base = idx.get(p.get("base", ""))
        if base:
            idx[p["id"]] = {**base, **{k: v for k, v in p.items() if k in ("id", "name", "desc", "cat", "tags", "base", "template")}}
    return idx


def is_safe_asset_name(name: str) -> bool:
    return bool(_SAFE_ASSET_RE.match(name or "")) and ".." not in name


def validate_track(raw: Any, presets: dict[str, dict[str, Any]], total_frames: int,
                   asset_exists: Callable[[str], bool]) -> dict[str, Any]:
    """AI/웹이 보낸 트랙 1개를 정규화. 코드(TSX/CSS)·임의 키는 버린다."""
    if not isinstance(raw, dict):
        raise BlueprintError("트랙은 객체여야 합니다.")
    preset_id = str(raw.get("preset") or "").strip()
    preset = presets.get(preset_id)
    if not preset:
        raise BlueprintError(f"알 수 없는 프리셋: {preset_id!r} (motion_search_presets 로 확인)")
    f = raw.get("f")
    if (not isinstance(f, (list, tuple)) or len(f) != 2
            or not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in f)):
        raise BlueprintError(f"{preset_id}: f 는 [시작프레임, 끝프레임] 이어야 합니다.")
    a, b = int(f[0]), int(f[1])
    a = max(0, min(a, total_frames - 1))
    b = max(0, min(b, total_frames - 1))
    if b - a < 10:
        raise BlueprintError(f"{preset_id}: 구간이 너무 짧습니다(최소 10프레임). f={list(f)}")
    tid = str(raw.get("id") or "").strip()
    if not _TRACK_ID_RE.match(tid):
        tid = new_track_id()
    template = preset.get("template") or {}
    pos = str(raw.get("pos") or template.get("pos") or preset.get("pos") or "MC").upper()
    if pos not in POSITIONS:
        raise BlueprintError(f"{preset_id}: pos 는 {'/'.join(POSITIONS)} 중 하나여야 합니다.")
    allowed = set(preset.get("vars") or [])
    vars_in = raw.get("vars") or {}
    if not isinstance(vars_in, dict):
        raise BlueprintError(f"{preset_id}: vars 는 객체여야 합니다.")
    unknown = sorted(set(vars_in) - allowed)
    if unknown:
        raise BlueprintError(f"{preset_id}: 허용되지 않은 vars {unknown}. 사용 가능: {sorted(allowed)}")
    clean_vars: dict[str, str] = {}
    for key, value in vars_in.items():
        if value is None:
            continue
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            value = str(value)
        if not isinstance(value, str):
            raise BlueprintError(f"{preset_id}.{key}: 문자열이어야 합니다.")
        value = value.strip()[:MAX_VAR_LEN]
        if key in IMAGE_VARS and value:
            if not is_safe_asset_name(value) or not asset_exists(value):
                raise BlueprintError(f"{preset_id}.{key}: 프로젝트 assets 에 없는 이미지입니다: {value!r}")
        clean_vars[key] = value
    track: dict[str, Any] = {"id": tid, "f": [a, b], "preset": preset_id, "pos": pos, "vars": clean_vars}
    if preset.get("base"):
        track["base"] = preset["base"]
    return track


def validate_tracks(raws: Any, presets: dict[str, dict[str, Any]], total_frames: int,
                    asset_exists: Callable[[str], bool]) -> list[dict[str, Any]]:
    if not isinstance(raws, list):
        raise BlueprintError("tracks 는 배열이어야 합니다.")
    if len(raws) > MAX_TRACKS:
        raise BlueprintError(f"트랙은 최대 {MAX_TRACKS}개입니다.")
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    errors: list[str] = []
    for i, raw in enumerate(raws):
        try:
            track = validate_track(raw, presets, total_frames, asset_exists)
        except BlueprintError as exc:
            errors.append(f"tracks[{i}]: {exc}")
            continue
        while track["id"] in seen:
            track["id"] = new_track_id()
        seen.add(track["id"])
        out.append(track)
    if errors:
        raise BlueprintError("; ".join(errors[:12]))
    return out


def snap_tracks(tracks: list[dict[str, Any]], onsets: list[int], total_frames: int) -> int:
    """시작 프레임을 실제 발화 시작점에 스냅. 이동한 트랙 수 반환 (길이는 유지)."""
    moved = 0
    for t in tracks:
        a, b = t["f"]
        na = snap_frame(a, onsets)
        if na != a:
            shift = na - a
            t["f"] = [na, max(na + 10, min(total_frames - 1, b + shift))]
            moved += 1
    return moved


def merge_chunk(existing: list[dict[str, Any]], incoming: list[dict[str, Any]],
                chunk: list[int] | None) -> list[dict[str, Any]]:
    """chunk 가 주어지면 그 청크에서 시작하는 기존 트랙을 incoming 으로 교체(재적용해도 중복 없음)."""
    if chunk is None:
        keep = list(existing)
    else:
        a, b = chunk
        keep = [t for t in existing if not (a <= t["f"][0] < b)]
    ids = {t["id"] for t in keep}
    for t in incoming:
        while t["id"] in ids:
            t["id"] = new_track_id()
        ids.add(t["id"])
    merged = keep + incoming
    merged.sort(key=lambda t: (t["f"][0], t["f"][1]))
    return merged


# ── 렌더 구간 ──────────────────────────────────────────────────────────

def render_segments(tracks: list[dict[str, Any]], total_frames: int, *,
                    gap: int = 15, max_segments: int = 40) -> list[tuple[int, int]]:
    """트랙 구간을 합쳐 (시작, 길이) 오버레이 렌더 구간을 만든다. 트랙 없는 구간은 렌더하지 않는다."""
    spans = sorted((max(0, t["f"][0]), min(total_frames - 1, t["f"][1])) for t in tracks)
    spans = [(a, b) for a, b in spans if b > a]
    if not spans:
        return []
    merge_gap = gap
    while True:
        merged: list[list[int]] = []
        for a, b in spans:
            if merged and a <= merged[-1][1] + merge_gap:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        if len(merged) <= max_segments:
            break
        merge_gap *= 2
    return [(a, b - a + 1) for a, b in merged]


# ── 프리셋 변수화 ──────────────────────────────────────────────────────

def variabilize(track: dict[str, Any], preset: dict[str, Any]) -> dict[str, Any]:
    """잘 나온 트랙 → 재활용 템플릿. 값은 {{var}} 플레이스홀더로, 원래 값은 예시로 남긴다."""
    vars_ = list(preset.get("vars") or [])
    example = {k: v for k, v in (track.get("vars") or {}).items() if k in vars_}
    return {
        "pos": track.get("pos") or preset.get("pos") or "MC",
        "dur": int(track["f"][1] - track["f"][0]),
        "vars": {k: "{{" + k + "}}" for k in vars_},
        "example": example,
    }


def summarize_preset(p: dict[str, Any]) -> dict[str, Any]:
    """AI 에 넘길 최소 요약 (토큰 절감)."""
    out = {"id": p["id"], "desc": p.get("desc") or p.get("name") or "", "vars": list(p.get("vars") or []),
           "cat": p.get("cat"), "mode": p.get("mode"), "pos": (p.get("template") or {}).get("pos") or p.get("pos"),
           "dur": (p.get("template") or {}).get("dur") or p.get("dur")}
    if p.get("base"):
        out["base"] = p["base"]
    return out


CATEGORY_ALIASES = {
    "intro": "intro", "인트로": "intro", "오프닝": "intro",
    "compare": "compare", "비교": "compare", "vs": "compare",
    "emphasis": "emphasis", "강조": "emphasis", "하이라이트": "emphasis",
    "chart": "chart", "차트": "chart", "그래프": "chart", "숫자": "chart",
    "info": "info", "정보": "info", "카드": "info", "이미지": "info",
}


def filter_presets(presets: Iterable[dict[str, Any]], tag: str | None) -> list[dict[str, Any]]:
    tag = (tag or "").strip().lower()
    if not tag:
        return list(presets)
    cat = CATEGORY_ALIASES.get(tag)
    out = []
    for p in presets:
        hay = " ".join([p.get("id", ""), p.get("name", ""), p.get("desc", ""), " ".join(p.get("tags") or [])]).lower()
        if (cat and p.get("cat") == cat) or tag in hay:
            out.append(p)
    return out
