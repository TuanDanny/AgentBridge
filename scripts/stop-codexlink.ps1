param(
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BridgeDir = Join-Path $Root ".agentbridge"
$StateFile = Join-Path $BridgeDir "launcher-state.json"

Set-Location $Root
Write-Host "Stopping CodexLink local server from $Root"

if ($DryRun) {
  Write-Host "Dry-run: would run node dist\cli.js stop."
  exit 0
}

if (!(Test-Path (Join-Path $Root "dist\cli.js"))) {
  Write-Host "dist\cli.js is missing. Nothing was stopped." -ForegroundColor Yellow
  exit 0
}

node dist\cli.js stop
if ($LASTEXITCODE -ne 0) {
  Write-Host "node dist\cli.js stop returned a non-zero exit code." -ForegroundColor Yellow
}

if (Test-Path $StateFile) {
  try {
    $state = Get-Content $StateFile -Raw | ConvertFrom-Json
    $state | Add-Member -NotePropertyName stopped_at -NotePropertyValue ((Get-Date).ToUniversalTime().ToString("o")) -Force
    $state | ConvertTo-Json -Depth 5 | Set-Content -Path $StateFile -Encoding UTF8
  } catch {
    Write-Host "Could not update launcher state file." -ForegroundColor Yellow
  }
}
