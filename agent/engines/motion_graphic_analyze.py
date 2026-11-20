"""모션그래픽 1단계 — 영상 분석 (토큰 0, 내 PC 에서 ffmpeg 만 사용).

motion-graphics 스킬의 「분석」 단계를 그대로 옮긴 것:
- 2fps · 160×90 그레이 프레임 차이(모션 스코어) → 실제로 움직이는 구간 / 거의 멈춘 구간
- 원본 fps 그대로 (29.97 영상을 30 으로 두면 끝에서 약 0.9초 어긋남)
- 자막 번호별 프레임(subs.json 과 같은 모양) + 자막별 움직임
- 장면 급변(컷) · 자막 없는 로고 인트로 후보
- 사용자 지시문(「0 ~ 41초 … 전면」)의 시간 범위 추출

순수 함수는 파일·프로세스 없이 테스트할 수 있게 분리했다.
"""
from __future__ import annotations

import re
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any, Iterable

SAMPLE_FPS = 2          # 모션 샘플링
STATIC_MAX = 1.0        # 이 값 아래면 사실상 정지 (0~255 평균 차이). 601화 실측: 정지 0.01~0.5, 조작 2~230
STATIC_MIN_SEC = 2.5    # 이보다 짧은 정지는 무시 (풀 모션 발동 최소 길이)
CUT_MIN = 40.0          # 한 샘플 차이가 이 이상이면 화면 급변(컷·전환)


# ── 순수 함수 ───────────────────────────────────────────────────────────

def parse_fps(text: str | None) -> Fraction:
    """ffprobe avg_frame_rate("30000/1001") → Fraction. 실패하면 30."""
    try:
        value = Fraction(str(text or "30"))
        if 1 <= value <= 240:
            return value.limit_denominator(1001)
    except (ValueError, ZeroDivisionError):
        pass
    return Fraction(30)


def to_frame(sec: float, fps: Fraction) -> int:
    return int(round(sec * float(fps)))


def parse_motion(text: str) -> list[tuple[float, float]]:
    """ffmpeg metadata=print 출력 → [(초, 평균 차이)]."""
    times = [float(x) for x in re.findall(r"pts_time:([0-9.]+)", text)]
    vals = [float(x) for x in re.findall(r"lavfi\.signalstats\.YAVG=([0-9.]+)", text)]
    return list(zip(times, vals))


def window(series: list[tuple[float, float]], a: float, b: float) -> list[float]:
    return [v for t, v in series if a <= t < b]


def motion_stats(series: list[tuple[float, float]], a: float, b: float) -> dict[str, float]:
    vals = window(series, a, b) or window(series, a - 0.5, b + 0.5)
    if not vals:
        return {"mean": 0.0, "max": 0.0, "moving": 0.0}
    moving = sum(1 for v in vals if v >= STATIC_MAX) / len(vals)
    return {"mean": round(sum(vals) / len(vals), 2), "max": round(max(vals), 2), "moving": round(moving, 2)}


def static_runs(series: list[tuple[float, float]], *, threshold: float = STATIC_MAX,
                min_sec: float = STATIC_MIN_SEC) -> list[tuple[float, float]]:
    """연속으로 threshold 아래인 구간 [(시작초, 끝초)]. 샘플 한 개짜리 튐(마우스 살짝)은 이어 붙인다."""
    runs: list[tuple[float, float]] = []
    start: float | None = None
    blips = 0
    step = 1.0 / SAMPLE_FPS
    last_t = 0.0
    for t, v in series:
        last_t = t
        if v < threshold:
            if start is None:
                start = t - step
            blips = 0
        elif start is not None and blips == 0 and v < threshold * 4:
            blips = 1  # 한 번은 봐준다
        else:
            if start is not None and t - step - start >= min_sec:
                runs.append((round(start, 2), round(t - step, 2)))
            start, blips = None, 0
    if start is not None and last_t - start >= min_sec:
        runs.append((round(start, 2), round(last_t, 2)))
    return runs


def cuts(series: list[tuple[float, float]], minimum: float = CUT_MIN, gap: float = 1.0) -> list[float]:
    """화면이 확 바뀐 시각(초). 가까운 것은 하나로."""
    out: list[float] = []
    for t, v in series:
        if v >= minimum and (not out or t - out[-1] > gap):
            out.append(round(t, 2))
    return out


def subs_table(cues: Iterable[Any], fps: Fraction) -> dict[int, dict[str, Any]]:
    """{번호: {s, e, t}} — s/e 는 원본 fps 프레임 (스킬의 subs.json)."""
    out: dict[int, dict[str, Any]] = {}
    for i, cue in enumerate(cues, start=1):
        start, end, text = cue.start, cue.end, cue.text
        out[i] = {"s": to_frame(start, fps), "e": to_frame(end, fps), "t": text, "a": round(start, 3), "b": round(end, 3)}
    return out


def logo_candidates(subs: dict[int, dict[str, Any]], cut_times: list[float], duration: float,
                    *, min_gap: float = 2.0, max_gap: float = 12.0) -> list[dict[str, Any]]:
    """자막이 비고 그 안이나 경계에 화면 급변이 있는 구간 — 로고 인트로(NONE) 후보. 앞쪽 40% 안에서만."""
    out = []
    keys = sorted(subs)
    for prev, nxt in zip(keys, keys[1:]):
        a, b = subs[prev]["b"], subs[nxt]["a"]
        if not (min_gap <= b - a <= max_gap) or a > duration * 0.4:
            continue
        inside = [c for c in cut_times if a - 1.5 <= c <= b + 1.5]
        if inside:
            out.append({"from_sec": a, "to_sec": b, "after_sub": prev, "before_sub": nxt, "cuts": inside})
    return out


