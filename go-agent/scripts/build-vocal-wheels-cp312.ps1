# Build Vocal Remover cp312 wheel bundles (CPU + GPU) and optional Setup wrappers.
# Prerequisites: Python 3.12 on PATH (py -3.12), NVIDIA optional for GPU smoke.
param(
    [ValidateSet("all", "cpu", "gpu", "package", "test")]
    [string]$Phase = "package",
    [string]$Python = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $Root "agent\version.py"))) {
    $Root = Split-Path -Parent $PSScriptRoot
}
$Work = Join-Path $Root "go-agent\dist\vocal-wheels-cp312"
$CpuWheels = Join-Path $Work "cpu\wheels"
$GpuWheels = Join-Path $Work "gpu\wheels"
$Out = Join-Path $Work "out"
$SetupDir = Join-Path $Work "setup"

function Resolve-Py {
    param([string]$Preferred)
    if ($Preferred -and (Test-Path $Preferred)) { return $Preferred }
    $c = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"
    if (Test-Path $c) { return $c }
    throw "Python 3.12 not found"
}

$Py = Resolve-Py $Python
New-Item -ItemType Directory -Force -Path $Out, $SetupDir | Out-Null

function New-SplitZip {
    param(
        [string]$SourceZip,
        [string]$OutDir,
        [string]$BaseName = "wheels_gpu.zip",
        [int]$PartBytes = 1500MB
    )
    Get-ChildItem $OutDir -Filter "$BaseName.*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    $fs = [System.IO.File]::OpenRead($SourceZip)
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

Write-Host "Work: $Work" -ForegroundColor Cyan
Write-Host "Python: $Py"

if ($Phase -in @("all", "package")) {
    Write-Host "==> Packaging CPU wheel.zip" -ForegroundColor Cyan
    $cpuZip = Join-Path $Out "wheel.zip"
    if (Test-Path $cpuZip) { Remove-Item $cpuZip -Force }
    # Prefer Compress-Archive for .zip; large GPU uses .NET ZipFile
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path $cpuZip) { Remove-Item $cpuZip -Force }
    [System.IO.Compression.ZipFile]::CreateFromDirectory($CpuWheels, $cpuZip)
    Write-Host "CPU zip: $cpuZip ($([math]::Round((Get-Item $cpuZip).Length/1MB,1)) MB)"

    Write-Host "==> Packaging GPU wheels_gpu.zip (may be large)" -ForegroundColor Cyan
    $gpuZip = Join-Path $Out "wheels_gpu.zip"
    if (Test-Path $gpuZip) { Remove-Item $gpuZip -Force }
    [System.IO.Compression.ZipFile]::CreateFromDirectory($GpuWheels, $gpuZip)
    Write-Host "GPU zip: $gpuZip ($([math]::Round((Get-Item $gpuZip).Length/1MB,1)) MB)"
    Write-Host "==> Splitting GPU zip into .001/.002 ..."
    New-SplitZip -SourceZip $gpuZip -OutDir $Out -BaseName "wheels_gpu.zip" -PartBytes (1500MB)
    Get-ChildItem $Out | Select-Object Name, @{N='MB';E={[math]::Round($_.Length/1MB,1)}} | Format-Table -AutoSize
}

