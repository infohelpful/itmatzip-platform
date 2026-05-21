# 트레이용 16×16 ICO 생성 (Windows 알림 영역 — 단일 256px ICO는 빈 칸으로 보일 수 있음)
param(
    [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$RepoAgentAssets = Join-Path (Split-Path -Parent $Root) "agent\assets"
$Src = Join-Path $RepoAgentAssets "itmatzip-agent.ico"
$TrayDir = Join-Path $Root "trayicon"
$Out16 = Join-Path $TrayDir "tray-16.ico"
$Out32 = Join-Path $TrayDir "tray-32.ico"
$OutAssets = Join-Path $RepoAgentAssets "itmatzip-agent-tray.ico"

if (-not (Test-Path $Src)) {
    throw "Source icon missing: $Src"
}
New-Item -ItemType Directory -Force -Path $TrayDir | Out-Null

$py = @"
from pathlib import Path
from PIL import Image
src = Path(r'$Src')
base = Image.open(src).convert('RGBA')
for size, out in [(32, Path(r'$Out32')), (16, Path(r'$Out16'))]:
    base.resize((size, size), Image.Resampling.LANCZOS).save(out, format='ICO')
    print(out, out.stat().st_size)
Path(r'$OutAssets').write_bytes(Path(r'$Out32').read_bytes())
print('assets', Path(r'$OutAssets'))
"@

& $Python -c $py
if ($LASTEXITCODE -ne 0) {
    throw "Pillow required: pip install Pillow"
}
Write-Host "Tray 16+32 ICO ready (go:embed + agent/assets)" -ForegroundColor Green
