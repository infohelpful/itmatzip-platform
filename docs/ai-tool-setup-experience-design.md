# AI 도구 공통 설치 현황 UI 설계

> 상태: 공통 설치 패널 1차 구현 · 작성일: 2026-11-07 · 적용 범위: ItMatZip의 AI 도구 9개

## 1. 목적

사용자가 AI 도구 페이지에 들어오면 로컬 에이전트와 해당 도구의 필수 런타임·모델 상태를 한곳에서 확인한다. 에이전트가 연결되어 있으면 미설치 필수 항목을 즉시 순서대로 준비하고, 현재 작업과 완료된 작업을 같은 UI에서 계속 보여준다. 사이트마다 같은 구성요소와 상태 표현을 쓰되 항목명·의존관계·실행 API는 도구별로 등록한다.

이 문서는 UI와 설치 상태 계약을 정의한다. 실제 설치 동작과 배포는 후속 작업이다.

## 2. 현재 상태와 문제

- 공용 `web-ui/tools/common/bridge.js`가 에이전트 연결을 감시하고, AI 사이트 상당수가 연결 실패 시 설치 팝업을 자동으로 연다. AutoSubtitle의 `site-glue.js`는 진입 시 연결 확인과 모니터를 각각 시작한다.
- AutoSubtitle은 `App.tsx`에서 필수 엔진 시작 게이트, 진행 팝업, 설치 후 GPU 안내를 따로 보여준다. 정밀 정렬은 `AlignmentRuntimeControl.tsx`가 별도 팝업으로 관리한다.
- AutoSubtitle의 `/deps/prepare` 응답에는 `percent`와 `step`이 있지만 웹 어댑터는 `percent`만 전달한다. FFmpeg·모델의 개별 바이트 수는 현 계약에 없다. 화면의 88%/99.5% 경계는 실제 단계가 아니라 퍼센트 추정이다.
- 다른 AI 도구도 대체로 `/readiness`, `/prepare`, `/prepare/status`를 가지지만 응답 필드와 설치 UI가 제각각이다. Silence Detector의 `/prepare`는 동기 호출이어서 장시간 설치의 중간 상태를 다시 조회할 수 없다.
- 브라우저에서 MSI를 내려받을 수는 있지만 실행·설치를 조용히 완료하거나 그 MSI의 실제 설치 퍼센트를 읽을 수는 없다. 따라서 에이전트 설치 행은 수동 단계와 자동 연결 확인을 명확히 구분해야 한다.

## 3. 적용 대상

기준은 `web-ui/tools/assets/tools-registry.js`에서 현재 `available: true`, `badge: "AI"`인 도구다. 허브 설명이나 배지 변경만으로 설치 대상을 자동 추론하지 않고, 아래 도구 ID를 공용 설치 레지스트리에 명시한다.

| 도구 | 레지스트리 ID / 화면 경로 | 필수 준비 항목의 표시 예 | 현 상태 API |
| --- | --- | --- | --- |
| Silence Detector | `silence-remover` | 실행 환경, FFmpeg·ffprobe | `/api/tools/silence-remover/readiness`, `/prepare` |
| AutoSubtitle | `auto-subtitle` | 실행 패키지, FFmpeg, Whisper 모델 | `/api/tools/auto-subtitle/v2/deps`, `/deps/prepare` |
| Vocal Remover | `vocal-remover` | 실행 패키지, Demucs 모델 | `/api/tools/vocal-remover/readiness`, `/prepare/status` |
| Image Enhancer | `image-enhancer` | PyTorch·CodeFormer, 복원 모델 | `/api/tools/image-enhancer/readiness`, `/prepare/status` |
| Background Remover | `background-remover` | PyTorch·BiRefNet, 배경 제거 모델 | `/api/tools/background-remover/readiness`, `/prepare/status` |
| Create Music | `create-music` | ACE-Step 실행 환경과 모델 | `/api/tools/create-music/readiness`, `/prepare/status` |
| MagicEraser | `magic-eraser` | LaMa 실행 환경과 모델 | `/api/tools/magic-eraser/readiness`, `/prepare/status` |
| Voice Changer | `voice-changer` | Seed-VC 실행 환경과 모델 | `/api/tools/voice-changer/readiness`, `/prepare/status` |
| Fixed Area Remover | `watermark-remover` / `fixed-area-remover/` | ProPainter 실행 환경과 모델 | `/api/tools/watermark-remover/readiness`, `/prepare/status` |

