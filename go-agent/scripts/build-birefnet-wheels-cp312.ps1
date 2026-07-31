# Build complete BiRefNet cp312 wheel bundles (CPU + GPU) for library-hub background-remover-lib.
# Offline-ready: prepare = download zip → extract into engine-runtime (no PyPI).
#
# Usage:
#   .\go-agent\scripts\build-birefnet-wheels-cp312.ps1 -Phase all
#   .\go-agent\scripts\build-birefnet-wheels-cp312.ps1 -Phase package
#   .\go-agent\scripts\build-birefnet-wheels-cp312.ps1 -Phase upload
#   .\go-agent\scripts\build-birefnet-wheels-cp312.ps1 -Phase models   # HF code+weights mirror only
#
param(
    [ValidateSet("all", "download", "package", "upload", "models")]
    [string]$Phase = "all",
    [string]$Python = "",
    [string]$Repo = "infohelpful/library-hub",
    [string]$Tag = "background-remover-lib"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $Root "agent\version.py"))) {
    $Root = Split-Path -Parent $PSScriptRoot
}
$Work = Join-Path $Root "go-agent\dist\birefnet-wheels-cp312"
$CpuWheels = Join-Path $Work "cpu\wheels"
$GpuWheels = Join-Path $Work "gpu\wheels"
$ModelsDir = Join-Path $Work "models"
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
        [string]$BaseName = "birefnet-wheels_gpu.zip",
        # GitHub 릴리스 자산 상한은 2GB. 런타임이 .001/.002 두 조각만 기대하므로
        # 총 번들이 3600MB 이하인 동안 2조각으로 유지된다.
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
        } elseif ($name -eq "tokenizers") {
            $keep = $g.Group | Where-Object { $_.Name -like "tokenizers-0.21.*" } | Select-Object -Last 1
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

function Download-HfModelAssets {
    param([string]$DestRoot)
    New-Item -ItemType Directory -Force -Path $DestRoot, $Out | Out-Null
    $models = @(
        @{ Key = "general"; Repo = "ZhengPeng7/BiRefNet"; CodeZip = "birefnet-general-code.zip"; Weights = "birefnet-general-model.safetensors" },
        @{ Key = "hr"; Repo = "ZhengPeng7/BiRefNet_HR"; CodeZip = "birefnet-hr-code.zip"; Weights = "birefnet-hr-model.safetensors" }
    )
    foreach ($m in $models) {
        $dir = Join-Path $DestRoot $m.Key
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Write-Host "Fetching BiRefNet $($m.Key) code from HF..." -ForegroundColor Cyan
        foreach ($file in @("config.json", "birefnet.py", "BiRefNet_config.py")) {
            $url = "https://huggingface.co/$($m.Repo)/resolve/main/$file"
            $dest = Join-Path $dir $file
            Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
        }
        $codeZip = Join-Path $Out $m.CodeZip
        if (Test-Path -LiteralPath $codeZip) { Remove-Item -LiteralPath $codeZip -Force }
        $seven = "C:\Program Files\7-Zip\7z.exe"
        if (Test-Path $seven) {
            & $seven a -tzip -mx=0 -y $codeZip (Join-Path $dir "*") | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "7z code zip failed: $codeZip" }
        } else {
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [System.IO.Compression.ZipFile]::CreateFromDirectory($dir, $codeZip)
        }

        Write-Host "Fetching BiRefNet $($m.Key) weights (large)..." -ForegroundColor Cyan
        $weightUrl = "https://huggingface.co/$($m.Repo)/resolve/main/model.safetensors"
        $weightOut = Join-Path $Out $m.Weights
        Invoke-WebRequest -Uri $weightUrl -OutFile $weightOut -UseBasicParsing
        if ((Get-Item $weightOut).Length -lt 50MB) {
            throw "Weight too small: $weightOut"
        }
    }
    Write-Host "Model assets ready under $Out" -ForegroundColor Green
}

$Py = Resolve-Py $Python
New-Item -ItemType Directory -Force -Path $Out, $CpuWheels, $GpuWheels, $ModelsDir | Out-Null
Write-Host "Work: $Work" -ForegroundColor Cyan
Write-Host "Python: $Py"

