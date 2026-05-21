# One-shot agent + web-ui release helper (run from go-agent/ in Admin PowerShell for MSI E2E)
param(
    [string]$Version = "",
    [switch]$SkipMsiE2E,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$GoAgent = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $GoAgent
$VersionPy = Join-Path $RepoRoot "agent\version.py"
$ProductWxs = Join-Path $GoAgent "installer\product.wxs"
$MsiOut = Join-Path $GoAgent "dist\itmatzip-agent.msi"

function Read-AgentVersion {
    $raw = Get-Content $VersionPy -Raw
    if ($raw -match 'AGENT_VERSION\s*=\s*"([^"]+)"') { return $Matches[1] }
    throw "AGENT_VERSION not found in $VersionPy"
}

function Read-WixVersion {
    $raw = Get-Content $ProductWxs -Raw
    if ($raw -match 'ProductVersion\s*=\s*"([^"]+)"') { return $Matches[1] }
    throw "ProductVersion not found in $ProductWxs"
}

if (-not $Version) { $Version = Read-AgentVersion }
$wixVer = Read-WixVersion
$wixShort = ($wixVer -replace '\.0$', '')

Write-Host "=== ItMatZip release-once ===" -ForegroundColor Cyan
Write-Host "agent/version.py : $Version"
Write-Host "product.wxs      : $wixVer"

if ($wixShort -ne $Version) {
    throw "Version mismatch: bump agent/version.py ($Version) and installer/product.wxs ($wixVer) to the SAME value (wxs uses x.x.x.0)."
}

if (-not $SkipBuild) {
    Write-Host "`n[1/3] Building MSI..." -ForegroundColor Cyan
    powershell -ExecutionPolicy Bypass -File (Join-Path $GoAgent "installer\build.ps1") -UseEmbeddable
}

if (-not (Test-Path $MsiOut)) {
    throw "MSI missing: $MsiOut"
}
Write-Host "MSI: $MsiOut ($((Get-Item $MsiOut).Length) bytes)" -ForegroundColor Green

if (-not $SkipMsiE2E) {
    Write-Host "`n[2/3] MSI E2E (admin)..." -ForegroundColor Cyan
    powershell -ExecutionPolicy Bypass -File (Join-Path $GoAgent "scripts\msi_e2e_test.ps1")
} else {
    Write-Host "`n[2/3] MSI E2E skipped" -ForegroundColor Yellow
}

Write-Host "`n[3/3] Publish checklist" -ForegroundColor Cyan
Write-Host @"

GitHub Release (tag v$Version):
  Upload: $MsiOut

Manifest (repo root, Admin not required):
  .\publish-agent-release.ps1 -PackageType msi `
    -MsiPath "$MsiOut" `
    -DownloadUrl "https://github.com/infohelpful/itmatzip-platform/releases/download/v$Version/itmatzip-agent.msi" `
    -ReleaseNotes "MSI: CORS fix, auto-start service, FFmpeg prepare, ProgramData bin path"

Web UI (required for Silence Detector FFmpeg /prepare):
  Deploy web-ui/ to silence.itmatzip.com + tools.itmatzip.com
  - web-ui/tools/common/bridge.js
  - web-ui/tools/silence-remover/script.js

User install (one line):
  msiexec /i "$MsiOut" /qn

Verify:
  Get-Service ItMatZipAgent          # Running
  Invoke-RestMethod http://127.0.0.1:19876/health
  # Browser: silence tool -> FFmpeg ready (green)

"@ -ForegroundColor White
