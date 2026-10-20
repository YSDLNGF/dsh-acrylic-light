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

# -- locate app.asar --
$asar = $Asar
if (-not $asar) {
  $asar = Find-First @(
    'C:\Program Files\DeepSeek Harness\resources\app.asar'
    'C:\Program Files (x86)\DeepSeek Harness\resources\app.asar'
    (Join-Path $env:LOCALAPPDATA 'Programs\deepseek-harness\resources\app.asar')
    (Join-Path $env:LOCALAPPDATA 'DeepSeek Harness\resources\app.asar')
    'E:\gongju\deepseek\resources\app.asar'
  )
}

# -- locate the executable --
$exe = $Exe
if (-not $exe) {
  $exe = Find-First @(
    'C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe'
    'C:\Program Files (x86)\DeepSeek Harness\DeepSeek Harness.exe'
    (Join-Path $env:LOCALAPPDATA 'Programs\deepseek-harness\DeepSeek Harness.exe')
    (Join-Path $env:LOCALAPPDATA 'DeepSeek Harness\DeepSeek Harness.exe')
    'E:\gongju\deepseek\DeepSeek Harness.exe'
  )
}

if ($asar -eq $null) { Write-Host 'app.asar not found. Pass -Asar <path>.'; exit 2 }

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
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$free = $false
while ((Get-Date) -lt $deadline) {
  try {
    $stream = [System.IO.File]::Open($asar, 'Open', 'ReadWrite', 'None')
    $stream.Close()
    $free = $true
    break
  } catch {
    Start-Sleep -Milliseconds 700
  }
}
if (-not $free) { Write-Log 'timeout: asar still locked'; exit 1 }
Write-Log 'asar released'

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
