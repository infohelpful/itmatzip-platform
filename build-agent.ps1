# ItMatZip 로컬 에이전트 → Windows exe 빌드
# 사용: .\build-agent.ps1
# 결과: agent\dist\itmatzip-agent.exe

$ErrorActionPreference = "Stop"
$AgentRoot = Join-Path $PSScriptRoot "agent"
Set-Location $AgentRoot

Write-Host "=== ItMatZip Agent EXE build ===" -ForegroundColor Cyan
Write-Host "Agent root: $AgentRoot"

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "Python이 PATH에 없습니다. https://www.python.org 에서 Python 3.10+ 설치 후 'Add to PATH'를 선택하세요."
}

$venv = Join-Path $AgentRoot ".venv-build"
if (-not (Test-Path $venv)) {
    Write-Host "가상환경 생성: $venv"
    python -m venv $venv
}

$py = Join-Path $venv "Scripts\python.exe"
$pip = Join-Path $venv "Scripts\pip.exe"

Write-Host "의존성 설치..."
& $py -m pip install -q --upgrade pip
& $py -m pip install -q -r requirements.txt

Write-Host "PyInstaller 빌드 (1~3분 소요)..."
& $py -m PyInstaller itmatzip-agent.spec --noconfirm --clean

$exe = Join-Path $AgentRoot "dist\itmatzip-agent.exe"
if (-not (Test-Path $exe)) {
    throw "빌드 실패: $exe 가 생성되지 않았습니다."
}

$sizeMb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host ""
Write-Host ""
Write-Host "완료: $exe ($sizeMb MB)" -ForegroundColor Green
Write-Host "배포: itmatzip-agent.exe 만 올리면 됩니다. 사용자는 exe 1회 실행 = 설치 + 자동 실행 등록"
Write-Host "확인: 브라우저에서 http://127.0.0.1:8000/health"
