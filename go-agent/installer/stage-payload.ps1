# Stage MSI payload: Go exe, Python venv (engine), python_worker scripts
param(
    [switch]$SkipEngine,
    [switch]$SkipAgent,
    [switch]$UseEmbeddable,
    [string]$Python = "python",
    [string]$EmbeddableVersion = "3.12.10"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. (Join-Path $PSScriptRoot "archive-compat.ps1")
$Root = Split-Path -Parent $PSScriptRoot
$Staging = Join-Path $Root "dist\staging"
$EngineDir = Join-Path $Staging "engine"
$WorkerSrc = Join-Path $Root "python_worker"
$WorkerDst = Join-Path $Staging "python_worker"
$AgentDst = Join-Path $Staging "agent"
$ModelsDir = Join-Path $Staging "models"
$ExePath = Join-Path $Root "itmatzip-agent.exe"
$CacheDir = Join-Path $Root "dist\cache"
$InstallerDir = Join-Path $Root "installer"
$EngineReq = Join-Path $InstallerDir "engine-requirements.txt"
$WorkerReq = Join-Path $WorkerSrc "requirements.txt"
$AgentReq = Join-Path $InstallerDir "agent-requirements.txt"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

function Install-EmbeddableEngine {
    param(
        [string]$TargetDir,
        [string]$Version,
        [string]$RequirementsFile
    )
    New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
    $zipName = "python-$Version-embed-amd64.zip"
    $zipPath = Join-Path $CacheDir $zipName
    $url = "https://www.python.org/ftp/python/$Version/$zipName"

    if (-not (Test-Path $zipPath)) {
        Write-Step "Downloading embeddable Python $Version"
        Invoke-WebRequest -Uri $url -OutFile $zipPath
    }

    Write-Step "Extracting embeddable Python to $TargetDir"
    if (Test-Path $TargetDir) {
        Remove-Item -Recurse -Force $TargetDir
    }
    Expand-ArchiveCompat -Path $zipPath -DestinationPath $TargetDir

    $pthFiles = Get-ChildItem -Path $TargetDir -Filter "python*._pth"
    foreach ($pth in $pthFiles) {
        $content = Get-Content $pth.FullName | ForEach-Object {
            if ($_ -match '^#\s*import site') { 'import site' } else { $_ }
        }
        Set-Content -Path $pth.FullName -Value $content -Encoding ASCII
    }

    $enginePython = Join-Path $TargetDir "python.exe"
    $getPip = Join-Path $CacheDir "get-pip.py"
    if (-not (Test-Path $getPip)) {
        Write-Step "Downloading get-pip.py"
        Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPip
    }

    Write-Step "Bootstrapping pip in embeddable Python"
    $env:PYTHONNOUSERSITE = "1"
    & $enginePython $getPip --no-warn-script-location

    Write-Step "Installing engine requirements into embeddable Python"
    & $enginePython -m pip install -r $RequirementsFile
    Remove-Item Env:PYTHONNOUSERSITE -ErrorAction SilentlyContinue
}

function Resolve-BuildPython {
    param([string]$EmbeddableVersion)
    $candidates = @()
    if ($env:ITMATZIP_BUILD_PYTHON) {
        $candidates += $env:ITMATZIP_BUILD_PYTHON
    }
    $majorMinor = ($EmbeddableVersion -split '\.')[0..1] -join ''
    $candidates += @(
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python$majorMinor\python.exe"),
        (Join-Path $env:ProgramFiles "Python$majorMinor\python.exe")
    )
    foreach ($path in $candidates) {
        if ($path -and (Test-Path $path)) {
            return $path
        }
    }
    return $null
}

function Build-DiffqVendorWheel {
    param(
        [string]$EngineDir,
        [string]$EmbeddableVersion
    )
    $vendorDir = Join-Path $EngineDir "vendor-wheels"
    New-Item -ItemType Directory -Force -Path $vendorDir | Out-Null
    $existing = Get-ChildItem $vendorDir -Filter "diffq-*-cp312*.whl" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $existing) {
        $existing = Get-ChildItem $vendorDir -Filter "diffq-*.whl" -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match 'cp312' } |
            Select-Object -First 1
    }
    if ($existing) {
        Write-Host "vendor diffq wheel already present: $($existing.Name)"
        return
    }

    # Prefer a prebuilt cp312 wheel — sdist needs MSVC (Python.h + C++ Build Tools).
    $prebuiltCandidates = @(
        (Join-Path $Root "dist\vocal-wheels-cp312\cpu\wheels"),
        (Join-Path $Root "dist\vocal-wheels-cp312\gpu\wheels"),
        (Join-Path $CacheDir "diffq-prebuilt"),
        (Join-Path $env:LOCALAPPDATA "ItMatZip\engine-runtime\vocal-remover\Lib\site-packages")
    )
    foreach ($dir in $prebuiltCandidates) {
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        $hit = Get-ChildItem -LiteralPath $dir -Filter "diffq-*-cp312*.whl" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($hit) {
            Write-Step "Copying prebuilt diffq wheel: $($hit.FullName)"
            Copy-Item -LiteralPath $hit.FullName -Destination (Join-Path $vendorDir $hit.Name) -Force
            return
        }
    }

    $buildPython = Resolve-BuildPython -EmbeddableVersion $EmbeddableVersion
    if (-not $buildPython) {
        throw (
            "Full Python $EmbeddableVersion is required to build the diffq cp312 wheel (embeddable Python has no Python.h)." + [char]10 +
            "  - Place a prebuilt diffq-*-cp312*.whl under go-agent\dist\vocal-wheels-cp312\cpu\wheels, or" + [char]10 +
            "  - Install Python $EmbeddableVersion + Visual C++ Build Tools and rebuild, or" + [char]10 +
            "  - Set env var ITMATZIP_BUILD_PYTHON to python.exe"
        )
    }

    $wheelZip = Join-Path $CacheDir "v1.0.4-wheel.zip"
    if (-not (Test-Path $wheelZip)) {
        Write-Step "Downloading v1.0.4 wheel.zip for diffq sdist"
        Invoke-WebRequest -Uri "https://github.com/infohelpful/library-hub/releases/download/VocalRemover-Lib/wheel.zip" -OutFile $wheelZip
    }
    $extractDir = Join-Path $CacheDir "wheel-zip-extract"
    if (-not (Test-Path (Join-Path $extractDir "diffq-0.2.4.tar.gz"))) {
        if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
        Expand-ArchiveCompat -Path $wheelZip -DestinationPath $extractDir -Force
    }
    # Prefer .whl inside the zip if present (newer hub assets)
    $diffqWhl = Get-ChildItem $extractDir -Recurse -Filter "diffq-*-cp312*.whl" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($diffqWhl) {
        Write-Step "Using diffq wheel from VocalRemover-Lib wheel.zip: $($diffqWhl.Name)"
        Copy-Item -LiteralPath $diffqWhl.FullName -Destination (Join-Path $vendorDir $diffqWhl.Name) -Force
        return
    }
    $diffqTar = Get-ChildItem $extractDir -Recurse -Filter "diffq-*.tar.gz" | Select-Object -First 1
    if (-not $diffqTar) {
        throw "diffq tar.gz not found inside v1.0.4 wheel.zip"
    }

    Write-Step "Building diffq vendor wheel with $buildPython (MSI runtime용 cp312 win_amd64)"
    $env:PYTHONNOUSERSITE = "1"
    & $buildPython -m pip wheel $diffqTar.FullName -w $vendorDir --no-deps
    Remove-Item Env:PYTHONNOUSERSITE -ErrorAction SilentlyContinue
    if (-not (Get-ChildItem $vendorDir -Filter "diffq-*-cp312*.whl" -ErrorAction SilentlyContinue)) {
        throw (
            "diffq vendor wheel build failed (usually missing Microsoft Visual C++ Build Tools)." + [char]10 +
            "  Fix: copy go-agent\dist\vocal-wheels-cp312\cpu\wheels\diffq-*-cp312*.whl into the staging engine\vendor-wheels, or install VS C++ Build Tools and retry."
        )
    }
}

