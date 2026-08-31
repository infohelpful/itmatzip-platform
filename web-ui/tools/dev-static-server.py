#!/usr/bin/env python3
"""Local static server for web-ui/tools with the same /admin/api.php JSON API as production PHP."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import posixpath
import re
import secrets
import sys
import time
import urllib.parse
from datetime import datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.sax.saxutils import escape as xml_escape

ROOT = Path(__file__).resolve().parent
ADMIN = ROOT / "admin"
AUTH_FILE = ADMIN / "_auth.json"
DEFAULT_CONFIG = ADMIN / "site-config.json"
DATA_DIR = ADMIN / "data"
RUNTIME_CONFIG = DATA_DIR / "site-config.json"
RATE_FILE = DATA_DIR / "login-rate.json"
SESS_FILE = DATA_DIR / "sessions.json"
REGISTRY_FILE = ROOT / "assets" / "tools-registry.js"

LANG_PREFIXES = frozenset({"kr", "ko", "en", "ja", "zh"})
LANG_TO_URL_PREFIX = {"ko": "kr", "en": "en", "ja": "ja", "zh": "zh"}
URL_PREFIX_TO_LANG = {"kr": "ko", "ko": "ko", "en": "en", "ja": "ja", "zh": "zh"}
PUBLIC_SLUG_RENAMES = {"watermark-remover": "fixed-area-remover"}
SKIP_LANG_REDIRECT_FIRST = frozenset({"admin", "common", "assets"})
STATIC_FILE_EXT = frozenset(
    {
        ".css",
        ".js",
        ".mjs",
        ".map",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".svg",
        ".ico",
        ".woff",
        ".woff2",
        ".json",
        ".txt",
        ".xml",
        ".php",
        ".webmanifest",
    }
)

COOKIE_NAME = "itz_admin"
RATE_WINDOW_SEC = 900
RATE_MAX_ATTEMPTS = 8
SESSION_IDLE_SEC = 43200

ALLOWED_TOOL_IDS = frozenset(
    {
        "silence-remover",
        "auto-subtitle",
        "vocal-remover",
        "image-enhancer",
        "background-remover",
        "create-music",
        "magic-eraser",
        "voice-changer",
        "watermark-remover",
        "thumbnail-grabber",
        "ico-maker",
        "image-combiner",
        "unattend-maker",
        "online-clock",
        "json-formatter",
        "currency-calculator",
    }
)
ALLOWED_TOOL_ID_ORDER = (
    "silence-remover",
    "auto-subtitle",
    "vocal-remover",
    "image-enhancer",
    "background-remover",
    "create-music",
    "magic-eraser",
    "voice-changer",
    "watermark-remover",
    "thumbnail-grabber",
    "ico-maker",
    "image-combiner",
    "unattend-maker",
    "online-clock",
    "json-formatter",
    "currency-calculator",
)
ALLOWED_AD_UNITS = (
    "dashboardBanner",
    "editorAboveWorkspace",
    "editorBelowExport",
    "downloadTop",
    "downloadBottom",
)
TOOL_AD_UNITS = (
    "editorAboveWorkspace",
    "editorBelowExport",
    "downloadTop",
    "downloadBottom",
)
ALLOWED_LANGS = ("ko", "en", "ja", "zh")
ALLOWED_LEGAL_IDS = ("about", "policy", "email", "copyright", "disclaimer")
DEFAULT_ADS_CLIENT = "ca-pub-2088466558007407"


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _write_json(path: Path, data) -> bool:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(payload, encoding="utf-8")
        try:
            tmp.replace(path)
        except OSError:
            path.write_text(payload, encoding="utf-8")
            tmp.unlink(missing_ok=True)
        return True
    except OSError:
        return False


def default_config():
    data = _read_json(DEFAULT_CONFIG)
    if isinstance(data, dict):
        return data
    return {
        "hiddenToolIds": [],
        "mobileEnabledToolIds": default_mobile_enabled_tool_ids(),
        "adsense": {
            "enabled": True,
            "client": DEFAULT_ADS_CLIENT,
            "units": {},
        },
    }


def parse_tool_id_list(raw) -> list:
    out = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if isinstance(item, str) and item in ALLOWED_TOOL_IDS:
            out.append(item)
    return sorted(set(out), key=out.index)


def default_mobile_enabled_tool_ids() -> list:
    return parse_tool_id_list(
        [
            "thumbnail-grabber",
            "ico-maker",
            "image-combiner",
            "online-clock",
            "unattend-maker",
            "json-formatter",
            "currency-calculator",
        ]
    )


def itz_clip(value, max_len: int) -> str:
    s = str(value or "").strip()
    if not s:
        return ""
    s = re.sub(r"<[^>]*>", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    if not s:
        return ""
    return s[:max_len]


def empty_lang_map():
    return {lang: "" for lang in ALLOWED_LANGS}


def normalize_lang_map(raw, max_len: int):
    out = empty_lang_map()
    if not isinstance(raw, dict):
        return out
    for lang in ALLOWED_LANGS:
        v = raw.get(lang)
        if isinstance(v, str):
            out[lang] = itz_clip(v, max_len)
        elif isinstance(v, (int, float)):
            out[lang] = itz_clip(str(v), max_len)
    return out


def normalize_meta_fields(raw):
    src = raw if isinstance(raw, dict) else {}
    return {
        "title": itz_clip(src.get("title") or "", 80),
        "description": itz_clip(src.get("description") or "", 320),
        "keywords": itz_clip(src.get("keywords") or "", 500),
    }


def normalize_meta_langs(raw):
    src = raw if isinstance(raw, dict) else {}
    return {lang: normalize_meta_fields(src.get(lang)) for lang in ALLOWED_LANGS}


def normalize_og_image(value) -> str:
    s = value.strip() if isinstance(value, str) else ""
    if not s:
        return ""
    if not re.fullmatch(r"/assets/og/[a-zA-Z0-9._-]+\.(png|jpe?g|webp)", s, re.I):
        return ""
    return s


def normalize_ads_client(value, required: bool) -> str:
    client = value.strip() if isinstance(value, str) else ""
    if not client or not re.fullmatch(r"ca-pub-\d{8,22}", client):
        return DEFAULT_ADS_CLIENT if required else ""
    return client


def normalize_slot(value) -> str:
    slot = value.strip() if isinstance(value, str) else ""
    if slot and not re.fullmatch(r"\d{6,20}", slot):
        return ""
    return slot


def normalize_global_units(in_units, base_units):
    units = {}
    in_units = in_units if isinstance(in_units, dict) else {}
    base_units = base_units if isinstance(base_units, dict) else {}
    for key in ALLOWED_AD_UNITS:
        src = {}
        if isinstance(base_units.get(key), dict):
            src.update(base_units[key])
        if isinstance(in_units.get(key), dict):
            src.update(in_units[key])
        enabled = src.get("enabled")
        units[key] = {
            "enabled": True if enabled is None else bool(enabled),
            "slot": normalize_slot(src.get("slot") or ""),
            "adFormat": src["adFormat"] if isinstance(src.get("adFormat"), str) else "horizontal",
            "fullWidthResponsive": True if src.get("fullWidthResponsive") is None else bool(src.get("fullWidthResponsive")),
        }
    return units


def normalize_tool_ad_units(raw):
    out = {}
    if not isinstance(raw, dict):
        return out
    for key in TOOL_AD_UNITS:
        src = raw.get(key)
        if not isinstance(src, dict):
            continue
        has_enabled = "enabled" in src
        slot = normalize_slot(src.get("slot") or "")
        if not has_enabled and slot == "":
            continue
        out[key] = {
            "enabled": bool(src.get("enabled")) if has_enabled else True,
            "slot": slot,
            "adFormat": "horizontal",
            "fullWidthResponsive": True,
        }
    return out


def normalize_tool_entry(raw):
    src = raw if isinstance(raw, dict) else {}
    ads = src.get("adsense") if isinstance(src.get("adsense"), dict) else {}
    return {
        "title": normalize_lang_map(src.get("title"), 80),
        "subtitle": normalize_lang_map(src.get("subtitle"), 80),
        "description": normalize_lang_map(src.get("description"), 200),
        "badge": normalize_lang_map(src.get("badge"), 48),
        "meta": normalize_meta_langs(src.get("meta")),
        "ogImage": normalize_og_image(src.get("ogImage") or ""),
        "adsense": {
            "client": normalize_ads_client(ads.get("client") or "", False),
            "units": normalize_tool_ad_units(ads.get("units")),
        },
    }


def normalize_config(cfg) -> dict:
    if not isinstance(cfg, dict):
        cfg = {}
    hidden = parse_tool_id_list(cfg.get("hiddenToolIds"))
    if "mobileEnabledToolIds" in cfg:
        mobile = parse_tool_id_list(cfg.get("mobileEnabledToolIds"))
    else:
        mobile = default_mobile_enabled_tool_ids()

    ads = cfg.get("adsense") if isinstance(cfg.get("adsense"), dict) else {}
    client = normalize_ads_client(ads.get("client") or "", True)

    defaults = default_config()
    base_units = {}
    if isinstance(defaults.get("adsense"), dict) and isinstance(defaults["adsense"].get("units"), dict):
        base_units = defaults["adsense"]["units"]
    in_units = ads.get("units") if isinstance(ads.get("units"), dict) else {}
    units = normalize_global_units(in_units, base_units)

    hub_src = cfg.get("hub") if isinstance(cfg.get("hub"), dict) else {}
    hub = {
        "meta": normalize_meta_langs(hub_src.get("meta")),
        "ogImage": normalize_og_image(hub_src.get("ogImage") or ""),
    }

    legal_src = cfg.get("legal") if isinstance(cfg.get("legal"), dict) else {}
    legal = {}
    for legal_id in ALLOWED_LEGAL_IDS:
        row = legal_src.get(legal_id) if isinstance(legal_src.get(legal_id), dict) else {}
        legal[legal_id] = {"meta": normalize_meta_langs(row.get("meta"))}

    tools_src = cfg.get("tools") if isinstance(cfg.get("tools"), dict) else {}
    tools = {tool_id: normalize_tool_entry(tools_src.get(tool_id)) for tool_id in ALLOWED_TOOL_ID_ORDER}

    updated = 0
    if "updatedAt" in cfg:
        try:
            updated = int(cfg.get("updatedAt") or 0)
        except (TypeError, ValueError):
            updated = 0

    return {
        "hiddenToolIds": hidden,
        "mobileEnabledToolIds": mobile,
        "adsense": {
            "enabled": True if ads.get("enabled") is None else bool(ads.get("enabled")),
            "client": client,
            "units": units,
        },
        "hub": hub,
        "legal": legal,
        "tools": tools,
        "updatedAt": updated,
    }


def fill_empty_lang_map(current, fallback, max_len: int, retired=None):
    out = normalize_lang_map(current, max_len)
    fb = normalize_lang_map(fallback, max_len)
    retired_set = set(retired or [])
    for lang in ALLOWED_LANGS:
        cur = out[lang]
        if (cur == "" or cur in retired_set) and fb[lang]:
            out[lang] = fb[lang]
    return out


def retired_watermark_display(field: str):
    if field == "title":
        return ["Watermark Remover"]
    if field == "subtitle":
        return [
            "고정 워터마크 제거 · ProPainter",
            "Fixed watermark · ProPainter",
            "固定ウォーターマーク除去 · ProPainter",
            "固定水印去除 · ProPainter",
        ]
    if field == "description":
        return [
            "영상에서 워터마크 영역을 칠하면 ProPainter가 해당 부분만 지우고 일반 재생 가능한 영상으로 저장합니다.",
            "Paint the watermark region; ProPainter fills that area and saves a normal playable video.",
            "映像の透かし範囲を塗るとProPainterがその部分だけ消し、再生できる動画として保存します。",
            "涂出视频水印区域后，ProPainter 只修那一块并保存可播放的视频。",
        ]
    return []


def merge_default_tool_display(tools, defaults, raw_tools=None):
    def_tools = defaults.get("tools") if isinstance(defaults.get("tools"), dict) else {}
    tools = tools if isinstance(tools, dict) else {}
    raw_tools = raw_tools if isinstance(raw_tools, dict) else None
    out = {}
    for tool_id in ALLOWED_TOOL_ID_ORDER:
        row = tools.get(tool_id) if isinstance(tools.get(tool_id), dict) else normalize_tool_entry(None)
        defn = def_tools.get(tool_id) if isinstance(def_tools.get(tool_id), dict) else {}
        row = dict(row)
        retired_title = retired_watermark_display("title") if tool_id == "watermark-remover" else []
        retired_sub = retired_watermark_display("subtitle") if tool_id == "watermark-remover" else []
        retired_desc = retired_watermark_display("description") if tool_id == "watermark-remover" else []
        row["title"] = fill_empty_lang_map(row.get("title"), defn.get("title"), 80, retired_title)
        row["subtitle"] = fill_empty_lang_map(row.get("subtitle"), defn.get("subtitle"), 80, retired_sub)
        row["description"] = fill_empty_lang_map(row.get("description"), defn.get("description"), 200, retired_desc)
        raw_row = raw_tools.get(tool_id) if raw_tools and isinstance(raw_tools.get(tool_id), dict) else None
        if raw_row is None or "badge" not in raw_row:
            row["badge"] = fill_empty_lang_map(row.get("badge"), defn.get("badge"), 48)
        else:
            row["badge"] = normalize_lang_map(raw_row.get("badge"), 48)
        out[tool_id] = row
    return out


def apply_hub_description_limits(cfg, defaults):
    try:
        fb = defaults["hub"]["meta"]["ko"]["description"]
    except (KeyError, TypeError):
        return cfg
    if not isinstance(fb, str) or not fb.strip():
        return cfg
    try:
        cur = cfg["hub"]["meta"]["ko"]["description"]
    except (KeyError, TypeError):
        cur = ""
    if isinstance(cur, str) and len(cur) > 80:
        cfg["hub"]["meta"]["ko"]["description"] = fb.strip()[:80]
    return cfg


def public_config() -> dict:
    runtime = _read_json(RUNTIME_CONFIG)
    base = default_config()
    raw_tools = None
    if isinstance(runtime, dict):
        if "hub" not in runtime and isinstance(base.get("hub"), dict):
            runtime["hub"] = base["hub"]
        if "legal" not in runtime and isinstance(base.get("legal"), dict):
            runtime["legal"] = base["legal"]
        raw_tools = runtime.get("tools") if isinstance(runtime.get("tools"), dict) else None
        cfg = normalize_config(runtime)
    else:
        cfg = normalize_config(base)
    cfg["tools"] = merge_default_tool_display(cfg.get("tools") or {}, normalize_config(base), raw_tools)
    cfg = apply_hub_description_limits(cfg, base)
    return cfg


def parse_tools_registry():
    tools = []
    try:
        raw = REGISTRY_FILE.read_text(encoding="utf-8")
    except OSError:
        return tools
    match = re.search(r"export const TOOLS = \[(.*)\];", raw, re.S)
    if not match:
        return tools
    for block in re.findall(r"\{([^{}]+)\}", match.group(1)):
        id_m = re.search(r'\bid:\s*"([^"]+)"', block)
        href_m = re.search(r'\bhref:\s*"([^"]+)"', block)
        if not id_m or not href_m:
            continue
        avail_m = re.search(r"\bavailable:\s*(true|false)", block)
        tools.append(
            {
                "id": id_m.group(1),
                "href": href_m.group(1),
                "available": avail_m.group(1) == "true" if avail_m else True,
            }
        )
    return tools


def _iso_date(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).strftime("%Y-%m-%d")


def _url_lastmod(relative_href: str) -> str:
    rel = relative_href.replace("\\", "/").strip("/")
    candidates = [ROOT / rel / "index.html", ROOT / rel]
    for path in candidates:
        if path.is_file():
            return _iso_date(path.stat().st_mtime)
    if REGISTRY_FILE.is_file():
        return _iso_date(REGISTRY_FILE.stat().st_mtime)
    return _iso_date(time.time())


def _normalize_hl(raw: str) -> str:
    s = (raw or "").lower().replace("_", "-")
    if s == "kr" or s.startswith("ko"):
        return "ko"
    if s.startswith("ja"):
        return "ja"
    if s.startswith("zh"):
        return "zh"
    if s.startswith("en"):
        return "en"
    return ""


def _lang_url(base: str, loc_path: str, lang: str) -> str:
    prefix = LANG_TO_URL_PREFIX.get(lang, "kr")
    path = loc_path if loc_path.startswith("/") else "/" + loc_path
    if path == "/":
        return f"{base}/{prefix}/"
    return f"{base}/{prefix}{path}"


def sitemap_xml(base: str) -> bytes:
    hidden = set(public_config().get("hiddenToolIds") or [])
    home = ROOT / "index.html"
    home_mod = _iso_date(home.stat().st_mtime if home.is_file() else time.time())
    urls = [
        {
            "loc_path": "/",
            "lastmod": home_mod,
            "changefreq": "daily",
            "priority": "1.0",
        }
    ]
    for tool in parse_tools_registry():
        if not tool.get("available"):
            continue
        if tool["id"] in hidden:
            continue
        href = str(tool.get("href") or "").lstrip("/")
        if not href or ".." in href or re.match(r"^[a-z][a-z0-9+.-]*:", href, re.I):
            continue
        if not href.endswith("/"):
            href += "/"
        urls.append(
            {
                "loc_path": f"/{href}",
                "lastmod": _url_lastmod(href),
                "changefreq": "weekly",
                "priority": "0.8",
            }
        )
    legal_pages = (
        ("/legal/about.html", "0.4"),
        ("/legal/policy.html", "0.4"),
        ("/legal/email.html", "0.3"),
        ("/legal/copyright.html", "0.3"),
        ("/legal/disclaimer.html", "0.4"),
    )
    for rel, prio in legal_pages:
        disk = ROOT / rel.lstrip("/").replace("/", os.sep)
        mtime = disk.stat().st_mtime if disk.is_file() else time.time()
        urls.append(
            {
                "loc_path": rel,
                "lastmod": _iso_date(mtime),
                "changefreq": "monthly",
                "priority": prio,
            }
        )
    langs = ("ko", "en", "ja", "zh")
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ]
    for url in urls:
        alternates = {lang: _lang_url(base, url["loc_path"], lang) for lang in langs}
        alternates["x-default"] = _lang_url(base, url["loc_path"], "ko")
        for lang in langs:
            loc = _lang_url(base, url["loc_path"], lang)
            lines.extend(
                [
                    "  <url>",
                    f"    <loc>{xml_escape(loc)}</loc>",
                    f"    <lastmod>{xml_escape(url['lastmod'])}</lastmod>",
                    f"    <changefreq>{xml_escape(url['changefreq'])}</changefreq>",
                    f"    <priority>{xml_escape(url['priority'])}</priority>",
                ]
            )
            for hreflang, href in alternates.items():
                lines.append(
                    f'    <xhtml:link rel="alternate" hreflang="{xml_escape(hreflang)}" href="{xml_escape(href)}" />'
                )
            lines.append("  </url>")
    lines.append("</urlset>")
    return ("\n".join(lines) + "\n").encode("utf-8")


def verify_login(username: str, password: str) -> bool:
    auth = _read_json(AUTH_FILE)
    if not isinstance(auth, dict):
        return False
    try:
        user_hash = hashlib.sha256(username.encode("utf-8")).hexdigest()
        user_ok = hmac.compare_digest(str(auth.get("user_hash") or ""), user_hash)
        salt = bytes.fromhex(str(auth["salt"]))
        pepper = bytes.fromhex(str(auth["pepper"]))
        expected = bytes.fromhex(str(auth["pass_hash"]))
        iterations = int(auth.get("iterations") or 210000)
        if iterations < 100000:
            iterations = 210000
        calc = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt + pepper, iterations, dklen=32)
        pass_ok = hmac.compare_digest(expected, calc)
        return user_ok and pass_ok
    except (KeyError, ValueError, TypeError):
        return False


def load_rate() -> dict:
    data = _read_json(RATE_FILE)
    return data if isinstance(data, dict) else {}


def prune_rate(data: dict, now: int) -> dict:
    out = {}
    for ip, row in data.items():
        if isinstance(row, dict) and now - int(row.get("start") or 0) < RATE_WINDOW_SEC:
            out[ip] = row
    return out


def rate_state(ip: str):
    now = int(time.time())
    data = prune_rate(load_rate(), now)
    row = data.get(ip) if isinstance(data.get(ip), dict) else {"start": now, "count": 0}
    if now - int(row.get("start") or 0) >= RATE_WINDOW_SEC:
        row = {"start": now, "count": 0}
    return int(row.get("count") or 0) >= RATE_MAX_ATTEMPTS, data, row


def rate_fail(ip: str) -> None:
    _, data, row = rate_state(ip)
    row["count"] = int(row.get("count") or 0) + 1
    data[ip] = row
    _write_json(RATE_FILE, data)


def rate_clear(ip: str) -> None:
    now = int(time.time())
    data = prune_rate(load_rate(), now)
    data.pop(ip, None)
    _write_json(RATE_FILE, data)


def load_sessions() -> dict:
    data = _read_json(SESS_FILE)
    return data if isinstance(data, dict) else {}


def save_session(sid: str, csrf: str) -> None:
    now = int(time.time())
    data = load_sessions()
    expired = [k for k, v in data.items() if not isinstance(v, dict) or now - int(v.get("last") or 0) > SESSION_IDLE_SEC]
    for k in expired:
        data.pop(k, None)
    data[sid] = {"csrf": csrf, "last": now}
    _write_json(SESS_FILE, data)


def drop_session(sid: str) -> None:
    data = load_sessions()
    data.pop(sid, None)
    _write_json(SESS_FILE, data)


def get_session(sid: str):
    if not sid:
        return None
    now = int(time.time())
    data = load_sessions()
    row = data.get(sid)
    if not isinstance(row, dict):
        return None
    last = int(row.get("last") or 0)
    if last and now - last > SESSION_IDLE_SEC:
        data.pop(sid, None)
        _write_json(SESS_FILE, data)
        return None
    row["last"] = now
    data[sid] = row
    _write_json(SESS_FILE, data)
    return row


class ToolsHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(HTTPStatus.FORBIDDEN, "Directory listing disabled")
        return None

    def _rel_path(self) -> str:
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        path = posixpath.normpath(path)
        if path.startswith(".."):
            return ""
        rel = path.lstrip("/")
        parts = [p for p in rel.split("/") if p]
        if parts and parts[0].lower() in LANG_PREFIXES:
            rel = "/".join(parts[1:])
        return rel

    def translate_path(self, path):
        path = path.split("?", 1)[0]
        path = path.split("#", 1)[0]
        trailing_slash = path.rstrip().endswith("/")
        try:
            path = urllib.parse.unquote(path, errors="surrogatepass")
        except UnicodeDecodeError:
            path = urllib.parse.unquote(path)
        path = posixpath.normpath(path)
        words = []
        for word in path.split("/"):
            if not word or word in (os.curdir, os.pardir):
                continue
            drive, word = os.path.splitdrive(word)
            head, word = os.path.split(word)
            if not word or word in (os.curdir, os.pardir):
                continue
            words.append(word)
        if words and words[0].lower() in LANG_PREFIXES:
            words = words[1:]
        path = str(ROOT)
        for word in words:
            path = os.path.join(path, word)
        if trailing_slash:
            path += os.sep
        return path

    def _query_without_hl(self, parsed: urllib.parse.ParseResult) -> str:
        qs = [(k, v) for k, v in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True) if k.lower() != "hl"]
        if not qs:
            return ""
        return "?" + urllib.parse.urlencode(qs)

    def _send_redirect(self, location: str):
        self.send_response(HTTPStatus.MOVED_PERMANENTLY)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _lang_redirect(self) -> str | None:
        parsed = urllib.parse.urlparse(self.path)
        raw_path = urllib.parse.unquote(parsed.path) or "/"
        if not raw_path.startswith("/"):
            raw_path = "/" + raw_path
        parts = [p for p in raw_path.split("/") if p]
        first = parts[0].lower() if parts else ""
        if first == "admin":
            return None
        if parsed.path in ("/sitemap.xml", "/sitemap.php"):
            return None
        if first in ("common", "assets"):
            return None

        qs = urllib.parse.parse_qs(parsed.query)
        hl_raw = ""
        if "hl" in qs and qs["hl"]:
            hl_raw = qs["hl"][0]
        hl = _normalize_hl(hl_raw)
        rest_parts = parts[1:] if first in LANG_PREFIXES else parts
        slug_changed = False
        if rest_parts:
            old_slug = rest_parts[0].lower()
            new_slug = PUBLIC_SLUG_RENAMES.get(old_slug)
            if new_slug:
                rest_parts = [new_slug, *rest_parts[1:]]
                slug_changed = True
        rest = "/" + "/".join(rest_parts) if rest_parts else "/"
        if raw_path.endswith("/") and rest != "/" and not rest.endswith("/"):
            rest += "/"
        elif rest_parts and not raw_path.endswith("/") and "." not in rest_parts[-1]:
            pass
        suffix = self._query_without_hl(parsed)

        if first == "ko":
            dest = "/kr/" if rest == "/" else "/kr" + rest
            return dest + suffix

        if first in ("kr", "en", "ja", "zh"):
            dest_prefix = first
            if hl and LANG_TO_URL_PREFIX.get(hl) != first:
                dest_prefix = LANG_TO_URL_PREFIX[hl]
            if (hl and LANG_TO_URL_PREFIX.get(hl) != first) or slug_changed:
                dest = f"/{dest_prefix}/" if rest == "/" else f"/{dest_prefix}{rest}"
                return dest + suffix
            return None

        last = parts[-1] if parts else ""
        if last:
            ext = os.path.splitext(last)[1].lower()
            if ext in STATIC_FILE_EXT and ext not in (".html", ".htm"):
                return None

        dest_prefix = LANG_TO_URL_PREFIX.get(hl or "ko", "kr")
        dest = f"/{dest_prefix}/" if rest == "/" else f"/{dest_prefix}{rest}"
        return dest + suffix

    def _is_protected(self, rel: str) -> bool:
        parts = [p for p in rel.split("/") if p]
        if not parts:
            return False
        if any(p.startswith("_") for p in parts):
            return True
        if len(parts) >= 2 and parts[0] == "admin" and parts[1] == "data":
            return True
        return False

    def _json(self, payload: dict, code: int = 200, set_cookie: str | None = None, clear_cookie: bool = False):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(raw)))
        if set_cookie:
            self.send_header(
                "Set-Cookie",
                f"{COOKIE_NAME}={set_cookie}; Path=/admin; HttpOnly; SameSite=Strict",
            )
        if clear_cookie:
            self.send_header(
                "Set-Cookie",
                f"{COOKIE_NAME}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0",
            )
        self.end_headers()
        self.wfile.write(raw)

    def _request_base(self) -> str:
        host = self.headers.get("Host") or "127.0.0.1:29180"
        if re.search(r"(^|\.)tools\.itmatzip\.com$", host, re.I):
            return "https://tools.itmatzip.com"
        return f"http://{host}"

    def _serve_sitemap(self):
        raw = sitemap_xml(self._request_base())
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/xml; charset=utf-8")
        self.send_header("Cache-Control", "public, max-age=600")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(raw)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 1_000_000:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return {}
        return data if isinstance(data, dict) else {}

    def _cookie_sid(self) -> str:
        jar = SimpleCookie()
        raw = self.headers.get("Cookie")
        if not raw:
            return ""
        try:
            jar.load(raw)
        except Exception:
            return ""
        morsel = jar.get(COOKIE_NAME)
        return morsel.value if morsel else ""

    def _csrf_ok(self, sess: dict, body: dict) -> bool:
        sent = self.headers.get("X-CSRF-Token") or ""
        if not sent:
            csrf = body.get("csrf")
            sent = csrf if isinstance(csrf, str) else ""
        expected = sess.get("csrf") if isinstance(sess.get("csrf"), str) else ""
        if not expected or not sent:
            return False
        return hmac.compare_digest(expected, sent)

    def _handle_api(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        body = {}
        if self.command == "POST":
            body = self._read_body()
        action = ""
        if "action" in qs and qs["action"]:
            action = qs["action"][0]
        if isinstance(body.get("action"), str):
            action = body["action"]

        if action == "public":
            self._json({"ok": True, "config": public_config()})
            return

        sid = self._cookie_sid()
        sess = get_session(sid)

        if action == "session":
            if not sess:
                self._json({"ok": False, "loggedIn": False}, 401)
                return
            self._json(
                {
                    "ok": True,
                    "loggedIn": True,
                    "csrf": sess["csrf"],
                    "config": public_config(),
                }
            )
            return

        if action == "logout":
            if not sess or not self._csrf_ok(sess, body):
                self._json({"ok": False, "error": "세션이 만료되었습니다. 다시 로그인해 주세요."}, 403)
                return
            drop_session(sid)
            self._json({"ok": True}, clear_cookie=True)
            return

        if action == "login":
            if self.command != "POST":
                self._json({"ok": False, "error": "허용되지 않은 요청입니다."}, 405)
                return
            ip = self.client_address[0]
            blocked, _, _ = rate_state(ip)
            if blocked:
                self._json({"ok": False, "error": "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요."}, 429)
                return
            username = body.get("username") if isinstance(body.get("username"), str) else ""
            password = body.get("password") if isinstance(body.get("password"), str) else ""
            if not verify_login(username, password):
                rate_fail(ip)
                self._json({"ok": False, "error": "아이디 또는 비밀번호가 올바르지 않습니다."}, 401)
                return
            rate_clear(ip)
            new_sid = secrets.token_urlsafe(32)
            csrf = secrets.token_urlsafe(32)
            drop_session(sid)
            save_session(new_sid, csrf)
            self._json({"ok": True, "csrf": csrf, "config": public_config()}, set_cookie=new_sid)
            return

        if action == "save":
            if self.command != "POST":
                self._json({"ok": False, "error": "허용되지 않은 요청입니다."}, 405)
                return
            if not sess:
                self._json({"ok": False, "error": "로그인이 필요합니다."}, 401)
                return
            if not self._csrf_ok(sess, body):
                self._json({"ok": False, "error": "세션이 만료되었습니다. 다시 로그인해 주세요."}, 403)
                return
            incoming = body.get("config") if isinstance(body.get("config"), dict) else None
            if incoming is None:
                self._json({"ok": False, "error": "설정 데이터가 없습니다. 페이지를 새로고침한 뒤 다시 저장해 주세요."}, 400)
                return
            existing = public_config()
            if "hub" not in incoming and isinstance(existing.get("hub"), dict):
                incoming["hub"] = existing["hub"]
            if "legal" not in incoming and isinstance(existing.get("legal"), dict):
                incoming["legal"] = existing["legal"]
            tools_in = incoming.get("tools") if isinstance(incoming.get("tools"), dict) else None
            if (tools_in is None or len(tools_in) == 0) and isinstance(existing.get("tools"), dict) and existing["tools"]:
                incoming["tools"] = existing["tools"]
            cfg = normalize_config(incoming)
            cfg["updatedAt"] = int(time.time())
            if not _write_json(RUNTIME_CONFIG, cfg):
                self._json({"ok": False, "error": "설정을 저장하지 못했습니다."}, 500)
                return
            self._json({"ok": True, "config": cfg, "csrf": sess["csrf"]})
            return

        self._json({"ok": False, "error": "알 수 없는 요청입니다."}, 400)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.rstrip("/") == "/admin/api.php" or parsed.path == "/admin/api.php":
            self._handle_api()
            return
        if parsed.path in ("/sitemap.xml", "/sitemap.php"):
            self._serve_sitemap()
            return
        loc = self._lang_redirect()
        if loc:
            self._send_redirect(loc)
            return
        rel = self._rel_path()
        if self._is_protected(rel):
            self.send_error(HTTPStatus.FORBIDDEN, "Forbidden")
            return
        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.rstrip("/") == "/admin/api.php" or parsed.path == "/admin/api.php":
            self._handle_api()
            return
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "Method not allowed")

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.rstrip("/") == "/admin/api.php" or parsed.path == "/admin/api.php":
            self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "Method not allowed")
            return
        if parsed.path in ("/sitemap.xml", "/sitemap.php"):
            self._serve_sitemap()
            return
        loc = self._lang_redirect()
        if loc:
            self._send_redirect(loc)
            return
        rel = self._rel_path()
        if self._is_protected(rel):
            self.send_error(HTTPStatus.FORBIDDEN, "Forbidden")
            return
        super().do_HEAD()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 29180
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    os.chdir(ROOT)
    httpd = ThreadingHTTPServer(("0.0.0.0", port), ToolsHandler)
    print(f"Serving {ROOT} at http://127.0.0.1:{port}/", flush=True)
    print(f"Admin: http://127.0.0.1:{port}/admin/", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped")


if __name__ == "__main__":
    main()
