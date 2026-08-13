# Copy updated agent/*.py into installed MSI layout (no full MSI rebuild).
# Requires Administrator if destination is under Program Files.
param(
    [string]$RepoRoot = "",
    [string]$InstallDir = "C:\Program Files\itmatzip-agent"
)

$ErrorActionPreference = "Stop"
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}
$AgentSrc = Join-Path $RepoRoot "agent"
$AgentDst = Join-Path $InstallDir "agent"

if (-not (Test-Path (Join-Path $AgentSrc "main.py"))) {
    throw "agent source not found: $AgentSrc"
}
if (-not (Test-Path $AgentDst)) {
    throw "install agent folder not found: $AgentDst (install MSI first)"
}

$files = @(
    # main.py 은 라우터 등록이 들어 있어 새 툴 추가 시 반드시 함께 배포해야 한다.
    @{ Src = Join-Path $AgentSrc "main.py"; Dst = Join-Path $AgentDst "main.py" },
    @{ Src = Join-Path $AgentSrc "runtime_paths.py"; Dst = Join-Path $AgentDst "runtime_paths.py" },
    @{ Src = Join-Path $AgentSrc "common\bin_manager.py"; Dst = Join-Path $AgentDst "common\bin_manager.py" },
    @{ Src = Join-Path $AgentSrc "common\runtime_site_packages.py"; Dst = Join-Path $AgentDst "common\runtime_site_packages.py" },
    @{ Src = Join-Path $AgentSrc "common\subprocess_util.py"; Dst = Join-Path $AgentDst "common\subprocess_util.py" },
    @{ Src = Join-Path $AgentSrc "engines\demucs_runner.py"; Dst = Join-Path $AgentDst "engines\demucs_runner.py" },
    @{ Src = Join-Path $AgentSrc "engines\vocal_remover.py"; Dst = Join-Path $AgentDst "engines\vocal_remover.py" },
    @{ Src = Join-Path $AgentSrc "engines\silence_remover.py"; Dst = Join-Path $AgentDst "engines\silence_remover.py" },
    @{ Src = Join-Path $AgentSrc "engines\codeformer_runtime.py"; Dst = Join-Path $AgentDst "engines\codeformer_runtime.py" },
    @{ Src = Join-Path $AgentSrc "engines\codeformer_runner.py"; Dst = Join-Path $AgentDst "engines\codeformer_runner.py" },
    @{ Src = Join-Path $AgentSrc "engines\image_enhancer.py"; Dst = Join-Path $AgentDst "engines\image_enhancer.py" },
    @{ Src = Join-Path $AgentSrc "engines\birefnet_runtime.py"; Dst = Join-Path $AgentDst "engines\birefnet_runtime.py" },
    @{ Src = Join-Path $AgentSrc "engines\birefnet_runner.py"; Dst = Join-Path $AgentDst "engines\birefnet_runner.py" },
    @{ Src = Join-Path $AgentSrc "engines\background_remover.py"; Dst = Join-Path $AgentDst "engines\background_remover.py" },
    @{ Src = Join-Path $AgentSrc "engines\iopaint_runtime.py"; Dst = Join-Path $AgentDst "engines\iopaint_runtime.py" },
    @{ Src = Join-Path $AgentSrc "engines\iopaint_runner.py"; Dst = Join-Path $AgentDst "engines\iopaint_runner.py" },
    @{ Src = Join-Path $AgentSrc "engines\magic_eraser.py"; Dst = Join-Path $AgentDst "engines\magic_eraser.py" },
    @{ Src = Join-Path $AgentSrc "engines\seedvc_runtime.py"; Dst = Join-Path $AgentDst "engines\seedvc_runtime.py" },
    @{ Src = Join-Path $AgentSrc "engines\voice_changer.py"; Dst = Join-Path $AgentDst "engines\voice_changer.py" },
    @{ Src = Join-Path $AgentSrc "engines\voice_changer_runner.py"; Dst = Join-Path $AgentDst "engines\voice_changer_runner.py" },
    @{ Src = Join-Path $AgentSrc "engines\propainter_runtime.py"; Dst = Join-Path $AgentDst "engines\propainter_runtime.py" },
    @{ Src = Join-Path $AgentSrc "engines\propainter_runner.py"; Dst = Join-Path $AgentDst "engines\propainter_runner.py" },
    @{ Src = Join-Path $AgentSrc "engines\watermark_remover.py"; Dst = Join-Path $AgentDst "engines\watermark_remover.py" },
    @{ Src = Join-Path $AgentSrc "engines\create_music_acestep_runtime.py"; Dst = Join-Path $AgentDst "engines\create_music_acestep_runtime.py" },
    @{ Src = Join-Path $AgentSrc "engines\create_music.py"; Dst = Join-Path $AgentDst "engines\create_music.py" },
    @{ Src = Join-Path $AgentSrc "engines\create_music_runner.py"; Dst = Join-Path $AgentDst "engines\create_music_runner.py" },
    @{ Src = Join-Path $AgentSrc "engines\create_music_prepare_runner.py"; Dst = Join-Path $AgentDst "engines\create_music_prepare_runner.py" },
    @{ Src = Join-Path $AgentSrc "engines\__init__.py"; Dst = Join-Path $AgentDst "engines\__init__.py" },
    @{ Src = Join-Path $AgentSrc "routers\silence_remover.py"; Dst = Join-Path $AgentDst "routers\silence_remover.py" },
    @{ Src = Join-Path $AgentSrc "routers\image_enhancer.py"; Dst = Join-Path $AgentDst "routers\image_enhancer.py" },
    @{ Src = Join-Path $AgentSrc "routers\background_remover.py"; Dst = Join-Path $AgentDst "routers\background_remover.py" },
    @{ Src = Join-Path $AgentSrc "routers\magic_eraser.py"; Dst = Join-Path $AgentDst "routers\magic_eraser.py" },
    @{ Src = Join-Path $AgentSrc "routers\voice_changer.py"; Dst = Join-Path $AgentDst "routers\voice_changer.py" },
    @{ Src = Join-Path $AgentSrc "routers\watermark_remover.py"; Dst = Join-Path $AgentDst "routers\watermark_remover.py" },
    @{ Src = Join-Path $AgentSrc "routers\create_music.py"; Dst = Join-Path $AgentDst "routers\create_music.py" }
)

