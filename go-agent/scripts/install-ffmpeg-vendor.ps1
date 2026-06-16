# FFmpeg gpl-shared를 MSI staging 또는 ProgramData bin에 설치 (빌드·수리용).
param(
    [string]$TargetDir = "",
    [switch]$ToProgramData
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. (Join-Path (Split-Path -Parent $PSScriptRoot) "installer/archive-compat.ps1")

function Get-LatestFfmpegSharedZipUrl {
    $headers = @{ "User-Agent" = "itmatzip-agent-installer" }
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest" -Headers $headers
    foreach ($asset in $release.assets) {
        $name = [string]$asset.name
        if ($name -match "win64-gpl-shared.*\.zip$") {
            return [string]$asset.browser_download_url
        }
    }
    throw "win64-gpl-shared zip not found in latest BtbN release"
}

function Install-FfmpegSharedTo {
    param([string]$DestDir)
    New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
    if ((Test-Path (Join-Path $DestDir "ffmpeg.exe")) -and (Test-Path (Join-Path $DestDir "ffprobe.exe"))) {
        $dll = Get-ChildItem -Path $DestDir -Filter "*.dll" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($dll) {
            Write-Host "FFmpeg already present: $DestDir"
            return
        }
    }

    $tmp = Join-Path $env:TEMP ("itmatzip-ffmpeg-" + [guid]::NewGuid().ToString("n"))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
        $zipUrl = Get-LatestFfmpegSharedZipUrl
        $zipPath = Join-Path $tmp "ffmpeg.zip"
        Write-Host "Downloading FFmpeg: $zipUrl"
        curl.exe -fL --retry 3 --retry-delay 2 -o $zipPath $zipUrl
        if ($LASTEXITCODE -ne 0) { throw "curl download failed: $LASTEXITCODE" }

        $extract = Join-Path $tmp "extract"
        Expand-ArchiveCompat -Path $zipPath -DestinationPath $extract -Force
        $binDir = Get-ChildItem -Path $extract -Recurse -Directory -Filter "bin" | Select-Object -First 1
        if (-not $binDir) { throw "bin folder not found in archive" }

        Get-ChildItem -Path $binDir.FullName -File | Where-Object {
            $ext = $_.Extension.ToLowerInvariant()
            $ext -eq ".exe" -or $ext -eq ".dll"
        } | ForEach-Object {
            Copy-Item $_.FullName (Join-Path $DestDir $_.Name) -Force
        }
        if (-not (Test-Path (Join-Path $DestDir "ffmpeg.exe"))) {
            throw "ffmpeg.exe missing after extract"
        }
        Write-Host "FFmpeg installed: $DestDir"
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
