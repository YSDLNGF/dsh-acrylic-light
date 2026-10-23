@echo off
chcp 65001 >nul
title dsh-acrylic-light - diagnose why the window is not transparent
setlocal EnableExtensions

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose.ps1"
echo.
pause
