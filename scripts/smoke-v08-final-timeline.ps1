param(
  [int]$RandomRounds = 1
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Cli = Join-Path $RepoRoot "dist\cli.js"
$Pass = 0
$Fail = 0
$ProjectId = "SmokeTimeline"
$Marker = "v08-final-marker-$([guid]::NewGuid().ToString('N'))"

function Pass($Message) {
  $script:Pass += 1
  Write-Host "PASS $Message"
}

function Fail($Message) {
  $script:Fail += 1
  Write-Host "FAIL $Message" -ForegroundColor Red
}

function Run-Json($WorkRoot, [string[]]$CliArgs) {
  $output = & node $Cli @CliArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: node dist\cli.js $($CliArgs -join ' ') :: $output"
  }
  return $output | ConvertFrom-Json
}

function Assert-True($Condition, $Message) {
  if ($Condition) {
    Pass $Message
  } else {
    Fail $Message
  }
}

$WorkRoot = Join-Path ([System.IO.Path]::GetTempPath()) "codexlink-v08-final-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $WorkRoot | Out-Null
try {
  Push-Location $WorkRoot
  git init | Out-Null
  Set-Content -Path ".gitignore" -Value ".agentbridge/" -Encoding UTF8
  Run-Json $WorkRoot @("project", "register-current", $ProjectId) | Out-Null

  $bootstrap = Run-Json $WorkRoot @("session", "bootstrap", $ProjectId, "--source", "v08_final_smoke", "--json")
  Assert-True ($bootstrap.ok -eq $true) "bootstrap works"

  $handoff = Run-Json $WorkRoot @(
    "session", "handoff", $ProjectId,
    "--from", "chatgpt",
    "--to", "codex",
    "--title", "v0.8 final timeline smoke",
    "--message", "Create timeline proof without raw content.",
    "--json"
  )
  $handoffId = [string]$handoff.handoff.id
  Run-Json $WorkRoot @("session", "update-handoff", $ProjectId, $handoffId, "--status", "acknowledged", "--json") | Out-Null
  $handoffTimeline = Run-Json $WorkRoot @("session", "timeline", $ProjectId, "--handoff", $handoffId, "--json")
  $handoffKinds = @($handoffTimeline.activities | ForEach-Object { $_.kind })
  Assert-True (($handoffKinds -contains "handoff_added") -and ($handoffKinds -contains "handoff_acknowledged")) "handoff timeline includes add and acknowledge"

  $safeFile = "v08-final-safe.txt"
  Set-Content -Path $safeFile -Value $Marker -Encoding UTF8
  $reconcile = Run-Json $WorkRoot @("session", "reconcile", $ProjectId, "--json")
  $writtenKinds = @($reconcile.activities_written | ForEach-Object { $_.kind })
  Assert-True ($writtenKinds -contains "workspace_snapshot") "reconcile writes workspace_snapshot"
  Assert-True ($writtenKinds -contains "activity_gap_detected") "reconcile detects activity gap"

  $hash = (Get-FileHash -Algorithm SHA256 -Path $safeFile).Hash.ToLowerInvariant()
  $verify = Run-Json $WorkRoot @("session", "file-verify", $ProjectId, "--path", $safeFile, "--expect-sha256", $hash, "--json")
  Assert-True (($verify.verified -eq $true) -and ($verify.activity.kind -eq "file_verify")) "file verify records hash metadata"

  $check = Run-Json $WorkRoot @(
    "session", "check", $ProjectId,
    "--type", "workflow",
    "--status", "pass",
    "--summary", "Final timeline smoke check passed OPENAI_API_KEY=sk-test_should_not_leak",
    "--json"
  )
  Assert-True ($check.check.status -eq "pass") "check metadata logged"

  $task = Run-Json $WorkRoot @(
    "session", "activity-add", $ProjectId,
    "--kind", "task_complete",
    "--status", "success",
    "--summary", "Final timeline smoke task complete",
    "--task-id", "final-smoke-task",
    "--json"
  )
  Assert-True ($task.activity.kind -eq "task_complete") "task_complete activity logged"

  $fileTimeline = Run-Json $WorkRoot @("session", "timeline", $ProjectId, "--file", $safeFile, "--json")
  $fileKinds = @($fileTimeline.activities | ForEach-Object { $_.kind })
  Assert-True (($fileKinds -contains "file_verify") -and ($fileKinds -contains "workspace_snapshot")) "file timeline includes verify and snapshot"

  $taskTimeline = Run-Json $WorkRoot @("session", "timeline", $ProjectId, "--task", "final-smoke-task", "--json")
  Assert-True (@($taskTimeline.activities | Where-Object { $_.kind -eq "task_complete" }).Count -eq 1) "task timeline includes task_complete"

  $context = Run-Json $WorkRoot @("session", "context", $ProjectId, "--compact", "--json")
  Assert-True (($context.recent_activity.Count -gt 0) -and ($null -ne $context.workspace)) "compact context returns activity and workspace"

  $runtimeText = ""
  Get-ChildItem -Path ".agentbridge\sessions" -Recurse -Include *.json,*.jsonl | ForEach-Object {
    $runtimeText += [System.IO.File]::ReadAllText($_.FullName)
  }
  Assert-True (-not $runtimeText.Contains($Marker)) "runtime does not store raw safe file content"
  Assert-True (-not ($runtimeText -match "sk-test_should_not_leak|diff --git|@@\s|Bearer\s+(?!\[REDACTED\])\S{12,}")) "runtime has no fake secret or raw diff"

  for ($i = 0; $i -lt $RandomRounds; $i++) {
    $recent = Run-Json $WorkRoot @("session", "timeline", $ProjectId, "--recent", "--limit", "10", "--json")
    Assert-True ($recent.activities.Count -gt 0) "random recent timeline round $($i + 1)"
  }
}
finally {
  Pop-Location
  Remove-Item -LiteralPath $WorkRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "v0.8 final timeline smoke: PASS=$Pass FAIL=$Fail"
if ($Fail -gt 0) {
  exit 1
}
