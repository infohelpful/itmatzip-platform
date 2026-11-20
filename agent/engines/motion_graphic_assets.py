"""모션그래픽 에셋 수집 — AI 가 설계서에 적은 검색어로 웹에서 로고·사진을 받아 프로젝트 assets/web/ 에 둔다.

- 출처: 위키데이터(이름이 정해진 대상의 공식 로고·대표 이미지) → Wikimedia Commons, Openverse(Flickr 등 수십 곳), NASA, 그리고 무료 API 키가 있으면 Pexels · Pixabay. Openverse(사진, 상업적 이용 가능 라이선스만)
- 밖으로 나가는 것은 검색어(예: "Windows 11 logo")뿐이다. 영상·자막·사용자 정보는 보내지 않는다.
- 받은 파일마다 출처·작성자·라이선스를 assets/credits.json 에 남긴다 (영상 설명란 표기용).
- 다운로드는 정해진 이미지 호스트(https)만, 한 장 15MB 까지.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from common.bin_manager import get_ffmpeg_exe

_UA = "ItMatZipTools-MotionGraphic/1.0 (asset search; https://tools.itmatzip.com)"
_ALLOWED_DOMAINS = ("wikimedia.org", "staticflickr.com", "openverse.org", "rawpixel.com", "stocksnap.io", "pexels.com",
                    "pixabay.com", "unsplash.com", "nasa.gov")
_MAX_BYTES = 15 * 1024 * 1024
_MAX_VIDEO_BYTES = 80 * 1024 * 1024
_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg"}
KINDS = ("logo", "photo", "screenshot", "video")
_COMMONS_SLOTS = threading.BoundedSemaphore(2)
_OTHER_SLOTS = threading.BoundedSemaphore(4)


def _get_json(url: str, timeout: float = 12, headers: dict[str, str] | None = None) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept": "application/json", **(headers or {})})
    host = urllib.parse.urlparse(url).hostname or ""
    slot = _COMMONS_SLOTS if host.endswith("wikimedia.org") else _OTHER_SLOTS
    with slot:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))


def _strip_html(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s or "").strip()[:200]


def _commons_candidate(page: dict[str, Any]) -> dict[str, Any] | None:
    info = (page.get("imageinfo") or [{}])[0]
    meta = info.get("extmetadata") or {}
    url = info.get("thumburl") or info.get("url")
    if not url:
        return None
    return {"source": "Wikimedia Commons", "title": page.get("title", ""), "url": url, "page": info.get("descriptionurl"),
            "mime": info.get("mime"), "width": info.get("thumbwidth") or info.get("width"), "height": info.get("thumbheight") or info.get("height"),
            "size": info.get("size"),
            "license": _strip_html((meta.get("LicenseShortName") or {}).get("value", "")),
            "author": _strip_html((meta.get("Artist") or {}).get("value", ""))}


def search_commons(q: str, kind: str, limit: int = 8) -> list[dict[str, Any]]:
    filetype = "filetype:drawing|bitmap" if kind == "logo" else "filetype:bitmap"
    params = {
        "action": "query", "format": "json", "generator": "search", "gsrnamespace": "6", "gsrlimit": str(limit),
        "gsrsearch": f"{q} {filetype}", "prop": "imageinfo", "iiprop": "url|extmetadata|mime|size",
        "iiurlwidth": "1600" if kind != "logo" else "800",
    }
    data = _get_json("https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(params))
    out = []
    for page in sorted((data.get("query") or {}).get("pages", {}).values(), key=lambda p: p.get("index", 99)):
        cand = _commons_candidate(page)
        if cand:
            out.append(cand)
    return out


def search_commons_video(q: str, limit: int = 8) -> list[dict[str, Any]]:
    """API 키 없이 이용 가능한 Commons 교육·자료 영상을 찾는다."""
    params = {"action": "query", "format": "json", "generator": "search", "gsrnamespace": "6", "gsrlimit": str(limit),
              "gsrsearch": f"{q} filetype:video", "prop": "imageinfo", "iiprop": "url|extmetadata|mime|size"}
    data = _get_json("https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(params))
    out = []
    for page in sorted((data.get("query") or {}).get("pages", {}).values(), key=lambda p: p.get("index", 99)):
        cand = _commons_candidate(page)
        if cand and cand["mime"] in {"video/webm", "video/ogg"} and (cand["size"] or 0) <= _MAX_VIDEO_BYTES \
                and (cand["width"] or 0) >= 640 and (cand["height"] or 0) >= 360:
            out.append(cand)
    return out


def search_wikidata(q: str, kind: str) -> list[dict[str, Any]]:
    """이름이 정해진 대상(회사·제품·부품·장소)은 위키데이터의 공식 로고(P154)·대표 이미지(P18)를 쓴다 — 동음이의어에 속지 않는다."""
    plain = " ".join(w for w in re.split(r"\s+", q) if w.lower() not in _GENERIC).strip()
    if not plain:
        return []
    base = "https://www.wikidata.org/w/api.php?format=json&"
    hits = _get_json(base + urllib.parse.urlencode({"action": "wbsearchentities", "search": plain, "language": "en", "limit": "5"})).get("search", [])
    if not hits:
        return []
    ents = _get_json(base + urllib.parse.urlencode({"action": "wbgetentities", "ids": "|".join(h["id"] for h in hits), "props": "claims|labels",
                                                      "languages": "en"})).get("entities", {})
    prop = "P154" if kind == "logo" else "P18"
    files: list[tuple[str, str]] = []
    for h in hits:
        claims = (ents.get(h["id"]) or {}).get("claims", {}).get(prop) or []
        name = next((c["mainsnak"]["datavalue"]["value"] for c in claims if c.get("mainsnak", {}).get("datavalue")), None)
        label = h.get("label") or ""
        lw = [x for x in re.split(r"\W+", label.lower()) if x and x not in _GENERIC]
        qw = set(x for x in re.split(r"\W+", plain.lower()) if x)
        hit = sum(1 for x in lw if x in qw)
        # 찾은 항목의 이름이 검색어와 실제로 맞아야 한다 (추상적인 긴 검색어가 엉뚱한 항목에 걸리는 것을 막는다)
        if name and lw and hit / len(lw) >= 0.75 and hit / max(1, len(qw)) >= 0.5:
            files.append((name, label))
    if not files:
        return []
    params = {"action": "query", "format": "json", "titles": "|".join("File:" + n for n, _ in files[:3]), "prop": "imageinfo",
              "iiprop": "url|extmetadata|mime|size", "iiurlwidth": "1600" if kind != "logo" else "800"}
    data = _get_json("https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(params))
    labels = {"file:" + n.replace("_", " ").lower(): lab for n, lab in files}
    out = []
    for page in (data.get("query") or {}).get("pages", {}).values():
        cand = _commons_candidate(page)
        if cand:
            label = labels.get(cand["title"].replace("_", " ").lower(), plain)
            cand.update(trusted=True, match=label + (" logo" if kind == "logo" else ""), source="Wikidata → Wikimedia Commons")
            out.append(cand)
    return out


def search_openverse(q: str, limit: int = 8) -> list[dict[str, Any]]:
    params = {"q": q, "page_size": str(limit), "license_type": "commercial", "mature": "false"}
    data = _get_json("https://api.openverse.org/v1/images/?" + urllib.parse.urlencode(params))
    return [{"source": f"Openverse ({r.get('source', '')})", "title": r.get("title", ""),
             "match": " ".join([str(r.get("title") or "")] + [str(t.get("name") or "") for t in r.get("tags") or [] if isinstance(t, dict)]),
             "url": r.get("url"), "page": r.get("foreign_landing_url"),
             "mime": None, "width": r.get("width"), "height": r.get("height"),
             "license": f"{(r.get('license') or '').upper()} {r.get('license_version') or ''}".strip(), "author": r.get("creator") or ""}
            for r in data.get("results", []) if r.get("url")]


def _api_key(name: str) -> str:
    """무료 API 키(선택): 환경변수 PEXELS_API_KEY · PIXABAY_API_KEY 또는 %APPDATA%/ItMatZip/motion-keys.json."""
    key = os.environ.get(f"{name.upper()}_API_KEY", "").strip()
    if key:
        return key
    try:
        path = Path(os.environ.get("APPDATA") or Path.home()) / "ItMatZip" / "motion-keys.json"
        return str(json.loads(path.read_text(encoding="utf-8")).get(name, "")).strip()
    except (OSError, ValueError):
        return ""


def search_nasa(q: str, limit: int = 6) -> list[dict[str, Any]]:
    """NASA 이미지 라이브러리 (키 없음, 대부분 퍼블릭 도메인) — 우주·항공·초기 컴퓨터 같은 주제."""
    data = _get_json("https://images-api.nasa.gov/search?" + urllib.parse.urlencode({"q": q, "media_type": "image", "page_size": str(limit)}))
    out = []
    for it in (data.get("collection") or {}).get("items", []):
        meta = (it.get("data") or [{}])[0]
        thumb = next((l.get("href") for l in it.get("links") or [] if l.get("render") == "image"), None)
        if not thumb:
            continue
        out.append({"source": "NASA Image Library", "title": meta.get("title", ""), "url": thumb.replace("~thumb.", "~medium."), "page": f"https://images.nasa.gov/details/{meta.get('nasa_id', '')}",
                    "mime": None, "width": None, "height": None, "license": "NASA (public domain)", "author": meta.get("photographer") or meta.get("center") or "NASA"})
    return out


def search_pexels(q: str, limit: int = 6) -> list[dict[str, Any]]:
    key = _api_key("pexels")
    if not key:
        return []
    data = _get_json("https://api.pexels.com/v1/search?" + urllib.parse.urlencode({"query": q, "per_page": str(limit), "orientation": "landscape"}), headers={"Authorization": key})
    return [{"source": "Pexels", "title": r.get("alt") or "", "url": (r.get("src") or {}).get("large2x"), "page": r.get("url"), "mime": None,
             "width": r.get("width"), "height": r.get("height"), "license": "Pexels License (free)", "author": r.get("photographer") or "", "stock": True}
            for r in data.get("photos", []) if (r.get("src") or {}).get("large2x")]


def search_pexels_video(q: str, limit: int = 6) -> list[dict[str, Any]]:
    """기존 Pexels API 키가 있을 때만 짧은 무음 배경 클립 후보를 받는다."""
    key = _api_key("pexels")
    if not key:
        return []
    data = _get_json("https://api.pexels.com/v1/videos/search?" + urllib.parse.urlencode(
        {"query": q, "per_page": str(limit), "orientation": "landscape", "size": "medium"}),
        headers={"Authorization": key})
    out = []
    for item in data.get("videos", []):
        files = [f for f in item.get("video_files") or [] if f.get("file_type") == "video/mp4"
                 and f.get("link") and (f.get("width") or 0) >= 1280
                 and (f.get("file_size") or 0) <= _MAX_VIDEO_BYTES]
        if not files or not (2 <= (item.get("duration") or 0) <= 60):
            continue
        chosen = min(files, key=lambda f: (abs((f.get("width") or 1920) - 1920), f.get("file_size") or 0))
        out.append({"source": "Pexels", "title": q, "url": chosen["link"], "page": item.get("url"),
                    "mime": "video/mp4", "width": chosen.get("width"), "height": chosen.get("height"),
                    "license": "Pexels License (free)", "author": (item.get("user") or {}).get("name") or "", "stock": True})
    return out


def search_pixabay(q: str, limit: int = 6) -> list[dict[str, Any]]:
    key = _api_key("pixabay")
    if not key:
        return []
    data = _get_json("https://pixabay.com/api/?" + urllib.parse.urlencode({"key": key, "q": q, "image_type": "photo", "per_page": str(limit), "safesearch": "true", "orientation": "horizontal"}))
    return [{"source": "Pixabay", "title": r.get("tags") or "", "url": r.get("largeImageURL"), "page": r.get("pageURL"), "mime": None,
             "width": r.get("imageWidth"), "height": r.get("imageHeight"), "license": "Pixabay License (free)", "author": r.get("user") or "", "stock": True}
            for r in data.get("hits", []) if r.get("largeImageURL")]


def _score(c: dict[str, Any], kind: str, q: str, context: str = "") -> float:
    title = (c.get("match") or c.get("title") or "").lower()
    w, h = c.get("width") or 0, c.get("height") or 0
    s = 20.0 if c.get("trusted") else (2.0 if c.get("stock") else 0.0)  # 위키데이터가 가리키는 공식 이미지는 항상 먼저
    words = [x for x in re.split(r"\W+", q.lower()) if len(x) > 1]
    stem = re.sub(r"^file:|\.[a-z0-9]{2,4}$", "", title).strip()
    stem_words = [x for x in re.split(r"[\W_]+", stem) if len(x) > 1]
    s += sum(1.0 for x in words if x in stem_words)
    if stem_words and words and set(words) <= set(stem_words):
        s += 2.0                                   # 검색어 단어가 모두 들어 있음
        s -= 0.6 * min(4, len(set(stem_words) - set(words)))  # 군더더기 단어(Office, 연도 등)는 감점
    if stem and stem == " ".join(words):
        s += 6.0                                   # 파일명이 검색어와 같음 (예: Windows 11 logo)
    scene_words = {x for x in re.split(r"\W+", context.lower()) if len(x) > 2 and x not in _GENERIC}
    s += min(2.0, 0.4 * len(scene_words.intersection(stem_words)))
    if kind == "logo":
        s += 2.0 if "logo" in title or "icon" in title else 0
        s += 1.0 if (c.get("mime") or "").endswith(("svg+xml", "png")) else 0
    else:
        s += 1.5 if w >= 1200 else 0
        s += 1.0 if w and h and 1.2 <= w / h <= 2.0 else 0
        s -= 2.0 if "logo" in title else 0
        if kind == "video":
            s += 1.0 if 1280 <= w <= 1920 else 0
            s -= min(3.0, max(0, (c.get("size") or 0) - 20 * 1024 * 1024) / (20 * 1024 * 1024))
    if re.search(r"\b(map|flag|coat of arms|diagram)\b", title):
        s -= 1.5
    return s


def _license_ok(c: dict[str, Any]) -> bool:
    """편집·크롭 가능한 소재만 자동 선택한다. 라이선스가 불명확한 파일은 건너뛴다."""
    license_name = str(c.get("license") or "").upper()
    if c.get("stock") or c.get("source") in {"NASA Image Library", "Pexels", "Pixabay"}:
        return True
    if any(mark in license_name for mark in ("-NC", "-ND", "NONCOMMERCIAL", "NO DERIV")):
        return False
    if str(c.get("source") or "").startswith("Openverse"):
        return license_name.split(" ", 1)[0] in {"CC0", "PDM", "BY", "BY-SA"}
    return any(mark in license_name for mark in ("CC0", "CC BY", "CC-BY", "PUBLIC DOMAIN", "PDM"))


_GENERIC = {"logo", "icon", "screenshot", "photo", "image", "picture", "closeup", "close", "up", "and", "the", "of", "for", "with", "modern", "new"}
_BAD_WORDS = {"anti", "censored", "protest", "meme", "cartoon", "parody", "fanart", "wallpaper", "vandal"}


def _relevant(title: str, kind: str, q: str) -> bool:
    """점수와 별개의 하한선: 엉뚱한 결과(예: 'Corsair' 로고 검색 → 전투기 사진)는 아예 받지 않는다."""
    t = (title or "").lower()
    stem = re.sub(r"^file:|\.[a-z0-9]{2,4}$", "", t)
    stem_words = set(x for x in re.split(r"[\W_]+", stem) if x)
    if stem_words & _BAD_WORDS:
        return False
    core = [x for x in re.split(r"\W+", q.lower()) if len(x) > 1 and x not in _GENERIC]
    if not core:
        return True
    hit = sum(1 for x in core if x in stem_words)
    need = len(core) if len(core) <= 2 else -(-len(core) * 7 // 10)  # 3단어 이상은 70% 이상 일치
    if kind == "logo":
        return hit >= (1 if len(core) <= 2 else need) and any(k in t for k in ("logo", "icon", "symbol", "wordmark", "emblem"))
    return hit >= need


def _stock_ok(c: dict[str, Any], q: str) -> bool:
    """스톡 사진 사이트는 자체 검색이 정확하다 — 설명(태그)에 검색어 핵심 단어가 하나라도 있으면 받는다."""
    words = set(re.split(r"[\W_]+", (c.get("title") or "").lower()))
    core = [x for x in re.split(r"\W+", q.lower()) if len(x) > 1 and x not in _GENERIC]
    return not core or any(x in words for x in core)


def _download(url: str, dest_stem: Path) -> Path:
    host = urllib.parse.urlparse(url).hostname or ""
    if not url.startswith("https://") or not any(host == d or host.endswith("." + d) for d in _ALLOWED_DOMAINS):
        raise ValueError(f"허용되지 않은 이미지 주소입니다: {host}")
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept": "image/*"})
    with urllib.request.urlopen(req, timeout=30) as r:
        final_host = urllib.parse.urlparse(r.geturl()).hostname or ""
        if not r.geturl().startswith("https://") or not any(final_host == d or final_host.endswith("." + d) for d in _ALLOWED_DOMAINS):
            raise ValueError(f"허용되지 않은 리다이렉트 주소입니다: {final_host}")
        ctype = (r.headers.get_content_type() or "").lower()
        ext = _EXT.get(ctype)
        if not ext:
            raise ValueError(f"이미지가 아닌 응답입니다 ({ctype})")
        data = r.read(_MAX_BYTES + 1)
    if len(data) > _MAX_BYTES:
        raise ValueError("이미지가 15MB 를 넘습니다.")
    path = dest_stem.with_suffix(ext)
    path.write_bytes(data)
    return path


def _download_video(url: str, dest_stem: Path) -> Path:
    host = urllib.parse.urlparse(url).hostname or ""
    allowed = lambda h: h == "pexels.com" or h.endswith(".pexels.com") or h == "wikimedia.org" or h.endswith(".wikimedia.org")
    if not url.startswith("https://") or not allowed(host):
        raise ValueError(f"허용되지 않은 영상 주소입니다: {host}")
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept": "video/mp4"})
    with urllib.request.urlopen(req, timeout=45) as r:
        final_host = urllib.parse.urlparse(r.geturl()).hostname or ""
        if not r.geturl().startswith("https://") or not allowed(final_host):
            raise ValueError(f"허용되지 않은 영상 리다이렉트입니다: {final_host}")
        mime = r.headers.get_content_type().lower()
        if mime not in {"video/mp4", "video/webm", "video/ogg", "application/octet-stream"}:
            raise ValueError("지원하지 않는 영상 응답입니다.")
        data = r.read(_MAX_VIDEO_BYTES + 1)
    if len(data) > _MAX_VIDEO_BYTES:
        raise ValueError("영상 크기 또는 형식이 올바르지 않습니다.")
    path = dest_stem.with_suffix(".mp4")
    if b"ftyp" in data[:32]:
        path.write_bytes(data)
        return path
    if data.startswith(b"\x1a\x45\xdf\xa3"):
        ext = ".webm"
    elif data.startswith(b"OggS"):
        ext = ".ogv"
    else:
        raise ValueError("영상 파일 시그니처가 올바르지 않습니다.")
    original = dest_stem.with_suffix(ext)
    try:
        original.write_bytes(data)
        proc = subprocess.run([str(get_ffmpeg_exe()), "-hide_banner", "-loglevel", "error", "-y", "-i", str(original),
                               "-t", "12", "-vf", "scale=w='min(1920,iw)':h=-2", "-an", "-c:v", "libx264",
                               "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", str(path)],
                              capture_output=True, timeout=90, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if proc.returncode or not path.is_file() or path.stat().st_size == 0:
            raise ValueError("Commons 영상 변환에 실패했습니다.")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        path.unlink(missing_ok=True)
        raise
    finally:
        original.unlink(missing_ok=True)
    return path


def _slug(s: str) -> str:
    s = re.sub(r"[^0-9A-Za-z가-힣_-]+", "_", s).strip("_")
    return (s or "asset")[:40]


def _variants(q: str, kind: str) -> list[str]:
    """검색어 후보: 원래 → 군더더기 단어를 뺀 것 → 앞 3단어 → 앞 2단어 (너무 구체적인 검색어가 실패하는 걸 막는다)."""
    plain = re.sub(r"(?i)\b(logo|icon|screenshot|photo|image|picture)\b", " ", q)
    words = plain.split()
    tail = " logo" if kind == "logo" else ""
    out = [q]
    for n in ((len(words), 3, 2) if kind == "logo" else (len(words), 3)):  # 사진·스크린샷은 2단어까지 줄이면 뜻이 사라진다
        if 1 <= n <= len(words):
            out.append(" ".join(words[:n]) + tail)
    seen: set[str] = set()
    return [v.strip() for v in out if v.strip() and not (v.strip().lower() in seen or seen.add(v.strip().lower()))]


def fetch(assets_dir: Path, requests_: list[dict[str, Any]], *, on_progress=None, failed: list[str] | None = None) -> dict[str, str]:
    """[{id, q, kind}] → {id: "web/파일명"}. 못 찾은 id 는 빠지고 failed 에 검색어가 담긴다. 같은 검색어는 다시 받지 않는다."""
    web = assets_dir / "web"
    web.mkdir(parents=True, exist_ok=True)
    credits_path = assets_dir / "credits.json"
    try:
        credits = json.loads(credits_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        credits = {}
    out: dict[str, str] = {}
    work = []
    for req in requests_[:24]:
        aid = _slug(str(req.get("id") or ""))
        q0 = str(req.get("q") or "").strip()[:80]
        kind = req.get("kind") if req.get("kind") in KINDS else "photo"
        if aid and q0:
            work.append((aid, q0, kind, str(req.get("context") or "")[:120]))

    def candidates(item: tuple[str, str, str, str]) -> tuple[str, str, str, list[dict[str, Any]]]:
        aid, q0, kind, context = item
        cached = next((k for k, v in credits.items() if v.get("query") == q0 and v.get("kind") == kind
                       and (kind == "logo" or not context or v.get("context") == context)
                       and (web / k).is_file() and _license_ok(v)
                       and _relevant(v.get("title", ""), kind, q0)), None)
        if cached:
            return aid, q0, kind, [{"cached": cached, "url": str((web / cached).resolve())}]
        ranked: list[dict[str, Any]] = []
        seen: set[str] = set()
        for q in _variants(q0, kind):
            searches = [search_pexels_video, search_commons_video] if kind == "video" else [search_commons]
            if kind not in ("screenshot", "video"):
                searches.insert(0, search_wikidata)
            if kind not in ("logo", "video"):
                searches.extend((search_openverse, search_pexels, search_pixabay))
                if re.search(r"(?i)\b(nasa|space|moon|mars|apollo|rocket|satellite)\b", q):
                    searches.append(search_nasa)
            # 한 에셋의 출처는 동시에 조회하되 전체 작업은 최대 세 에셋만 실행한다.
            with ThreadPoolExecutor(max_workers=3) as sources:
                futures = [sources.submit(fn, q, kind) if fn in (search_commons, search_wikidata)
                           else sources.submit(fn, q) for fn in searches]
                for future in as_completed(futures):
                    try:
                        hits = future.result()
                    except (OSError, ValueError, KeyError):
                        continue
                    for c in hits:
                        url = str(c.get("url") or "")
                        if url in seen or not _license_ok(c):
                            continue
                        if not (_stock_ok(c, q) if c.get("stock") else _relevant(c.get("match") or c.get("title", ""), kind, q)):
                            continue
                        seen.add(url)
                        ranked.append({**c, "rank": _score(c, kind, q, context) - (0.5 if q != q0 else 0)})
            if ranked:
                break
            time.sleep(0.3)
        if kind == "video" and not ranked:
            # 영상 API 키가 없거나 검색에 실패하면 같은 장면의 사진으로 대체한다.
            for fn in (search_openverse, search_pexels, search_pixabay):
                try:
                    hits = fn(q0)
                except (OSError, ValueError, KeyError):
                    continue
                for c in hits:
                    if _license_ok(c) and (_stock_ok(c, q0) if c.get("stock") else _relevant(c.get("title", ""), "photo", q0)):
                        ranked.append({**c, "rank": _score(c, "photo", q0, context), "download_kind": "photo"})
        ranked.sort(key=lambda c: -c["rank"])
        return aid, q0, kind, ranked[:8]

    # 검색 결과를 먼저 모은 뒤 중복 URL을 피해서 장면에 배정한다.
    results: dict[str, tuple[str, str, list[dict[str, Any]]]] = {}
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(candidates, item): item for item in work}
        for future in as_completed(futures):
            aid, q0, kind, ranked = future.result()
            results[aid] = (q0, kind, ranked)

    contexts = {aid: context for aid, _, _, context in work}
    used_urls: set[str] = set()
    selected: list[tuple[str, str, str, list[dict[str, Any]]]] = []
    for aid, q0, kind, _ in work:
        ranked = results[aid][2]
        if ranked and ranked[0].get("cached"):
            out[aid] = f"web/{ranked[0]['cached']}"
            used_urls.add(ranked[0]["url"])
            continue
        ordered = [c for c in ranked if c["url"] not in used_urls] + [c for c in ranked if c["url"] in used_urls]
        if ordered:
            used_urls.add(ordered[0]["url"])
        selected.append((aid, q0, kind, ordered[:4]))

    def download(item: tuple[str, str, str, list[dict[str, Any]]]):
        aid, q0, kind, ranked = item
        for cand in ranked:
            try:
                download_kind = cand.get("download_kind") or kind
                path = (_download_video if download_kind == "video" else _download)(cand["url"], web / _slug(f"{aid}_{q0}"))
            except (OSError, ValueError, subprocess.TimeoutExpired):
                continue
            return aid, q0, kind, path, cand
        return aid, q0, kind, None, None

    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(download, item) for item in selected]
        for n, future in enumerate(as_completed(futures)):
            aid, q0, kind, path, cand = future.result()
            if path and cand:
                credits[path.name] = {"query": q0, "kind": kind, "context": contexts.get(aid, ""),
                                      **{k: cand.get(k) for k in ("source", "title", "page", "license", "author")}}
                out[aid] = f"web/{path.name}"
            elif failed is not None:
                failed.append(q0)
            if on_progress:
                on_progress(n, len(work), q0)
    credits_path.write_text(json.dumps(credits, ensure_ascii=False, indent=1), encoding="utf-8")
    return out
