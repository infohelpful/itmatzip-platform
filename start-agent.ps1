# ItMatZip 로컬 에이전트 (FastAPI, 포트 19876 — agent/agent_config.py)
$AgentRoot = Join-Path $PSScriptRoot "agent"
Set-Location $AgentRoot
Write-Host "Agent root: $AgentRoot"
uvicorn main:app --reload --host 127.0.0.1 --port 19876
