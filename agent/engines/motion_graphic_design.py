"""모션그래픽 설계 — 스타일 프리셋 + 고정 장면 템플릿에 「구간 · 템플릿 · 문구 · 타이밍」만 매핑한다.

흐름 (화면 순서와 같다)
  1. 영상 + SRT 업로드 → 전처리(motion_graphic.py): 화면 움직임·정지 구간·로고 후보 (토큰 0)
  2. 스타일 프리셋 선택 (mg-core.js STYLES)
  3. 설계하기: AI CLI 1회 호출 → 구간 FULL/OVERLAY/NONE + FULL 템플릿·문구 + 비트(자막 번호) + OVERLAY 효과 종류
     → 자막·장면·소재 품질 검사와 자동 보정
     · 카메라·좌표는 AI 가 정하지 않는다. FULL 은 템플릿 코드가, OVERLAY 하이라이트 위치는 화면 변화 측정(로컬)이 정한다.
  4. 수정 요청: 「이 구간/지금 시점 ○○ 해줘」 → 그 구간 JSON 만 AI 가 고침 (전체 재실행 없음)
  5. 설계대로 적용 → 미리보기 (mg-core.js composeFrame, 렌더와 같은 코드)
  6. MP4 내보내기 → motion_graphic.start_render (적용된 설계서가 있어야만)
"""
from __future__ import annotations

import copy
import json
import re
import subprocess
import sys
import threading
import time
import uuid
from fractions import Fraction
from pathlib import Path
from typing import Any

from common.bin_manager import get_ffmpeg_exe
from common.subprocess_util import no_window_creationflags
from engines import motion_graphic as mg
from engines import motion_graphic_ai as mai
from engines import motion_graphic_analyze as mga
from engines import motion_graphic_assets as mgassets
from engines import motion_graphic_styles as mgstyles
from engines import motion_graphic_ctx as mgx

TYPES = ("FULL", "OVERLAY", "NONE")

# 소재 방식 — 이미지·아이콘을 어떻게 구하나. 프롬프트로 부탁하는 것에 더해 코드가 다운로드를 직접 걸러낸다.
MEDIA_MODES = ("photo", "logo", "emoji", "video")
QUERY_RULES = ("검색어 규칙(중요): 로고·제품·앱 화면의 q 는 정확한 영문 고유명사 1~4단어(예: 「Corsair logo」, 「Windows 11 Start menu」). "
                "사진·영상의 q 는 실제 화면에 보일 대상과 행동을 2~5단어로(예: 「server rack closeup」, 「person using laptop」). "
                "context 에는 이 장면에서 보여줘야 할 구체적 시각 요소를 영문으로 적습니다. 추상적인 사양표·차트·포럼 댓글은 "
                "억지 스톡 사진으로 채우지 말고 NUMBER·COMPARE·CHECKLIST 같은 그래픽 템플릿을 쓰세요. "
                "사진·영상은 장면 내용과 직접 맞을 때만 요청하고, 같은 이미지를 반복 요청하지 마세요.\n")


MEDIA_RULES = {
    "photo": "",
    "video": "소재 규칙: 로고·사진·스크린샷을 기본으로 쓰되, 움직임 자체가 설명에 도움이 되는 FULL 장면 1~3곳에만 "
             "kind=video 를 요청하세요. 영상은 PHOTO_POINTS·IMAGE_CARDS·SHOWCASE 의 img 자리에만 넣고 아이콘·로고 자리에는 넣지 마세요. "
             "영상 후보가 없으면 같은 주제의 사진으로 대체됩니다.\n\n",
    "logo": "소재 규칙(위 이미지 지침보다 우선): assets 에는 kind 가 logo 인 것만 적으세요(회사·제품·앱 로고). 사진·스크린샷은 요청하지 마세요 — "
            "사진 자리는 원본 화면에 실제 조작이 있을 때만 캡처하고, 그 밖에는 그래픽 장면으로 바뀝니다. 아이콘 변수는 이모지로 채워도 됩니다.\n\n",
    "emoji": "소재 규칙(위 이미지 지침보다 우선): 웹에서 이미지를 받지 않습니다. assets 는 빈 배열 [] 로 두고 vars 에 asset: 을 쓰지 마세요. "
            "아이콘 변수(i1, left_icon 등)는 이모지 1개로, 로고 자리(logo1…)에는 회사·제품 이름 글자를 넣으세요. "
            "사진이 필요한 자리는 원본 화면에 실제 조작이 있을 때만 캡처하고, 그 밖에는 그래픽 장면으로 바뀝니다.\n\n",
}


def filter_assets(wanted: list[dict[str, Any]], media: str) -> list[dict[str, Any]]:
    """소재 방식에 맞지 않는 다운로드 요청은 AI 가 적었더라도 버린다."""
    if media == "emoji":
        return []
    if media == "logo":
        return [a for a in wanted if str(a.get("kind") or "").lower() == "logo"]
    if media == "photo":
        return [a for a in wanted if str(a.get("kind") or "").lower() != "video"]
    return wanted
LEAD_FRAMES = 3
_CALL_TIMEOUT = 600
CATALOG_PATH = Path(__file__).resolve().parent / "motion_graphic_core" / "catalog.json"

_lock = threading.Lock()
_jobs: dict[str, dict[str, Any]] = {}
_project_job: dict[str, str] = {}


def catalog() -> dict[str, Any]:
    """mg-core.js 의 STYLES · TEMPLATE_META · OVERLAY_FX 를 그대로 옮긴 JSON (mg-core.test.mjs 가 일치 검사)."""
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))


# ── 분석 확보 ──────────────────────────────────────────────────────────

def _cues(pid: str) -> list[Any]:
    return mgx.parse_srt((mg.project_dir(pid) / "assets" / "source.srt").read_text(encoding="utf-8"))


def ensure_analysis(pid: str) -> dict[str, Any]:
    path = mg.project_dir(pid) / "analysis.json"
    data = mg._read_json(path)
    if isinstance(data, dict) and data.get("subs"):
        return data
    meta = mg.load_project(pid)
    series = mga.measure_motion(get_ffmpeg_exe(), Path(meta["video_path"]), creationflags=no_window_creationflags())
    data = mga.analyze(_cues(pid), series, fps=mga.parse_fps(meta.get("src_fps")), duration=float(meta["duration_sec"]))
    data["width"], data["height"] = meta["w"], meta["h"]
    mg._write_json(path, data)
    return data


def _subs(analysis: dict[str, Any]) -> dict[int, dict[str, Any]]:
    return {int(k): v for k, v in analysis["subs"].items()}


def _fps(analysis: dict[str, Any]) -> Fraction:
    return Fraction(analysis["fps"]["num"], analysis["fps"]["den"])


def _ts(sec: float) -> str:
    return f"{int(sec // 60)}:{sec % 60:05.2f}"


def _template_brief(cat: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"id": t["id"], "desc": t["desc"], "vars": {k: f"최대 {n}자" for k, n in t["max"].items()}, "slots": t["slots"]}
            for t in cat["templates"]]


# ── 설계 프롬프트 (1회 호출) ───────────────────────────────────────────