foreach ($f in $files) {
    if (-not (Test-Path $f.Src)) {
        throw "missing source: $($f.Src)"
    }
    $parent = Split-Path -Parent $f.Dst
    if (-not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    Copy-Item -LiteralPath $f.Src -Destination $f.Dst -Force
    Write-Host "OK $($f.Dst)" -ForegroundColor Green
}

Write-Host ""

# 사이드카는 서비스가 아니라 트레이 앱이 띄우는 경우가 많다. 서비스가 실행 중이면 서비스를
# 재시작하고, 아니면 uvicorn 프로세스만 종료해 워치독이 같은 사용자 권한으로 다시 띄우게 한다.
# (트레이/에이전트를 관리자로 새로 띄우면 engine-runtime ACL 이 오염된다.)
$svc = Get-Service ItMatZipAgent -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Host "Restarting ItMatZipAgent service..." -ForegroundColor Cyan
    Restart-Service ItMatZipAgent -ErrorAction Stop
} else {
    Write-Host "Service not running - restarting tray-hosted FastAPI sidecar..." -ForegroundColor Cyan
    $sidecars = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match "uvicorn" -and $_.CommandLine -match "main:app" }
    if (-not $sidecars) {
        Write-Warning "FastAPI sidecar process not found. Start the ItMatZip tray app (as a normal user) to load the new files."
    } else {
        foreach ($s in $sidecars) {
            Write-Host "  stopping sidecar pid $($s.ProcessId)" -ForegroundColor Yellow
            Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

# /health 는 Go 컨트롤러가 항상 응답하므로 fastapi_ready 까지 확인해야 실제 재기동을 검증할 수 있다.
$ok = $false
foreach ($i in 1..30) {
    Start-Sleep -Seconds 2
    try {
        $h = Invoke-RestMethod "http://127.0.0.1:19876/health" -TimeoutSec 5
        if ($h.fastapi_ready) {
            Write-Host "fastapi ready (agent $($h.agent_version))" -ForegroundColor Green
            $ok = $true
            break
        }
        Write-Host "  waiting sidecar... state=$($h.fastapi.state)" -ForegroundColor DarkGray
    } catch {
        # Go 컨트롤러도 아직 기동 중
    }
}
if (-not $ok) {
    Write-Warning "health check failed after ~60s"
    Write-Host "Check: Get-Content `"$env:ProgramData\itmatzip-agent\logs\fastapi-sidecar.log`" -Tail 40"
}
