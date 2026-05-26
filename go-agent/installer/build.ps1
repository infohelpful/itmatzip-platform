# WiX MSI build: stage payload (Go exe + engine + python_worker) and link MSI
param(
    [switch]$SkipEngine,
    [switch]$UseEmbeddable,
    [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $Root
$OutDir = Join-Path $Root "dist"
$InstallerDir = Join-Path $Root "installer"
$Staging = Join-Path $OutDir "staging"
$VersionPy = Join-Path $RepoRoot "agent\version.py"
$ProductWxs = Join-Path $InstallerDir "product.wxs"

. (Join-Path $InstallerDir "resolve-wix.ps1")

function Normalize-AgentSemVer {
    param([string]$Version)
    $v = $Version.Trim()
    # version.py must be x.y.z; accept mistaken x.y.z.0 and compare as x.y.z
    if ($v -match '^(\d+\.\d+\.\d+)\.0$') { return $Matches[1] }
    return $v
}

function Assert-AgentVersionMatchesWix {
    if (-not (Test-Path $VersionPy)) { throw "agent/version.py not found: $VersionPy" }
    if (-not (Test-Path $ProductWxs)) { throw "product.wxs not found: $ProductWxs" }
    $agentRaw = Get-Content $VersionPy -Raw
    $wxsRaw = Get-Content $ProductWxs -Raw
    if ($agentRaw -notmatch 'AGENT_VERSION\s*=\s*"([^"]+)"') {
        throw "AGENT_VERSION not found in $VersionPy"
    }
    $agentVer = $Matches[1]
    if ($wxsRaw -notmatch 'ProductVersion\s*=\s*"([^"]+)"') {
        throw "ProductVersion not found in $ProductWxs"
    }
    $wixVer = $Matches[1]
    $agentNorm = Normalize-AgentSemVer $agentVer
    $wixNorm = Normalize-AgentSemVer $wixVer
    if ($agentNorm -ne $wixNorm) {
        throw @"
Version mismatch before MSI build:
  agent/version.py     AGENT_VERSION = "$agentVer"  -> use x.y.z (example: "1.1.6")
  installer/product.wxs ProductVersion = "$wixVer"  -> use x.y.z.0 (example: "1.1.6.0")
Normalized compare: $agentNorm vs $wixNorm
/health reads version.py inside the MSI — both must refer to the same release (1.1.6 / 1.1.6.0).
"@
    }
    if ($agentVer -match '^\d+\.\d+\.\d+\.0$') {
        Write-Warning "agent/version.py has AGENT_VERSION=`"$agentVer`" — use `"$agentNorm`" (three-part). /health shows the three-part value."
    }
}

function Invoke-WixTool {
    param(
        [string]$Name,
        [string[]]$ToolArgs
    )
    $bin = Resolve-WixBin
    if (-not $bin) {
        throw "WiX Toolset not found"
    }
    $exe = Join-Path $bin $Name
    if (-not (Test-Path $exe)) {
        throw "WiX tool missing: $exe"
    }
    & $exe @ToolArgs
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Push-Location $Root
try {
    Assert-AgentVersionMatchesWix
    Write-Host "Version check OK: agent/version.py matches product.wxs" -ForegroundColor Green

    Write-Host "Building itmatzip-agent.exe..." -ForegroundColor Cyan
    go build -ldflags "-H windowsgui" -o itmatzip-agent.exe .

    Write-Host "Building tray icon (16x16)..." -ForegroundColor Cyan
    & (Join-Path $Root "scripts\build-tray-icon.ps1") -Python $Python

    $stageArgs = @{
        SkipEngine = $SkipEngine
        Python = $Python
    }
    if ($UseEmbeddable -or (-not $SkipEngine)) { $stageArgs.UseEmbeddable = $true }
    & (Join-Path $InstallerDir "stage-payload.ps1") @stageArgs

    $enginePython = Join-Path $Staging "engine\python.exe"
    if ($SkipEngine) {
        throw @"
MSI cannot be built with -SkipEngine: bundled engine\python.exe is required for gRPC and FastAPI.
Rebuild with: powershell -File installer\build.ps1 -UseEmbeddable
"@
    }
    if (-not (Test-Path $enginePython)) {
        throw "Staging missing engine\python.exe at $enginePython — grpc/fastapi will not start."
    }
    if (-not (Import-WixPath)) {
        Write-Warning "WiX Toolset not found in PATH or standard install locations."
        Write-Warning "Install with: winget install WiXToolset.WiXToolset"
        Write-Warning "Then re-open PowerShell or run: `$env:PATH = `"C:\Program Files (x86)\WiX Toolset v3.14\bin;`$env:PATH`""
        Write-Host "Staged payload at $Staging"
        exit 0
    }
    Write-Host "Using WiX from: $(Resolve-WixBin)" -ForegroundColor Cyan

    $heatArgs = @(
        "dir", $Staging,
        "-cg", "StagingComponents",
        "-dr", "INSTALLFOLDER",
        "-var", "var.StagingDir",
        "-srd",
        "-sreg",
        "-gg", "-g1",
        "-out", (Join-Path $OutDir "staging.wxs")
    )
    Write-Host "Harvesting staged files with heat.exe..." -ForegroundColor Cyan
    Invoke-WixTool -Name "heat.exe" -ToolArgs $heatArgs

    Write-Host "Compiling WiX source..." -ForegroundColor Cyan
    $productWxs = Join-Path $InstallerDir "product.wxs"
    $stagingWxs = Join-Path $OutDir "staging.wxs"
    $productWixobj = Join-Path $OutDir "product.wixobj"
    $stagingWixobj = Join-Path $OutDir "staging.wixobj"
    $msiPath = Join-Path $OutDir "itmatzip-agent.msi"

    Invoke-WixTool -Name "candle.exe" -ToolArgs @(
        "-ext", "WixUtilExtension",
        "-arch", "x64",
        "-dStagingDir=$Staging",
        "-dSourceDir=$Root",
        "-out", $productWixobj,
        $productWxs
    )
    Invoke-WixTool -Name "candle.exe" -ToolArgs @(
        "-arch", "x64",
        "-dStagingDir=$Staging",
        "-dSourceDir=$Root",
        "-out", $stagingWixobj,
        $stagingWxs
    )

    Write-Host "Linking MSI..." -ForegroundColor Cyan
    Invoke-WixTool -Name "light.exe" -ToolArgs @(
        "-ext", "WixUtilExtension",
        "-out", $msiPath,
        $productWixobj,
        $stagingWixobj
    )

    Write-Host "MSI created: $msiPath" -ForegroundColor Green
    Write-Host "MSI size: $((Get-Item $msiPath).Length) bytes" -ForegroundColor Green
}
finally {
    Pop-Location
}
