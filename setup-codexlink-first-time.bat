@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion

REM ============================================================
REM CodexLink / AgentBridge First-Time Setup
REM Put this file in the AgentBridge repo root, then double click.
REM It does NOT print your local token.
REM ============================================================

set "ROOT=%~dp0"
cd /d "%ROOT%"
set "USE_DEFAULTS=0"
set "RUN_NOW_MODE=ask"

:ParseArgs
if "%~1"=="" goto ArgsDone
if /I "%~1"=="--defaults" set "USE_DEFAULTS=1"
if /I "%~1"=="--no-start" set "RUN_NOW_MODE=no"
if /I "%~1"=="--start" set "RUN_NOW_MODE=yes"
if /I "%~1"=="--help" goto Usage
shift
goto ParseArgs

:Usage
echo CodexLink First-Time Setup
echo.
echo Usage:
echo   setup-codexlink-first-time.bat
echo   setup-codexlink-first-time.bat --defaults --no-start
echo.
echo Options:
echo   --defaults   Use safe defaults: no git pull, default project ID, no URLs, no quick tunnel.
echo   --no-start   Do not start CodexLink after setup.
echo   --start      Start CodexLink after setup without prompting.
exit /b 0

:ArgsDone

echo.
echo ============================================================
echo  CodexLink First-Time Setup
echo ============================================================
echo Repo root: %CD%
echo.

if not exist "package.json" (
  echo [FAIL] package.json not found.
  echo Put this .bat file in the AgentBridge repo root.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Node.js was not found in PATH.
  echo Install Node.js LTS first, then run this setup again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [FAIL] npm was not found in PATH.
  echo Install Node.js LTS first, then run this setup again.
  pause
  exit /b 1
)

echo [OK] Node:
node --version
echo [OK] npm:
call npm --version <nul
echo.

set "DO_PULL=n"
if exist ".git" (
  if "%USE_DEFAULTS%"=="1" (
    echo [INFO] Defaults mode: skipping git pull.
  ) else (
    set /p DO_PULL="Pull latest from GitHub first? [y/N]: "
  )
  if /I "!DO_PULL!"=="y" (
    where git >nul 2>nul
    if errorlevel 1 (
      echo [WARN] git was not found. Skipping git pull.
    ) else (
      echo.
      echo === git pull origin main ===
      git pull origin main
      if errorlevel 1 (
        echo [FAIL] git pull failed. Fix Git status/conflicts first.
        pause
        exit /b 1
      )
    )
  )
) else (
  echo [INFO] No .git folder found. Skipping git pull.
)

echo.
echo === npm install ===
call npm install <nul
if errorlevel 1 (
  echo [FAIL] npm install failed.
  pause
  exit /b 1
)

echo.
echo === npm run build ===
call npm run build <nul
if errorlevel 1 (
  echo [FAIL] npm run build failed.
  pause
  exit /b 1
)

echo.
set "PROJECT_ID=AgentBridge"
if "%USE_DEFAULTS%"=="1" (
  echo [INFO] Defaults mode: using project ID AgentBridge.
) else (
  set /p PROJECT_ID_INPUT="Project ID to register [AgentBridge]: "
  if not "!PROJECT_ID_INPUT!"=="" set "PROJECT_ID=!PROJECT_ID_INPUT!"
)

echo.
echo === Register current repo as project: %PROJECT_ID% ===
node dist\cli.js project register-current "%PROJECT_ID%" <nul
if errorlevel 1 (
  echo [WARN] project register-current failed. Continuing, but check manually later.
)

echo.
echo Optional:
echo - GPT URL: your custom GPT link, e.g. https://chatgpt.com/g/...
echo - Public URL: stable HTTPS endpoint, e.g. https://codexlink.yourdomain.com
echo.
echo If you do not have a stable Public URL yet, leave it empty.
echo You can use Quick Tunnel setup later in this script.
echo.

set "GPT_URL="
if "%USE_DEFAULTS%"=="1" (
  echo [INFO] Defaults mode: no GPT URL configured.
) else (
  set /p GPT_URL="GPT URL (optional): "
)

set "PUBLIC_URL="
if "%USE_DEFAULTS%"=="1" (
  echo [INFO] Defaults mode: no public URL configured.
) else (
  set /p PUBLIC_URL="Stable Public URL (optional, must start with https://): "
)

if not "%PUBLIC_URL%"=="" (
  echo %PUBLIC_URL% | findstr /I /B "https://" >nul
  if errorlevel 1 (
    echo [FAIL] Public URL must start with https://
    pause
    exit /b 1
  )
)

