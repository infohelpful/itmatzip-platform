param(
  [Parameter(Mandatory = $true)][string]$MsiPath,
  [string]$ServiceName = "ItMatZipAgent",
  [string]$LogPath = ""
)
$ErrorActionPreference = "Stop"

function Write-UpdateLog([string]$Message) {
  if ($LogPath) {
    "$(Get-Date -Format o) $Message" | Out-File -FilePath $LogPath -Append -Encoding utf8
  }
}

function Invoke-MsiExecQuoted {
  param([string[]]$Arguments)
  $argLine = ($Arguments | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -join ' '
  $p = Start-Process -FilePath "msiexec.exe" -ArgumentList $argLine -Wait -PassThru -WindowStyle Hidden
  return $p.ExitCode
}

Write-UpdateLog "MSI update starting: $MsiPath"
try {
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  $exit = Invoke-MsiExecQuoted -Arguments @("/i", $MsiPath, "/qn", "/norestart", "/L*v", $LogPath)
  if ($exit -ne 0) {
    Write-UpdateLog "msiexec failed with exit code $exit"
    exit $exit
  }
  Start-Sleep -Seconds 2
  $sc = Start-Process -FilePath "sc.exe" -ArgumentList "start $ServiceName" -Wait -PassThru -WindowStyle Hidden -NoNewWindow
  if ($sc.ExitCode -ne 0) {
    Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
  }
  Write-UpdateLog "MSI update completed"
} catch {
  Write-UpdateLog ("MSI update error: " + $_.Exception.Message)
  exit 1
}
