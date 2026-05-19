# ItMatZip 로컬 에이전트 → Windows 단일 exe 빌드
# 사용: .\build-agent.ps1
# 결과: agent\dist\itmatzip-agent.exe  (사용자는 이 파일 하나만 받음)
# 내부: onedir 번들 zip → AppData 설치 후 빠른 기동

param(
    [string]$IconPath = ""
)

$ErrorActionPreference = "Stop"
$AgentRoot = Join-Path $PSScriptRoot "agent"
Set-Location $AgentRoot

$DefaultIcon = Join-Path $AgentRoot "assets\itmatzip-agent.ico"
$AssetsDir = Join-Path $AgentRoot "assets"

Write-Host "=== ItMatZip Agent EXE build (single file) ===" -ForegroundColor Cyan
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
} else {
    Write-Host "아이콘: $DefaultIcon" -ForegroundColor Green
}

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "Python이 PATH에 없습니다."
}

$venv = Join-Path $AgentRoot ".venv-build"
if (-not (Test-Path $venv)) {
    Write-Host "가상환경 생성: $venv"
    python -m venv $venv
}

$py = Join-Path $venv "Scripts\python.exe"

Write-Host "의존성 설치..."
& $py -m pip install -q --upgrade pip
& $py -m pip install -q -r requirements.txt

$buildDir = Join-Path $AgentRoot "build"
$distDir = Join-Path $AgentRoot "dist"
# onedir 번들은 dist 가 아닌 build 에만 생성 (배포 폴더에 폴더가 남지 않게)
$bundleDir = Join-Path $buildDir "itmatzip-agent"
$bundleZip = Join-Path $buildDir "agent-bundle.zip"
$outExe = Join-Path $distDir "itmatzip-agent.exe"

Remove-Item -Recurse -Force (Join-Path $AgentRoot "build"), $distDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $buildDir, $distDir -Force | Out-Null

Write-Host "[1/3] onedir 에이전트 번들 (내부용, build\ 에만 생성)..."
& $py -m PyInstaller itmatzip-agent-bundle.spec --noconfirm --clean --distpath $buildDir --workpath (Join-Path $buildDir "pyi-bundle")
if (-not (Test-Path (Join-Path $bundleDir "itmatzip-agent.exe"))) {
    throw "onedir 번들 빌드 실패: $bundleDir\itmatzip-agent.exe"
}

Write-Host "[2/3] 번들 zip 패키징 (setup exe 에 포함)..."
if (Test-Path $bundleZip) { Remove-Item $bundleZip -Force }
$zipStaging = Join-Path $buildDir "zip-staging"
if (Test-Path $zipStaging) { Remove-Item $zipStaging -Recurse -Force }
New-Item -ItemType Directory -Path $zipStaging -Force | Out-Null
Copy-Item -Path (Join-Path $bundleDir "*") -Destination $zipStaging -Recurse -Force
Compress-Archive -Path (Join-Path $zipStaging "*") -DestinationPath $bundleZip -CompressionLevel Optimal -Force
Remove-Item $zipStaging -Recurse -Force

Write-Host "[3/3] 단일 itmatzip-agent.exe (설치 프로그램)..."
& $py -m PyInstaller itmatzip-agent-setup.spec --noconfirm --clean --distpath $distDir --workpath (Join-Path $buildDir "pyi-setup")
if (-not (Test-Path $outExe)) {
    throw "setup exe 빌드 실패: $outExe"
}

# 혹시 남은 중간 산물 정리 (dist 에는 exe 만)
Get-ChildItem $distDir -Exclude "itmatzip-agent.exe" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path $bundleDir) { Remove-Item $bundleDir -Recurse -Force -ErrorAction SilentlyContinue }

$sizeMb = [math]::Round((Get-Item $outExe).Length / 1MB, 1)
Write-Host ""
Write-Host "완료: $outExe ($sizeMb MB)" -ForegroundColor Green
Write-Host "배포: itmatzip-agent.exe 파일 하나만 올리면 됩니다 (ZIP 불필요)."
Write-Host "사용자: exe 더블클릭 1회 = AppData 설치 + 서버 기동 (수 초, 이후 로그인·재실행도 빠름)"
Write-Host "확인: http://127.0.0.1:19876/health"
