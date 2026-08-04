# Build MagicEraser (LaMa erase-only) cp312 wheel bundles for library-hub magic-eraser-lib.
# Offline-ready: prepare = download zip → extract into engine-runtime (no PyPI).
# Does NOT include full iopaint / diffusers / SD — only torch + opencv + Pillow for TorchScript LaMa.
#
# Usage:
#   .\go-agent\scripts\build-iopaint-wheels-cp312.ps1 -Phase all
#   .\go-agent\scripts\build-iopaint-wheels-cp312.ps1 -Phase package
#   .\go-agent\scripts\build-iopaint-wheels-cp312.ps1 -Phase upload
#   .\go-agent\scripts\build-iopaint-wheels-cp312.ps1 -Phase models   # big-lama.pt only
#
param(
    [ValidateSet("all", "download", "package", "upload", "models")]
    [string]$Phase = "all",
    [string]$Python = "",
    [string]$Repo = "infohelpful/library-hub",
    [string]$Tag = "magic-eraser-lib"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $Root "agent\version.py"))) {
    $Root = Split-Path -Parent $PSScriptRoot
}
$Work = Join-Path $Root "go-agent\dist\iopaint-wheels-cp312"
$CpuWheels = Join-Path $Work "cpu\wheels"
$GpuWheels = Join-Path $Work "gpu\wheels"
$Out = Join-Path $Work "out"

function Resolve-Py {
    param([string]$Preferred)
    if ($Preferred -and (Test-Path $Preferred)) { return $Preferred }
    $c = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"
    if (Test-Path $c) { return $c }
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        $resolved = & py -3.12 -c "import sys; print(sys.executable)" 2>$null
        if ($resolved -and (Test-Path $resolved)) { return $resolved.Trim() }
    }
    throw "Python 3.12 not found (install or pass -Python)"
}

function New-SplitZip {
    param(
        [string]$SourceZip,
        [string]$OutDir,
        [string]$BaseName = "iopaint-wheels_gpu.zip",
        [int]$PartBytes = 1800MB
    )
    if (-not (Test-Path -LiteralPath $SourceZip)) {
        throw "Source zip missing before split: $SourceZip"
    }
    1..9 | ForEach-Object {
        $p = Join-Path $OutDir ("{0}.{1:D3}" -f $BaseName, $_)
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
    }
    $fs = [System.IO.File]::OpenRead((Resolve-Path -LiteralPath $SourceZip))
    try {
        $buf = New-Object byte[] (16MB)
        $part = 1
        $writtenInPart = 0
        $out = $null
        while (($n = $fs.Read($buf, 0, $buf.Length)) -gt 0) {
            if ($null -eq $out -or $writtenInPart -ge $PartBytes) {
                if ($out) { $out.Close() }
                $name = "{0}.{1:D3}" -f $BaseName, $part
                $out = [System.IO.File]::Create((Join-Path $OutDir $name))
                $part++
                $writtenInPart = 0
            }
            $out.Write($buf, 0, $n)
            $writtenInPart += $n
        }
        if ($out) { $out.Close() }
    } finally {
        $fs.Close()
    }
}

function New-ZipFromDir {
    param([string]$SourceDir, [string]$ZipPath)
    $seven = "C:\Program Files\7-Zip\7z.exe"
    if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
    if (Test-Path $seven) {
        Push-Location $SourceDir
        try {
            & $seven a -tzip -mx=0 -y $ZipPath "*.whl"
            if ($LASTEXITCODE -ne 0) { throw "7z zip failed: $ZipPath" }
        } finally {
            Pop-Location
        }
    } else {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::CreateFromDirectory($SourceDir, $ZipPath)
    }
    if (-not (Test-Path -LiteralPath $ZipPath)) {
        throw "Zip not created: $ZipPath"
    }
}

function Remove-WrongTorch {
    param([string]$Dir, [ValidateSet("cpu", "gpu")][string]$Variant)
    Get-ChildItem $Dir -Filter "torch*.whl" -ErrorAction SilentlyContinue | ForEach-Object {
        $n = $_.Name
        $isCuda = $n -match '\+cu'
        if ($Variant -eq "cpu" -and $isCuda) { Remove-Item $_.FullName -Force; return }
        if ($Variant -eq "gpu" -and -not $isCuda) { Remove-Item $_.FullName -Force; return }
    }
}

