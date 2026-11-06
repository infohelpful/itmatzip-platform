"""API keys (Claude, ChatGPT) and proofreading glossary for AutoSubtitle's AI proofreading.

The keys never leave this PC except in requests to the provider's API made by the agent itself:
- stored under the signed-in Windows user's %APPDATA% (not the shared ProgramData root),
- encrypted with DPAPI in the current-user scope, so another Windows account or a copied file
  cannot decrypt them,
- never returned to the browser; status reports only whether a key is set and its last 4 chars.
"""
from __future__ import annotations

import base64
import ctypes
import json
import os
import sys
import threading
from ctypes import wintypes
from pathlib import Path
from typing import Any

PROVIDERS = ("claude", "openai")
DEFAULT_PROVIDER = "claude"
# First entry is the default: the low-cost model. The user can switch to the higher-quality one.
MODELS: dict[str, tuple[str, ...]] = {
    "claude": ("claude-haiku-5-5", "claude-opus-5-5"),
    "openai": ("gpt-6-luna", "gpt-6.1-sol"),
}
MAX_KEY_LENGTH = 512
MAX_GLOSSARY_TERMS = 500
MAX_TERM_LENGTH = 80

_lock = threading.Lock()


def settings_path() -> Path:
    override = os.environ.get("ITMATZIP_AUTOSUB_AI_SETTINGS", "").strip()
    if override:
        return Path(override)
    appdata = os.environ.get("APPDATA", "").strip()
    base = Path(appdata) / "ItMatZip" if appdata else Path.home() / ".itmatzip"
    return base / "auto-subtitle" / "ai-settings.json"


# -- DPAPI (current user) ----------------------------------------------------------------
class _Blob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(data: bytes) -> tuple[_Blob, Any]:
    buf = ctypes.create_string_buffer(data, len(data))
    return _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), buf


_ENTROPY = b"ItMatZip.AutoSubtitle.ClaudeKey.v1"
_CRYPTPROTECT_UI_FORBIDDEN = 0x1


def _dpapi(data: bytes, protect: bool) -> bytes:
    if sys.platform != "win32":
        raise RuntimeError("API 키 저장은 Windows에서만 지원합니다.")
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    src, _src_buf = _blob(data)
    ent, _ent_buf = _blob(_ENTROPY)
    out = _Blob()
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    ok = fn(ctypes.byref(src), None, ctypes.byref(ent), None, None, _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out))
    if not ok:
        raise RuntimeError("API 키를 암호화하거나 풀지 못했습니다.")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(out.pbData)


# -- storage -----------------------------------------------------------------------------
def _read() -> dict[str, Any]:
    path = settings_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    # 1.7.8 test builds stored a single Claude key at the top level.
    if isinstance(data.get("apiKey"), str):
        keys = data.setdefault("keys", {})
        keys.setdefault("claude", {"sealed": data["apiKey"], "hint": data.get("apiKeyHint")})
        data.pop("apiKey", None)
        data.pop("apiKeyHint", None)
    return data


def _write(data: dict[str, Any]) -> None:
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, path)


def check_provider(raw: Any) -> str:
    if raw not in PROVIDERS:
        raise ValueError("AI 종류는 claude 또는 openai 입니다.")
    return raw


def _keys(data: dict[str, Any]) -> dict[str, Any]:
    keys = data.get("keys")
    return keys if isinstance(keys, dict) else {}


def api_key(provider: str) -> str | None:
    """Decrypted key for the agent's own API calls. Never send this to the browser."""
    with _lock:
        entry = _keys(_read()).get(provider)
    sealed = entry.get("sealed") if isinstance(entry, dict) else None
    if not isinstance(sealed, str) or not sealed:
        return None
    try:
        return _dpapi(base64.b64decode(sealed), protect=False).decode("utf-8")
    except (RuntimeError, ValueError):
        return None


def normalize_key(provider: str, raw: Any) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("API 키를 입력해 주세요.")
    key = raw.strip()
    if len(key) > MAX_KEY_LENGTH or any(c.isspace() for c in key) or not key.isascii():
        raise ValueError("API 키 형식이 올바르지 않습니다.")
    if provider == "claude" and not key.startswith("sk-ant-"):
        raise ValueError("Claude API 키는 sk-ant- 로 시작합니다.")
    if provider == "openai" and (not key.startswith("sk-") or key.startswith("sk-ant-")):
        raise ValueError("ChatGPT(OpenAI) API 키는 sk- 로 시작합니다. sk-ant- 는 Claude 키입니다.")
    return key


def set_api_key(provider: str, key: str) -> None:
    sealed = base64.b64encode(_dpapi(key.encode("utf-8"), protect=True)).decode("ascii")
    with _lock:
        data = _read()
        data.setdefault("keys", {})[provider] = {"sealed": sealed, "hint": key[-4:]}
        _write(data)


def delete_api_key(provider: str) -> None:
    with _lock:
        data = _read()
        _keys(data).pop(provider, None)
        _write(data)


def provider() -> str:
    with _lock:
        value = _read().get("provider")
    return value if value in PROVIDERS else DEFAULT_PROVIDER


def set_provider(value: str) -> None:
    with _lock:
        data = _read()
        data["provider"] = value
        _write(data)


def model(name: str) -> str:
    with _lock:
        models = _read().get("models")
    value = models.get(name) if isinstance(models, dict) else None
    return value if value in MODELS[name] else MODELS[name][0]


def set_model(name: str, value: Any) -> None:
    if value not in MODELS[name]:
        raise ValueError("지원하지 않는 모델입니다.")
    with _lock:
        data = _read()
        models = data.get("models") if isinstance(data.get("models"), dict) else {}
        models[name] = value
        data["models"] = models
        _write(data)


def normalize_glossary(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        raise ValueError("용어 사전 형식이 올바르지 않습니다.")
    terms: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, str):
            continue
        term = " ".join(item.split())
        if not term or term in seen:
            continue
        if len(term) > MAX_TERM_LENGTH:
            raise ValueError(f"용어는 {MAX_TERM_LENGTH}자 이하로 입력해 주세요: {term[:20]}…")
        seen.add(term)
        terms.append(term)
    if len(terms) > MAX_GLOSSARY_TERMS:
        raise ValueError(f"용어는 최대 {MAX_GLOSSARY_TERMS}개까지 등록할 수 있습니다.")
    return terms


def glossary() -> list[str]:
    with _lock:
        raw = _read().get("glossary")
    try:
        return normalize_glossary(raw if isinstance(raw, list) else [])
    except ValueError:
        return []


def set_glossary(terms: list[str]) -> None:
    with _lock:
        data = _read()
        data["glossary"] = terms
        _write(data)


def status() -> dict[str, Any]:
    with _lock:
        data = _read()
    keys = _keys(data)
    providers: dict[str, Any] = {}
    for name in PROVIDERS:
        entry = keys.get(name)
        configured = isinstance(entry, dict) and isinstance(entry.get("sealed"), str) and bool(entry.get("sealed"))
        hint = entry.get("hint") if configured else None
        providers[name] = {"configured": configured, "keyHint": hint if isinstance(hint, str) else None,
                           "model": model(name), "models": list(MODELS[name])}
    selected = data.get("provider") if data.get("provider") in PROVIDERS else DEFAULT_PROVIDER
    return {"provider": selected, "providers": providers, "configured": providers[selected]["configured"],
            "glossary": glossary()}