if ($Phase -in @("all", "package")) {
    Write-Host "==> Writing Setup scripts (CPU / GPU)" -ForegroundColor Cyan
    $installerPs1 = @'
# Vocal Remover runtime installer (cp312) — places wheels then pip --target into AppData
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("cpu","gpu")]
    [string]$Variant,
    [string]$Python = ""
)
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
function Resolve-Py([string]$Preferred) {
    if ($Preferred -and (Test-Path $Preferred)) { return $Preferred }
    $c = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"
    if (Test-Path $c) { return $c }
    throw "Python 3.12 required"
}
$Py = Resolve-Py $Python
$Target = Join-Path $env:APPDATA "ItMatZip\engine-runtime\vocal-remover\Lib\site-packages"
New-Item -ItemType Directory -Force -Path $Target | Out-Null
$WheelsDir = Join-Path $env:TEMP ("itz-vocal-wheels-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Force -Path $WheelsDir | Out-Null
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if ($Variant -eq "cpu") {
        $zip = Join-Path $Here "wheel.zip"
        if (-not (Test-Path $zip)) { throw "missing wheel.zip next to installer" }
        [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $WheelsDir)
    } else {
        $p1 = Join-Path $Here "wheels_gpu.zip.001"
        $p2 = Join-Path $Here "wheels_gpu.zip.002"
        $merged = Join-Path $WheelsDir "wheels_gpu.zip"
        if (-not (Test-Path $p1)) { throw "missing wheels_gpu.zip.001" }
        $out = [System.IO.File]::Create($merged)
        try {
            foreach ($p in @($p1, $p2)) {
                if (-not (Test-Path $p)) { continue }
                $in = [System.IO.File]::OpenRead($p)
                try { $in.CopyTo($out) } finally { $in.Close() }
            }
        } finally { $out.Close() }
        [System.IO.Compression.ZipFile]::ExtractToDirectory($merged, $WheelsDir)
    }
    $all = Get-ChildItem $WheelsDir -Recurse -File
    $torch = $all | Where-Object { $_.Name -like 'torch-*.whl' -and (($Variant -eq 'gpu' -and $_.Name -match '\+cu') -or ($Variant -eq 'cpu' -and $_.Name -notmatch '\+cu')) } | Select-Object -First 1
    $ta = $all | Where-Object { $_.Name -like 'torchaudio-*.whl' } | Select-Object -First 1
    $tc = $all | Where-Object { $_.Name -like 'torchcodec-*.whl' } | Select-Object -First 1
    $np = $all | Where-Object { $_.Name -like 'numpy-*.whl' } | Select-Object -First 1
    $dq = $all | Where-Object { $_.Name -like 'diffq-*-cp312*.whl' } | Select-Object -First 1
    $dm = $all | Where-Object { $_.Name -like 'demucs-*.tar.gz' } | Select-Object -First 1
    if (-not $torch -or -not $dm -or -not $dq) { throw "bundle incomplete" }
    $links = $torch.DirectoryName
    Write-Host "Installing into $Target"
    & $Py -m pip install --target $Target --upgrade --no-warn-script-location --no-index --find-links $links --prefer-binary `
        $torch.FullName $ta.FullName $tc.FullName $np.FullName $dq.FullName $dm.FullName
    $env:PYTHONPATH = $Target
    & $Py -c "import torch, demucs, diffq; print('OK', torch.__version__, 'cuda', torch.cuda.is_available())"
    Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
    Write-Host "Vocal Remover $Variant runtime installed." -ForegroundColor Green
} finally {
    Remove-Item $WheelsDir -Recurse -Force -ErrorAction SilentlyContinue
}
'@
    Set-Content -Path (Join-Path $SetupDir "Install-VocalRemover.ps1") -Value $installerPs1 -Encoding UTF8

    # CPU / GPU launchers (cmd) — double-click friendly
    @"
@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-VocalRemover.ps1" -Variant cpu
pause
"@ | Set-Content (Join-Path $SetupDir "Install-VocalRemover-CPU.cmd") -Encoding ASCII

    @"
@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-VocalRemover.ps1" -Variant gpu
pause
"@ | Set-Content (Join-Path $SetupDir "Install-VocalRemover-GPU.cmd") -Encoding ASCII

    Copy-Item (Join-Path $Out "wheel.zip") $SetupDir -Force
    Get-ChildItem $Out -Filter "wheels_gpu.zip.*" | Copy-Item -Destination $SetupDir -Force

    Write-Host "Setup folder: $SetupDir" -ForegroundColor Green
    Write-Host "  Install-VocalRemover-CPU.cmd  (+ wheel.zip)"
    Write-Host "  Install-VocalRemover-GPU.cmd  (+ wheels_gpu.zip.001/.002)"

    $SfxMod = "C:\Program Files\7-Zip\7z.sfx"
    $SevenZip = "C:\Program Files\7-Zip\7z.exe"
    if ((Test-Path $SfxMod) -and (Test-Path $SevenZip)) {
        Write-Host "==> Building 7-Zip SFX Setup.exe" -ForegroundColor Cyan
        $cpuCfg = Join-Path $Out "sfx-cpu-config.txt"
        $gpuCfg = Join-Path $Out "sfx-gpu-config.txt"
        [System.IO.File]::WriteAllText($cpuCfg, @"
;!@Install@!UTF-8!
Title="ItMatZip Vocal Remover CPU (Python 3.12)"
BeginPrompt="Install Demucs/diffq CPU wheels into %APPDATA%\ItMatZip\engine-runtime\vocal-remover ?"
RunProgram="Install-VocalRemover-CPU.cmd"
;!@InstallEnd@!
"@, [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($gpuCfg, @"
;!@Install@!UTF-8!
Title="ItMatZip Vocal Remover GPU (Python 3.12 + CUDA)"
BeginPrompt="Install Demucs/diffq GPU wheels into %APPDATA%\ItMatZip\engine-runtime\vocal-remover ? (needs NVIDIA GPU)"
RunProgram="Install-VocalRemover-GPU.cmd"
;!@InstallEnd@!
"@, [System.Text.UTF8Encoding]::new($false))

        $cpu7z = Join-Path $Out "VocalRemover-Lib-cp312-CPU.7z"
        $gpu7z = Join-Path $Out "VocalRemover-Lib-cp312-GPU.7z"
        Remove-Item $cpu7z, $gpu7z -Force -ErrorAction SilentlyContinue
        Push-Location $SetupDir
        & $SevenZip a -t7z -mx=5 $cpu7z "wheel.zip" "Install-VocalRemover.ps1" "Install-VocalRemover-CPU.cmd"
        if ($LASTEXITCODE -ne 0) { Pop-Location; throw "CPU 7z failed" }
        & $SevenZip a -t7z -mx=1 $gpu7z "wheels_gpu.zip.001" "wheels_gpu.zip.002" "Install-VocalRemover.ps1" "Install-VocalRemover-GPU.cmd"
        if ($LASTEXITCODE -ne 0) { Pop-Location; throw "GPU 7z failed" }
        Pop-Location

        $cpuExe = Join-Path $Out "VocalRemover-Lib-cp312-CPU-Setup.exe"
        $gpuExe = Join-Path $Out "VocalRemover-Lib-cp312-GPU-Setup.exe"
        cmd /c "copy /b `"$SfxMod`" + `"$cpuCfg`" + `"$cpu7z`" `"$cpuExe`"" | Out-Null
        cmd /c "copy /b `"$SfxMod`" + `"$gpuCfg`" + `"$gpu7z`" `"$gpuExe`"" | Out-Null
        Write-Host "CPU Setup: $cpuExe ($([math]::Round((Get-Item $cpuExe).Length/1MB,1)) MB)"
        Write-Host "GPU Setup: $gpuExe ($([math]::Round((Get-Item $gpuExe).Length/1MB,1)) MB)"
    } else {
        Write-Host "7-Zip SFX skipped (install 7-Zip to build Setup.exe)" -ForegroundColor Yellow
    }
}

Write-Host "Done." -ForegroundColor Green
