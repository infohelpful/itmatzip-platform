$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot '..\itmatzip-agent.exe'
$dest = 'C:\Program Files\itmatzip-agent\itmatzip-agent.exe'

Write-Host "Stopping ItMatZipAgent..."
Stop-Service ItMatZipAgent -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "Copying $src -> $dest"
Copy-Item $src $dest -Force

Write-Host "Starting ItMatZipAgent..."
Start-Service ItMatZipAgent
Start-Sleep -Seconds 3

$svc = Get-Service ItMatZipAgent
Write-Host "Service status: $($svc.Status)"

Write-Host "Testing health..."
try {
    $r = Invoke-WebRequest -Uri "http://localhost:19876/health" -TimeoutSec 5 -UseBasicParsing
    Write-Host "Health: $($r.Content)"
} catch {
    Write-Host "Health check failed: $_"
}
Write-Host "Done. Press Enter to close."
Read-Host
