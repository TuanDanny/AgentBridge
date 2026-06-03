param(
  [string]$Server = "http://127.0.0.1:7777",
  [string]$RepoRoot = "D:\AgentBridge",
  [switch]$KeepTestProject,
  [switch]$SkipNpmChecks
)

$ErrorActionPreference = "Stop"

$script:Passed = 0
$script:Failed = 0
$script:Warnings = 0
$script:CreatedProject = $null
$script:CreatedTestRoot = $null
$script:StartedServerProcess = $null
$script:ServerWasStartedByScript = $false

function Pass($msg) {
  $script:Passed++
  Write-Host "[PASS] $msg" -ForegroundColor Green
}

function Fail($msg) {
  $script:Failed++
  Write-Host "[FAIL] $msg" -ForegroundColor Red
}

function Warn($msg) {
  $script:Warnings++
  Write-Host "[WARN] $msg" -ForegroundColor Yellow
}

function Info($msg) {
  Write-Host "[INFO] $msg" -ForegroundColor Cyan
}

function Assert-True($condition, $msg) {
  if ($condition) { Pass $msg } else { Fail $msg }
}

function UrlEncode([string]$s) {
  return [uri]::EscapeDataString($s)
}

function To-JsonText($obj) {
  return ($obj | ConvertTo-Json -Depth 60)
}

function Json-Contains($obj, [string]$needle) {
  return (To-JsonText $obj).Contains($needle)
}

function Invoke-HttpJson {
  param(
    [string]$Method = "GET",
    [string]$Url,
    [hashtable]$Headers = @{},
    [int[]]$ExpectedStatus = @(200),
    [switch]$NoFail
  )

  try {
    $resp = Invoke-WebRequest -Method $Method -Uri $Url -Headers $Headers -UseBasicParsing
    $status = [int]$resp.StatusCode

    if (($ExpectedStatus -notcontains $status) -and (-not $NoFail)) {
      Fail "$Method $Url expected HTTP $($ExpectedStatus -join '/') but got $status"
    }

    $body = $null
    if ($resp.Content -and $resp.Content.Trim().Length -gt 0) {
      try {
        $body = $resp.Content | ConvertFrom-Json
      } catch {
        $body = $resp.Content
      }
    }

    return @{
      status = $status
      body = $body
      blocked = $false
    }
  } catch {
    $status = $null

    if ($_.Exception.Response -ne $null) {
      try { $status = [int]$_.Exception.Response.StatusCode } catch {}
    }

    if (($status -ne $null) -and ($ExpectedStatus -contains $status)) {
      return @{
        status = $status
        body = $null
        blocked = $true
      }
    }

    if (-not $NoFail) {
      Fail "$Method $Url failed unexpectedly. Status=$status Error=$($_.Exception.Message)"
    }

    return @{
      status = $status
      body = $null
      blocked = $true
      error = $_.Exception.Message
    }
  }
}

function Test-Blocked {
  param(
    [string]$Url,
    [hashtable]$Headers = @{},
    [string]$Name,
    [int[]]$ExpectedStatus = @(400,401,403,404)
  )

  $r = Invoke-HttpJson -Url $Url -Headers $Headers -ExpectedStatus $ExpectedStatus

  if ($r.blocked) {
    Pass "$Name blocked as expected, HTTP $($r.status)"
  } else {
    Fail "$Name was not blocked"
  }
}

function Test-NoSecretText {
  param(
    [string]$Name,
    [string]$Text
  )

  $patterns = @(
    "fake-local-token-should-not-return",
    "OPENAI_API_KEY=sk-",
    "sk-fake",
    "BEGIN PRIVATE KEY",
    "Authorization",
    "Bearer "
  )

  foreach ($p in $patterns) {
    if ($Text -match [regex]::Escape($p)) {
      Fail "$Name leaked forbidden pattern: $p"
      return
    }
  }

  Pass "$Name has no obvious secret leakage"
}

