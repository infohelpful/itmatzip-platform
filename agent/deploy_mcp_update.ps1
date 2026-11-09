#requires -RunAsAdministrator
param(
    [string]$InstallRoot = "$env:ProgramFiles\itmatzip-agent"
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$install = (Resolve-Path -LiteralPath $InstallRoot).Path

$copies = @(
    @('agent/engines/mcp_registry.py', 'agent/engines/mcp_registry.py'),
    @('agent/engines/mcp_chat.py', 'agent/engines/mcp_chat.py'),
    @('agent/engines/autosub/ai_proofread.py', 'agent/engines/autosub/ai_proofread.py'),
    @('agent/routers/autosub.py', 'agent/routers/autosub.py'),
    @('agent/version.py', 'agent/version.py')
)
foreach ($pair in $copies) {
    Copy-Item -LiteralPath (Join-Path $source $pair[0]) -Destination (Join-Path $install $pair[1]) -Force
}
Copy-Item -Path (Join-Path $source 'web-ui/tools/auto-subtitle/app/*') `
    -Destination (Join-Path $install 'tools-web/auto-subtitle/app') -Recurse -Force

$before = Invoke-RestMethod -Uri 'http://127.0.0.1:19876/health' -TimeoutSec 5
$null = Invoke-RestMethod -Uri 'http://127.0.0.1:19876/api/agent/fastapi/restart' -Method Post -TimeoutSec 5
# Older tray builds acknowledged restart but skipped it while FastAPI was healthy.
$health = Invoke-RestMethod -Uri 'http://127.0.0.1:19876/health' -TimeoutSec 5
$sidecarPort = [int]$health.fastapi.port
Start-Sleep -Seconds 2
try {
    $after = Invoke-RestMethod -Uri 'http://127.0.0.1:19876/health' -TimeoutSec 5
    if ($after.fastapi.last_start_at -eq $before.fastapi.last_start_at) {
        throw '실행 중인 FastAPI가 다시 시작되지 않았습니다.'
    }
    $openapi = Invoke-RestMethod -Uri "http://127.0.0.1:$sidecarPort/openapi.json" -TimeoutSec 3
    if ('/api/tools/auto-subtitle/v2/mcp/chat' -notin $openapi.paths.PSObject.Properties.Name) {
        throw '실행 중인 FastAPI에 새 채팅 API가 아직 없습니다.'
    }
} catch {
    $listener = Get-NetTCPConnection -LocalPort $sidecarPort -State Listen -ErrorAction Stop | Select-Object -First 1
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction Stop
    $expectedPython = [IO.Path]::GetFullPath((Join-Path $install 'engine/python.exe'))
    if (-not [string]::Equals([IO.Path]::GetFullPath($process.ExecutablePath), $expectedPython, [StringComparison]::OrdinalIgnoreCase)) {
        throw "FastAPI 포트의 프로세스가 설치된 에이전트 Python이 아닙니다: $($process.ExecutablePath)"
    }
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction Stop
}
$statusUri = 'http://127.0.0.1:19876/api/tools/auto-subtitle/v2/mcp/status'
$deadline = [DateTime]::UtcNow.AddSeconds(35)
do {
    try {
        $status = Invoke-RestMethod -Uri $statusUri -TimeoutSec 2
        if ($null -ne $status.connected) {
            Write-Output "MCP routes are active. Connected clients: $($status.activeClients)"
            exit 0
        }
    } catch { }
    Start-Sleep -Milliseconds 500
} while ([DateTime]::UtcNow -lt $deadline)

throw 'MCP API route did not respond after the FastAPI sidecar restart.'
