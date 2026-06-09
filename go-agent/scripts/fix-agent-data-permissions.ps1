# ProgramData\itmatzip-agent — auto-subtitle models/workspace ACL 복구
# active_model_dir.txt Permission denied (Errno 13) 시 1회 실행 (관리자 PowerShell 권장)
param(
    [string]$DataRoot = "$env:ProgramData\itmatzip-agent"
)

$ErrorActionPreference = "Stop"
$targets = @(
    $DataRoot,
    (Join-Path $DataRoot "auto-subtitle"),
    (Join-Path $DataRoot "auto-subtitle\models"),
    (Join-Path $DataRoot "auto-subtitle\workspace")
)

foreach ($t in $targets) {
    if (-not (Test-Path -LiteralPath $t)) {
        New-Item -ItemType Directory -Force -Path $t | Out-Null
    }
}

Write-Host "Taking ownership of $DataRoot\auto-subtitle ..." -ForegroundColor Cyan
takeown /f (Join-Path $DataRoot "auto-subtitle") /r /d y | Out-Null

Write-Host "Granting Users modify on auto-subtitle tree ..." -ForegroundColor Cyan
icacls (Join-Path $DataRoot "auto-subtitle") /grant "*S-1-5-32-545:(OI)(CI)M" /T /Q
icacls (Join-Path $DataRoot "auto-subtitle") /grant "${env:USERNAME}:(OI)(CI)F" /T /Q
if ($LASTEXITCODE -ne 0) {
    Write-Warning "icacls failed — Run as Administrator"
    exit $LASTEXITCODE
}

Write-Host "OK. Restart itmatzip-agent tray, then retry Prepare." -ForegroundColor Green
