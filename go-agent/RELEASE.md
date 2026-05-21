# 에이전트 릴리스 — 한 번에 끝내기

여러 번 MSI만 올리지 말고, **아래 순서를 한 사이클**로만 진행하세요.

## 이번 1.0.5에 묶인 수정 (한 번에 배포)

| 영역 | 내용 |
|------|------|
| Go MSI | 설치/업그레이드 후 **서비스 자동 시작** |
| Go HTTP | **CORS** (웹툰 → 127.0.0.1:19876) |
| Go → FastAPI | **CORS 중복 제거** (Failed to fetch) |
| FastAPI | FFmpeg **readiness 빠름** + **POST /prepare** 다운로드 |
| FFmpeg 경로 | `C:\ProgramData\itmatzip-agent\bin` (서비스 계정) |
| Web UI | `silence-remover/script.js` — `/prepare` 호출 |

**MSI만 올리고 웹 UI를 안 올리면** Silence Detector FFmpeg는 여전히 깨질 수 있습니다.

## 1. 버전 맞추기 (한 줄기)

- `agent/version.py` → `AGENT_VERSION = "1.0.5"`
- `go-agent/installer/product.wxs` → `ProductVersion = "1.0.5.0"`

이미 GitHub에 **깨진 1.0.5**를 올렸다면 → **1.0.6**으로 올리고 manifest도 1.0.6.

## 2. 빌드 + 검증 (관리자 PowerShell)

```powershell
cd go-agent
powershell -ExecutionPolicy Bypass -File scripts\release-once.ps1
```

## 3. GitHub + manifest + 웹 UI

`release-once.ps1` 끝에 나오는 체크리스트 그대로 실행.

## 왜 여러 번 나왔나

디버깅하면서 **증상마다 패치**가 쌓였기 때문입니다 (서비스 수동 시작, CORS, CORS 중복, FFmpeg API).  
앞으로는 **이 문서 + `release-once.ps1` 한 번**만 쓰면 됩니다.
