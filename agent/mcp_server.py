"""Small stdio MCP host for ItMatZip's local agent.

Keep this module dependency-free so the installed agent can expose MCP over stdio.
The local FastAPI agent remains the source of truth for tools and user credentials.
"""
from __future__ import annotations

import json
import threading
import sys
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from agent_config import agent_base_url
from version import AGENT_VERSION

PROTOCOL_VERSION = "2025-06-18"
SUPPORTED_PROTOCOLS = {"2024-11-05", "2025-03-26", "2025-06-18"}
BASE = agent_base_url()
SESSION_ID = str(uuid.uuid4())
AUTOSUB_PROMPT_NAME = "itmatzip-AutoSubtitle"
AUTOSUB_PROMPT_TEXT = (
    "현재 열려 있는 ItMatZip AutoSubtitle 편집기의 자막을 교정해 주세요. "
    "먼저 autosub_get_active_subtitles 도구로 현재 자막과 revision을 가져오세요. "
    "오타를 고치고 문맥과 쉼 구간에 맞게 줄을 나눠 읽기 쉽게 만드세요. "
    "공백 포함 30자 이하의 문장은 한 줄로 두고, 더 긴 문장만 문맥 단위로 나누되 아주 짧은 조각이나 한 단어만 남기지 마세요. "
    "음성이 잘못 인식된 단어는 종류와 상관없이 앞뒤 문맥상 확실하면 올바른 말로 고치세요 "
    "(고유명사·영어/전문용어·숫자·동음이의어·조사/어미 오류 모두 해당. "
    "예: '갓 오브 워 선지 오브 스파르타' → 'God of War: Sons of Sparta', 단어 수는 유지해 각 단어 index에 대응시키세요). "
    "말한 내용의 뜻과 순서는 바꾸지 말고 윤문·의역하지 마세요. 문맥으로도 확신이 없는 부분만 그대로 두세요. "
    "음성이 제공되고 직접 들을 수 있다면 autosub_listen_active_audio 도구로 필요한 구간을 듣고 "
    "실제 발화와 자막을 대조하세요. 들을 수 없는 경우에는 들었다고 주장하지 마세요. "
    "수정 결과는 autosub_submit_active_edits 도구에 revision, corrections, lineStarts를 전달해 "
    "(요청에 따라 강조 emphasis/emphasisColored/unemphasize, 자막 숨김 hide/show, 자막 표시 시간 displayTiming, "
    "단어 삭제 deleteWords, 전체 서식 style도 함께 전달할 수 있습니다) "
    "현재 편집기에 적용하세요. 편집기의 확인 후 적용/자동 수정 설정을 따르세요. "
    "현재 편집기가 없거나 도구 호출이 실패하면 수정했다고 말하지 말고 원인을 알려 주세요."
)


def _heartbeat_loop() -> None:
    while True:
        try:
            _request("/api/tools/auto-subtitle/v2/mcp/session", "POST", {"sessionId": SESSION_ID}, timeout=3)
        except Exception:
            pass
        time.sleep(10)


def _register_session() -> None:
    try:
        _request("/api/tools/auto-subtitle/v2/mcp/session", "POST", {"sessionId": SESSION_ID}, timeout=3)
    except Exception:
        pass


def _request(path: str, method: str = "GET", body: dict[str, Any] | None = None,
             timeout: float = 20) -> dict[str, Any]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Content-Type": "application/json"} if data is not None else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8"))
            detail = payload.get("detail", str(exc))
        except (ValueError, UnicodeDecodeError):
            detail = str(exc)
        raise ValueError(str(detail)) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise ValueError("ItMatZip 로컬 에이전트에 연결할 수 없습니다. 에이전트를 실행해 주세요.") from exc


