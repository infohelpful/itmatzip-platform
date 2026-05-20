# Vocal Remover 개발 아키텍처 계획

## 1. 목표 요약

`vocal-remover`은 기존 `silence-remover`와 동일한 로컬 에이전트 기반 웹툴 아키텍처를 따릅니다.

- 브라우저 UI는 `vocal remover` 기능 화면 제공
- 로컬 에이전트는 오디오 파일 선택, Demucs 모델 설치/다운로드, 분리 실행
- 최종 결과는 사용자가 원하는 오디오 포맷으로 다운로드

## 2. 전체 구조

```
[브라우저 UI]
   ├─ tools registry
   ├─ vocal-remover page
   ├─ bridge.js 연결+설치 UI
   └─ progress bar / 결과 다운로드
        │
        ▼
[로컬 에이전트 FastAPI]
   ├─ /health
   ├─ /api/tools/vocal-remover/status
   ├─ /api/tools/vocal-remover/prepare
   ├─ /api/tools/vocal-remover/separate
   ├─ /api/tools/vocal-remover/pick-local-file
   └─ Demucs 및 모델 캐시 관리
        │
        ▼
[로컬 디스크]
   ├─ 에이전트 exe
   ├─ %APPDATA%\ItMatZip\bin\ffmpeg.exe
   ├─ %APPDATA%\ItMatZip\vocal-remover\demucs-models\
   └─ %APPDATA%\ItMatZip\vocal-remover\workspace\
```

## 3. UI 레이어 설계

### 3.1. 대시보드 등록

- `web-ui/tools/assets/tools-registry.js`
  - 새 항목 `vocal-remover`
  - `href: "vocal-remover/"`
  - `title`, `subtitle`, `description`, `icon`, `badge`, `tags`

### 3.2. 페이지 구조

- `web-ui/tools/vocal-remover/index.html`
- `web-ui/tools/vocal-remover/style.css`
- `web-ui/tools/vocal-remover/script.js`

### 3.3. UI 요소

- 오디오 파일 경로 입력 + `찾아보기`
- 출력 모드 선택
  - `Instrumental (MR)`
  - `Vocals only`
- 출력 포맷 선택
  - `wav`, `mp3`, `flac`
- 모델 다운로드 / 준비 상태 표시
  - `필수 AI 모델 다운로드 중...`
  - `모델 준비 완료`
  - `에이전트가 설치되어 있지 않습니다`
- 진행률 표시
  - `모델 다운로드 진행률`
  - `분리 처리 진행률`
- 결과 다운로드 버튼

### 3.4. 설치/연결 UX 재사용

- `web-ui/tools/common/bridge.js`
  - 기존 `checkAgentConnection()` 재사용
- `web-ui/tools/common/agent-install-ui.js`
  - 로컬 에이전트 설치 안내 팝업과 동일한 흐름
- 연결 실패 시 `에이전트 다운로드` 모달 표시

## 4. 에이전트 API 설계

### 4.1. 신규 라우터 추가

- `agent/routers/vocal_remover.py`
  - `prefix="/api/tools/vocal-remover"`
  - `tags=["vocal-remover"]`

### 4.2. 주요 엔드포인트

- `GET /api/tools/vocal-remover/status`
  - `agent_installed`, `demucs_installed`, `model_ready`, `supported_formats`
- `POST /api/tools/vocal-remover/pick-local-file`
  - `selection` UI 재사용
- `POST /api/tools/vocal-remover/prepare`
  - Demucs 라이브러리 / 모델 다운로드 시작
- `GET /api/tools/vocal-remover/prepare/status`
  - `phase`: `not_started`, `installing_dependencies`, `downloading_models`, `ready`, `failed`
  - `progress`: 0~100
  - `message`
- `POST /api/tools/vocal-remover/separate`
  - `audio_path`
  - `mode`: `instrumental` | `vocals`
  - `format`: `wav` | `mp3` | `flac`

### 4.3. 내부 검증

- `POST /prepare` 호출 시
  - Demucs 설치 여부 확인
  - 모델 weights 존재 여부 확인
- `POST /separate` 호출 시
  - `audio_path` 접근성 체크
  - `supported_formats` 유효성 검사
  - 준비 중이 아니면 400 에러 반환

## 5. 엔진/백엔드 설계

### 5.1. Demucs 설치 전략

