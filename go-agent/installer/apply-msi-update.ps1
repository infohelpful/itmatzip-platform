param(
  [Parameter(Mandatory = $true)][string]$MsiPath,
  [string]$InstallRoot = "",
  [string]$ServiceName = "ItMatZipAgent",
  [string]$LogPath = ""
)
$ErrorActionPreference = "Stop"

function Write-UpdateLog([string]$Message) {
  if ($LogPath) {
    "$(Get-Date -Format o) $Message" | Out-File -FilePath $LogPath -Append -Encoding utf8
  }
}

function Get-TrayExePath {
  param([string]$Root)
  if ($Root -and (Test-Path -LiteralPath $Root)) {
    $candidate = Join-Path $Root "itmatzip-agent.exe"
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }
  $fallback = Join-Path ${env:ProgramFiles} "itmatzip-agent\itmatzip-agent.exe"
  if (Test-Path -LiteralPath $fallback) {
    return $fallback
  }
  return $null
}

function Start-TrayAgent {
  param([string]$Root)
  $trayExe = Get-TrayExePath -Root $Root
  if (-not $trayExe) {
    Write-UpdateLog "tray restart skipped: itmatzip-agent.exe not found"
    return
  }
  try {
    Start-Process -FilePath $trayExe -ArgumentList "--tray" -WindowStyle Hidden | Out-Null
    Write-UpdateLog "tray restart launched: $trayExe --tray"
  } catch {
    Write-UpdateLog ("tray restart failed: " + $_.Exception.Message)
  }
}

function Invoke-MsiExecElevated {
  param([string[]]$Arguments)
  Write-UpdateLog ("msiexec elevated: " + ($Arguments -join " "))
  try {
    $p = Start-Process -FilePath "msiexec.exe" -ArgumentList $Arguments -Verb RunAs -Wait -PassThru
    if ($null -eq $p) {
      Write-UpdateLog "msiexec elevated: no process handle (UAC canceled?)"
      return 1223
    }
    return $p.ExitCode
  } catch {
    Write-UpdateLog ("msiexec elevation failed: " + $_.Exception.Message)
    return 1223
  }
}

Write-UpdateLog "MSI update starting: $MsiPath"
$exit = 1223
try {
  # Legacy Windows service (pre-tray installs). Tray-only installs ignore missing service.
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1

  $exit = Invoke-MsiExecElevated -Arguments @("/i", $MsiPath, "/qn", "/norestart", "/L*v", $LogPath)
  if ($exit -ne 0) {
    Write-UpdateLog "msiexec failed with exit code $exit"
    exit $exit
  }

  Start-Sleep -Seconds 2
  try {
    Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
  } catch {
    # tray-only layout: no Windows service
  }
  Start-TrayAgent -Root $InstallRoot
  Write-UpdateLog "MSI update completed"
} catch {
  Write-UpdateLog ("MSI update error: " + $_.Exception.Message)
  Start-TrayAgent -Root $InstallRoot
  exit 1
}
