param(
  [int]$RandomRounds = 20,
  [string]$ProjectId = "AgentBridge"
)

$ErrorActionPreference = "Stop"
$Pass = 0
$Fail = 0

function Pass($Message) {
  $script:Pass++
  Write-Host "PASS $Message"
}

function Fail($Message) {
  $script:Fail++
  Write-Host "FAIL $Message"
}

function RunCliJson(
  [Alias("Args")]
  [string[]]$CliArgs
) {
  $output = & node dist\cli.js @CliArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: node dist\cli.js $($CliArgs -join ' ')`n$output"
  }
  return $output | ConvertFrom-Json
}

function ActivityCount() {
  $activity = RunCliJson -Args @("session", "activity", $ProjectId, "--recent", "--json")
  return @($activity.activities).Count
}

$Marker = "v08_beta_smoke_$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())_$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$FakeOpenAI = "OPENAI_API_KEY=sk-test_should_not_leak_$Marker"
$FakeToken = "token=abc_should_not_leak_$Marker"
$FakeBearer = "Bearer should_not_leak_$Marker"

try {
  $bootstrap = RunCliJson -Args @(
    "session", "bootstrap", $ProjectId,
    "--source", "v08_beta_smoke",
    "--json"
  )
  if ($bootstrap.ok -and $bootstrap.recent_activity) { Pass "bootstrap returns recent_activity" } else { Fail "bootstrap returns recent_activity" }

  $handoff = RunCliJson -Args @(
    "session", "handoff", $ProjectId,
    "--from", "chatgpt",
    "--to", "codex",
    "--title", "v0.8 beta smoke handoff $Marker",
    "--message", "Acknowledge this smoke handoff. $FakeOpenAI",
    "--json"
  )
  $handoffId = $handoff.handoff.id
  $addedActivity = @($handoff.summary.recent_activity) | Select-Object -Last 1
  if ($addedActivity.kind -eq "handoff_added" -and $addedActivity.related.handoff_id -eq $handoffId) {
    Pass "handoff_added activity recorded"
  } else {
    Fail "handoff_added activity recorded"
  }

  $updated = RunCliJson -Args @(
    "session", "update-handoff", $ProjectId, $handoffId,
    "--actor", "codex",
    "--status", "acknowledged",
    "--summary", "Acknowledged smoke handoff. $FakeBearer",
    "--json"
  )
  $updateActivity = @($updated.summary.recent_activity) | Select-Object -Last 1
  if (
    $updateActivity.kind -eq "handoff_acknowledged" -and
    $updateActivity.metadata.status_before -eq "open" -and
    $updateActivity.metadata.status_after -eq "acknowledged"
  ) {
    Pass "handoff acknowledged activity recorded with before/after"
  } else {
    Fail "handoff acknowledged activity recorded with before/after"
  }

  $check = RunCliJson -Args @(
    "session", "check", $ProjectId,
    "--type", "workflow",
    "--status", "pass",
    "--summary", "v0.8 beta smoke check $Marker $FakeToken",
    "--command", "smoke workflow metadata only $FakeToken",
    "--exit-code", "0",
    "--duration-ms", "12",
    "--json"
  )
  $checkActivity = @($check.summary.recent_activity) | Select-Object -Last 1
  if ($checkActivity.kind -eq "check_logged" -and $checkActivity.metadata.output_stored -eq $false) {
    Pass "check_logged activity recorded without output"
  } else {
    Fail "check_logged activity recorded without output"
  }

  $beforeReads = ActivityCount
  [void](RunCliJson -Args @("session", "summary", $ProjectId, "--json"))
  [void](RunCliJson -Args @("session", "summary", $ProjectId, "--json"))
  $afterReads = ActivityCount
  if ($beforeReads -eq $afterReads) { Pass "read-only summary does not spam activity" } else { Fail "read-only summary does not spam activity" }

  for ($i = 0; $i -lt $RandomRounds; $i++) {
    $choice = Get-Random -Minimum 0 -Maximum 4
    if ($choice -eq 0) {
      [void](RunCliJson -Args @("session", "summary", $ProjectId, "--json"))
    } elseif ($choice -eq 1) {
      [void](RunCliJson -Args @("session", "bootstrap", $ProjectId, "--source", "v08_beta_smoke", "--json"))
    } elseif ($choice -eq 2) {
      [void](RunCliJson -Args @(
        "session", "check", $ProjectId,
        "--type", "smoke",
        "--status", "pass",
        "--summary", "random smoke metadata round $i $Marker",
        "--json"
      ))
    } else {
      [void](RunCliJson -Args @("session", "activity", $ProjectId, "--recent", "--json"))
    }
  }
  Pass "random rounds completed: $RandomRounds"

  $summary = RunCliJson -Args @("session", "summary", $ProjectId, "--json")
  $counts = $summary.summary.activity_counts
  foreach ($kind in @("handoff_added", "handoff_acknowledged", "check_logged")) {
    if ($counts.$kind -ge 1) { Pass "summary activity_counts includes $kind" } else { Fail "summary activity_counts includes $kind" }
  }

  $sessionId = $summary.summary.session_id
  $sessionDir = Join-Path (Get-Location) ".agentbridge\sessions\$ProjectId\$sessionId"
  $text = ""
  foreach ($file in @("activity.jsonl", "summary.json", "state.json")) {
    $path = Join-Path $sessionDir $file
    if (Test-Path $path) {
      $text += Get-Content -Raw $path
    }
  }
  if ($text.Contains($FakeOpenAI) -or $text.Contains($FakeToken) -or $text.Contains($FakeBearer)) {
    Fail "fake secrets are redacted from activity runtime files"
  } else {
    Pass "fake secrets are redacted from activity runtime files"
  }
  if ($text.Contains("raw terminal output") -or $text.Contains("diff --git")) {
    Fail "raw terminal/diff output not stored"
  } else {
    Pass "raw terminal/diff output not stored"
  }

  $trackedSessions = git status --short -- .agentbridge/sessions
  if ([string]::IsNullOrWhiteSpace($trackedSessions)) { Pass ".agentbridge/sessions not tracked" } else { Fail ".agentbridge/sessions not tracked" }
} catch {
  Fail $_.Exception.Message
}

Write-Host ""
Write-Host "v0.8 session activity smoke: PASS=$Pass FAIL=$Fail RandomRounds=$RandomRounds"
if ($Fail -gt 0) {
  exit 1
}
