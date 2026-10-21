@echo off
chcp 65001 >nul
title dsh-acrylic-light - 开启窗口透明
setlocal EnableExtensions EnableDelayedExpansion

set "HERE=%~dp0"
set "LOG=%HERE%apply.log"

echo ============================================================
echo   dsh-acrylic-light  -  开启窗口透明
echo ============================================================
echo.
echo   这个脚本会让 DeepSeek Harness 窗口透出桌面壁纸
echo   （Windows Acrylic 材质模糊）。
echo.
echo   流程：
echo     1. 等你完全退出 DeepSeek Harness
echo     2. 自动给 app.asar 打补丁
echo     3. 校验结果
echo     4. 自动重新启动 Harness
echo.
echo   注意：必须"完全退出"——托盘图标右键 → 退出，
echo         不是只点窗口右上角的关闭按钮。
echo.
echo   按 Ctrl+C 可随时取消。
echo.
pause

:: ── 用 PowerShell 可靠地检测进程（tasklist 在部分环境会被拒绝访问）──
:check_running
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue; if ($p) { exit 1 } else { exit 0 }"
if not errorlevel 1 goto exited

echo   Harness 还在运行，等待退出...（每 2 秒检查一次）
timeout /t 2 /nobreak >nul 2>&1
if errorlevel 1 ping -n 3 127.0.0.1 >nul 2>&1
goto check_running

:exited
echo.
echo   Harness 已退出，开始打补丁...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%apply-when-closed.ps1" -TimeoutMinutes 5
set "RC=%errorlevel%"

echo.
if not "%RC%"=="0" (
  echo ============================================================
  echo   [失败] 补丁没有打成功。
  echo ============================================================
  echo.
  echo   常见原因和解决办法：
  echo.
  echo   1. Harness 没有真正退出
  echo      → 打开任务管理器，结束所有 "DeepSeek Harness" 进程后重试
  echo.
  echo   2. 权限不足
  echo      → 右键这个文件，选择"以管理员身份运行"
  echo.
  echo   3. 安装目录不在常见位置
  echo      → 手动指定路径重试（见下面）
  echo.
  echo   详细日志：%LOG%
  echo.
  echo   手动指定 app.asar 路径的命令：
  echo     powershell -ExecutionPolicy Bypass -File "%~dp0apply-when-closed.ps1" -Asar "你的路径\resources\app.asar"
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo   补丁已应用成功，正在重新启动 DeepSeek Harness
echo ============================================================
echo.
echo   重启后窗口应该就能透出桌面壁纸了。
echo.
timeout /t 6 >nul 2>&1
exit /b 0