def _request_audio(path: str) -> bytes:
    req = urllib.request.Request(BASE + path, headers={"Accept": "audio/wav"})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            if response.headers.get_content_type() != "audio/wav":
                raise ValueError("로컬 에이전트가 올바른 WAV 오디오를 반환하지 않았습니다.")
            data = response.read(1_200_001)
            if not data or len(data) > 1_200_000:
                raise ValueError("요청한 오디오 구간이 너무 큽니다.")
            return data
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8"))
            detail = payload.get("detail", str(exc))
        except (ValueError, UnicodeDecodeError):
            detail = str(exc)
        raise ValueError(str(detail)) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise ValueError("ItMatZip 로컬 에이전트에 연결할 수 없습니다. 에이전트를 실행해 주세요.") from exc


def _agent_status(_: dict[str, Any]) -> dict[str, Any]:
    return _request("/health")


def _autosub_settings(_: dict[str, Any]) -> dict[str, Any]:
    settings = _request("/api/tools/auto-subtitle/v2/ai/settings")
    # Do not expose key material or key hints through MCP.
    return {
        "provider": settings.get("provider"),
        "configured": settings.get("configured", False),
        "providers": {
            name: {"configured": state.get("configured", False), "model": state.get("model")}
            for name, state in settings.get("providers", {}).items()
        },
        "glossary": settings.get("glossary", []),
    }


def _autosub_get_active(_: dict[str, Any]) -> dict[str, Any]:
    active = _request("/api/tools/auto-subtitle/v2/mcp/editor")
    return {
        "revision": active["revision"],
        "lines": active["snapshot"].get("lines", []),
        "words": active["snapshot"].get("words", []),
        "lineStarts": active["snapshot"].get("lineStarts", []),
        "pauses": active["snapshot"].get("pauses", []),
        # 지금 강조된 단어 index와 전체 서식 — 숨김·표시 시간은 lines[].hidden / displayStartAdj·displayEndAdj
        "emphasized": active["snapshot"].get("emphasized", []),
        "style": active["snapshot"].get("style", {}),
        "audioAvailable": bool(active["snapshot"].get("audioPath")),
        "note": "현재 열린 AutoSubtitle 편집기의 자막입니다. words.index 값으로 수정 위치를 지정하세요.",
    }


def _autosub_listen_active_audio(args: dict[str, Any]) -> dict[str, Any]:
    start, end = args.get("startSec"), args.get("endSec")
    if (not isinstance(start, (int, float)) or isinstance(start, bool)
            or not isinstance(end, (int, float)) or isinstance(end, bool)):
        raise ValueError("startSec와 endSec에 오디오 시작/끝 초를 지정해 주세요.")
    if start < 0 or end <= start or end - start > 6:
        raise ValueError("오디오 구간은 0초 이후의 최대 6초로 지정해 주세요.")
    query = urllib.parse.urlencode({"startSec": start, "endSec": end})
    audio = _request_audio(f"/api/tools/auto-subtitle/v2/mcp/editor/audio?{query}")
    return {"audio": audio, "startSec": start, "endSec": end}


def _autosub_submit_active(args: dict[str, Any]) -> dict[str, Any]:
    revision = args.get("revision")
    corrections = args.get("corrections")
    line_starts = args.get("lineStarts")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise ValueError("autosub_get_active_subtitles에서 받은 revision이 필요합니다.")
    if not isinstance(corrections, list) or not isinstance(line_starts, list):
        raise ValueError("corrections와 lineStarts 목록이 필요합니다.")
    emphasis = args.get("emphasis", [])
    if not isinstance(emphasis, list):
        raise ValueError("emphasis는 강조할 단어 index 목록이어야 합니다.")
    payload = {"revision": revision, "corrections": corrections, "lineStarts": line_starts, "emphasis": emphasis}
    for key in ("emphasisColored", "unemphasize", "hide", "show", "displayTiming", "deleteWords", "style"):
        if key in args:
            payload[key] = args[key]
    result = _request("/api/tools/auto-subtitle/v2/mcp/editor/submit", "POST", payload)
    result["message"] = "수정안을 열린 편집기에 전달했습니다. 페이지의 선택 모드에 따라 미리보기 또는 자동 적용됩니다."
    return result


