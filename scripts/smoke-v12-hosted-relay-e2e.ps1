param(
  [string]$ProjectId = "AgentBridge",
  [switch]$AllRegistered
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codexlink-hosted-relay-smoke-" + [System.Guid]::NewGuid().ToString("N"))
$RelayLog = Join-Path $TempRoot "relay.log"
$RelayErr = Join-Path $TempRoot "relay.err.log"
$ClientLog = Join-Path $TempRoot "client.log"
$ClientErr = Join-Path $TempRoot "client.err.log"
$RelayProcess = $null
$ClientProcess = $null
$Pass = 0
$Fail = 0

function Pass([string]$Name) {
  $script:Pass += 1
  Write-Host "PASS: $Name"
}

function Fail([string]$Name, [string]$Message) {
  $script:Fail += 1
  Write-Host "FAIL: $Name - $Message" -ForegroundColor Red
}

function Invoke-Json([string]$Method, [string]$Url, [object]$Body = $null, [string]$RelaySession = "") {
  $headers = @{}
  if ($RelaySession) { $headers["X-CodexLink-Relay-Session"] = $RelaySession }
  if ($Body -ne $null) {
    return Invoke-RestMethod -Method $Method -Uri $Url -Headers $headers -ContentType "application/json" -Body ($Body | ConvertTo-Json -Compress) -TimeoutSec 10
  }
  return Invoke-RestMethod -Method $Method -Uri $Url -Headers $headers -TimeoutSec 10
}

function Invoke-Status([string]$Method, [string]$Url, [object]$Body = $null, [string]$RelaySession = "") {
  try {
    Invoke-Json $Method $Url $Body $RelaySession | Out-Null
    return 200
  } catch {
    return [int]$_.Exception.Response.StatusCode
  }
}

function Wait-Health([string]$Url) {
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $health = Invoke-Json GET $Url
      if ($health.ok -eq $true) { return $true }
    } catch {}
    Start-Sleep -Milliseconds 300
  }
  return $false
}

