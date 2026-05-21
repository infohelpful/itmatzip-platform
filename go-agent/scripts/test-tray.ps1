# ItMatZip Agent tray / file-dialog broker test
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\test-tray.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\test-tray.ps1 -TrayOnly -SkipBuild
#   powershell -ExecutionPolicy Bypass -File scripts\test-tray.ps1 -StartService
#   powershell -ExecutionPolicy Bypass -File scripts\test-tray.ps1 -BrokerOnly -SkipBuild

param(
    [switch]$LocalWeb,
    [switch]$SkipBuild,
    [switch]$TrayOnly,
    [switch]$BrokerOnly,
    [switch]$StartService
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Exe = Join-Path $Root "dist\itmatzip-agent.exe"
if (-not (Test-Path $Exe)) {
    $Exe = Join-Path $Root "itmatzip-agent.exe"
}

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Sc-ServiceState {
    $out = sc.exe query ItMatZipAgent 2>&1 | Out-String
    if ($out -match "RUNNING") { return "RUNNING" }
    if ($out -match "STOPPED") { return "STOPPED" }
    return "UNKNOWN"
}
function Test-BrokerListening {
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $iar = $tcp.BeginConnect("127.0.0.1", 19879, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(800)) { return $false }
        $tcp.EndConnect($iar) | Out-Null
        $tcp.Close()
        return $true
    } catch {
        return $false
    }
}
function Test-AgentHealth {
    try {
        $script:AgentHealth = Invoke-RestMethod "http://127.0.0.1:19876/health" -TimeoutSec 5
        return $true
    } catch {
        return $false
    }
}

