# Background Remover (BiRefNet)

로컬 PC에서 BiRefNet으로 이미지 배경을 제거하고 투명 PNG + 마스크를 생성합니다.

## 구조

| 레이어 | 경로 |
|--------|------|
| UI | `web-ui/tools/background-remover/` |
| API | `agent/routers/background_remover.py` (`/api/tools/background-remover`) |
| 엔진 | `agent/engines/background_remover.py` |
| 런타임 | `agent/engines/birefnet_runtime.py` |
| 추론 runner | `agent/engines/birefnet_runner.py` |
| tool_id | `background-remover` |

## 런타임 경로

- Packages: `%APPDATA%\ItMatZip\engine-runtime\background-remover\Lib\site-packages`
- Data: `%APPDATA%\ItMatZip\background-remover\` (`models/`, `wheels-cache/`, `workspace/`, `hf-home/`)
- Python: MSI `engine\python.exe` (3.12)

## library-hub

Release tag: `background-remover-lib`

| Asset | 용도 |
|-------|------|
| `birefnet-wheels.zip` | CPU wheel 번들 |
| `birefnet-wheels_gpu.zip.001/.002` | GPU(cu128) 분할 zip |
| `birefnet-general-code.zip` | BiRefNet general 코드 |
| `birefnet-general-model.safetensors` | BiRefNet general 가중치 |
| `birefnet-hr-code.zip` | BiRefNet_HR 코드 |
| `birefnet-hr-model.safetensors` | BiRefNet_HR 가중치 |

빌드/업로드:

```powershell
.\go-agent\scripts\build-birefnet-wheels-cp312.ps1 -Phase all
```

## UI 옵션

- 모델: `general`(1024) / `hr`(2048)
- 장치: auto / CUDA / CPU
- 경계 블러 · 알파 임계값 · 긴 변 상한 · CUDA fp16
- 출력: 투명 PNG + 흑백 마스크

## API

| Method | Path | 설명 |
|--------|------|------|
| GET | `/readiness` | 준비 상태 |
| POST | `/prepare` | wheel·모델 설치 |
| GET | `/prepare/status` | 준비 진행률 |
| POST | `/remove` | 배경 제거 시작 |
| GET | `/remove/status` | 작업 진행률 |
| POST | `/workspace/cleanup` | 작업 폴더 정리 |
| GET | `/download` | 결과 파일 |