function Dedup-Wheels {
    param([string]$Dir)
    $groups = Get-ChildItem $Dir -Filter "*.whl" | Group-Object {
        $name = $_.Name.ToLowerInvariant().Replace("_", "-")
        $parts = $name.Split("-")
        $pkg = @()
        foreach ($part in $parts) {
            if ($part -and $part[0] -match '\d') { break }
            $pkg += $part
        }
        if ($pkg.Count -gt 0) { ($pkg -join "-") } else { $parts[0] }
    }
    foreach ($g in $groups) {
        if ($g.Count -le 1) { continue }
        $name = $g.Name
        $keep = $null
        if ($name -eq "sympy") {
            $keep = $g.Group | Where-Object { $_.Name -like "sympy-1.13.1-*" } | Select-Object -First 1
        } elseif ($name -eq "mpmath") {
            $keep = $g.Group | Where-Object { $_.Name -like "mpmath-1.3.0-*" } | Select-Object -First 1
        } elseif ($name -eq "numpy") {
            $keep = $g.Group | Where-Object { $_.Name -like "numpy-1.26.*" } | Select-Object -Last 1
        }
        if (-not $keep) {
            $keep = $g.Group | Sort-Object Name | Select-Object -Last 1
        }
        foreach ($f in $g.Group) {
            if ($f.FullName -ne $keep.FullName) {
                Remove-Item $f.FullName -Force
            }
        }
    }
}

function Remove-JunkWheels {
    param([string]$Dir)
    Get-ChildItem $Dir -Filter "*.whl" | ForEach-Object {
        $l = $_.Name.ToLowerInvariant()
        $ok = ($l -match 'py3-none-any') -or ($l -match 'py2\.py3-none-any') -or
              ($l -match 'abi3' -and $l -match 'win_amd64') -or
              ($l -match 'cp312' -and $l -match 'win_amd64') -or
              ($l -match 'none-win_amd64')
        if (-not $ok) { Remove-Item $_.FullName -Force }
    }
}

function Assert-Required {
    param([string]$Dir, [string[]]$Names)
    $missing = @()
    foreach ($name in $Names) {
        $norm = $name.ToLowerInvariant().Replace("_", "-")
        $hit = Get-ChildItem $Dir -Filter "*.whl" | Where-Object {
            $_.Name.ToLowerInvariant().Replace("_", "-").StartsWith($norm + "-")
        }
        if (-not $hit) { $missing += $name }
    }
    if ($missing.Count -gt 0) {
        throw "Incomplete bundle ($Dir): missing $($missing -join ', ')"
    }
}

function Download-LamaModel {
    param([string]$DestPath)
    $url = "https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt"
    New-Item -ItemType Directory -Force -Path (Split-Path $DestPath -Parent) | Out-Null
    Write-Host "Downloading big-lama.pt ..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $url -OutFile $DestPath -UseBasicParsing
    if ((Get-Item $DestPath).Length -lt 50MB) {
        throw "LaMa weight too small: $DestPath"
    }
    Write-Host "LaMa model ready: $DestPath" -ForegroundColor Green
}

$Py = Resolve-Py $Python
New-Item -ItemType Directory -Force -Path $Out, $CpuWheels, $GpuWheels | Out-Null
Write-Host "Work: $Work" -ForegroundColor Cyan
Write-Host "Python: $Py"

# Erase-only stack — no transformers / diffusers / iopaint web UI deps
$PipPkgs = @(
    'numpy==1.26.4',
    'Pillow>=10.0.0',
    'opencv-python-headless>=4.8.0',
    'typing_extensions',
    'sympy',
    'mpmath',
    'networkx',
    'jinja2',
    'markupsafe',
    'fsspec',
    'filelock',
    'setuptools'
)

$RequiredNames = @(
    "numpy", "pillow", "opencv-python-headless",
    "typing-extensions", "sympy", "mpmath", "networkx", "jinja2",
    "markupsafe", "fsspec", "filelock", "torch", "torchvision"
)

if ($Phase -in @("all", "models")) {
    Download-LamaModel -DestPath (Join-Path $Out "big-lama.pt")
    if ($Phase -eq "models") {
        Write-Host "Models-only phase done." -ForegroundColor Green
        exit 0
    }
}

