# Stage MSI payload: Go exe, Python venv (engine), python_worker scripts
param(
    [switch]$SkipEngine,
    [switch]$SkipAgent,
    [switch]$UseEmbeddable,
    [string]$Python = "python",
    [string]$EmbeddableVersion = "3.11.9"
)

$ErrorActionPreference = "Stop"
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
    Expand-Archive -Path $zipPath -DestinationPath $TargetDir

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
    & $enginePython $getPip --no-warn-script-location

    Write-Step "Installing engine requirements into embeddable Python"
    & $enginePython -m pip install -r $RequirementsFile
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
    $enginePython = Join-Path $EngineDir "python.exe"
    if (Test-Path $AgentReq) {
        Write-Step "Installing FastAPI sidecar requirements into embeddable engine"
        & $enginePython -m pip install -r $AgentReq
    }
} else {    Write-Step "Creating engine venv at $EngineDir"
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

Write-Step "Staging complete: $Staging"
Get-ChildItem $Staging | Format-Table Name, Length -AutoSize
