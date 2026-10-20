@echo off
chcp 65001 >nul
setlocal EnableExtensions

set "HERE=%~dp0"

echo ============================================================
echo   dsh-acrylic-light  -  enable window transparency
echo ============================================================
echo.
echo   Step 1: QUIT DeepSeek Harness completely.
echo           Right-click the tray icon  -  Exit.
echo           Do NOT just close the window.
echo.
echo   This window continues by itself once Harness exits.
echo   (You can press Ctrl+C to cancel.)
echo.

tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" 2>nul | find /I "DeepSeek Harness.exe" >nul
if not errorlevel 1 (
  echo   Harness is running. Waiting...
)

:wait_loop
tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" 2>nul | find /I "DeepSeek Harness.exe" >nul
if not errorlevel 1 (
  timeout /t 2 /nobreak >nul
  goto wait_loop
)

echo.
echo   Harness exited. Applying patch...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%apply-when-closed.ps1" -TimeoutMinutes 5
if errorlevel 1 (
  echo.
  echo   [FAILED] Patch not applied. See messages above.
  echo   Log file: %HERE%apply.log
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   Done. DeepSeek Harness is restarting.
echo   The window should now show your desktop wallpaper.
echo ============================================================
timeout /t 6 >nul
exit /b 0