if ($Phase -in @("all", "download")) {
    Write-Host "Downloading CPU package wheels..." -ForegroundColor Cyan
    & $Py -m pip download --only-binary=:all: --no-deps --python-version 312 --platform win_amd64 `
        -d $CpuWheels @PipPkgs
    if ($LASTEXITCODE -ne 0) { throw "pip download CPU packages failed" }

    & $Py -m pip download --only-binary=:all: --no-deps --python-version 312 --platform win_amd64 `
        -d $CpuWheels --index-url https://download.pytorch.org/whl/cpu `
        "torch==2.7.1+cpu" "torchvision==0.22.1+cpu"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Pinned torch CPU failed, retrying unpinned..." -ForegroundColor Yellow
        & $Py -m pip download --only-binary=:all: --no-deps --python-version 312 --platform win_amd64 `
            -d $CpuWheels --index-url https://download.pytorch.org/whl/cpu torch torchvision
        if ($LASTEXITCODE -ne 0) { throw "pip download torch CPU failed" }
    }

    Remove-WrongTorch -Dir $CpuWheels -Variant cpu
    Remove-JunkWheels -Dir $CpuWheels
    Dedup-Wheels -Dir $CpuWheels
    Assert-Required -Dir $CpuWheels -Names $RequiredNames

    Write-Host "Building GPU wheel set from CPU + cu128 torch..." -ForegroundColor Cyan
    if (Test-Path $GpuWheels) { Remove-Item -Recurse -Force $GpuWheels }
    New-Item -ItemType Directory -Force -Path $GpuWheels | Out-Null
    Copy-Item (Join-Path $CpuWheels "*.whl") $GpuWheels
    Get-ChildItem $GpuWheels -Filter "torch*.whl" | Remove-Item -Force

    & $Py -m pip download --only-binary=:all: --no-deps --python-version 312 --platform win_amd64 `
        -d $GpuWheels --index-url https://download.pytorch.org/whl/cu128 `
        "torch==2.7.1+cu128" "torchvision==0.22.1+cu128"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Pinned torch cu128 failed, retrying unpinned..." -ForegroundColor Yellow
        & $Py -m pip download --only-binary=:all: --no-deps --python-version 312 --platform win_amd64 `
            -d $GpuWheels --index-url https://download.pytorch.org/whl/cu128 torch torchvision
        if ($LASTEXITCODE -ne 0) { throw "pip download torch GPU failed" }
    }

    Remove-WrongTorch -Dir $GpuWheels -Variant gpu
    Remove-JunkWheels -Dir $GpuWheels
    Dedup-Wheels -Dir $GpuWheels
    Assert-Required -Dir $GpuWheels -Names $RequiredNames
}

if ($Phase -in @("all", "package")) {
    Assert-Required -Dir $CpuWheels -Names $RequiredNames
    Assert-Required -Dir $GpuWheels -Names $RequiredNames

    $cpuZip = Join-Path $Out "iopaint-wheels.zip"
    $gpuZip = Join-Path $Out "iopaint-wheels_gpu.zip"
    Write-Host "Packaging CPU zip..." -ForegroundColor Cyan
    New-ZipFromDir -SourceDir $CpuWheels -ZipPath $cpuZip
    Write-Host "Packaging GPU zip + split..." -ForegroundColor Cyan
    New-ZipFromDir -SourceDir $GpuWheels -ZipPath $gpuZip
    New-SplitZip -SourceZip $gpuZip -OutDir $Out -BaseName "iopaint-wheels_gpu.zip" -PartBytes 1800MB
    Remove-Item -LiteralPath $gpuZip -Force

    $p1 = Join-Path $Out "iopaint-wheels_gpu.zip.001"
    $p2 = Join-Path $Out "iopaint-wheels_gpu.zip.002"
    if (-not (Test-Path -LiteralPath $p1) -or -not (Test-Path -LiteralPath $p2)) {
        throw "Expected exactly two GPU split parts (.001/.002)"
    }
    if (Test-Path -LiteralPath (Join-Path $Out "iopaint-wheels_gpu.zip.003")) {
        throw "GPU zip split into 3+ parts — raise PartBytes or shrink bundle"
    }
    Write-Host "Package ready: $cpuZip + GPU .001/.002" -ForegroundColor Green
}

if ($Phase -in @("all", "upload")) {
    $cpuZip = Join-Path $Out "iopaint-wheels.zip"
    $p1 = Join-Path $Out "iopaint-wheels_gpu.zip.001"
    $p2 = Join-Path $Out "iopaint-wheels_gpu.zip.002"
    $lama = Join-Path $Out "big-lama.pt"

    foreach ($f in @($cpuZip, $p1, $p2, $lama)) {
        if (-not (Test-Path -LiteralPath $f)) {
            throw "Missing upload asset: $f (run -Phase all or models+package first)"
        }
    }

    Write-Host "Uploading to $Repo release $Tag ..." -ForegroundColor Cyan
    # Ensure release exists (view failure must not abort under $ErrorActionPreference Stop)
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    gh release view $Tag --repo $Repo 2>$null | Out-Null
    $viewExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($viewExit -ne 0) {
        gh release create $Tag --repo $Repo --title $Tag --notes "MagicEraser LaMa erase-only wheels (cp312)"
        if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }
    }
    gh release upload $Tag $cpuZip $p1 $p2 $lama --repo $Repo --clobber
    if ($LASTEXITCODE -ne 0) { throw "gh release upload failed" }
    Write-Host "Upload complete. Agents with IOPAINT_WHEELS_BUNDLE_REVISION=cp312-lama-v1 will re-download." -ForegroundColor Green
}
