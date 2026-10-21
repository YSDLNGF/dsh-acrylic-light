param(
  [int]$TimeoutMinutes = 120,
  [string]$Asar,
  [string]$Exe,
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
if (-not $asar) {
  # also accept a bare install dir via -Asar
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
  Write-Host 'app.asar not found automatically.'
  Write-Host 'Pass it explicitly:  powershell -File apply-when-closed.ps1 -Asar C:\path\to\resources\app.asar [-NoRestart]'
  Write-Host ''
  exit 2
}

# -- locate node: PATH first, then the runtime bundled with DSH --
$nodeCmd = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($nodeCmd -eq $null) {
  $candidates = @(
    (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
  )
  $runtime = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
  if (Test-Path $runtime) {
    $found = Get-ChildItem $runtime -Recurse -Filter node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found -ne $null) { $candidates += $found.FullName }
  }
  $nodeCmd = Find-First $candidates
}
if ($nodeCmd -eq $null) { Write-Host 'node.exe not found.'; exit 2 }

function Write-Log([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -Path $log -Value $line -Encoding utf8
  Write-Host $line
}

Write-Log "=== acrylic helper started (pid $PID) ==="
Write-Log "asar = $asar"
Write-Log "exe  = $exe"

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
  $running = Test-HarnessRunning
  $writable = Test-AsarWritable

  if (-not $running -and $writable) {
    $free = $true
    break
  }

  # report status every 15s so the user is not left staring at a blank window
  if (((Get-Date) - $lastReport).TotalSeconds -ge 15) {
    $lastReport = Get-Date
    if ($running) {
      Write-Log 'waiting: DeepSeek Harness is still running'
    } else {
      Write-Log 'waiting: Harness exited, but app.asar is still locked (handle not released yet)'
    }
  }

  Start-Sleep -Milliseconds 800
}

if (-not $free) {
  $running = Test-HarnessRunning
  if ($running) {
    Write-Log 'FAILED: DeepSeek Harness is STILL RUNNING.'
    Write-Log 'Quit it completely from the tray icon (right-click -> Exit), then run this again.'
  } else {
    Write-Log 'FAILED: app.asar is still locked even though Harness is gone.'
    Write-Log 'A leftover process is probably holding it. End all "DeepSeek Harness" processes'
    Write-Log 'in Task Manager, then run this again.'
  }
  exit 1
}
Write-Log 'asar released and writable'

# -- patch: add backgroundMaterial only, never a transparent backgroundColor --
Write-Log 'patching'
$patched = $false
try {
  $output = & $nodeCmd (Join-Path $here 'patch-asar.mjs') --asar $asar --material acrylic 2>&1
  Write-Log ($output -join "`n")
  if ($LASTEXITCODE -eq 0) {
    $patched = $true
    Write-Log 'PATCH OK'
  } else {
    Write-Log "PATCH FAILED exit=$LASTEXITCODE"
  }
} catch {
  Write-Log "patch threw: $($_.Exception.Message)"
}

# -- verify the patch really landed in the archive --
if ($patched) {
  $check = & $nodeCmd (Join-Path $here 'verify-asar.mjs') --asar $asar 2>&1
  Write-Log ($check -join "`n")
}

# -- relaunch so the user is not left without the app --
if (-not $NoRestart -and $exe -ne $null) {
  Write-Log "relaunching (patched=$patched)"
  Start-Process -FilePath $exe
} else {
  Write-Log 'not relaunching (-NoRestart specified or exe not found)'
}

Write-Log '=== done ==='