function Start-Server-IfNeeded {
  param(
    [string]$Server,
    [string]$RepoRoot
  )

  try {
    $health = Invoke-WebRequest -Uri "$Server/health" -UseBasicParsing -TimeoutSec 2
    if ($health.StatusCode -eq 200) {
      Pass "existing server is reachable"
      return
    }
  } catch {
    Warn "server not reachable yet; starting a temporary daemon"
  }

  $uri = [Uri]$Server
  $hostName = $uri.Host
  $port = $uri.Port

  $script:StartedServerProcess = Start-Process -FilePath "node" `
    -ArgumentList @("dist/cli.js", "start", "--host", $hostName, "--port", "$port") `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -PassThru

  $script:ServerWasStartedByScript = $true

  for ($i = 0; $i -lt 40; $i++) {
    try {
      $health = Invoke-WebRequest -Uri "$Server/health" -UseBasicParsing -TimeoutSec 2
      if ($health.StatusCode -eq 200) {
        Pass "temporary server started and reachable"
        return
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }

  throw "Server did not become ready at $Server"
}

function Get-OpenApiOperationIds {
  param([string]$OpenApiPath)

  $raw = Get-Content $OpenApiPath -Raw
  $json = $raw | ConvertFrom-Json
  $ops = @()

  foreach ($pathProp in $json.paths.PSObject.Properties) {
    foreach ($methodProp in $pathProp.Value.PSObject.Properties) {
      $op = $methodProp.Value
      if ($op.operationId) {
        $ops += [string]$op.operationId
      }
    }
  }

  return @{
    Raw = $raw
    Json = $json
    OperationIds = $ops
    PathNames = @($json.paths.PSObject.Properties | ForEach-Object { $_.Name })
  }
}

function Cleanup-TestArtifacts {
  param(
    [string]$Project,
    [string]$TestRoot,
    [string]$RepoRoot,
    [switch]$KeepTestProject
  )

  Info "Cleanup started"

  try {
    if ($Project) {
      & node "$RepoRoot\dist\cli.js" project remove $Project | Out-Null
      Info "Removed registry entry for $Project"
    }
  } catch {
    Warn "Could not remove registry entry for ${Project}: $($_.Exception.Message)"
  }

  if ($TestRoot -and (-not $KeepTestProject)) {
    try {
      Remove-Item $TestRoot -Recurse -Force -ErrorAction SilentlyContinue
      Info "Removed test root $TestRoot"
    } catch {
      Warn "Could not remove test root ${TestRoot}: $($_.Exception.Message)"
    }
  } elseif ($TestRoot) {
    Warn "Keeping test root because -KeepTestProject was set: $TestRoot"
  }

  if ($script:StartedServerProcess -and -not $script:StartedServerProcess.HasExited) {
    try {
      Stop-Process -Id $script:StartedServerProcess.Id -Force
      Info "Stopped temporary server process $($script:StartedServerProcess.Id)"
    } catch {
      Warn "Could not stop temporary server: $($_.Exception.Message)"
    }
  }
}

Push-Location $RepoRoot

try {
  Info "CodexLink v0.5 Gamma/Delta full workflow acceptance test V4"
  Info "RepoRoot: $RepoRoot"
  Info "Server:   $Server"
  Info "This script creates a randomized disposable project and does not depend on 123.txt or any fixed sample file."

  if (!(Test-Path ".agentbridge\local_token")) {
    throw "Missing .agentbridge\local_token"
  }

  $token = (Get-Content ".agentbridge\local_token" -Raw).Trim()
  Assert-True ($token.Length -ge 16) "local_token loaded"
  $headers = @{ Authorization = "Bearer $token" }

  Start-Server-IfNeeded -Server $Server -RepoRoot $RepoRoot

  $health = (Invoke-HttpJson -Url "$Server/health" -ExpectedStatus @(200)).body
  Assert-True ($health.ok -eq $true) "health endpoint ok"

  # Pre-flight: OpenAPI should expose current stable workflow actions.
  $openapiPath = Join-Path $RepoRoot "openapi.agentbridge.gpt-actions.json"
  $openapiInfo = Get-OpenApiOperationIds -OpenApiPath $openapiPath
  $requiredOps = @(
    "listProjects",
    "inspectProject",
    "getCodexChanges",
    "getReviewPacket",
    "getProjectTree",
    "searchProjectFiles",
    "readProjectFile",
    "searchProjectText"
  )

  foreach ($op in $requiredOps) {
    Assert-True ($openapiInfo.OperationIds -contains $op) "OpenAPI operationId exists: $op"
  }

  Assert-True (-not (($openapiInfo.PathNames -join "`n") -match '^/mcp$|/mcp')) "OpenAPI paths do not expose /mcp"
  Assert-True (-not (($openapiInfo.PathNames -join "`n") -match 'scan')) "OpenAPI paths do not expose HTTP project scan"

  # Create a fully randomized local project.
  $rid = [System.Guid]::NewGuid().ToString("N").Substring(0,12)
  $testRoot = "D:\CodexLink_V4_Acceptance_$rid"
  $project = "GammaDeltaV4_$rid"
  $projectRoot = Join-Path $testRoot $project

  $script:CreatedProject = $project
  $script:CreatedTestRoot = $testRoot

  $dirs = @{
    notes = Join-Path $projectRoot "notes_$rid"
    docs = Join-Path $projectRoot "docs_$rid"
    nested = Join-Path $projectRoot "nested_$rid\level1\level2"
    src = Join-Path $projectRoot "src_$rid"
    config = Join-Path $projectRoot "config_$rid"
    ignoredNodeModules = Join-Path $projectRoot "node_modules\FakePackage"
    ignoredGitNested = Join-Path $projectRoot ".git_should_not_matter"
    ignoredDist = Join-Path $projectRoot "dist"
  }

  New-Item -ItemType Directory -Force -Path @($dirs.Values) | Out-Null

  $readToken = "CODEXLINK_V4_READ_$([System.Guid]::NewGuid().ToString())"
  $grepToken = "CODEXLINK_V4_GREP_$([System.Guid]::NewGuid().ToString())"
  $nestedToken = "CODEXLINK_V4_NESTED_$([System.Guid]::NewGuid().ToString())"
  $secretMarker = "sk-v4-fake-secret-$rid"

  $noteFile = "note_$rid.txt"
  $guideFile = "guide_$rid.md"
  $targetFile = "target_$rid.txt"
  $moduleFile = "module_$rid.ts"
  $jsonFile = "settings_$rid.json"
  $largeFile = "large_safe_text_$rid.txt"
  $secretAllowedFile = "allowed_secret_text_$rid.txt"
  $binFile = "binary_$rid.bin"
  $pemFile = "private_key_$rid.pem"

  Set-Content (Join-Path $dirs.notes $noteFile) "Random V4 note. READ_TOKEN=$readToken"
  Set-Content (Join-Path $dirs.docs $guideFile) "Random V4 guide. GREP_TOKEN=$grepToken"
  Set-Content (Join-Path $dirs.nested $targetFile) "Random V4 nested target. NESTED_TOKEN=$nestedToken"
  Set-Content (Join-Path $dirs.src $moduleFile) "export const v4Marker = '$grepToken';"
  Set-Content (Join-Path $dirs.config $jsonFile) "{ `"name`": `"$project`", `"marker`": `"$grepToken`" }"
  Set-Content (Join-Path $dirs.ignoredNodeModules "ignored_$rid.txt") "ignored token $grepToken"
  Set-Content (Join-Path $dirs.ignoredDist "ignored_dist_$rid.txt") "ignored token $grepToken"
  Set-Content (Join-Path $projectRoot $largeFile) (("LARGE_SAFE_TEXT_$rid " * 40000))
  Set-Content (Join-Path $projectRoot $secretAllowedFile) "Allowed file with fake secret: OPENAI_API_KEY=$secretMarker"
  Set-Content (Join-Path $projectRoot ".env") "OPENAI_API_KEY=sk-env-should-not-return-$rid"
  Set-Content (Join-Path $projectRoot $pemFile) "-----BEGIN PRIVATE KEY-----`nfake-key-$rid`n-----END PRIVATE KEY-----"
  New-Item -ItemType Directory -Force (Join-Path $projectRoot ".agentbridge") | Out-Null
  Set-Content (Join-Path $projectRoot ".agentbridge\local_token") "fake-local-token-should-not-return-$rid"
  [byte[]]$bytes = 0,1,2,3,4,5,255,254,253
  [System.IO.File]::WriteAllBytes((Join-Path $projectRoot $binFile), $bytes)

  # Create a real git project so workflow matches real projects.
  Push-Location $projectRoot
  git init | Out-Null
  git add . | Out-Null
  git commit -m "init randomized v4 acceptance project" | Out-Null
  Pop-Location

  Info "Random project id: $project"
  Info "Random project root: $projectRoot"

  # Workflow step 1: register project explicitly.
  & node "$RepoRoot\dist\cli.js" project register $project $projectRoot | Out-Null
  Assert-True ($LASTEXITCODE -eq 0) "workflow: CLI register project"

  # Workflow step 2: user opens GPT and lists available projects.
  $projects = (Invoke-HttpJson -Url "$Server/chatgpt/projects" -Headers $headers -ExpectedStatus @(200)).body
  Assert-True ($projects.ok -eq $true) "workflow: listProjects ok"
  Assert-True (Json-Contains $projects $project) "workflow: listProjects shows randomized project"
  Assert-True (-not (Json-Contains $projects $projectRoot)) "listProjects does not expose full raw root"

  # Workflow step 3: user chooses project and inspects it.
  $inspect = (Invoke-HttpJson -Url "$Server/chatgpt/projects/$project/inspect" -Headers $headers -ExpectedStatus @(200)).body
  Assert-True ($inspect.ok -eq $true) "workflow: inspectProject ok"
  Assert-True (Json-Contains $inspect $project) "workflow: inspectProject references randomized project"
  Assert-True (-not (Json-Contains $inspect $projectRoot)) "inspectProject does not expose full raw root"

  # Workflow step 4: user asks what files/folders are in the project.
  $tree = (Invoke-HttpJson -Url "$Server/chatgpt/projects/$project/tree?max_depth=6&max_entries=300" -Headers $headers -ExpectedStatus @(200)).body
  Assert-True ($tree.ok -eq $true) "workflow: getProjectTree ok"
  Assert-True (Json-Contains $tree "notes_$rid/$noteFile") "tree includes randomized note"
  Assert-True (Json-Contains $tree "docs_$rid/$guideFile") "tree includes randomized guide"
  Assert-True (Json-Contains $tree "nested_$rid/level1/level2/$targetFile") "tree includes randomized nested target"
  Assert-True (Json-Contains $tree "src_$rid/$moduleFile") "tree includes randomized source file"
  Assert-True ($tree.total_files -ge 6) "tree reports total_files"
  Assert-True ($tree.total_folders -ge 5) "tree reports total_folders"

  $treeEntryPaths = @($tree.entries | ForEach-Object { [string]$_.path })
  $treeEntryText = $treeEntryPaths -join "`n"
  Assert-True (-not ($treeEntryText -match "node_modules")) "tree entries ignore node_modules"
  Assert-True (-not ($treeEntryText -match "dist/ignored_dist")) "tree entries ignore dist files"
  Assert-True (-not ($treeEntryText -match "\.agentbridge")) "tree entries ignore .agentbridge"

  # Workflow step 5: user asks whether a random file exists.
  $noteSearch = (Invoke-HttpJson -Url "$Server/chatgpt/projects/$project/files/search?q=$(UrlEncode $noteFile)" -Headers $headers -ExpectedStatus @(200)).body
  Assert-True ($noteSearch.ok -eq $true) "workflow: searchProjectFiles note ok"
  Assert-True (Json-Contains $noteSearch "notes_$rid/$noteFile") "searchProjectFiles finds randomized note"

  $targetSearch = (Invoke-HttpJson -Url "$Server/chatgpt/projects/$project/files/search?q=$(UrlEncode $targetFile)" -Headers $headers -ExpectedStatus @(200)).body
  Assert-True ($targetSearch.ok -eq $true) "workflow: searchProjectFiles nested target ok"
  Assert-True (Json-Contains $targetSearch "nested_$rid/level1/level2/$targetFile") "searchProjectFiles finds randomized nested target"

  # Workflow step 6: user asks to read safe files.
  $notePath = "notes_$rid/$noteFile"
  $noteRead = (Invoke-HttpJson -Url "$Server/chatgpt/projects/$project/file?path=$(UrlEncode $notePath)" -Headers $headers -ExpectedStatus @(200)).body
  Assert-True ($noteRead.ok -eq $true) "workflow: readProjectFile note ok"
  Assert-True ($noteRead.truncated -eq $false) "small note file is not truncated"
  Assert-True ($noteRead.content -match "Random V4 note") "readProjectFile note returns expected non-token text"
  Assert-True (($noteRead.content -match [regex]::Escape($readToken)) -or ($noteRead.redacted -eq $true)) "readProjectFile note contains or redacts randomized token"

  $targetPath = "nested_$rid/level1/level2/$targetFile"
  $targetRead = (Invoke-HttpJson -Url "$Server/chatgpt/projects/$project/file?path=$(UrlEncode $targetPath)" -Headers $headers -ExpectedStatus @(200)).body
  Assert-True ($targetRead.ok -eq $true) "workflow: readProjectFile nested target ok"
  Assert-True ($targetRead.truncated -eq $false) "small nested target is not truncated"
  Assert-True ($targetRead.content -match "Random V4 nested target") "readProjectFile nested target returns expected non-token text"

  # Workflow step 7: large safe file should truncate, not block.
  $largeRead = (Invoke-HttpJson -Url "$Server/chatgpt/projects/$project/file?path=$(UrlEncode $largeFile)" -Headers $headers -ExpectedStatus @(200)).body
  Assert-True ($largeRead.ok -eq $true) "large safe text returns HTTP 200"
  Assert-True ($largeRead.truncated -eq $true) "large safe text returns truncated=true"
  Assert-True ($largeRead.content.Length -gt 0) "large safe text returns non-empty content"
  Assert-True ($largeRead.size -gt $largeRead.content.Length) "large safe text reports original size larger than returned content"

  # Workflow step 8: allowed text containing fake secret should be readable but redacted.
  $secretRead = (Invoke-HttpJson -Url "$Server/chatgpt/projects/$project/file?path=$(UrlEncode $secretAllowedFile)" -Headers $headers -ExpectedStatus @(200)).body
  Assert-True ($secretRead.ok -eq $true) "allowed text with fake secret returns ok"
  Assert-True ($secretRead.redacted -eq $true) "allowed text fake secret triggers redaction"
  Assert-True (-not ($secretRead.content -match [regex]::Escape($secretMarker))) "allowed text does not expose fake secret"

  # Workflow step 9: user searches project text.
  $grep = (Invoke-HttpJson -Url "$Server/chatgpt/projects/$project/grep?q=$(UrlEncode $grepToken)&max_matches=20" -Headers $headers -ExpectedStatus @(200)).body
  Assert-True ($grep.ok -eq $true) "workflow: searchProjectText ok"
  Assert-True (Json-Contains $grep "docs_$rid/$guideFile") "searchProjectText finds markdown file"
  Assert-True (Json-Contains $grep "src_$rid/$moduleFile") "searchProjectText finds TypeScript file"
  Assert-True (Json-Contains $grep "config_$rid/$jsonFile") "searchProjectText finds JSON file"

  $snippetLeak = $false
  foreach ($m in $grep.matches) {
    if ($null -ne $m.snippet -and ([string]$m.snippet).Contains($grepToken)) {
      $snippetLeak = $true
    }
  }
  Assert-True (-not $snippetLeak) "searchProjectText snippets do not leak raw randomized token"
  Assert-True ($grep.query -eq $grepToken) "searchProjectText may echo query separately"

  # Workflow step 10: selected project UX / audit.
  $select = (Invoke-HttpJson -Method "POST" -Url "$Server/chatgpt/projects/$project/select" -Headers $headers -ExpectedStatus @(200)).body
  Assert-True ($select.ok -eq $true) "workflow: selectProject ok"

  $active = (Invoke-HttpJson -Url "$Server/chatgpt/active-project" -Headers $headers -ExpectedStatus @(200)).body
  Assert-True (Json-Contains $active $project) "workflow: getActiveProject returns randomized project"
  Assert-True (-not (Json-Contains $active $projectRoot)) "getActiveProject does not expose full raw root"

  $eventLog = Join-Path $RepoRoot ".agentbridge\active_project_events.jsonl"
  Assert-True (Test-Path $eventLog) "audit event log exists"
  $tailText = ((Get-Content $eventLog -Tail 20 -ErrorAction SilentlyContinue) -join "`n")
  Assert-True ($tailText.Contains($project)) "audit log records selected project id"
  Assert-True (-not ($tailText.Contains($projectRoot))) "audit log does not contain full raw root"
  Test-NoSecretText -Name "audit log tail" -Text $tailText

  # Workflow step 11: protected paths and unsafe reads are blocked.
  Test-Blocked -Name "traversal path read" -Url "$Server/chatgpt/projects/$project/file?path=$(UrlEncode '../package.json')" -Headers $headers
  Test-Blocked -Name "absolute path read" -Url "$Server/chatgpt/projects/$project/file?path=$(UrlEncode 'D:\AgentBridge\package.json')" -Headers $headers
  Test-Blocked -Name "local_token read" -Url "$Server/chatgpt/projects/$project/file?path=$(UrlEncode '.agentbridge/local_token')" -Headers $headers
  Test-Blocked -Name ".env read" -Url "$Server/chatgpt/projects/$project/file?path=$(UrlEncode '.env')" -Headers $headers
  Test-Blocked -Name "private key read" -Url "$Server/chatgpt/projects/$project/file?path=$(UrlEncode $pemFile)" -Headers $headers
  Test-Blocked -Name "binary read" -Url "$Server/chatgpt/projects/$project/file?path=$(UrlEncode $binFile)" -Headers $headers

  # Workflow step 12: endpoint auth and bad project IDs are rejected.
  Test-Blocked -Name "missing auth on tree" -Url "$Server/chatgpt/projects/$project/tree" -Headers @{} -ExpectedStatus @(401)
  Test-Blocked -Name "unknown project" -Url "$Server/chatgpt/projects/Unknown_$rid/tree" -Headers $headers -ExpectedStatus @(404)
  Test-Blocked -Name "raw path projectId" -Url "$Server/chatgpt/projects/$(UrlEncode 'D:\AgentBridge')/tree" -Headers $headers -ExpectedStatus @(400,404)

  # Workflow step 13: old v0.4/v0.5 endpoints remain usable.
  $changes = (Invoke-HttpJson -Url "$Server/chatgpt/projects/$project/codex-changes" -Headers $headers -ExpectedStatus @(200)).body
  Assert-True ($changes.ok -eq $true) "old action getCodexChanges still works"

  $review = (Invoke-HttpJson -Url "$Server/chatgpt/projects/$project/review-packet" -Headers $headers -ExpectedStatus @(200)).body
  Assert-True ($review.ok -eq $true) "old action getReviewPacket still works"

  # Workflow step 14: local-only files remain ignored by git.
  $statusText = ((git status --short) -join "`n")
  Assert-True (-not ($statusText -match "\.agentbridge/projects\.json")) "projects.json not shown in git status"
  Assert-True (-not ($statusText -match "\.agentbridge/local_token")) "local_token not shown in git status"
  Assert-True (-not ($statusText -match "\.agentbridge/active_project\.json")) "active_project.json not shown in git status"
  Assert-True (-not ($statusText -match "\.agentbridge/active_project_events\.jsonl")) "active_project_events.jsonl not shown in git status"
  Assert-True (-not ($statusText -match "123\.txt")) "123.txt not present in git status"

  # Workflow step 15: source quality checks.
  if (-not $SkipNpmChecks) {
    Info "Running npm run build..."
    npm run build
    Assert-True ($LASTEXITCODE -eq 0) "npm run build PASS"

    Info "Running npm test..."
    npm test
    Assert-True ($LASTEXITCODE -eq 0) "npm test PASS"

    Info "Running git diff --check..."
    git diff --check
    Assert-True ($LASTEXITCODE -eq 0) "git diff --check PASS"
  } else {
    Warn "Skipping npm/build/git checks because -SkipNpmChecks was set"
  }

} catch {
  Fail "Script crashed: $($_.Exception.Message)"
} finally {
  Cleanup-TestArtifacts -Project $script:CreatedProject -TestRoot $script:CreatedTestRoot -RepoRoot $RepoRoot -KeepTestProject:$KeepTestProject
  Pop-Location
}

Write-Host ""
Write-Host "============================================================"
Write-Host "CodexLink v0.5 Gamma/Delta Full Workflow Acceptance Summary V4"
Write-Host "PASS: $script:Passed"
Write-Host "FAIL: $script:Failed"
Write-Host "WARN: $script:Warnings"
Write-Host "============================================================"

if ($script:Failed -eq 0 -and $script:Warnings -eq 0) {
  Write-Host "OKKK - v0.5-gamma/v0.5-delta full workflow acceptance passed with zero warnings. Ready for commit/tag discipline." -ForegroundColor Green
  exit 0
}

if ($script:Failed -eq 0) {
  Write-Host "OKKK - v0.5-gamma/v0.5-delta full workflow acceptance passed. Review warnings before tag." -ForegroundColor Green
  exit 0
}

Write-Host "NOT OK - fix failing checks before commit/tag." -ForegroundColor Red
exit 1
