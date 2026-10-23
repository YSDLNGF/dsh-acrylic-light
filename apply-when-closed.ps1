param(
  [int]$TimeoutMinutes = 120,
  [string]$Asar,
  [string]$Exe,
  [string]$Node,
  [switch]$NoRestart
)

# Waits for DeepSeek Harness to fully exit, applies the window-material patch
# to app.asar, then relaunches.
#
# Why this step exists:
#   Window material (backgroundMaterial) is an Electron BrowserWindow
#   CONSTRUCTOR option that only exists in the main process. Plugins run in a
#   separate Node process -- require('electron') fails there, so a plugin can
#   never reach the window object. Same situation as dsh-desktop-glass and
#   other themes: the window material has to be patched into app.asar.
#
# Usage:
#   Double-click enable-transparency.cmd in the same folder.
#
# Notes:
#   * No backup is restored. The patch is an equal-byte edit applied to the
#     current app.asar, so it is safe after a Harness update: if the anchors do
#     not match, the patch script exits without touching the file.
#   * Harness is relaunched automatically when the patch succeeds.

$ErrorActionPreference = 'Continue'

$here = $PSScriptRoot
if (-not $here) { $here = (Get-Location).Path }
$log = Join-Path $here 'apply.log'

# ---------------------------------------------------------------------------
# 中文欢迎横幅。
#
# 为什么放在 .ps1 而不是 .cmd：
#   .cmd 必须保持纯 ASCII（cmd.exe 会用系统 GBK 码页解析 UTF-8 字节，
#   中文会变成乱码并被当成命令执行）。本文件存为 UTF-8 **带 BOM**，
#   PowerShell 5.1 靠 BOM 就能正确显示中文 —— 所以所有中文都放这里。
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '============================================================'
Write-Host '  dsh-acrylic-light  -  开启窗口透明'
Write-Host '============================================================'
Write-Host ''
Write-Host '  这个工具会让 DeepSeek Harness 的窗口透出桌面壁纸，'
Write-Host '  模糊效果由 Windows 的 Acrylic 材质提供。'
Write-Host ''
Write-Host '  运行前必须把 DeepSeek Harness **完全退出**：'
Write-Host '    右下角托盘图标右键 -> 退出'
Write-Host '    只点窗口右上角的关闭按钮是不够的，程序还在后台运行'
Write-Host ''
Write-Host '  退出之后本工具会自动完成：'
Write-Host '    等待退出 -> 打补丁 -> 校验 -> 重新启动'
Write-Host '  整个过程不需要按任何键。'
Write-Host ''
Write-Host '  English: makes the DSH window show your desktop wallpaper'
Write-Host '  (Windows Acrylic blur). DSH must be FULLY closed (tray -> Exit).'
Write-Host '  Then it patches, verifies and relaunches automatically.'
Write-Host ''
Write-Host '============================================================'
Write-Host ''

function Find-First($paths) {
  foreach ($p in $paths) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

# discover the install directory via the Windows uninstall registry entry.
# This finds non-standard install locations (e.g. a portable/extracted copy
# anywhere on disk) without hardcoding any particular path.
function Get-InstallDirFromRegistry {
  $roots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($r in $roots) {
    $hits = Get-ItemProperty $r -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -match 'DeepSeek Harness' -or $_.DisplayLocation -match 'deepseek' }
    foreach ($h in $hits) {
      $loc = $null
      if ($h.InstallLocation) { $loc = $h.InstallLocation }
      elseif ($h.DisplayIcon -and $h.DisplayIcon -match '^([A-Za-z]:\\.*?)\\') { $loc = $Matches[1] }
      if ($loc -and (Test-Path (Join-Path $loc 'resources\app.asar'))) { return $loc }
    }
  }
  return $null
}

# -- locate app.asar (explicit, standard paths, then registry) --
$asar = $Asar
if ($asar) {
  # A bare install directory may be passed instead of the archive itself.
  #
  # This check belongs INSIDE the `if ($asar)` branch. It used to sit under
  # `if (-not $asar)`, i.e. exactly when $asar was the empty string, and
  # Join-Path throws ParameterArgumentValidationErrorEmptyStringNotAllowed
  # on that -- the crash seen before the archive was even looked for.
  if (Test-Path (Join-Path $asar 'resources\app.asar')) {
    $asar = Join-Path $asar 'resources\app.asar'
  }
}
if (-not $asar) {
  $asar = Find-First @(
    'C:\Program Files\DeepSeek Harness\resources\app.asar'
    'C:\Program Files (x86)\DeepSeek Harness\resources\app.asar'
    (Join-Path $env:LOCALAPPDATA 'Programs\deepseek-harness\resources\app.asar')
    (Join-Path $env:LOCALAPPDATA 'DeepSeek Harness\resources\app.asar')
  )
}
if (-not $asar) {
  $installDir = Get-InstallDirFromRegistry
  if ($installDir) { $asar = Join-Path $installDir 'resources\app.asar' }
}

