# Integration test: Go controller + FastAPI sidecar proxy
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$AgentDir = Join-Path (Split-Path -Parent $Root) "agent"
$Exe = Join-Path $Root "itmatzip-agent.exe"

if (-not (Test-Path $Exe)) {
    Push-Location $Root
    go build -o itmatzip-agent.exe .
    Pop-Location
}

$env:ITMATZIP_AGENT_DEV = "1"
$env:ITMATZIP_AGENT_DIR = $AgentDir

Get-Process -Name itmatzip-agent -ErrorAction SilentlyContinue | Stop-Process -Force

$proc = Start-Process -FilePath $Exe -PassThru -WindowStyle Hidden
Start-Sleep 8

try {
    Write-Host "Testing merged /health..."
    $health = Invoke-RestMethod http://127.0.0.1:19876/health
    Write-Host ($health | ConvertTo-Json -Compress)
    if (-not $health.fastapi_ready) { throw "FastAPI sidecar not ready" }

    Write-Host "Testing proxied /api/tools/vocal-remover/status..."
    $status = Invoke-RestMethod http://127.0.0.1:19876/api/tools/vocal-remover/status
    Write-Host ($status | ConvertTo-Json -Compress)

    Write-Host "Testing proxied /api/tools/vocal-remover/readiness..."
    $ready = Invoke-RestMethod http://127.0.0.1:19876/api/tools/vocal-remover/readiness
    Write-Host "readiness ok=$($ready.ok)"

    Write-Host "Proxy integration test passed."
}
finally {
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force
    }
}
