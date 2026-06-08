param(
  [string]$ProjectId = "SmokeWorkspace"
)

$ErrorActionPreference = "Stop"
$Pass = 0
$Fail = 0
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Cli = Join-Path $RepoRoot "dist\cli.js"
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("agentbridge-v08-workspace-" + [Guid]::NewGuid().ToString("N"))

function Pass($Message) {
  $script:Pass++
  Write-Host "PASS $Message"
}

function Fail($Message) {
  $script:Fail++
  Write-Host "FAIL $Message"
}

function RunCliJson([string[]]$CliArgs) {
  $output = & node $Cli @CliArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: node $Cli $($CliArgs -join ' ')`n$output"
  }
  return $output | ConvertFrom-Json
}

try {
  New-Item -ItemType Directory -Path $TempRoot | Out-Null
  Push-Location $TempRoot
  git init | Out-Null
  Set-Content -Path ".gitignore" -Value ".agentbridge/`n" -Encoding UTF8
  [void](RunCliJson -CliArgs @("project", "register-current", $ProjectId))

  $GapFile = "kiemtrasuco.txt"
  $SafeContent = "safe workspace timeline marker`n"
  Set-Content -Path $GapFile -Value $SafeContent -Encoding UTF8
  $reconcile = RunCliJson -CliArgs @("session", "reconcile", $ProjectId, "--json")
  if (@($reconcile.activities_written | Where-Object { $_.kind -eq "workspace_snapshot" }).Count -ge 1) { Pass "reconcile records workspace_snapshot" } else { Fail "reconcile records workspace_snapshot" }
  if (@($reconcile.activities_written | Where-Object { $_.kind -eq "activity_gap_detected" -and @($_.paths) -contains $GapFile }).Count -ge 1) { Pass "untracked file creates activity_gap_detected" } else { Fail "untracked file creates activity_gap_detected" }

  $hash = (Get-FileHash -Algorithm SHA256 $GapFile).Hash.ToLowerInvariant()
  $verify = RunCliJson -CliArgs @("session", "file-verify", $ProjectId, "--path", $GapFile, "--expect-sha256", $hash, "--json")
  if ($verify.verified -eq $true -and $verify.activity.kind -eq "file_verify" -and $verify.activity.metadata.content_stored -eq $false) {
    Pass "file-verify records hash metadata without content"
  } else {
    Fail "file-verify records hash metadata without content"
  }

  $TrackedFile = "tracked.txt"
  Set-Content -Path $TrackedFile -Value "one`n" -Encoding UTF8
  git add $TrackedFile | Out-Null
  Set-Content -Path $TrackedFile -Value "one`ntwo`nthree`n" -Encoding UTF8
  $diffReconcile = RunCliJson -CliArgs @("session", "reconcile", $ProjectId, "--json")
  $tracked = @($diffReconcile.snapshot.changed_files | Where-Object { $_.path -eq $TrackedFile }) | Select-Object -First 1
  if ($tracked -and (($tracked.added_lines -as [int]) + ($tracked.removed_lines -as [int])) -gt 0 -and $tracked.large_diff_truncated -eq $false) {
    Pass "diff summary stores added/removed counts"
  } else {
    Fail "diff summary stores added/removed counts"
  }

  $blockedOk = $false
  Set-Content -Path ".env" -Value "TOKEN=should_not_read" -Encoding UTF8
  try {
    $blockedOutput = & node $Cli session file-verify $ProjectId --path ".env" --json 2>&1
    $blockedExit = $LASTEXITCODE
  } catch {
    $blockedOutput = $_.Exception.Message
    $blockedExit = 1
  }
  if ($blockedExit -ne 0 -and ($blockedOutput -join "`n") -match "blocked") {
    $blockedOk = $true
  }
  if ($blockedOk) { Pass "safe path policy blocks .env" } else { Fail "safe path policy blocks .env" }

  $summary = RunCliJson -CliArgs @("session", "summary", $ProjectId, "--json")
  $sessionId = $summary.summary.session_id
  $sessionDir = Join-Path $TempRoot ".agentbridge\sessions\$ProjectId\$sessionId"
  $text = ""
  foreach ($file in @("activity.jsonl", "summary.json", "state.json")) {
    $path = Join-Path $sessionDir $file
    if (Test-Path $path) {
      $text += Get-Content -Raw $path
    }
  }
  if ($text.Contains($SafeContent.Trim()) -or $text.Contains("diff --git") -or $text.Contains("TOKEN=should_not_read")) {
    Fail "runtime files do not store raw content, raw diff, or fake secret"
  } else {
    Pass "runtime files do not store raw content, raw diff, or fake secret"
  }
  if (($summary.summary.recent_activity | Where-Object { $_.kind -in @("workspace_snapshot", "activity_gap_detected", "file_verify", "changed_files_summary") }).Count -ge 3) {
    Pass "summary recent_activity shows workspace/file activities"
  } else {
    Fail "summary recent_activity shows workspace/file activities"
  }
} catch {
  Fail $_.Exception.Message
} finally {
  Pop-Location
  if (Test-Path $TempRoot) {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force
  }
}

Write-Host ""
Write-Host "v0.8 workspace timeline smoke: PASS=$Pass FAIL=$Fail"
if ($Fail -gt 0) {
  exit 1
}
