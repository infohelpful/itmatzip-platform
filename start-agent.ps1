# ItMatZip 로컬 에이전트 (FastAPI, 포트 8000)
$AgentRoot = Join-Path $PSScriptRoot "agent"
Set-Location $AgentRoot
Write-Host "Agent root: $AgentRoot"
uvicorn main:app --reload --port 8000