# 「2분 06초」 「2분」 「41초」 「41」
_TIME = r"(?:(\d+)\s*분\s*(?:(\d+(?:\.\d+)?)\s*초?)?|(\d+(?:\.\d+)?)\s*초?)"
_RANGE_RE = re.compile(_TIME + r"\s*[~\-–]\s*" + _TIME)


def _sec(m: str | None, s: str | None, plain: str | None) -> float | None:
    if m is not None:
        return int(m) * 60 + float(s or 0)
    return float(plain) if plain is not None else None


def parse_directives(text: str) -> list[dict[str, Any]]:
    """사용자 지시문에서 「0 ~ 41초 …」, 「2분06초 ~2분58초 …」 같은 줄을 뽑는다.

    시간 표기가 엉성해도(「41~45초」 → 41초~45초) 받아 주고, 줄 나머지는 지시 내용으로 둔다.
    """
    out = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        m = _RANGE_RE.search(line)
        if not m or m.start() > 6:
            continue
        m1, s1, p1, m2, s2, p2 = m.groups()
        a, b = _sec(m1, s1, p1), _sec(m2, s2, p2)
        if a is None or b is None or b <= a:
            continue
        lower = line.lower()
        kind = None
        if any(k in line for k in ("전면", "배경 제거", "배경제거")):
            kind = "FULL"
        if any(k in line for k in ("적용하면 안", "적용 금지", "넣으면 안됨", "효과 적용하면 안")) and "로고" in line:
            kind = "NONE"
        if kind != "FULL" and any(k in line for k in ("확대", "하이라이트", "설명")):
            kind = kind or "OVERLAY"
        if "섞어" in line or "혼합" in line:
            kind = "MIXED"
        out.append({"from_sec": a, "to_sec": b, "kind": kind, "text": line[m.end():].strip(" -:·") or line,
                    "blur": "블러" in lower})
    return out


def boundary_candidates(sec: float, subs: dict[int, dict[str, Any]], cut_times: list[float],
                        statics: list[tuple[float, float]], *, within: float = 15.0) -> list[dict[str, Any]]:
    """지시 시간 경계 근처의 실제 경계 후보 — 가장 가까운 문장 경계, 화면 급변, 정지 구간 끝.

    지시 시간은 편집 전 기준이라 10초 넘게 어긋나기도 한다(601화: 「0~41초 오프닝」 → 실제 로고 직전 52.08초).
    하나로 정하지 않고 종류별 후보를 넘겨 설계 단계(AI·사용자)가 고르게 한다.
    """
    out: list[dict[str, Any]] = []
    sentence = [(abs(e - sec), e, f"#{n} {k}") for n, s in subs.items()
                for e, k in ((s["a"], "시작"), (s["b"], "끝")) if abs(e - sec) <= within]
    if sentence:
        d, e, by = min(sentence)
        out.append({"sec": round(e, 2), "by": f"문장 {by}", "shift": round(e - sec, 2)})
    near_cuts = [c for c in cut_times if abs(c - sec) <= within]
    if near_cuts:
        c = min(near_cuts, key=lambda x: abs(x - sec))
        out.append({"sec": c, "by": "화면 급변", "shift": round(c - sec, 2)})
    edges = [e for a, b in statics for e in (a, b) if abs(e - sec) <= within]
    if edges:
        e = min(edges, key=lambda x: abs(x - sec))
        out.append({"sec": e, "by": "정지 구간 경계", "shift": round(e - sec, 2)})
    return out


def classify_hint(stats: dict[str, float]) -> str:
    """구간 움직임 → 스킬 규칙상 기본 판단. 최종 결정은 설계(AI·사용자)."""
    if stats["max"] < STATIC_MAX or stats["moving"] < 0.08:
        return "FULL"  # 멈춰 있고 말만 함
    return "OVERLAY"   # 실제 조작이 보임


# ── ffmpeg ─────────────────────────────────────────────────────────────

def measure_motion(ffmpeg: Path, video: Path, *, creationflags: int = 0) -> list[tuple[float, float]]:
    vf = (f"fps={SAMPLE_FPS},scale=160:90,format=gray,tblend=all_mode=difference,signalstats,"
          "metadata=print:key=lavfi.signalstats.YAVG:file=-")
    proc = subprocess.run([str(ffmpeg), "-hide_banner", "-nostats", "-i", str(video), "-an", "-vf", vf, "-f", "null", "-"],
                          capture_output=True, timeout=3600, creationflags=creationflags)
    return parse_motion(proc.stdout.decode("utf-8", "replace"))


def analyze(cues: list[Any], series: list[tuple[float, float]], *, fps: Fraction, duration: float,
            directives_text: str = "") -> dict[str, Any]:
    subs = subs_table(cues, fps)
    for s in subs.values():
        s.update(motion_stats(series, s["a"], s["b"]))
    cut_times = cuts(series)
    statics = static_runs(series)
    directives = parse_directives(directives_text)
    for d in directives:
        d["from_candidates"] = boundary_candidates(d["from_sec"], subs, cut_times, statics)
        d["to_candidates"] = boundary_candidates(d["to_sec"], subs, cut_times, statics)
    return {
        "fps": {"num": fps.numerator, "den": fps.denominator, "value": round(float(fps), 5)},
        "duration_sec": round(duration, 3),
        "duration_frames": to_frame(duration, fps),
        "sample_fps": SAMPLE_FPS,
        "motion": [round(v, 2) for _, v in series],
        "static_runs": [{"from_sec": a, "to_sec": b, "sec": round(b - a, 1)} for a, b in statics],
        "cuts": cut_times,
        "logo_candidates": logo_candidates(subs, cut_times, duration),
        "subs": subs,
        "directives": directives,
    }
