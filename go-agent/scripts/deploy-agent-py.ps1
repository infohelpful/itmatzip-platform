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
    @{ Src = Join-Path $AgentSrc "engines\__init__.py"; Dst = Join-Path $AgentDst "engines\__init__.py" },
    @{ Src = Join-Path $AgentSrc "routers\silence_remover.py"; Dst = Join-Path $AgentDst "routers\silence_remover.py" },
    @{ Src = Join-Path $AgentSrc "routers\image_enhancer.py"; Dst = Join-Path $AgentDst "routers\image_enhancer.py" }
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
Write-Host "Restarting ItMatZipAgent service..." -ForegroundColor Cyan
Restart-Service ItMatZipAgent -ErrorAction Stop
Start-Sleep -Seconds 3
try {
    $h = Invoke-RestMethod "http://127.0.0.1:19876/health" -TimeoutSec 5
    Write-Host "health: $($h | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
    Write-Warning "health check failed: $_"
    Write-Host "Check: Get-Content `"$env:ProgramData\itmatzip-agent\logs\service.log`" -Tail 30"
}
