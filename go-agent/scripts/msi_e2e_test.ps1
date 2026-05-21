# MSI install + Windows service E2E test (requires Administrator)
param(
    [string]$MsiPath = "",
    [switch]$SkipInstall,
    [switch]$SkipUninstall,
    [string]$LogPath = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not $MsiPath) {
    $MsiPath = Join-Path $Root "dist\itmatzip-agent.msi"
}
if (-not $LogPath) {
    $LogPath = Join-Path $Root "dist\msi-e2e.log"
}

function Write-Log($msg) {
    $line = "$(Get-Date -Format o) $msg"
    Write-Host $line
    Add-Content -Path $LogPath -Value $line
}

$InstallDir = "${env:ProgramFiles}\itmatzip-agent"
$DataDir = "$env:ProgramData\itmatzip-agent"
$MsiInstallLog = Join-Path $Root "dist\msi-install.log"
$ServiceName = "ItMatZipAgent"

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-MsiExec {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )
    $argLine = ($Arguments | ForEach-Object {
        if ($_ -match '\s') { "`"$_`"" } else { $_ }
    }) -join ' '
    Write-Log "msiexec $argLine"
    $p = Start-Process -FilePath "msiexec.exe" -ArgumentList $argLine -Wait -PassThru
    return $p.ExitCode
}

function Wait-Health($timeoutSec = 60) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod http://127.0.0.1:19876/health -TimeoutSec 3
            if ($health.status -eq "ok") {
                return $health
            }
        } catch {}
        Start-Sleep -Seconds 2
    }
    throw "Agent /health did not become ready within ${timeoutSec}s"
}

New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null
Write-Log "MSI E2E starting (admin=$([bool](Test-Admin)))"

if (-not (Test-Admin)) {
    throw "Administrator PowerShell required for MSI E2E test."
}

if (-not $SkipInstall) {
    if (-not (Test-Path $MsiPath)) {
        Write-Host "MSI not found, building..."
        powershell -ExecutionPolicy Bypass -File (Join-Path $Root "installer\build.ps1") -UseEmbeddable
    }

    Write-Host "Installing MSI: $MsiPath"
    $exitCode = Invoke-MsiExec -Arguments @("/i", $MsiPath, "/qn", "/norestart", "/L*v", $MsiInstallLog)
    if ($exitCode -ne 0) {
        $hint = ""
        if ($exitCode -eq 1639) {
            $hint = " (MSI path not opened — check quoting/spaces in path)"
        }
        throw "msiexec failed with exit code $exitCode$hint. Install log: $MsiInstallLog"
    }
    Write-Host "MSI install completed."
}

$exePath = Join-Path $InstallDir "itmatzip-agent.exe"
if (-not (Test-Path $exePath)) {
    throw "Installed exe not found: $exePath"
}
if (-not (Test-Path (Join-Path $InstallDir "agent\main.py"))) {
    throw "Bundled agent/ not found under $InstallDir"
}
Write-Host "Install layout OK (exe + agent/)"

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Host "Registering service manually..."
    & $exePath --install
}
$svc = Get-Service -Name $ServiceName
Write-Host "Service status before start: $($svc.Status)"

if ($svc.Status -ne "Running") {
    Start-Service -Name $ServiceName
    Start-Sleep -Seconds 5
}
$svc.Refresh()
Write-Host "Service status: $($svc.Status)"

$health = Wait-Health 90
Write-Host "Health: $($health | ConvertTo-Json -Compress)"

$status = Invoke-RestMethod http://127.0.0.1:19876/status
Write-Host "fastapi_ready=$($status.fastapi_ready) grpc_health=$($status.grpc_health.status)"

if ($status.fastapi_ready) {
    $vr = Invoke-RestMethod http://127.0.0.1:19876/api/tools/vocal-remover/status
    Write-Host "vocal-remover status: $($vr | ConvertTo-Json -Compress)"
}

Write-Host "Installing model via Go API..."
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19876/install-model `
    -Body '{"model_id":"msi-e2e","url":"https://httpbin.org/bytes/256"}' `
    -ContentType application/json | Out-Null
Start-Sleep -Seconds 8

$infer = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19876/inference `
    -Body '{"model_id":"msi-e2e","input":"msi-test"}' `
    -ContentType application/json
Write-Host "Inference: $($infer | ConvertTo-Json -Compress)"
if ($infer.status -ne "ok") {
    throw "Inference failed during MSI E2E"
}

Write-Host "MSI E2E test passed."

if (-not $SkipUninstall) {
    Write-Host "Stopping service and uninstalling MSI..."
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    & $exePath --uninstall
    $exitCode = Invoke-MsiExec -Arguments @("/x", $MsiPath, "/qn", "/norestart")
    if ($exitCode -ne 0) {
        throw "msiexec uninstall failed with exit code $exitCode"
    }
    Write-Host "Uninstall completed."
}
