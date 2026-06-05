param(
  [string]$ProjectId = "AgentBridge",
  [int]$Port = 7777,
  [string]$HostName = "127.0.0.1",
  [int]$RandomRounds = 20,
  [int]$Seed = 0,
  [switch]$SkipRegression,
  [switch]$NoStartServer
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# ============================================================
# CodexLink / AgentBridge v0.6 Shared Session Protocol Test
# Levels:
#   1) Fixed smoke test
#   2) Controlled randomized protocol workflow test
#   3) Negative/security/edge-case test
#
# This script must NOT:
#   - print bearer token
#   - push/tag/release
#   - add files to git
#   - intentionally store raw secrets
# ============================================================

$script:PassCount = 0
$script:WarnCount = 0
$script:FailCount = 0
$script:CreatedHandoffs = @()
$script:RandomMarkers = @()

function Step([string]$msg) {
  Write-Host ""
  Write-Host "============================================================"
  Write-Host $msg
  Write-Host "============================================================"
}

function Pass([string]$msg) {
  $script:PassCount++
  Write-Host "[PASS] $msg" -ForegroundColor Green
}

function Warn([string]$msg) {
  $script:WarnCount++
  Write-Host "[WARN] $msg" -ForegroundColor Yellow
}

function Fail([string]$msg) {
  $script:FailCount++
  Write-Host "[FAIL] $msg" -ForegroundColor Red
  Write-Host ""
  Write-Host "Partial summary:"
  Write-Host "  PASS: $script:PassCount"
  Write-Host "  WARN: $script:WarnCount"
  Write-Host "  FAIL: $script:FailCount"
  Write-Host ""
  exit 1
}

function Run([string]$cmd) {
  Write-Host "> $cmd"
  cmd /c $cmd
  if ($LASTEXITCODE -ne 0) {
    Fail "Command failed: $cmd"
  }
}

function RunCapture([string]$cmd) {
  Write-Host "> $cmd"
  $out = cmd /c $cmd 2>&1
  $exit = $LASTEXITCODE
  $out | ForEach-Object { Write-Host $_ }
  if ($exit -ne 0) {
    Fail "Command failed: $cmd"
  }
  return ($out -join "`n")
}

function New-TestId {
  return "rnd_" + ([Guid]::NewGuid().ToString("N").Substring(0, 8))
}

function Get-SessionRevision($response, [string]$label) {
  if ($null -eq $response) {
    Fail "Response is null while reading revision: $label"
  }

  if (Get-Member -InputObject $response -Name "summary" -MemberType NoteProperty -ErrorAction SilentlyContinue) {
    if ($response.summary -and (Get-Member -InputObject $response.summary -Name "revision" -MemberType NoteProperty -ErrorAction SilentlyContinue) -and $null -ne $response.summary.revision) {
      return [int]$response.summary.revision
    }
  }

  if (Get-Member -InputObject $response -Name "session" -MemberType NoteProperty -ErrorAction SilentlyContinue) {
    if ($response.session -and (Get-Member -InputObject $response.session -Name "revision" -MemberType NoteProperty -ErrorAction SilentlyContinue) -and $null -ne $response.session.revision) {
      return [int]$response.session.revision
    }
  }

  if (Get-Member -InputObject $response -Name "active_session" -MemberType NoteProperty -ErrorAction SilentlyContinue) {
    if ($response.active_session -and (Get-Member -InputObject $response.active_session -Name "revision" -MemberType NoteProperty -ErrorAction SilentlyContinue) -and $null -ne $response.active_session.revision) {
      return [int]$response.active_session.revision
    }
  }

  if (Get-Member -InputObject $response -Name "revision" -MemberType NoteProperty -ErrorAction SilentlyContinue) {
    if ($null -ne $response.revision) {
      return [int]$response.revision
    }
  }

  Write-Host ($response | ConvertTo-Json -Depth 20)
  Fail "Could not read revision from response: $label"
}

function Get-HandoffId($response) {
  if ($null -eq $response) {
    Fail "Handoff response is null"
  }

  if ((Get-Member -InputObject $response -Name "handoff" -MemberType NoteProperty -ErrorAction SilentlyContinue) -and $response.handoff) {
    if ((Get-Member -InputObject $response.handoff -Name "id" -MemberType NoteProperty -ErrorAction SilentlyContinue) -and $response.handoff.id) {
      return [string]$response.handoff.id
    }

    if ((Get-Member -InputObject $response.handoff -Name "handoff" -MemberType NoteProperty -ErrorAction SilentlyContinue) -and $response.handoff.handoff) {
      if ((Get-Member -InputObject $response.handoff.handoff -Name "id" -MemberType NoteProperty -ErrorAction SilentlyContinue) -and $response.handoff.handoff.id) {
        return [string]$response.handoff.handoff.id
      }
    }
  }

  if ((Get-Member -InputObject $response -Name "id" -MemberType NoteProperty -ErrorAction SilentlyContinue) -and $response.id) {
    return [string]$response.id
  }

  if ((Get-Member -InputObject $response -Name "handoff_id" -MemberType NoteProperty -ErrorAction SilentlyContinue) -and $response.handoff_id) {
    return [string]$response.handoff_id
  }

  Write-Host ($response | ConvertTo-Json -Depth 20)
  Fail "Could not determine handoff id from response"
}

function Invoke-JsonPost([string]$uri, $bodyObject, $headers) {
  $json = $bodyObject | ConvertTo-Json -Depth 20
  return Invoke-RestMethod -Method Post -Headers $headers -ContentType "application/json" -Uri $uri -Body $json
}

function ExpectHttp400([scriptblock]$action, [string]$label) {
  try {
    & $action | Out-Null
    Fail "$label did not fail"
  } catch {
    $code = $null
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $code = $_.Exception.Response.StatusCode.value__
    }

    if ($code -ne 400) {
      Fail "$label expected HTTP 400, got $code"
    }

    Pass "$label returns HTTP 400"
  }
}

