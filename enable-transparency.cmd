@echo off
chcp 65001 >nul
title dsh-acrylic-light - window transparency patch
setlocal EnableExtensions

:: ---------------------------------------------------------------------------
:: This file is deliberately ASCII-only. Do not add Chinese text here.
::
:: Why: cmd.exe reads a .cmd file using the active ANSI code page (GBK on a
:: Chinese Windows) even after `chcp 65001`, so UTF-8 Chinese in a batch file
:: decodes into mojibake and cmd then tries to RUN those fragments as commands
:: -- the window filled with "'...' is not recognized as an internal or
:: external command" and a stray "(" even opened Notepad. That was a real
:: reported bug.
::
:: All localized text therefore lives in apply-when-closed.ps1, which is
:: saved as UTF-8 **with BOM** -- PowerShell 5.1 needs the BOM to decode
:: non-ASCII correctly.
::
:: This wrapper does exactly one thing: hand over to PowerShell. No wait loop
:: here -- the old version spawned a PowerShell child every 2 seconds to poll
:: for the app's exit, which cost 1-2 seconds per iteration and looked frozen.
:: ---------------------------------------------------------------------------

:: Hand over. The PowerShell script prints the Chinese welcome banner,
:: waits for DSH to exit, patches, verifies and relaunches.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply-when-closed.ps1" -TimeoutMinutes 10
set "RC=%errorlevel%"

echo.
if not "%RC%"=="0" (
  echo ============================================================
  echo   [FAILED] The patch was not applied.
  echo ============================================================
  echo.
  echo   See the messages above for the reason.
  echo.
  echo   Quick checklist:
  echo     1. DeepSeek Harness really exited
  echo        Task Manager -^> end every "DeepSeek Harness" process
  echo     2. Permissions
  echo        Right-click this file -^> Run as administrator
  echo     3. Unusual install location
  echo        powershell -ExecutionPolicy Bypass -File "%~dp0apply-when-closed.ps1" -Asar "D:\your\path\resources\app.asar"
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
timeout /t 5 >nul 2>&1
exit /b 0