def design_prompt(analysis: dict[str, Any], style_ref: dict[str, Any] | None, directives_text: str, instruction: str, media: str = "photo") -> str:
    cat = catalog()
    subs = _subs(analysis)
    cut_times = analysis.get("cuts", [])
    statics = [(r["from_sec"], r["to_sec"]) for r in analysis.get("static_runs", [])]
    directives = mga.parse_directives(directives_text)
    for d in directives:
        d["from"], d["to"] = _ts(d["from_sec"]), _ts(d["to_sec"])
        d["from_candidates"] = [{"at": _ts(c["sec"]), **c} for c in mga.boundary_candidates(d["from_sec"], subs, cut_times, statics)]
        d["to_candidates"] = [{"at": _ts(c["sec"]), **c} for c in mga.boundary_candidates(d["to_sec"], subs, cut_times, statics)]
    data = {
        "video": {"duration": _ts(analysis["duration_sec"]), "duration_sec": analysis["duration_sec"]},
        "subs_columns": ["번호", "시작초", "끝초", "자막", "움직임평균(1 미만=정지)", "움직이는비율"],
        "subs": [[n, s["a"], s["b"], s["t"], s.get("mean", 0), s.get("moving", 0)] for n, s in sorted(subs.items())],
        "static_runs": analysis.get("static_runs", []),
        "screen_cuts_sec": cut_times,
        "logo_candidates": analysis.get("logo_candidates", []),
        "directives": directives,
        "style": ({"fixed": True, "name": style_ref["name"], "bg": style_ref.get("bg"), "colors": style_ref["colors"]} if style_ref else None),
        "full_templates": _template_brief(cat),
        "overlay_fx": cat["overlay_fx"],
    }
    return (
        "한국 유튜브 테크 채널 모션그래픽 설계서를 만드세요. 도구를 쓰지 말고 JSON 하나만 답합니다. "
        "장면 연출·좌표·카메라는 이미 코드(템플릿)로 정해져 있으니, 당신은 구간을 나누고 템플릿·문구·타이밍만 고릅니다.\n\n"
        + ("디자인(style)은 data.style 로 고정돼 있습니다(보관함에서 고른 이전 작업 디자인). 그 색·분위기에 어울리는 문구와 이미지를 고르고, "
        "답에 style 키는 넣지 마세요.\n\n" if style_ref else "디자인(style)은 영상 주제·분위기·자막 맥락에 맞게 이번 영상만의 것을 새로 만드세요. 답 맨 위에 "
        "\"style\": {\"name\": \"디자인 이름\", \"colors\": {\"bg\": \"#rrggbb\", \"deep\": …, \"primary\": …, \"sky\": …, \"accent\": …, "
        "\"text\": …, \"text2\": …}, \"bg\": \"aurora|grid|particles|waves\", \"energy\": 0.6~1.4, \"reason\": \"왜 이 디자인인가\"} 를 넣습니다. "
        "주제에 맞는 색(윈도우=블루, 보안·경고=블랙+레드, 웹 도구·오디오=틸·민트, 맥·애플=그래파이트+실버, 안드로이드=포레스트+라임, "
        "금융·경제=네이비+골드 등)을 쓰되 매번 같은 조합을 반복하지 말고 영상 분위기에 맞게 변주하세요. bg(배경색)는 아주 어두운 색, "
        "text 는 거의 흰색, accent 는 밝고 선명한 색. 배경 종류: 차분한 설명=aurora, 기술·데이터=grid, 가볍고 경쾌함=particles, "
        "음악·흐름=waves. energy 는 차분하면 낮게, 역동적이면 높게. 코드가 대비를 검사해 어두운 배경·읽히는 글자로 고칩니다.\n\n")
        + "1) 구간 나누기 (영상 전체를 빈틈없이, 시간 순서)\n"
        "- FULL: 원본을 가리고 전면 MG. 오프닝·엔딩, 화면이 멈춰 있고 말만 하는 곳, 개념·원리 설명.\n"
        "- OVERLAY: 실제 클릭·설정·조작이 보이는 곳. 원본 + 확대·하이라이트만(글자·도형 금지).\n"
        "- NONE: 자막 없는 로고 인트로 등 손대면 안 되는 곳 (logo_candidates·화면 급변 사이로 정확히).\n"
        "- 움직임 없는 화면(움직임 평균 1 미만)에서 말만 하는 구간이 2.5초 이상 이어지면 FULL(풀 모션). 사이에 1.5초 미만의 짧은 움직임이 "
        "끼면 하나로 보세요(깜빡임 방지). 단 사용자 지시(directives)가 있는 구간은 지시가 항상 우선입니다.\n"
        "- OVERLAY 는 마우스가 움직이거나 화면에 실제 조작·UI 변화가 있는 구간. 확대·하이라이트는 가리지 않는 효과로만(글자·도형 카드 금지, "
        "문장을 그대로 옮긴 글자 금지). 문장마다 fx 비트를 하나씩 넣으세요(공백 금지). 가까운 곳을 이어서 보여줘야 하면 문장마다 zoom 비트를 "
        "연달아 넣으세요 — 코드가 확대한 채로 다음 대상으로 이동시키고, 이어지는 대상이 없을 때만 원래 크기로 돌아옵니다.\n"
        "- directives(사용자 지시)를 따르되 시간은 편집 전 기준이라 어긋날 수 있으니 from/to_candidates 로 보정하고 "
        "reason 에 「지시 0:41 → 실측 0:52.08」처럼 적습니다. 지시와 다르게 판단했으면 reason 을 「지시와 다름: …」 으로 시작.\n"
        "- 경계는 문장 경계(자막 시작/끝)나 화면 급변에. 한 구간 최소 4초(로고 NONE 예외), FULL 은 20~60초마다 장면을 나눔.\n\n"
        "2) FULL 구간 = 장면(scenes) 여러 개. 한 장면을 오래 두지 말고 자막 2~4문장(6~12초)마다 다음 장면으로 바꿉니다 — 말이 "
        "바뀌면 화면도 바뀌어야 합니다. 장면마다 full_templates 중 하나(template)와 vars(글자 수 제한 지킴, 자막을 그대로 옮기지 말고 "
        "화면용으로 짧게), beats = 그 장면 slots 순서대로 요소가 나타날 자막 번호 배열. 첫 장면의 첫 비트는 구간 첫 자막. "
        "같은 템플릿을 연달아 쓰지 말고 섞으세요. 영상 처음은 TITLE 또는 PHOTO_POINTS 로 문제 제기, 끝은 ENDING.\n"
        "   장면마다 keys = 그 장면 시간대의 자막 문장 하나하나에 대한 핵심 키워드(2~8자, 빠짐없이): "
        "[{\"sub\": 자막번호, \"text\": \"느린 반응\"}]. 화면 위쪽에 문장이 바뀔 때마다 이 키워드가 바뀌어 보이므로 "
        "자막 내용과 직접 관련된 말이어야 하고, 인사·접속사 문장은 건너뛰어도 됩니다. 시청자가 지루하지 않게, 말이 바뀔 때마다 "
        "화면이 반응하도록 설계하세요.\n"
        "   실제 이미지를 적극 쓰세요: 회사·제품·앱 이름이 나오면 로고(LOGO_SLAM, COMPARE·HUB·STEPS 의 아이콘 자리), "
        "상황 설명은 사진(PHOTO_POINTS), 기능 소개는 스크린샷(IMAGE_CARDS, SHOWCASE). 필요한 이미지는 맨 위 assets 에 "
        "{\"id\": \"영문_소문자\", \"q\": \"영문 검색어\", \"kind\": \"logo|photo|screenshot|video\", \"context\": \"장면에 필요한 구체적 시각 요소(영문)\"} 로 적고(최대 16개, 로고는 "
        "「Windows 11 logo」처럼 정확한 이름), vars 에는 \"asset:id\" 로 넣습니다. 아이콘 변수는 이모지 1개 또는 asset:id. "
        "설정·레지스트리·앱 화면 설명은 APP_WINDOW 로 창을 재현합니다.\n"
        "   이미지 템플릿을 고를 때는 반드시 해당 장면 자막에 직접 맞는 소재를 assets 에 요청하세요. 원본이 고정 배경화면이면 사진 대용으로 쓸 수 없습니다. "
        "확실한 소재를 구하기 어려운 추상적인 설명은 처음부터 NUMBER·COMPARE·CHECKLIST 같은 그래픽 템플릿으로 설계하세요.\n"
        "3) OVERLAY 구간: beats = [{\"sub\": 자막번호, \"fx\": overlay_fx 중 하나}] — 조작·클릭·중요 UI 가 나오는 문장에만. "
        "위치는 프로그램이 화면 변화로 찾으니 적지 않습니다. 메일 주소 등 개인정보가 나온다는 지시가 있으면 blur.\n"
        "4) NONE: beats 없음.\n\n"
        + (QUERY_RULES if media != "emoji" else "")
        + MEDIA_RULES.get(media, "")
        + (f"사용자 추가 요청: {instruction}\n\n" if instruction else "")
        + "답 형식:\n"
        '{"style": {"name": "…", "colors": {…}, "bg": "grid", "energy": 1.0, "reason": "…"} (보관함 디자인이 고정이면 생략),\n'
        ' "assets": [{"id": "win11_logo", "q": "Windows 11 logo", "kind": "logo", "context": "Windows search interface"}, {"id": "desk", "q": "laptop desk working", "kind": "photo", "context": "slow computer at desk"}],\n'
        ' "segments": [\n'
        ' {"id": "A", "type": "FULL", "chapter": "오프닝", "title": "검색창 개편 소개", "start_sec": 0, "reason": "…", "scenes": [\n'
        '   {"template": "PHOTO_POINTS", "vars": {"img": "asset:desk", "p1": "느린 반응 속도", "i1": "⏳", "p2": "불필요한 웹 검색", "i2": "asset:bing_logo", "p3": "광고 노출", "i3": "📢"}, "beats": [1, 1, 2, 3], "keys": [{"sub": 1, "text": "검색창 불편"}, {"sub": 2, "text": "느린 반응"}, {"sub": 3, "text": "광고"}]},\n'
        '   {"template": "LOGO_SLAM", "vars": {"logo1": "asset:win11_logo", "text": "검색, 바닥부터 다시"}, "beats": [6, 7, 8]},\n'
        '   {"template": "TITLE", "vars": {"eyebrow": "Windows 11", "title": "새 검색 기능", "sub": "직접 써 봤습니다"}, "beats": [13, 15]}]},\n'
        ' {"id": "B", "type": "NONE", "chapter": "로고", "title": "채널 로고", "start_sec": 52.08, "reason": "…"},\n'
        ' {"id": "C", "type": "OVERLAY", "chapter": "접속", "title": "사이트 접속", "start_sec": 55.59, "reason": "…",\n'
        '  "beats": [{"sub": 17, "fx": "zoom"}, {"sub": 18, "fx": "ring"}]}\n]}\n\n'
        "DATA:\n" + json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    )


# ── 정규화 ─────────────────────────────────────────────────────────────

def _segments_from_answer(raw: list[Any], analysis: dict[str, Any]) -> list[dict[str, Any]]:
    """AI 구간 → 원본 fps 프레임의 연속 구간. 2초 미만 구간은 앞 구간에 흡수(로고 NONE 은 유지)."""
    fps = _fps(analysis)
    total = int(analysis["duration_frames"])
    items = []
    for s in raw:
        if not isinstance(s, dict):
            continue
        typ = str(s.get("type", "")).upper()
        try:
            start = float(s.get("start_sec", 0))
        except (TypeError, ValueError):
            continue
        if typ not in TYPES:
            continue
        items.append({**s, "type": typ, "from": max(0, min(total - 1, mga.to_frame(start, fps)))})
    if not items:
        raise ValueError("형식에 맞는 구간이 없습니다.")
    items.sort(key=lambda x: x["from"])
    items[0]["from"] = 0
    merged: list[dict[str, Any]] = []
    min_frames = int(round(float(fps) * 2))
    for it in items:
        if merged and it["from"] - merged[-1]["from"] < min_frames and "NONE" not in (it["type"], merged[-1]["type"]):
            continue
        merged.append(it)
    seen: set[str] = set()
    for i, it in enumerate(merged):
        end = merged[i + 1]["from"] if i + 1 < len(merged) else total
        it["durationInFrames"] = max(1, end - it["from"])
        sid = "".join(ch for ch in str(it.get("id") or "") if ch.isalnum())[:8] or f"S{i + 1}"
        while sid in seen:
            sid += "x"
        seen.add(sid)
        it["id"] = sid
    return merged


def _sub_frame(subs: dict[int, dict[str, Any]], n: Any, seg: dict[str, Any]) -> int | None:
    if not isinstance(n, int) or isinstance(n, bool) or n not in subs:
        return None
    a, b = seg["from"], seg["from"] + seg["durationInFrames"]
    f = subs[n]["s"] - LEAD_FRAMES
    if not (a - 30 <= f < b):
        return None
    return max(a, min(b - 1, f))


def _sentence_end(subs: dict[int, dict[str, Any]], frame: int) -> int | None:
    """frame 이 속한 자막 문장이 끝나는 프레임 — 확대·강조는 이 시점에 원상복구된다."""
    for sub in subs.values():
        if int(sub["s"]) - LEAD_FRAMES - 1 <= frame < int(sub["e"]):
            return int(sub["e"])
    return None


_IMAGE_VAR = re.compile(r"^(img\d?|logo\d|i\d|i[abc]|left_icon|right_icon|center_icon|icon|n\d_img)$")


