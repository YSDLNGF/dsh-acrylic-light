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
  Write-Host 'app.asar not found automatically.'
  Write-Host 'Pass it explicitly:  powershell -File apply-when-closed.ps1 -Asar C:\path\to\resources\app.asar [-NoRestart]'
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
  Write-Host 'node.exe not found.'
  Write-Host ''
  Write-Host 'The patch tool (patch-asar.mjs) runs on Node.js, and no copy was found in:'
  Write-Host '  - PATH'
  Write-Host "  - $env:USERPROFILE\.dsh\dsh-runtimes  (DSH runtime cache)"
  Write-Host '  - C:\Program Files\nodejs, %LOCALAPPDATA%\Programs\nodejs'
  Write-Host ''
  Write-Host 'Fix it by either:'
  Write-Host '  1. Installing Node.js 18+ from https://nodejs.org and re-running this script, or'
  Write-Host '  2. Starting DSH once (it downloads its runtime into the cache above), or'
  Write-Host '  3. Passing the path explicitly:'
  Write-Host '       powershell -ExecutionPolicy Bypass -File apply-when-closed.ps1 -Node "C:\path\to\node.exe"'
  Write-Host ''
  exit 2
}
Write-Host "node: $nodeCmd"

function Write-Log([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -Path $log -Value $line -Encoding utf8
  Write-Host $line
}

Write-Log "=== acrylic helper started (pid $PID) ==="
Write-Log "asar = $asar"
Write-Log "exe  = $exe"

# Tell the user up front what is being waited for, so an idle window does not
# look like a hang. The old version printed nothing until the first 15s tick.
Write-Host ''
Write-Host 'Waiting for DeepSeek Harness to exit...'
Write-Host '  If it is still open: right-click the tray icon -> Exit.'
Write-Host '  This window updates automatically; there is nothing to press.'
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
    Write-Host ("  [{0,3}s] Harness is still running - quit it from the tray icon" -f $elapsed) -NoNewline
  } else {
    Write-Host ("  [{0,3}s] Harness exited; waiting for app.asar to be released" -f $elapsed) -NoNewline
  }
  Write-Host "`r" -NoNewline

  # Keep the plain-text log sparse (one line per 15s) for later inspection.
  if (((Get-Date) - $lastReport).TotalSeconds -ge 15) {
    $lastReport = Get-Date
    if ($running) {
      Write-Log 'waiting: app.asar is locked (DeepSeek Harness is still running)'
    } else {
      Write-Log 'waiting: app.asar is locked (a leftover process may be holding it)'
    }
  }

  Start-Sleep -Milliseconds 800
}

# Clear the status line before proceeding.
Write-Host ''
if ($free) { Write-Log 'asar released and writable' }

if (-not $free) {
  $running = Test-HarnessRunning
  Write-Log 'FAILED: app.asar is still locked after the timeout.'
  if ($running) {
    Write-Log 'DeepSeek Harness is still running. Quit it completely from the tray icon'
    Write-Log '(right-click -> Exit), then run this script again.'
  } else {
    Write-Log 'No Harness process was found, so something else is holding the file.'
    Write-Log 'End every "DeepSeek Harness" process in Task Manager, then try again.'
  }
  Write-Log ''
  Write-Log "File in question: $asar"
  exit 1
}

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
$verified = $false
if ($patched) {
  $check = & $nodeCmd (Join-Path $here 'verify-asar.mjs') --asar $asar 2>&1
  Write-Log ($check -join "`n")
  if ($LASTEXITCODE -eq 0) { $verified = $true }
}

# -- relaunch so the user is not left without the app --
if (-not $NoRestart -and $exe -ne $null) {
  Write-Log "relaunching (patched=$patched)"
  Start-Process -FilePath $exe
} else {
  Write-Log 'not relaunching (-NoRestart specified or exe not found)'
}

Write-Log '=== done ==='

# Exit code must reflect the real outcome.
#
# The old script ended with a bare Write-Log, so a failed patch still exited
# 0 -- enable-transparency.cmd then printed "Patch applied, restarting" over
# a failure, and the user had no idea the patch had not been written.
# Reported cases that reach here: "already patched" (patch-asar refuses to
# apply twice) and anchor mismatches after a DSH update.
if (-not $patched) {
  Write-Host ''
  Write-Host 'The patch was NOT applied. See the messages above.'
  Write-Host 'Most common cause: this app.asar was already patched (the script'
  Write-Host 'refuses to apply it twice). If the window is already frosted,'
  Write-Host 'there is nothing to do. To force a re-patch, restore the original'
  Write-Host 'first:  powershell -ExecutionPolicy Bypass -File restore-asar.ps1'
  exit 1
}
if (-not $verified) {
  Write-Host ''
  Write-Host 'The patch ran but verification did not pass. Do not restart yet;'
  Write-Host "check $log for details."
  exit 1
}
exit 0
