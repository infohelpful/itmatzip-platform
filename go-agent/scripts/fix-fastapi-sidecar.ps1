# FastAPI sidecar fix: embedded python ignores PYTHONPATH.
# Option A) deploy new itmatzip-agent.exe (includes --app-dir)
# Option B) add .pth so import main works until exe is updated
param(
    [string]$InstallDir = "C:\Program Files\itmatzip-agent",
    [switch]$SkipServiceRestart
)

$ErrorActionPreference = "Stop"
$GoAgentRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $GoAgentRoot
$ExeSrc = Join-Path $GoAgentRoot "dist\itmatzip-agent.exe"
$ExeDst = Join-Path $InstallDir "itmatzip-agent.exe"
$AgentDir = Join-Path $InstallDir "agent"
$SitePackages = Join-Path $InstallDir "engine\Lib\site-packages"
$PthFile = Join-Path $SitePackages "itmatzip_agent.pth"

function Stop-ItMatZipAgent {
    Stop-Service ItMatZipAgent -Force -ErrorAction SilentlyContinue
    Get-Process itmatzip-agent -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
}

Write-Host "Stopping ItMatZipAgent..." -ForegroundColor Cyan
Stop-ItMatZipAgent

if (Test-Path $ExeSrc) {
    Write-Host "Copying $ExeSrc -> $ExeDst" -ForegroundColor Cyan
    Copy-Item -LiteralPath $ExeSrc -Destination $ExeDst -Force
} else {
    Write-Warning "Built exe not found: $ExeSrc (build go-agent first). Applying .pth fallback only."
}

if (-not (Test-Path $AgentDir)) {
    throw "agent folder missing: $AgentDir"
}
if (-not (Test-Path $SitePackages)) {
    throw "site-packages missing: $SitePackages"
}

Set-Content -LiteralPath $PthFile -Value $AgentDir -Encoding ascii -NoNewline
Write-Host "Wrote $PthFile" -ForegroundColor Green

if (-not $SkipServiceRestart) {
    Write-Host "Starting ItMatZipAgent..." -ForegroundColor Cyan
    Start-Service ItMatZipAgent
    Start-Sleep -Seconds 5
    $h = Invoke-RestMethod "http://127.0.0.1:19876/health" -TimeoutSec 10
    Write-Host ($h | ConvertTo-Json -Compress) -ForegroundColor Green
    if (-not $h.fastapi_ready) {
        Write-Warning "fastapi_ready is still false — check C:\ProgramData\itmatzip-agent\logs\service.log"
    }
}
