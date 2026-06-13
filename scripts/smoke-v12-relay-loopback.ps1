param(
  [string]$ProjectId = "AgentBridge",
  [int]$Port = 8790
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RelayUrl = "http://127.0.0.1:$Port"
$SessionHint = "smoke-v12-relay-loopback"
$RelayProcess = $null
$Pass = 0
$Fail = 0

function Pass-Step([string]$Name) {
  $script:Pass += 1
  Write-Host "PASS: $Name"
}

function Fail-Step([string]$Name, [string]$Message) {
  $script:Fail += 1
  Write-Host "FAIL: $Name - $Message" -ForegroundColor Red
}

function Invoke-Json([string]$Method, [string]$Url, [object]$Body = $null, [hashtable]$Headers = @{}) {
  $params = @{
    Method = $Method
    Uri = $Url
    TimeoutSec = 10
    Headers = $Headers
  }
  if ($null -ne $Body) {
    $params.ContentType = "application/json"
    $params.Body = ($Body | ConvertTo-Json -Compress)
  }
  Invoke-RestMethod @params
}

function Assert-NoSecretText([string]$Name, [string]$Text) {
  $patterns = @(
    @{ label = "local_token"; regex = "local_token" },
    @{ label = "raw bearer"; regex = "Bearer\s+(?!\[REDACTED\])\S+" },
    @{ label = "raw OpenAI key"; regex = "OPENAI_API_KEY\s*=\s*(?!\[REDACTED\])\S+" },
    @{ label = "raw sk key"; regex = "sk-[A-Za-z0-9_=-]{8,}" },
    @{ label = "raw password"; regex = "password\s*=\s*(?!\[REDACTED\])\S+" },
    @{ label = "raw token"; regex = "token\s*=\s*(?!\[REDACTED\])\S+" }
  )
  foreach ($pattern in $patterns) {
    if ($Text -match $pattern.regex) {
      Fail-Step $Name "secret-like text found: $($pattern.label)"
      return
    }
  }
  Pass-Step $Name
}

Set-Location $Root
Write-Host "CodexLink v1.2 relay loopback smoke"
Write-Host "Project: $ProjectId"
Write-Host "Relay: $RelayUrl"

try {
  if (!(Test-Path (Join-Path $Root "dist\cli.js"))) {
    throw "dist\cli.js is missing. Run npm run build first."
  }

  node dist\cli.js session bootstrap $ProjectId --source relay_loopback_smoke --json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "session bootstrap failed." }
  Pass-Step "session bootstrap"

  $pairingJson = node dist\cli.js relay pairing create --ttl 120 --json
  if ($LASTEXITCODE -ne 0) { throw "relay pairing create failed." }
  $pairing = $pairingJson | ConvertFrom-Json
  if (!$pairing.code -or $pairing.code_value_stored -ne $false) { throw "pairing output invalid." }
  Pass-Step "pairing code created"

  $RelayProcess = Start-Process -FilePath "node" -ArgumentList @("dist\cli.js","relay","serve","--experimental","--host","127.0.0.1","--port",[string]$Port) -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  $healthy = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-Json "GET" "$RelayUrl/relay/health"
      if ($health.ok -eq $true -and $health.local_only -eq $true) { $healthy = $true; break }
    } catch {}
  }
  if (!$healthy) { throw "relay health did not pass." }
  Pass-Step "relay health"

  $mcpStatus = 0
  try {
    Invoke-Json "GET" "$RelayUrl/mcp" | Out-Null
    $mcpStatus = 200
  } catch {
    $mcpStatus = [int]$_.Exception.Response.StatusCode
  }
  if ($mcpStatus -ne 404) { throw "/mcp returned status $mcpStatus, expected 404." }
  Pass-Step "no /mcp endpoint"

  $deniedStatus = 0
  try {
    Invoke-Json "GET" "$RelayUrl/chatgpt/projects" | Out-Null
    $deniedStatus = 200
  } catch {
    $deniedStatus = [int]$_.Exception.Response.StatusCode
  }
  if ($deniedStatus -ne 401) { throw "unpaired listProjects returned status $deniedStatus, expected 401." }
  Pass-Step "unpaired metadata denied"

  $paired = Invoke-Json "POST" "$RelayUrl/relay/pair" @{ code = $pairing.code; gpt_session = $SessionHint }
  if ($paired.ok -ne $true -or $paired.code_value_stored -ne $false) { throw "pairDevice failed." }
  $pairedText = $paired | ConvertTo-Json -Depth 10 -Compress
  if ($pairedText.Contains($pairing.code)) { throw "pairing response leaked raw code." }
  Pass-Step "pairDevice"

  $headers = @{ "X-CodexLink-Relay-Session" = $SessionHint }
  $projects = Invoke-Json "GET" "$RelayUrl/chatgpt/projects" $null $headers
  if ($projects.ok -ne $true -or $projects.operation_id -ne "listProjects") { throw "listProjects relay call failed." }
  Pass-Step "listProjects via relay"
  Assert-NoSecretText "listProjects no secret text" ($projects | ConvertTo-Json -Depth 20 -Compress)

  $summary = Invoke-Json "GET" "$RelayUrl/chatgpt/projects/$ProjectId/session/summary" $null $headers
  if ($summary.ok -ne $true -or $summary.operation_id -ne "getSessionSummary") { throw "getSessionSummary relay call failed." }
  if ($summary.metadata.content_stored -ne $false) { throw "summary metadata must report content_stored=false." }
  Pass-Step "getSessionSummary via relay"
  Assert-NoSecretText "summary no secret text" ($summary | ConvertTo-Json -Depth 20 -Compress)

  $context = Invoke-Json "GET" "$RelayUrl/chatgpt/projects/$ProjectId/session/context" $null $headers
  if ($context.ok -ne $true -or $context.operation_id -ne "getSessionContext") { throw "getSessionContext relay call failed." }
  Pass-Step "getSessionContext via relay"

  $timeline = Invoke-Json "GET" "$RelayUrl/chatgpt/projects/$ProjectId/session/timeline?mode=recent&limit=5" $null $headers
  if ($timeline.ok -ne $true -or $timeline.operation_id -ne "getSessionTimeline") { throw "getSessionTimeline relay call failed." }
  Pass-Step "getSessionTimeline via relay"

  if ($Fail -gt 0) {
    Write-Host "Overall: FAIL ($Pass PASS / $Fail FAIL)" -ForegroundColor Red
    exit 1
  }
  Write-Host "Overall: PASS ($Pass PASS / $Fail FAIL)"
  Write-Host "OKKK"
  exit 0
} catch {
  Fail-Step "relay loopback smoke" $_.Exception.Message
  Write-Host "Overall: FAIL ($Pass PASS / $Fail FAIL)" -ForegroundColor Red
  exit 1
} finally {
  if ($RelayProcess) {
    try { Stop-Process -Id $RelayProcess.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
}