function Copy-AgentSource {
    param(
        [string]$RepoRoot,
        [string]$TargetDir
    )
    $agentSrc = Join-Path (Split-Path -Parent $RepoRoot) "agent"
    if (-not (Test-Path (Join-Path $agentSrc "main.py"))) {
        throw "agent source not found at $agentSrc"
    }

    Write-Step "Copying agent/ FastAPI source to $TargetDir"
    if (Test-Path $TargetDir) {
        Remove-Item -Recurse -Force $TargetDir
    }
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null

    $excludeDirs = @(
        "__pycache__", ".venv", ".venv-build", "build", "dist", ".git",
        "wheel-cache", "wheels", "wheels_gpu"
    )
    $excludeFiles = @("*.pyc", "*.pyo", "*.spec")

    robocopy $agentSrc $TargetDir /E /NFL /NDL /NJH /NJS /NC /NS /NP `
        /XD $excludeDirs `
        /XF *.spec | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy agent failed with exit code $LASTEXITCODE"
    }
}
Write-Step "Cleaning staging directory"
if (Test-Path $Staging) {
    Remove-Item -Recurse -Force $Staging
}
New-Item -ItemType Directory -Force -Path $Staging, $ModelsDir | Out-Null

if (-not (Test-Path $ExePath)) {
    Write-Step "Building itmatzip-agent.exe"
    Push-Location $Root
    go build -o itmatzip-agent.exe .
    Pop-Location
}
Copy-Item $ExePath (Join-Path $Staging "itmatzip-agent.exe")