try {
  Set-Location $Root
  New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null

  $RelayProcess = Start-Process -FilePath "node" -ArgumentList @("dist\cli.js","relay","hosted","serve","--host","127.0.0.1","--port","0","--public-url","https://relay.codexlink.example.com") -WorkingDirectory $Root -RedirectStandardOutput $RelayLog -RedirectStandardError $RelayErr -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 800
  $relayText = Get-Content $RelayLog -Raw
  $portMatch = [regex]::Match($relayText, "127\.0\.0\.1:(\d+)")
  if (!$portMatch.Success) { throw "Could not determine hosted relay port." }
  $RelayUrl = "http://127.0.0.1:$($portMatch.Groups[1].Value)"
  if (Wait-Health "$RelayUrl/relay/health") { Pass "hosted relay health" } else { Fail "hosted relay health" "not reachable" }

  $schema = Invoke-Json GET "$RelayUrl/relay/openapi.json"
  if ($schema.servers[0].url -eq "https://relay.codexlink.example.com" -and !$schema.paths."/mcp") {
    Pass "stable relay OpenAPI schema"
  } else {
    Fail "stable relay OpenAPI schema" "server URL mismatch or /mcp present"
  }

  $clientArgs = @("dist\cli.js","relay","client","connect","--relay-url",$RelayUrl,"--ttl","60")
  if ($AllRegistered) {
    $clientArgs += "--all-registered"
  } else {
    $clientArgs += @("--project",$ProjectId)
  }
  $ClientProcess = Start-Process -FilePath "node" -ArgumentList $clientArgs -WorkingDirectory $Root -RedirectStandardOutput $ClientLog -RedirectStandardError $ClientErr -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 1200
  $clientText = Get-Content $ClientLog -Raw
  $codeMatch = [regex]::Match($clientText, "Pairing code:\s*([A-Z0-9-]+)")
  if (!$codeMatch.Success) { throw "Could not determine pairing code from client stdout." }
  $PairingCode = $codeMatch.Groups[1].Value
  Pass "relay client connected"

  $unpairedStatus = Invoke-Status GET "$RelayUrl/chatgpt/projects"
  if ($unpairedStatus -eq 401) { Pass "unpaired request rejected" } else { Fail "unpaired request rejected" "expected 401, got $unpairedStatus" }

  $mcpStatus = Invoke-Status GET "$RelayUrl/mcp"
  if ($mcpStatus -eq 404) { Pass "/mcp remains unavailable" } else { Fail "/mcp remains unavailable" "expected 404, got $mcpStatus" }

  $paired = Invoke-Json POST "$RelayUrl/relay/pair" @{ code = $PairingCode; gpt_session = "smoke-v12-hosted-relay" }
  if ($paired.ok -eq $true -and $paired.relay_session) { Pass "pairDevice binds relay session" } else { Fail "pairDevice binds relay session" "missing relay_session" }
  $RelaySession = [string]$paired.relay_session

  $routes = @(
    @{ name = "list projects"; url = "$RelayUrl/chatgpt/projects" },
    @{ name = "session summary"; url = "$RelayUrl/chatgpt/projects/$ProjectId/session/summary" },
    @{ name = "session context"; url = "$RelayUrl/chatgpt/projects/$ProjectId/session/context" },
    @{ name = "session timeline"; url = "$RelayUrl/chatgpt/projects/$ProjectId/session/timeline?limit=5" },
    @{ name = "inspect"; url = "$RelayUrl/chatgpt/projects/$ProjectId/inspect" },
    @{ name = "codex changes"; url = "$RelayUrl/chatgpt/projects/$ProjectId/codex-changes" },
    @{ name = "review packet"; url = "$RelayUrl/chatgpt/projects/$ProjectId/review-packet" },
    @{ name = "tree"; url = "$RelayUrl/chatgpt/projects/$ProjectId/tree?max_entries=50" },
    @{ name = "file search"; url = "$RelayUrl/chatgpt/projects/$ProjectId/files/search?q=project" },
    @{ name = "safe file read"; url = "$RelayUrl/chatgpt/projects/$ProjectId/file?path=package.json&max_chars=400" },
    @{ name = "grep"; url = "$RelayUrl/chatgpt/projects/$ProjectId/grep?q=relay&max_matches=10" }
  )

  $combined = ""
  foreach ($route in $routes) {
    try {
      $result = Invoke-Json GET $route.url $null $RelaySession
      $json = $result | ConvertTo-Json -Depth 20 -Compress
      $combined += $json
      if ($result.ok -eq $true) { Pass $route.name } else { Fail $route.name "ok was not true" }
    } catch {
      Fail $route.name $_.Exception.Message
    }
  }

  foreach ($bad in @("local_token","OPENAI_API_KEY=sk-","Bearer secret_should_not_leak",".agentbridge/local_token")) {
    if ($combined.Contains($bad)) { Fail "secret scan $bad" "found forbidden marker" } else { Pass "secret scan $bad" }
  }

  if ($Fail -eq 0) {
    Write-Host "OKKK"
  }
} finally {
  if ($ClientProcess -and !$ClientProcess.HasExited) {
    Stop-Process -Id $ClientProcess.Id -Force
    Wait-Process -Id $ClientProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
  }
  if ($RelayProcess -and !$RelayProcess.HasExited) {
    Stop-Process -Id $RelayProcess.Id -Force
    Wait-Process -Id $RelayProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
  }
  if (Test-Path $TempRoot) {
    for ($i = 0; $i -lt 5; $i++) {
      try {
        Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction Stop
        break
      } catch {
        Start-Sleep -Milliseconds 250
      }
    }
  }
}

Write-Host "Hosted relay smoke: PASS=$Pass FAIL=$Fail"
if ($Fail -ne 0) { exit 1 }
