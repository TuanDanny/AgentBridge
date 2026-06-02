param(
  [Parameter(Mandatory = $true)]
  [string]$TunnelUrl
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$CliPath = Join-Path $RepoRoot "dist\cli.js"
$TokenPath = Join-Path $RepoRoot ".agentbridge\local_token"
$ProjectId = "AgentBridge"

Set-Location $RepoRoot

if (-not (Test-Path $CliPath)) {
  throw "Missing dist\cli.js. Run npm run build first."
}

if (-not (Test-Path $TokenPath)) {
  throw "Missing .agentbridge\local_token. Start AgentBridge first with scripts\start-agentbridge.ps1."
}

$TunnelUrl = $TunnelUrl.TrimEnd("/")
if ($TunnelUrl -notmatch "^https://") {
  throw "TunnelUrl must start with https://"
}

Write-Host "Registering tunnel..." -ForegroundColor Cyan
node $CliPath tunnel register $TunnelUrl

Write-Host "`nRunning base tunnel test..." -ForegroundColor Cyan
node $CliPath tunnel test

$Token = (Get-Content $TokenPath -Raw).Trim()
if (-not $Token) {
  throw "Local token file is empty."
}

Write-Host "`nLoaded local token for Authorization header. Token value is hidden." -ForegroundColor Yellow

Add-Type -AssemblyName System.Net.Http

function Invoke-AgentBridgeGet {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [int]$ExpectedStatus,
    [switch]$WithoutToken
  )

  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, "$TunnelUrl$Path")
  if (-not $WithoutToken) {
    $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", $Token)
  }

  $client = [System.Net.Http.HttpClient]::new()
  try {
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    $status = [int]$response.StatusCode
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()

    Write-Host "`nGET $Path" -ForegroundColor Cyan
    Write-Host "Status: $status"

    if ($status -ne $ExpectedStatus) {
      throw "Expected HTTP $ExpectedStatus but got HTTP $status for GET $Path"
    }

    if ($body) {
      try {
        $json = $body | ConvertFrom-Json
        $json | ConvertTo-Json -Depth 30
      } catch {
        $body
      }
    }
  } finally {
    $client.Dispose()
    $request.Dispose()
  }
}

Invoke-AgentBridgeGet -Path "/chatgpt/projects" -ExpectedStatus 200
Invoke-AgentBridgeGet -Path "/chatgpt/projects/$ProjectId/inspect" -ExpectedStatus 200
Invoke-AgentBridgeGet -Path "/chatgpt/projects/$ProjectId/codex-changes" -ExpectedStatus 200
Invoke-AgentBridgeGet -Path "/chatgpt/projects/$ProjectId/review-packet" -ExpectedStatus 200
Invoke-AgentBridgeGet -Path "/chatgpt/projects" -ExpectedStatus 401 -WithoutToken
Invoke-AgentBridgeGet -Path "/chatgpt/projects/not-exist/inspect" -ExpectedStatus 404

Write-Host "`nDemo complete. No token value was printed." -ForegroundColor Green
