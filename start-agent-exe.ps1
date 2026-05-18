# ItMatZip 로컬 에이전트 (빌드된 exe)
$Exe = Join-Path $PSScriptRoot "agent\dist\itmatzip-agent.exe"
if (-not (Test-Path $Exe)) {
    Write-Host "exe가 없습니다. 먼저 실행: .\build-agent.ps1" -ForegroundColor Yellow
    exit 1
}
Write-Host "Starting: $Exe"
& $Exe
