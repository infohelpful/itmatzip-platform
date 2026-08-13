# 관리자 PowerShell — 설치된 tools-web 만 소스와 동기화 (전체 MSI 없이 UI만 갱신)
param(
    [string]$InstallRoot = "C:\Program Files\itmatzip-agent"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$PlatformRoot = Split-Path -Parent $Root
$ToolsSrc = Join-Path $PlatformRoot "web-ui\tools"
$ToolsDst = Join-Path $InstallRoot "tools-web"

if (-not (Test-Path (Join-Path $ToolsSrc "image-enhancer\script.js"))) {
    throw "Source not found: $ToolsSrc\image-enhancer"
}

Write-Host "Syncing tools-web -> $ToolsDst" -ForegroundColor Cyan
$dstParent = Split-Path $ToolsDst -Parent
if (-not (Test-Path $dstParent)) { New-Item -ItemType Directory -Force -Path $dstParent | Out-Null }

function Sync-Dir($name) {
    $s = Join-Path $ToolsSrc $name
    $d = Join-Path $ToolsDst $name
    if (-not (Test-Path $s)) { return }
    robocopy $s $d /E /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy $name failed: $LASTEXITCODE" }
}

if (Test-Path $ToolsDst) { Remove-Item -Recurse -Force $ToolsDst }
New-Item -ItemType Directory -Force -Path $ToolsDst | Out-Null
Sync-Dir "image-enhancer"
Sync-Dir "background-remover"
Sync-Dir "magic-eraser"
Sync-Dir "voice-changer"
Sync-Dir "watermark-remover"
Sync-Dir "common"
$silence = Join-Path $ToolsSrc "silence-remover"
if (Test-Path $silence) {
    $sd = Join-Path $ToolsDst "silence-remover"
    New-Item -ItemType Directory -Force -Path $sd | Out-Null
    foreach ($f in @("mobile-only.css", "mobile-only.js")) {
        $src = Join-Path $silence $f
        if (Test-Path $src) { Copy-Item $src (Join-Path $sd $f) }
    }
}
foreach ($ico in @("favicon-16x16.ico", "favicon-32x32.ico")) {
    $src = Join-Path $ToolsSrc $ico
    if (Test-Path $src) { Copy-Item $src (Join-Path $ToolsDst $ico) }
}

$check = Join-Path $ToolsDst "image-enhancer\script.js"
if (-not (Select-String -Path $check -Pattern "loadImageInto" -Quiet)) {
    throw "Sync failed: script.js still outdated"
}

Write-Host "OK. Restart tray agent, open http://127.0.0.1:19876/tools/image-enhancer/ and Ctrl+F5" -ForegroundColor Green
