# ItMatZip Silence Remover — 개발 내역

> 무음 구간 분석·EDL 생성 웹 도구 + 로컬 에이전트  
> 최종 갱신: 2026-05-15 · 에이전트 버전 `0.1.0`

---

## 1. 프로젝트 개요

| 구분 | 설명 |
|------|------|
| **웹 UI** | 브라우저에서 영상 경로·옵션 설정 → 무음 분석 → 파형 미리보기 → EDL 다운로드 |
| **로컬 에이전트** | 사용자 PC에서 FFmpeg·파일 선택·분석·EDL 생성 (`127.0.0.1:19876`) |
| **데이터 처리** | 영상·오디오는 **로컬에서만** 처리, 외부 서버 업로드 없음 |
| **배포 URL (예)** | `https://silence.itmatzip.com` (웹) + GitHub Releases (exe) |

---

## 2. 시스템 구조

```
[브라우저 — silence.itmatzip.com 또는 로컬 web-ui]
        │  fetch (CORS + Private Network Access)
        ▼
[로컬 에이전트 — itmatzip-agent.exe / FastAPI :19876]
        │  FFmpeg / ffprobe (%APPDATA%\ItMatZip\bin\)
        ▼
[로컬 영상 파일 · 캐시 · EDL 텍스트]
```

### 주요 디렉터리

```
itmatzip-platform/
├── web-ui/tools/              # 정적 웹 루트 (tools.itmatzip.com)
│   ├── index.html             # 메인 대시보드 (웹툴 메뉴)
│   ├── assets/                # 대시보드 css/js, tools-registry.js
│   ├── common/                # bridge, edl-export, adsense, agent-install-ui
│   └── silence-remover/       # 무음 분석 웹툴
├── agent/                     # Python FastAPI 에이전트 소스
│   ├── main.py
│   ├── routers/silence_remover.py
│   ├── engines/silence_remover.py
│   ├── common/                # bin_manager, auto_update, windows_startup
│   └── version.py
├── build-agent.ps1            # exe 빌드
├── install-agent.ps1          # 로컬 테스트 실행
├── publish-agent-release.ps1  # manifest + sha256 생성
└── README.md                  # 본 문서
```

---

## 3. 웹 UI — Silence Remover (`web-ui/tools/silence-remover/`)

### 3.1 편집 화면 (`index.html` + `script.js`)

| 기능 | 설명 |
|------|------|
| **영상 경로** | 직접 입력 또는 에이전트 **찾아보기**로 로컬 절대 경로 |
| **프로브** | FPS, 볼륨, 추천 무음 민감도 자동 로드 |
| **무음 구간 분석** | 편집 FPS 격자·파형 생성 후 EDL·무음 구간 계산 |
| **파형 미리보기** | 보라색 밴드 = 파형 기준 미리보기 (EDL과 다를 수 있음) |
| **미디어 요약** | 길이, 무음 통계, **현재 설정** 등 |
| **EDL 다운로드** | `download.html`로 이동 (분석 완료 후 활성화) |

#### 연결 상태 UI

- 우측 상단 **에이전트 연결됨 / 끊김**
- FFmpeg 준비 상태
- 미연결 시 **에이전트 설치 팝업** (`agent-install-ui.js` + `bridge.js`)

#### 「현재 설정」 표시 규칙

- **무음 구간 분석** 버튼을 눌렀을 때만 갱신 (옵션만 바꿔도 즉시 반영 안 함)
- 항목별 한 줄, 콜론 형식 예:

  ```
  프레임: 29.97 fps
  무음 민감도: -35dB
  여백: 18ms
  최소 무음: 0.3초
  ```

#### EDL 다운로드 버튼

- 클릭 시 `이동 중…` → `download.html` 이동
- `pageshow` / `resetExportLinkUi()`로 **뒤로가기(bfcache)** 시 버튼 문구 복구

### 3.2 공통 모듈 (`web-ui/tools/common/`)

| 파일 | 역할 |
|------|------|
| `bridge.js` | `127.0.0.1:19876` / `localhost` 폴백, PNA, 연결 모니터, 설치 다이얼로그 |
| `edl-export.js` | sessionStorage 키, 분석 스냅샷, `buildEdlViaAgent`, 저장 (`showSaveFilePicker` / anchor) |
| `agent-install-ui.js` | 설치 안내 HTML, 다운로드 링크 |
| `adsense.js` | 광고 슬롯 (편집·다운로드·설치 팝업) |

### 3.3 sessionStorage 키 (EDL·분석 결과)

`edl-export.js`에서 정의:

