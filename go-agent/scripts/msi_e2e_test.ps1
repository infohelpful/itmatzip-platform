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

function Stop-AgentProcesses {
    Write-Host "Stopping service and freeing agent ports..."
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Get-Process -Name itmatzip-agent -ErrorAction SilentlyContinue | Stop-Process -Force
    foreach ($port in 19876, 19877, 50051) {
        Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
            ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Seconds 2
}

function Wait-AgentReady($timeoutSec = 120) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $status = Invoke-RestMethod http://127.0.0.1:19876/status -TimeoutSec 5
            $grpcOk = $status.grpc_health -and $status.grpc_health.status -eq "ok"
            $grpcStale = $status.grpc_error -and $status.grpc_error -match "mismatch|stale|not running"
            if ($status.fastapi_ready -and $grpcOk -and -not $grpcStale) {
                return $status
            }
            Write-Host "waiting: fastapi_ready=$($status.fastapi_ready) grpc=$($status.grpc_health.status) grpc_error=$($status.grpc_error)"
        } catch {
            Write-Host "waiting: agent not reachable yet"
        }
        Start-Sleep -Seconds 3
    }
    throw "Agent did not become fully ready within ${timeoutSec}s (need fastapi + grpc)"
}

function Wait-ModelReady($modelId, $timeoutSec = 60) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        $status = Invoke-RestMethod http://127.0.0.1:19876/status -TimeoutSec 5
        $model = $status.models | Where-Object { $_.id -eq $modelId } | Select-Object -First 1
        if ($model -and $model.status -eq "ready") {
            return $model
        }
        Start-Sleep -Seconds 2
    }
    throw "Model '$modelId' did not reach ready within ${timeoutSec}s"
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

    Stop-AgentProcesses

    $installedExe = Join-Path $InstallDir "itmatzip-agent.exe"
    if (Test-Path $installedExe) {
        Write-Host "Removing previous MSI install before reinstall..."
        if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
            $prevEAP = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            & $installedExe --uninstall 2>&1 | Out-Null
            $ErrorActionPreference = $prevEAP
        } else {
            Write-Host "Service $ServiceName not registered; skipping exe --uninstall"
        }
        $uninstallCode = Invoke-MsiExec -Arguments @("/x", $MsiPath, "/qn", "/norestart")
        if ($uninstallCode -ne 0 -and $uninstallCode -ne 1605) {
            throw "msiexec uninstall before reinstall failed with exit code $uninstallCode"
        }
        Start-Sleep -Seconds 2
        Stop-AgentProcesses
    }

    Write-Host "Installing MSI: $MsiPath"
    $exitCode = Invoke-MsiExec -Arguments @("/i", $MsiPath, "/qn", "/norestart", "/L*v", $MsiInstallLog)
    if ($exitCode -ne 0) {
        $hint = ""
        if ($exitCode -eq 1639) {
            $hint = " (MSI path not opened — check quoting/spaces in path)"
        } elseif ($exitCode -eq 1603) {
            $hint = " (fatal install error — often InstallService custom action; check InstallService in $MsiInstallLog)"
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

$enginePython = Join-Path $InstallDir "engine\python.exe"
if (-not (Test-Path $enginePython)) {
    throw @"
Bundled Python missing: $enginePython
The MSI was built with -SkipEngine (engine not staged). gRPC/FastAPI cannot start.
Rebuild: cd go-agent; powershell -File installer\build.ps1 -UseEmbeddable
Then reinstall the MSI.
"@
}
Write-Host "Install layout OK (engine/python.exe present)"

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Host "Registering service manually..."
    & $exePath --install
    $svc = Get-Service -Name $ServiceName
}

Stop-AgentProcesses
Write-Host "Starting service fresh after install..."
Start-Service -Name $ServiceName
Start-Sleep -Seconds 5
$svc.Refresh()
Write-Host "Service status: $($svc.Status)"

$health = Wait-Health 90
Write-Host "Health: $($health | ConvertTo-Json -Compress)"
if ($health.update_error) {
    Write-Host "Note: update_error is OK until manifest has package_type=msi ($($health.update_error))"
}

$status = Wait-AgentReady 120
Write-Host "fastapi_ready=$($status.fastapi_ready) grpc_health=$($status.grpc_health.status)"

if ($status.fastapi_ready) {
    $vr = Invoke-RestMethod http://127.0.0.1:19876/api/tools/vocal-remover/status
    Write-Host "vocal-remover status: $($vr | ConvertTo-Json -Compress)"
}

Write-Host "Installing model via Go API..."
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19876/install-model `
    -Body '{"model_id":"msi-e2e","url":"https://httpbin.org/bytes/256"}' `
    -ContentType application/json | Out-Null
Wait-ModelReady -modelId "msi-e2e" -timeoutSec 60 | Out-Null
Start-Sleep -Seconds 2

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
