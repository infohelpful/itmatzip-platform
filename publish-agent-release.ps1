# ItMatZip 에이전트 릴리스 manifest 생성
# 사용 예:
#   .\build-agent.ps1
#   .\publish-agent-release.ps1 -Version "0.2.0" `
#     -DownloadUrl "https://github.com/<USER>/<REPO>/releases/download/v0.2.0/itmatzip-agent.exe"
#
# GitHub에 exe + 이 스크립트가 만든 agent-update-manifest.json 을 올리면
# 설치된 에이전트가 백그라운드에서 자동으로 확인·업데이트합니다.

param(
    [string]$Version = "",
    [string]$DownloadUrl = "",
    [string]$ReleaseNotes = "",
    [switch]$Mandatory
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$AgentRoot = Join-Path $Root "agent"
$Exe = Join-Path $AgentRoot "dist\itmatzip-agent.exe"
$ManifestPath = Join-Path $AgentRoot "agent-update-manifest.json"
$VersionFile = Join-Path $AgentRoot "version.py"

if (-not (Test-Path $Exe)) {
    throw "exe 없음. 먼저 .\build-agent.ps1 실행"
}

if (-not $Version) {
    if (-not (Test-Path $VersionFile)) { throw "version.py 없음" }
    $vf = Get-Content $VersionFile -Raw
    if ($vf -match 'AGENT_VERSION\s*=\s*"([^"]+)"') {
        $Version = $Matches[1]
    } else {
        throw "version.py 에서 AGENT_VERSION 을 찾을 수 없습니다."
    }
}

if (-not $DownloadUrl) {
    Write-Host "GitHub Releases 다운로드 URL을 입력하세요." -ForegroundColor Yellow
    Write-Host "예: https://github.com/<USER>/<REPO>/releases/download/v$Version/itmatzip-agent.exe"
    $DownloadUrl = Read-Host "download_url"
}

$hash = Get-FileHash -Path $Exe -Algorithm SHA256
$manifest = [ordered]@{
    version       = $Version
    published_at  = (Get-Date -Format "yyyy-MM-dd")
    download_url  = $DownloadUrl.Trim()
    sha256        = $hash.Hash.ToLowerInvariant()
    mandatory     = [bool]$Mandatory
    release_notes = if ($ReleaseNotes) { $ReleaseNotes } else { "ItMatZip Agent $Version" }
}

$json = $manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($ManifestPath, $json + "`n", [System.Text.UTF8Encoding]::new($false))

Write-Host ""
Write-Host "manifest 저장: $ManifestPath" -ForegroundColor Green
Write-Host "version: $($manifest.version)"
Write-Host "sha256:  $($manifest.sha256)"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1) Upload itmatzip-agent.exe to GitHub Release v$Version"
Write-Host "  2) git push agent/agent-update-manifest.json to main"
Write-Host "  3) Check update_config.py DEFAULT_UPDATE_MANIFEST_URL matches raw manifest URL"
