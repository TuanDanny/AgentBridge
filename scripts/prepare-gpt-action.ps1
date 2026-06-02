param(
  [int]$Port = 7777,
  [string]$HostName = "127.0.0.1"
)

$ErrorActionPreference = "Stop"

function Say($text) {
  Write-Host ""
  Write-Host "=== $text ===" -ForegroundColor Cyan
}

function Ok($text) {
  Write-Host "[OK] $text" -ForegroundColor Green
}

function Fail($text) {
  Write-Host "[FAIL] $text" -ForegroundColor Red
}

$ScriptDir = Split-Path -Parent $PSCommandPath
$Root = Resolve-Path (Join-Path $ScriptDir "..")
$Root = $Root.Path
Set-Location $Root

$BridgeDir = Join-Path $Root ".agentbridge"
$TokenFile = Join-Path $BridgeDir "local_token"
$RemoteFile = Join-Path $BridgeDir "remote_bridge.json"
$SchemaSource = Join-Path $Root "openapi.agentbridge.gpt-actions.json"
$SchemaLive = Join-Path $BridgeDir "openapi-gpt-actions-live.json"
$SetupFile = Join-Path $BridgeDir "GPT_ACTION_SETUP.txt"
$LocalUrl = "http://${HostName}:$Port"

Say "AgentBridge GPT Actions One-Click Setup"
Write-Host "Root: $Root"
Write-Host "Local URL: $LocalUrl"

if (!(Test-Path $BridgeDir)) {
  New-Item -ItemType Directory -Path $BridgeDir | Out-Null
}

if (!(Test-Path $SchemaSource)) {
  Fail "Missing file: $SchemaSource"
  exit 1
}

if (!(Test-Path $TokenFile)) {
  Fail "Missing file: $TokenFile"
  Write-Host "Run AgentBridge once to create local_token."
  exit 1
}

Say "Check AgentBridge local server"

$serverOk = $false
try {
  Invoke-RestMethod -Uri "$LocalUrl/health" -Method Get -TimeoutSec 3 | Out-Null
  $serverOk = $true
} catch {
  $serverOk = $false
}

if ($serverOk) {
  Ok "AgentBridge server already running"
} else {
  Write-Host "Starting AgentBridge server in new PowerShell window..."
  Start-Process powershell.exe -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "cd '$Root'; node dist\cli.js start --host $HostName --port $Port"

  $ready = $false
  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Seconds 1
    try {
      Invoke-RestMethod -Uri "$LocalUrl/health" -Method Get -TimeoutSec 3 | Out-Null
      $ready = $true
      break
    } catch {
      $ready = $false
    }
  }

  if (!$ready) {
    Fail "AgentBridge server did not become healthy."
    Write-Host "Check the new AgentBridge server window."
    exit 1
  }

  Ok "AgentBridge server is healthy"
}

Say "Start Cloudflare tunnel"

Write-Host "A new Cloudflare tunnel window will open."
Write-Host "Copy the https://*.trycloudflare.com URL from that window."
Start-Process powershell.exe -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "cd '$Root'; cloudflared tunnel --url $LocalUrl"

$tunnelUrl = Read-Host "Paste tunnel URL here"

if (!$tunnelUrl.StartsWith("https://")) {
  Fail "Tunnel URL must start with https://"
  exit 1
}

if (!$tunnelUrl.Contains(".trycloudflare.com")) {
  Fail "Tunnel URL should look like https://xxxx.trycloudflare.com"
  exit 1
}

Ok "Tunnel URL: $tunnelUrl"

Say "Test public health"

try {
  Invoke-RestMethod -Uri "$tunnelUrl/health" -Method Get -TimeoutSec 20 | Out-Null
  Ok "Public /health OK"
} catch {
  Fail "Public /health failed"
  Write-Host $_.Exception.Message
  exit 1
}

Say "Register tunnel"

node dist\cli.js tunnel register $tunnelUrl
Ok "Tunnel registered"

