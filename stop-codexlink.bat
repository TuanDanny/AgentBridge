@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-codexlink.ps1" %*
if errorlevel 1 (
  echo.
  echo CodexLink stop failed. Press any key to close.
  pause >nul
)
