# ItMatZip Tools 웹 UI 로컬 서버 (document root = web-ui/tools)
# 사용: .\serve-tools.ps1
# 포트: web-ui/tools/dev-server-port.js 의 WEB_TOOLS_DEV_PORT 와 동일

$ErrorActionPreference = "Stop"
$Port = 29180
$Root = Join-Path $PSScriptRoot "web-ui\tools"

if (-not (Test-Path $Root)) {
    throw "web-ui/tools 폴더 없음: $Root"
}

Set-Location $Root
Write-Host "=== ItMatZip Tools (static) ===" -ForegroundColor Cyan
Write-Host "Root: $Root"
Write-Host "URL:  http://localhost:$Port/" -ForegroundColor Green
Write-Host "      http://localhost:$Port/silence-remover/" -ForegroundColor Green
Write-Host "에이전트 health: http://127.0.0.1:19876/health" -ForegroundColor DarkGray
Write-Host ""

python -m http.server $Port