def _autosub_proofread(args: dict[str, Any]) -> dict[str, Any]:
    """Proofread supplied caption lines and return a reviewable suggestion."""
    lines = args.get("lines")
    if not isinstance(lines, list) or not lines or not all(isinstance(x, str) for x in lines):
        raise ValueError("lines에는 교정할 자막 줄 문자열 목록이 필요합니다.")
    words = [word for line in lines for word in line.split()]
    if not words:
        raise ValueError("교정할 자막이 없습니다.")
    if len(words) > 40_000:
        raise ValueError("자막 단어 수가 최대 40,000개를 넘습니다.")
    starts: list[int] = []
    cursor = 0
    for line in lines:
        if line.split():
            starts.append(cursor)
            cursor += len(line.split())
    max_units = args.get("maxUnits", 36)
    if not isinstance(max_units, int) or isinstance(max_units, bool) or not 4 <= max_units <= 80:
        raise ValueError("maxUnits는 4~80 사이 정수여야 합니다.")
    target_units = args.get("targetUnits", min(18, max_units))
    if not isinstance(target_units, int) or isinstance(target_units, bool) or not 4 <= target_units <= max_units:
        raise ValueError("targetUnits는 4 이상 maxUnits 이하 정수여야 합니다.")

    job = _request("/api/tools/auto-subtitle/v2/ai/proofread", "POST", {
        "words": words,
        "lineStarts": starts,
        "pauses": [],
        "maxUnits": max_units,
        "targetUnits": target_units,
        "emphasize": False,
        "instruction": args.get("instruction", ""),
    })
    job_id = urllib.parse.quote(str(job["jobId"]), safe="")
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        state = _request(f"/api/tools/auto-subtitle/v2/ai/proofread?jobId={job_id}&wait=10", timeout=15)
        if state.get("state") == "done" and isinstance(state.get("result"), dict):
            answer = state["result"]
            corrected = list(words)
            for item in answer.get("corrections", []):
                idx, text = item.get("id"), item.get("text")
                if isinstance(idx, int) and 0 <= idx < len(corrected) and isinstance(text, str):
                    corrected[idx] = text
            result_lines: list[str] = []
            starts_out = answer.get("lineStarts", [])
            if starts_out:
                for i, start in enumerate(starts_out):
                    end = starts_out[i + 1] if i + 1 < len(starts_out) else len(corrected)
                    phrase = " ".join(word for word in corrected[start:end] if word)
                    if phrase:
                        result_lines.append(phrase)
            return {
                "suggestedLines": result_lines,
                "corrections": answer.get("corrections", []),
                "uncertain": answer.get("uncertain", []),
                "note": "텍스트만 처리했습니다. 음성과 대조하거나 원본 파일에 적용하지 않았습니다. 결과를 확인한 뒤 직접 적용하세요.",
                "usage": state.get("usage"),
            }
        if state.get("state") == "error":
            raise ValueError(state.get("error", "AI 자막 교정이 실패했습니다."))
    raise ValueError("AI 자막 교정 시간이 초과되었습니다. 다시 시도해 주세요.")


