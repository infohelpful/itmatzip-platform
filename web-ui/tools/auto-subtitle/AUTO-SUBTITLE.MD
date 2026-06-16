# Auto Subtitle (ItMatZip)

로컬 영상·오디오 → Faster-Whisper 전사 → SRT/VTT/ASS/TXT·영상 번인·MP3/WAV.

## 첫 사용 안내

- **Whisper AI 모델 약 1.6GB** + FFmpeg — 자막 추출 버튼 시 `POST /prepare`로 PC에 자동 다운로드
- `agent/agent-update-manifest.json` → `tool_hints.auto-subtitle`

## API 요약

| Method | Path |
|--------|------|
| GET | `/readiness` — `model.download_hint_mb`, `runtime.job_busy` |
| POST | `/prepare`, GET `/prepare/status` |
| POST | `/transcribe`, GET `/transcribe/status` |
| POST | `/export`, `/export/sync`, GET `/export/status` |
| POST | `/model/unload` — VRAM 절약 |
| POST | `/project/save`, `/project/load` |
| POST | `/workspace/cleanup` |
| GET | `/download`, `/media/stream` |

파일 선택 (Go 에이전트):

| 용도 | Path |
|------|------|
| 영상·오디오 원본 | `POST /api/agent/pick-local-subtitle-media` |
| 프로젝트 (.autosub) | `POST /api/agent/pick-local-project-file` |
| 자막 폰트 | `POST /api/agent/pick-local-font-file` |
| 워터마크 이미지 | `POST /api/agent/pick-local-image-file` |

CFR 미리보기: `POST /api/tools/auto-subtitle/media/prepare-preview` (pick 응답과 분리)

웹 UI 상수: `web-ui/tools/common/agent-pick-endpoints.js`

## 작업·메모리

- 전사와 보내기는 **동시에 1건**만 실행
- 유휴 **5분** 후 Whisper 모델 자동 언로드 (환경 변수 `ITMATZIP_WHISPER_UNLOAD_IDLE_SEC`)

## 배포

1. `deploy-agent-py.ps1` 또는 MSI
2. `web-ui/tools/` 배포 (`script.js?v=4`, `style.css?v=4`)
3. `version.py` ↔ `product.wxs` 동기화