- `agent/engines/vocal_remover.py`
- 두 단계
  1. 런타임 dependency 확보
     - `demucs` Python 패키지
     - `torch` / `torchaudio` 등
  2. 모델 weights 다운로드
     - `demucs` 기본 모델
     - 저장 위치: `%APPDATA%\ItMatZip\vocal-remover\models\`

### 5.2. 모델 다운로드 방식

- HTTP 다운로드 URL 또는 `demucs` 패키지 내 자동 다운로드
- 진행률 추적 필요
- 캐시된 모델이 있으면 즉시 준비 완료

### 5.3. 분리 실행

- `agent/engines/vocal_remover.py`에서 Demucs API 호출
- `vocals` 또는 `instrumental` 모드에 따라 출력 트랙 선택
- `ffmpeg`로 지정 포맷 변환
- 결과 파일을 임시 출력 디렉터리에 생성

### 5.4. 캐시 / 파일 관리

- 모델/weights 디렉터리: `%APPDATA%\ItMatZip\vocal-remover\models\`
- 결과 임시 디렉터리: `%APPDATA%\ItMatZip\vocal-remover\workspace\`
- 오래된 임시 파일 정리

## 6. 진행 상태/로딩 바 설계

### 6.1. UI 쪽
- `agent 연결 확인`
- `모델 준비`
- `모델 다운로드 중`
- `분리 작업 진행 중`

### 6.2. 에이전트 쪽
- `/prepare/status` 반환
  - `phase`
  - `progress`
  - `message`
- `/separate` 내부에서 장기 작업일 경우 상태 API 폴링

## 7. 구현 단계

### 7.1. 준비 단계
1. `tools-registry.js`에 `vocal-remover` 추가
2. `web-ui/tools/vocal-remover/` 폴더와 기본 페이지 템플릿 생성
3. `agent/routers/vocal_remover.py` 라우터 추가
4. `agent/engines/vocal_remover.py` 스켈레톤 구현

### 7.2. 에이전트 연결/설치 UX
1. `bridge.js`로 기본 `health` 체크 재사용
2. `agent-install-ui.js` 설치 화면 재사용
3. 에이전트가 없으면 설치 유도
4. 에이전트가 있어도 Demucs 준비가 안 됐으면 `prepare` 호출

### 7.3. Demucs / 모델 설치 워크플로우
1. `prepare` API로 라이브러리/모델 설치
2. UI에서 `prepare/status` 폴링
3. 완료 후 `ready` 상태로 전환

### 7.4. 분리 서비스 워크플로우
1. 사용자 파일 선택
2. `POST /api/tools/vocal-remover/separate`
3. 분리 결과 생성
4. 브라우저에서 다운로드

### 7.5. 예외/실패 처리
- 에이전트 미실행
- Demucs 설치 실패
- 모델 다운로드 실패
- 분리 작업 중 timeout/오류
- 브라우저 네트워크 권한 차단

## 8. 비기능 요구 사항

### 8.1. 가벼운 에이전트 유지
- `itmatzip-agent.exe` 본체는 Demucs 모델을 포함하지 않음
- 초기 설치는 빠르게 유지
- Demucs는 사용 시점에만 다운로드

### 8.2. 로컬 데이터 보안
- 오디오 파일은 로컬에서만 처리
- 웹 UI는 메타/상태만 주고받음
- 외부 서버 업로드 없음

### 8.3. 배포 고려
- 에이전트 자체는 기존 exe 배포 방식 유지
- `Demucs` 의존성은 에이전트가 실행 중일 때 동적 설치
- 설치 실패 시 사용자에게 명확한 재시도 안내 제공

## 9. 핵심 권장 설계

### A. 기존 `silence-remover` 패턴 재사용
- 로컬 파일 선택 단계
- 에이전트 연결 검사
- `/api/tools/...` 구조
- 설치 팝업 UX

### B. 새로운 `prepare` 단계 추가
- 에이전트가 실행돼도 `Demucs`가 없을 수 있으므로
- `prepare`는 반드시 별도 단계로 둬야 함

### C. 모델 다운로드 진행률을 UI에 노출
- 단순 “로딩 중”보다
- “모델 다운로드 중 34%”처럼 구체적 표시

### D. 에이전트 내부에 `Demucs` 설치/모델 캐시 책임 배치
- UI는 호출과 상태 표시만 담당
- 실제 설치, 다운로드, 분리 실행은 `agent/engines/vocal_remover.py`에서 처리

## 10. 추천 파일/디렉터리 구조

```
web-ui/tools/vocal-remover/
  index.html
  style.css
  script.js

agent/routers/vocal_remover.py
agent/engines/vocal_remover.py
agent/common/vocal_remover_install.py   # optional helper
```

---

이 계획대로 구현하면, `vocal remover`는 `에이전트 설치 → 에이전트 연결 → Demucs/모델 준비 → 분리 실행 → 결과 다운로드`라는 자연스러운 흐름을 갖습니다.
