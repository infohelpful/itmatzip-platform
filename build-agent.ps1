# ItMatZip 로컬 에이전트 → Windows exe 빌드
# 사용: .\build-agent.ps1
#       .\build-agent.ps1 -IconPath "C:\path\to\my.ico"
# 결과: agent\dist\itmatzip-agent.exe
# 아이콘: agent\assets\itmatzip-agent.ico (없으면 Python 기본 아이콘)

param(
    [string]$IconPath = ""
)

$ErrorActionPreference = "Stop"
$AgentRoot = Join-Path $PSScriptRoot "agent"
Set-Location $AgentRoot

$DefaultIcon = Join-Path $AgentRoot "assets\itmatzip-agent.ico"
$AssetsDir = Join-Path $AgentRoot "assets"

Write-Host "=== ItMatZip Agent EXE build ===" -ForegroundColor Cyan
Write-Host "Agent root: $AgentRoot"

if (-not (Test-Path $AssetsDir)) {
    New-Item -ItemType Directory -Path $AssetsDir -Force | Out-Null
}

if ($IconPath -ne "") {
    if (-not (Test-Path $IconPath)) {
        throw "아이콘 파일 없음: $IconPath"
    }
    Copy-Item -Path $IconPath -Destination $DefaultIcon -Force
    Write-Host "아이콘 복사: $IconPath -> $DefaultIcon" -ForegroundColor Green
} elseif (-not (Test-Path $DefaultIcon)) {
    Write-Host "경고: $DefaultIcon 없음 — exe는 Python 기본 아이콘으로 빌드됩니다." -ForegroundColor Yellow
    Write-Host "      PNG는 .ico 로 변환 후 agent\assets\itmatzip-agent.ico 로 저장하세요." -ForegroundColor Yellow
} else {
    Write-Host "아이콘: $DefaultIcon" -ForegroundColor Green
}

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
