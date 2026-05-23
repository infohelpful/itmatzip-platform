# Web UI ↔ Go agent integration test (mirrors vocal-remover bridge.js flows)
param(
    [switch]$SkipPrepare,
    [switch]$SkipSeparation
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $Root
$AgentDir = Join-Path $RepoRoot "agent"
$Exe = Join-Path $Root "itmatzip-agent.exe"
$Origin = "http://127.0.0.1:19876"
$WsUrl = "ws://127.0.0.1:19876/ws"

function Ensure-AgentExe {
    if (-not (Test-Path $Exe)) {
        Push-Location $Root
        go build -o itmatzip-agent.exe .
        Pop-Location
    }
}

function Stop-Agent {
    Get-Process -Name itmatzip-agent -ErrorAction SilentlyContinue | Stop-Process -Force
    foreach ($port in 19876, 19877, 50051) {
        Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
            ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Seconds 1
}

function Wait-Health {
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
        try {
            $h = Invoke-RestMethod "$Origin/health" -TimeoutSec 3
            if ($h.status -eq "ok") { return $h }
        } catch {}
        Start-Sleep -Seconds 1
    }
    throw "Agent /health timeout"
}

function Test-WebSocket {
    try {
        Invoke-WebRequest -Uri "$Origin/ws" -TimeoutSec 3 -UseBasicParsing | Out-Null
        throw "Expected /ws to reject plain HTTP"
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp -or [int]$resp.StatusCode -ne 400) {
            throw "WebSocket endpoint check failed: $_"
        }
    }
    Write-Host "WebSocket endpoint OK (/ws rejects non-upgrade HTTP)"
}

Ensure-AgentExe
Stop-Agent

$env:ITMATZIP_AGENT_DEV = "1"
$env:ITMATZIP_AGENT_DIR = $AgentDir

$proc = Start-Process -FilePath $Exe -ArgumentList @("--port=19876", "--grpc-port=50051") `
    -WorkingDirectory $Root -PassThru -WindowStyle Hidden

try {
    $health = Wait-Health
    Write-Host "health: $($health | ConvertTo-Json -Compress)"

    $status = Invoke-RestMethod "$Origin/status"
    if (-not $status.grpc_health -or $status.grpc_health.status -ne "ok") {
        throw "gRPC unhealthy: $($status.grpc_error)"
    }
    if (-not $status.fastapi_ready) {
        throw "FastAPI sidecar not ready"
    }
    Write-Host "status OK (fastapi + grpc)"

    Test-WebSocket

    $vrStatus = Invoke-RestMethod "$Origin/api/tools/vocal-remover/status"
    Write-Host "vocal-remover/status: $($vrStatus | ConvertTo-Json -Compress)"
    if (-not $vrStatus.ok) { throw "vocal-remover status not ok" }

    $asReadiness = Invoke-RestMethod "$Origin/api/tools/auto-subtitle/readiness"
    Write-Host "auto-subtitle/readiness: $($asReadiness | ConvertTo-Json -Compress)"
    if (-not $asReadiness.ok) { throw "auto-subtitle readiness not ok" }

    $asExport = Invoke-RestMethod "$Origin/api/tools/auto-subtitle/export/status"
    Write-Host "auto-subtitle/export/status: phase=$($asExport.phase)"

    $readiness = Invoke-RestMethod "$Origin/api/tools/vocal-remover/readiness"
    Write-Host "vocal-remover/readiness: demucs=$($readiness.demucs_installed) ffmpeg=$($readiness.ffmpeg_installed)"

    if (-not $SkipPrepare -and -not $readiness.demucs_installed) {
        Write-Host "Starting prepare (Demucs wheels) — may take several minutes..."
        Invoke-RestMethod -Method Post -Uri "$Origin/api/tools/vocal-remover/prepare" | Out-Null
        $deadline = (Get-Date).AddMinutes(20)
        while ((Get-Date) -lt $deadline) {
            $ps = Invoke-RestMethod "$Origin/api/tools/vocal-remover/prepare/status"
            Write-Host "prepare: phase=$($ps.phase) progress=$($ps.progress)"
            if ($ps.phase -eq "ready") { break }
            if ($ps.phase -eq "failed") { throw "prepare failed: $($ps.message)" }
            Start-Sleep -Seconds 5
        }
        if ($ps.phase -ne "ready") { throw "prepare timeout" }
    }

    if (-not $SkipSeparation) {
        $testWav = Join-Path $AgentDir "test_input.wav"
        if (-not (Test-Path $testWav)) {
            Write-Host "Skip separation: test_input.wav not found at $testWav"
        } elseif (-not (Invoke-RestMethod "$Origin/api/tools/vocal-remover/readiness").demucs_installed) {
            Write-Host "Skip separation: demucs not installed (use without -SkipPrepare)"
        } else {
            Write-Host "Running separation via FastAPI (same path as web UI)..."
            $sepBody = @{ audio_path = $testWav; format = "wav"; device = "cpu" } | ConvertTo-Json
            Invoke-RestMethod -Method Post -Uri "$Origin/api/tools/vocal-remover/separate" `
                -Body $sepBody -ContentType "application/json" | Out-Null
            $deadline = (Get-Date).AddMinutes(30)
            while ((Get-Date) -lt $deadline) {
                $ss = Invoke-RestMethod "$Origin/api/tools/vocal-remover/separate/status"
                Write-Host "separate: phase=$($ss.phase) progress=$($ss.progress)"
                if ($ss.phase -eq "ready") {
                    Write-Host "separation OK: export=$($ss.result.export_path)"
                    break
                }
                if ($ss.phase -eq "failed") { throw "separation failed: $($ss.message)" }
                Start-Sleep -Seconds 5
            }
            if ($ss.phase -ne "ready") { throw "separation timeout" }
        }
    }

    Write-Host "Web UI integration test passed."
}
finally {
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force
    }
}