TOOLS = {
    "itmatzip_agent_status": {
        "description": "ItMatZip 로컬 에이전트 연결 상태를 확인합니다.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "run": _agent_status,
    },
    "autosub_ai_settings": {
        "description": "AutoSubtitle AI 교정 설정 상태를 확인합니다. API 키 자체는 반환하지 않습니다.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "run": _autosub_settings,
    },
    "autosub_get_active_subtitles": {
        "description": "현재 열려 있는 AutoSubtitle 편집기의 자막, 단어 인덱스, 줄 시작 위치와 쉼 구간을 가져옵니다.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "run": _autosub_get_active,
    },
    "autosub_submit_active_edits": {
        "description": "현재 열린 AutoSubtitle 편집기에 수정안(오타·줄바꿈·강조·숨김·표시 시간·단어 삭제·서식)을 전달합니다. 적용 여부는 편집기에서 선택한 확인 후 적용/자동 수정 설정을 따릅니다.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "revision": {"type": "integer", "minimum": 1},
                "corrections": {"type": "array", "items": {
                    "type": "object", "properties": {
                        "index": {"type": "integer", "minimum": 0},
                        "text": {"type": "string", "maxLength": 200},
                    }, "required": ["index", "text"], "additionalProperties": False,
                }},
                "lineStarts": {"type": "array", "items": {"type": "integer", "minimum": 0}},
                "emphasis": {"type": "array", "items": {"type": "integer", "minimum": 0},
                             "description": "강조 색을 칠할 단어 index 목록(사용자가 강조를 요청했을 때만). 글자·줄은 바꾸지 않습니다."},
                "emphasisColored": {"type": "array", "description": "지정한 색으로 강조할 단어",
                                    "items": {"type": "object", "properties": {
                                        "index": {"type": "integer", "minimum": 0},
                                        "color": {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"},
                                    }, "required": ["index", "color"], "additionalProperties": False}},
                "unemphasize": {"type": "array", "items": {"type": "integer", "minimum": 0},
                                "description": "강조를 지울 단어 index"},
                "hide": {"type": "array", "items": {"type": "integer", "minimum": 0},
                         "description": "이 단어가 든 자막 줄을 화면·자막 입힌 영상에서 숨김(SRT 등 파일에는 남음)"},
                "show": {"type": "array", "items": {"type": "integer", "minimum": 0},
                         "description": "이 단어가 든 숨긴 자막 줄을 다시 표시"},
                "displayTiming": {"type": "array", "description": "이 단어가 든 줄의 자막 표시 시작·끝 보정(초, 음수=앞당김). 단어·소리는 그대로",
                                  "items": {"type": "object", "properties": {
                                      "index": {"type": "integer", "minimum": 0},
                                      "startAdj": {"type": "number"}, "endAdj": {"type": "number"},
                                  }, "required": ["index"], "additionalProperties": False}},
                "deleteWords": {"type": "array", "items": {"type": "integer", "minimum": 0},
                                "description": "편집기 Delete와 같이 지울 단어(그 소리 구간이 영상에서 빠짐). 사용자가 삭제를 요청했을 때만"},
                "style": {"type": "object", "description": "바꿀 전체 자막 서식만: fontFamily, fontSize, fontWeight, textColor, "
                          "strokeColor, strokeWidth, bgColor, bgOpacity(0-100), bgPaddingPct, x(0-100 왼쪽부터 %), "
                          "y(아래부터 %), boxStyle(classic|capsule), emphasisColor, wordHighlight(bool), wordHighlightColor. 색은 #rrggbb"},
            },
            "required": ["revision", "corrections", "lineStarts"], "additionalProperties": False,
        },
        "run": _autosub_submit_active,
    },
    "autosub_listen_active_audio": {
        "description": "현재 열린 AutoSubtitle 영상에서 지정한 최대 6초 구간의 실제 오디오를 가져옵니다. 모델이 audio/wav를 들을 수 있으면 자막과 직접 대조할 수 있습니다.",
        "inputSchema": {"type": "object", "properties": {
            "startSec": {"type": "number", "minimum": 0, "description": "영상 타임라인 기준 시작 초"},
            "endSec": {"type": "number", "exclusiveMinimum": 0, "description": "영상 타임라인 기준 끝 초, 시작에서 6초 이내"},
        }, "required": ["startSec", "endSec"], "additionalProperties": False},
        "run": _autosub_listen_active_audio,
    },
    "autosub_proofread": {
        "description": "제공한 AutoSubtitle 자막 줄의 오타와 줄바꿈 수정안을 만듭니다. 음성 파일을 듣지 않으며 원본에 자동 적용하지 않습니다.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "lines": {"type": "array", "items": {"type": "string"}, "minItems": 1,
                     "description": "화면에 표시 중인 자막 줄 목록"},
                "maxUnits": {"type": "integer", "minimum": 4, "maximum": 80, "default": 36},
                "targetUnits": {"type": "integer", "minimum": 4, "maximum": 80},
                "instruction": {"type": "string", "maxLength": 1000,
                                "description": "이번 자막 작업에 적용할 추가 요청"},
            },
            "required": ["lines"], "additionalProperties": False,
        },
        "run": _autosub_proofread,
    },
}


