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

$relayStopped = $false
$relayClientStopped = $false
if (Test-Path $StateFile) {
  try {
    $state = Get-Content $StateFile -Raw | ConvertFrom-Json
    if ($state.relay_process_id) {
      try {
        $relayProcess = Get-Process -Id ([int]$state.relay_process_id) -ErrorAction Stop
        if ($relayProcess.ProcessName -eq "node") {
          Stop-Process -Id $relayProcess.Id -Force
          $relayStopped = $true
          Write-Host "Relay prototype stopped (pid $($relayProcess.Id))."
        } else {
          Write-Host "Relay process id no longer belongs to node; skipped." -ForegroundColor Yellow
        }
      } catch {
        Write-Host "Relay prototype process was not running." -ForegroundColor Yellow
      }
    }
    if ($state.relay_client_process_id) {
      try {
        $relayClientProcess = Get-Process -Id ([int]$state.relay_client_process_id) -ErrorAction Stop
        if ($relayClientProcess.ProcessName -eq "node") {
          Stop-Process -Id $relayClientProcess.Id -Force
          $relayClientStopped = $true
          Write-Host "Relay client stopped (pid $($relayClientProcess.Id))."
        } else {
          Write-Host "Relay client process id no longer belongs to node; skipped." -ForegroundColor Yellow
        }
      } catch {
        Write-Host "Relay client process was not running." -ForegroundColor Yellow
      }
    }
    $state | Add-Member -NotePropertyName stopped_at -NotePropertyValue ((Get-Date).ToUniversalTime().ToString("o")) -Force
    $state | Add-Member -NotePropertyName relay_stopped -NotePropertyValue $relayStopped -Force
    $state | Add-Member -NotePropertyName relay_client_stopped -NotePropertyValue $relayClientStopped -Force
    $state | ConvertTo-Json -Depth 5 | Set-Content -Path $StateFile -Encoding UTF8
  } catch {
    Write-Host "Could not update launcher state file." -ForegroundColor Yellow
  }
}
