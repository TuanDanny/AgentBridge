param(
  [int]$RandomRounds = 0
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
  Push-Location $Cwd
  try {
    $output = & node $Cli @CliArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "CLI failed: node dist\cli.js $($CliArgs -join ' ')"
    }
    return ($output | Out-String | ConvertFrom-Json)
  } finally {
    Pop-Location
  }
}

if (!(Test-Path $Cli)) {
  Fail "dist CLI exists"
  exit 1
}

$Suffix = [guid]::NewGuid().ToString("N")
$RegistryRoot = Join-Path ([IO.Path]::GetTempPath()) "codexlink-v07-evidence-registry-$Suffix"
$ProjectRoot = Join-Path ([IO.Path]::GetTempPath()) "codexlink-v07-evidence-project-$Suffix"
$Marker = "CODEXLINK_GAMMA_TOKEN_$Suffix"
$RawContentMarker = "RAW_CONTENT_SHOULD_NOT_BE_STORED_$Suffix"

try {
  New-Item -ItemType Directory -Force -Path $RegistryRoot, (Join-Path $ProjectRoot "src"), (Join-Path $ProjectRoot "docs") | Out-Null
  Set-Content -Path (Join-Path $ProjectRoot "package.json") -Value "{`"name`":`"codexlink-smoke`"}" -Encoding UTF8
  Set-Content -Path (Join-Path $ProjectRoot "src\index.ts") -Value "export const marker = '$Marker';`nexport const raw = '$RawContentMarker';`n" -Encoding UTF8
  Set-Content -Path (Join-Path $ProjectRoot "docs\note.md") -Value "Smoke note $Marker`nOPENAI_API_KEY=sk-test_should_not_leak`n" -Encoding UTF8

  Invoke-CliJson -CliArgs @("project", "register", "SmokeProject", $ProjectRoot) -Cwd $RegistryRoot | Out-Null
  Invoke-CliJson -CliArgs @("project", "tree", "SmokeProject", "--json") -Cwd $RegistryRoot | Out-Null
  Invoke-CliJson -CliArgs @("project", "read-file", "SmokeProject", "src/index.ts", "--json") -Cwd $RegistryRoot | Out-Null
  Invoke-CliJson -CliArgs @("project", "find-file", "SmokeProject", "index", "--json") -Cwd $RegistryRoot | Out-Null
  Invoke-CliJson -CliArgs @("project", "grep", "SmokeProject", $Marker, "--json") -Cwd $RegistryRoot | Out-Null
  Invoke-CliJson -CliArgs @("project", "inspect", "SmokeProject", "--json") -Cwd $RegistryRoot | Out-Null
  Invoke-CliJson -CliArgs @(
    "session", "check", "SmokeProject",
    "--type", "test",
    "--status", "pass",
    "--summary", "smoke check token=$Marker",
    "--command", "npm test --token=$Marker",
    "--exit-code", "0",
    "--duration-ms", "1",
    "--json"
  ) -Cwd $RegistryRoot | Out-Null

  $rng = [Random]::new(7)
  for ($i = 0; $i -lt $RandomRounds; $i += 1) {
    switch ($rng.Next(0, 4)) {
      0 { Invoke-CliJson -CliArgs @("project", "tree", "SmokeProject", "--json") -Cwd $RegistryRoot | Out-Null }
      1 { Invoke-CliJson -CliArgs @("project", "find-file", "SmokeProject", "note", "--json") -Cwd $RegistryRoot | Out-Null }
      2 { Invoke-CliJson -CliArgs @("project", "read-file", "SmokeProject", "docs/note.md", "--json") -Cwd $RegistryRoot | Out-Null }
      3 { Invoke-CliJson -CliArgs @("project", "grep", "SmokeProject", $Marker, "--json") -Cwd $RegistryRoot | Out-Null }
    }
  }

  $summary = Invoke-CliJson -CliArgs @("session", "summary", "SmokeProject", "--json") -Cwd $RegistryRoot
  $updates = Invoke-CliJson -CliArgs @("session", "updates", "SmokeProject", "--since", "1", "--json") -Cwd $RegistryRoot
  $evidenceKinds = @($updates.evidence | ForEach-Object { $_.kind })
  $checkTypes = @($updates.checks | ForEach-Object { $_.type })

  Assert-True ($evidenceKinds -contains "tree_seen") "tree_seen evidence logged"
  Assert-True ($evidenceKinds -contains "file_read") "file_read evidence logged"
  Assert-True ($evidenceKinds -contains "file_search") "file_search evidence logged"
  Assert-True ($evidenceKinds -contains "grep_seen") "grep_seen evidence logged"
  Assert-True ($evidenceKinds -contains "inspect_seen") "inspect_seen evidence logged"
  Assert-True ($checkTypes -contains "test") "check metadata logged"
  Assert-True (@($summary.summary.recent_evidence).Count -le 8) "summary recent_evidence compact"
  Assert-True (@($summary.summary.recent_checks).Count -le 8) "summary recent_checks compact"

  $sessionDir = Join-Path $RegistryRoot ".agentbridge\sessions\SmokeProject\$($summary.summary.session_id)"
  $stored = @(
    Get-Content (Join-Path $sessionDir "evidence.jsonl") -Raw
    Get-Content (Join-Path $sessionDir "checks.jsonl") -Raw
    Get-Content (Join-Path $sessionDir "summary.json") -Raw
  ) -join "`n"

  Assert-True (-not $stored.Contains($Marker)) "random grep token redacted from session metadata"
  Assert-True (-not $stored.Contains($RawContentMarker)) "raw file content not stored"
  Assert-True (-not $stored.Contains("sk-test_should_not_leak")) "fake OpenAI key not stored"
  Assert-True (-not $stored.Contains("OPENAI_API_KEY=sk-test_should_not_leak")) "fake secret assignment not stored"
  Assert-True (-not $stored.Contains("npm test --token=$Marker")) "raw check command token not stored"

  Write-Host ""
  Write-Host "v0.7 evidence/check smoke: PASS=$passes FAIL=$failures RandomRounds=$RandomRounds"
  if ($failures -gt 0) {
    exit 1
  }
} finally {
  Remove-Item $RegistryRoot, $ProjectRoot -Recurse -Force -ErrorAction SilentlyContinue
}
