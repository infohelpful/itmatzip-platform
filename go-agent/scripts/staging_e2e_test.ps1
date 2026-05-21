# Bundled layout E2E (MSI payload without admin install)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Staging = Join-Path $Root "dist\staging"
$Exe = Join-Path $Staging "itmatzip-agent.exe"
$AgentPorts = @(19876, 19877, 19878, 50051, 50151)
$GrpcPort = 50151
$FastAPIPort = 19878

if (-not (Test-Path $Exe)) {
    Write-Host "Staging payload missing, building MSI payload..."
    powershell -ExecutionPolicy Bypass -File (Join-Path $Root "installer\build.ps1") -UseEmbeddable
}

if (-not (Test-Path (Join-Path $Staging "agent\main.py"))) {
    throw "Bundled agent/ not found under $Staging"
}

function Stop-StagingAgent {
    Write-Host "Stopping staging agent and freeing ports..."
    Stop-Service -Name ItMatZipAgent -Force -ErrorAction SilentlyContinue
    Get-Process -Name itmatzip-agent -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    foreach ($port in $AgentPorts) {
        Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
            ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    }
    # gRPC/FastAPI child python can outlive the Go parent after a failed run.
    Get-Process -Name python -ErrorAction SilentlyContinue | ForEach-Object {
        $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
        if ($cmd -match "worker_grpc\.py|uvicorn.*main:app") {
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Seconds 2
}

function Wait-Health($timeoutSec = 90) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod http://127.0.0.1:19876/health -TimeoutSec 3
            if ($health.status -eq "ok") {
                return $health
            }
        } catch {
            Write-Host "waiting: /health not reachable yet"
        }
        Start-Sleep -Seconds 2
    }
    throw "Agent /health did not become ready within ${timeoutSec}s"
}

function Wait-AgentReady($timeoutSec = 120) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $status = Invoke-RestMethod http://127.0.0.1:19876/status -TimeoutSec 5
            $grpcOk = $status.grpc_health -and $status.grpc_health.status -eq "ok"
            $grpcStale = $status.grpc_error -and $status.grpc_error -match "mismatch|stale|not running"
            if ($status.fastapi_ready -and $grpcOk -and -not $grpcStale) {
                return $status
            }
            Write-Host "waiting: fastapi_ready=$($status.fastapi_ready) grpc=$($status.grpc_health.status) grpc_error=$($status.grpc_error)"
        } catch {
            Write-Host "waiting: /status not reachable yet"
        }
        Start-Sleep -Seconds 3
    }
    throw "Agent did not become fully ready within ${timeoutSec}s (need fastapi + grpc)"
}

Stop-StagingAgent

Remove-Item Env:ITMATZIP_AGENT_DEV -ErrorAction SilentlyContinue
Remove-Item Env:ITMATZIP_AGENT_DIR -ErrorAction SilentlyContinue

# Staging/CLI: start tray manually (test-tray.ps1); Windows service does not spawn --tray.
$proc = Start-Process -FilePath $Exe -ArgumentList @("--port=19876", "--grpc-port=$GrpcPort", "--fastapi-port=$FastAPIPort") `
    -WorkingDirectory $Staging -PassThru -WindowStyle Hidden

try {
    $health = Wait-Health 90
    Write-Host "health: $($health | ConvertTo-Json -Compress)"

    $status = Wait-AgentReady 120
    Write-Host "install_root=$($status.install_root)"
    Write-Host "fastapi_ready=$($status.fastapi_ready) grpc_health=$($status.grpc_health.status)"

    if ($status.install_root -ne $Staging) {
        throw "unexpected install_root=$($status.install_root)"
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
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
    Stop-StagingAgent
}