Say "Test authenticated projects endpoint"

$token = (Get-Content $TokenFile -Raw).Trim()

try {
  $projects = Invoke-RestMethod -Uri "$tunnelUrl/chatgpt/projects" -Method Get -Headers @{
    Authorization = "Bearer $token"
  } -TimeoutSec 20

  if ($projects.ok -ne $true) {
    throw "Response ok is not true"
  }

  Ok "/chatgpt/projects OK"
  Write-Host "Projects:"
  $projects.projects | ForEach-Object {
    Write-Host " - $($_.id) branch=$($_.branch) clean=$($_.clean)"
  }
} catch {
  Fail "/chatgpt/projects failed"
  Write-Host $_.Exception.Message
  Write-Host "If this is 401, restart AgentBridge server and run this script again."
  exit 1
}

Say "Create live GPT Actions schema"

$schema = Get-Content $SchemaSource -Raw
$schema = $schema.Replace("https://YOUR-TUNNEL-URL.example", $tunnelUrl)
Set-Content -Path $SchemaLive -Value $schema -Encoding UTF8

if (Select-String -Path $SchemaLive -Pattern "YOUR-TUNNEL-URL" -Quiet) {
  Fail "Schema still contains placeholder YOUR-TUNNEL-URL"
  exit 1
}

if (Select-String -Path $SchemaLive -Pattern '"\$ref": "#/components/parameters' -Quiet) {
  Fail "Schema still contains parameter refs"
  exit 1
}

Ok "Created schema: $SchemaLive"

Say "Create setup guide"

$masked = "***"
if ($token.Length -gt 12) {
  $masked = $token.Substring(0, 6) + "..." + $token.Substring($token.Length - 6)
}

$lines = @()
$lines += "AgentBridge GPT Actions setup"
$lines += ""
$lines += "Tunnel URL:"
$lines += $tunnelUrl
$lines += ""
$lines += "Schema file:"
$lines += $SchemaLive
$lines += ""
$lines += "GPT Actions settings:"
$lines += "Authentication Type: API Key"
$lines += "Auth Type: Bearer"
$lines += "API Key/token: paste local_token value only"
$lines += ""
$lines += "Token preview:"
$lines += $masked
$lines += ""
$lines += "Test prompt:"
$lines += "Hay goi action listProjects cua AgentBridge de liet ke project hien co."
$lines += ""
$lines += "Do not paste the token into normal chat."

Set-Content -Path $SetupFile -Value $lines -Encoding UTF8
Ok "Created guide: $SetupFile"

Say "Copy schema to clipboard"

Get-Content $SchemaLive -Raw | Set-Clipboard
Ok "Schema copied to clipboard"

Write-Host ""
Write-Host "NOW IN GPT ACTIONS:" -ForegroundColor Yellow
Write-Host "1. Schema box: Ctrl+A -> Delete -> Ctrl+V"
Write-Host "2. Click Format"
Write-Host "3. Authentication Type: API Key"
Write-Host "4. Auth Type: Bearer"
Write-Host ""

Read-Host "After pasting schema, press Enter here to copy token"

$token | Set-Clipboard
Ok "Token copied to clipboard"

Write-Host ""
Write-Host "Paste token into GPT Actions API Key box." -ForegroundColor Yellow
Write-Host "Because Auth Type is Bearer, paste token only. Do NOT add Bearer."
Write-Host ""

Read-Host "After saving authentication, press Enter here to copy test prompt"

$prompt = "Hãy gọi action listProjects của AgentBridge để liệt kê project hiện có."
$prompt | Set-Clipboard
Ok "Test prompt copied to clipboard"

Write-Host ""
Write-Host "DONE." -ForegroundColor Green
Write-Host "Paste the test prompt into GPT Preview."
Write-Host "Schema file: $SchemaLive"
Write-Host "Setup file: $SetupFile"
Write-Host "Tunnel URL: $tunnelUrl"
Write-Host ""

pause