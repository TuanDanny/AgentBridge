@echo off
setlocal EnableExtensions EnableDelayedExpansion

title CodexLink - Register Project

echo.
echo ============================================================
echo CodexLink / AgentBridge - Register One Project
echo ============================================================
echo.
echo Cach dung:
echo   1. De file nay trong thu muc AgentBridge
echo      vi du: D:\AgentBridge\register-project.bat
echo   2. Double click file nay
echo   3. Dan duong dan project can dang ky
echo   4. Nhap Project ID hoac bo trong de lay ten folder
echo.

REM Script nay duoc thiet ke de nam trong thu muc goc AgentBridge.
set "AGENTBRIDGE_DIR=%~dp0"
cd /d "%AGENTBRIDGE_DIR%"

if not exist "dist\cli.js" (
  echo [ERROR] Khong thay dist\cli.js trong:
  echo         "%AGENTBRIDGE_DIR%"
  echo.
  echo Ban hay build AgentBridge truoc:
  echo   npm run build
  echo.
  pause
  exit /b 1
)

echo AgentBridge folder:
echo   "%AGENTBRIDGE_DIR%"
echo.

set "PROJECT_PATH="
set /p "PROJECT_PATH=Dan duong dan project can dang ky vao day: "

REM Xoa dau quote neu user paste kem dau "
set "PROJECT_PATH=%PROJECT_PATH:"=%"

if "%PROJECT_PATH%"=="" (
  echo.
  echo [ERROR] Ban chua nhap duong dan project.
  pause
  exit /b 1
)

if not exist "%PROJECT_PATH%" (
  echo.
  echo [ERROR] Duong dan khong ton tai:
  echo   "%PROJECT_PATH%"
  echo.
  pause
  exit /b 1
)

REM Lay ten folder lam Project ID mac dinh.
for %%I in ("%PROJECT_PATH%") do set "DEFAULT_ID=%%~nxI"

echo.
echo Project path:
echo   "%PROJECT_PATH%"
echo.
echo Project ID mac dinh: %DEFAULT_ID%
echo Neu muon dung ten nay, bam Enter.
echo.

set "PROJECT_ID="
set /p "PROJECT_ID=Nhap Project ID: "

if "%PROJECT_ID%"=="" set "PROJECT_ID=%DEFAULT_ID%"

REM Lam sach Project ID co ban: thay space bang _
set "PROJECT_ID=%PROJECT_ID: =_%"

echo.
echo ------------------------------------------------------------
echo Dang ky project:
echo   ID   : %PROJECT_ID%
echo   Path : "%PROJECT_PATH%"
echo ------------------------------------------------------------
echo.

node dist\cli.js project register "%PROJECT_ID%" "%PROJECT_PATH%"
if errorlevel 1 (
  echo.
  echo [FAIL] Dang ky project that bai.
  echo Hay kiem tra lai path, Project ID, hoac dist\cli.js.
  pause
  exit /b 1
)

echo.
echo [PASS] Da dang ky project thanh cong.
echo.

choice /C YN /N /M "Ban co muon chon project nay lam active project khong? [Y/N]: "
if errorlevel 2 goto SKIP_SELECT

echo.
node dist\cli.js project select "%PROJECT_ID%"
if errorlevel 1 (
  echo.
  echo [WARN] Dang ky thanh cong, nhung select active project that bai.
) else (
  echo.
  echo [PASS] Da chon active project: %PROJECT_ID%
)

:SKIP_SELECT
echo.
echo Danh sach project hien co:
echo ------------------------------------------------------------
node dist\cli.js project list
echo ------------------------------------------------------------
echo.
echo Xong.
pause
endlocal