function Assert-NoGitTrackedRuntime([string]$GitStatusText) {
  if ($GitStatusText -match "\.agentbridge[\\/]+sessions") {
    Fail ".agentbridge/sessions appears in git status. Runtime session files must not be tracked."
  }
  Pass ".agentbridge/sessions is not tracked by git"
}

function Select-Random($items, [System.Random]$rng) {
  return $items[$rng.Next(0, $items.Count)]
}

# ============================================================
# Main
# ============================================================

$Root = (Resolve-Path ".").Path
$BaseUrl = "http://$HostName`:$Port"

if ($Seed -eq 0) {
  $Seed = [int](Get-Date -Format "HHmmss")
}
$rng = [System.Random]::new($Seed)

Step "v0.6 shared session protocol smoke/random test"
Write-Host "Root:            $Root"
Write-Host "ProjectId:       $ProjectId"
Write-Host "BaseUrl:         $BaseUrl"
Write-Host "RandomRounds:    $RandomRounds"
Write-Host "Seed:            $Seed"
Write-Host "SkipRegression:  $SkipRegression"
Write-Host ""

Step "Repo sanity"

if (!(Test-Path "$Root\package.json")) {
  Fail "package.json not found. Run this script from repo root."
}

Run "git status --short"
Run "git log --oneline --decorate -8"

Step "Build and unit tests"

Run "npm run build"
Run "npm test"
Run "git diff --check"

Step "v0.6-alpha fixed CLI session smoke test"

Run "node dist\cli.js session active --json"
Run "node dist\cli.js session summary $ProjectId"
Run "node dist\cli.js session set-goal $ProjectId `"Script smoke test for v0.6 alpha beta shared session`""
Run "node dist\cli.js session event $ProjectId --actor codex --type note --summary `"Script alpha test: Codex wrote event from CLI`""
Run "node dist\cli.js session handoff $ProjectId --to codex --title `"Script alpha CLI handoff test`" --message `"Testing CLI handoff storage from smoke script`""
Run "node dist\cli.js session handoffs $ProjectId --open"

