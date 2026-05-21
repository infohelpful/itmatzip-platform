# 에이전트 자동 업데이트 (GitHub exe)

설치된 `itmatzip-agent.exe`는 **백그라운드**에서 manifest JSON을 주기적으로 확인하고, 새 버전이 있으면 exe를 받아 **자동으로 교체·재시작**합니다.

## 동작 요약

| 항목 | 내용 |
|------|------|
| 첫 확인 | 실행 후 약 45초 뒤 |
| 이후 주기 | 6시간마다 (환경 변수로 변경 가능) |
| manifest | GitHub `raw` URL 또는 Releases에 올린 JSON |
| 교체 방식 | `%APPDATA%\ItMatZip\updates\` 에 받은 뒤 PowerShell로 exe 스왑 |
| 로그 | `%APPDATA%\ItMatZip\updates\agent-update.log` |

## 배포 절차 (매 버전)

1. `agent/version.py` 의 `AGENT_VERSION` 을 올립니다 (예: `0.2.0`).
2. `.\build-agent.ps1` 로 exe 빌드.
3. GitHub **Releases**에 `itmatzip-agent.exe` 업로드.
4. manifest 생성:

```powershell
.\publish-agent-release.ps1 -Version "0.2.0" `
  -DownloadUrl "https://github.com/<USER>/<REPO>/releases/download/v0.2.0/itmatzip-agent.exe" `
  -ReleaseNotes "버그 수정"
```

5. 생성된 `agent/agent-update-manifest.json` 을 **main 브랜치에 커밋·push**  
   (또는 manifest만 별도 raw URL로 호스팅).

6. `agent/common/update_config.py` 의 `DEFAULT_UPDATE_MANIFEST_URL` 이 실제 manifest 주소와 같아야 합니다.

### manifest 예시

```json
{
  "version": "0.2.0",
  "published_at": "2026-05-15",
  "download_url": "https://github.com/you/repo/releases/download/v0.2.0/itmatzip-agent.exe",
  "sha256": "abc123...",
  "mandatory": false,
  "release_notes": "설명"
}
```

- `version`: `0.1.0` 형식 권장 (숫자 비교).
- `sha256`: `publish-agent-release.ps1` 이 exe 해시를 채웁니다. 비우면 검증 생략(비권장).

## 환경 변수

| 변수 | 설명 |
|------|------|
| `ITMATZIP_UPDATE_MANIFEST_URL` | manifest JSON URL (기본값은 `update_config.py`) |
| `ITMATZIP_DISABLE_AUTO_UPDATE=1` | 자동 확인·적용 끔 |
| `ITMATZIP_UPDATE_INITIAL_DELAY_SEC` | 첫 확인 지연(초), 기본 45 |
| `ITMATZIP_UPDATE_CHECK_INTERVAL_SEC` | 확인 주기(초), 기본 21600 |

## 수동 테스트

```powershell
# manifest만 확인 (개발 모드 python)
python agent\main.py --check-update

# exe에서 확인 후 실제 적용
.\agent\dist\itmatzip-agent.exe --check-update --apply
```

`/health` 응답에 `agent_version`, `update_available`, `remote_version`, `startup_installed` 이 포함됩니다.

## Windows 자동 실행

`itmatzip-agent.exe --install` 시 `%APPDATA%\ItMatZip\itmatzip-agent.exe` 로 복사되고 로그인마다 자동 실행됩니다. 자동 업데이트도 이 경로의 exe를 교체합니다.

## MSI 자동 업데이트 (Go 하이브리드)

**MSI로 설치**(`C:\Program Files\itmatzip-agent\`)한 경우 Go 컨트롤러가 manifest를 확인하고 새 MSI를 `msiexec /qn`으로 적용합니다. (exe 스왑과 별도)

manifest 예시:

```json
{
  "version": "1.0.4",
  "package_type": "msi",
  "download_url": "https://github.com/.../itmatzip-agent.msi",
  "sha256": "...",
  "msi_download_url": "https://github.com/.../itmatzip-agent.msi",
  "msi_sha256": "...",
  "release_notes": "..."
}
```

릴리스:

```powershell
cd go-agent
powershell -ExecutionPolicy Bypass -File installer/build.ps1 -UseEmbeddable
cd ..
.\publish-agent-release.ps1 -PackageType msi -MsiPath go-agent\dist\itmatzip-agent.msi -DownloadUrl "https://github.com/.../itmatzip-agent.msi"
git add agent/agent-update-manifest.json && git commit && git push
```

로그: `C:\ProgramData\itmatzip-agent\updates\agent-update.log`

## 주의

- 업데이트 중에는 에이전트가 **한 번 재시작**됩니다. 분석 중이면 잠시 끊길 수 있습니다.
- exe를 **읽기 전용 폴더**에 두면 교체가 실패할 수 있습니다. 쓰기 가능한 경로에 설치하세요.
- Windows Defender 등이 새 exe 다운로드를 막을 수 있습니다.
