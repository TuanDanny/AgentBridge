param(
  [int]$Port = 7777,
  [string]$HostName = "127.0.0.1",
  [string]$TunnelUrl = "",
  [switch]$NoClipboard,
  [switch]$AutoTunnel,
  [switch]$ManualTunnel
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
$TunnelPidFile = Join-Path $BridgeDir "cloudflared.pid"
$LocalUrl = "http://${HostName}:$Port"
$Generator = Join-Path $Root "scripts\generate-openapi.mjs"
$DistCli = Join-Path $Root "dist\cli.js"
$NodeModules = Join-Path $Root "node_modules"
$TscCmd = Join-Path $Root "node_modules\.bin\tsc.cmd"

Say "AgentBridge GPT Actions One-Click Setup"
Write-Host "Root: $Root"
Write-Host "Local URL: $LocalUrl"
if ($TunnelUrl) {
  Write-Host "Tunnel URL: $TunnelUrl"
}
if (!$TunnelUrl -and !$ManualTunnel) {
  $AutoTunnel = $true
}

function Resolve-Cloudflared {
  $command = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $candidates = @(
    "C:\Program Files\cloudflared\cloudflared.exe",
    "C:\Program Files (x86)\cloudflared\cloudflared.exe"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  return $null
}

function Require-Command($name, $installHint) {
  $command = Get-Command $name -ErrorAction SilentlyContinue
  if (!$command) {
    Fail "$name is not installed or not on PATH."
    Write-Host $installHint
    exit 1
  }
  return $command.Source
}

function Run-Step($description, $filePath, $arguments) {
  Write-Host $description
  $process = Start-Process -FilePath $filePath -ArgumentList $arguments -WorkingDirectory $Root -NoNewWindow -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    Fail "$description failed with exit code $($process.ExitCode)."
    exit $process.ExitCode
  }
}

function Install-CloudflaredIfPossible {
  $cloudflared = Resolve-Cloudflared
  if ($cloudflared) {
    return $cloudflared
  }

  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (!$winget) {
    return $null
  }

  Write-Host "cloudflared is missing; installing with winget..."
  $args = @(
    "install",
    "--id", "Cloudflare.cloudflared",
    "--exact",
    "--silent",
    "--accept-source-agreements",
    "--accept-package-agreements"
  )
  $process = Start-Process -FilePath $winget.Source -ArgumentList $args -WorkingDirectory $Root -NoNewWindow -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    return $null
  }

  return Resolve-Cloudflared
}

if (!(Test-Path $BridgeDir)) {
  New-Item -ItemType Directory -Path $BridgeDir | Out-Null
}

Say "Bootstrap local runtime"

Require-Command "node" "Install Node.js 18+ and run this script again." | Out-Null
Require-Command "npm.cmd" "Install npm with Node.js and run this script again." | Out-Null

if (!(Test-Path $NodeModules) -or !(Test-Path $TscCmd)) {
  Run-Step "Installing npm dependencies with npm ci..." "npm.cmd" @("ci")
  Ok "npm dependencies installed"
} else {
  Ok "npm dependencies already installed"
}

if (!(Test-Path $DistCli)) {
  Run-Step "Building AgentBridge dist..." "npm.cmd" @("run", "build")
  Ok "AgentBridge built"
} else {
  Ok "dist/cli.js already exists"
}

Say "Refresh OpenAPI schema"

if (!(Test-Path $Generator)) {
  Fail "Missing file: $Generator"
  exit 1
}

node $Generator
if ($LASTEXITCODE -ne 0) {
  Fail "OpenAPI schema generation failed"
  exit 1
}
Ok "OpenAPI schema regenerated"

if (!(Test-Path $SchemaSource)) {
  Fail "Missing file: $SchemaSource"
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

if (!(Test-Path $TokenFile)) {
  Fail "Missing file: $TokenFile"
  Write-Host "AgentBridge server is healthy, but local_token was not created."
  exit 1
}

Say "Start Cloudflare tunnel"

if (!$TunnelUrl) {
  $cloudflared = Install-CloudflaredIfPossible
  if (!$cloudflared) {
    Fail "cloudflared is not installed or not on PATH."
    Write-Host "Install cloudflared, or run this script with an existing tunnel URL:"
    Write-Host ".\run-gpt-action-setup.bat -TunnelUrl https://xxxx.trycloudflare.com"
    Write-Host "Use -ManualTunnel only when you want to paste the URL yourself."
    exit 1
  }

  if ($AutoTunnel) {
    Write-Host "Starting cloudflared and waiting for a trycloudflare URL..."
    $tunnelLog = Join-Path $BridgeDir "cloudflared.log"
    $tunnelErr = Join-Path $BridgeDir "cloudflared.err.log"
    Remove-Item $tunnelLog, $tunnelErr -ErrorAction SilentlyContinue
    $command = "/c `"`"$cloudflared`" tunnel --url `"$LocalUrl`" > `"$tunnelLog`" 2> `"$tunnelErr`"`""
    $tunnelProcess = Start-Process -FilePath "cmd.exe" -ArgumentList $command -WorkingDirectory $Root -PassThru -WindowStyle Hidden
    Set-Content -Path $TunnelPidFile -Value $tunnelProcess.Id -Encoding ASCII

    $pattern = "https://[A-Za-z0-9-]+\.trycloudflare\.com"
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
      foreach ($logPath in @($tunnelLog, $tunnelErr)) {
        if (Test-Path $logPath) {
          $logText = Get-Content $logPath -Raw
          if (!$logText) {
            continue
          }
          $match = [regex]::Match($logText, $pattern)
          if ($match.Success) {
            $TunnelUrl = $match.Value
            break
          }
        }
      }

      if ($TunnelUrl -or $tunnelProcess.HasExited) {
        break
      }
      Start-Sleep -Milliseconds 500
    }

    if (!$TunnelUrl) {
      if (!$tunnelProcess.HasExited) {
        $tunnelProcess.Kill()
      }
      if (Test-Path $tunnelErr) {
        Write-Host "Recent cloudflared output:"
        Get-Content $tunnelErr | Select-Object -Last 20 | ForEach-Object { Write-Host $_ }
      }
      Fail "cloudflared did not report a trycloudflare URL."
      exit 1
    }
  } else {
    Write-Host "A new Cloudflare tunnel window will open."
    Write-Host "Copy the https://*.trycloudflare.com URL from that window."
    Start-Process powershell.exe -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "cd '$Root'; & '$cloudflared' tunnel --url $LocalUrl"
  }
}