도구별 정확한 항목명·크기·공유 파일 여부는 해당 설치 코드와 모델 목록을 대조해 레지스트리에 확정한다. 예를 들어 AutoSubtitle의 GPU 런타임과 정밀 정렬 모델은 기본 자막 추출에 필수가 아니므로 선택 항목이다. 다른 도구의 GPU 필수 여부도 하드웨어와 CPU 지원 상태를 조회해 결정한다. AI가 없는 `audio-join`, `thumbnail-grabber` 등은 이번 적용 대상이 아니다.

## 4. 사용자 흐름

1. 페이지의 공용 설치 영역을 즉시 렌더링하고 `상태 확인 중`을 표시한다. 네트워크 응답 전에 설치 필요나 0%를 단정하지 않는다.
2. 에이전트 `/health`와 현재 도구의 빠른 준비 상태를 확인한다. 에이전트가 연결되지 않으면 공용 설치 영역의 첫 행에 설치 파일 다운로드, 실행 안내, `연결 다시 확인`을 보여준다. 브라우저의 로컬 네트워크 접근 차단과 구버전은 `미설치`와 다른 원인으로 보여준다.
3. 에이전트와 API가 준비되면 이미 설치된 필수 항목을 완료로 표시한다. 빠진 필수 항목은 별도 시작 버튼이나 확인 팝업 없이 설치 작업을 시작한다. 기존 작업이 진행 중이면 새 작업을 만들지 않고 그 상태에 붙는다.
4. 필수 항목의 순서와 현재 단계가 한 화면에서 바뀐다. 다운로드가 끝나면 검증·압축 해제·설치를 각각 실제 상태에 따라 표시한다. 완료 검증 후 편집·처리 버튼을 사용할 수 있다.
5. GPU 가속, 고정밀 모델 등 선택 항목은 필수 준비 완료 뒤 같은 영역 아래에 `선택 설치`로 표시한다. 자동 다운로드하지 않는다. 해당 기능을 누르면 그 항목의 설치를 시작하거나 기존 작업에 붙는다.
6. 페이지 이동·새로고침·다른 탭에서 복귀하면 서버의 작업 상태와 실제 설치 상태를 다시 조회해 진행 중인 작업에 붙는다. 설치가 끝나면 작은 상태 표시로 접되, 클릭하면 전체 목록을 다시 연다.

### 화면 구조

```
AutoSubtitle 준비                                  2 / 4 완료
✓ 로컬 에이전트                                    연결됨
✓ 실행 패키지·FFmpeg                               준비됨
↓ Whisper 음성 인식 모델                           680 MB / 1.6 GB · 42%
  [진행 막대]  다운로드 중
○ 설치 검증                                        대기 중

선택 설치  GPU 가속 · 정밀 정렬                    [설치]
```

표시 공간이 좁으면 제목·현재 단계·진행률만 남기고 상세 항목을 펼칠 수 있게 한다. 모바일에서도 화면을 덮는 자동 모달을 쓰지 않는다. 설치 실패나 사용자의 조치가 필요한 경우에만 해당 행을 강조하고 필요한 버튼을 배치한다. 기존 연결 점과 상태 배너는 공용 영역의 축약 상태와 연결해 중복 안내를 없앤다.

## 5. 공용 UI 계약

### 항목 상태

`checking`, `not_installed`, `waiting`, `downloading`, `installing`, `verifying`, `ready`, `failed`, `blocked`, `optional`, `skipped`를 공통 상태로 사용한다. `blocked`는 이전 필수 항목 실패, 에이전트 연결·권한 문제 등으로 실행할 수 없는 경우다. `ready`는 설치 명령의 성공 응답만으로 판정하지 않고 설치 후 준비 상태 조회로 확인한다.

각 행은 안정적인 `itemId`, 이름, 필수/선택 구분, 현재 상태, 작업 단계, 간단한 설명, 재시도 가능 여부를 가진다. 진행률은 `bytesDone`과 `bytesTotal`이 있을 때 실제 다운로드 바이트로 표시한다. 전체 퍼센트만 있으면 `전체 준비 42%`로 표시하며 모델 자체의 42%라고 쓰지 않는다. 총량을 알 수 없으면 퍼센트 대신 다운로드된 바이트와 활동 중 표시를 쓴다. ETA는 충분한 측정치가 있을 때만 보조 정보로 표시한다.

