# engine-runtime 권한 복구 (1회성)
# 원인: 관리자/SYSTEM 이 %APPDATA%\ItMatZip\engine-runtime 에 pip --target 한 뒤
#       일반 사용자(트레이)가 site-packages 를 읽지 못함 → FastAPI sidecar exit 1
# 근본 수정: agent/common/runtime_site_packages.py ensure_runtime_tree_acl (pip 직후·기동 시)
# 관리자 PowerShell 권장. 이후 트레이 에이전트를 관리자 권한 없이 재시작.
param(
    [switch]$ResetSilenceRemoverOnly
)

$ErrorActionPreference = "Stop"
$RuntimeRoot = Join-Path $env:APPDATA "ItMatZip\engine-runtime"

if ($ResetSilenceRemoverOnly) {
    $target = Join-Path $RuntimeRoot "silence-remover"
    if (Test-Path $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
        Write-Host "Removed $target (Pillow will reinstall on next API use)" -ForegroundColor Green
    }
    exit 0
}

if (-not (Test-Path $RuntimeRoot)) {
    Write-Host "Nothing to fix: $RuntimeRoot does not exist"
    exit 0
}

Write-Host "Taking ownership of $RuntimeRoot ..." -ForegroundColor Cyan
takeown /f $RuntimeRoot /r /d y | Out-Null

Write-Host "Granting current user Full control on $RuntimeRoot ..." -ForegroundColor Cyan
$grant = "${env:USERNAME}:(OI)(CI)F"
icacls $RuntimeRoot /grant $grant /T
icacls $RuntimeRoot /grant "*S-1-5-32-545:(OI)(CI)M" /T
if ($LASTEXITCODE -ne 0) {
    Write-Warning "icacls failed (try Run as Administrator). Exit code: $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host "Testing Pillow import via agent python ..." -ForegroundColor Cyan
$py = "C:\Program Files\itmatzip-agent\engine\python.exe"
$agentDir = "C:\Program Files\itmatzip-agent\agent"
if ((Test-Path $py) -and (Test-Path $agentDir)) {
    $env:PYTHONPATH = $agentDir
    $env:PYTHONNOUSERSITE = "1"
    & $py -c "import sys; sys.path.insert(0, r'$agentDir'); import main; print('import main OK')"
}

Write-Host "Restart ItMatZip tray agent, then: Invoke-RestMethod http://127.0.0.1:19876/health" -ForegroundColor Green
