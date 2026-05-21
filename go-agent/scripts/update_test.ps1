# MSI auto-update smoke test (manifest fetch + optional dry-run apply)
param(
    [switch]$Apply
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Exe = Join-Path $Root "itmatzip-agent.exe"

if (-not (Test-Path $Exe)) {
    Push-Location $Root
    go build -o itmatzip-agent.exe .
    Pop-Location
}

$args = @("--check-update")
if ($Apply) { $args += "--apply-update" }

Write-Host "Running: itmatzip-agent.exe $($args -join ' ')"
& $Exe @args