진행 막대는 `role=progressbar`와 항목명·현재 단계를 제공하고, 단계 변경은 `aria-live=polite`로 알린다. 잦은 바이트 업데이트를 모두 낭독하지 않는다. 키보드로 펼치기, 설치, 재시도, 연결 다시 확인을 사용할 수 있어야 한다.

### 도구 등록 정보

공용 레지스트리의 도구 정의에는 `toolId`, 화면 경로, 표시 이름, 상태 어댑터, 설치 시작 함수, 상태 폴링 함수, 필수 항목 순서, 선택 항목과 활성 조건을 둔다. 페이지는 `toolId`만 넘겨 동일한 설치 컴포넌트를 초기화한다. AutoSubtitle의 React 화면에는 같은 상태 모델을 React 래퍼로 연결하고, 일반 HTML 도구에는 DOM 래퍼를 쓴다. 스타일과 상태 문구는 공용 자산 하나에서 관리한다.

에이전트 상태는 모든 도구가 공유한다. 모델·런타임 항목은 `toolId`별로 구분하되 실제 FFmpeg처럼 공유되는 자원은 동일한 `resourceId`로 표현한다. 공유 자원의 설치 완료·진행 중 상태는 다른 도구에서도 다시 확인해 반영한다.

## 6. 설치 상태 API 계약

초기 구현은 기존 도구 API를 공용 프런트엔드 어댑터가 정규화한다. 필요한 정보가 없는 도구부터 백엔드 응답을 확장한다. 도구별 기존 `/prepare` 경로를 당장 통합 경로로 바꾸지는 않는다.

```json
{
  "toolId": "auto-subtitle",
  "jobId": "stable-server-job-id",
  "state": "running",
  "items": [
    {
      "itemId": "whisper-model",
      "resourceId": "auto-subtitle/whisper-model",
      "required": true,
      "state": "downloading",
      "stage": "모델 다운로드",
      "bytesDone": 713031680,
      "bytesTotal": 1717986918,
      "percent": 41.5,
      "errorCode": null,
      "message": null
    }
  ],
  "updatedAt": "2026-11-07T00:00:00Z"
}
```

- `POST prepare`는 새 작업을 시작하거나 이미 실행 중인 작업의 식별자와 상태를 반환한다. 같은 도구·자원에 대한 중복 호출은 기존 작업에 붙게 한다. AutoSubtitle의 현재 `409 이미 준비 중` 처리도 이 규칙으로 조정한다.
- `GET prepare/status`는 페이지를 새로 열어도 조회 가능해야 한다. 작업이 끝난 뒤에도 설치 완료 여부는 별도 readiness 검사로 확인한다. 서버 프로세스가 재시작돼 진행 기록이 사라진 경우 `checking`에서 실제 파일 상태를 재검사하고, 미완료 파일을 안전하게 정리하거나 재개한다.
- 다운로드 콜백이 제공하는 바이트 수를 각 항목에 보존한다. 파일 크기를 모르면 `bytesTotal: null`, 진행률을 모르면 `percent: null`이다. 100%는 해당 단계의 완료를 뜻하며 설치 전체 완료로 오해하지 않도록 단계 상태와 분리한다.
- 오류에는 화면에 표시할 안전한 메시지와 분기용 `errorCode`를 둔다. 내부 경로, 긴 설치 로그, 토큰, 외부 응답 전문은 기본 화면에 노출하지 않는다. 상세 로그는 사용자가 요청할 때만 제공한다.
- 폴링은 작업 중 0.5~1초, 대기·연결 재시도 시 점진적으로 느리게 한다. 페이지가 숨겨지면 표시 갱신 빈도를 낮추되 서버 설치 작업은 유지한다. 에이전트가 작업 중 잠깐 응답하지 않는 경우 즉시 `미설치`로 되돌리지 않는다.

## 7. 자동 시작과 중복 작업 규칙

필수 설치는 연결·호환 버전·API 준비 확인 직후 시작한다. 설치 가능 여부를 빠르게 조회하고 이미 준비된 항목은 건너뛴다. 한 도구 안의 의존 항목은 선언된 순서대로 실행한다. 에이전트와 FFmpeg 같은 공유 자원은 서버 측 잠금과 상태 조회로 중복 설치를 막는다. 두 탭 또는 두 AI 사이트를 동시에 열어도 같은 자원을 별도로 받지 않는다.

선택 항목, GPU 가속, 고정밀 정렬, 사용자가 고르는 추가 모델은 사용자가 해당 기능을 선택할 때만 시작한다. 하드웨어 조건이 충족되지 않으면 `사용 불가` 이유를 표시하고 필수 준비의 실패로 취급하지 않는다. 사용자 설정이 필요한 항목은 자동으로 다음 단계까지 진행하되 조치가 필요한 지점에서만 멈춘다.