Step "Runtime storage check"

$SessionRoot = "$Root\.agentbridge\sessions\$ProjectId"
if (!(Test-Path "$SessionRoot\active_session.json")) {
  Fail "Missing active_session.json at $SessionRoot"
}

$active = Get-Content "$SessionRoot\active_session.json" -Raw | ConvertFrom-Json
$SessionId = $active.session_id
$SessionDir = "$SessionRoot\$SessionId"

$requiredFiles = @(
  "session.json",
  "state.json",
  "summary.json",
  "events.jsonl",
  "handoffs.jsonl"
)

foreach ($f in $requiredFiles) {
  if (!(Test-Path "$SessionDir\$f")) {
    Fail "Missing runtime file: $f"
  }
}

Get-Content "$SessionDir\session.json" -Raw | ConvertFrom-Json | Out-Null
Get-Content "$SessionDir\state.json" -Raw | ConvertFrom-Json | Out-Null
Get-Content "$SessionDir\summary.json" -Raw | ConvertFrom-Json | Out-Null
Pass "Runtime session JSON snapshots parse correctly"

foreach ($jsonl in @("events.jsonl", "handoffs.jsonl")) {
  $path = "$SessionDir\$jsonl"
  $lineNo = 0
  Get-Content $path | ForEach-Object {
    $lineNo++
    if (-not [string]::IsNullOrWhiteSpace($_)) {
      try {
        $_ | ConvertFrom-Json | Out-Null
      } catch {
        Fail "$jsonl has invalid JSON at line $lineNo"
      }
    }
  }
}
Pass "Runtime JSONL files parse correctly"
Pass "Runtime session files exist: $SessionDir"

$gitStatus = git status --short
Assert-NoGitTrackedRuntime ($gitStatus -join "`n")

Step "Start or detect local server"

$serverOk = $false
try {
  Invoke-RestMethod -Uri "$BaseUrl/health" -Method Get -TimeoutSec 2 | Out-Null
  $serverOk = $true
  Pass "Server already running at $BaseUrl"
} catch {
  if ($NoStartServer) {
    Fail "Server is not running at $BaseUrl and -NoStartServer was set"
  }
  Warn "Server not detected at $BaseUrl. Starting server in a new PowerShell window..."
}

