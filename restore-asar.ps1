param(
  [string]$Asar,
  [string]$Backup
)

<#
  还原 app.asar 的窗口材质补丁。
  不指定 -Backup 时，用 backups/ 下最新的那一份。
  运行前请确认 DeepSeek Harness 已完全退出（否则文件被占用，写入会失败）。
#>
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
if (-not $here) { $here = (Get-Location).Path }

function Find-First($paths) {
  foreach ($p in $paths) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

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

$asar = $Asar
if (-not $asar) {
  if ((Test-Path (Join-Path $asar 'resources\app.asar'))) { $asar = Join-Path $asar 'resources\app.asar' }
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
if ($asar -eq $null) {
  Write-Host '找不到 app.asar，请用 -Asar 指定'
  Write-Host '例如: restore-asar.ps1 -Asar C:\path\to\resources\app.asar'
  exit 2
}

# ── 找到备份 ────────────────────────────────────────────────
if (-not $Backup) {
  $dir = Join-Path $here 'backups'
  $latest = Get-ChildItem $dir -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            Select-Object -First 1
  if ($latest -ne $null) {
    $candidate = Join-Path $latest.FullName 'app.asar'
    if (Test-Path $candidate) { $Backup = $candidate }
  }
  # 兜底：patch-asar.mjs 也会把原件存成 .glass-original 旁的副本
  if (-not $Backup) {
    $legacy = Join-Path $here 'app.asar.original'
    if (Test-Path $legacy) { $Backup = $legacy }
  }
}
if (-not $Backup -or -not (Test-Path $Backup)) {
  Write-Host "找不到备份：$Backup"
  Write-Host '可用 -Backup <path> 手动指定。'
  exit 2
}

Write-Host "目标 : $asar"
Write-Host "备份 : $Backup"

# ── 确认文件未被占用 ────────────────────────────────────────
try {
  $stream = [System.IO.File]::Open($asar, 'Open', 'ReadWrite', 'None')
  $stream.Close()
} catch {
  Write-Host ''
  Write-Host 'app.asar 仍被占用 —— DeepSeek Harness 还没退出。'
  Write-Host '请从托盘完全退出后重试。'
  exit 3
}

Copy-Item $Backup $asar -Force
Write-Host ''
Write-Host '已还原 app.asar。重启 DeepSeek Harness 后窗口恢复原生外观。'