- `itmatzip_silence_edl`, `itmatzip_silence_silences`, `itmatzip_silence_vocal_ms`
- `itmatzip_silence_fps`, `itmatzip_silence_fps_rational`, `itmatzip_silence_native_fps_rational`
- `itmatzip_silence_padding_ms`, `itmatzip_silence_min_silence_sec`
- `itmatzip_silence_video_path`, `itmatzip_silence_clip_name`, `itmatzip_silence_duration_sec` 등

---

## 4. EDL 다운로드 페이지 (`download.html` + `download.js`)

### 4.1 플로우

1. 편집 화면에서 **EDL 파일 다운로드** → `download.html` (+ AdSense)
2. 3초 카운트다운 후 자동 시작 (또는 **지금 다운로드**)
3. 에이전트 `POST /api/tools/silence-remover/build-edl` 로 EDL 생성
4. 파일 저장
   - **수동 클릭**: 클릭 직후 `showSaveFilePicker` → 경로 선택 → EDL 생성 → 저장
   - **자동 카운트다운**: 브라우저 기본 다운로드(anchor)
5. **지금 다운로드** 버튼은 완료·취소 후에도 **계속 활성화** (재시도 가능)
6. **편집 화면으로 돌아가기** → `history.back()` (편집 상태 sessionStorage 유지)

### 4.2 가이드·FAQ 카드 (download.css)

- NLE별 EDL 불러오기 (Premiere / Resolve / Final Cut)
- FPS 싱크 주의사항
- 다운로드·에이전트·작업 복원 FAQ
- 페이지 최대 너비 **880px**

---

## 5. 로컬 에이전트 (`agent/`)

### 5.1 실행

| 모드 | 방법 |
|------|------|
| **개발** | `start-agent.ps1` → uvicorn `main:app` :19876 |
| **배포** | `itmatzip-agent.exe` (PyInstaller, 콘솔 없음) |

- 호스트: `127.0.0.1:19876` (`agent/agent_config.py`)
- CORS `allow_origins=["*"]`, **`allow_private_network=True`** (HTTPS 사이트 → localhost 호출)

### 5.2 API 엔드포인트 (`/api/tools/silence-remover/`)

| 메서드 | 경로 | 용도 |
|--------|------|------|
| GET | `/health` | 생존 확인, `agent_version`, 업데이트 상태 |
| GET | `/readiness` | FFmpeg 준비 여부 |
| POST | `/pick-local-file` | 로컬 파일 대화상자 → 절대 경로 |
| POST | `/probe` | 미디어 정보 (FPS, dB 등) |
| POST | `/waveform-peaks` | 파형 peaks 데이터 |
| POST | `/analyze` | 무음 분석 + EDL 초안 |
| POST | `/build-edl` | EDL 최종 생성 (다운로드 페이지) |

### 5.3 FFmpeg

- `%APPDATA%\ItMatZip\bin\ffmpeg.exe`, `ffprobe.exe`
- 최초 필요 시 GitHub 번들 자동 다운로드 (`common/bin_manager.py`)

### 5.4 exe 빌드

```powershell
.\build-agent.ps1
# → agent\dist\itmatzip-agent.exe
```

상세: `agent/BUILD_EXE.md`

---

## 6. Windows 설치 · 자동 실행 (`common/windows_startup.py`)

### 동작 (exe 1회 실행 = 설치)

