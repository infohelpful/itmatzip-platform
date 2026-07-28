# ItMatZip 로컬 에이전트 (FastAPI, 포트 19876 — agent/agent_config.py)
# 개발 기준 Python: 3.12.x (MSI embeddable과 동일 메이저)
$AgentRoot = Join-Path $PSScriptRoot "agent"
Set-Location $AgentRoot
Write-Host "Agent root: $AgentRoot"
$py = Get-Command py -ErrorAction SilentlyContinue
if ($py) {
    Write-Host "Using: py -3.12 -m uvicorn ..."
    py -3.12 -m uvicorn main:app --reload --host 127.0.0.1 --port 19876
} else {
    Write-Host "Using: python -m uvicorn ... (ensure Python 3.12 is on PATH)"
    python -m uvicorn main:app --reload --host 127.0.0.1 --port 19876
}