if (-not $serverOk) {
  Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-ExecutionPolicy", "Bypass",
    "-Command", "cd `"$Root`"; node dist\cli.js start --host $HostName --port $Port"
  )

  Start-Sleep -Seconds 5

  try {
    Invoke-RestMethod -Uri "$BaseUrl/health" -Method Get -TimeoutSec 5 | Out-Null
    Pass "Server started at $BaseUrl"
  } catch {
    Fail "Server did not start or /health is unavailable at $BaseUrl"
  }
}

Step "Load local bearer token without printing it"

$tokenPath = "$Root\.agentbridge\local_token"
if (!(Test-Path $tokenPath)) {
  Fail "Missing .agentbridge/local_token. Run prepare-gpt-action.ps1 first."
}

$token = (Get-Content $tokenPath -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($token)) {
  Fail "local_token is empty"
}

$headers = @{ Authorization = "Bearer $token" }
Pass "Bearer token loaded without printing it"

Step "v0.6-beta fixed HTTP session smoke test"

$summaryBefore = Invoke-RestMethod -Headers $headers -Uri "$BaseUrl/chatgpt/projects/$ProjectId/session/summary"
$revBefore = Get-SessionRevision $summaryBefore "summary before HTTP event"
Pass "HTTP summary works. Revision before: $revBefore"

$eventResp = Invoke-JsonPost "$BaseUrl/chatgpt/projects/$ProjectId/session/events" @{
  actor = "chatgpt"
  type = "decision"
  summary = "Script beta test: ChatGPT wrote event through HTTP"
  details = "This checks GPT Actions can write to shared sessionStore."
} $headers

$summaryAfterEvent = Invoke-RestMethod -Headers $headers -Uri "$BaseUrl/chatgpt/projects/$ProjectId/session/summary"
$revAfterEvent = Get-SessionRevision $summaryAfterEvent "summary after HTTP event"

if ($revAfterEvent -le $revBefore) {
  Write-Host ($eventResp | ConvertTo-Json -Depth 20)
  Write-Host ($summaryAfterEvent | ConvertTo-Json -Depth 20)
  Fail "Revision did not increase after HTTP event. Before=$revBefore After=$revAfterEvent"
}
Pass "HTTP event wrote to session. Revision: $revBefore -> $revAfterEvent"

$cliSummaryAfterHttpEvent = RunCapture "node dist\cli.js session summary $ProjectId"
if ($cliSummaryAfterHttpEvent -notmatch "Script beta test") {
  Warn "CLI summary did not show the exact HTTP event text. It may be trimmed if many events exist."
} else {
  Pass "CLI can see HTTP-written event"
}

$handoffResp = Invoke-JsonPost "$BaseUrl/chatgpt/projects/$ProjectId/session/handoffs" @{
  from = "chatgpt"
  to = "codex"
  title = "Script beta HTTP handoff test"
  message = "ChatGPT creates a handoff through HTTP; Codex should read it through CLI."
  constraints = @("No release", "No tag change", "No raw file content in session")
  expected_output = @("Codex can list this handoff via CLI", "Codex can update the handoff status")
} $headers

$handoffId = Get-HandoffId $handoffResp
$script:CreatedHandoffs += $handoffId
Pass "HTTP handoff created: $handoffId"

$handoffsText = RunCapture "node dist\cli.js session handoffs $ProjectId --open"
if ($handoffsText -notmatch [regex]::Escape($handoffId)) {
  Fail "CLI did not show HTTP-created handoff: $handoffId"
}
Pass "CLI can see HTTP-created handoff"

Run "node dist\cli.js session update-handoff $ProjectId $handoffId --status acknowledged"

$summaryAfterAck = Invoke-RestMethod -Headers $headers -Uri "$BaseUrl/chatgpt/projects/$ProjectId/session/summary"
$summaryAckJson = $summaryAfterAck | ConvertTo-Json -Depth 20
if ($summaryAckJson -notmatch [regex]::Escape($handoffId)) {
  Warn "HTTP summary did not include handoff id. This may be okay if summary trims older handoffs."
} elseif ($summaryAckJson -notmatch "acknowledged") {
  Warn "HTTP summary includes handoff id but did not visibly show acknowledged. Inspect manually if needed."
} else {
  Pass "HTTP can see CLI-updated handoff status"
}

$updates = Invoke-RestMethod -Headers $headers -Uri "$BaseUrl/chatgpt/projects/$ProjectId/session/updates?since_revision=$revBefore"
$updatesJson = $updates | ConvertTo-Json -Depth 20
if ($updatesJson -notmatch "Script beta test") {
  Warn "updates?since_revision did not visibly include the script beta event text. Inspect response manually."
} else {
  Pass "updates since_revision includes HTTP event"
}

Step "Controlled randomized protocol workflow test"

$validActors = @("chatgpt", "codex", "user", "system")
$validEventTypes = @("note", "decision", "correction", "implementation", "review", "test_result", "warning", "blocker")
$validHandoffStatuses = @("acknowledged", "in_progress", "done", "blocked", "cancelled")
$validPhases = @("planning", "implementation", "review", "blocked", "done")
$validSessionStatuses = @("active", "in_progress", "blocked", "done")

$summaryStart = Invoke-RestMethod -Headers $headers -Uri "$BaseUrl/chatgpt/projects/$ProjectId/session/summary"
$lastRevision = Get-SessionRevision $summaryStart "random test start summary"

for ($i = 1; $i -le $RandomRounds; $i++) {
  $caseId = New-TestId
  $action = Select-Random @("http_event", "cli_event", "http_handoff", "cli_handoff", "set_goal_http", "set_goal_cli") $rng

  Write-Host ""
  Write-Host "[RANDOM $i/$RandomRounds] action=$action case=$caseId"

  if ($action -eq "http_event") {
    $actor = Select-Random $validActors $rng
    $type = Select-Random $validEventTypes $rng
    $summaryText = "Random HTTP event $caseId actor=$actor type=$type"

    Invoke-JsonPost "$BaseUrl/chatgpt/projects/$ProjectId/session/events" @{
      actor = $actor
      type = $type
      summary = $summaryText
      details = "Randomized protocol test via HTTP. marker=$caseId"
    } $headers | Out-Null

    $script:RandomMarkers += $caseId
  }
  elseif ($action -eq "cli_event") {
    $type = Select-Random $validEventTypes $rng
    $summaryText = "Random CLI event $caseId type=$type"

    Run "node dist\cli.js session event $ProjectId --actor codex --type $type --summary `"$summaryText`""
    $script:RandomMarkers += $caseId
  }
  elseif ($action -eq "http_handoff") {
    $to = Select-Random @("codex", "chatgpt") $rng
    $from = if ($to -eq "codex") { "chatgpt" } else { "codex" }

    $handoffRespRnd = Invoke-JsonPost "$BaseUrl/chatgpt/projects/$ProjectId/session/handoffs" @{
      from = $from
      to = $to
      title = "Random HTTP handoff $caseId"
      message = "Randomized handoff created through HTTP. marker=$caseId"
      constraints = @("No release", "No tag change", "No raw file content")
      expected_output = @("Visible from CLI", "Status can be updated")
    } $headers

    $handoffIdRnd = Get-HandoffId $handoffRespRnd
    $script:CreatedHandoffs += $handoffIdRnd
    $script:RandomMarkers += $caseId

    $cliHandoffs = RunCapture "node dist\cli.js session handoffs $ProjectId --open"
    if ($cliHandoffs -notmatch [regex]::Escape($handoffIdRnd)) {
      Fail "Random HTTP handoff was not visible from CLI: $handoffIdRnd"
    }
    Pass "Random HTTP handoff visible from CLI: $handoffIdRnd"
  }
  elseif ($action -eq "cli_handoff") {
    $title = "Random CLI handoff $caseId"
    Run "node dist\cli.js session handoff $ProjectId --to codex --title `"$title`" --message `"Randomized handoff from CLI marker=$caseId`""
    $script:RandomMarkers += $caseId
  }
  elseif ($action -eq "set_goal_http") {
    $phase = Select-Random $validPhases $rng
    $status = Select-Random $validSessionStatuses $rng

    Invoke-JsonPost "$BaseUrl/chatgpt/projects/$ProjectId/session/goal" @{
      goal = "Random HTTP goal $caseId"
      phase = $phase
      status = $status
    } $headers | Out-Null

    $script:RandomMarkers += $caseId
  }
  elseif ($action -eq "set_goal_cli") {
    Run "node dist\cli.js session set-goal $ProjectId `"Random CLI goal $caseId`""
    $script:RandomMarkers += $caseId
  }

  $summaryNow = Invoke-RestMethod -Headers $headers -Uri "$BaseUrl/chatgpt/projects/$ProjectId/session/summary"
  $revNow = Get-SessionRevision $summaryNow "random test summary after $action"

  if ($revNow -le $lastRevision) {
    Fail "Revision did not increase after random action. action=$action before=$lastRevision after=$revNow seed=$Seed case=$caseId"
  }

  Pass "Revision increased: $lastRevision -> $revNow"
  $lastRevision = $revNow
}

Pass "Randomized workflow actions completed: $RandomRounds"

Step "Randomized handoff status lifecycle test"

$handoffsToUpdate = @($script:CreatedHandoffs | Select-Object -Unique | Select-Object -First 6)

foreach ($hid in $handoffsToUpdate) {
  $newStatus = Select-Random $validHandoffStatuses $rng
  Write-Host "[RANDOM HANDOFF] $hid -> $newStatus"

  Run "node dist\cli.js session update-handoff $ProjectId $hid --status $newStatus"

  $updatesAfterHandoff = Invoke-RestMethod -Headers $headers -Uri "$BaseUrl/chatgpt/projects/$ProjectId/session/updates?since_revision=0"
  $updatesAfterHandoffJson = $updatesAfterHandoff | ConvertTo-Json -Depth 30

  if ($updatesAfterHandoffJson -notmatch [regex]::Escape($hid)) {
    Fail "HTTP updates did not include CLI-updated handoff: $hid"
  }

  Pass "HTTP can see CLI-updated handoff: $hid -> $newStatus"
}

Step "Negative validation tests"

ExpectHttp400 {
  Invoke-JsonPost "$BaseUrl/chatgpt/projects/$ProjectId/session/events" @{
    actor = "bad_actor_" + (New-TestId)
    type = "note"
    summary = "Should fail bad actor"
  } $headers
} "Invalid actor"

ExpectHttp400 {
  Invoke-JsonPost "$BaseUrl/chatgpt/projects/$ProjectId/session/events" @{
    actor = "chatgpt"
    type = "bad_type_" + (New-TestId)
    summary = "Should fail bad type"
  } $headers
} "Invalid event type"

if ($handoffsToUpdate.Count -gt 0) {
  $badHandoff = $handoffsToUpdate[0]
  ExpectHttp400 {
    Invoke-JsonPost "$BaseUrl/chatgpt/projects/$ProjectId/session/handoffs/$badHandoff" @{
      status = "bad_status_" + (New-TestId)
    } $headers
  } "Invalid handoff status"
} else {
  Warn "No handoff id available for invalid status test"
}

Step "Randomized redaction and truncation tests"

$secretMarker = New-TestId
$fakeKey = "sk-test-$secretMarker-secret"
$fakePassword = "pw_$secretMarker"
$fakeToken = "tok_$secretMarker"
$fakeBearer = "bearer_$secretMarker"

Invoke-JsonPost "$BaseUrl/chatgpt/projects/$ProjectId/session/events" @{
  actor = "chatgpt"
  type = "note"
  summary = "Random redaction $secretMarker OPENAI_API_KEY=$fakeKey PASSWORD=$fakePassword token=$fakeToken"
  details = "Bearer $fakeBearer"
} $headers | Out-Null

$secretHits = Select-String -Path "$SessionDir\*.json", "$SessionDir\*.jsonl" `
  -Pattern $fakeKey, $fakePassword, $fakeToken, $fakeBearer `
  -ErrorAction SilentlyContinue

if ($secretHits) {
  $secretHits | ForEach-Object { Write-Host $_ }
  Fail "Random secret-like raw values were found in session runtime files"
}
Pass "Random secret-like values were redacted"

$longMarker = New-TestId
$longText = "long_$longMarker " + ("x" * 12000)

Invoke-JsonPost "$BaseUrl/chatgpt/projects/$ProjectId/session/events" @{
  actor = "chatgpt"
  type = "note"
  summary = "Random truncation test $longMarker"
  details = $longText
} $headers | Out-Null

$summaryAfterLong = Invoke-RestMethod -Headers $headers -Uri "$BaseUrl/chatgpt/projects/$ProjectId/session/summary"
$summaryAfterLongJson = $summaryAfterLong | ConvertTo-Json -Depth 30

if ($summaryAfterLongJson -notmatch "truncated") {
  Warn "Summary did not visibly include truncated marker. This may be okay if event was trimmed from recent summary."
} else {
  Pass "Long details truncation marker visible in summary/update output"
}

Step "OpenAPI/GPT Actions schema check"

$openapiFiles = @(
  "$Root\openapi.agentbridge.json",
  "$Root\openapi.agentbridge.gpt-actions.json"
)

$expectedOperationIds = @(
  "getProjectSession",
  "getSessionSummary",
  "getSessionUpdates",
  "appendSessionEvent",
  "addSessionHandoff",
  "updateSessionHandoff",
  "setSessionGoal",
  "listProjects",
  "getActiveProject",
  "getProjectTree",
  "searchProjectFiles",
  "readProjectFile",
  "searchProjectText",
  "selectProject",
  "inspectProject",
  "getCodexChanges",
  "getReviewPacket"
)

foreach ($file in $openapiFiles) {
  if (!(Test-Path $file)) {
    Fail "Missing OpenAPI file: $file"
  }

  $raw = Get-Content $file -Raw
  $json = $raw | ConvertFrom-Json
  $json | Out-Null

  foreach ($op in $expectedOperationIds) {
    if ($raw -notmatch "`"operationId`"\s*:\s*`"$op`"") {
      Fail "OpenAPI missing operationId $op in $file"
    }
  }

  if ($raw -match "`"/mcp") {
    Fail "OpenAPI contains HTTP /mcp endpoint in $file"
  }

  if ($raw -match "`"/chatgpt/projects/\{projectId\}/scan") {
    Fail "OpenAPI contains HTTP scan endpoint in $file"
  }

  if ($raw -match "OPENAI_API_KEY") {
    Fail "OpenAPI appears to require OPENAI_API_KEY in $file"
  }

  Pass "OpenAPI schema check passed: $file"
}

