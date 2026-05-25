# 개발 중 설치본(C:\Program Files\itmatzip-agent)에 최신 agent/ Python 소스 반영 + 서비스 재로드
# 관리자 PowerShell에서 실행하세요.
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [string]$InstallAgent = "C:\Program Files\itmatzip-agent\agent",
    [switch]$UseOverrideOnly
)

$ErrorActionPreference = "Stop"
$AgentSrc = Join-Path $RepoRoot "agent"
if (-not (Test-Path (Join-Path $AgentSrc "main.py"))) {
    throw "agent source not found: $AgentSrc"
}

$PythonExe = "C:\Program Files\itmatzip-agent\engine\python.exe"
if (-not (Test-Path $PythonExe)) {
    $PythonExe = "python"
}
Write-Host "Checking agent import..." -ForegroundColor Cyan
& $PythonExe -c "import sys; sys.path.insert(0, r'$AgentSrc'); import main; print('import ok')"
if ($LASTEXITCODE -ne 0) {
    throw "agent Python import failed — sync/restart aborted. Fix syntax errors in agent/ first."
}
Write-Host "Agent import OK." -ForegroundColor Green

$OverrideFile = "C:\ProgramData\itmatzip-agent\agent_dir.override"
New-Item -ItemType Directory -Force -Path (Split-Path $OverrideFile) | Out-Null
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($OverrideFile, $AgentSrc, $utf8NoBom)
Write-Host "Wrote override: $OverrideFile -> $AgentSrc" -ForegroundColor Cyan
Write-Host "Note: override applies after go-agent rebuild (paths.go) or ITMATZIP_AGENT_DIR env." -ForegroundColor Yellow

if (-not $UseOverrideOnly) {
    Write-Host "Copying agent source to $InstallAgent ..." -ForegroundColor Cyan
    robocopy $AgentSrc $InstallAgent /E /NFL /NDL /NJH /NJS /NC /NS /NP `
        /XD __pycache__ .pytest_cache .venv .venv-build build dist .git `
        /XF *.pyc *.pyo | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy failed ($LASTEXITCODE). Run this script as Administrator."
    }
    Write-Host "Agent source synced." -ForegroundColor Green
}

try {
    $resp = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:19876/api/agent/service/restart" -TimeoutSec 10
    Write-Host "Service reload: $($resp.message)" -ForegroundColor Green
} catch {
    Write-Warning "Service reload failed: $($_.Exception.Message)"
    Write-Host "Manually restart: services.msc -> ItMatZip Agent -> 다시 시작" -ForegroundColor Yellow
}

Start-Sleep -Seconds 2
$probeOk = $false
for ($i = 0; $i -lt 15; $i++) {
    try {
        $probe = Invoke-WebRequest -Method Post -Uri "http://127.0.0.1:19876/api/tools/auto-subtitle/export/video-burn-in/prepare" `
            -ContentType "application/json" -Body '{"video_path":"C:/probe.mp4"}' -UseBasicParsing -TimeoutSec 5
        Write-Host "burn-in API probe: HTTP $($probe.StatusCode)" -ForegroundColor Green
        $probeOk = $true
        break
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        if ($code -eq 400) {
            Write-Host "burn-in API available (HTTP 400 expected for dummy path)." -ForegroundColor Green
            $probeOk = $true
            break
        }
        if ($code -eq 503 -and $i -lt 14) {
            Write-Host "FastAPI starting... ($($i + 1)/15)" -ForegroundColor DarkYellow
            Start-Sleep -Seconds 2
            continue
        }
        if ($code -eq 404) {
            Write-Host "burn-in API still 404 — sync 후에도 구버전이면 MSI 재설치가 필요합니다." -ForegroundColor Red
            break
        }
        Write-Host "burn-in API probe: HTTP $code" -ForegroundColor Yellow
        break
    }
}
if (-not $probeOk) {
    Write-Host "FastAPI가 기동되지 않았습니다. service.log 확인:" -ForegroundColor Red
    Write-Host "  C:\ProgramData\itmatzip-agent\logs\service.log" -ForegroundColor Yellow
}
