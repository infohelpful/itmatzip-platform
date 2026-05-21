# End-to-end smoke test for go-agent

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Exe = Join-Path $Root "itmatzip-agent.exe"
$Port = 19876
$GrpcPort = 50051

if (-not (Test-Path $Exe)) {
    Push-Location $Root
    go build -o itmatzip-agent.exe .
    Pop-Location
}

$env:ITMATZIP_AGENT_DEV = "1"
$proc = Start-Process -FilePath $Exe -ArgumentList @("--port=$Port", "--grpc-port=$GrpcPort") -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3

try {
    Write-Host "Testing /health..."
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health"
    Write-Host ($health | ConvertTo-Json -Compress)

    Write-Host "Testing /status..."
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/status"
    Write-Host "grpc_health: $($status.grpc_health | ConvertTo-Json -Compress)"
    if ($status.grpc_error) {
        Write-Warning "gRPC error: $($status.grpc_error)"
    }

    Write-Host "Testing /install-model..."
    $body = @{
        model_id = "smoke-test"
        url      = "https://httpbin.org/bytes/2048"
    } | ConvertTo-Json
    $install = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/install-model" -Body $body -ContentType "application/json"
    Write-Host ($install | ConvertTo-Json -Compress)

    Start-Sleep -Seconds 5
    $models = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/models"
    Write-Host "models: $($models.models | ConvertTo-Json -Compress)"

    Write-Host "Smoke test passed."
}
finally {
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force
    }
}