def _scene(raw: dict[str, Any], seg: dict[str, Any], subs: dict[int, dict[str, Any]], cat: dict[str, Any]) -> dict[str, Any] | None:
    tmpl = {t["id"]: t for t in cat["templates"]}
    tid = str(raw.get("template") or "").upper()
    if tid not in tmpl:
        tid = "STATEMENT"
    t = tmpl[tid]
    vars_in = raw.get("vars") if isinstance(raw.get("vars"), dict) else {}
    vars_out = {}
    for k in t["vars"]:
        v = str(vars_in.get(k) or "").strip()
        if not v:
            continue
        # asset:id(설계 직후) 또는 web/파일(받은 뒤)은 길이 제한 없이, 문구는 제한 + 여유 4자
        vars_out[k] = v[:120] if v.startswith(("asset:", "web/", "user/")) else v[: t["max"][k] + 4]
    if tid == "LOGO_SLAM" and not any(k.startswith("logo") for k in vars_out):
        # 로고가 하나도 없는 로고 장면은 빈 화면이 된다 — 문장 장면으로 바꾼다
        tid, t = "STATEMENT", tmpl["STATEMENT"]
        vars_out = {k: v for k, v in vars_out.items() if k in ("header", "text")}
    frames = []
    for b in raw.get("beats") or []:
        n = b.get("sub") if isinstance(b, dict) else b
        f = b.get("frame") if isinstance(b, dict) and isinstance(b.get("frame"), int) else _sub_frame(subs, n, seg)
        if f is None:
            continue
        f = max(seg["from"], min(seg["from"] + seg["durationInFrames"] - 1, int(f)))
        frames.append({"sub": n if isinstance(n, int) else None, "frame": f})
    frames.sort(key=lambda x: x["frame"])
    if not frames:
        return None
    scene = {"template": tid, "vars": vars_out, "beats": frames[: len(t["slots"])]}
    keys = []
    for kk in raw.get("keys") or []:
        if not isinstance(kk, dict) or not str(kk.get("text") or "").strip():
            continue
        f = kk.get("frame") if isinstance(kk.get("frame"), int) else _sub_frame(subs, kk.get("sub"), seg)
        if f is not None:
            keys.append({"sub": kk.get("sub") if isinstance(kk.get("sub"), int) else None, "frame": int(f), "text": str(kk["text"]).strip()[:14]})
    keys.sort(key=lambda x: x["frame"])
    if keys:
        scene["keys"] = keys
    return scene


def resolve_assets(design: dict[str, Any], found: dict[str, str], queries: dict[str, str] | None = None) -> int:
    """vars 의 asset:id 를 받은 파일 경로(web/…)로 바꾼다. 못 받은 사진은 비워 두고 장면 품질 검사에서 처리한다."""
    n = 0
    for seg in design["segments"]:
        for sc in seg.get("scenes") or []:
            for k, v in list(sc["vars"].items()):
                if not (isinstance(v, str) and v.startswith("asset:")):
                    continue
                aid = v[6:].strip()
                path = found.get(aid)
                if path:
                    sc["vars"][k] = path
                    n += 1
                elif k.startswith("logo") and queries and queries.get(aid):
                    # 로고 자리: 못 받았으면 브랜드 이름 글자로 (검색어에서 logo·icon 단어만 뺀다)
                    brand = re.sub(r"\b(logo|icon|symbol)\b", "", queries[aid], flags=re.I).strip()
                    if brand:
                        sc["vars"][k] = brand[:14]
                elif re.match(r"^(i\d|i[abc]|left_icon|right_icon|center_icon|icon)$", k):
                    sc["vars"][k] = "◆"  # 아이콘 자리: 못 받았으면 기본 기호
                else:
                    del sc["vars"][k]
    return n


def normalize_segment(raw: dict[str, Any], seg: dict[str, Any], subs: dict[int, dict[str, Any]], cat: dict[str, Any]) -> dict[str, Any]:
    """구간 하나의 템플릿·문구·비트를 검증한다. from/durationInFrames 는 seg 것을 쓴다."""
    out = {"id": seg["id"], "type": seg["type"], "from": seg["from"], "durationInFrames": seg["durationInFrames"],
           "chapter": str(raw.get("chapter") or seg.get("chapter") or "")[:40],
           "title": str(raw.get("title") or seg.get("title") or "")[:120],
           "reason": str(raw.get("reason") or seg.get("reason") or "")[:500], "beats": []}
    if out["type"] == "FULL":
        raw_scenes = raw.get("scenes") if isinstance(raw.get("scenes"), list) and raw.get("scenes") else \
            [{"template": raw.get("template"), "vars": raw.get("vars"), "beats": raw.get("beats")}]
        scenes = [sc for sc in (_scene(r, seg, subs, cat) for r in raw_scenes if isinstance(r, dict)) if sc]
        if not scenes:
            first_sub = next((n for n, sub in sorted(subs.items()) if seg["from"] <= sub["s"] < seg["from"] + seg["durationInFrames"]), None)
            scenes = [{"template": "STATEMENT", "vars": {"text": out["title"] or "핵심 내용"},
                       "beats": [{"sub": first_sub, "frame": seg["from"]}]}]
        scenes.sort(key=lambda sc: sc["beats"][0]["frame"])
        scenes[0]["beats"][0]["frame"] = seg["from"]  # 첫 장면은 구간 시작부터
        # 장면 시작이 겹치면 뒤 장면을 버린다 (같은 프레임에 두 장면 금지)
        kept = []
        for sc in scenes:
            if kept and sc["beats"][0]["frame"] <= kept[-1]["beats"][0]["frame"] + 15:
                continue
            kept.append(sc)
        out["scenes"] = kept
        out["beats"] = [b for sc in kept for b in sc["beats"]]
    elif out["type"] == "OVERLAY":
        for b in raw.get("beats") or []:
            if not isinstance(b, dict):
                continue
            fx = str(b.get("fx") or "").lower()
            if fx not in cat["overlay_fx"]:
                continue
            f = b.get("frame") if isinstance(b.get("frame"), int) else _sub_frame(subs, b.get("sub"), seg)
            if f is None:
                continue
            beat = {"sub": b.get("sub"), "frame": max(seg["from"], min(seg["from"] + seg["durationInFrames"] - 1, int(f))), "fx": fx}
            # track(추적 경로)은 normalize 후 track_targets 가 다시 만든다
            tgt = b.get("target")
            if isinstance(tgt, list) and len(tgt) == 4 and all(isinstance(v, (int, float)) for v in tgt):
                beat["target"] = [int(v) for v in tgt]
                if isinstance(b.get("target_frame"), int):
                    beat["target_frame"] = b["target_frame"]
            if fx == "zoom":
                try:
                    beat["zoom"] = round(max(1.1, min(2.6, float(b.get("zoom", 1.6)))), 2)
                except (TypeError, ValueError):
                    beat["zoom"] = 1.6
            end_f = _sentence_end(subs, beat["frame"])
            if end_f is not None:
                beat["until"] = min(seg["from"] + seg["durationInFrames"] - 1, end_f)
            out["beats"].append(beat)
        out["beats"].sort(key=lambda x: x["frame"])
    return out


# ── OVERLAY 하이라이트 위치: 화면 변화 측정 (토큰 0) ─────────────────────

_GW, _GH = 320, 180


def _gray(video: Path, t: float) -> bytes | None:
    proc = subprocess.run([str(get_ffmpeg_exe()), "-hide_banner", "-loglevel", "error", "-ss", f"{max(0.0, t):.3f}", "-i", str(video),
                           "-frames:v", "1", "-vf", f"scale={_GW}:{_GH},format=gray", "-f", "rawvideo", "-"],
                          capture_output=True, timeout=60, creationflags=no_window_creationflags())
    return proc.stdout if len(proc.stdout) == _GW * _GH else None


def change_box(a: bytes, b: bytes, threshold: int = 22) -> tuple[int, int, int, int] | None:
    """두 그레이 프레임에서 바뀐 픽셀들의 바운딩 박스 (작은 잡음·화면 전체 변화는 None)."""
    xs, ys = [], []
    for y in range(0, _GH, 2):
        row = y * _GW
        for x in range(0, _GW, 2):
            if abs(a[row + x] - b[row + x]) > threshold:
                xs.append(x)
                ys.append(y)
    n = len(xs)
    if n < 6 or n > (_GW * _GH / 4) * 0.6:
        return None
    xs.sort()
    ys.sort()
    lo, hi = int(n * 0.03), max(0, int(n * 0.97) - 1)  # 튀는 점 제외
    x0, x1, y0, y1 = xs[lo], xs[hi] + 2, ys[lo], ys[hi] + 2
    if (x1 - x0) * (y1 - y0) > _GW * _GH * 0.35:  # 화면 전환·스크롤 — 짚을 대상이 아님
        return None
    return x0, y0, max(4, x1 - x0), max(4, y1 - y0)


def locate_targets(pid: str, design: dict[str, Any], only: set[str] | None = None) -> int:
    """target 이 없는 OVERLAY 비트에 화면 변화 위치를 채운다. 못 찾으면 직전 비트 위치, 그것도 없으면 효과를 뺀다."""
    video = Path(mg.load_project(pid)["video_path"])
    fps = float(Fraction(design["fps"]["num"], design["fps"]["den"]))
    W, H = int(design["width"]), int(design["height"])
    sx, sy = W / _GW, H / _GH
    found = 0
    for seg in design["segments"]:
        if seg["type"] != "OVERLAY" or (only and seg["id"] not in only):
            continue
        last = None
        keep = []
        for b in seg["beats"]:
            if not b.get("target"):
                t = (b["frame"] + LEAD_FRAMES) / fps
                fa, fb = _gray(video, t - 0.4), _gray(video, t + 0.9)
                box = change_box(fa, fb) if fa and fb else None
                if box:
                    x, y, w, h = box
                    pad_w, pad_h = max(w * 0.12, 6), max(h * 0.12, 6)
                    b["target"] = [round((x - pad_w) * sx), round((y - pad_h) * sy), round((w + pad_w * 2) * sx), round((h + pad_h * 2) * sy)]
                    b["auto"] = True
                    found += 1
                elif last:
                    b["target"] = list(last)
                    b["auto"] = True
            if b.get("target"):
                x, y, w, h = b["target"]
                x, y = max(0, min(W - 8, x)), max(0, min(H - 8, y))
                b["target"] = [x, y, max(8, min(W - x, w)), max(8, min(H - y, h))]
                last = b["target"]
                keep.append(b)
        seg["beats"] = keep
    return found


