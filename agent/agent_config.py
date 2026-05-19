"""로컬 에이전트 바인딩 — 포트 변경 시 web-ui/tools/common/agent-endpoints.js 도 맞출 것."""

from __future__ import annotations

AGENT_HOST = "127.0.0.1"
# 8000 대신 충돌이 적은 비예약 포트 (Django/React 등과 겹치지 않음)
AGENT_PORT = 19876


def agent_base_url() -> str:
    return f"http://{AGENT_HOST}:{AGENT_PORT}"


def health_url() -> str:
    return f"{agent_base_url()}/health"
