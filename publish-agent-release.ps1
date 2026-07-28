# ItMatZip 에이전트 릴리스 manifest 생성 (exe 또는 MSI)
# MSI 예:
#   cd go-agent
#   powershell -ExecutionPolicy Bypass -File installer/build.ps1 -UseEmbeddable
#   cd ..
#   .\publish-agent-release.ps1 -PackageType msi `
#     -MsiPath "go-agent\dist\itmatzip-agent.msi" `
#     -DownloadUrl "https://github.com/infohelpful/itmatzip-platform/releases/download/v1.0.4/itmatzip-agent.msi"
#
# exe 예 (기존 PyInstaller):
#   .\build-agent.ps1
#   .\publish-agent-release.ps1 -DownloadUrl "https://github.com/.../itmatzip-agent.exe"

param(
    [string]$Version = "",
    [ValidateSet("exe", "msi", "auto")]
    [string]$PackageType = "auto",
    [string]$DownloadUrl = "",
    [string]$MsiPath = "",
    [string]$ExePath = "",
    [string]$ReleaseNotes = "",
    [switch]$Mandatory
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$AgentRoot = Join-Path $Root "agent"
$DefaultExe = Join-Path $AgentRoot "dist\itmatzip-agent.exe"
$DefaultMsi = Join-Path $Root "go-agent\dist\itmatzip-agent.msi"
$ManifestPath = Join-Path $AgentRoot "agent-update-manifest.json"
$VersionFile = Join-Path $AgentRoot "version.py"

if (-not $ExePath) { $ExePath = $DefaultExe }
if (-not $MsiPath) { $MsiPath = $DefaultMsi }

if ($PackageType -eq "auto") {
    if (Test-Path $MsiPath) {
        $PackageType = "msi"
    } elseif (Test-Path $ExePath) {
        $PackageType = "exe"
    } else {
        throw "패키지 없음. MSI($MsiPath) 또는 exe($ExePath)를 먼저 빌드하세요."
    }
}

$artifactPath = if ($PackageType -eq "msi") { $MsiPath } else { $ExePath }
if (-not (Test-Path $artifactPath)) {
    throw "artifact not found: $artifactPath"
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
    $ext = if ($PackageType -eq "msi") { "itmatzip-agent.msi" } else { "itmatzip-agent.exe" }
    Write-Host "GitHub Releases 다운로드 URL을 입력하세요." -ForegroundColor Yellow
    Write-Host "예: https://github.com/infohelpful/itmatzip-platform/releases/download/v$Version/$ext"
    $DownloadUrl = Read-Host "download_url"
}

$hash = Get-FileHash -Path $artifactPath -Algorithm SHA256
$manifest = [ordered]@{
    version       = $Version
    published_at  = (Get-Date -Format "yyyy-MM-dd")
    package_type  = $PackageType
    download_url  = $DownloadUrl.Trim()
    sha256        = $hash.Hash.ToLowerInvariant()
    mandatory     = [bool]$Mandatory
    release_notes = if ($ReleaseNotes) { $ReleaseNotes } else { "ItMatZip Agent $Version" }
}

if ($PackageType -eq "msi") {
    $manifest.msi_download_url = $DownloadUrl.Trim()
    $manifest.msi_sha256 = $hash.Hash.ToLowerInvariant()
}

$json = $manifest | ConvertTo-Json -Depth 4
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($ManifestPath, $json + "`n", $utf8)

# 웹 UI 설치 팝업은 assets 사본을 우선 조회하므로 릴리즈 시 동기화 필수
$WebUiManifestPath = Join-Path $Root "web-ui\tools\assets\agent-update-manifest.json"
$webUiDir = Split-Path $WebUiManifestPath -Parent
if (-not (Test-Path $webUiDir)) {
    New-Item -ItemType Directory -Force -Path $webUiDir | Out-Null
}
[System.IO.File]::WriteAllText($WebUiManifestPath, $json + "`n", $utf8)

# agent-install-ui.js FALLBACK_RELEASE (manifest 전부 실패 시 버튼 문구·URL)
$InstallUiJs = Join-Path $Root "web-ui\tools\common\agent-install-ui.js"
if (Test-Path $InstallUiJs) {
    $js = [System.IO.File]::ReadAllText($InstallUiJs, $utf8)
    $dl = $DownloadUrl.Trim()
    $fallback = @"
const FALLBACK_RELEASE = {
  version: "$Version",
  download_url:
    "$dl",
  package_type: "$PackageType",
};
"@
    $pattern = '(?s)const FALLBACK_RELEASE = \{.*?\};'
    if ($js -notmatch $pattern) {
        Write-Warning "FALLBACK_RELEASE block not found in $InstallUiJs — skipped"
    } else {
        $js2 = [regex]::Replace($js, $pattern, $fallback.TrimEnd())
        [System.IO.File]::WriteAllText($InstallUiJs, $js2, $utf8)
        Write-Host "FALLBACK_RELEASE → v$Version" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "manifest 저장: $ManifestPath" -ForegroundColor Green
Write-Host "web-ui assets: $WebUiManifestPath" -ForegroundColor Green
Write-Host "package_type: $PackageType"
Write-Host "version: $($manifest.version)"
Write-Host "sha256:  $($manifest.sha256)"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1) Upload $artifactPath to GitHub Release v$Version"
Write-Host "  2) git add agent/agent-update-manifest.json web-ui/tools/assets/agent-update-manifest.json web-ui/tools/common/agent-install-ui.js && git commit && git push"
Write-Host "  3) Installed MSI agents poll manifest and auto-upgrade via msiexec"
