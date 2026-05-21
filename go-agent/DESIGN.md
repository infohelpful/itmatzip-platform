# itmatzip-agent Go/Python Hybrid Design

## 목표
- `C:\Program Files\itmatzip-agent\`에 Go 기반 실행기/서비스 설치
- `C:\ProgramData\itmatzip-agent\`에 설정·로그·상태 DB 저장
- Go는 서비스/트레이/UI/로컬 서버/모델 다운로드/프로세스 관리 담당
- Python은 AI 모델 로드, 추론, 설치 워크플로우, 진단을 담당
- 브라우저는 Go가 제공하는 WebSocket 서버로 상태를 구독

## 아키텍처

### Go 메인 컨트롤러
- `main.go`
  - 로컬 HTTP/WebSocket 서버 실행
  - `python_worker/worker.py` 장기 워커 실행
  - `/install-model` 엔드포인트로 Python 설치 워크플로우 실행
  - `C:\ProgramData\itmatzip-agent\` 폴더 보장
- `service.go`
  - `github.com/kardianos/service/v3` 기반 Windows 서비스 등록/실행/제거
  - 서비스가 시작되면 Python 워커와 HTTP/WebSocket 서비스를 시작

### Python 워커
- `python_worker/worker.py`
  - long-lived worker 모드(`--serve`)
  - 설치 진행(w/ stdout JSON events) 모드(`--install-model`)
  - `--model-id`, `--model-url` argument 지원
- `python_worker/worker_grpc.py`
  - gRPC 기반 `WorkerControl` 및 `Inference` 서비스 스켈레톤
  - proto 파일을 기반으로 확장 가능
- `proto/agent.proto`
  - Go/Python 간 계약(Health, InstallModel, InstallModelProgress, Status, Inference)

## 통신 패턴
- Go ↔ Python
  - 장기 서비스: Go가 Python 워커를 subprocess로 실행하고 stdout/stderr JSON라인을 읽음
  - 설치 진행률: Python이 `{"type":"install_progress", ...}` 형태의 JSON 이벤트를 출력하면 Go가 WebSocket으로 브로드캐스트
  - 추론은 장기 gRPC 서버로 확장 가능, `proto/agent.proto`를 기준으로 메시지 계약을 유지

## 설치/경로
- 실행 파일: `C:\Program Files\itmatzip-agent\main.exe`
- Python 엔진: `C:\Program Files\itmatzip-agent\engine\`
- 모델 저장소: `C:\Program Files\itmatzip-agent\models\`
- 설정/로그: `C:\ProgramData\itmatzip-agent\`

## 확장 계획
1. `main.exe` Windows 서비스 설치/삭제 옵션 완성
2. `engine\`에 Python venv 배치 및 Go에서 해당 인터프리터를 직접 지정
3. 모델 다운로드 모듈 추가: 병렬 HTTP Range, 체크섬, SQLite 상태 DB
4. gRPC 기반 inference 서버와 Go 관리 인터페이스 연결
5. 브라우저 UI용 WebSocket 메시지 포맷 고도화
6. WiX/MSI 인스톨러 스크립트 작성

## 현 상태
- Go 서비스/HTTP/WebSocket + **FastAPI 사이드car 프록시** (`/api/*`, `/ui/*`)
- SQLite 상태 DB, Go 모델 다운로더, gRPC 워커
- MSI 스테이징: venv 또는 **embeddable Python** (`-UseEmbeddable`)
- 웹 UI WebSocket 연동 (`bridge.js`, vocal-remover hybrid polling)

## 다음 단계
- MSI에 `agent/` FastAPI 번들 (또는 PyInstaller onedir) 포함
- WiX 설치 후 서비스 E2E 검증 (관리자)
- inference gRPC 실제 모델 로드 연동
