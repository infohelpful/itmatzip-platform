# Build complete CodeFormer cp312 wheel bundles (CPU + GPU) for library-hub image-enhancer-lib.
# Offline-ready: prepare = download zip → extract into engine-runtime (no PyPI).
#
# Usage:
#   .\go-agent\scripts\build-codeformer-wheels-cp312.ps1 -Phase all
#   .\go-agent\scripts\build-codeformer-wheels-cp312.ps1 -Phase package   # zip only (reuse downloads)
#   .\go-agent\scripts\build-codeformer-wheels-cp312.ps1 -Phase upload    # gh release upload
#
param(
    [ValidateSet("all", "download", "package", "upload")]
    [string]$Phase = "all",
    [string]$Python = "",
    [string]$Repo = "infohelpful/library-hub",
    [string]$Tag = "image-enhancer-lib"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $Root "agent\version.py"))) {
    $Root = Split-Path -Parent $PSScriptRoot
}
$Work = Join-Path $Root "go-agent\dist\codeformer-wheels-cp312"
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
        [string]$BaseName = "codeformer-wheels_gpu.zip",
        [int]$PartBytes = 1500MB
    )
    if (-not (Test-Path -LiteralPath $SourceZip)) {
        throw "Source zip missing before split: $SourceZip"
    }
    # Never use Filter "*.zip.*" — can wipe the source zip on some Windows wildcard quirks
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
        # store (-mx=0): wheels already compressed; much faster / safer for multi-GB
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
        ($_.Name -replace '_', '-').Split('-')[0].ToLowerInvariant()
    }
    foreach ($g in $groups) {
        if ($g.Count -le 1) { continue }
        $name = $g.Name
        $keep = $null
        if ($name -eq "sympy") {
            $keep = $g.Group | Where-Object { $_.Name -like "sympy-1.13.1-*" } | Select-Object -First 1
        } elseif ($name -eq "mpmath") {
            $keep = $g.Group | Where-Object { $_.Name -like "mpmath-1.3.0-*" } | Select-Object -First 1
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
    # basicsr = vendor only; tensorboard stack not needed for inference
    $patterns = @(
        "basicsr-*",
        "tb_nightly-*", "tb-nightly-*",
        "tensorboard-*", "tensorboard_data_server-*",
        "grpcio-*", "protobuf-*", "absl_py-*", "absl-py-*",
        "markdown-*", "werkzeug-*"
    )
    foreach ($pat in $patterns) {
        Get-ChildItem $Dir -Filter $pat -ErrorAction SilentlyContinue | Remove-Item -Force
    }
    # drop non-win / non-cp312 / non-pure
    Get-ChildItem $Dir -Filter "*.whl" | ForEach-Object {
        $l = $_.Name.ToLowerInvariant()
        $ok = ($l -match 'py3-none-any') -or ($l -match 'py2\.py3-none-any') -or
              ($l -match 'abi3' -and $l -match 'win_amd64') -or
              ($l -match 'cp312' -and $l -match 'win_amd64')
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

$Py = Resolve-Py $Python
New-Item -ItemType Directory -Force -Path $Out, $CpuWheels, $GpuWheels | Out-Null
Write-Host "Work: $Work" -ForegroundColor Cyan
Write-Host "Python: $Py"

# CodeFormer inference deps (no basicsr — vendor). Include transitive deps for offline.
$PipPkgs = @(
    "facexlib==0.3.0",
    "opencv-python-headless>=4.8.0",
    "lmdb", "pyyaml", "scipy", "tqdm", "yapf", "addict", "future",
    "einops", "lpips", "gdown", "scikit-image", "requests",
    "numpy>=1.26.0,<3", "Pillow>=10.0.0",
    "numba", "matplotlib", "imageio", "tifffile",
    "typing_extensions", "sympy", "mpmath", "networkx", "jinja2",
    "markupsafe", "fsspec", "filelock", "setuptools"
)

$RequiredNames = @(
    "facexlib", "opencv-python-headless", "numpy", "pillow", "scipy",
    "pyyaml", "tqdm", "einops", "lpips", "gdown", "scikit-image",
    "requests", "lmdb", "yapf", "addict", "future",
    "typing-extensions", "sympy", "mpmath", "networkx", "jinja2",
    "markupsafe", "fsspec", "filelock", "filterpy", "torch", "torchvision"
)

function Ensure-FilterpyWheel {
    param([string]$Dir)
    $existing = Get-ChildItem $Dir -Filter "filterpy-*.whl" -ErrorAction SilentlyContinue
    if ($existing) { return }
    # PyPI filterpy is broken sdist-only; use known pure wheel (py3-none-any)
    $url = "https://files.pythonhosted.org/packages/f6/1d/ac8914360460fafa1990890259b7fa5ef7ba4cd59014e782e4ab3ab144d8/filterpy-1.4.5.zip"
    $pi = "https://www.piwheels.org/simple/filterpy/filterpy-1.4.5-py3-none-any.whl"
    $dest = Join-Path $Dir "filterpy-1.4.5-py3-none-any.whl"
    Write-Host "Fetching filterpy pure wheel..." -ForegroundColor Cyan
    try {
        Invoke-WebRequest -Uri $pi -OutFile $dest -UseBasicParsing
    } catch {
        Write-Host "piwheels failed, building wheel from sdist..." -ForegroundColor Yellow
        $tmp = Join-Path $Work "_filterpy_build"
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        $zip = Join-Path $tmp "filterpy-1.4.5.zip"
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        Expand-Archive $zip -DestinationPath $tmp -Force
        $src = Get-ChildItem $tmp -Directory | Where-Object { $_.Name -like "filterpy-*" } | Select-Object -First 1
        if (-not $src) { throw "filterpy sdist extract failed" }
        # Broken setup.py imports filterpy; invent a minimal wheel via zip of package tree
        $pkg = Join-Path $src.FullName "filterpy"
        if (-not (Test-Path $pkg)) { throw "filterpy package dir missing" }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        if (Test-Path $dest) { Remove-Item $dest -Force }
        $stage = Join-Path $tmp "wheel_stage"
        if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $stage | Out-Null
        Copy-Item $pkg $stage -Recurse
        $distInfo = Join-Path $stage "filterpy-1.4.5.dist-info"
        New-Item -ItemType Directory -Force -Path $distInfo | Out-Null
        Set-Content (Join-Path $distInfo "METADATA") @"
Metadata-Version: 2.1
Name: filterpy
Version: 1.4.5
"@ -Encoding UTF8
        Set-Content (Join-Path $distInfo "WHEEL") @"
Wheel-Version: 1.0
Generator: itmatzip-build
Root-Is-Purelib: true
Tag: py3-none-any
"@ -Encoding UTF8
        Set-Content (Join-Path $distInfo "RECORD") "" -Encoding UTF8
        [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $dest)
    }
    if (-not (Test-Path $dest)) { throw "filterpy wheel missing after fetch" }
}

if ($Phase -in @("all", "download")) {
    Write-Host "==> Download shared deps + CPU torch" -ForegroundColor Cyan
    Remove-Item "$CpuWheels\*" -Force -ErrorAction SilentlyContinue
    & $Py -m pip download --dest $CpuWheels --only-binary=:all: --no-deps `
        --python-version 312 --platform win_amd64 `
        @PipPkgs
    if ($LASTEXITCODE -ne 0) { throw "pip download deps failed" }
    Ensure-FilterpyWheel $CpuWheels
    # pull remaining pure/binary deps that pip would resolve (without filterpy sdist)
    & $Py -m pip download --dest $CpuWheels --only-binary=:all: --no-deps `
        --python-version 312 --platform win_amd64 `
        contourpy cycler fonttools kiwisolver packaging pyparsing python-dateutil six `
        lazy-loader charset-normalizer idna urllib3 certifi beautifulsoup4 soupsieve `
        colorama platformdirs PySocks llvmlite
    if ($LASTEXITCODE -ne 0) { throw "pip download transitive deps failed" }
    & $Py -m pip download --dest $CpuWheels --only-binary=:all: --python-version 312 --platform win_amd64 `
        --index-url https://download.pytorch.org/whl/cpu `
        "torch==2.6.0+cpu" "torchvision==0.21.0+cpu"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "CPU pin failed, trying unpinned cpu index..." -ForegroundColor Yellow
        & $Py -m pip download --dest $CpuWheels --only-binary=:all: --python-version 312 --platform win_amd64 `
            --index-url https://download.pytorch.org/whl/cpu `
            torch torchvision
        if ($LASTEXITCODE -ne 0) { throw "CPU torch download failed" }
    }
    Remove-JunkWheels $CpuWheels
    Remove-WrongTorch -Dir $CpuWheels -Variant cpu
    Dedup-Wheels $CpuWheels
    Assert-Required $CpuWheels $RequiredNames
    Write-Host "CPU wheels: $((Get-ChildItem $CpuWheels -Filter *.whl).Count) files" -ForegroundColor Green

    Write-Host "==> GPU set = copy deps + CUDA torch" -ForegroundColor Cyan
    Remove-Item "$GpuWheels\*" -Force -ErrorAction SilentlyContinue
    Copy-Item "$CpuWheels\*" $GpuWheels -Force
    # remove CPU torch from GPU folder
    Remove-WrongTorch -Dir $GpuWheels -Variant gpu
    Get-ChildItem $GpuWheels -Filter "torch*.whl" -ErrorAction SilentlyContinue | Remove-Item -Force
    & $Py -m pip download --dest $GpuWheels --only-binary=:all: --python-version 312 --platform win_amd64 `
        --index-url https://download.pytorch.org/whl/cu124 `
        "torch==2.6.0+cu124" "torchvision==0.21.0+cu124"
    if ($LASTEXITCODE -ne 0) {
        & $Py -m pip download --dest $GpuWheels --only-binary=:all: --python-version 312 --platform win_amd64 `
            --index-url https://download.pytorch.org/whl/cu124 `
            torch torchvision
        if ($LASTEXITCODE -ne 0) { throw "GPU torch download failed" }
    }
    Remove-JunkWheels $GpuWheels
    Remove-WrongTorch -Dir $GpuWheels -Variant gpu
    Dedup-Wheels $GpuWheels
    Assert-Required $GpuWheels $RequiredNames
    Write-Host "GPU wheels: $((Get-ChildItem $GpuWheels -Filter *.whl).Count) files" -ForegroundColor Green
}

if ($Phase -in @("all", "package")) {
    Write-Host "==> Packaging codeformer-wheels.zip (CPU)" -ForegroundColor Cyan
    $cpuZip = Join-Path $Out "codeformer-wheels.zip"
    Assert-Required $CpuWheels $RequiredNames
    New-ZipFromDir -SourceDir $CpuWheels -ZipPath $cpuZip
    Write-Host "CPU zip: $cpuZip ($([math]::Round((Get-Item -LiteralPath $cpuZip).Length/1MB,1)) MB)"

    Write-Host "==> Packaging codeformer-wheels_gpu.zip + split" -ForegroundColor Cyan
    $gpuZip = Join-Path $Out "codeformer-wheels_gpu.zip"
    Assert-Required $GpuWheels $RequiredNames
    New-ZipFromDir -SourceDir $GpuWheels -ZipPath $gpuZip
    Write-Host "GPU zip: $gpuZip ($([math]::Round((Get-Item -LiteralPath $gpuZip).Length/1MB,1)) MB)"
    New-SplitZip -SourceZip $gpuZip -OutDir $Out -BaseName "codeformer-wheels_gpu.zip" -PartBytes (1500MB)
    # keep parts for upload; drop merged gpu zip to save disk (optional)
    Remove-Item -LiteralPath $gpuZip -Force -ErrorAction SilentlyContinue
    Get-ChildItem $Out | Select-Object Name, @{N = 'MB'; E = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table -AutoSize
}

if ($Phase -in @("all", "upload")) {
    $cpuZip = Join-Path $Out "codeformer-wheels.zip"
    $p1 = Join-Path $Out "codeformer-wheels_gpu.zip.001"
    $p2 = Join-Path $Out "codeformer-wheels_gpu.zip.002"
    foreach ($f in @($cpuZip, $p1, $p2)) {
        if (-not (Test-Path $f)) { throw "Missing asset for upload: $f (run -Phase package first)" }
    }
    Write-Host "==> Upload to $Repo release $Tag (clobber)" -ForegroundColor Cyan
    gh release upload $Tag $cpuZip $p1 $p2 --repo $Repo --clobber
    if ($LASTEXITCODE -ne 0) { throw "gh release upload failed" }
    Write-Host "Uploaded. Agents with CODEFORMER_WHEELS_BUNDLE_REVISION=cp312-complete-v2 will re-download." -ForegroundColor Green
}

Write-Host "Done." -ForegroundColor Green
