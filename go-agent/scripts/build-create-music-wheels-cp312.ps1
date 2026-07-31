# Build complete Create Music (ACE-Step) cp312+cu128 wheel bundle for library-hub Create_Music_Lib.
# Offline-ready: prepare = download split zip → extract into engine-runtime/create-music (no PyPI).
#
# Usage:
#   .\go-agent\scripts\build-create-music-wheels-cp312.ps1 -Phase all
#   .\go-agent\scripts\build-create-music-wheels-cp312.ps1 -Phase package
#   .\go-agent\scripts\build-create-music-wheels-cp312.ps1 -Phase upload
#
param(
    [ValidateSet("all", "download", "package", "upload")]
    [string]$Phase = "all",
    [string]$Python = "",
    [string]$Repo = "infohelpful/library-hub",
    [string]$Tag = "Create_Music_Lib"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $Root "agent\version.py"))) {
    $Root = Split-Path -Parent $PSScriptRoot
}
$Work = Join-Path $Root "go-agent\dist\create-music-wheels-cp312"
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
    throw "Python 3.12 not found"
}

function New-SplitZip {
    param(
        [string]$SourceZip,
        [string]$OutDir,
        [string]$BaseName = "wheels_create_music.zip",
        [int]$PartBytes = 1500MB
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

function Remove-JunkWheels {
    param([string]$Dir)
    Get-ChildItem $Dir -Filter "*.whl" | ForEach-Object {
        $l = $_.Name.ToLowerInvariant()
        # Keep pure/any + win_amd64 (incl. py2.py3-none-win_amd64 e.g. soundfile)
        $ok = ($l -match 'py3-none-any') -or ($l -match 'py2\.py3-none-any') -or
              ($l -match 'none-win_amd64') -or
              ($l -match 'abi3' -and $l -match 'win_amd64') -or
              ($l -match 'cp312' -and $l -match 'win_amd64')
        if (-not $ok) { Remove-Item $_.FullName -Force }
    }
}

function Dedup-Wheels {
    param([string]$Dir)
    $groups = Get-ChildItem $Dir -Filter "*.whl" | Group-Object {
        ($_.Name -replace '_', '-').Split('-')[0].ToLowerInvariant()
    }
    foreach ($g in $groups) {
        if ($g.Count -le 1) { continue }
        $keep = $g.Group | Sort-Object Name | Select-Object -Last 1
        foreach ($f in $g.Group) {
            if ($f.FullName -ne $keep.FullName) { Remove-Item $f.FullName -Force }
        }
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
New-Item -ItemType Directory -Force -Path $Out, $GpuWheels | Out-Null
Write-Host "Work: $Work" -ForegroundColor Cyan
Write-Host "Python: $Py"

# ACE-Step runtime deps (no acestep editable — source path inject)
$PipPkgs = @(
    'safetensors==0.7.0',
    'transformers>=4.51.0,<4.58.0',
    'diffusers>=0.37.0',
    'matplotlib>=3.7.5',
    'scipy>=1.10.1',
    'soundfile>=0.13.1',
    'loguru>=0.7.3',
    'einops>=0.8.1',
    'accelerate>=1.12.0',
    'fastapi>=0.110.0',
    'diskcache',
    'uvicorn[standard]>=0.27.0',
    'numba>=0.63.1',
    'vector-quantize-pytorch>=1.27.15',
    'torchcodec>=0.9.1',
    'torchao>=0.16.0,<0.17.0',
    'toml',
    'modelscope',
    'peft>=0.18.0',
    'setuptools<72',
    'huggingface_hub>=0.34.0,<1.0',
    'sentencepiece',
    'tokenizers==0.22.1',
    'modelscope',
    'modelscope_hub',
    'protobuf',
    'tqdm',
    'pyyaml',
    'omegaconf',
    'librosa',
    'av',
    'numpy',
    'Pillow',
    'typing_extensions', 'sympy', 'mpmath', 'networkx', 'jinja2',
    'markupsafe', 'fsspec', 'filelock',
    'requests', 'packaging', 'regex', 'tokenizers',
    'xxhash'
)

$RequiredNames = @(
    "torch", "torchvision", "torchaudio",
    "safetensors", "transformers", "diffusers", "numpy", "scipy",
    "soundfile", "cffi", "pycparser", "loguru", "einops", "accelerate", "huggingface-hub",
    "httpx", "httpcore", "win32-setctime", "tokenizers", "modelscope-hub",
    "einx", "frozendict", "vector-quantize-pytorch",
    "modelscope", "peft", "sentencepiece", "librosa", "av",
    "typing-extensions", "sympy", "jinja2", "filelock"
)

if ($Phase -in @("all", "download")) {
    Write-Host "==> Download ACE-Step runtime deps (no-deps)" -ForegroundColor Cyan
    Remove-Item "$GpuWheels\*" -Force -ErrorAction SilentlyContinue
    & $Py -m pip download --dest $GpuWheels --only-binary=:all: --no-deps `
        --python-version 312 --platform win_amd64 `
        @PipPkgs
    if ($LASTEXITCODE -ne 0) { throw "pip download deps failed" }

    # Transitive common deps
    & $Py -m pip download --dest $GpuWheels --only-binary=:all: --no-deps `
        --python-version 312 --platform win_amd64 `
        contourpy cycler fonttools kiwisolver pyparsing python-dateutil six `
        charset-normalizer idna urllib3 certifi anyio starlette h11 httptools `
        httpcore httpx sniffio win32_setctime `
        watchfiles websockets click pydantic annotated-types pydantic-core `
        llvmlite audioread soxr lazy-loader platformdirs colorama `
        importlib-metadata zipp hf-xet cffi pycparser `
        einx frozendict
    # ignore failures on some pure extras
    Write-Host "Transitive download done (best-effort)" -ForegroundColor DarkGray

    # Drop any non-cu128 torch that transitive/pip may have pulled
    Get-ChildItem $GpuWheels -Filter "torch-*.whl" | Where-Object {
        $_.Name -notmatch 'cu128'
    } | ForEach-Object {
        Write-Host ("Removing non-cu128 torch: {0}" -f $_.Name) -ForegroundColor Yellow
        Remove-Item $_.FullName -Force
    }

    Write-Host "==> CUDA 12.8 torch stack" -ForegroundColor Cyan
    & $Py -m pip download --dest $GpuWheels --only-binary=:all: --python-version 312 --platform win_amd64 `
        --index-url https://download.pytorch.org/whl/cu128 `
        "torch==2.7.1+cu128" "torchvision==0.22.1+cu128" "torchaudio==2.7.1+cu128"
    if ($LASTEXITCODE -ne 0) {
        & $Py -m pip download --dest $GpuWheels --only-binary=:all: --python-version 312 --platform win_amd64 `
            --index-url https://download.pytorch.org/whl/cu128 `
            torch torchvision torchaudio
        if ($LASTEXITCODE -ne 0) { throw "CUDA torch download failed" }
    }

    # Optional flash-attn (may fail - not required)
    $flash = 'https://huggingface.co/lldacing/flash-attention-windows-wheel/resolve/main/flash_attn-2.7.4.post1+cu128torch2.7.0cxx11abiFALSE-cp312-cp312-win_amd64.whl'
    try {
        $destFlash = Join-Path $GpuWheels (Split-Path $flash -Leaf)
        if (-not (Test-Path $destFlash)) {
            Write-Host 'Fetching optional flash-attn...' -ForegroundColor Cyan
            Invoke-WebRequest -Uri $flash -OutFile $destFlash -UseBasicParsing
        }
    } catch {
        Write-Host 'flash-attn optional skip' -ForegroundColor Yellow
    }

    # Optional triton-windows
    try {
        & $Py -m pip download --dest $GpuWheels --only-binary=:all: --no-deps `
            --python-version 312 --platform win_amd64 'triton-windows>=3.2.0,<3.7'
    } catch {
        Write-Host 'triton-windows optional skip' -ForegroundColor Yellow
    }

    Remove-JunkWheels $GpuWheels
    Dedup-Wheels $GpuWheels
    Assert-Required $GpuWheels $RequiredNames
    $whlCount = (Get-ChildItem $GpuWheels -Filter *.whl).Count
    Write-Host "GPU wheels: $whlCount files" -ForegroundColor Green
}

if ($Phase -in @('all', 'package')) {
    Write-Host '==> Packaging wheels_create_music.zip + split' -ForegroundColor Cyan
    Assert-Required $GpuWheels $RequiredNames
    $gpuZip = Join-Path $Out 'wheels_create_music.zip'
    New-ZipFromDir -SourceDir $GpuWheels -ZipPath $gpuZip
    $gpuMb = [math]::Round((Get-Item -LiteralPath $gpuZip).Length / 1MB, 1)
    Write-Host ('GPU zip: {0} ({1} MB)' -f $gpuZip, $gpuMb)
    New-SplitZip -SourceZip $gpuZip -OutDir $Out -BaseName 'wheels_create_music.zip' -PartBytes (1900MB)
    Remove-Item -LiteralPath $gpuZip -Force -ErrorAction SilentlyContinue
    Get-ChildItem $Out | Select-Object Name, @{N = 'MB'; E = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table -AutoSize
}

if ($Phase -in @('all', 'upload')) {
    $p1 = Join-Path $Out 'wheels_create_music.zip.001'
    $p2 = Join-Path $Out 'wheels_create_music.zip.002'
    foreach ($f in @($p1, $p2)) {
        if (-not (Test-Path $f)) { throw "Missing asset for upload: $f (run -Phase package first)" }
    }
    $parts = Get-ChildItem $Out -Filter 'wheels_create_music.zip.*' | Sort-Object Name
    Write-Host "==> Upload to $Repo release $Tag (clobber)" -ForegroundColor Cyan
    gh release upload $Tag ($parts.FullName) --repo $Repo --clobber
    if ($LASTEXITCODE -ne 0) { throw 'gh release upload failed' }
    Write-Host 'Uploaded. Agents with CREATE_MUSIC_WHEELS_BUNDLE_REVISION=cp312-cu128-complete-v3 will re-download.' -ForegroundColor Green
}

Write-Host 'Done.' -ForegroundColor Green
