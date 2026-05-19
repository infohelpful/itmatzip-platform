# ItMatZip 에이전트 — 로컬 테스트용 (exe 1회 실행 = 자동 설치)
# 사용: .\install-agent.ps1  (먼저 .\build-agent.ps1)

$ErrorActionPreference = "Stop"
$Exe = Join-Path $PSScriptRoot "agent\dist\itmatzip-agent.exe"
if (-not (Test-Path $Exe)) {
    throw "exe 없음. 먼저 .\build-agent.ps1 실행"
}
Write-Host "실행 중 (첫 실행 시 자동 설치): $Exe" -ForegroundColor Cyan
Start-Process -FilePath $Exe
Write-Host "완료. http://127.0.0.1:19876/health 확인" -ForegroundColor Green