Write-Step "Copying python_worker"
New-Item -ItemType Directory -Force -Path $WorkerDst | Out-Null
$workerFiles = @(
    "worker.py",
    "worker_grpc.py",
    "vocal_inference.py",
    "agent_pb2.py",
    "agent_pb2_grpc.py",
    "requirements.txt",
    "README.md"
)
foreach ($name in $workerFiles) {
    $src = Join-Path $WorkerSrc $name
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $WorkerDst $name)
    }
}

if (-not (Test-Path (Join-Path $WorkerDst "agent_pb2.py"))) {
    Write-Step "Generating Python protobuf stubs"
    Push-Location $WorkerSrc
    & $Python generate_proto.py
    Pop-Location
    Copy-Item (Join-Path $WorkerSrc "agent_pb2.py") (Join-Path $WorkerDst "agent_pb2.py") -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $WorkerSrc "agent_pb2_grpc.py") (Join-Path $WorkerDst "agent_pb2_grpc.py") -ErrorAction SilentlyContinue
}

if ($SkipEngine) {
    Write-Warning "Skipping engine (--SkipEngine). MSI will ship without bundled Python."
    New-Item -ItemType Directory -Force -Path $EngineDir | Out-Null
    Set-Content -Path (Join-Path $EngineDir ".keep") -Value "engine not staged"
} elseif ($UseEmbeddable) {
    Install-EmbeddableEngine -TargetDir $EngineDir -Version $EmbeddableVersion -RequirementsFile $WorkerReq
    Build-DiffqVendorWheel -EngineDir $EngineDir -EmbeddableVersion $EmbeddableVersion
    $enginePython = Join-Path $EngineDir "python.exe"
    if (Test-Path $AgentReq) {
        Write-Step "Installing FastAPI sidecar requirements into embeddable engine"
        $env:PYTHONNOUSERSITE = "1"
        & $enginePython -m pip install -r $AgentReq
        Remove-Item Env:PYTHONNOUSERSITE -ErrorAction SilentlyContinue
    }
} else {
    Write-Step "Creating engine venv at $EngineDir"
    if (Test-Path $EngineDir) {
        Remove-Item -Recurse -Force $EngineDir
    }
    & $Python -m venv --copies $EngineDir
    $pip = Join-Path $EngineDir "Scripts\python.exe"
    Write-Step "Installing python_worker requirements into engine venv"
    & $pip -m pip install --upgrade pip wheel
    & $pip -m pip install -r $WorkerReq
    if (Test-Path $AgentReq) {
        Write-Step "Installing FastAPI sidecar requirements into engine venv"
        & $pip -m pip install -r $AgentReq
    }

    $cfg = Join-Path $EngineDir "pyvenv.cfg"
    if (Test-Path $cfg) {
        Write-Host "engine pyvenv.cfg home: $((Get-Content $cfg | Select-String '^home'))"
    }
}

