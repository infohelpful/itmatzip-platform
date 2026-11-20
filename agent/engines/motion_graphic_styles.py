"""모션그래픽 디자인(스타일) — AI 가 영상마다 만든 디자인의 검증과, 이전 작업 보관함.

- 디자인 = {name, colors(bg·deep·primary·sky·accent·text·text2·ok·bad·warn), bg(배경 종류), energy(움직임 세기), reason}
- AI 가 만든 색은 그대로 쓰지 않고 코드가 대비를 검증한다: 배경은 어둡게, 글자는 밝게(대비 7:1), 강조색은 4.5:1 이상.
- 작업 내역: MP4 내보내기까지 끝낸 프로젝트의 설계서에서 읽는다(저장 버튼 없음). 사용자의 이전 작업 두 개(시네마틱 블루 · 민트)가 기본으로 함께 나온다.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from engines import motion_graphic as mg

BG_KINDS = ("aurora", "grid", "particles", "waves")
COLOR_KEYS = ("bg", "deep", "primary", "sky", "accent", "text", "text2", "ok", "bad", "warn")
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
_DEFAULT = {"bg": "#001E3C", "deep": "#0F3A73", "primary": "#0078D4", "sky": "#00A4EF", "accent": "#50E6FF", "text": "#EAF3FF",
            "text2": "#A9C3E3", "ok": "#3DDC97", "bad": "#FF5A6A", "warn": "#FFB020"}

SEEDS = [
    {"id": "seed_blue", "name": "시네마틱 테크 블루", "note": "윈도우·PC·IT 리뷰 (컴테크 592화)", "bg": "aurora", "energy": 1.0,
     "colors": {"bg": "#001E3C", "deep": "#0F3A73", "primary": "#0078D4", "sky": "#00A4EF", "accent": "#50E6FF", "text": "#EAF3FF",
                "text2": "#A9C3E3", "ok": "#3DDC97", "bad": "#FF5A6A", "warn": "#FFB020"}},
    {"id": "seed_mint", "name": "민트 웨이브", "note": "웹 도구·오디오·파형 (601화 무음 자동 제거)", "bg": "waves", "energy": 1.0,
     "colors": {"bg": "#04121a", "deep": "#0b3a3a", "primary": "#1f9e82", "sky": "#39dfbb", "accent": "#7cffe0", "text": "#e8fff8",
                "text2": "#a6cfc6", "ok": "#3ddc97", "bad": "#ff5a6a", "warn": "#ffb020"}},
]


# ── 색 계산 ────────────────────────────────────────────────────────────

def _rgb(h: str) -> tuple[float, float, float]:
    return tuple(int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))  # type: ignore[return-value]


def _hex(rgb: tuple[float, float, float]) -> str:
    return "#" + "".join(f"{max(0, min(255, round(v * 255))):02x}" for v in rgb)


def luminance(h: str) -> float:
    def f(v: float) -> float:
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (f(v) for v in _rgb(h))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def _mix(a: str, b: str, k: float) -> str:
    ra, rb = _rgb(a), _rgb(b)
    return _hex(tuple(x + (y - x) * k for x, y in zip(ra, rb)))  # type: ignore[arg-type]


def _ensure_contrast(color: str, against: str, minimum: float, toward: str) -> str:
    for k in [i / 10 for i in range(0, 11)]:
        c = _mix(color, toward, k)
        if contrast(c, against) >= minimum:
            return c
    return toward


def normalize_style(raw: Any, fallback: dict[str, Any] | None = None) -> dict[str, Any]:
    """AI 가 준 디자인을 안전한 값으로 고친다. 형식이 틀리면 fallback(없으면 기본 블루)을 쓴다."""
    base = fallback or {"name": "새 디자인", "bg": "aurora", "energy": 1.0, "colors": dict(_DEFAULT)}
    if not isinstance(raw, dict):
        return json.loads(json.dumps(base))
    src = raw.get("colors") if isinstance(raw.get("colors"), dict) else {}
    colors = {k: (src[k] if isinstance(src.get(k), str) and _HEX.match(src[k]) else base["colors"][k]) for k in COLOR_KEYS}
    # 배경은 어두운 톤 (글래스 카드·글자가 보이도록), 너무 밝으면 어둡게
    if luminance(colors["bg"]) > 0.08:
        colors["bg"] = _mix(colors["bg"], "#000000", 0.82)
    if luminance(colors["deep"]) > 0.25:
        colors["deep"] = _mix(colors["deep"], colors["bg"], 0.5)
    colors["text"] = _ensure_contrast(colors["text"], colors["bg"], 7.0, "#ffffff")
    colors["text2"] = _ensure_contrast(colors["text2"], colors["bg"], 4.5, "#ffffff")
    for k in ("primary", "sky", "accent"):
        colors[k] = _ensure_contrast(colors[k], colors["bg"], 3.0 if k == "primary" else 4.5, "#ffffff")
    try:
        energy = max(0.6, min(1.4, float(raw.get("energy", 1.0))))
    except (TypeError, ValueError):
        energy = 1.0
    bg = raw.get("bg") if raw.get("bg") in BG_KINDS else base.get("bg", "aurora")
    return {"name": str(raw.get("name") or base.get("name") or "새 디자인")[:30], "bg": bg, "energy": round(energy, 2),
            "reason": str(raw.get("reason") or "")[:300], "colors": colors}


# ── 작업 내역 (지금까지 만든 프로젝트의 디자인) ─────────────────────────

def _project_style(design: dict[str, Any]) -> dict[str, Any] | None:
    raw = design.get("style")
    if isinstance(raw, dict) and isinstance(raw.get("colors"), dict):
        return normalize_style(raw)
    if isinstance(raw, str):  # 예전 설계서의 고정 프리셋 id
        from engines import motion_graphic_design as mgd
        old = mgd.catalog()["styles"].get(raw)
        if old:
            return {"name": old["label"], "bg": "aurora", "energy": 1.0, "colors": {**_DEFAULT, **old["colors"]}}
    return None


def list_styles(exclude: str | None = None) -> list[dict[str, Any]]:
    """MP4 내보내기까지 끝낸 프로젝트들(최근 순) + 사용자의 이전 작업 두 개. 저장 버튼 없이 내보낼 때마다 자동으로 쌓인다."""
    items: list[dict[str, Any]] = []
    root = mg.projects_root()
    if root.is_dir():
        for d in root.iterdir():
            if not d.is_dir() or d.name == exclude:
                continue
            if not (d / "output.mp4").is_file():  # MP4 내보내기를 끝낸 작업만 내역에 올린다
                continue
            design = mg._read_json(d / "design.json")
            meta = mg._read_json(d / "project.json")
            if not (isinstance(design, dict) and design.get("version") == 2 and isinstance(meta, dict)):
                continue
            style = _project_style(design)
            if not style:
                continue
            video = str(meta.get("video_name") or d.name)
            items.append({"id": d.name, "name": Path(video).stem, "style_name": style["name"], "bg": style["bg"], "energy": style["energy"],
                          "colors": style["colors"], "created": str(design.get("updated") or meta.get("created") or ""),
                          "duration_sec": meta.get("duration_sec"), "seed": False})
    items.sort(key=lambda x: x["created"], reverse=True)
    for seed in SEEDS:
        items.append({**seed, "style_name": seed["name"], "name": seed["note"], "created": "", "seed": True})
    return items


def get_style(style_id: str) -> dict[str, Any] | None:
    if not re.match(r"^[A-Za-z0-9_]{1,40}$", style_id or ""):
        return None
    return next((x for x in list_styles() if x["id"] == style_id), None)


def as_design(item: dict[str, Any]) -> dict[str, Any]:
    """작업 내역 항목 → 설계서 style 객체 (그 작업의 색·배경·움직임 그대로)"""
    return {"name": item["style_name"], "bg": item.get("bg", "aurora"), "energy": item.get("energy", 1.0), "colors": item["colors"],
            "ref": item["id"], "ref_name": item["name"]}