# -- locate the executable (standard paths, then registry) --
$exe = $Exe
if (-not $exe) {
  $exe = Find-First @(
    'C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe'
    'C:\Program Files (x86)\DeepSeek Harness\DeepSeek Harness.exe'
    (Join-Path $env:LOCALAPPDATA 'Programs\deepseek-harness\DeepSeek Harness.exe')
    (Join-Path $env:LOCALAPPDATA 'DeepSeek Harness\DeepSeek Harness.exe')
  )
}
if (-not $exe) {
  $installDir = Get-InstallDirFromRegistry
  if ($installDir) { $exe = Join-Path $installDir 'DeepSeek Harness.exe' }
}

if ($asar -eq $null) {
  Write-Host ''
  Write-Host '没有自动找到 app.asar / app.asar not found automatically.'
  Write-Host ''
  Write-Host '请手动指定路径 / Pass it explicitly:'
  Write-Host '  powershell -ExecutionPolicy Bypass -File apply-when-closed.ps1 -Asar "C:\你的安装目录\resources\app.asar"'
  Write-Host ''
  exit 2
}

# -- locate node: PATH first, then the runtimes bundled with DSH --
#
# Search order and why:
#   1. PATH -- a user who has Node installed gets it immediately.
#   2. <install>\resources\... -- a packaged DSH may ship its own runtime
#      next to the app (handled by Find-First below).
#   3. %USERPROFILE%\.dsh\dsh-runtimes -- the CLI/web layout keeps a
#      downloaded runtime here (Node 22+ satisfies package engines).
#   4. Any node.exe found under common install roots, as a last resort.
#
# The old version only looked at PATH and %USERPROFILE%\.dsh\dsh-runtimes,
# so on a fresh machine (a VM, or a DSH installed somewhere else) it printed
# "node.exe not found." and stopped -- even though the archive was already
# located. Report what was searched so the user can act instead of guessing.
$nodeCmd = $Node
if ($nodeCmd) {
  if (-not (Test-Path $nodeCmd)) {
    Write-Host "The -Node path does not exist: $nodeCmd"
    exit 2
  }
}
if (-not $nodeCmd) {
  $nodeCmd = (Get-Command node -ErrorAction SilentlyContinue).Source
}

