param(
  [switch]$DryRun,
  [switch]$Install,
  [Alias("NoBrowser")]
  [switch]$NoOpenBrowser,
  [switch]$NoClipboard
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BridgeDir = Join-Path $Root ".agentbridge"
$LogDir = Join-Path $BridgeDir "logs"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogFile = Join-Path $LogDir "launcher-$Stamp.log"
$StateFile = Join-Path $BridgeDir "launcher-state.json"
$ConfigFile = Join-Path $BridgeDir "launcher-config.json"

function Ensure-LocalDir([string]$Path) {
  if ($DryRun) { return }
  if (!(Test-Path $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
}

function Log-Line([string]$Message) {
  $line = "$(Get-Date -Format o) $Message"
  if (!$DryRun) {
    Ensure-LocalDir $LogDir
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
  }
}

function Say([string]$Message) {
  Write-Host $Message
  Log-Line $Message
}

function Say-ConsoleOnly([string]$Message) {
  [Console]::Out.WriteLine($Message)
}

function Warn([string]$Message) {
  Write-Host "WARN: $Message" -ForegroundColor Yellow
  Log-Line "WARN: $Message"
}

function Fail([string]$Message) {
  Write-Host "FAIL: $Message" -ForegroundColor Red
  Log-Line "FAIL: $Message"
  exit 1
}

function Test-Health([string]$Url) {
  try {
    $health = Invoke-RestMethod -Uri $Url -TimeoutSec 3
    return ($health.ok -eq $true)
  } catch {
    return $false
  }
}

function ConvertTo-ProcessArgument([string]$Arg) {
  if ($null -eq $Arg) { return '""' }
  if ($Arg -notmatch '[\s"]') { return $Arg }
  return '"' + $Arg.Replace('"', '\"') + '"'
}

function Read-Config {
  $defaults = [ordered]@{
    projectId = Split-Path $Root -Leaf
    host = "127.0.0.1"
    port = 7777
    publicBaseUrl = $null
    gptUrl = $null
    openBrowser = $true
    copyGreetingToClipboard = $true
    autoBootstrap = $true
    autoDoctor = $true
    tunnelMode = "stable"
    relayHost = "127.0.0.1"
    relayPort = 8787
    autoRelay = $true
  }
  if (Test-Path $ConfigFile) {
    $loaded = Get-Content $ConfigFile -Raw | ConvertFrom-Json
    foreach ($key in @("projectId","host","port","publicBaseUrl","gptUrl","openBrowser","copyGreetingToClipboard","autoBootstrap","autoDoctor","tunnelMode","relayHost","relayPort","autoRelay")) {
      if ($null -ne $loaded.$key) { $defaults[$key] = $loaded.$key }
    }
  }
  return [pscustomobject]$defaults
}

function Invoke-Cli([string[]]$CliArgs, [int]$TimeoutSec = 20) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "node"
  $psi.Arguments = (($CliArgs | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join " ")
  $psi.WorkingDirectory = $Root
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $process = [System.Diagnostics.Process]::Start($psi)
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (!$process.WaitForExit($TimeoutSec * 1000)) {
    try { $process.Kill() } catch {}
    throw "CLI command timed out."
  }
  $process.WaitForExit()
  $stdoutText = $stdout.Result
  $stderrText = $stderr.Result
  if ($process.ExitCode -ne 0) {
    throw (($stderrText + " " + $stdoutText).Trim())
  }
  return $stdoutText
}

Set-Location $Root
Ensure-LocalDir $BridgeDir
Ensure-LocalDir $LogDir
Say "CodexLink launcher starting from $Root"

if (!(Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js was not found. Install Node.js 18+ and retry." }
if (!(Get-Command npm -ErrorAction SilentlyContinue)) { Fail "npm was not found. Install Node.js/npm and retry." }

if (!(Test-Path (Join-Path $Root "node_modules"))) {
  if ($Install) {
    if ($DryRun) { Say "Dry-run: would run npm install." } else {
      Say "Installing dependencies with npm install."
      npm install
      if ($LASTEXITCODE -ne 0) { Fail "npm install failed." }
    }
  } else {
    Fail "node_modules is missing. Run npm install, or rerun launcher with -Install."
  }
}

if (!(Test-Path (Join-Path $Root "dist\cli.js"))) {
  if ($DryRun) { Say "Dry-run: would run npm run build." } else {
    Say "dist\cli.js missing; running npm run build."
    npm run build
    if ($LASTEXITCODE -ne 0) { Fail "npm run build failed." }
  }
}

if (!(Test-Path $ConfigFile)) {
  $defaultProject = Split-Path $Root -Leaf
  if ($DryRun) {
    Say "Dry-run: would create local launcher config for project=$defaultProject."
  } else {
    Say "First run: creating local launcher config for project=$defaultProject."
    Invoke-Cli @("dist\cli.js","setup","launcher","--project",$defaultProject,"--json") | Out-Null
  }
}

$Config = Read-Config
$LocalUrl = "http://$($Config.host):$($Config.port)"
$HealthUrl = "$LocalUrl/health"
$Started = $false
$RelayMode = ([string]$Config.tunnelMode -eq "relay")
$RelayPairingCode = $null
$RelayPairingExpiresAt = $null
$RelayUrl = "http://$($Config.relayHost):$($Config.relayPort)"
$RelayHealthUrl = "$RelayUrl/relay/health"
$RelayStarted = $false
$RelayProcess = $null

if (Test-Health $HealthUrl) {
  Say "Local server: PASS ($HealthUrl)"
} elseif ($DryRun) {
  Say "Dry-run: would start node dist\cli.js start --host $($Config.host) --port $($Config.port)"
} else {
  Say "Starting AgentBridge at $LocalUrl"
  $process = Start-Process -FilePath "node" -ArgumentList @("dist\cli.js","start","--host",$Config.host,"--port",[string]$Config.port) -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  $Started = $true
  $ready = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Health $HealthUrl) { $ready = $true; break }
  }
  if (!$ready) { Fail "Local server health did not pass at $HealthUrl." }
  Say "Local server: PASS ($HealthUrl)"
}

if ($RelayMode) {
  Warn "Relay mode is experimental/local-only. Hosted stable relay is not production-ready yet."
  Say "Relay GPT Actions schema: openapi.codexlink.relay.gpt-actions.json"
  Say "Relay prototype command: node dist\cli.js relay serve --experimental --host $($Config.relayHost) --port $($Config.relayPort)"
  if ($Config.autoRelay) {
    if (Test-Health $RelayHealthUrl) {
      Say "Relay prototype: PASS ($RelayHealthUrl)"
    } elseif ($DryRun) {
      Say "Dry-run: would start relay prototype at $RelayUrl."
    } else {
      Say "Starting relay prototype at $RelayUrl"
      $RelayProcess = Start-Process -FilePath "node" -ArgumentList @("dist\cli.js","relay","serve","--experimental","--host",$Config.relayHost,"--port",[string]$Config.relayPort) -WorkingDirectory $Root -WindowStyle Hidden -PassThru
      $RelayStarted = $true
      $relayReady = $false
      for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Health $RelayHealthUrl) { $relayReady = $true; break }
      }
      if ($relayReady) {
        Say "Relay prototype: PASS ($RelayHealthUrl)"
      } else {
        Warn "Relay prototype health did not pass at $RelayHealthUrl."
      }
    }
  } else {
    Say "Relay prototype auto-start disabled."
  }
  if ($DryRun) {
    Say "Dry-run: would create a short-lived relay pairing code."
  } else {
    try {
      $pairingJson = Invoke-Cli @("dist\cli.js","relay","pairing","create","--json")
      $pairing = $pairingJson | ConvertFrom-Json
      $RelayPairingCode = [string]($pairing | Select-Object -ExpandProperty code)
      $RelayPairingExpiresAt = [string]($pairing | Select-Object -ExpandProperty expires_at)
      Say "Relay pairing: PASS (short-lived code printed once; expires=$RelayPairingExpiresAt)"
      Say-ConsoleOnly "Relay pairing code: $RelayPairingCode"
    } catch {
      Warn "Relay pairing create failed: $($_.Exception.Message)"
    }
  }
} elseif ($Config.publicBaseUrl) {
  if ([string]$Config.publicBaseUrl -match "trycloudflare\.com") {
    Warn "Quick Tunnel URL is temporary. GPT Actions may need schema update after restart. Use a stable tunnel/domain for one-click GPTs usage."
  } else {
    Say "Configured public URL: PASS ($($Config.publicBaseUrl))"
  }
} else {
  Warn "Configured public URL: WARN (missing). GPT Actions need an HTTPS public endpoint."
  Say "For true GPT Actions one-click, run setup launcher with --public-url or configure experimental --tunnel-mode relay."
}

if (!$DryRun -and ($Started -or $RelayStarted)) {
  $state = [ordered]@{
    started_at = (Get-Date).ToUniversalTime().ToString("o")
    host = $Config.host
    port = $Config.port
    local_url = $LocalUrl
    process_id = if ($Started -and $process) { $process.Id } else { $null }
    project_id = $Config.projectId
    public_base_url = $Config.publicBaseUrl
    relay_mode = $RelayMode
    relay_url = if ($RelayMode) { $RelayUrl } else { $null }
    relay_process_id = if ($RelayStarted -and $RelayProcess) { $RelayProcess.Id } else { $null }
  }
  $state | ConvertTo-Json -Depth 5 | Set-Content -Path $StateFile -Encoding UTF8
}

if ($Config.projectId -and $Config.autoBootstrap) {
  try {
    if ($DryRun) {
      Say "Dry-run: would bootstrap session for project=$($Config.projectId)."
    } else {
      $metadata = @{ local_url = $LocalUrl; public_url_configured = [bool]$Config.publicBaseUrl } | ConvertTo-Json -Compress
      Invoke-Cli @("dist\cli.js","session","activity-add",$Config.projectId,"--kind","launcher_started","--source","script","--summary","CodexLink one-click launcher started.","--metadata",$metadata,"--json") | Out-Null
      $bootstrap = Invoke-Cli @("dist\cli.js","session","bootstrap",$Config.projectId,"--source","one_click_launcher","--json")
      $revision = "unknown"
      $action = "unknown"
      $bootstrapText = ($bootstrap | Out-String)
      $revisionMatch = [regex]::Match($bootstrapText, '"revision"\s*:\s*(\d+)')
      if ($revisionMatch.Success) { $revision = $revisionMatch.Groups[1].Value }
      $actionMatch = [regex]::Match($bootstrapText, '"recommended_next_action"\s*:\s*"([^"]+)"')
      if ($actionMatch.Success) { $action = $actionMatch.Groups[1].Value }
      if ($revision -eq "unknown" -or $action -eq "unknown") {
        $summaryText = (Invoke-Cli @("dist\cli.js","session","summary",$Config.projectId,"--json") | Out-String)
        if ($revision -eq "unknown") {
          $summaryRevisionMatch = [regex]::Match($summaryText, '"revision"\s*:\s*(\d+)')
          if ($summaryRevisionMatch.Success) { $revision = $summaryRevisionMatch.Groups[1].Value }
        }
        if ($action -eq "unknown") {
          $summaryActionMatch = [regex]::Match($summaryText, '"recommended_next_action"\s*:\s*"([^"]+)"')
          if ($summaryActionMatch.Success) { $action = $summaryActionMatch.Groups[1].Value }
        }
      }
      if ($revision -eq "unknown" -and $action -eq "unknown") {
        Say "Session bootstrap: PASS (project=$($Config.projectId))"
      } else {
        Say "Session bootstrap: PASS (project=$($Config.projectId), revision=$revision, action=$action)"
      }
      Invoke-Cli @("dist\cli.js","session","context",$Config.projectId,"--compact","--json") | Out-Null
      Invoke-Cli @("dist\cli.js","session","activity-add",$Config.projectId,"--kind","launcher_ready","--source","script","--summary","CodexLink one-click launcher is ready.","--metadata",$metadata,"--json") | Out-Null
    }
  } catch {
    Warn "Session bootstrap/context had a warning: $($_.Exception.Message)"
    try {
      if (!$DryRun -and $Config.projectId) {
        $warningMetadata = @{ warning = "bootstrap_or_context_failed" } | ConvertTo-Json -Compress
        Invoke-Cli @("dist\cli.js","session","activity-add",$Config.projectId,"--kind","launcher_warn","--source","script","--status","warning","--summary","CodexLink launcher bootstrap/context warning.","--metadata",$warningMetadata,"--json") | Out-Null
      }
    } catch {}
  }
}

if ($Config.autoDoctor) {
  try {
    if ($DryRun) {
      Say "Dry-run: would run doctor --launcher."
    } else {
      Invoke-Cli @("dist\cli.js","doctor","--launcher","--project",$Config.projectId,"--json") 30 | Out-Null
      Say "Doctor launcher check: PASS"
    }
  } catch {
    Warn "Doctor launcher check returned a warning: $($_.Exception.Message)"
  }
}

$GreetingLines = @(
  "Xin chao CodexLink.",
  "",
  "Hay goi listProjects, chon project mac dinh neu co, roi goi getSessionSummary hoac getSessionContext cho project do.",
  "",
  "Sau do cho toi biet:",
  "- project dang active",
  "- session_id/revision",
  "- current_goal",
  "- phase/status",
  "- recent_activity",
  "- workspace snapshot/gaps neu co",
  "- recommended_next_action",
  "",
  "Khong doc repo neu chua can."
)
if ($RelayMode) {
  $GreetingLines += @(
    "",
    "Relay mode note: use the relay GPT Actions schema only with a trusted relay origin.",
    "First call pairDevice if available, then listProjects/getSessionSummary."
  )
  if ($RelayPairingCode) {
    $GreetingLines += "Relay pairing code: $RelayPairingCode"
  }
}
$Greeting = $GreetingLines -join "`n"

if ($Config.copyGreetingToClipboard -and !$NoClipboard) {
  if ($DryRun) { Say "Dry-run: would copy GPT greeting to clipboard." } else {
    try {
      Set-Clipboard -Value $Greeting
      Say "GPT greeting copied to clipboard."
    } catch {
      Warn "Could not copy GPT greeting to clipboard."
    }
  }
} else {
  Say "GPT greeting copy skipped."
}

if ($Config.gptUrl -and $Config.openBrowser -and !$NoOpenBrowser) {
  if ($DryRun) { Say "Dry-run: would open GPT URL $($Config.gptUrl)." } else {
    Start-Process $Config.gptUrl
    Say "GPT URL opened. Paste the greeting into GPTs."
  }
} else {
  Say "GPT URL open skipped. Paste the greeting into GPTs when ready."
}

Say "Next action: paste the greeting into GPTs and ask it to call listProjects/getSessionSummary."
Say "Log: $LogFile"
