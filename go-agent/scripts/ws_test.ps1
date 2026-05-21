# WebSocket smoke test for Go agent events
param(
    [int]$Port = 19876,
    [int]$WaitSec = 8
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.WebSockets

$uri = [Uri]"ws://127.0.0.1:$Port/ws"
$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$cts = New-Object System.Threading.CancellationTokenSource
$connectTask = $ws.ConnectAsync($uri, $cts.Token)
$connectTask.Wait()
Write-Host "WS connected to $uri"

$buf = New-Object byte[] 8192
$events = [System.Collections.Generic.List[string]]::new()
$deadline = (Get-Date).AddSeconds($WaitSec)

while ((Get-Date) -lt $deadline) {
    if ($ws.State -ne [System.Net.WebSockets.WebSocketState]::Open) { break }
    $seg = [ArraySegment[byte]]::new($buf)
    $recv = $ws.ReceiveAsync($seg, $cts.Token)
    if (-not $recv.Wait(500)) { continue }
    if ($recv.Result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { break }
    $text = [Text.Encoding]::UTF8.GetString($buf, 0, $recv.Result.Count)
    Write-Host "event: $text"
    $events.Add($text)
}

try { $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "", $cts.Token).Wait() } catch {}
$ws.Dispose()

if ($events.Count -eq 0) {
    Write-Warning "No WS events received in ${WaitSec}s"
    exit 1
}
Write-Host "Received $($events.Count) WS event(s)"
