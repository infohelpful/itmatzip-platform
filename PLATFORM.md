# ItMatZip Platform — 스펙 및 동작 가이드

> 최종 갱신: 2026-07-07 · 에이전트 버전 `1.5.0`

ItMatZip은 **브라우저 기반 웹 UI**와 **Windows 로컬 에이전트**를 결합한 AI 미디어 처리 플랫폼입니다.  
영상·오디오·이미지는 **사용자 PC에서만** 처리되며, 외부 서버로 미디어 파일이 업로드되지 않습니다.

---

## 목차

1. [핵심 개념](#1-핵심-개념)
2. [시스템 아키텍처](#2-시스템-아키텍처)
3. [컴포넌트 상세](#3-컴포넌트-상세)
4. [통신 흐름](#4-통신-흐름)
5. [툴 목록 및 API](#5-툴-목록-및-api)
6. [런타임 시스템](#6-런타임-시스템)
7. [설치 및 배포](#7-설치-및-배포)
8. [개발 환경](#8-개발-환경)
9. [환경 변수 참조](#9-환경-변수-참조)
10. [새 툴 추가 체크리스트](#10-새-툴-추가-체크리스트)

---

## 1. 핵심 개념

| 구분 | 설명 |
|------|------|
| **웹 UI** | `https://tools.itmatzip.com` 에서 제공되는 정적 HTML/JS/CSS. 툴 대시보드와 각 툴 화면으로 구성 |
| **로컬 에이전트** | 사용자 PC에 설치되는 `itmatzip-agent.exe`. `127.0.0.1:19876` 에서 HTTP/WebSocket 서버 실행 |
| **프라이버시** | 미디어 파일은 로컬 디스크에서만 읽고 쓰며, 처리 결과도 로컬에 저장 |
| **AI 모델** | 최초 사용 시 Hugging Face 등에서 로컬로 다운로드. 이후 오프라인 사용 가능 |
| **툴 격리** | 각 툴은 독립된 Python 런타임(venv 또는 pip target)을 사용 — 툴 간 패키지 공유 금지 |

### 설계 원칙

- **로컬 우선(Local-first)**: 브라우저는 UI만 담당, 실제 연산은 에이전트가 수행
- **툴별 런타임 격리**: MSI `Program Files` 엔진은 읽기 전용이므로, pip 설치는 `%APPDATA%` 아래 툴별 폴더에 수행
- **점진적 준비(Lazy prepare)**: FFmpeg·AI 패키지·모델은 툴 최초 사용 시 `/prepare` 엔드포인트로 비동기 설치
- **Go + Python 하이브리드**: Go는 서비스/트레이/프록시/파일 대화상자, Python은 FastAPI API·AI 추론

---

## 2. 시스템 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│  브라우저 (tools.itmatzip.com 또는 localhost:29180)              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ 대시보드      │  │ 툴 UI        │  │ common/bridge.js     │  │
│  │ index.html   │  │ silence-...  │  │ (HTTP + WebSocket)   │  │
│  └──────────────┘  └──────────────┘  └──────────┬───────────┘  │
└─────────────────────────────────────────────────┼───────────────┘
                                                  │ CORS + Private Network Access
                                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  Go Controller — itmatzip-agent.exe :19876                       │
│  ┌──────────┐ ┌──────────┐ ┌────────────┐ ┌─────────────────┐  │
│  │ /health  │ │ /ws      │ │ /api/agent │ │ Reverse Proxy   │  │
│  │ /status  │ │ WebSocket│ │ pick-*     │ │ /api/* → :19877 │  │
│  └──────────┘ └──────────┘ └────────────┘ └────────┬────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌────────────┐          │            │
│  │ 시스템   │ │ MSI      │ │ Python     │          │            │
│  │ 트레이   │ │ 자동업데이트│ │ gRPC Worker│          │            │
│  └──────────┘ └──────────┘ └────────────┘          │            │
└─────────────────────────────────────────────────────┼────────────┘
                                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│  Python FastAPI Sidecar — uvicorn :19877                         │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ agent/main.py — 툴별 라우터 등록                              │ │
│  │  /api/tools/silence-remover/*                               │ │
│  │  /api/tools/vocal-remover/*                                 │ │
│  │  /api/tools/auto-subtitle/*                                 │ │
│  │  /api/tools/image-enhancer/*                                │ │
│  │  /api/tools/create-music/*                                  │ │
│  │  /api/tools/magic-canvas/*                                  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ agent/engines/ — FFmpeg, Whisper, Demucs, CodeFormer 등     │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  로컬 리소스                                                      │
│  • FFmpeg/ffprobe  → %APPDATA%\ItMatZip\bin\                    │
│  • Engine runtime  → %APPDATA%\ItMatZip\engine-runtime\<tool>\  │
│  • Venv runtime    → %APPDATA%\ItMatZip\<tool>\.venv-*          │
│  • AI 모델         → C:\Program Files\itmatzip-agent\models\    │
│  • 설정/로그/DB    → C:\ProgramData\itmatzip-agent\             │
└─────────────────────────────────────────────────────────────────┘
```

### 포트 구성

| 포트 | 프로세스 | 용도 |
|------|----------|------|
| `19876` | Go `itmatzip-agent.exe` | 브라우저가 직접 접속하는 메인 엔드포인트 |
| `19877` | Python FastAPI (사이드카) | Go가 내부 프록시하는 API 서버 |
| `50051` | Python gRPC Worker | 장기 AI 추론 워커 (선택) |
| `29180` | 개발용 정적 서버 | `serve-tools.ps1` 로컬 웹 UI |

---

## 3. 컴포넌트 상세

### 3.1 웹 UI (`web-ui/tools/`)

정적 파일로 호스팅되며, 에이전트 없이도 화면은 열리지만 실제 처리는 에이전트 연결이 필요합니다.

```
web-ui/tools/
├── index.html              # 툴 대시보드 (허브)
├── assets/
│   ├── tools-registry.js   # 툴 메뉴 정의 (SSOT)
│   └── dashboard.js        # 대시보드 렌더링
├── common/                 # 툴 공통 모듈
│   ├── bridge.js           # 에이전트 HTTP/WS 클라이언트
│   ├── agent-endpoints.js  # 포트·오리진 상수
│   ├── agent-pick-endpoints.js  # 파일 대화상자 API 맵
│   ├── agent-install-ui.js # MSI 설치 안내 팝업
│   └── ...
├── silence-remover/        # 툴별 폴더
├── auto-subtitle/
├── vocal-remover/
├── image-enhancer/
├── create-music/
└── magic-canvas/
```

**`bridge.js`** 가 모든 툴의 에이전트 통신을 담당합니다:
- `GET /health` — 연결 상태 모니터링 (2~3회 연속 실패 시 UI에 '끊김' 표시)
- `fetch()` — 툴 API 호출 (`/api/tools/...`)
- `connectAgentWebSocket()` — `ws://127.0.0.1:19876/ws` 로 설치·다운로드 진행 이벤트 수신
- Circuit breaker — 연속 실패 시 일시적 요청 차단

### 3.2 Go 에이전트 (`go-agent/`)

Windows에서 실행되는 메인 컨트롤러입니다.

| 파일 | 역할 |
|------|------|
| `main.go` | HTTP/WS 서버, CLI (`--tray`, `--launch`, `--install`) |
| `fastapi_sidecar.go` | Python FastAPI 사이드카 프로세스 관리 |
| `tray_windows.go` | 시스템 트레이 UI |
| `auto_update.go` | MSI 자동 업데이트 |
| `worker_manager.go` | Python gRPC 워커 수명 관리 |
| `model_downloader.go` | 병렬 HTTP Range 모델 다운로드 |
| `permissions_windows.go` | runtime 디렉터리 ACL 설정 |
| `installer/` | WiX MSI 빌드 스크립트 |

**실행 모드:**

| 모드 | 명령 | 설명 |
|------|------|------|
| 트레이 | `itmatzip-agent.exe --tray` | 사용자 세션. 트레이 아이콘 + 파일 대화상자 가능 |
| 서비스 | Windows 서비스로 등록 | API만 제공 (Session 0, 파일 대화상자 불가) |
| 개발 | `ITMATZIP_AGENT_DEV=1` + 실행 | `go-agent\.local\` 경로 사용 |

### 3.3 Python 에이전트 (`agent/`)

FastAPI 기반 API 서버. Go 사이드카로 `:19877` 에서 실행됩니다.

| 디렉터리 | 역할 |
|----------|------|
| `main.py` | 앱 팩토리, 라우터 등록, CORS, lifespan warmup |
| `routers/` | 툴별 FastAPI 라우터 (`/api/tools/<id>/*`) |
| `engines/` | 실제 처리 로직 (FFmpeg, AI 추론 등) |
| `common/` | bin_manager, runtime_site_packages, auto_update |
| `version.py` | `AGENT_VERSION` (MSI·manifest와 동기화) |

**공통 API 패턴 (툴별):**

| 엔드포인트 | 설명 |
|-----------|------|
| `GET /readiness` | FFmpeg·모델 등 준비 상태 확인 |
| `POST /prepare` | 환경 비동기 설치 시작 (pip, 모델 다운로드) |
| `GET /prepare/status` | 설치 진행률 폴링 |
| `POST /<action>` | 작업 시작 (분석, 분리, 생성 등) |
| `GET /<action>/status` | 작업 진행률 폴링 |

### 3.4 Python gRPC Worker (`go-agent/python_worker/`)

장기 실행 AI 추론용 서브프로세스입니다. Go가 subprocess로 실행하고 stdout JSON 이벤트를 WebSocket으로 브로드캐스트합니다.

- `worker.py` — stdio JSON 이벤트 (`--serve`, `--install-model`)
- `worker_grpc.py` — gRPC `WorkerControl` / `Inference` 서비스
- `proto/agent.proto` — Go/Python 간 메시지 계약

---

## 4. 통신 흐름

### 4.1 일반 작업 흐름

```
1. 사용자가 웹 UI에서 파일 경로·옵션 설정
2. bridge.js → GET /health (에이전트 연결 확인)
3. bridge.js → POST /api/tools/<tool>/prepare (필요 시 환경 설치)
4. bridge.js → GET /api/tools/<tool>/prepare/status (폴링)
5. bridge.js → POST /api/tools/<tool>/<action> (작업 시작)
6. bridge.js → GET /api/tools/<tool>/<action>/status (진행률 폴링)
7. 완료 → 결과 파일 경로 또는 다운로드 URL 반환
```

### 4.2 파일 선택 흐름 (Go 전용)

브라우저는 로컬 파일 시스템에 직접 접근할 수 없으므로, Go가 네이티브 파일 대화상자를 띄웁니다.

```
1. bridge.js → POST /api/agent/pick-local-file (또는 pick-local-audio-file 등)
2. Go (interactive tray 프로세스) → Windows 파일 대화상자 표시
3. 사용자가 파일 선택 → UTF-8 절대 경로 반환
4. 웹 UI가 경로를 API 요청 body에 포함
```

> **주의**: Windows 서비스(Session 0)에서는 파일 대화상자를 띄울 수 없습니다.  
> 반드시 `--tray` 모드(사용자 세션)로 실행해야 합니다.

### 4.3 WebSocket 이벤트

`ws://127.0.0.1:19876/ws` 로 연결하면 다음 이벤트를 수신합니다:

| type | 설명 |
|------|------|
| `download` | 모델/패키지 다운로드 시작·완료 |
| `install` | pip 설치 시작·완료 |
| `install_progress` | 설치 진행률 (percent, message) |
| `worker` | gRPC 워커 상태 변경 |
| `heartbeat` | 연결 유지 |

### 4.4 CORS 및 Private Network Access

`tools.itmatzip.com`(공인 HTTPS)에서 `127.0.0.1:19876`(로컬)으로 요청할 때 Chrome의 Local Network Access 정책이 적용됩니다.

- Go가 CORS 헤더와 `Access-Control-Allow-Private-Network: true` 를 응답
- FastAPI는 `ITMATZIP_BEHIND_GO_PROXY=1` 일 때 CORS를 비활성화 (Go가 대신 처리)

---

## 5. 툴 목록 및 API

`web-ui/tools/assets/tools-registry.js` 가 툴 메뉴의 단일 진실 공급원(SSOT)입니다.  
`id`(kebab-case)는 백엔드 라우터 prefix·런타임 `tool_id`와 반드시 일치해야 합니다.

| ID | 이름 | 기술 스택 | 런타임 유형 |
|----|------|-----------|-------------|
| `silence-remover` | Silence Detector | FFmpeg silencedetect, FCP7 XML | Engine (Pillow) |
| `auto-subtitle` | Auto Subtitle | Faster-Whisper, SRT/번인 | Engine |
| `vocal-remover` | Vocal Remover | Demucs `mdx_extra_q` | Engine (torch, demucs) |
| `image-enhancer` | Image Enhancer | CodeFormer 얼굴 복원 | Venv (Python 3.12) |
| `create-music` | Create Music | ACE-Step 1.5, LoRA | Venv (Python 3.12) |
| `magic-canvas` | Magic Canvas | SDXL inpaint/outpaint, rembg | Venv (Python 3.12) |

### 툴별 상세 문서

| 툴 | 문서 경로 |
|----|-----------|
| Auto Subtitle | `web-ui/tools/auto-subtitle/AUTO-SUBTITLE.MD` |
| Vocal Remover | `web-ui/tools/vocal-remover/VOCAL-REMOVER.MD` |
| Image Enhancer | `web-ui/tools/image-enhancer/IMAGE-ENHANCER.MD` |
| Magic Canvas | `web-ui/tools/magic-canvas/MAGIC-CANVAS.MD` |

---

## 6. 런타임 시스템

### 6.1 왜 툴별 런타임인가?

MSI로 설치된 `C:\Program Files\itmatzip-agent\engine\`(Python **3.12** embeddable)은 일반 사용자에게 **쓰기 불가**합니다.  
따라서 pip 설치는 `%APPDATA%\ItMatZip\` 아래 툴별 폴더에 `--target` 옵션으로 수행합니다.

**툴 간 runtime 공유는 금지** — 서로 다른 torch/demucs/whisper 버전이 충돌할 수 있습니다.

### 6.2 Engine Runtime (Python 3.12, pip --target)

경로: `%APPDATA%\ItMatZip\engine-runtime\<tool_id>\Lib\site-packages`

| tool_id | 주요 패키지 |
|---------|-------------|
| `silence-remover` | Pillow |
| `vocal-remover` | torch, demucs, diffq (GitHub wheel 번들, **cp312**) |
| `auto-subtitle` | faster-whisper, ctranslate2 등 |

### 6.3 Venv Runtime (Python 3.12 전용 venv)

엔진과 **같은 메이저(3.12)** 이지만, 무거운 AI 스택은 독립 venv를 사용합니다.

| tool_id | venv 경로 |
|---------|-----------|
| `image-enhancer` | `%APPDATA%\ItMatZip\image-enhancer\.venv-codeformer` |
| `create-music` | `%ProgramData%\itmatzip-agent\create-music\.venv-acestep` |
| `magic-canvas` | `%APPDATA%\ItMatZip\magic-canvas\.venv-magiccanvas` |

### 6.4 런타임 API (`agent/common/runtime_site_packages.py`)

| 함수 | 용도 |
|------|------|
| `activate_runtime_site_packages(tool_id)` | 요청 시점에 해당 툴 site-packages를 `sys.path`에 추가 |
| `run_runtime_pip(tool_id, ...)` | pip 설치 + Windows ACL 정리 |
| `finalize_runtime_pip(tool_id)` | Popen pip 완료 후 ACL 정리 |
| `tool_has_module(tool_id, module)` | 디스크 기반 설치 확인 (find_spec만으로 판단 금지) |
| `verify_importable(tool_id, module)` | 실제 import 가능 여부 검증 |

### 6.5 ACL 안전 규칙

pip를 **관리자 권한** 또는 **SYSTEM(MSI deferred)** 으로 실행하면 ACL이 오염되어 일반 사용자가 import 불가해집니다.

**반드시 지켜야 할 규칙:**
- pip는 `run_runtime_pip` / `run_hidden` / `finalize_runtime_pip` 로만 실행
- `main.py` startup에서 특정 툴 runtime을 전역 활성화하지 않음
- subprocess에는 `ITMATZIP_RUNTIME_TOOL=<tool_id>` 환경 변수 전달

---

## 7. 설치 및 배포

### 7.1 경로 (프로덕션 MSI)

| 용도 | 경로 |
|------|------|
| 실행 파일 | `C:\Program Files\itmatzip-agent\` |
| Python 엔진 | `C:\Program Files\itmatzip-agent\engine\` |
| AI 모델 | `C:\Program Files\itmatzip-agent\models\` |
| 설정·로그·DB | `C:\ProgramData\itmatzip-agent\` |
| FFmpeg | `%APPDATA%\ItMatZip\bin\` |
| 툴 runtime | `%APPDATA%\ItMatZip\engine-runtime\<tool>\` |

### 7.2 웹 UI 배포

- **호스팅**: `https://tools.itmatzip.com` (cPanel, `.cpanel.yml` 로 `web-ui/tools/` 배포)
- **로컬 개발**: `.\serve-tools.ps1` → `http://localhost:29180/`
- **에이전트 번들**: Go가 `tools-web/` 을 `http://127.0.0.1:19876/tools/` 에 서빙 가능

### 7.3 에이전트 배포 (MSI)

```powershell
# MSI 빌드
cd go-agent/installer
.\build.ps1 -UseEmbeddable   # embeddable Python 3.12.10 권장

# 릴리스 게시 (manifest + SHA256)
.\publish-agent-release.ps1 -PackageType msi
```

**설치 후 흐름:**
1. WiX MSI 설치 → `C:\Program Files\itmatzip-agent\`
2. `itmatzip-agent.exe --install` → 트레이 자동시작 등록 (HKCU/HKLM Run)
3. 로그인 시 `--tray` 모드로 트레이 아이콘 표시
4. 자동 업데이트: `agent-update-manifest.json` 기반 MSI 다운로드·적용

### 7.4 버전 동기화

다음 파일의 버전은 반드시 일치해야 합니다:

| 파일 | 필드 |
|------|------|
| `agent/version.py` | `AGENT_VERSION` |
| `go-agent/installer/product.wxs` | `Version` 속성 |
| `agent/agent-update-manifest.json` | `version` |

---

## 8. 개발 환경

### 8.1 사전 요구

- Windows 10/11
- Go 1.23+
- Python 3.12.10 (에이전트 엔진 embeddable + 로컬 개발, venv 툴과 메이저 통일)
- WiX Toolset 3.14+ (MSI 빌드 시; WiX 버전이며 Python과 무관)
- FFmpeg (자동 bootstrap 또는 수동 설치)

### 8.2 로컬 실행

```powershell
# 1. 정적 웹 UI (터미널 1)
.\serve-tools.ps1
# → http://localhost:29180/

# 2. Go 에이전트 (터미널 2)
cd go-agent
$env:ITMATZIP_AGENT_DEV = "1"
.\itmatzip-agent.exe --tray
# → http://127.0.0.1:19876/health

# 3. (선택) Python 에이전트만 단독 실행 (레거시)
.\start-agent.ps1
# → uvicorn agent/main.py :19876
```

### 8.3 스모크 테스트

```powershell
cd go-agent
.\scripts\smoke_test.ps1
```

### 8.4 주요 빌드 스크립트

| 스크립트 | 용도 |
|----------|------|
| `build-agent.ps1` | 레거시 PyInstaller exe 빌드 |
| `go-agent/installer/build.ps1` | WiX MSI 빌드 |
| `go-agent/scripts/deploy-agent-py.ps1` | agent Python 소스를 설치 트리에 배포 |
| `publish-agent-release.ps1` | manifest + SHA256 생성 |
| `go-agent/scripts/fix-engine-runtime-permissions.ps1` | ACL 오염 수동 복구 |

---

## 9. 환경 변수 참조

| 변수 | 효과 |
|------|------|
| `ITMATZIP_RUNTIME_TOOL` | subprocess/runtime 활성화 대상 툴 ID |
| `ITMATZIP_BEHIND_GO_PROXY` | FastAPI가 Go 프록시 뒤에서 실행 (CORS 비활성화) |
| `ITMATZIP_AGENT_DEV` | 개발 모드 (`go-agent\.local\` 경로 사용) |
| `ITMATZIP_AGENT_INSTALL_ROOT` | MSI 설치 루트 오버라이드 |
| `ITMATZIP_AGENT_DATA` / `ITMATZIP_DATA_ROOT` | ProgramData 경로 오버라이드 |
| `ITMATZIP_DISABLE_AUTO_UPDATE` | MSI/exe 자동 업데이트 비활성화 |
| `ITMATZIP_FASTAPI_PYTHON` | FastAPI 사이드카 Python 인터프리터 오버라이드 |
| `ITMATZIP_TOOLS_WEB_BASE` | 트레이 메뉴 URL 기본값 (기본: `https://tools.itmatzip.com`) |
| `ITMATZIP_WHEEL_VARIANT` | Demucs CPU/GPU wheel 선택 |
| `HF_TOKEN` / `ITMATZIP_HF_TOKEN` | Hugging Face 토큰 (모델 다운로드) |

---

## 10. 새 툴 추가 체크리스트

1. **`web-ui/tools/assets/tools-registry.js`** — `TOOLS` 배열에 항목 추가 (`id` = kebab-case)
2. **`web-ui/tools/<tool-id>/`** — `index.html`, `script.js`, CSS 등 UI 파일 생성
3. **`agent/routers/<tool>.py`** — FastAPI 라우터 (`prefix="/api/tools/<tool-id>"`)
4. **`agent/engines/<tool>.py`** — 처리 로직
5. **`agent/main.py`** — `app.include_router(...)` 등록
6. **`agent/common/runtime_site_packages.py`**
   - `TOOL_<NAME> = "<tool-id>"` 상수 추가
   - `ENGINE_RUNTIME_TOOL_IDS` 또는 `VENV_RUNTIME_TOOL_IDS`에 등록
   - `ensure_runtime_directories()`에 venv 경로 반영
7. **`go-agent/permissions_windows.go`** — `ensureRuntimeSitePackagesDir()`에 디렉터리 추가
8. pip/import 시 `activate_runtime_site_packages(tool_id)` 호출 (전역 활성화 금지)
9. subprocess env: `ITMATZIP_RUNTIME_TOOL=<tool_id>`

---

## 관련 문서

| 문서 | 내용 |
|------|------|
| `go-agent/DESIGN.md` | Go/Python 하이브리드 설계 |
| `go-agent/MIGRATION.md` | PyInstaller → Go MSI 마이그레이션 |
| `go-agent/README.md` | Go 에이전트 빌드·실행 |
| `agent/AGENT_AUTO_UPDATE.md` | 자동 업데이트 메커니즘 |
| `.cursor/rules/per-tool-runtime.mdc` | 런타임 격리 규칙 (개발 필수) |
| `README.md` | Silence Remover 초기 개발 내역 (레거시) |
