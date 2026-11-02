# Auto Subtitle (web)

데스크톱 AutoSubtitle(Electron)을 웹 도구로 옮긴 소스입니다. 화면은 데스크톱 렌더러를 그대로 쓰고,
Electron이 하던 일은 로컬 에이전트가 합니다.

| 위치 | 역할 |
|------|------|
| `src/renderer/src`, `src/shared` | 데스크톱 `src/renderer/src`, `src/shared` 복사본 (기준: `infohelpful/1.-AutoSubtitle@5379aa6`) |
| `src/renderer/src/platform/` | 웹 전용. `window.api`를 에이전트 HTTP·브라우저 파일 대화상자로 구현 |
| `../../web-ui/tools/auto-subtitle/app/` | 빌드 결과물 (`npm run build`). 페이지(`index.html`)는 손으로 관리 |
| `../../agent/engines/autosub/` | 에이전트 엔진. `sidecar/`는 데스크톱 `python_sidecar` 복사본 |
| `../../agent/routers/autosub.py` | `/api/tools/auto-subtitle/v2/*` |

## 개발

```powershell
cd web-src/auto-subtitle
npm install
npm run build        # web-ui/tools/auto-subtitle/app 갱신
npm test
```

에이전트 FastAPI를 설치본과 따로 띄워 시험할 때는 다른 포트로 실행하고 페이지에 `?agentApi=`를 붙입니다
(값은 localStorage에 남고, `?agentApi=`를 비워 주면 지워집니다).

```powershell
cd agent
python -m uvicorn main:app --port 19887
# http://127.0.0.1:29180/auto-subtitle/?agentApi=http://127.0.0.1:19887
```

| 환경 변수 | 용도 |
|-----------|------|
| `ITMATZIP_AUTOSUB_PYTHON` | 사이드카 실행 Python (기본: 에이전트 Python) |
| `ITMATZIP_AUTOSUB_MODELS_DIR` | Whisper 모델 폴더 (기본: `<agent data>/auto-subtitle/models`) |
| `ITMATZIP_AUTOSUB_ALIGN_PYTHON` | WhisperX 정렬 Python 직접 지정 (기본: 설치한 정렬 런타임) |
| `ITMATZIP_AUTOSUB_ALIGN_RUNTIME` | 정렬 런타임 폴더 (기본: `%APPDATA%\ItMatZip\engine-runtime\auto-subtitle-align`) |
| `ITMATZIP_AUTOSUB_ALIGN_BASE_PYTHON` | 정렬 런타임을 만들 기준 Python (기본: 에이전트 Python) |
| `AUTOSUBTITLE_AUDIOWAVEFORM_PATH` | audiowaveform.exe 직접 지정 (기본: 에이전트 bin에 자동 설치) |

## 정밀 정렬 (WhisperX)

필수 엔진(Whisper 1.6GB)과 따로, 화면 위쪽 「정밀 정렬 설치」로 처음 한 번 설치합니다.

- 설치본 에이전트의 embeddable Python은 PYTHONPATH를 무시하고 venv도 없어서, 인터프리터 파일을 정렬 런타임 폴더로
  복사해 따로 씁니다. 패키지는 `sidecar/requirements-alignment-cpu-win.lock.txt` 고정 버전(torch 2.8.0+cpu)입니다.
- 설치 후 `torch/lib/*.lib`(빌드 전용, 약 2.6GB)를 지웁니다. 런타임 약 1.4GB.
- 모델은 `kresnik/wav2vec2-large-xlsr-korean`의 `model.safetensors`와 JSON만 받습니다(약 1.27GB).
- audiowaveform은 BBC 공식 릴리스 1.10.2 win64 zip을 해시 확인 후 에이전트 bin에 둡니다(GPL-3.0, 별도 실행 파일).

## 데스크톱과 다른 점

- 영상은 에이전트 파일 선택 창으로 고릅니다. 브라우저는 끌어다 놓은 파일의 경로를 알려 주지 않습니다.
- 프로젝트·자막 파일은 브라우저 저장/열기 창을 씁니다. "저장"은 이번 세션에 열었거나 저장한 파일에만 덮어씁니다.
- 정밀 정렬은 필수 엔진에 들어 있지 않고, 처음 쓸 때 따로 설치합니다.
- 자막 입힌 영상·MP3/WAV는 에이전트 폴더 선택 창으로 저장 위치를 고르면 `<영상 이름>_AutoSubtitle.<확장자>`로 저장합니다
  (같은 이름이 있으면 ` (2)`를 붙이고, 원본은 덮어쓰지 않습니다).
- 자막 입힌 영상: 데스크톱은 오프스크린 창을 캡처했지만, 웹은 같은 `ExportSubtitleFrame` 마크업을 SVG foreignObject로
  그려 상태마다 PNG 한 장을 올립니다. 에이전트가 이를 데스크톱과 같은 단일 패스(FFmpeg rawvideo 오버레이)로 합성합니다.
