# MagicEraser 아키텍처

`magic-eraser`는 기존 `background-remover`/`image-enhancer`와 동일한 로컬 에이전트 기반 웹툴 아키텍처를 따르는 브러시 마스크 기반 객체 지우개(LaMa inpaint) 툴입니다.

## 1. 개요

- 브라우저 UI: 이미지 로드 → 캔버스에 브러시로 지울 영역 칠하기 → 마스크를 로컬 에이전트로 전송 → LaMa(IOPaint) 추론 → 결과 다운로드
- 로컬 에이전트(FastAPI): PyTorch + LaMa(big-lama.pt) 전용 Python 3.12 런타임 설치·모델 다운로드·추론 서브프로세스 실행
- 파일은 로컬 PC에서만 처리되며, 마스크는 브라우저 캔버스에서 base64 PNG로 인코딩해 전송합니다.

```
[브라우저 UI]
  web-ui/tools/magic-eraser/{index.html,style.css,script.js}
    ├─ 이미지 선택 (agent-pick-endpoints.js → AGENT_PICK_IMAGE)
    ├─ 캔버스 편집기 (표시용 canvas + 오프스크린 mask/overlay canvas)
    ├─ bridge.js 연결 확인·설치 안내·요청 폴링
    └─ 결과 비교 슬라이더 · download.html
         │ /api/tools/magic-eraser/*
         ▼
[로컬 에이전트 FastAPI]  agent/routers/magic_eraser.py
  ├─ GET  /readiness            — 빠른 상태 조회 (torch/pip/model)
  ├─ POST /prepare, GET /prepare/status — 런타임+모델 설치 진행률
  ├─ POST /erase, GET /erase/status     — 지우기 작업 시작·폴링
  ├─ POST /preview, GET /media/image    — 원본 미리보기
  ├─ GET  /download                     — 결과 파일 다운로드
  └─ POST /workspace/cleanup            — 임시 작업 폴더 정리
         │
         ▼
[엔진]  agent/engines/magic_eraser.py, agent/engines/iopaint_runtime.py
  ├─ 전용 Python 3.12 런타임 설치 (library-hub wheel, GPU/CPU 자동 선택)
  ├─ LaMa 모델(big-lama.pt) 다운로드
  └─ agent/engines/iopaint_runner.py 서브프로세스로 실제 추론 실행
         │
         ▼
[로컬 디스크]
  %APPDATA%\ItMatZip\magic-eraser\models\      — big-lama.pt
  %APPDATA%\ItMatZip\magic-eraser\workspace\   — job-<ts>/input, output
```

## 2. 브러시 마스크 캔버스 설계

`script.js`는 이미지 하나당 캔버스 3장을 사용합니다.

1. **`edit-canvas`** (DOM, 화면 표시): 원본 이미지 + 반투명 빨강 오버레이를 매 프레임 합성해서 보여줍니다.
2. **`maskCanvas`** (오프스크린): 실제 마스크 데이터. 기본은 완전 투명, 브러시로 칠한 곳은 불투명 흰색(RGBA 255,255,255,255)입니다.
   - 브러시 도구: `globalCompositeOperation = "source-over"`로 흰 원/선을 그립니다.
   - 지우개 도구: `globalCompositeOperation = "destination-out"`으로 칠했던 부분을 다시 투명하게 되돌립니다.
3. **`overlayCanvas`** (오프스크린): 화면에 보여줄 반투명 빨강 레이어. 매 스트로크마다
   - 캔버스 전체를 `rgba(239,68,68,0.45)`로 채우고
   - `globalCompositeOperation = "destination-in"`으로 `maskCanvas`를 그려 마스크 모양대로만 빨간색이 남게 만듭니다.
   - 이 방식은 스트로크가 겹쳐도 항상 45% 고정 투명도를 유지합니다(단순 누적 페인팅과 달리 겹칠수록 진해지지 않음).

`edit-canvas`는 표시 성능을 위해 원본 해상도가 아니라 긴 변 최대 1600px로 축소한 "작업 해상도"에서 그려집니다. 「지우기 실행」을 누르면 `maskCanvas`를 원본 해상도로 다시 그려(니어리스트 네이버, `imageSmoothingEnabled=false`) PNG base64로 인코딩한 뒤 `mask_base64`로 전송합니다. 좌표 변환은 `edit-canvas.getBoundingClientRect()`와 캔버스 내부 해상도 비율로 매 포인터 이벤트마다 계산합니다.

포인터 다운/무브/업 이벤트로 원(점)과 선(스트로크)을 그려 빠른 드래그에도 끊기지 않게 하며, 포인터업 시 `maskCanvas`의 알파 채널을 스캔해 실제로 칠해진 픽셀이 있는지 확인해 「지우기 실행」 버튼 활성화 여부를 갱신합니다.

## 3. 에이전트 API 계약 (이미 구현됨)

`agent/routers/magic_eraser.py` 기준:

- `GET /api/tools/magic-eraser/readiness` → `background-remover`와 동일한 필드 구조(`pytorch.gpu_detected`, `binaries.cuda_available`, `binaries.torch/pip_stack/model_ready` 등)를 사용해 헤더의 GPU/CPU 배지·준비 상태 문구를 재사용합니다.
- `POST /api/tools/magic-eraser/prepare` (`?force=true` 지원), `GET /prepare/status` → `phase`(`installing_dependencies`/`downloading_models`/`ready`/`failed`), `progress`, `message`, `step`.
- `POST /api/tools/magic-eraser/erase` → body `{ image_path, mask_base64 | mask_path, device, timeout_sec }`. `device`는 `null`(자동)/`cpu`/`cuda`.
- `GET /api/tools/magic-eraser/erase/status` → `phase`(`running`/`ready`/`failed`), `progress`, `output_path`, `mask_path`, `original_path`, `width`, `height`.
- `GET /api/tools/magic-eraser/download?file_path=...` → 결과 파일 스트리밍.
- `POST /api/tools/magic-eraser/workspace/cleanup` → 임시 작업 폴더 정리(작업 중이면 409).

## 4. UI 파일 구성

```
web-ui/tools/magic-eraser/
  index.html      # 경로 입력 · 캔버스 편집기 · 브러시 툴바 · 옵션 · 실행 버튼
  style.css       # 다크 테마 (accent #a855f7), 브러시 툴바, 캔버스, 비교 슬라이더
  script.js       # readiness/prepare 폴링, 캔버스 브러시, erase 폴링, 다운로드 세션
  download.html   # 결과 다운로드 페이지
  download.js
  download.css
  MAGIC-ERASER.MD
```

## 5. 대시보드 등록

- `web-ui/tools/assets/tools-registry.js`에 `id: "magic-eraser"` 항목 추가 (SSOT).
- `web-ui/tools/assets/dashboard.js`의 `tools-registry.js` import 캐시 버스트 버전과 `web-ui/tools/index.html`의 `dashboard.js` 스크립트 버전을 함께 올려 배포 후 새 카드가 즉시 반영되게 합니다.

## 6. 재사용한 공통 모듈

- `web-ui/tools/common/bridge.js` — 연결 확인·설치 안내·`requestAgent`(202 폴링 포함)
- `web-ui/tools/common/agent-pick-endpoints.js` — `AGENT_PICK_IMAGE`
- `web-ui/tools/common/adsense.js` — `editorAboveWorkspace` / `editorBelowExport` / `downloadTop` / `downloadBottom` 광고 슬롯
- `web-ui/tools/silence-remover/mobile-only.css`, `download.css`, `mobile-only.js` — 모바일 안내·다운로드 페이지 공통 스타일
