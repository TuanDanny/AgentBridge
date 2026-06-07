param(
  [int]$ActivityCount = 3
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Cli = Join-Path $Root "dist\cli.js"
$failures = 0
$passes = 0

function Pass($Message) {
  $script:passes += 1
  Write-Host "PASS $Message" -ForegroundColor Green
}

function Fail($Message) {
  $script:failures += 1
  Write-Host "FAIL $Message" -ForegroundColor Red
}

function Assert-True($Condition, [string]$Message) {
  if ($Condition) {
    Pass $Message
  } else {
    Fail $Message
  }
}

function Invoke-CliJson([string[]]$CliArgs, [string]$Cwd) {
  $argsFile = Join-Path ([IO.Path]::GetTempPath()) "codexlink-v08-args-$([guid]::NewGuid().ToString("N")).json"
  Set-Content -Path $argsFile -Value ($CliArgs | ConvertTo-Json -Compress) -Encoding UTF8
  try {
    $output = & node $script:Runner $Cli $argsFile $Cwd 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "CLI failed: node dist\cli.js $($CliArgs -join ' ')"
    }
    return ($output | Out-String | ConvertFrom-Json)
  } finally {
    Remove-Item $argsFile -Force -ErrorAction SilentlyContinue
  }
}

if (!(Test-Path $Cli)) {
  Fail "dist CLI exists"
  exit 1
}

$Suffix = [guid]::NewGuid().ToString("N")
$RegistryRoot = Join-Path ([IO.Path]::GetTempPath()) "codexlink-v08-activity-registry-$Suffix"
$ProjectRoot = Join-Path ([IO.Path]::GetTempPath()) "codexlink-v08-activity-project-$Suffix"
$ProjectId = "ActivitySmoke"
$FakeSecret = "sk-test_should_not_leak_$Suffix"
$RawContent = "RAW_ACTIVITY_CONTENT_SHOULD_NOT_STORE_$Suffix"
$RawOutput = "RAW_ACTIVITY_OUTPUT_SHOULD_NOT_STORE_$Suffix"
$Runner = Join-Path ([IO.Path]::GetTempPath()) "codexlink-v08-runner-$Suffix.mjs"
$RunnerSource = @'
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const [cli, argsFile, cwd] = process.argv.slice(2);
const args = JSON.parse(fs.readFileSync(argsFile, "utf8").replace(/^\uFEFF/, ""));
const result = spawnSync(process.execPath, [cli, ...args], {
  cwd,
  encoding: "utf8",
  windowsHide: true
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
'@
Set-Content -Path $Runner -Value $RunnerSource -Encoding UTF8

try {
  New-Item -ItemType Directory -Force -Path $RegistryRoot, $ProjectRoot | Out-Null
  Set-Content -Path (Join-Path $ProjectRoot "README.md") -Value "activity smoke project" -Encoding UTF8

  Invoke-CliJson -CliArgs @("project", "register", $ProjectId, $ProjectRoot) -Cwd $RegistryRoot | Out-Null

  for ($i = 0; $i -lt $ActivityCount; $i += 1) {
    $metadata = @{
      bytes = 12 + $i
      content = "$RawContent $FakeSecret"
      stdout = $RawOutput
      note = "OPENAI_API_KEY=$FakeSecret"
    } | ConvertTo-Json -Compress
    Invoke-CliJson -CliArgs @(
      "session", "activity-add", $ProjectId,
      "--kind", "file_create",
      "--status", "success",
      "--summary", "activity smoke OPENAI_API_KEY=$FakeSecret",
      "--path", "README.md",
      "--metadata", $metadata,
      "--json"
    ) -Cwd $RegistryRoot | Out-Null
  }

  $activity = Invoke-CliJson -CliArgs @("session", "activity", $ProjectId, "--json") -Cwd $RegistryRoot
  $summary = Invoke-CliJson -CliArgs @("session", "summary", $ProjectId, "--json") -Cwd $RegistryRoot

  Assert-True (@($activity.activities).Count -ge $ActivityCount) "CLI session activity returns recent activity"
  Assert-True (@($summary.summary.recent_activity).Count -ge $ActivityCount) "summary includes recent_activity"
  Assert-True ($summary.summary.activity_counts.file_create -ge $ActivityCount) "summary includes activity_counts"

  $sessionDir = Join-Path $RegistryRoot ".agentbridge\sessions\$ProjectId\$($summary.summary.session_id)"
  $stored = @(
    Get-Content (Join-Path $sessionDir "activity.jsonl") -Raw
    Get-Content (Join-Path $sessionDir "summary.json") -Raw
  ) -join "`n"

  Assert-True (-not $stored.Contains($FakeSecret)) "fake secret redacted from activity storage"
  Assert-True (-not $stored.Contains($RawContent)) "raw file content not stored in activity"
  Assert-True (-not $stored.Contains($RawOutput)) "raw terminal output not stored in activity"

  Push-Location $Root
  try {
    $runtimeStatus = git status --short -- .agentbridge/sessions
    Assert-True ([string]::IsNullOrWhiteSpace($runtimeStatus)) ".agentbridge/sessions not tracked"
  } finally {
    Pop-Location
  }

  Write-Host ""
  Write-Host "v0.8 activity core smoke: PASS=$passes FAIL=$failures ActivityCount=$ActivityCount"
  if ($failures -gt 0) {
    exit 1
  }
} finally {
  Remove-Item $RegistryRoot, $ProjectRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $Runner -Force -ErrorAction SilentlyContinue
}
