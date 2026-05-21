# ItMatZip Agent 트레이 기능 수동·반자동 테스트
# 사용 (관리자 권장 — 서비스 시작/중지):
#   powershell -ExecutionPolicy Bypass -File scripts\test-tray.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\test-tray.ps1 -LocalWeb

param(
    [switch]$LocalWeb,
    [switch]$SkipBuild
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

if (-not $SkipBuild) {
    Write-Step "Building itmatzip-agent.exe"
    Push-Location $Root
    go build -o dist\itmatzip-agent.exe .
    Pop-Location
}

if (-not (Test-Path $Exe)) { throw "exe not found: $Exe" }

$icon = Join-Path (Split-Path -Parent $Root) "agent\assets\itmatzip-agent.ico"
Write-Host "Exe:  $Exe"
Write-Host "Icon: $(if (Test-Path $icon) { $icon } else { '(missing)' })"

# 기존 트레이/launch 프로세스 정리 (서비스 모드 제외)
Get-CimInstance Win32_Process -Filter "Name='itmatzip-agent.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '--launch|--tray' } |
    ForEach-Object {
        Write-Host "Stopping prior tray/launch PID $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
Start-Sleep -Seconds 1

$env:ITMATZIP_TOOLS_WEB_BASE = ""
if ($LocalWeb) {
    $env:ITMATZIP_TOOLS_WEB_BASE = "http://localhost:29180"
    Write-Host "ITMATZIP_TOOLS_WEB_BASE = $($env:ITMATZIP_TOOLS_WEB_BASE)"
}

Write-Step "Starting tray via --launch (background)"
$launch = Start-Process -FilePath $Exe -ArgumentList "--launch" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3

$svc = Sc-ServiceState
Write-Host "Service state: $svc"
if ($svc -ne "RUNNING") {
    Write-Warning "Service is not RUNNING. Try: Run as Administrator, or sc start ItMatZipAgent"
}

try {
    $health = Invoke-RestMethod "http://127.0.0.1:19876/health" -TimeoutSec 5
    Write-Host "Health: $($health.status) agent=$($health.agent_version) fastapi=$($health.fastapi_ready)"
} catch {
    Write-Warning "Health check failed: $($_.Exception.Message)"
}

$trayProc = Get-CimInstance Win32_Process -Filter "Name='itmatzip-agent.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '--launch' }
if ($trayProc) {
    Write-Host "Tray/launch process: PID $($trayProc.ProcessId)" -ForegroundColor Green
} else {
    Write-Warning "No --launch process found (tray may have exited immediately)"
}

Write-Step "Manual checklist (작업 표시줄 우측 트레이)"
Write-Host @"
  1. ^(숨김 아이콘)^ itmatzip-agent 아이콘이 보이는지
  2. 우클릭 → 메뉴: 대시보드 / Silence Detector / Vocal Remover
  3. 각 메뉴 클릭 시 브라우저가 열리는지
  4. 「서비스 종료」→ health 실패, 메뉴에서 「서비스 재시작」만 활성화되는지
  5. 「서비스 재시작」→ health OK, 「서비스 종료」 다시 활성화되는지
  6. 「종료」→ 트레이 사라지고 서비스 STOPPED 인지

로컬 웹 UI 병행 테스트:
  repo 루트: .\serve-tools.ps1
  그 다음: .\scripts\test-tray.ps1 -LocalWeb -SkipBuild

종료 후 정리:
  sc stop ItMatZipAgent
"@ -ForegroundColor DarkGray

Write-Host "`nTray test launcher PID: $($launch.Id) (종료 메뉴로 닫거나 Stop-Process)" -ForegroundColor Yellow