def _send(message: dict[str, Any]) -> None:
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def _tool_result(call: dict[str, Any]) -> dict[str, Any]:
    name = call.get("name")
    tool = TOOLS.get(name)
    if tool is None:
        raise ValueError(f"알 수 없는 도구입니다: {name}")
    data = tool["run"](call.get("arguments") or {})
    if isinstance(data, dict) and isinstance(data.get("audio"), bytes):
        return {"content": [
            {"type": "text", "text": f"AutoSubtitle 영상의 {data['startSec']:.3f}초부터 {data['endSec']:.3f}초까지 실제 오디오입니다. 자막과 발음을 대조해 주세요."},
            {"type": "audio", "data": __import__("base64").b64encode(data["audio"]).decode("ascii"), "mimeType": "audio/wav"},
        ], "isError": False}
    return {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}], "isError": False}


def main() -> None:
    threading.Thread(target=_heartbeat_loop, daemon=True, name="mcp-heartbeat").start()
    for raw in sys.stdin.buffer:
        request_id = None
        try:
            message = json.loads(raw.decode("utf-8"))
            method = message.get("method")
            request_id = message.get("id")
            if method == "notifications/initialized" or request_id is None:
                continue
            if method == "initialize":
                threading.Thread(target=_register_session, daemon=True).start()
                requested_version = (message.get("params") or {}).get("protocolVersion")
                result = {
                    "protocolVersion": requested_version if requested_version in SUPPORTED_PROTOCOLS else PROTOCOL_VERSION,
                    "capabilities": {"tools": {"listChanged": False}, "prompts": {"listChanged": False}},
                    "serverInfo": {"name": "itmatzip-agent", "version": AGENT_VERSION},
                }
            elif method == "ping":
                result = {}
            elif method == "shutdown":
                result = {}
            elif method == "tools/list":
                result = {"tools": [{k: v for k, v in tool.items() if k != "run"} | {"name": name}
                                     for name, tool in TOOLS.items()]}
            elif method == "prompts/list":
                result = {"prompts": [{
                    "name": AUTOSUB_PROMPT_NAME,
                    "title": "ItMatZip AutoSubtitle",
                    "description": "현재 열린 자막을 음성과 문맥에 맞춰 교정하고 편집기에 전달합니다.",
                }]}
            elif method == "prompts/get":
                prompt_name = (message.get("params") or {}).get("name")
                if prompt_name != AUTOSUB_PROMPT_NAME:
                    _send({"jsonrpc": "2.0", "id": request_id,
                           "error": {"code": -32602, "message": f"Unknown prompt: {prompt_name}"}})
                    continue
                result = {"description": "ItMatZip AutoSubtitle 자막 교정",
                          "messages": [{"role": "user", "content": {"type": "text", "text": AUTOSUB_PROMPT_TEXT}}]}
            elif method == "tools/call":
                result = _tool_result(message.get("params") or {})
            else:
                _send({"jsonrpc": "2.0", "id": request_id,
                       "error": {"code": -32601, "message": f"Unknown method: {method}"}})
                continue
            _send({"jsonrpc": "2.0", "id": request_id, "result": result})
        except Exception as exc:  # keep stdio protocol alive after a bad tool call
            if "request_id" in locals() and request_id is not None:
                _send({"jsonrpc": "2.0", "id": request_id,
                       "error": {"code": -32000, "message": str(exc)}})
            else:
                print(f"MCP request error: {exc}", file=sys.stderr, flush=True)
    try:
        _request(f"/api/tools/auto-subtitle/v2/mcp/session/{SESSION_ID}", "DELETE", timeout=3)
    except Exception:
        pass


if __name__ == "__main__":
    main()