if (-not $SkipBuild) {
    Write-Step "Building itmatzip-agent.exe"
    Push-Location $Root
    $go = @(
        "C:\Program Files\Go\bin\go.exe",
        "$env:LOCALAPPDATA\Programs\Go\bin\go.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $go) { throw "go.exe not found in PATH" }
    & $go build -o dist\itmatzip-agent.exe .
    Pop-Location
}

if (-not (Test-Path $Exe)) { throw "exe not found: $Exe" }

$icon = Join-Path (Split-Path -Parent $Root) "agent\assets\itmatzip-agent.ico"
Write-Host "Exe:  $Exe"
Write-Host "Icon: $(if (Test-Path $icon) { $icon } else { '(missing)' })"

if ($StartService) {
    Write-Step "Starting Windows service ItMatZipAgent"
    sc.exe start ItMatZipAgent 2>&1 | Out-Host
    Start-Sleep -Seconds 3
}

Get-CimInstance Win32_Process -Filter "Name='itmatzip-agent.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '--launch|--tray|--broker' } |
    ForEach-Object {
        Write-Host "Stopping prior tray/broker PID $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
Start-Sleep -Seconds 1

$env:ITMATZIP_TOOLS_WEB_BASE = ""
if ($LocalWeb) {
    $env:ITMATZIP_TOOLS_WEB_BASE = "http://localhost:29180"
    Write-Host "ITMATZIP_TOOLS_WEB_BASE = $($env:ITMATZIP_TOOLS_WEB_BASE)"
}

if ($BrokerOnly) {
    Write-Step "Starting broker only (--broker, no tray icon)"
    $tray = Start-Process -FilePath $Exe -ArgumentList "--broker" -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 2
} elseif ($TrayOnly) {
    Write-Step "Starting tray only (--tray) — does NOT start agent on :19876"
    $tray = Start-Process -FilePath $Exe -ArgumentList "--tray" -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 2
} else {
    Write-Step "Starting --launch (restart service + tray)"
    $tray = Start-Process -FilePath $Exe -ArgumentList "--launch" -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 3
}

$svc = Sc-ServiceState
Write-Host "Service (ItMatZipAgent): $svc"

$agentOk = Test-AgentHealth
if ($agentOk) {
    Write-Host "Agent :19876 health: OK  v=$($AgentHealth.agent_version) fastapi=$($AgentHealth.fastapi_ready)" -ForegroundColor Green
} else {
    if ($TrayOnly -and $svc -eq "STOPPED") {
        Write-Host "Agent :19876 health: SKIP (expected with -TrayOnly while service STOPPED)" -ForegroundColor Yellow
        Write-Host "  -> Browser needs :19876. Run: sc start ItMatZipAgent" -ForegroundColor Yellow
        Write-Host "  -> Or: .\scripts\test-tray.ps1   (without -TrayOnly, uses --launch)" -ForegroundColor Yellow
    } else {
        Write-Warning "Agent :19876 health: FAIL — $($_.Exception.Message)"
    }
}

$brokerOk = $false
for ($i = 1; $i -le 20; $i++) {
    if (Test-BrokerListening) {
        $brokerOk = $true
        break
    }
    Start-Sleep -Milliseconds 500
}
if ($brokerOk) {
    try {
        $bh = Invoke-RestMethod "http://127.0.0.1:19879/health" -TimeoutSec 3
        Write-Host "Broker :19879 health: OK  ($($bh.broker))" -ForegroundColor Green
    } catch {
        Write-Host "Broker :19879: port open" -ForegroundColor Green
    }
} else {
    Write-Warning "Broker :19879: not listening — run scripts\start-broker.ps1 or check tray icon"
}

$pickNote = ""
if ($agentOk -and $brokerOk) {
    Write-Host "pick-local-file: agent+broker ready (click Browse in browser to test dialog)" -ForegroundColor Green
} elseif (-not $agentOk) {
    $pickNote = "SKIP — agent :19876 not running (start service first)"
    Write-Host "pick-local-file probe: $pickNote" -ForegroundColor Yellow
} elseif (-not $brokerOk) {
    $pickNote = "SKIP — broker :19879 not running"
    Write-Host "pick-local-file probe: $pickNote" -ForegroundColor Yellow
} else {
    try {
        Invoke-WebRequest -Method Post -Uri "http://127.0.0.1:19876/api/agent/pick-local-file" `
            -Headers @{ Accept = "application/json" } -TimeoutSec 3 -ErrorAction Stop | Out-Null
    } catch {
        $status = $null
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        if ($status -eq 503) {
            Write-Host "pick-local-file: 503 (broker unreachable from agent)" -ForegroundColor Yellow
        } else {
            Write-Warning "pick-local-file probe: $($_.Exception.Message)"
        }
    }
}

$trayProc = Get-CimInstance Win32_Process -Filter "Name='itmatzip-agent.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '--tray|--launch|--broker' }
if ($trayProc) {
    foreach ($p in $trayProc) {
        Write-Host "Process PID $($p.ProcessId): $($p.CommandLine)" -ForegroundColor DarkGray
    }
}

Write-Step "Summary"
Write-Host "  [19876 agent]  $(if ($agentOk) { 'OK — browser can connect' } else { 'OFF — sc start ItMatZipAgent or use --launch' })"
Write-Host "  [19879 broker] $(if ($brokerOk) { 'OK — file dialog can open' } else { 'OFF — --tray or -BrokerOnly' })"
Write-Host "  [tray UI]      $(if ($trayProc) { 'running' } else { 'not seen' })"

Write-Step "Quick commands"
Write-Host "  Full stack:     .\scripts\test-tray.ps1 -StartService"
Write-Host "  Tray only:      .\scripts\test-tray.ps1 -TrayOnly -SkipBuild"
Write-Host "  Broker only:    .\scripts\test-tray.ps1 -BrokerOnly -SkipBuild"
Write-Host "  Start service:  sc start ItMatZipAgent"
Write-Host "  Local web UI:   repo root .\serve-tools.ps1"
Write-Host "  Stop tray PID:  Stop-Process -Id $($tray.Id) -Force"

Write-Host "`nLauncher PID: $($tray.Id)" -ForegroundColor Yellow