if ($nodeCmd -eq $null) {
  $candidates = @()

  # (a) runtime shipped beside the DSH install
  if ($asar) {
    $roots = @( (Split-Path (Split-Path $asar -Parent) -Parent) )
    foreach ($root in $roots) {
      if ($root -and (Test-Path $root)) {
        $candidates += (Join-Path $root 'node.exe')
        $candidates += (Join-Path $root 'resources\node.exe')
      }
    }
  }

  # (b) the DSH runtime cache
  $candidates += (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
  $runtime = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
  if (Test-Path $runtime) {
    $found = Get-ChildItem $runtime -Recurse -Filter node.exe -ErrorAction SilentlyContinue |
      Sort-Object FullName | Select-Object -First 1
    if ($found -ne $null) { $candidates += $found.FullName }
  }

  # (c) common Node.js install locations
  $candidates += 'C:\Program Files\nodejs\node.exe'
  $candidates += 'C:\Program Files (x86)\nodejs\node.exe'
  $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  $candidates += (Join-Path $env:PROGRAMFILES 'nodejs\node.exe')

  $nodeCmd = Find-First $candidates
}

if ($nodeCmd -eq $null) {
  Write-Host ''
  Write-Host '找不到 node.exe / node.exe not found.'
  Write-Host ''
  Write-Host '补丁工具 patch-asar.mjs 需要 Node.js 运行，但下面这些位置都没有找到:'
  Write-Host 'The patch tool runs on Node.js, and no copy was found in:'
  Write-Host '  - 系统 PATH'
  Write-Host "  - $env:USERPROFILE\.dsh\dsh-runtimes   (DSH 运行时缓存)"
  Write-Host '  - C:\Program Files\nodejs 及 %LOCALAPPDATA%\Programs\nodejs'
  Write-Host ''
  Write-Host '三种解决办法（任选其一）/ Fix it by either:'
  Write-Host '  1. 安装 Node.js 18+（https://nodejs.org），然后重新运行本脚本'
  Write-Host '     Install Node.js 18+ and re-run this script'
  Write-Host '  2. 先启动一次 DeepSeek Harness（它会下载运行时到上面的缓存目录），'
  Write-Host '     把 DSH 完全退出后再运行本脚本'
  Write-Host '     Start DSH once so it downloads its runtime, quit it, then re-run'
  Write-Host '  3. 手动指定 node 路径 / Pass the path explicitly:'
  Write-Host '     powershell -ExecutionPolicy Bypass -File apply-when-closed.ps1 -Node "C:\Program Files\nodejs\node.exe"'
  Write-Host ''
  exit 2
}
Write-Host "node 路径 / node: $nodeCmd"

function Write-Log([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -Path $log -Value $line -Encoding utf8
  Write-Host $line
}

Write-Log "=== 补丁助手已启动 / acrylic helper started (pid $PID) ==="
Write-Log "asar = $asar"
Write-Log "exe  = $exe"

# 开窗先讲清楚在等什么，避免看起来像卡死。
# Tell the user up front what is being waited for, so an idle window does not
# look like a hang.
Write-Host ''
Write-Host '正在等待 DeepSeek Harness 退出... / Waiting for DeepSeek Harness to exit...'
Write-Host '  如果它还开着：右下角托盘图标右键 → 退出 / right-click the tray icon -> Exit'
Write-Host '  关掉窗口不算退出，程序还在后台运行 / closing the window is not enough'
Write-Host ''
Write-Host '  本窗口会自动继续，不需要按任何键 / this window updates by itself, nothing to press'
Write-Host ''

# -- wait until app.asar is released --
#
# Why not rely on "can we open the file exclusively" alone:
#   1. Windows releases file handles with a delay. Right after the process
#      exits, Open(...,'None') can still fail, so the script thinks the app is
#      still running and waits until it times out. The user sees "it ran but
#      nothing happened".
#   2. A read-only open ('Read') often succeeds even while the app runs, but an
#      exclusive read/write open ('ReadWrite','None') is what we actually need.
#      Mixing the two up produces wrong verdicts.
#   3. The most reliable signal is that the process is gone. The file lock is
#      only a secondary check.
#
# So: wait for the process to disappear, then for the file to become writable.
# Only when both hold do we proceed.
function Test-HarnessRunning {
  $procs = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -eq 'DeepSeek Harness' -or ($_.Path -and $_.Path -eq $exe) }
  return ($procs -ne $null)
}

function Test-AsarWritable {
  try {
    $stream = [System.IO.File]::Open($asar, 'Open', 'ReadWrite', 'None')
    $stream.Close()
    return $true
  } catch {
    return $false
  }
}

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$free = $false
$lastReport = Get-Date

while ((Get-Date) -lt $deadline) {
  # The ONLY thing that actually blocks patching is the target file being
  # locked. The process check is merely used to word the status line.
  #
  # The old version required BOTH "no Harness process" AND "file writable",
  # which is wrong in two ways:
  #   * passing -Asar for some other copy (a backup, a second install) waited
  #     forever on a running Harness that has nothing to do with that file;
  #   * a Harness started from a different path also matched the name check.
  $writable = Test-AsarWritable
  if ($writable) { $free = $true; break }

  $running = Test-HarnessRunning

  # A live one-line status keeps the window from looking frozen.
  # The old version only logged every 15s, so for the first quarter minute
  # nothing changed on screen and users assumed it had hung.
  $elapsed = [int](((Get-Date) - ($deadline.AddMinutes(-$TimeoutMinutes))).TotalSeconds)
  if ($running) {
    Write-Host ("  已等 {0,3} 秒：Harness 还在运行，请从托盘退出 / still running" -f $elapsed) -NoNewline
  } else {
    Write-Host ("  已等 {0,3} 秒：Harness 已退出，正在等 app.asar 释放 / waiting for the file" -f $elapsed) -NoNewline
  }
  Write-Host "`r" -NoNewline

  # Keep the plain-text log sparse (one line per 15s) for later inspection.
  if (((Get-Date) - $lastReport).TotalSeconds -ge 15) {
    $lastReport = Get-Date
    if ($running) {
      Write-Log '等待中：app.asar 被占用（DeepSeek Harness 还在运行）'
    } else {
      Write-Log '等待中：app.asar 被占用（可能有残留进程）'
    }
  }

  Start-Sleep -Milliseconds 800
}

# Clear the status line before proceeding.
Write-Host ''
if ($free) { Write-Log 'app.asar 已释放且可写 / asar released and writable' }

if (-not $free) {
  $running = Test-HarnessRunning
  Write-Log '失败：等待超时，app.asar 仍被占用 / FAILED: still locked after the timeout'
  if ($running) {
    Write-Log 'DeepSeek Harness 还在运行。请从托盘图标右键 → 退出，然后重新运行本脚本。'
    Write-Log 'DSH is still running. Quit it from the tray icon, then run this again.'
  } else {
    Write-Log '没找到 Harness 进程，但有别的东西占着这个文件。'
    Write-Log '请在任务管理器里结束所有 "DeepSeek Harness" 进程后重试。'
    Write-Log 'End every "DeepSeek Harness" process in Task Manager, then try again.'
  }
  Write-Log ''
  Write-Log "目标文件 / File in question: $asar"
  exit 1
}

# -- patch: add backgroundMaterial only, never a transparent backgroundColor --
Write-Log '正在打补丁 / patching'
$patched = $false
try {
  $output = & $nodeCmd (Join-Path $here 'patch-asar.mjs') --asar $asar --material acrylic 2>&1
  Write-Log ($output -join "`n")
  if ($LASTEXITCODE -eq 0) {
    $patched = $true
    Write-Log '补丁已写入 / PATCH OK'
  } else {
    Write-Log "补丁失败 / PATCH FAILED exit=$LASTEXITCODE"
  }
} catch {
  Write-Log "打补丁时出错 / patch threw: $($_.Exception.Message)"
}

# -- verify the patch really landed in the archive --
$verified = $false
if ($patched) {
  $check = & $nodeCmd (Join-Path $here 'verify-asar.mjs') --asar $asar 2>&1
  Write-Log ($check -join "`n")
  if ($LASTEXITCODE -eq 0) { $verified = $true }
}

# -- relaunch so the user is not left without the app --
if (-not $NoRestart -and $exe -ne $null) {
  Write-Log "正在重新启动 DeepSeek Harness / relaunching (patched=$patched)"
  Start-Process -FilePath $exe
} else {
  Write-Log '未重新启动（指定了 -NoRestart 或找不到 exe）/ not relaunching'
}

Write-Log '=== 完成 / done ==='

# Exit code must reflect the real outcome.
#
# The old script ended with a bare Write-Log, so a failed patch still exited
# 0 -- enable-transparency.cmd then printed "Patch applied, restarting" over
# a failure, and the user had no idea the patch had not been written.
# Reported cases that reach here: "already patched" (patch-asar refuses to
# apply twice) and anchor mismatches after a DSH update.
if (-not $patched) {
  Write-Host ''
  Write-Host '补丁没有打上。请看上面的输出。 / The patch was NOT applied. See above.'
  Write-Host ''
  Write-Host '最常见的原因：这个 app.asar 已经打过补丁了（脚本拒绝重复打）。'
  Write-Host 'Most common cause: this app.asar is already patched (refuses to apply twice).'
  Write-Host ''
  Write-Host '如果窗口已经是磨砂玻璃效果，那就无需再打，直接关掉本窗口即可。'
  Write-Host 'If the window is already frosted, there is nothing to do.'
  Write-Host ''
  Write-Host '想强制重打，请先还原原始文件，再运行本脚本:'
  Write-Host 'To force a re-patch, restore the original first:'
  Write-Host '  powershell -ExecutionPolicy Bypass -File restore-asar.ps1'
  Write-Host ''
  exit 1
}
if (-not $verified) {
  Write-Host ''
  Write-Host '补丁已执行，但校验没有通过。先别重启。 / Verification did not pass.'
  Write-Host "详情见日志 / check the log: $log"
  exit 1
}
Write-Host ''
Write-Host '补丁已成功应用，窗口现在应该能透出桌面壁纸了。'
Write-Host 'Patch applied. The window should now show your desktop wallpaper.'
Write-Host ''
exit 0
