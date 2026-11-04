# FFmpeg gpl-shared를 MSI staging 또는 ProgramData bin에 설치 (빌드·수리용).
# 모든 도구 공통 고정 빌드(7.1.5)만 설치한다 — agent/common/bin_manager.py 의 PINNED_FFMPEG_* 와 같은 값.
param(
    [string]$TargetDir = "",
    [switch]$ToProgramData
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. (Join-Path (Split-Path -Parent $PSScriptRoot) "installer/archive-compat.ps1")

$PinnedName = "ffmpeg-n7.1.5-12-g1fdbca85aa-win64-gpl-shared-7.1.zip"
$PinnedSize = 71578639
$PinnedSha256 = "3e61e96b44bce30f0fad9fc31955be7fe4d6690d6a5a2b65c62494e262f8369e"
$PinnedUrls = @(
    "https://github.com/infohelpful/library-hub/releases/download/ffmpeg-lib/$PinnedName",
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-31-14-10/$PinnedName"
)
# 설치된 빌드 표시 — Go 에이전트(ffmpeg_bootstrap.go)와 bin_manager 가 같은 이름을 쓴다.
$MarkerName = "ffmpeg-build.txt"

function Test-PinnedPresent {
    param([string]$Dir)
    $marker = Join-Path $Dir $MarkerName
    if (-not (Test-Path $marker)) { return $false }
    if ((Get-Content $marker -Raw).Trim() -ne $PinnedName) { return $false }
    return (Test-Path (Join-Path $Dir "ffmpeg.exe")) -and (Test-Path (Join-Path $Dir "ffprobe.exe"))
}

function Get-PinnedZip {
    param([string]$ZipPath)
    foreach ($url in $PinnedUrls) {
        Write-Host "Downloading FFmpeg: $url"
        Remove-Item $ZipPath -Force -ErrorAction SilentlyContinue
        curl.exe -fL --retry 3 --retry-delay 2 -o $ZipPath $url
        if ($LASTEXITCODE -ne 0) { Write-Warning "download failed ($LASTEXITCODE): $url"; continue }
        $size = (Get-Item $ZipPath).Length
        $sha = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($size -eq $PinnedSize -and $sha -eq $PinnedSha256) { return }
        Write-Warning "pinned FFmpeg mismatch (size=$size sha=$sha): $url"
    }
    throw "pinned FFmpeg $PinnedName could not be downloaded"
}

function Install-FfmpegSharedTo {
    param([string]$DestDir)
    New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
    if (Test-PinnedPresent $DestDir) {
        Write-Host "FFmpeg already present: $DestDir ($PinnedName)"
        return
    }

    $tmp = Join-Path $env:TEMP ("itmatzip-ffmpeg-" + [guid]::NewGuid().ToString("n"))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
        $zipPath = Join-Path $tmp "ffmpeg.zip"
        Get-PinnedZip -ZipPath $zipPath

        $extract = Join-Path $tmp "extract"
        Expand-ArchiveCompat -Path $zipPath -DestinationPath $extract -Force
        $binDir = Get-ChildItem -Path $extract -Recurse -Directory -Filter "bin" | Select-Object -First 1
        if (-not $binDir) { throw "bin folder not found in archive" }

        # 다른 빌드의 exe·dll(예: avcodec-63.dll)이 섞이지 않게 비우고 넣는다.
        Get-ChildItem -Path $DestDir -File | Remove-Item -Force
        Get-ChildItem -Path $binDir.FullName -File | Where-Object {
            $ext = $_.Extension.ToLowerInvariant()
            $ext -eq ".exe" -or $ext -eq ".dll"
        } | ForEach-Object {
            Copy-Item $_.FullName (Join-Path $DestDir $_.Name) -Force
        }
        if (-not (Test-Path (Join-Path $DestDir "ffmpeg.exe"))) {
            throw "ffmpeg.exe missing after extract"
        }
        [System.IO.File]::WriteAllText((Join-Path $DestDir $MarkerName), $PinnedName)
        Write-Host "FFmpeg installed: $DestDir ($PinnedName)"
    }
    finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

if ($ToProgramData) {
    $dataRoot = "C:\ProgramData\itmatzip-agent"
    $binRoot = Join-Path $dataRoot "bin"
    $lock = Join-Path $binRoot ".ffmpeg_download.lock"
    if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue }
    Install-FfmpegSharedTo -DestDir (Join-Path $binRoot "gpl-shared")
    exit 0
}

if (-not $TargetDir) {
    throw "Specify -TargetDir or -ToProgramData"
}
Install-FfmpegSharedTo -DestDir $TargetDir
