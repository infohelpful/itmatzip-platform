# Expand-Archive / Compress-Archive — PS 5.1 Write-Progress IndexOutOfRange 회피
# 사용: . (Join-Path $PSScriptRoot "archive-compat.ps1")

function Expand-ArchiveCompat {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$DestinationPath,
        [switch]$Force
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Archive not found: $Path"
    }
    if ($Force -and (Test-Path -LiteralPath $DestinationPath)) {
        Remove-Item -LiteralPath $DestinationPath -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $DestinationPath | Out-Null
    $prevProgress = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
        [System.IO.Compression.ZipFile]::ExtractToDirectory(
            (Resolve-Path -LiteralPath $Path).Path,
            (Resolve-Path -LiteralPath $DestinationPath).Path
        )
    } catch {
        Expand-Archive -LiteralPath $Path -DestinationPath $DestinationPath -Force:$Force
    } finally {
        $ProgressPreference = $prevProgress
    }
}

function Compress-ArchiveCompat {
    param(
        [Parameter(Mandatory)][string[]]$Path,
        [Parameter(Mandatory)][string]$DestinationPath,
        [ValidateSet("Fastest", "Optimal", "NoCompression")]
        [string]$CompressionLevel = "Optimal",
        [switch]$Force
    )
    if ($Force -and (Test-Path -LiteralPath $DestinationPath)) {
        Remove-Item -LiteralPath $DestinationPath -Force
    }
    $parent = Split-Path -Parent $DestinationPath
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    $prevProgress = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
        $level = [System.IO.Compression.CompressionLevel]::Optimal
        if ($CompressionLevel -eq "Fastest") {
            $level = [System.IO.Compression.CompressionLevel]::Fastest
        } elseif ($CompressionLevel -eq "NoCompression") {
            $level = [System.IO.Compression.CompressionLevel]::NoCompression
        }
        $sources = @($Path | ForEach-Object { (Resolve-Path -LiteralPath $_).Path })
        if ($sources.Count -eq 1 -and (Test-Path -LiteralPath $sources[0] -PathType Container)) {
            [System.IO.Compression.ZipFile]::CreateFromDirectory(
                $sources[0],
                $DestinationPath,
                $level,
                $false
            )
        } else {
            $mode = [System.IO.Compression.ZipArchiveMode]::Create
            $zip = [System.IO.Compression.ZipFile]::Open($DestinationPath, $mode)
            try {
                foreach ($src in $sources) {
                    if (Test-Path -LiteralPath $src -PathType Container) {
                        Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object {
                            $rel = $_.FullName.Substring($src.Length).TrimStart("\", "/")
                            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                                $zip, $_.FullName, $rel, $level
                            ) | Out-Null
                        }
                    } else {
                        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                            $zip, $src, (Split-Path -Leaf $src), $level
                        ) | Out-Null
                    }
                }
            } finally {
                $zip.Dispose()
            }
        }
    } catch {
        Compress-Archive -Path $Path -DestinationPath $DestinationPath -CompressionLevel $CompressionLevel -Force:$Force
    } finally {
        $ProgressPreference = $prevProgress
    }
}
