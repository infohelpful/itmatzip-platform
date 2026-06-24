# Magic Canvas (`magic-canvas`) — 프로토콜 명세

> 서비스 표시명: **Magic Canvas**  
> 툴 ID: `magic-canvas`  
> 최종 갱신: v4 Sign-off (Persistent Worker + OOM 자가치유 + Idle 600s)

본 문서는 메인 에이전트 **Orchestrator**(`agent/engines/magic_canvas.py`)와 백엔드 **Persistent Worker**(`agent/engines/magic_canvas_worker.py`) 간 통신·예외·수명 주기를 규정하는 공식 명세입니다.

---

## 1. 런타임 경로

| 구성 | 경로 |
|------|------|
| Python venv | `%APPDATA%\ItMatZip\magic-canvas\.venv-magiccanvas` (3.12) |
| HF 모델 캐시 | `%APPDATA%\ItMatZip\magic-canvas\models` (`HF_HOME`) |
| 작업 파일 | `%APPDATA%\ItMatZip\magic-canvas\workspace\` |
| 환경 변수 | `HF_HUB_DISABLE_SYMLINKS=1` |

---

## 2. HTTP API (브라우저 ↔ FastAPI)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/tools/magic-canvas/readiness` | GPU·모델·venv |
| POST | `/api/tools/magic-canvas/prepare` | 비동기 환경 준비 |
| GET | `/api/tools/magic-canvas/prepare/status` | prepare 폴링 |
| POST | `/api/tools/magic-canvas/workspace/stage-image` | 원본 → workspace ASCII-safe 복사 |
| POST | `/api/tools/magic-canvas/workspace/upload-mask` | Base64 마스크 PNG 저장 |
| POST | `/api/tools/magic-canvas/submit` | 작업 접수 (단일 Job) |
| GET | `/api/tools/magic-canvas/status` | Job 진행률 폴링 |
| POST | `/api/tools/magic-canvas/workspace/cleanup` | workspace 정리 |

### 단일 Job 스케줄러

- 전역 `CURRENT_JOB`: `status`, `progress`, `output_path`, `error`, `action`
- `threading.Lock` (`_gpu_lock`) — 동시 GPU 작업 1건
- 충돌 시 `409 Conflict`: `"다른 이미지 편집 작업이 진행 중입니다."`
- `output_path`는 서버가 workspace 내 UUID로 자동 생성

---

## 3. IPC 프로토콜 (JSONL)

Orchestrator ↔ Worker는 **stdin / stdout 파이프**로 **한 줄 = JSON 객체**를 교환합니다.

### 3-A. Orchestrator → Worker (stdin)

#### 환경 로드

```json
{"cmd": "load"}
```

OOM 재시도 시 Tier 1 강등 로드:

```json
{"cmd": "load", "force_tier1": true}
```

#### 작업 실행

```json
{
  "cmd": "outpaint",
  "image_path": "C:\\...\\workspace\\ws_image_abc.png",
  "output_path": "C:\\...\\workspace\\out_xyz.png",
  "target_width": 1280,
  "target_height": 720,
  "prompt": "seamless background extension"
}
```

```json
{
  "cmd": "remove",
  "image_path": "...",
  "mask_path": "...",
  "output_path": "..."
}
```

```json
{
  "cmd": "compose",
  "bg_image_path": "...",
  "fg_image_path": "...",
  "output_path": "...",
  "x": 100,
  "y": 80,
  "fg_width": 320,
  "fg_height": 240,
  "prompt": "natural lighting and shadows"
}
```

#### 수동 종료 (Idle 회수 포함)

```json
{"cmd": "ping"}
{"cmd": "shutdown"}
```

### 3-B. Worker → Orchestrator (stdout)

| type | 필드 | 설명 |
|------|------|------|
| `ready` | `message` (선택) | 워커 기동 완료 |
| `pong` | — | ping 응답 |
| `loaded` | `vram_tier` | 모델 로드 완료 |
| `progress` | `progress`, `message` | 0.0–100.0 |
| `result` | `output_path` | 작업 성공 |
| `error` | `message` | 작업 실패 |
| `shutdown_ack` | — | 종료 수락 |

예시:

```json
{"type": "progress", "progress": 45.0, "message": "SDXL 인페인트 추론"}
{"type": "result", "output_path": "C:\\...\\workspace\\out_xyz.png"}
{"type": "error", "message": "CUDA out of memory"}
```

### 3-C. 파싱 규칙

- `JSONDecodeError` 라인은 **로그만** 남기고 루프 계속 (비정형 stderr 혼입 방어)
- 브라우저는 JSONL을 직접 읽지 않음 → HTTP `/status` 폴링

---

## 4. Worker 수명 정책

| 정책 | 선택 |
|------|------|
| 기본 | **Persistent Worker** — 모델 메모리 상주, 2번째 submit부터 빠른 시작 |
| 1-shot | **미사용** (매 job 프로세스 신규 생성 안 함) |
| OOM | 프로세스 격리 crash → Orchestrator **respawn** |
| Idle | **600초** 무요청 시 `shutdown` → VRAM 0MB 회수 |

환경 변수로 Idle 시간 변경: `ITMATZIP_MAGIC_CANVAS_IDLE_SEC` (초, 기본 `600`)

---

## 5. OOM 자가치유 (Self-Healing)

```
[작업 중 워커 OOM / crash / CUDA error]
        │
        ▼
[1] _gpu_lock 유지 (해제하지 않음)
        │
        ▼
[2] 기존 프로세스 kill → respawn_worker()
        │
        ▼
[3] 재시도 판단
    ├─ 1회차 실패 → force_tier1=true 로 load + 동일 cmd 1회 재전송
    └─ 2회차 실패 → CURRENT_JOB.status = "failed"
                    메시지: GPU 메모리 부족 안내
```

**Tier 1 강등:** `enable_sequential_cpu_offload()` 강제 (속도 ↓, 안정성 ↑)

---

## 6. VRAM Tier (Worker 내부)

| Tier | VRAM | 최적화 |
|------|------|--------|
| 1 | ≤ 6500 MB | `sequential_cpu_offload` |
| 2 | 6501–8500 MB | `model_cpu_offload` + attention slicing + VAE tiling |
| 3 | > 8500 MB | `model_cpu_offload` only |
| 1 (강제) | OOM 재시도 | Tier 1과 동일 |

---

## 7. 파일·보안 규칙

- 입력/출력 경로는 **workspace 하위만** 허용
- UI pick 경로는 `stage-image`로 UUID ASCII-safe 복사 후 사용
- 마스크: 흰색=변형 영역, 검은색=보존 (`upload-mask`)

---

## 8. 구현 파일 맵

| 파일 | 역할 |
|------|------|
| `agent/engines/magic_canvas_runtime.py` | venv · prepare · HF 다운로드 |
| `agent/engines/magic_canvas.py` | Orchestrator · Job · staging |
| `agent/engines/magic_canvas_worker.py` | Persistent Worker · SDXL |
| `agent/routers/magic_canvas.py` | FastAPI |
| `web-ui/tools/magic-canvas/` | Magic Canvas UI |

---

## 9. Sign-off 체크리스트

- [x] Persistent Worker (속도)
- [x] subprocess OOM 격리
- [x] `threading.Lock` GPU 직렬화
- [x] `stage-image` + `upload-mask`
- [x] stdout JSONL progress → `/status`
- [x] OOM 1회 Tier1 자동 재시도
- [x] Idle 600s worker shutdown
