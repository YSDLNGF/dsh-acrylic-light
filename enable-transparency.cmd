@echo off
chcp 65001 >nul
title dsh-acrylic-light - enable window transparency
setlocal EnableExtensions

echo ============================================================
echo   dsh-acrylic-light  -  enable window transparency
echo ============================================================
echo.
echo   Makes the DeepSeek Harness window show your desktop
echo   wallpaper (Windows Acrylic blur).
echo.
echo   DeepSeek Harness must be FULLY closed.
echo   Right-click the tray icon  -  Exit.
echo   Closing the window is not enough.
echo.
echo   This script then does everything automatically, no key press:
echo     wait for exit -^> patch -^> verify -^> relaunch
echo.
echo ============================================================
echo.

:: All logic lives in the PowerShell script.
::
:: Why this file is ASCII-only (do not add Chinese text here):
::   cmd.exe reads a .cmd file using the system ANSI code page (GBK on a
::   Chinese Windows), while this file is stored as UTF-8. Chinese comments
::   and echo lines therefore decode into mojibake, and cmd then tries to
::   RUN those fragments as commands -- the window fills with
::   "'...' is not recognized as an internal or external command",
::   and a stray "(" can even open Notepad. That was the reported bug.
::   Keep every byte ASCII in .cmd files; put localized text in the .ps1
::   (PowerShell reads UTF-8 with a BOM correctly) or in the README.
::
:: Why no wait loop here:
::   The old version ran a PowerShell child process every 2 seconds to poll
::   for the app's exit. Each spawn costs 1-2 seconds, so the loop looked
::   frozen, and it spun forever while Harness was still up.
::   One PowerShell call does the waiting internally, with progress output.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply-when-closed.ps1" -TimeoutMinutes 10
set "RC=%errorlevel%"

echo.
if not "%RC%"=="0" (
  echo ============================================================
  echo   [FAILED] The patch was not applied.
  echo ============================================================
  echo.
  echo   Check these in order:
  echo.
  echo   1. DeepSeek Harness really exited
  echo      Open Task Manager, end every "DeepSeek Harness" process.
  echo.
  echo   2. Permissions
  echo      Right-click this file  -^>  Run as administrator.
  echo.
  echo   3. Unusual install location
  echo      Pass the path explicitly:
  echo      powershell -ExecutionPolicy Bypass -File "%~dp0apply-when-closed.ps1" -Asar "D:\your\path\resources\app.asar"
  echo.
  echo   Log: %~dp0apply.log
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo   Patch applied. DeepSeek Harness is restarting.
echo ============================================================
echo.
echo   The window should now show your desktop wallpaper.
echo.
timeout /t 5 >nul 2>&1
exit /b 0
