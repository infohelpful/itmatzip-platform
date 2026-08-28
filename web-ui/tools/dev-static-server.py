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
        "unattend-maker",
        "online-clock",
    }
)
ALLOWED_AD_UNITS = (
    "dashboardBanner",
    "editorAboveWorkspace",
    "editorBelowExport",
    "downloadTop",
    "downloadBottom",
)


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _write_json(path: Path, data) -> bool:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(path)
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
            "client": "ca-pub-2088466558007407",
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
        ["thumbnail-grabber", "ico-maker", "online-clock", "unattend-maker"]
    )


def normalize_config(cfg) -> dict:
    if not isinstance(cfg, dict):
        cfg = {}
    hidden = parse_tool_id_list(cfg.get("hiddenToolIds"))
    if "mobileEnabledToolIds" in cfg:
        mobile = parse_tool_id_list(cfg.get("mobileEnabledToolIds"))
    else:
        mobile = default_mobile_enabled_tool_ids()

    ads = cfg.get("adsense") if isinstance(cfg.get("adsense"), dict) else {}
    client = ads.get("client") if isinstance(ads.get("client"), str) else ""
    client = client.strip()
    if not client or not re.fullmatch(r"ca-pub-\d{8,22}", client):
        client = "ca-pub-2088466558007407"

    defaults = default_config()
    base_units = {}
    if isinstance(defaults.get("adsense"), dict) and isinstance(defaults["adsense"].get("units"), dict):
        base_units = defaults["adsense"]["units"]
    in_units = ads.get("units") if isinstance(ads.get("units"), dict) else {}

    units = {}
    for key in ALLOWED_AD_UNITS:
        src = {}
        if isinstance(base_units.get(key), dict):
            src.update(base_units[key])
        if isinstance(in_units.get(key), dict):
            src.update(in_units[key])
        slot = src.get("slot") if isinstance(src.get("slot"), str) else ""
        slot = slot.strip()
        if slot and not re.fullmatch(r"\d{6,20}", slot):
            slot = ""
        ad_format = src.get("adFormat") if isinstance(src.get("adFormat"), str) else "horizontal"
        units[key] = {
            "slot": slot,
            "adFormat": ad_format,
            "fullWidthResponsive": bool(src.get("fullWidthResponsive", True)),
        }

    return {
        "hiddenToolIds": hidden,
        "mobileEnabledToolIds": mobile,
        "adsense": {
            "enabled": bool(ads.get("enabled", True)),
            "client": client,
            "units": units,
        },
    }


def public_config() -> dict:
    runtime = _read_json(RUNTIME_CONFIG)
    if isinstance(runtime, dict):
        return normalize_config(runtime)
    return normalize_config(default_config())


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


def sitemap_xml(base: str) -> bytes:
    hidden = set(public_config().get("hiddenToolIds") or [])
    home = ROOT / "index.html"
    home_mod = _iso_date(home.stat().st_mtime if home.is_file() else time.time())
    urls = [
        {
            "loc": f"{base}/",
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
        urls.append(
            {
                "loc": f"{base}/{href}",
                "lastmod": _url_lastmod(href),
                "changefreq": "weekly",
                "priority": "0.8",
            }
        )
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ]
    for url in urls:
        lines.extend(
            [
                "  <url>",
                f"    <loc>{xml_escape(url['loc'])}</loc>",
                f"    <lastmod>{xml_escape(url['lastmod'])}</lastmod>",
                f"    <changefreq>{xml_escape(url['changefreq'])}</changefreq>",
                f"    <priority>{xml_escape(url['priority'])}</priority>",
                "  </url>",
            ]
        )
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
        return path.lstrip("/")

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
            cfg = normalize_config(body.get("config") if isinstance(body.get("config"), dict) else {})
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
