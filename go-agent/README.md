# itmatzip-agent Go + Python Hybrid

Go가 Windows 서비스·로컬 HTTP/WebSocket·모델 다운로드·상태 DB를 담당하고, Python은 AI 추론(gRPC) 및 stdio JSON 이벤트 워커를 담당합니다.

## 구조

```
go-agent/
├── main.go              # HTTP/WS 서버, CLI
├── service.go           # Windows 서비스 등록/실행
├── worker_manager.go    # Python subprocess 수명 관리
├── model_downloader.go  # 병렬 Range 다운로드
├── model_store.go       # SQLite 모델 메타
├── state_db.go          # SQLite 스키마
├── grpc_client.go       # Python gRPC 클라이언트
├── paths.go             # 설치/개발 경로
├── proto/               # agent.proto + 생성된 Go stubs
├── python_worker/       # Python stdio + gRPC worker
├── installer/           # WiX MSI 스켈레톤
└── scripts/             # proto 생성, smoke test
```

## 사전 요구

- Go 1.23+
- Python 3.10+ (`pip install -r python_worker/requirements.txt`)
- (MSI 빌드) WiX Toolset 3.14+

## 빌드

```powershell
cd go-agent
go build -o itmatzip-agent.exe .
```

Proto 재생성:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/generate_proto.ps1
cd python_worker
python generate_proto.py
```

## 실행 (개발)

```powershell
$env:ITMATZIP_AGENT_DEV = "1"
.\itmatzip-agent.exe
# 또는 포트 지정
.\itmatzip-agent.exe --port 19876 --grpc-port 50051
# Python worker 없이 Go만
.\itmatzip-agent.exe --no-python
```

개발 경로:
- 설치: `go-agent\.local\install\`
- 데이터/DB/로그: `go-agent\.local\data\`

## API

| 엔드포인트 | 설명 |
|-----------|------|
| `GET /health` | `{ status, service, agent_version }` |
| `GET /status` | 경로, workers, models, gRPC health |
| `GET /models` | 설치된 모델 목록 |
| `POST /install-model` | `{ "model_id": "...", "url": "..." }` |
| `WS /ws` | download/install/worker 이벤트 |

설치 예:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19876/install-model `
  -Body '{"model_id":"test-model","url":"https://example.com/model.bin"}' `
  -ContentType 'application/json'
```

## gRPC worker (단독)

```powershell
cd python_worker
python worker_grpc.py --bind 127.0.0.1:50051
```

## Windows 서비스

관리자 PowerShell:

```powershell
.\itmatzip-agent.exe --install
Start-Service ItMatZipAgent
# 제거
.\itmatzip-agent.exe --uninstall
```

## FastAPI 사이드카 (vocal-remover API 프록시)

Go가 `:19877`에서 FastAPI(uvicorn)를 기동하고 `:19876`에서 `/api/*`, `/ui/*`를 프록시합니다.

```powershell
$env:ITMATZIP_AGENT_DEV = "1"
$env:ITMATZIP_AGENT_DIR = "..\agent"   # repo agent/ 경로
.\itmatzip-agent.exe
# http://127.0.0.1:19876/api/tools/vocal-remover/status  → FastAPI 프록시
# http://127.0.0.1:19876/health  → agent_version 병합 (FastAPI + Go)
```

옵션:
- `--fastapi-port 19877` — 사이드카 포트
- `--no-fastapi` — Go-only 모드

FastAPI Python: `ITMATZIP_FASTAPI_PYTHON` 또는 `agent/.venv-build/Scripts/python.exe` (uvicorn+fastapi 필요)

통합 테스트:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/proxy_test.ps1
```

## MSI / venv 번들링

```powershell
# embeddable Python (cross-machine MSI 권장)
powershell -ExecutionPolicy Bypass -File installer/stage-payload.ps1 -UseEmbeddable

# venv --copies (빌드 PC Python 경로 의존)
powershell -ExecutionPolicy Bypass -File installer/stage-payload.ps1

# MSI 빌드 (WiX 필요, 관리자)
powershell -ExecutionPolicy Bypass -File installer/build.ps1 -UseEmbeddable
```

자세한 내용: [installer/README.md](installer/README.md)

## WebSocket (웹 UI)

브라우저 → `ws://127.0.0.1:19876/ws`

이벤트 타입: `download`, `install`, `install_progress`, `worker`, `heartbeat`

웹 UI 연동: `web-ui/tools/common/bridge.js` — `connectAgentWebSocket()`, `mapAgentEventToPrepareStatus()`

vocal-remover prepare 오버레이가 WS + REST 폴링 하이브리드로 진행률 표시.


## 통합 테스트

```powershell
powershell -ExecutionPolicy Bypass -File scripts/smoke_test.ps1
```

## 상태 DB

`{data_root}/state.db` (SQLite)

- `models` — 모델 메타 (id, url, sha256, status)
- `downloads` — 다운로드 이력
- `workers` — Python worker PID/상태
- `settings` — key-value 설정

## 관련 문서

- [DESIGN.md](DESIGN.md) — 아키텍처 설계
- [MIGRATION.md](MIGRATION.md) — Python → Go 매핑