if (-not $SkipAgent) {
    Copy-AgentSource -RepoRoot $Root -TargetDir $AgentDst
}

function Copy-ToolsWebUI {
    param(
        [string]$PlatformRoot,
        [string]$TargetDir
    )
    $toolsSrc = Join-Path $PlatformRoot "web-ui\tools"
    if (-not (Test-Path (Join-Path $toolsSrc "image-enhancer\index.html"))) {
        throw "image-enhancer web UI not found at $toolsSrc"
    }
    Write-Step "Copying bundled tools web UI to $TargetDir"
    if (Test-Path $TargetDir) {
        Remove-Item -Recurse -Force $TargetDir
    }
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null

    robocopy (Join-Path $toolsSrc "image-enhancer") (Join-Path $TargetDir "image-enhancer") /E /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy image-enhancer failed: $LASTEXITCODE" }

    if (Test-Path (Join-Path $toolsSrc "background-remover\index.html")) {
        robocopy (Join-Path $toolsSrc "background-remover") (Join-Path $TargetDir "background-remover") /E /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy background-remover failed: $LASTEXITCODE" }
    }

    if (Test-Path (Join-Path $toolsSrc "magic-eraser\index.html")) {
        robocopy (Join-Path $toolsSrc "magic-eraser") (Join-Path $TargetDir "magic-eraser") /E /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy magic-eraser failed: $LASTEXITCODE" }
    }

    if (Test-Path (Join-Path $toolsSrc "voice-changer\index.html")) {
        robocopy (Join-Path $toolsSrc "voice-changer") (Join-Path $TargetDir "voice-changer") /E /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy voice-changer failed: $LASTEXITCODE" }
    }

    robocopy (Join-Path $toolsSrc "common") (Join-Path $TargetDir "common") /E /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy common failed: $LASTEXITCODE" }

    $silenceDir = Join-Path $toolsSrc "silence-remover"
    $mobileDst = Join-Path $TargetDir "silence-remover"
    New-Item -ItemType Directory -Force -Path $mobileDst | Out-Null
    foreach ($name in @("mobile-only.css", "mobile-only.js")) {
        $src = Join-Path $silenceDir $name
        if (Test-Path $src) {
            Copy-Item $src (Join-Path $mobileDst $name)
        }
    }
    foreach ($ico in @("favicon-16x16.ico", "favicon-32x32.ico")) {
        $src = Join-Path $toolsSrc $ico
        if (Test-Path $src) {
            Copy-Item $src (Join-Path $TargetDir $ico)
        }
    }
}

$PlatformRoot = Split-Path -Parent $Root
$ToolsWebDst = Join-Path $Staging "tools-web"
Copy-ToolsWebUI -PlatformRoot $PlatformRoot -TargetDir $ToolsWebDst

$previewScript = Join-Path $ToolsWebDst "image-enhancer\script.js"
if (-not (Test-Path $previewScript)) {
    throw "Bundled image-enhancer script missing: $previewScript"
}
if (-not (Select-String -Path $previewScript -Pattern "loadImageInto" -Quiet)) {
    throw "tools-web/image-enhancer/script.js is outdated (missing loadImageInto). Sync web-ui before MSI build."
}

$FfmpegVendorDir = Join-Path $Staging "vendor\ffmpeg\gpl-shared"
if (-not (Test-Path (Join-Path $FfmpegVendorDir "ffmpeg.exe"))) {
    Write-Step "Staging bundled FFmpeg (gpl-shared) for MSI"
    & (Join-Path $Root "scripts\install-ffmpeg-vendor.ps1") -TargetDir $FfmpegVendorDir
}

Write-Step "Staging complete: $Staging"
Get-ChildItem $Staging | Format-Table Name, Length -AutoSize