if (!$TunnelUrl) {
  $TunnelUrl = Read-Host "Paste tunnel URL here"
}

if ([string]::IsNullOrWhiteSpace($TunnelUrl)) {
  Fail "Tunnel URL is required."
  Write-Host "Paste the generated https://*.trycloudflare.com URL, or pass -TunnelUrl."
  exit 1
}

$TunnelUrl = $TunnelUrl.Trim().TrimEnd("/")

if (!$TunnelUrl.StartsWith("https://")) {
  Fail "Tunnel URL must start with https://"
  exit 1
}

if (!$TunnelUrl.Contains(".trycloudflare.com")) {
  Fail "Tunnel URL should look like https://xxxx.trycloudflare.com"
  exit 1
}

Ok "Tunnel URL: $TunnelUrl"

Say "Test public health"

$healthOk = $false
$lastHealthError = $null
for ($i = 0; $i -lt 12; $i++) {
  try {
    Invoke-RestMethod -Uri "$TunnelUrl/health" -Method Get -TimeoutSec 10 | Out-Null
    $healthOk = $true
    break
  } catch {
    $lastHealthError = $_.Exception.Message
    Start-Sleep -Seconds 3
  }
}

if ($healthOk) {
  Ok "Public /health OK"
} else {
  Fail "Public /health failed"
  Write-Host $lastHealthError
  exit 1
}

Say "Register tunnel"

node dist\cli.js tunnel register $TunnelUrl
Ok "Tunnel registered"

Say "Test authenticated projects endpoint"

$token = (Get-Content $TokenFile -Raw).Trim()

$projectsOk = $false
$projects = $null
$lastProjectsError = $null
for ($i = 0; $i -lt 8; $i++) {
  try {
    $projects = Invoke-RestMethod -Uri "$TunnelUrl/chatgpt/projects" -Method Get -Headers @{
      Authorization = "Bearer $token"
    } -TimeoutSec 10

    if ($projects.ok -ne $true) {
      throw "Response ok is not true"
    }

    $projectsOk = $true
    break
  } catch {
    $lastProjectsError = $_.Exception.Message
    Start-Sleep -Seconds 2
  }
}

if ($projectsOk) {
  Ok "/chatgpt/projects OK"
  Write-Host "Projects:"
  $projects.projects | ForEach-Object {
    Write-Host " - $($_.id) branch=$($_.branch) clean=$($_.clean)"
  }
} else {
  Fail "/chatgpt/projects failed"
  Write-Host $lastProjectsError
  Write-Host "If this is 401, restart AgentBridge server and run this script again."
  exit 1
}

Say "Create live GPT Actions schema"

$schema = Get-Content $SchemaSource -Raw
$schema = $schema.Replace("https://YOUR-TUNNEL-URL.example", $TunnelUrl)
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
$lines += $TunnelUrl
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

if ($NoClipboard) {
  Ok "Skipped clipboard copy"
} else {
  Get-Content $SchemaLive -Raw | Set-Clipboard
  Ok "Schema copied to clipboard"
}

Write-Host ""
Write-Host "NOW IN GPT ACTIONS:" -ForegroundColor Yellow
Write-Host "1. Schema box: Ctrl+A -> Delete -> Ctrl+V"
Write-Host "2. Click Format"
Write-Host "3. Authentication Type: API Key"
Write-Host "4. Auth Type: Bearer"
Write-Host ""

if ($NoClipboard) {
  Write-Host "Token file: $TokenFile"
  Write-Host "DONE." -ForegroundColor Green
  Write-Host "Schema file: $SchemaLive"
  Write-Host "Setup file: $SetupFile"
  Write-Host "Tunnel URL: $TunnelUrl"
  exit 0
}

Read-Host "After pasting schema, press Enter here to copy token"

$token | Set-Clipboard
Ok "Token copied to clipboard"

Write-Host ""
Write-Host "Paste token into GPT Actions API Key box." -ForegroundColor Yellow
Write-Host "Because Auth Type is Bearer, paste token only. Do NOT add Bearer."
Write-Host ""

Read-Host "After saving authentication, press Enter here to copy test prompt"

$prompt = "Hay goi action listProjects cua AgentBridge de liet ke project hien co."
$prompt | Set-Clipboard
Ok "Test prompt copied to clipboard"

Write-Host ""
Write-Host "DONE." -ForegroundColor Green
Write-Host "Paste the test prompt into GPT Preview."
Write-Host "Schema file: $SchemaLive"
Write-Host "Setup file: $SetupFile"
Write-Host "Tunnel URL: $TunnelUrl"
Write-Host ""

pause
