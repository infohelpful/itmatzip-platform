# Python → Go 마이그레이션 매핑

기존 Python 에이전트(`agent/`)의 Windows 설치·실행 로직을 Go 컨트롤러(`go-agent/`)로 이전할 때의 대응표입니다.

## 진입점

| Python | Go | 비고 |
|--------|-----|------|
| `agent/launcher.py` `--install` | `itmatzip-agent.exe --install` | WiX MSI 또는 CLI로 Windows 서비스 등록 |
| `agent/launcher.py` `--uninstall` | `itmatzip-agent.exe --uninstall` | 서비스 제거 |
| `agent/launcher.py` `--serve` | `itmatzip-agent.exe` (포그라운드) / `--service` | HTTP+WS + Python worker 기동 |
| `agent/main.py` FastAPI | 개발 모드 유지 / 추론은 gRPC worker | FastAPI는 admin/debug 용도로 공존 |

## 경로

| Python (`runtime_paths.py` 등) | Go |
|----------------------------------|-----|
| `%APPDATA%\ItMatZip\` (현재 설치본) | `C:\Program Files\itmatzip-agent\` (MSI) |
| 사용자 AppData 설정 | `C:\ProgramData\itmatzip-agent\` |
| 모델 캐시 | `{install_root}\models\` |
| Python venv / wheel | `{install_root}\engine\` |

개발 시 `ITMATZIP_AGENT_DEV=1` → `go-agent\.local\install`, `go-agent\.local\data`

## Windows 시작 / 서비스

| Python (`windows_startup.py`) | Go |
|-------------------------------|-----|
| HKCU Run 레지스트리 자동 실행 | Windows Service (`ItMatZipAgent`) auto-start |
| `installed_exe_path()` | MSI가 `Program Files\itmatzip-agent\itmatzip-agent.exe` 배치 |
| `agent_health_ok()` → `/health` + `agent_version` | `/health` 동일 필드 제공 |
| `subprocess DETACHED_PROCESS` 로 `--serve` | `kardianos/service` + worker manager |

## 모델 / 다운로드

| Python | Go |
|--------|-----|
| (기존) Python 측 다운로드 | `model_downloader.go` — Range 병렬, SHA256, WS 진행률 |
| JSON 상태 파일 | `state.db` (SQLite) — models, downloads, workers |
| — | `POST /install-model` `{ "model_id", "url" }` |

## 프로세스 / IPC

| Python | Go |
|--------|-----|
| 단일 FastAPI 프로세스 | Go 메인 + Python stdio worker + Python gRPC worker |
| HTTP API | Go localhost HTTP/WS (19876) |
| — | gRPC inference (`127.0.0.1:50051`, `proto/agent.proto`) |
| stdout JSON lines (설치) | `worker.py` → Go WS 브로드캐스트 |

## 아직 Go로 이전하지 않은 항목

- 트레이 UI / 파일 �icker (`--pick-file`, `--pick-audio-file`)
- 자동 업데이트 (`common/auto_update.py`)
- PyInstaller 번들링 → WiX MSI + `engine\` venv 로 대체 예정
- FastAPI 기존 REST 엔드포인트 전체 → 단계적으로 Go WS/HTTP로 프록시

## 검증 체크리스트

1. `go build -o itmatzip-agent.exe .`
2. `scripts/smoke_test.ps1` — health, status, gRPC, install-model
3. `python_worker/worker_grpc.py --bind 127.0.0.1:50051` 단독 실행
4. 관리자 PowerShell: `.\itmatzip-agent.exe --install` → 서비스 등록
5. `Get-Service ItMatZipAgent` / `sc query ItMatZipAgent`
