# Bundled layout E2E (MSI payload without admin install)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Staging = Join-Path $Root "dist\staging"
$Exe = Join-Path $Staging "itmatzip-agent.exe"

if (-not (Test-Path $Exe)) {
    Write-Host "Staging payload missing, building MSI payload..."
    powershell -ExecutionPolicy Bypass -File (Join-Path $Root "installer\build.ps1") -UseEmbeddable
}

if (-not (Test-Path (Join-Path $Staging "agent\main.py"))) {
    throw "Bundled agent/ not found under $Staging"
}

Get-Process -Name itmatzip-agent -ErrorAction SilentlyContinue | Stop-Process -Force
foreach ($port in 19876, 19877, 50051) {
    Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 1

Remove-Item Env:ITMATZIP_AGENT_DEV -ErrorAction SilentlyContinue
Remove-Item Env:ITMATZIP_AGENT_DIR -ErrorAction SilentlyContinue

$proc = Start-Process -FilePath $Exe -ArgumentList @("--port=19876", "--grpc-port=50051") `
    -WorkingDirectory $Staging -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 12

try {
    $health = Invoke-RestMethod http://127.0.0.1:19876/health -TimeoutSec 5
    Write-Host "health: $($health | ConvertTo-Json -Compress)"

    $status = Invoke-RestMethod http://127.0.0.1:19876/status -TimeoutSec 10
    Write-Host "install_root=$($status.install_root)"
    Write-Host "fastapi_ready=$($status.fastapi_ready) grpc_health=$($status.grpc_health.status)"

    if ($status.install_root -ne $Staging) {
        throw "unexpected install_root=$($status.install_root)"
    }
    if (-not $status.grpc_health -or $status.grpc_health.status -ne "ok") {
        throw "grpc worker not healthy: $($status.grpc_error)"
    }
    if (-not $status.fastapi_ready) {
        throw "FastAPI sidecar not ready"
    }

    $vr = Invoke-RestMethod http://127.0.0.1:19876/api/tools/vocal-remover/status -TimeoutSec 10
    Write-Host "vocal-remover: $($vr | ConvertTo-Json -Compress)"

    Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19876/install-model `
        -Body '{"model_id":"staging-e2e","url":"https://httpbin.org/bytes/256"}' `
        -ContentType application/json | Out-Null
    Start-Sleep -Seconds 8

    $infer = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19876/inference `
        -Body '{"model_id":"staging-e2e","input":"staging-test"}' `
        -ContentType application/json
    Write-Host "inference: $($infer | ConvertTo-Json -Compress)"
    if ($infer.status -ne "ok") {
        throw "inference failed: $($infer.status)"
    }

    Write-Host "Staging E2E test passed."
}
finally {
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force
    }
}