def _tracking_end(beat: dict[str, Any], next_frame: int, segment_end: int) -> int:
    """다음 비트나 현재 문장 종료 뒤에는 이 대상의 추적이 필요하지 않다."""
    visual_end = int(beat.get("until") or next_frame) + (14 if beat.get("fx") == "zoom" else 0)
    return min(segment_end, max(beat["frame"] + 15, min(visual_end, next_frame)))


def track_targets(pid: str, design: dict[str, Any], only: set[str] | None = None) -> int:
    """대상이 정해진 OVERLAY 비트마다 원본 화면 움직임을 따라가는 경로를 만든다 (Node track.mjs, 의존성 없음)."""
    node = mg.node_exe()
    script = mg.TEMPLATE_DIR / "track.mjs"
    if not node.is_file() or not script.is_file():
        return 0
    fps = float(Fraction(design["fps"]["num"], design["fps"]["den"]))
    items, refs = [], {}
    for seg in design["segments"]:
        if seg["type"] != "OVERLAY" or (only and seg["id"] not in only):
            continue
        end_seg = seg["from"] + seg["durationInFrames"]
        beats = seg["beats"]
        for i, b in enumerate(beats):
            if not b.get("target"):
                continue
            nxt = next((x["frame"] for x in beats[i + 1:] if x["frame"] > b["frame"]), end_seg)
            # 효과가 끝난 뒤까지 추적하면 긴 구간의 확대 비트마다 영상을 반복 디코딩한다.
            end = _tracking_end(b, nxt, end_seg)
            key = f"{seg['id']}:{i}"
            start = min(b["frame"], int(b.get("target_frame", b["frame"])))  # 위치를 잰 프레임부터 따라간다
            if end <= start or b.get("track"):
                continue
            items.append({"key": key, "start": round(start / fps, 3), "end": round(end / fps, 3), "box": b["target"]})
            refs[key] = b
    if not items:
        return 0
    work = mg.project_dir(pid) / "design_work"
    work.mkdir(parents=True, exist_ok=True)
    job = work / "track-job.json"
    mg._write_json(job, {"ffmpeg": str(get_ffmpeg_exe()), "video": str(Path(mg.load_project(pid)["video_path"])),
                         "w": int(design["width"]), "h": int(design["height"]), "items": items})
    proc = subprocess.run([str(node), str(script), str(job)], capture_output=True, timeout=900,
                          creationflags=no_window_creationflags())
    done = 0
    for line in proc.stdout.decode("utf-8", "replace").splitlines():
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        b = refs.get(msg.get("key"))
        tr = msg.get("track") or []
        if b is not None and len(tr) > 1:
            b["track"] = [[round(t * fps), x, y, w, h] for t, x, y, w, h in tr]
            done += 1
    return done


# ── 저장 ───────────────────────────────────────────────────────────────

def _design_path(pid: str) -> Path:
    return mg.project_dir(pid) / "design.json"


def cue_frames(analysis: dict[str, Any]) -> list[int]:
    """자막이 시작되는 프레임(−3프레임) 목록 — 전면 MG 가 자막 문장마다 반응하는 기준."""
    return sorted({max(0, int(s["s"]) - LEAD_FRAMES) for s in analysis["subs"].values()})


def load_design(pid: str) -> dict[str, Any] | None:
    data = mg._read_json(_design_path(pid))
    if not (isinstance(data, dict) and data.get("version") == 2):
        return None
    if "cues" not in data:  # 큐가 없던 이전 설계서 — 분석 결과에서 채운다
        analysis = mg._read_json(mg.project_dir(pid) / "analysis.json")
        if isinstance(analysis, dict) and analysis.get("subs"):
            data["cues"] = cue_frames(analysis)
    return data