echo.
echo === Setup launcher config ===
if "%PUBLIC_URL%"=="" (
  if "%GPT_URL%"=="" (
    node dist\cli.js setup launcher --project "%PROJECT_ID%" <nul
  ) else (
    node dist\cli.js setup launcher --project "%PROJECT_ID%" --gpt-url "%GPT_URL%" <nul
  )
) else (
  if "%GPT_URL%"=="" (
    node dist\cli.js setup launcher --project "%PROJECT_ID%" --public-url "%PUBLIC_URL%" <nul
  ) else (
    node dist\cli.js setup launcher --project "%PROJECT_ID%" --public-url "%PUBLIC_URL%" --gpt-url "%GPT_URL%" <nul
  )
)

if errorlevel 1 (
  echo [WARN] setup launcher failed. Continuing to basic checks.
)

echo.
echo === Doctor check ===
node dist\cli.js doctor --launcher --project "%PROJECT_ID%" --json <nul
if errorlevel 1 (
  echo [WARN] doctor --launcher returned a warning/failure. Review output above.
)

if not "%PUBLIC_URL%"=="" (
  echo.
  echo === Generate GPT Actions schema with stable Public URL ===
  echo Public URL: %PUBLIC_URL%
  node dist\cli.js setup gpt-actions --public-url "%PUBLIC_URL%" <nul
  if errorlevel 1 (
    echo [WARN] setup gpt-actions command failed or is not available.
    echo You can still generate schema manually or use scripts\prepare-gpt-action.ps1 for Quick Tunnel.
  ) else (
    echo [OK] GPT Actions schema generated with stable Public URL.
  )

  echo.
  echo Verify schema URL:
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Select-String -Path '.\openapi.agentbridge.gpt-actions.json' -Pattern '\"url\"|YOUR-TUNNEL|trycloudflare|codexlink' | ForEach-Object { $_.Line }"
) else (
  echo.
  echo No stable Public URL configured.
  echo If you use Cloudflare Quick Tunnel, GPT Actions URL may change after restart.
  echo.
  set "DO_QUICK=n"
  if "%USE_DEFAULTS%"=="1" (
    echo [INFO] Defaults mode: skipping Quick Tunnel setup.
  ) else (
    set /p DO_QUICK="Run Quick Tunnel GPT Actions setup now? Requires cloudflared. [y/N]: "
  )
  if /I "!DO_QUICK!"=="y" (
    where cloudflared >nul 2>nul
    if errorlevel 1 (
      echo [FAIL] cloudflared was not found in PATH.
      echo Install cloudflared first, or use a stable Public URL later.
      pause
      exit /b 1
    )

    call :EnsureLocalServer
    if errorlevel 1 (
      echo [FAIL] Could not start local server.
      pause
      exit /b 1
    )

    if not exist "scripts\prepare-gpt-action.ps1" (
      echo [FAIL] Missing scripts\prepare-gpt-action.ps1
      pause
      exit /b 1
    )

    echo.
    echo === Start Quick Tunnel GPT Actions setup ===
    echo Follow the instructions in the PowerShell window.
    powershell -NoExit -ExecutionPolicy Bypass -File "%ROOT%scripts\prepare-gpt-action.ps1"
  )
)

echo.
if /I "%RUN_NOW_MODE%"=="yes" (
  set "RUN_NOW=y"
) else if /I "%RUN_NOW_MODE%"=="no" (
  set "RUN_NOW=n"
  echo [INFO] Start skipped by --no-start.
) else if "%USE_DEFAULTS%"=="1" (
  set "RUN_NOW=n"
  echo [INFO] Defaults mode: not starting CodexLink. Run start-codexlink.bat when ready.
) else (
  set /p RUN_NOW="Start CodexLink now? [Y/n]: "
)
if /I not "!RUN_NOW!"=="n" (
  if exist "start-codexlink.bat" (
    call "%ROOT%start-codexlink.bat"
  ) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\start-codexlink.ps1"
  )
)

echo.
echo ============================================================
echo  Setup finished.
echo ============================================================
echo Daily use:
echo   Double click start-codexlink.bat
echo.
echo Stop:
echo   Double click stop-codexlink.bat
echo.
echo If GPT Actions uses Quick Tunnel, rerun Quick Tunnel setup when URL changes.
echo If GPT Actions uses a stable Public URL, schema should not need URL changes.
echo.
if "%USE_DEFAULTS%"=="1" (
  echo Non-interactive defaults mode complete.
) else (
  pause
)
exit /b 0

:EnsureLocalServer
echo.
echo === Ensure local server is running ===
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:7777/health' -Method Get -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  echo [OK] Local server already healthy.
  exit /b 0
)

echo Starting local server in a new PowerShell window...
start "CodexLink Local Server" powershell.exe -NoExit -ExecutionPolicy Bypass -Command "cd '%ROOT%'; node dist\cli.js start --host 127.0.0.1 --port 7777"

echo Waiting for local server health...
for /L %%i in (1,1,25) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:7777/health' -Method Get -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
  if not errorlevel 1 (
    echo [OK] Local server is healthy.
    exit /b 0
  )
  timeout /t 1 /nobreak >nul
)

echo [FAIL] Local server did not become healthy.
exit /b 1
