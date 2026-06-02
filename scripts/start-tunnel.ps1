$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

Set-Location $RepoRoot

Write-Host "Starting Cloudflare quick tunnel..." -ForegroundColor Cyan
Write-Host "Forwarding to local AgentBridge: http://127.0.0.1:7777" -ForegroundColor Yellow
Write-Host "Copy the generated https://*.trycloudflare.com URL for Terminal 3." -ForegroundColor Yellow

cloudflared tunnel --url http://127.0.0.1:7777