def save_design(pid: str, design: dict[str, Any]) -> dict[str, Any]:
    design["revision"] = int(design.get("revision", 0)) + 1
    design["updated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    mg._write_json(_design_path(pid), design)
    mg._write_json(mg.project_dir(pid) / "segments.json", {  # 스킬 형식
        "fps": design["fps"]["value"], "width": design["width"], "height": design["height"],
        "durationInFrames": design["durationInFrames"], "source": "source.mp4", "style": design["style"],
        "segments": design["segments"]})
    return design


def _thumbs(pid: str, design: dict[str, Any], only: set[str] | None = None) -> None:
    video = Path(mg.load_project(pid)["video_path"])
    fps = float(Fraction(design["fps"]["num"], design["fps"]["den"]))
    out = mg.project_dir(pid) / "design_assets"
    out.mkdir(parents=True, exist_ok=True)
    for s in design["segments"]:
        if only is not None and s["id"] not in only:
            continue
        t = (s["from"] + min(s["durationInFrames"] / 2, fps * 3)) / fps
        subprocess.run([str(get_ffmpeg_exe()), "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{t:.2f}", "-i", str(video),
                        "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", str(out / f"seg_{s['id']}.jpg")],
                       capture_output=True, timeout=60, creationflags=no_window_creationflags())


def _new_id(design: dict[str, Any], base: str) -> str:
    ids = {x["id"] for x in design["segments"]}
    stem = re.sub(r"\d+$", "", base) or base
    n = 2
    while f"{stem}{n}" in ids:
        n += 1
    return f"{stem}{n}"


def split_at(design: dict[str, Any], frame: int) -> str | None:
    """frame 이 구간 한가운데이면 둘로 쪼갠다 (경계면 아무것도 안 함). 새로 생긴 오른쪽 구간 id 를 돌려준다.

    사용자가 타임라인에서 고른 시간 범위의 양 끝을 구간 경계로 맞추려고 쓴다 — 범위 안만 고치고 바깥은 그대로 둔다.
    FULL 은 장면(scenes) 단위로 나누되, 쪼개진 지점에서 진행 중이던 장면은 양쪽에 이어진다.
    """
    for i, seg in enumerate(design["segments"]):
        a = seg["from"]
        b = a + seg["durationInFrames"]
        if a < frame < b:
            break
    else:
        return None
    left, right = copy.deepcopy(seg), copy.deepcopy(seg)
    left["durationInFrames"] = frame - a
    right.update(id=_new_id(design, seg["id"]), **{"from": frame}, durationInFrames=b - frame)
    right.pop("edits", None)
    if seg["type"] == "FULL":
        scenes = seg.get("scenes") or []
        starts = [a] + [min(bt["frame"] for bt in sc["beats"]) for sc in scenes[1:]]
        active = max(k for k, st in enumerate(starts) if st < frame) if scenes else 0
        ls, rs = [], []
        for k, sc in enumerate(scenes):
            if k < active:
                ls.append(sc)
            elif k == active:
                lb = [x for x in sc["beats"] if x["frame"] < frame] or [{"sub": None, "frame": starts[k]}]
                rb = [x for x in sc["beats"] if x["frame"] >= frame]
                if not rb or rb[0]["frame"] > frame:
                    rb = [{"sub": None, "frame": frame}] + rb
                lsc, rsc = {**sc, "beats": lb}, {**sc, "beats": rb}
                lk = [x for x in sc.get("keys", []) if x["frame"] < frame]
                rk = [x for x in sc.get("keys", []) if x["frame"] >= frame]
                lsc.pop("keys", None)
                rsc.pop("keys", None)
                if lk:
                    lsc["keys"] = lk
                if rk:
                    rsc["keys"] = rk
                ls.append(lsc)
                rs.append(rsc)
            else:
                rs.append(sc)
        left["scenes"], right["scenes"] = ls, rs
        left["beats"] = [x for sc in ls for x in sc["beats"]]
        right["beats"] = [x for sc in rs for x in sc["beats"]]
    else:
        left["beats"] = [x for x in seg.get("beats", []) if x["frame"] < frame]
        right["beats"] = [x for x in seg.get("beats", []) if x["frame"] >= frame]
    design["segments"][i:i + 1] = [left, right]
    return right["id"]


def thumb_path(pid: str, sid: str) -> Path | None:
    if not sid.isalnum():
        return None
    p = mg.project_dir(pid) / "design_assets" / f"seg_{sid}.jpg"
    return p if p.is_file() else None


def set_type(pid: str, sid: str, type_: str) -> dict[str, Any]:
    """구간 종류만 바꾼다 (FULL 로 바꾸면 STATEMENT 템플릿, 문구는 제목으로 채움 — 이후 수정 요청으로 다듬기)."""
    design = load_design(pid)
    if not design:
        raise ValueError("설계서가 없습니다.")
    type_ = type_.upper()
    if type_ not in TYPES:
        raise ValueError("FULL / OVERLAY / NONE 중 하나여야 합니다.")
    for i, s in enumerate(design["segments"]):
        if s["id"] == sid and s["type"] != type_:
            raw = {"template": "STATEMENT", "vars": {"header": s.get("chapter", ""), "text": s.get("title", "")},
                   "beats": [{"frame": s["from"]}, {"frame": s["from"] + 20}]} if type_ == "FULL" else {}
            design["segments"][i] = normalize_segment(raw, {**s, "type": type_}, {}, catalog())
            design["segments"][i]["reason"] = (s.get("reason") or "") + f" · 사용자가 {type_} 로 변경"
    return save_design(pid, design)


def save_segment(pid: str, sid: str, raw: dict[str, Any]) -> dict[str, Any]:
    design = load_design(pid)
    if not design:
        raise ValueError("설계서가 없습니다.")
    idx = next((i for i, x in enumerate(design["segments"]) if x["id"] == sid), None)
    if idx is None:
        raise ValueError(f"구간 {sid} 를 찾을 수 없습니다.")
    seg = design["segments"][idx]
    typ = str(raw.get("type") or seg["type"]).upper()
    new = normalize_segment({**seg, **raw}, {**seg, "type": typ if typ in TYPES else seg["type"]}, _subs(ensure_analysis(pid)), catalog())
    new["reason"] = seg.get("reason", "")
    new["edits"] = (list(seg.get("edits") or []) + [{"request": "외부(MCP) 저장", "change": str(raw.get("change") or "")[:300],
                                                    "at": time.strftime("%H:%M:%S")}])[-10:]
    design["segments"][idx] = new
    locate_targets(pid, design, {sid})
    track_targets(pid, design, {sid})
    return save_design(pid, design)


_IMG_VARS = {"PHOTO_POINTS": ["img"], "IMAGE_CARDS": ["img1", "img2", "img3"], "SHOWCASE": ["img"]}


def _scene_subtitles(subs: dict[int, dict[str, Any]], start: int, end: int) -> list[tuple[int, dict[str, Any]]]:
    return [(n, sub) for n, sub in sorted(subs.items()) if start <= int(sub["s"]) < end]


def _source_frame_useful(subs: dict[int, dict[str, Any]], start: int, end: int) -> bool:
    """고정 배경화면 같은 원본을 소재로 재사용하지 않는다."""
    relevant = _scene_subtitles(subs, start, end)
    return any(float(s.get("mean") or 0) >= 1 and float(s.get("moving") or 0) >= .1 for _, s in relevant)


def _graphic_fallback(scene: dict[str, Any], seg: dict[str, Any], cat: dict[str, Any]) -> None:
    """사진을 구하지 못한 장면을 같은 메시지의 그래픽 장면으로 바꾼다."""
    old = scene["vars"]
    typ = scene["template"]
    if typ == "PHOTO_POINTS" and any(old.get(f"p{i}") for i in range(1, 4)):
        new_type = "CHECKLIST"
        new_vars = {"header": (scene.get("keys") or [{}])[0].get("text") or seg.get("title") or "핵심 내용"}
        new_vars.update({f"c{i}": " · ".join(filter(None, (old.get(f"p{i}"), old.get(f"d{i}"))))
                         for i in range(1, 4) if old.get(f"p{i}") or old.get(f"d{i}")})
    elif typ == "IMAGE_CARDS" and old.get("t1") and old.get("t2"):
        new_type = "COMPARE"
        new_vars = {"header": old.get("header") or seg.get("title") or "비교", "left": old["t1"],
                    "left_sub": old.get("s1", ""), "right": old["t2"], "right_sub": old.get("s2", ""),
                    "verdict": old.get("t3", "")}
    else:
        new_type = "STATEMENT"
        new_vars = {"header": old.get("header") or seg.get("title") or "핵심 내용",
                    "text": old.get("caption") or old.get("t1") or (scene.get("keys") or [{}])[0].get("text") or seg.get("title") or "핵심 내용",
                    "chip": old.get("chip") or old.get("s1") or ""}
    meta = next(t for t in cat["templates"] if t["id"] == new_type)
    scene["template"] = new_type
    scene["vars"] = {k: str(v)[:meta["max"][k]] for k, v in new_vars.items() if k in meta["vars"] and v}
    scene["beats"] = scene["beats"][:len(meta["slots"])]


def finalize_design(design: dict[str, Any], analysis: dict[str, Any]) -> dict[str, int]:
    """설계 저장·적용 전에 자막 반응과 소재를 보정하고 결과를 기록한다."""
    subs = _subs(analysis)
    cat = catalog()
    report = {"keys_added": 0, "graphic_fallbacks": 0, "stale_frames_removed": 0}
    for seg in design["segments"]:
        if seg["type"] != "FULL":
            continue
        scenes = [sc for sc in seg.get("scenes") or [] if sc.get("beats") and
                  isinstance(sc["beats"][0].get("frame"), int) and
                  seg["from"] <= sc["beats"][0]["frame"] < seg["from"] + seg["durationInFrames"]]
        scenes.sort(key=lambda sc: sc["beats"][0]["frame"])
        scenes = [sc for i, sc in enumerate(scenes) if i == 0 or sc["beats"][0]["frame"] > scenes[i - 1]["beats"][0]["frame"]]
        if not scenes:
            first = _scene_subtitles(subs, seg["from"], seg["from"] + seg["durationInFrames"])
            scenes = [{"template": "STATEMENT", "vars": {"text": seg.get("title") or "핵심 내용"},
                       "beats": [{"sub": first[0][0] if first else None, "frame": seg["from"]}]}]
        scenes[0]["beats"][0]["frame"] = seg["from"]
        seg["scenes"] = scenes
        for i, scene in enumerate(scenes):
            start = scene["beats"][0]["frame"]
            end = scenes[i + 1]["beats"][0]["frame"] if i + 1 < len(scenes) else seg["from"] + seg["durationInFrames"]
            relevant = _scene_subtitles(subs, start, end)
            existing = {k.get("sub") for k in scene.get("keys") or []}
            for n, sub in relevant:
                if n not in existing:
                    text = re.sub(r"\s+", " ", str(sub.get("t") or "")).strip(" .,!?…")[:14]
                    scene.setdefault("keys", []).append({"sub": n, "frame": max(start, int(sub["s"]) - LEAD_FRAMES),
                                                         "text": text or seg.get("title") or "핵심 내용"})
                    report["keys_added"] += 1
            if scene.get("keys"):
                scene["keys"].sort(key=lambda k: k["frame"])
            names = _IMG_VARS.get(scene["template"])
            if not names:
                continue
            useful = _source_frame_useful(subs, start, end)
            for name in names:
                value = scene["vars"].get(name)
                if isinstance(value, str) and value.startswith("frames/") and not useful:
                    del scene["vars"][name]
                    report["stale_frames_removed"] += 1
            required = [name for name in names if scene["template"] != "IMAGE_CARDS" or scene["vars"].get("t" + name[-1])]
            if not required or any(not scene["vars"].get(name) for name in required):
                _graphic_fallback(scene, seg, cat)
                report["graphic_fallbacks"] += 1
        seg["beats"] = [b for sc in scenes for b in sc["beats"]]
    design["quality"] = report
    return report


def _referenced_assets(design: dict[str, Any], wanted: list[dict[str, Any]]) -> list[dict[str, Any]]:
    used = {v[6:] for seg in design["segments"] for sc in seg.get("scenes") or []
            for v in sc.get("vars", {}).values() if isinstance(v, str) and v.startswith("asset:")}
    return [item for item in wanted if str(item.get("id") or "") in used]


def discard_missing_media(pid: str, design: dict[str, Any]) -> int:
    """파일이 없거나 프로젝트 밖을 가리키는 이미지 참조를 제거한다."""
    root = (mg.project_dir(pid) / "assets").resolve()
    removed = 0
    for seg in design["segments"]:
        for scene in seg.get("scenes") or []:
            for name, value in list(scene.get("vars", {}).items()):
                if not isinstance(value, str) or not value.startswith(("web/", "frames/", "user/")):
                    continue
                path = (root / value).resolve()
                if not path.is_relative_to(root) or not path.is_file():
                    del scene["vars"][name]
                    removed += 1
    return removed


def validate_design(design: dict[str, Any]) -> None:
    """적용 가능한 타임라인인지 확인한다. 자동 보정 후에도 남은 오류는 적용을 막는다."""
    end = 0
    for seg in design["segments"]:
        start = int(seg["from"])
        stop = start + int(seg["durationInFrames"])
        if start != end or stop <= start:
            raise ValueError("설계 구간이 비거나 겹칩니다.")
        end = stop
        if seg["type"] == "FULL":
            scenes = seg.get("scenes") or []
            if not scenes or scenes[0]["beats"][0]["frame"] != start:
                raise ValueError(f"{seg['id']} 구간에 시작 장면이 없습니다.")
            if any(not sc.get("beats") or not start <= sc["beats"][0]["frame"] < stop for sc in scenes):
                raise ValueError(f"{seg['id']} 구간의 장면 시간이 잘못됐습니다.")
        if any(isinstance(v, str) and v.startswith("asset:") for sc in seg.get("scenes") or [] for v in sc.get("vars", {}).values()):
            raise ValueError(f"{seg['id']} 구간에 받지 못한 이미지 참조가 남아 있습니다.")
    if end != int(design["durationInFrames"]):
        raise ValueError("설계가 영상 끝까지 이어지지 않습니다.")


def fill_missing_images(pid: str, design: dict[str, Any], analysis: dict[str, Any] | None = None) -> int:
    """장면에 실제 움직임이 있는 경우에만 원본 화면을 소재로 캡처한다."""
    analysis = analysis or ensure_analysis(pid)
    subs = _subs(analysis)
    video = Path(mg.load_project(pid)["video_path"])
    fps = float(Fraction(design["fps"]["num"], design["fps"]["den"]))
    out_dir = mg.project_dir(pid) / "assets" / "frames"
    out_dir.mkdir(parents=True, exist_ok=True)
    filled = 0
    for seg in design["segments"]:
        scenes = seg.get("scenes") or []
        for i, sc in enumerate(scenes):
            names = _IMG_VARS.get(sc["template"])
            if not names:
                continue
            want = [n for n in names if not sc["vars"].get(n)]
            # IMAGE_CARDS 는 카드 제목(t1..)이 있는 자리만
            if sc["template"] == "IMAGE_CARDS":
                want = [n for n in want if sc["vars"].get("t" + n[-1])]
            if not want:
                continue
            start = sc["beats"][0]["frame"]
            end = scenes[i + 1]["beats"][0]["frame"] if i + 1 < len(scenes) else seg["from"] + seg["durationInFrames"]
            if not _source_frame_useful(subs, start, end):
                continue
            span = max(1, min(end - start, 300))
            for k, name in enumerate(want):
                t = (start + span * (k + 1) / (len(want) + 1)) / fps
                path = out_dir / f"f_{int(round(t * 100)):07d}.jpg"
                if not path.is_file():
                    subprocess.run([str(get_ffmpeg_exe()), "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{t:.3f}", "-i", str(video),
                                    "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "3", str(path)],
                                   capture_output=True, timeout=60, creationflags=no_window_creationflags())
                if path.is_file():
                    sc["vars"][name] = f"frames/{path.name}"
                    filled += 1
    return filled


def apply(pid: str, value: bool = True) -> dict[str, Any]:
    design = load_design(pid)
    if not design:
        raise ValueError("설계서가 없습니다. 먼저 「설계하기」를 실행하세요.")
    if value:
        analysis = ensure_analysis(pid)
        discard_missing_media(pid, design)
        fill_missing_images(pid, design, analysis)
        finalize_design(design, analysis)
        validate_design(design)
    design["applied"] = bool(value)
    return save_design(pid, design)


# ── CLI ────────────────────────────────────────────────────────────────

def parse_json_answer(client: str, raw: str) -> dict[str, Any]:
    raw = raw.strip()
    if client == "antigravity":
        events = [json.loads(line) for line in raw.splitlines() if line.strip().startswith("{")]
        final = next((e.get("result", {}) for e in reversed(events) if e.get("event") == "result"), None)
        if not final or final.get("status") != "SUCCESS":
            raise RuntimeError("Antigravity 응답 실패: " + str((final or {}).get("error", "결과가 없습니다."))[:300])
        raw = str(final.get("response", "")).strip()
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("AI 가 JSON 을 돌려주지 않았습니다.")
    try:
        answer = json.loads(raw[start:end + 1])
    except ValueError as exc:
        raise RuntimeError(f"AI 답의 JSON 형식이 깨졌습니다: {exc}") from exc
    if not isinstance(answer, dict):
        raise RuntimeError("AI 답이 JSON 객체가 아닙니다.")
    return answer


def _cli(job_id: str, client: str, prompt: str, work: Path, effort: str, image: Path | None = None) -> dict[str, Any]:
    exe = mai._executable(client)
    cmd = mai._command(client, exe)
    if client == "claude":
        cmd = [c if c != "medium" else effort for c in cmd]
        if image:
            i = cmd.index("--tools")
            cmd[i:i + 2] = ["--tools", "Read", "--allowedTools", "Read", "--add-dir", str(image.parent)]
            prompt = f"먼저 이 화면 캡처를 Read 로 보세요: {image}\n\n" + prompt
    elif client == "codex":
        cmd = [c.replace('"medium"', f'"{effort}"') for c in cmd]
        if image:
            cmd = cmd[:-1] + ["-i", str(image), "-"]
    cli_input = (json.dumps({"event": "user", "message": {"content": prompt}}, ensure_ascii=False) + "\n"
                 if client == "antigravity" else prompt)
    work.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            encoding="utf-8", errors="replace", cwd=str(work), creationflags=no_window_creationflags(),
                            env=mai._environment(client, exe))
    with _lock:
        _jobs[job_id]["_proc"] = proc
    try:
        out, err = proc.communicate(cli_input, timeout=_CALL_TIMEOUT)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        raise RuntimeError("AI 응답이 10분 안에 끝나지 않았습니다.")
    finally:
        with _lock:
            _jobs[job_id]["_proc"] = None
    if _jobs[job_id].get("cancel"):
        raise InterruptedError
    if proc.returncode:
        raise RuntimeError(f"{mai.LABELS[client]} 실행 실패 (종료 코드 {proc.returncode}). "
                           + ((err or "").strip()[-300:] or (out or "").strip()[-300:]))
    (work / f"answer_{int(time.time())}_{client}.txt").write_text(out or "", encoding="utf-8")
    print(f"[motion_graphic_design] {client} prompt={len(prompt)}chars out={len(out or '')}chars", file=sys.stderr, flush=True)
    return parse_json_answer(client, out or "")


# ── 작업 ───────────────────────────────────────────────────────────────

def _step(job_id: str, key: str, **fields: Any) -> None:
    with _lock:
        for st in _jobs[job_id]["steps"]:
            if st["key"] == key:
                if fields.get("state") == "done" and st.get("started"):
                    fields.setdefault("elapsed", round(time.time() - st["started"], 2))
                st.update(fields)


def _run_design(job_id: str, pid: str, client: str, style_id: str | None, directives: str, instruction: str, media: str = "photo") -> str:
    _step(job_id, "analyze", state="running", started=time.time())
    analysis = ensure_analysis(pid)
    if not analysis.get("subs"):
        # 자막 없이 AI 를 부르면 영상과 상관없는 내용을 지어낸다 — 반드시 멈춘다
        raise RuntimeError("자막(SRT)을 한 줄도 읽지 못했습니다. SRT 파일을 다시 선택해 프로젝트를 만들어 주세요.")
    _step(job_id, "analyze", state="done", message=f"자막 {len(analysis['subs'])}줄 · 정지 구간 {len(analysis.get('static_runs', []))}개 · fps {analysis['fps']['value']}")
    _step(job_id, "design", state="running", started=time.time())
    lib = mgstyles.get_style(style_id) if style_id else None
    style_ref = mgstyles.as_design(lib) if lib else None
    answer = _cli(job_id, client, design_prompt(analysis, style_ref, directives, instruction, media), mg.project_dir(pid) / "design_work", "medium")
    segs = _segments_from_answer(answer.get("segments") or [], analysis)
    subs = _subs(analysis)
    cat = catalog()
    style_obj = style_ref if style_ref else mgstyles.normalize_style(answer.get("style"))
    design = {"version": 2, "revision": 0, "style": style_obj, "media": media, "fps": analysis["fps"], "cues": cue_frames(analysis), "width": analysis.get("width"),
              "height": analysis.get("height"), "durationInFrames": analysis["duration_frames"], "directives": directives,
              "instruction": instruction, "client": client, "applied": False,
              "segments": [normalize_segment(s, s, subs, cat) for s in segs]}
    counts = {t: sum(1 for s in design["segments"] if s["type"] == t) for t in TYPES}
    n_scenes = sum(len(s.get("scenes") or []) for s in design["segments"])
    _step(job_id, "design", state="done", message=f"구간 {len(segs)}개 · FULL {counts['FULL']}(장면 {n_scenes}) · OVERLAY {counts['OVERLAY']} · NONE {counts['NONE']}")
    _step(job_id, "assets", state="running", started=time.time())
    wanted = _referenced_assets(design, filter_assets([a for a in (answer.get("assets") or []) if isinstance(a, dict)], media))
    missed_d: list[str] = []
    try:
        found = mgassets.fetch(mg.project_dir(pid) / "assets", wanted, failed=missed_d,
                               on_progress=lambda i, n, q: _step(job_id, "assets", message=f"{i + 1}/{n} {q}")) if wanted else {}
    except (OSError, ValueError, RuntimeError) as exc:
        found = {}
        missed_d = [str(exc)[:70]]
    resolve_assets(design, found, {str(a.get("id")): str(a.get("q") or "") for a in wanted})
    discard_missing_media(pid, design)
    captured = fill_missing_images(pid, design, analysis)
    quality = finalize_design(design, analysis)
    validate_design(design)
    _step(job_id, "assets", state="done", message=(f"웹 이미지 {len(found)}/{len(wanted)}개 받음"
          + (f" (못 받음: {', '.join(missed_d)[:70]})" if missed_d else "")
          + f" · 영상 화면 캡처 {captured}곳 · 부적합 캡처 제거 {quality['stale_frames_removed']}곳"
          + f" · 그래픽 대체 {quality['graphic_fallbacks']}곳 · 자막 보정 {quality['keys_added']}곳"))
    _step(job_id, "locate", state="running", started=time.time())
    found = locate_targets(pid, design)
    tracked = track_targets(pid, design)
    design["applied"] = True
    save_design(pid, design)
    _step(job_id, "locate", state="done", message=f"하이라이트 위치 {found}곳 · 화면 따라가기 {tracked}곳")
    try:
        _thumbs(pid, design)
    except Exception:  # noqa: BLE001
        pass
    return "설계 품질 검사와 자동 적용이 끝났습니다. 미리보기에서 확인할 수 있습니다."


def edit_prompt(design: dict[str, Any], segs: list[dict[str, Any]], subs: dict[int, dict[str, Any]], request: str,
                a: int, b: int, at_frame: int | None, fetch_more: bool = False, detail: bool = False) -> str:
    cat = catalog()
    fps = design["fps"]["value"]
    seg_subs = [[n, s["s"], round(s["a"], 2), s["t"]] for n, s in sorted(subs.items()) if a - 30 <= s["s"] < b]
    where = f"사용자가 보고 있던 시점: {_ts(at_frame / fps)} (프레임 {at_frame})\n" if at_frame is not None else ""
    return (
        "모션그래픽 설계서에서 사용자가 고른 시간 범위의 구간들을 요청대로 고치세요. 도구를 쓰지 말고 JSON 하나만 답합니다.\n"
        f"영상 {design['width']}×{design['height']}, {fps}fps (프레임 = 초 × {fps}). "
        f"소재 모드: {design.get('media') or 'photo'}. "
        f"사용자가 고른 범위: {_ts(a / fps)} ~ {_ts(b / fps)} (프레임 {a}~{b - 1}). 이 범위 밖으로 비트를 옮기거나 다른 구간을 건드리지 마세요.\n"
        + where
        + "- 타이밍 요청(「0.5초 당겨」 등)은 해당 비트의 frame 을 초×fps 만큼 바꿉니다. 위치 요청(「왼쪽으로」, 「링크 부분 확대」)은 OVERLAY 비트 "
        "target [x, y, w, h](원본 픽셀)을 고칩니다. 화면 캡처가 있으면 캡처에서 대상을 찾아 target_img [x, y, w, h](캡처 이미지 픽셀, 캡처는 "
        "960×540)로 주세요. zoom 은 1.1~2.6. 비트가 없으면 sub(자막 번호)와 fx 로 새로 만듭니다. 가까운 곳을 이어서 보여줘야 하면 문장마다 "
        "zoom 비트를 연달아 넣으세요(코드가 확대한 채로 이동시키고, 문장이 끝나면 원래 크기로 돌립니다). 효과 종료 시각(until)은 쓰지 않습니다.\n"
        "- FULL 은 scenes(장면 목록: template · vars · beats=자막 번호)로 고칩니다. 장면을 나누거나 합치고 템플릿·문구를 바꿀 수 있습니다. "
        "새 소재가 필요하면 답 맨 위 assets 에 {id, q(영문 검색어), kind(logo|photo|screenshot|video), context(그 장면에 필요한 시각 요소·영문)} 를 적고 vars 에 asset:id 로 넣습니다. "
        "kind=video 는 설계서의 media 가 video 일 때만 사용하고 사진 프레임의 img 자리에만 넣습니다.\n"
        + QUERY_RULES
        + "- 종류를 바꾸라는 요청(「이 부분은 풀 모션으로」 「오버레이로」)이면 해당 구간의 type 을 바꾸고 그 종류에 맞는 scenes/beats 를 만듭니다.\n"
        "- OVERLAY 에는 문장을 그대로 옮긴 글자나 도형 카드를 넣지 않습니다. 요청과 관계없는 부분은 그대로 둡니다.\n"
        "- 답에는 이 범위의 구간을 모두(id 유지) 같은 형식으로 넣고, 무엇을 고쳤는지 change 에 한 줄.\n\n"
        + ("자료 보강 요청: 이 범위의 장면에 이미지·로고가 부족합니다. 장면 내용에 맞는 로고·사진·스크린샷을 웹에서 더 받아 쓰세요 — "
           "assets 에 필요한 것을 모두 적고(최대 8개, 로고는 정확한 이름) 장면 vars 에 asset:id 로 넣으세요. 이모지·글자로만 채워진 자리는 "
           "실제 이미지로 바꾸세요.\n\n" if fetch_more else "")
        + ("디테일 재설계: 이 구간을 처음 설계보다 훨씬 촘촘하게 다시 만드세요. 현재 구간의 방향·문구는 참고만 하고 더 풍부하게 바꿔도 됩니다." "FULL 이면 장면을 자막 1~3문장(3~7초)마다 나누고(같은 템플릿 연속 금지), 장면마다 keys 로 자막 문장 하나하나의 핵심 키워드를 빠짐없이 넣고, ""회사·제품·앱 이름이 나오면 로고(asset)를, 설정·메뉴 설명은 APP_WINDOW 를, 기능·화면 소개는 IMAGE_CARDS/SHOWCASE 를 적극 쓰세요. ""OVERLAY 면 문장마다 fx 비트를 하나 이상 넣고(zoom·ring·underline·click·spotlight 를 섞어서), 가까운 대상은 zoom 비트를 연달아 넣어 확대한 채 이동하게 하세요. 글자·도형 카드는 금지." + "\n\n" if detail else "")
        + f"사용자 요청: {request}\n\n"
        "답 형식: {\"assets\": [], \"segments\": [{\"id\": \"C2\", \"type\": …, \"scenes\": [{\"template\": …, \"vars\": {…}, \"beats\": [17, 18]}], "
        "\"beats\": [{\"sub\": 17, \"frame\": 1663, \"fx\": \"zoom\", \"target\": [x,y,w,h], \"zoom\": 1.6}]}], \"change\": \"…\"}  "
        "(FULL 은 scenes, OVERLAY 는 beats)\n\n"
        "현재 구간들:\n" + json.dumps([{
            **{k: sg.get(k) for k in ("id", "type", "from", "durationInFrames", "chapter", "title", "scenes")},
            "beats": [{k: bt.get(k) for k in ("sub", "frame", "fx", "target", "zoom", "until") if k in bt}
                      for bt in sg.get("beats") or []],
        } for sg in segs], ensure_ascii=False)
        + "\n\n이 범위 자막 [번호, 시작프레임, 시작초, 문장]:\n" + json.dumps(seg_subs, ensure_ascii=False)
        + "\n\nFULL 템플릿:\n" + json.dumps(_template_brief(cat), ensure_ascii=False)
        + "\n\nOVERLAY 효과:\n" + json.dumps(cat["overlay_fx"], ensure_ascii=False)
    )


def _run_edit(job_id: str, pid: str, client: str, request: str, sid: str | None, at_frame: int | None,
              rng: tuple[int, int] | None, fetch_more: bool = False, detail: bool = False) -> str:
    design = load_design(pid)
    if not design:
        raise RuntimeError("설계서가 없습니다.")
    if rng:
        a, b = rng
        new_ids = [x for x in (split_at(design, a), split_at(design, b)) if x]
        targets = [x["id"] for x in design["segments"] if x["from"] >= a and x["from"] + x["durationInFrames"] <= b]
        if not targets:
            raise RuntimeError("선택한 범위에 해당하는 구간이 없습니다.")
        if new_ids:
            save_design(pid, design)
            try:
                _thumbs(pid, design, set(new_ids) | {x["id"] for x in design["segments"] if x["id"] in targets})
            except Exception:  # noqa: BLE001
                pass
    else:
        idx = next((i for i, x in enumerate(design["segments"]) if x["id"] == sid), None) if sid else None
        if idx is None and at_frame is not None:
            idx = next((i for i, x in enumerate(design["segments"]) if x["from"] <= at_frame < x["from"] + x["durationInFrames"]), None)
        if idx is None:
            raise RuntimeError("고칠 구간을 찾지 못했습니다. 구간이나 시간 범위를 고르세요.")
        seg0 = design["segments"][idx]
        a, b = seg0["from"], seg0["from"] + seg0["durationInFrames"]
        targets = [seg0["id"]]
    segs = [x for x in design["segments"] if x["id"] in targets]
    _step(job_id, "edit", state="running", started=time.time(), segments=targets)
    subs = _subs(ensure_analysis(pid))
    work = mg.project_dir(pid) / "design_work"
    fps = float(Fraction(design["fps"]["num"], design["fps"]["den"]))
    capture_frame = at_frame if at_frame is not None else (a + b) // 2
    image = None
    if any(x["type"] == "OVERLAY" for x in segs) and client != "antigravity":
        work.mkdir(parents=True, exist_ok=True)
        image = work / f"edit_{capture_frame}.jpg"
        subprocess.run([str(get_ffmpeg_exe()), "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{capture_frame / fps:.3f}",
                        "-i", str(Path(mg.load_project(pid)["video_path"])), "-frames:v", "1", "-vf", "scale=960:540", "-q:v", "4",
                        str(image)], capture_output=True, timeout=60, creationflags=no_window_creationflags())
        image = image if image.is_file() else None
    answer = _cli(job_id, client, edit_prompt(design, segs, subs, request, a, b, at_frame, fetch_more, detail), work, "medium" if detail else "low", image)
    raws: dict[str, dict[str, Any]] = {}
    if isinstance(answer.get("segments"), list):
        raws = {str(r["id"]): r for r in answer["segments"] if isinstance(r, dict) and r.get("id")}
    elif isinstance(answer.get("segment"), dict) and len(targets) == 1:
        raws = {targets[0]: answer["segment"]}
    raws = {k: v for k, v in raws.items() if k in targets}
    if not raws:
        raise RuntimeError("AI 가 고친 구간을 돌려주지 않았습니다. 요청을 다르게 적어 다시 시도해 주세요.")
    sx, sy = int(design["width"]) / 960, int(design["height"]) / 540
    news: dict[str, dict[str, Any]] = {}
    for sg in segs:
        raw = raws.get(sg["id"])
        if raw is None:
            continue
        for bt in raw.get("beats") or []:
            ti = bt.get("target_img") if isinstance(bt, dict) else None
            if isinstance(ti, list) and len(ti) == 4 and all(isinstance(v, (int, float)) for v in ti):
                bt["target"] = [round(ti[0] * sx), round(ti[1] * sy), round(ti[2] * sx), round(ti[3] * sy)]
                bt["target_frame"] = capture_frame
        typ = str(raw.get("type") or sg["type"]).upper()
        new = normalize_segment({**sg, **raw}, {**sg, "type": typ if typ in TYPES else sg["type"]}, subs, catalog())
        if new["type"] == "OVERLAY":
            old_beats = {(b.get("frame"), b.get("fx"), tuple(b.get("target") or []), b.get("until")): b
                         for b in sg.get("beats") or [] if b.get("track")}
            for beat in new["beats"]:
                old = old_beats.get((beat.get("frame"), beat.get("fx"), tuple(beat.get("target") or []), beat.get("until")))
                if old:
                    beat["track"] = old["track"]
        new["reason"] = sg.get("reason", "")
        hist = list(sg.get("edits") or [])
        hist.append({"request": request[:300], "change": str(answer.get("change") or "")[:300], "at": time.strftime("%H:%M:%S")})
        new["edits"] = hist[-10:]
        news[sg["id"]] = new
    # AI 설계가 나온 즉시 미리보기 가능한 초안을 저장한다. 느린 웹 검색·추적은 뒤에서 보강한다.
    preview_news = copy.deepcopy(news)
    resolve_assets({"segments": list(preview_news.values())}, {}, {})
    preview = load_design(pid) or design
    preview["segments"] = [preview_news.get(x["id"], x) for x in preview["segments"]]
    save_design(pid, preview)
    with _lock:
        _jobs[job_id]["preview_ready"] = True
    _step(job_id, "edit", state="done", message="장면 설계 완료 · 미리보기 가능")
    _step(job_id, "assets", state="running", started=time.time())
    media_mode = str(design.get("media") or "photo")
    wanted = _referenced_assets({"segments": list(news.values())}, filter_assets([x for x in (answer.get("assets") or []) if isinstance(x, dict)],
                           media_mode if media_mode == "video" else "photo" if fetch_more else media_mode))
    missed: list[str] = []
    try:
        found = mgassets.fetch(mg.project_dir(pid) / "assets", wanted, failed=missed) if wanted else {}
    except (OSError, ValueError, RuntimeError) as exc:
        found = {}
        missed = [str(exc)[:90]]
    resolve_assets({"segments": list(news.values())}, found, {str(x.get("id")): str(x.get("q") or "") for x in wanted})
    _step(job_id, "assets", state="done", message=f"웹 자료 {len(found)}/{len(wanted)}개")
    _step(job_id, "locate", state="running", started=time.time())
    latest = load_design(pid) or design
    latest["segments"] = [news.get(x["id"], x) for x in latest["segments"]]
    locate_targets(pid, latest, set(news))
    track_targets(pid, latest, set(news))
    analysis = ensure_analysis(pid)
    discard_missing_media(pid, latest)
    fill_missing_images(pid, latest, analysis)
    finalize_design(latest, analysis)
    validate_design(latest)
    save_design(pid, latest)
    _step(job_id, "locate", state="done", message="화면 위치·추적 완료")
    msg = str(answer.get("change") or "수정했습니다")
    if wanted:
        msg += f" · 웹 이미지 {len(found)}/{len(wanted)}개 받음" + (f" (못 받음: {', '.join(missed)[:90]})" if missed else "")
    elif fetch_more:
        msg += " · AI 가 받을 자료를 요청하지 않아 새로 받은 이미지가 없습니다. 어떤 자료가 필요한지 요청에 구체적으로 적어 보세요"
    return f"{_ts(a / fps)}~{_ts(b / fps)} 범위를 고쳤습니다: {msg[:300]}"


def _worker(job_id: str, kind: str, args: tuple) -> None:
    try:
        msg = _run_design(job_id, *args) if kind == "design" else _run_edit(job_id, *args)
        state = "done"
    except InterruptedError:
        state, msg = "cancelled", "중지했습니다."
    except Exception as exc:  # noqa: BLE001
        state, msg = "failed", str(exc)[:500]
    with _lock:
        job = _jobs[job_id]
        if job.get("cancel"):
            state, msg = "cancelled", "중지했습니다."
        finished = time.time()
        if state == "done":
            timings = " · ".join(f"{st['key']} {st['elapsed']:.1f}초" for st in job["steps"] if "elapsed" in st)
            if timings:
                msg += f" ({timings})"
        job.update(state=state, message=msg, finished=finished, elapsed=round(finished - job["created"], 2))
        for st in job["steps"]:
            if st.get("state") == "running":
                st["state"] = "failed" if state == "failed" else "cancelled"
                st["message"] = msg if state == "failed" else st.get("message", "")
            elif st.get("state") == "queued":
                st["state"] = "cancelled"


def _start(pid: str, client: str, kind: str, steps: list[str], args: tuple) -> dict[str, Any]:
    if client not in mai.CLIENTS:
        raise ValueError("Claude Code · Codex · Antigravity 중에서 고르세요.")
    meta = mg.load_project(pid)
    if meta.get("phase") != "ready":
        raise RuntimeError("영상 분석이 끝난 뒤에 실행할 수 있습니다.")
    mai._executable(client)
    with _lock:
        running = _project_job.get(pid)
        if running and _jobs.get(running, {}).get("state") == "running":
            raise RuntimeError("이 프로젝트는 이미 AI 작업이 진행 중입니다.")
        job_id = uuid.uuid4().hex[:12]
        _jobs[job_id] = {"job_id": job_id, "kind": kind, "project_id": pid, "client": client, "client_name": mai.LABELS[client],
                         "state": "running", "message": "", "created": time.time(), "finished": None, "cancel": False,
                         "_proc": None, "steps": [{"key": k, "state": "queued"} for k in steps]}
        _project_job[pid] = job_id
    threading.Thread(target=_worker, args=(job_id, kind, args), daemon=True).start()
    return status(job_id)


# ── 내 이미지 (사용자가 올린 사진을 특정 자막에 넣기) ─────────────────────────

USER_IMAGE_MAX = 10 * 1024 * 1024
_USER_MAGIC = ((b"\x89PNG\r\n\x1a\n", ".png"), (b"\xff\xd8\xff", ".jpg"), (b"GIF87a", ".gif"), (b"GIF89a", ".gif"))


def _user_dir(pid: str) -> Path:
    return mg.project_dir(pid) / "assets" / "user"


def _image_ext(data: bytes) -> str | None:
    for magic, ext in _USER_MAGIC:
        if data.startswith(magic):
            return ext
    return ".webp" if data[:4] == b"RIFF" and data[8:12] == b"WEBP" else None


def save_user_image(pid: str, name: str, data: bytes) -> dict[str, Any]:
    """올린 이미지를 assets/user/ 에 둔다. 확장자가 아니라 파일 내용(매직 바이트)으로 이미지인지 확인한다."""
    if len(data) > USER_IMAGE_MAX:
        raise ValueError("이미지는 한 장에 10MB 까지 올릴 수 있습니다.")
    ext = _image_ext(data)
    if not ext:
        raise ValueError("PNG · JPG · WEBP · GIF 이미지만 올릴 수 있습니다.")
    stem = re.sub(r"[^0-9A-Za-z가-힣_-]+", "_", Path(name or "image").stem).strip("_")[:40] or "image"
    folder = _user_dir(pid)
    folder.mkdir(parents=True, exist_ok=True)
    final, n = f"{stem}{ext}", 2
    while (folder / final).exists():
        final, n = f"{stem}_{n}{ext}", n + 1
    (folder / final).write_bytes(data)
    return {"name": final, "path": f"user/{final}", "size": len(data)}


def list_user_images(pid: str) -> list[dict[str, Any]]:
    folder = _user_dir(pid)
    if not folder.is_dir():
        return []
    files = sorted((f for f in folder.iterdir() if f.is_file()), key=lambda f: -f.stat().st_mtime)
    return [{"name": f.name, "path": f"user/{f.name}", "size": f.stat().st_size} for f in files]


def delete_user_image(pid: str, name: str) -> bool:
    path = (_user_dir(pid) / Path(name).name)
    if not path.is_file():
        return False
    path.unlink()
    return True


def _busy(pid: str) -> bool:
    with _lock:
        running = _project_job.get(pid)
        return bool(running and _jobs.get(running, {}).get("state") == "running")


def place_user_image(pid: str, file: str, sub: int, sub_end: int | None = None, caption: str = "") -> dict[str, Any]:
    """올린 이미지를 자막 sub(~sub_end) 구간에 대표 이미지 장면으로 넣는다. AI 없이 코드가 바로 고친다.

    범위 양 끝을 구간 경계로 맞춘 뒤(split_at) 안쪽 구간들을 FULL 구간 하나로 바꾼다. 이미지는 비율 그대로 들어간다(framedPic).
    """
    if _busy(pid):
        raise RuntimeError("AI 작업이 끝난 뒤에 넣을 수 있습니다.")
    name = Path(file or "").name
    if not (_user_dir(pid) / name).is_file():
        raise ValueError("올린 이미지를 찾을 수 없습니다.")
    design = load_design(pid)
    if not design:
        raise ValueError("설계서가 없습니다. 먼저 「① AI 모션 설계서 생성」을 실행하세요.")
    subs = _subs(ensure_analysis(pid))
    first, last = subs.get(int(sub)), subs.get(int(sub_end if sub_end is not None else sub))
    if not first or not last or last["s"] < first["s"]:
        raise ValueError("자막 번호를 확인하세요.")
    total = int(design["durationInFrames"])
    a = max(0, int(first["s"]))
    b = min(total, max(int(last["e"]), a + 60))  # 한 자막이 너무 짧으면 2초는 보여준다
    if b - a < 30:
        raise ValueError("이미지를 보여줄 시간이 너무 짧습니다.")
    new_ids = [x for x in (split_at(design, a), split_at(design, b)) if x]
    inside = [x for x in design["segments"] if x["from"] >= a and x["from"] + x["durationInFrames"] <= b]
    if not inside:
        raise RuntimeError("그 자막 구간을 찾지 못했습니다.")
    head = inside[0]
    text = str(caption or "").strip() or str(first.get("t") or "")
    raw = {"id": head["id"], "type": "FULL", "chapter": head.get("chapter", ""), "title": head.get("title", ""),
           "reason": "사용자가 올린 이미지를 넣은 구간",
           "scenes": [{"template": "SHOWCASE", "vars": {"img": f"user/{name}", "caption": text[:30]},
                       "beats": [{"sub": int(sub), "frame": a}, {"sub": int(sub), "frame": a + 12}, {"sub": int(sub), "frame": a + 24}]}]}
    seg = {"id": head["id"], "type": "FULL", "from": a, "durationInFrames": b - a}
    new = normalize_segment(raw, seg, subs, catalog())
    new["reason"] = raw["reason"]
    new["edits"] = [{"request": f"내 이미지 {name} → 자막 {sub}" + (f"~{sub_end}" if sub_end not in (None, sub) else ""), "change": "대표 이미지 장면으로 교체", "at": time.strftime("%H:%M:%S")}]
    drop = {x["id"] for x in inside[1:]}
    design["segments"] = [new if x["id"] == head["id"] else x for x in design["segments"] if x["id"] not in drop]
    save_design(pid, design)
    try:
        _thumbs(pid, design, {head["id"]} | set(new_ids))
    except Exception:  # noqa: BLE001
        pass
    return design


def start(pid: str, client: str, style: str | None = None, directives: str = "", instruction: str = "", media: str = "photo") -> dict[str, Any]:
    """style: 보관함 디자인 id (없으면 AI 가 이번 영상에 맞는 새 디자인을 만든다)"""
    if style and not mgstyles.get_style(style):
        raise ValueError("보관함에서 그 디자인을 찾을 수 없습니다.")
    if len(directives) > 20000 or len(instruction) > 2000:
        raise ValueError("지시문이 너무 깁니다.")
    return _start(pid, client, "design", ["analyze", "design", "assets", "locate"],
                  (pid, client, style, directives.strip(), instruction.strip(), media if media in MEDIA_MODES else "photo"))


def start_edit(pid: str, client: str, request: str, sid: str | None = None, at_frame: int | None = None,
               start_frame: int | None = None, end_frame: int | None = None, fetch_more: bool = False,
               detail: bool = False) -> dict[str, Any]:
    request = (request or "").strip()
    if not request or len(request) > 1000:
        raise ValueError("수정 요청을 1~1,000자로 적어 주세요.")
    design = load_design(pid)
    if not design:
        raise ValueError("설계서가 없습니다. 먼저 「설계하기」를 실행하세요.")
    rng = None
    if start_frame is not None or end_frame is not None:
        total = int(design["durationInFrames"])
        a = max(0, int(start_frame if start_frame is not None else 0))
        b = min(total, int(end_frame if end_frame is not None else total))
        if b - a < 15:
            raise ValueError("시간 범위가 너무 짧습니다 (0.5초 이상 고르세요).")
        rng = (a, b)
    return _start(pid, client, "edit", ["edit", "assets", "locate"],
                  (pid, client, request, sid, at_frame, rng, bool(fetch_more), bool(detail)))


def status(job_id: str) -> dict[str, Any]:
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            raise KeyError(job_id)
        out = {k: v for k, v in job.items() if not k.startswith("_")}
        out["steps"] = [dict(s) for s in job["steps"]]
        return out


def project_status(pid: str) -> dict[str, Any] | None:
    with _lock:
        job_id = _project_job.get(pid)
    try:
        return status(job_id) if job_id else None
    except KeyError:
        return None


def cancel(job_id: str) -> bool:
    with _lock:
        job = _jobs.get(job_id)
        if not job or job["state"] != "running":
            return False
        job["cancel"] = True
        proc = job.get("_proc")
    if proc is not None:
        try:
            proc.kill()
        except OSError:
            pass
    return True
