@echo off
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo ==================================================
echo   AgentBridge ngrok Restore Setup
echo   Domain: https://aide-pauper-refold.ngrok-free.dev
echo ==================================================
echo.

echo [1/3] Cleaning up any stale tunnel or server processes...
taskkill /f /im node.exe >nul 2>&1
taskkill /f /im ngrok.exe >nul 2>&1
taskkill /f /im cloudflared.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/3] Registering current project in AgentBridge registry...
node "%ROOT%\dist\cli.js" project register-current >nul 2>&1

echo [3/3] Restoring ngrok configuration and starting server...
powershell -ExecutionPolicy Bypass -File "%ROOT%\scripts\prepare-gpt-action.ps1" -TunnelUrl https://aide-pauper-refold.ngrok-free.dev -NoClipboard

if %ERRORLEVEL% neq 0 (
  echo.
  echo [FAIL] Restore failed. Please check the logs.
) else (
  echo.
  echo [SUCCESS] Restore complete! Your tunnel is online at:
  echo https://aide-pauper-refold.ngrok-free.dev
)

echo.
pause