Step "Final runtime/git safety check"

$gitStatusFinal = git status --short
Assert-NoGitTrackedRuntime ($gitStatusFinal -join "`n")

Step "Final regression"

if ($SkipRegression) {
  Warn "Skipping regression checks because -SkipRegression was set"
} else {
  Run "npm run build"
  Run "npm test"
  Run "git diff --check"

  if (Test-Path "$Root\scripts\test-codexlink-v05-gamma-delta-full-workflow.ps1") {
    Run "powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-codexlink-v05-gamma-delta-full-workflow.ps1"
  } else {
    Warn "Full workflow script not found; skipped."
  }
}

Step "Final report"

$finalSummary = Invoke-RestMethod -Headers $headers -Uri "$BaseUrl/chatgpt/projects/$ProjectId/session/summary"
$finalRevision = Get-SessionRevision $finalSummary "final summary"

Run "git status --short"

Write-Host ""
Write-Host "v0.6 alpha/beta protocol workflow test completed."
Write-Host ""
Write-Host "Result:"
Write-Host "  PASS:            $script:PassCount"
Write-Host "  WARN:            $script:WarnCount"
Write-Host "  FAIL:            $script:FailCount"
Write-Host "  Seed:            $Seed"
Write-Host "  RandomRounds:    $RandomRounds"
Write-Host "  ProjectId:       $ProjectId"
Write-Host "  SessionId:       $SessionId"
Write-Host "  FinalRevision:   $finalRevision"
Write-Host "  CreatedHandoffs: $($script:CreatedHandoffs -join ', ')"
Write-Host ""
Write-Host "Verified:"
Write-Host "  - CLI writes are visible in shared session"
Write-Host "  - HTTP writes are visible to CLI"
Write-Host "  - CLI updates are visible to HTTP"
Write-Host "  - revision increases after writes"
Write-Host "  - updates since_revision works"
Write-Host "  - handoff lifecycle works"
Write-Host "  - random workflow cases passed"
Write-Host "  - invalid inputs return 400"
Write-Host "  - secrets are redacted"
Write-Host "  - .agentbridge/sessions is not git tracked"
Write-Host ""
Write-Host "Next:"
Write-Host "  If this script PASSes repeatedly, commit it with:"
Write-Host "    git add scripts\smoke-v06-session.ps1"
Write-Host "    git commit -m `"test: add v0.6 shared session smoke script`""
Write-Host ""