에이전트 MSI는 다운로드 버튼과 실행 안내를 제공하고, 설치 후 `/health`가 살아나면 자동으로 다음 필수 단계로 이동한다. 브라우저가 MSI 설치 진행률을 모르는 동안에는 가짜 진행 막대를 표시하지 않는다. 로컬 네트워크 차단, 에이전트 미실행, 구버전, API 기동 중을 분리해 안내한다.

## 8. 도구별 이행 사항

1. 공용 상태 모델·패널·레지스트리를 만든 뒤 AutoSubtitle을 첫 적용 사례로 연결한다. 현재 `site-glue.js`의 자동 설치 모달과 `App.tsx`의 엔진 게이트·진행 모달·후속 GPU 모달은 공용 영역으로 합친다. `/deps/prepare`의 `step`을 웹까지 전달하고, 모델 다운로드 바이트를 수집한다. 정밀 정렬 상태와 GPU 설치 상태도 선택 행으로 연결한다.
2. `/prepare/status`가 있는 Vocal Remover, Image Enhancer, Background Remover, Create Music, MagicEraser, Voice Changer, Fixed Area Remover를 기존 API 어댑터로 연결한다. 각 도구에서 기존 자동 연결 모달과 별도 설치 진행 UI의 중복 렌더링을 제거한다. 필요한 도구부터 항목별 바이트 정보를 추가한다.
3. Silence Detector는 동기 `/prepare`를 백그라운드 작업과 상태 조회로 전환한 뒤 연결한다. FFmpeg만 필요한 경우 UI에는 `AI 모델 다운로드` 행을 만들지 않는다.
4. 배포 중 구버전 에이전트가 새 상태 계약을 지원하지 않으면 기존 상태 API로 가능한 정보만 표시하고, 필요한 버전에서는 에이전트 업데이트 행을 보여준다. 공용 UI 배포와 에이전트 API 배포 순서를 버전 호환성 테스트로 고정한다.

## 9. 검증 기준

- AI 도구 9개에 같은 패널·상태 용어·재시도 위치가 보이며, 도구별 항목만 다르다.
- 에이전트가 이미 설치된 첫 방문에서 추가 클릭 없이 필수 준비가 시작된다. 설치된 항목은 재다운로드되지 않는다.
- 에이전트가 없을 때 MSI 다운로드·수동 실행·연결 확인 과정이 한 패널에서 이어진다. 브라우저가 알 수 없는 설치 퍼센트는 표시하지 않는다.
- 새로고침, 다른 탭, 다른 AI 도구 이동 후에도 진행 중인 작업을 중복 시작하지 않고 현재 상태를 다시 표시한다.
- 실제 바이트 정보를 제공하는 모델은 받은 용량/전체 용량과 모델별 진행률을 보인다. 제공하지 않는 모델에는 전체 준비율 또는 단계명만 정확히 표시한다.
- 설치 실패 시 실패 항목과 원인·재시도가 같은 자리에 남고, 이미 완료된 항목은 유지된다. 선택 항목 실패는 기본 기능을 막지 않는다.
- 로컬 네트워크 차단, 에이전트 구버전, 설치 중 API 일시 지연이 각각 올바른 상태로 표시된다. 설치 패널의 키보드 조작과 상태 알림을 확인한다.

## 10. 변경 예상 위치

- 웹 공용: `web-ui/tools/common/bridge.js`, `agent-install-ui.js`, 신규 설치 상태·패널 모듈과 CSS
- AutoSubtitle: `web-ui/tools/auto-subtitle/site-glue.js`, `web-src/auto-subtitle/src/renderer/src/App.tsx`, `platform/webApi.ts`, `platform/AlignmentRuntimeControl.tsx`
- 에이전트: `agent/routers/autosub.py`, `agent/engines/autosub/service.py` 및 나머지 AI 도구의 `agent/routers/*.py`와 준비 작업 구현
- 도구별 UI: 각 AI 도구의 `web-ui/tools/<tool>/script.js`와 페이지 연결부

구현 시에는 실제 API 응답 형식과 설치 함수의 잠금·재시작 동작을 도구마다 확인한 뒤 순차 적용한다. 이 문서의 화면 예시 수치는 설명용이며 실제 모델 크기나 다운로드 성능을 보장하지 않는다.
