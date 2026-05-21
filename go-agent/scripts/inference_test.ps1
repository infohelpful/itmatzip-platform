# gRPC inference smoke test
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Exe = Join-Path $Root "itmatzip-agent.exe"

if (-not (Test-Path $Exe)) {
    Push-Location $Root
    go build -o itmatzip-agent.exe .
    Pop-Location
}

$env:ITMATZIP_AGENT_DEV = "1"
$env:ITMATZIP_AGENT_DIR = Join-Path (Split-Path -Parent $Root) "agent"

Get-Process -Name itmatzip-agent -ErrorAction SilentlyContinue | Stop-Process -Force
Get-NetTCPConnection -LocalPort 50051 -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

$proc = Start-Process -FilePath $Exe -ArgumentList @("--port=19876", "--grpc-port=50051") -PassThru -WindowStyle Hidden
Start-Sleep 5

try {
    Write-Host "Installing test model..."
    Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19876/install-model `
        -Body '{"model_id":"infer-test","url":"https://httpbin.org/bytes/512"}' `
        -ContentType application/json | Out-Null
    Start-Sleep 6

    Write-Host "Running inference..."
    $body = '{"model_id":"infer-test","input":"hello-itmatzip"}'
    $result = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19876/inference -Body $body -ContentType application/json
    Write-Host ($result | ConvertTo-Json -Depth 5 -Compress)

    if ($result.status -ne "ok") {
        throw "inference status=$($result.status)"
    }
    Write-Host "Inference test passed."
}
finally {
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force
    }
}
