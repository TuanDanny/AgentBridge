@echo off
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo AgentBridge GPT Actions One-Click Setup
echo Root: %ROOT%
echo.

if not exist "%ROOT%\scripts\prepare-gpt-action.ps1" (
  echo Missing scripts\prepare-gpt-action.ps1
  pause
  exit /b 1
)

powershell -NoExit -ExecutionPolicy Bypass -File "%ROOT%\scripts\prepare-gpt-action.ps1"