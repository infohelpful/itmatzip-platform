# Build Seed-VC (Voice Changer) cp312 wheel + source + model assets for library-hub voice-changer-lib.
# Offline-ready: prepare = download zip from hub → extract into engine-runtime (no PyPI/HF).
#
# Usage:
#   .\go-agent\scripts\build-seedvc-wheels-cp312.ps1 -Phase all
#   .\go-agent\scripts\build-seedvc-wheels-cp312.ps1 -Phase models
#   .\go-agent\scripts\build-seedvc-wheels-cp312.ps1 -Phase source
#   .\go-agent\scripts\build-seedvc-wheels-cp312.ps1 -Phase download
#   .\go-agent\scripts\build-seedvc-wheels-cp312.ps1 -Phase package
#   .\go-agent\scripts\build-seedvc-wheels-cp312.ps1 -Phase upload
#
param(
    [ValidateSet("all", "download", "package", "upload", "models", "source")]
    [string]$Phase = "all",
    [string]$Python = "",
    [string]$Repo = "infohelpful/library-hub",
    [string]$Tag = "voice-changer-lib"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $Root "agent\version.py"))) {
    $Root = Split-Path -Parent $PSScriptRoot
}
$Work = Join-Path $Root "go-agent\dist\seedvc-wheels-cp312"
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
        [string]$BaseName = "seedvc-wheels_gpu.zip",
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

function Download-SeedVcSource {
    param([string]$DestZip)
    $url = "https://github.com/Plachtaa/seed-vc/archive/refs/heads/main.zip"
    New-Item -ItemType Directory -Force -Path (Split-Path $DestZip -Parent) | Out-Null
    Write-Host "Downloading Seed-VC source..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $url -OutFile $DestZip -UseBasicParsing
    if ((Get-Item $DestZip).Length -lt 100KB) {
        throw "Seed-VC source zip too small: $DestZip"
    }
    # Normalize name for hub asset
    $hubName = Join-Path (Split-Path $DestZip -Parent) "seedvc-source.zip"
    if ($DestZip -ne $hubName) {
        Copy-Item -LiteralPath $DestZip -Destination $hubName -Force
    }
    Write-Host "Seed-VC source ready: $hubName" -ForegroundColor Green
}

