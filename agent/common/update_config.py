"""자동 업데이트 manifest URL — GitHub에 exe 올린 뒤 본인 저장소 URL로 바꾸세요."""

from __future__ import annotations

import os

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ update_config.py  → manifest JSON 주소만 (버전·exe 링크는 그 안에 있음)   │
# │ agent-update-manifest.json → version, download_url(exe), sha256         │
# └─────────────────────────────────────────────────────────────────────────┘
#
# manifest는 Git main에 두는 방식 (권장): push 후 raw URL
# exe는 Releases에만 올리고, download_url은 manifest.json에 적습니다.
DEFAULT_UPDATE_MANIFEST_URL = (
    "https://raw.githubusercontent.com/infohelpful/itmatzip-platform/main/"
    "agent/agent-update-manifest.json"
)

UPDATE_MANIFEST_URL = os.environ.get(
    "ITMATZIP_UPDATE_MANIFEST_URL",
    DEFAULT_UPDATE_MANIFEST_URL,
).strip()

# 기동 후 첫 확인까지 대기(초)
UPDATE_INITIAL_DELAY_SEC = float(os.environ.get("ITMATZIP_UPDATE_INITIAL_DELAY_SEC", "45"))

# 백그라운드 확인 주기(초) — 기본 6시간
UPDATE_CHECK_INTERVAL_SEC = float(
    os.environ.get("ITMATZIP_UPDATE_CHECK_INTERVAL_SEC", str(6 * 3600))
)

# ITMATZIP_DISABLE_AUTO_UPDATE=1 이면 확인·적용 모두 끔
AUTO_UPDATE_DISABLED = os.environ.get("ITMATZIP_DISABLE_AUTO_UPDATE", "").strip().lower() in (
    "1",
    "true",
    "yes",
)
