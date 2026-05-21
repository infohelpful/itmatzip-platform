# ItMatZip Agent — 릴리스 전 점검 (1.0.9)

**원칙:** 자잘한 수정마다 버전 올리지 말 것. 1.0.9 MSI 한 번으로 아래 항목이 모두 포함되어야 함.

## 1.0.9에 포함된 수정 (최종 점검 반영)

| 영역 | 내용 |
|------|------|
| WiX | XML 주석 `--` 제거, 설치 후 `--tray`만 실행 |
| FFmpeg | MSI에 **포함 안 함** — `ProgramData\bin`에 첫 사용 시 `ensure_ffmpeg()` 다운로드 |
| Python engine | embeddable **3.14.3** (GitHub v1.0.4 wheel·wheels_gpu cp314와 동일) |
| Vocal Remover | `v1.0.4` wheel 다운로드 · **diffq cp314 wheel은 MSI `engine/vendor-wheels`에 내장** (embeddable은 Python.h 없어 sdist 빌드 불가) |
| pip | `PYTHONNOUSERSITE=1` — 서비스 계정 user-site와 engine site-packages 분리 |
| 트레이 | 「서비스 재시작」= Windows SCM stop/start (HTTP reload는 권한 없을 때만 폴백) |
| 설치/업그레이드 | `installService`가 **이미 설치된 경우에도** `sc sdset` ACL 적용 |
| 트레이 | `sc.exe` 폴링 제거 → SCM API, CMD 깜빡임 제거, `ShellExecute`로 URL |
| 재시작 | `POST /api/agent/service/restart` (localhost), 트레이 「서비스 재시작」 |
| 자동 실행 | HKLM Run·바로가기 → `--tray` (로그인 시 SCM stop 시도 없음) |
| gRPC | reload 시 `Close()` 후 재연결 |

## 릴리스 전 체크리스트

```powershell
cd go-agent
go build -o nul .
go vet ./...
# NEVER -SkipEngine for release MSI (grpc/fastapi need engine\python.exe)
powershell -File installer\build.ps1 -UseEmbeddable
powershell -File scripts\test-tray.ps1   # 선택

# 설치 후
Invoke-RestMethod http://127.0.0.1:19876/health
Invoke-RestMethod http://127.0.0.1:19876/api/tools/silence-remover/readiness
Invoke-RestMethod http://127.0.0.1:19876/api/tools/silence-remover/prepare -Method POST
```

- [ ] MSI 설치 시 검은 콘솔 안 뜸
- [ ] 트레이 「서비스 재시작」 후 `/health` OK
- [ ] tools.itmatzip.com FFmpeg prepare OK (웹 UI도 배포됐는지)

## 버전 파일 (동기화)

- `agent/version.py` → `1.0.9`
- `agent/agent-update-manifest.json` → `1.0.9` + MSI SHA256
- `go-agent/installer/product.wxs` → `1.0.9.0`

## GitHub Release

한 태그 `v1.0.9`에 MSI + manifest만 올리기. 1.0.5~1.0.8은 테스트 빌드로 취급.
