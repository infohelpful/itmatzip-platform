# Resolve WiX Toolset bin directory (candle.exe, heat.exe, light.exe)
function Resolve-WixBin {
    $candle = Get-Command candle.exe -ErrorAction SilentlyContinue
    if ($candle) {
        return Split-Path -Parent $candle.Source
    }

    $candidates = @(
        "${env:ProgramFiles(x86)}\WiX Toolset v3.14\bin",
        "${env:ProgramFiles(x86)}\WiX Toolset v3.11\bin",
        "$env:ProgramFiles\WiX Toolset v3.14\bin",
        "$env:ProgramFiles\WiX Toolset v3.11\bin"
    )

    foreach ($dir in $candidates) {
        if (Test-Path (Join-Path $dir "candle.exe")) {
            return $dir
        }
    }

    $pf86 = ${env:ProgramFiles(x86)}
    if ($pf86 -and (Test-Path $pf86)) {
        $found = Get-ChildItem -Path $pf86 -Directory -Filter "WiX Toolset*" -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName "bin\candle.exe" } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
        if ($found) {
            return Split-Path -Parent $found
        }
    }

    return $null
}

function Import-WixPath {
    $bin = Resolve-WixBin
    if (-not $bin) {
        return $false
    }
    if ($env:PATH -notlike "*$bin*") {
        $env:PATH = "$bin;$env:PATH"
    }
    return $true
}

if ($MyInvocation.InvocationName -ne '.') {
    if (Import-WixPath) {
        Write-Host "WiX bin: $(Resolve-WixBin)"
        exit 0
    }
    Write-Error "WiX Toolset not found. Install: winget install WiXToolset.WiXToolset"
    exit 1
}