# BiRefNet inference deps + torch transitive. Offline complete set.
# huggingface-hub 은 0.x 로 고정 — 1.x 는 httpx 스택을 추가로 요구합니다.
$PipPkgs = @(
    'transformers==4.51.3',
    'tokenizers==0.21.1',
    'huggingface-hub==0.34.4',
    'safetensors',
    'timm==1.0.15',
    'kornia==0.8.0',
    'kornia-rs',
    'einops',
    'numpy==1.26.4',
    'Pillow>=10.0.0',
    'requests',
    'pyyaml',
    'regex',
    'tqdm',
    'packaging',
    'typing_extensions',
    'sympy',
    'mpmath',
    'networkx',
    'jinja2',
    'markupsafe',
    'fsspec',
    'filelock',
    'setuptools',
    # requests / tqdm transitive
    'idna',
    'certifi',
    'charset-normalizer',
    'urllib3',
    'colorama',
    'hf-xet'
)

$RequiredNames = @(
    "transformers", "tokenizers", "huggingface-hub", "safetensors",
    "timm", "kornia", "kornia-rs", "einops", "numpy", "pillow", "requests",
    "pyyaml", "regex", "tqdm", "packaging",
    "typing-extensions", "sympy", "mpmath", "networkx", "jinja2",
    "markupsafe", "fsspec", "filelock", "torch", "torchvision"
)

if ($Phase -in @("all", "models")) {
    Download-HfModelAssets -DestRoot $ModelsDir
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

    # torch CPU
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

    $cpuZip = Join-Path $Out "birefnet-wheels.zip"
    $gpuZip = Join-Path $Out "birefnet-wheels_gpu.zip"
    Write-Host "Packaging CPU zip..." -ForegroundColor Cyan
    New-ZipFromDir -SourceDir $CpuWheels -ZipPath $cpuZip
    Write-Host "Packaging GPU zip + split..." -ForegroundColor Cyan
    New-ZipFromDir -SourceDir $GpuWheels -ZipPath $gpuZip
    New-SplitZip -SourceZip $gpuZip -OutDir $Out -BaseName "birefnet-wheels_gpu.zip" -PartBytes 1800MB
    Remove-Item -LiteralPath $gpuZip -Force

    $p1 = Join-Path $Out "birefnet-wheels_gpu.zip.001"
    $p2 = Join-Path $Out "birefnet-wheels_gpu.zip.002"
    if (-not (Test-Path -LiteralPath $p1) -or -not (Test-Path -LiteralPath $p2)) {
        throw "Expected exactly two GPU split parts (.001/.002)"
    }
    if (Test-Path -LiteralPath (Join-Path $Out "birefnet-wheels_gpu.zip.003")) {
        throw "GPU zip split into 3+ parts — raise PartBytes or shrink bundle"
    }
    Write-Host "Package ready: $cpuZip + GPU .001/.002" -ForegroundColor Green
}

if ($Phase -in @("all", "upload")) {
    $cpuZip = Join-Path $Out "birefnet-wheels.zip"
    $p1 = Join-Path $Out "birefnet-wheels_gpu.zip.001"
    $p2 = Join-Path $Out "birefnet-wheels_gpu.zip.002"
    $generalCode = Join-Path $Out "birefnet-general-code.zip"
    $generalWeights = Join-Path $Out "birefnet-general-model.safetensors"
    $hrCode = Join-Path $Out "birefnet-hr-code.zip"
    $hrWeights = Join-Path $Out "birefnet-hr-model.safetensors"

    foreach ($f in @($cpuZip, $p1, $p2, $generalCode, $generalWeights, $hrCode, $hrWeights)) {
        if (-not (Test-Path -LiteralPath $f)) {
            throw "Missing upload asset: $f (run -Phase all or models+package first)"
        }
    }

    Write-Host "Uploading to $Repo release $Tag ..." -ForegroundColor Cyan
    gh release upload $Tag $cpuZip $p1 $p2 $generalCode $generalWeights $hrCode $hrWeights `
        --repo $Repo --clobber
    if ($LASTEXITCODE -ne 0) { throw "gh release upload failed" }
    Write-Host "Upload complete. Agents with BIREFNET_WHEELS_BUNDLE_REVISION=cp312-complete-v1 will re-download." -ForegroundColor Green
}