function Download-SeedVcModels {
    param([string]$OutDir)
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $assets = @(
        @{
            Url = "https://huggingface.co/Plachta/Seed-VC/resolve/main/DiT_seed_v2_uvit_whisper_small_wavenet_bigvgan_pruned.pth"
            Name = "DiT_seed_v2_uvit_whisper_small_wavenet_bigvgan_pruned.pth"
            MinMB = 80
        },
        @{
            Url = "https://huggingface.co/Plachta/Seed-VC/resolve/main/config_dit_mel_seed_uvit_whisper_small_wavenet.yml"
            Name = "config_dit_mel_seed_uvit_whisper_small_wavenet.yml"
            MinMB = 0
        },
        @{
            Url = "https://huggingface.co/funasr/campplus/resolve/main/campplus_cn_common.bin"
            Name = "campplus_cn_common.bin"
            MinMB = 10
        }
    )
    foreach ($a in $assets) {
        $dest = Join-Path $OutDir $a.Name
        Write-Host "Downloading $($a.Name) ..." -ForegroundColor Cyan
        Invoke-WebRequest -Uri $a.Url -OutFile $dest -UseBasicParsing
        $mb = (Get-Item $dest).Length / 1MB
        if ($a.MinMB -gt 0 -and $mb -lt $a.MinMB) {
            throw "Asset too small: $dest ($([math]::Round($mb,1)) MB)"
        }
        Write-Host "  OK $([math]::Round($mb,1)) MB" -ForegroundColor Green
    }
    # Bundle models into one zip for simpler hub asset
    $modelsZip = Join-Path $OutDir "seedvc-models.zip"
    if (Test-Path -LiteralPath $modelsZip) { Remove-Item -LiteralPath $modelsZip -Force }
    $seven = "C:\Program Files\7-Zip\7z.exe"
    if (Test-Path $seven) {
        Push-Location $OutDir
        try {
            & $seven a -tzip -mx=0 -y $modelsZip `
                "DiT_seed_v2_uvit_whisper_small_wavenet_bigvgan_pruned.pth" `
                "config_dit_mel_seed_uvit_whisper_small_wavenet.yml" `
                "campplus_cn_common.bin"
            if ($LASTEXITCODE -ne 0) { throw "7z models zip failed" }
        } finally {
            Pop-Location
        }
    } else {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $tmp = Join-Path $OutDir "_models_staging"
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        Copy-Item (Join-Path $OutDir "DiT_seed_v2_uvit_whisper_small_wavenet_bigvgan_pruned.pth") $tmp
        Copy-Item (Join-Path $OutDir "config_dit_mel_seed_uvit_whisper_small_wavenet.yml") $tmp
        Copy-Item (Join-Path $OutDir "campplus_cn_common.bin") $tmp
        [System.IO.Compression.ZipFile]::CreateFromDirectory($tmp, $modelsZip)
        Remove-Item -Recurse -Force $tmp
    }
    Write-Host "Models zip ready: $modelsZip" -ForegroundColor Green
}

$Py = Resolve-Py $Python
New-Item -ItemType Directory -Force -Path $Out, $CpuWheels, $GpuWheels | Out-Null
Write-Host "Work: $Work" -ForegroundColor Cyan
Write-Host "Python: $Py"

# Seed-VC inference deps (no Gradio/GUI). Include common transitive wheels for offline extract.
$PipPkgs = @(
    'accelerate',
    'scipy',
    'librosa==0.10.2',
    'huggingface-hub==0.34.4',
    'munch==4.0.0',
    'einops==0.8.0',
    'descript-audio-codec==1.0.0',
    'descript-audiotools',
    'randomname',
    'argbind',
    'pydub==0.25.1',
    'soundfile==0.12.1',
    'transformers==4.46.3',
    'numpy==1.26.4',
    'hydra-core==1.3.2',
    'pyyaml',
    'python-dotenv',
    'tqdm',
    'resemblyzer',
    'tokenizers',
    'safetensors',
    'regex',
    'packaging',
    'requests',
    'idna',
    'certifi',
    'charset-normalizer',
    'urllib3',
    'colorama',
    'filelock',
    'fsspec',
    'typing_extensions',
    'sympy',
    'mpmath',
    'networkx',
    'jinja2',
    'markupsafe',
    'setuptools',
    'audioread',
    'soxr',
    'lazy_loader',
    'decorator',
    'joblib',
    'threadpoolctl',
    'scikit-learn',
    'numba',
    'llvmlite',
    'msgpack',
    'platformdirs',
    'pooch',
    'omegaconf',
    'antlr4-python3-runtime',
    'Pillow',
    'hf-xet'
)

function Convert-SdistsToWheels {
    param([string]$Dir, [string]$PythonExe)
    $sdists = @(Get-ChildItem $Dir -Filter "*.tar.gz" -ErrorAction SilentlyContinue)
    foreach ($sdist in $sdists) {
        # webrtcvad needs MSVC — skip; not required for Seed-VC inference path
        if ($sdist.Name -match '^webrtcvad') {
            Write-Host "Skip sdist (needs MSVC): $($sdist.Name)" -ForegroundColor Yellow
            continue
        }
        Write-Host "Building wheel from $($sdist.Name) ..." -ForegroundColor Cyan
        & $PythonExe -m pip wheel --no-deps -w $Dir $sdist.FullName
        if ($LASTEXITCODE -ne 0) {
            Write-Host "WARNING: pip wheel failed for $($sdist.Name) — continuing" -ForegroundColor Yellow
        }
    }
}

$RequiredNames = @(
    "torch", "torchvision", "torchaudio",
    "transformers", "huggingface-hub", "librosa", "soundfile",
    "einops", "munch", "numpy", "scipy", "pyyaml", "tqdm",
    "accelerate", "hydra-core", "descript-audio-codec", "randomname"
)

if ($Phase -in @("all", "source")) {
    Download-SeedVcSource -DestZip (Join-Path $Out "seed-vc-main.zip")
    if ($Phase -eq "source") {
        Write-Host "Source-only phase done." -ForegroundColor Green
        exit 0
    }
}

if ($Phase -in @("all", "models")) {
    Download-SeedVcModels -OutDir $Out
    if ($Phase -eq "models") {
        Write-Host "Models-only phase done." -ForegroundColor Green
        exit 0
    }
}

if ($Phase -in @("all", "download")) {
    Write-Host "Downloading CPU package wheels (with deps where needed)..." -ForegroundColor Cyan
    # Prefer binaries; allow sdist for pure-python pkgs like munch if needed
    & $Py -m pip download --python-version 312 --platform win_amd64 `
        -d $CpuWheels @PipPkgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Strict platform download failed; retrying without platform pin for pure-python..." -ForegroundColor Yellow
        & $Py -m pip download -d $CpuWheels @PipPkgs
        if ($LASTEXITCODE -ne 0) { throw "pip download packages failed" }
    }

    & $Py -m pip download --only-binary=:all: --no-deps --python-version 312 --platform win_amd64 `
        -d $CpuWheels --index-url https://download.pytorch.org/whl/cpu `
        "torch==2.7.1+cpu" "torchvision==0.22.1+cpu" "torchaudio==2.7.1+cpu"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Pinned torch CPU failed, retrying unpinned..." -ForegroundColor Yellow
        & $Py -m pip download --only-binary=:all: --no-deps --python-version 312 --platform win_amd64 `
            -d $CpuWheels --index-url https://download.pytorch.org/whl/cpu torch torchvision torchaudio
        if ($LASTEXITCODE -ne 0) { throw "pip download torch CPU failed" }
    }

    Convert-SdistsToWheels -Dir $CpuWheels -PythonExe $Py
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
        "torch==2.7.1+cu128" "torchvision==0.22.1+cu128" "torchaudio==2.7.1+cu128"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Pinned torch cu128 failed, retrying unpinned..." -ForegroundColor Yellow
        & $Py -m pip download --only-binary=:all: --no-deps --python-version 312 --platform win_amd64 `
            -d $GpuWheels --index-url https://download.pytorch.org/whl/cu128 torch torchvision torchaudio
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

    $cpuZip = Join-Path $Out "seedvc-wheels.zip"
    $gpuZip = Join-Path $Out "seedvc-wheels_gpu.zip"
    Write-Host "Packaging CPU zip..." -ForegroundColor Cyan
    New-ZipFromDir -SourceDir $CpuWheels -ZipPath $cpuZip
    Write-Host "Packaging GPU zip + split..." -ForegroundColor Cyan
    New-ZipFromDir -SourceDir $GpuWheels -ZipPath $gpuZip
    New-SplitZip -SourceZip $gpuZip -OutDir $Out -BaseName "seedvc-wheels_gpu.zip" -PartBytes 1800MB
    Remove-Item -LiteralPath $gpuZip -Force

    $p1 = Join-Path $Out "seedvc-wheels_gpu.zip.001"
    $p2 = Join-Path $Out "seedvc-wheels_gpu.zip.002"
    if (-not (Test-Path -LiteralPath $p1) -or -not (Test-Path -LiteralPath $p2)) {
        throw "Expected exactly two GPU split parts (.001/.002). Check part count under $Out"
    }
    if (Test-Path -LiteralPath (Join-Path $Out "seedvc-wheels_gpu.zip.003")) {
        Write-Host "WARNING: GPU zip split into 3+ parts — upload all parts or raise PartBytes" -ForegroundColor Yellow
    }
    Write-Host "Package ready: $cpuZip + GPU parts" -ForegroundColor Green
}

if ($Phase -in @("all", "upload")) {
    $cpuZip = Join-Path $Out "seedvc-wheels.zip"
    $p1 = Join-Path $Out "seedvc-wheels_gpu.zip.001"
    $p2 = Join-Path $Out "seedvc-wheels_gpu.zip.002"
    $sourceZip = Join-Path $Out "seedvc-source.zip"
    $modelsZip = Join-Path $Out "seedvc-models.zip"

    $required = @($cpuZip, $p1, $p2, $sourceZip, $modelsZip)
    foreach ($f in $required) {
        if (-not (Test-Path -LiteralPath $f)) {
            throw "Missing upload asset: $f (run -Phase all first)"
        }
    }

    $extraParts = @()
    3..9 | ForEach-Object {
        $p = Join-Path $Out ("seedvc-wheels_gpu.zip.{0:D3}" -f $_)
        if (Test-Path -LiteralPath $p) { $extraParts += $p }
    }

    Write-Host "Uploading to $Repo release $Tag ..." -ForegroundColor Cyan
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    gh release view $Tag --repo $Repo 2>$null | Out-Null
    $viewExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($viewExit -ne 0) {
        gh release create $Tag --repo $Repo --title $Tag --notes "Voice Changer Seed-VC wheels + source + models (cp312)"
        if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }
    }
    $upload = @($cpuZip, $p1, $p2, $sourceZip, $modelsZip) + $extraParts
    gh release upload $Tag @upload --repo $Repo --clobber
    if ($LASTEXITCODE -ne 0) { throw "gh release upload failed" }
    Write-Host "Upload complete. Agents with SEEDVC_WHEELS_BUNDLE_REVISION=cp312-seedvc-v1 will re-download." -ForegroundColor Green
}