1. `%APPDATA%\ItMatZip\itmatzip-agent.exe` 로 복사
2. `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 등록
3. 설치 완료 메시지 박스
4. 백그라운드 실행 (콘솔 창 없음, `console=False`)
5. **Windows 로그인마다 자동 실행**
6. 다운로드 폴더에서 실행해도 설치본만 상주

### CLI

| 인자 | 설명 |
|------|------|
| (없음) | 설치 확인 후 서버 기동 |
| `--install` | 수동 설치·등록 |
| `--uninstall` | 자동 실행 해제 + 파일 삭제 |
| `--pick-file` | 파일 선택 서브프로세스 |
| `--check-update` | 업데이트 확인 (`--apply` 시 적용) |

---

## 7. 자동 업데이트 (`common/auto_update.py`)

GitHub **manifest JSON** 기반.

### manifest 예 (`agent/agent-update-manifest.json`)

```json
{
  "version": "0.2.0",
  "download_url": "https://github.com/.../itmatzip-agent.exe",
  "sha256": "...",
  "mandatory": false,
  "release_notes": "..."
}
```

### 동작

- 기동 **45초 후** 첫 확인, 이후 **6시간마다**
- 새 버전 → exe 다운로드 → PowerShell로 교체·재시작
- 로그: `%APPDATA%\ItMatZip\updates\agent-update.log`

### 배포 절차

```powershell
# 1. version.py 의 AGENT_VERSION 수정
.\build-agent.ps1
.\publish-agent-release.ps1 -Version "0.2.0" -DownloadUrl "https://github.com/.../itmatzip-agent.exe"
# 2. exe → GitHub Releases
# 3. agent-update-manifest.json → main 브랜치 push
```

상세: `agent/AGENT_AUTO_UPDATE.md`

### 환경 변수

| 변수 | 설명 |
|------|------|
| `ITMATZIP_UPDATE_MANIFEST_URL` | manifest URL |
| `ITMATZIP_DISABLE_AUTO_UPDATE=1` | 자동 업데이트 끔 |
| `ITMATZIP_UPDATE_INITIAL_DELAY_SEC` | 첫 확인 지연 (기본 45) |
| `ITMATZIP_UPDATE_CHECK_INTERVAL_SEC` | 주기 (기본 21600) |

---

## 8. Git · 배포 정책

### `.gitignore` (저장소 루트)

Git에 **올리지 않음**:

- `.venv-build/`, `__pycache__/`, `*.pyc`
- `agent/build/`, `agent/dist/`
- `*.exe` (Releases 전용)

Git에 **올림**:

- Python 소스, `itmatzip-agent.spec`, `agent-update-manifest.json`
- 웹 UI (`web-ui/`)
- 빌드·배포 스크립트 (`*.ps1`)

### 웹 / exe 배포

| 자산 | 배포 위치 |
|------|-----------|
| 웹 UI | 호스팅 (`silence.itmatzip.com` 등) |
| `itmatzip-agent.exe` | **GitHub Releases** (저장소에 exe 커밋 안 함) |
| manifest JSON | raw URL 또는 Releases |

---

## 9. 해결한 주요 이슈 (개발 과정)

| 이슈 | 원인 | 조치 |
|------|------|------|
| 에이전트 연결 안 됨 / 찾아보기 무반응 | `edl-export.js` export 누락 → `script.js` 전체 로드 실패 | `STORAGE_FPS_*`, `STORAGE_SILENCES_DISPLAY` export 추가 |
| EDL 버튼 `이동 중…` 고정 | bfcache 복귀 시 DOM 유지 | `pageshow` + `resetExportLinkUi()` |
| `showSaveFilePicker` user gesture 오류 | EDL 생성 **후** 저장 대화상자 호출 | 클릭 직후 picker → 생성 → 저장 |
| 저장 대화상자 취소 | — | 지금 다운로드 버튼 유지 + 취소 메시지 |
| HTTPS → localhost 차단 | Private Network Access | 에이전트 `allow_private_network=True` |
| Git에 venv·exe 업로드 | `.gitignore` 없음 | 루트 `.gitignore` + `build/`·`dist/` 추적 해제 |

---

## 10. 검토만 하고 미구현인 항목

| 요청 | 상태 |
|------|------|
| 사이트 접속 시에만 에이전트 실행 | **웹만으로 불가** (브라우저 보안). 프로토콜 핸들러·런처 등 별도 설치 필요 |
| 사이트 종료 시 에이전트 종료 | **미구현**. heartbeat + idle shutdown 으로 가능 (별도 작업) |

---

## 11. 로컬 개발 빠른 시작

```powershell
# 에이전트 (개발 모드)
cd itmatzip-platform
.\start-agent.ps1

# exe 빌드·테스트
.\build-agent.ps1
.\agent\dist\itmatzip-agent.exe   # 첫 실행 = 설치 + 백그라운드

# 웹 UI (정적 서버, 포트 29180 — 8080 과 충돌 방지)
.\serve-tools.ps1
# http://localhost:29180/              ← 메인 대시보드
# http://localhost:29180/silence-remover/
```

---

## 12. 관련 문서

| 파일 | 내용 |
|------|------|
| `agent/BUILD_EXE.md` | exe 빌드 방법 |
| `agent/AGENT_AUTO_UPDATE.md` | 자동 업데이트·manifest |
| `agent/agent-update-manifest.json` | manifest 템플릿 |

---

## 13. 버전

- **에이전트**: `agent/version.py` → `AGENT_VERSION` (현재 `0.1.0`)
- **웹 캐시**: `script.js?v=connrestore6` 등 쿼리로 무효화

배포 시 `version.py`, manifest, GitHub Release 태그를 **함께** 올릴 것.
