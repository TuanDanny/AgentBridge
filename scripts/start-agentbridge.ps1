$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$CliPath = Join-Path $RepoRoot "dist\cli.js"

Set-Location $RepoRoot

if (-not (Test-Path $CliPath)) {
  throw "Missing dist\cli.js. Run npm run build first."
}

Write-Host "Starting AgentBridge daemon..." -ForegroundColor Cyan
Write-Host "Local URL: http://127.0.0.1:7777" -ForegroundColor Yellow

node $CliPath start --host 127.0.0.1 --port 7777
