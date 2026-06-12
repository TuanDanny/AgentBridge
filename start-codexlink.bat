@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-codexlink.ps1" %*
if errorlevel 1 (
  echo.
  echo CodexLink launcher failed. Press any key to close.
  pause >nul
)
