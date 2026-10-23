# 诊断：为什么打了补丁窗口还是不透明。
#
# 只看四件事，每一件都能单独决定成败：
#   1. 目标 app.asar 里到底有没有 backgroundMaterial（补丁真的写进去了吗）
#   2. Windows 版本是否支持 Acrylic 材质（Win10 1803+；更老的系统不支持）
#   3. 系统的"透明效果"开关是否打开（关掉后对任何程序都不生效）
#   4. 是否运行在虚拟机里、显卡是否被识别为基本显示适配器
#      （无硬件加速 / 远程桌面会话下，DWM 会禁用 Acrylic）

$ErrorActionPreference = 'Continue'

Write-Host ''
Write-Host '============================================================'
Write-Host '  dsh-acrylic-light  -  透明效果诊断'
Write-Host '============================================================'
Write-Host ''

function Section($title) {
  Write-Host ''
  Write-Host "── $title ──────────────────────────────────"
}

# ---------------------------------------------------------------------------
Section '1. 补丁是否已经写进 app.asar'

$asarCandidates = @(
  'C:\Program Files\DeepSeek Harness\resources\app.asar'
  'C:\Program Files (x86)\DeepSeek Harness\resources\app.asar'
  (Join-Path $env:LOCALAPPDATA 'Programs\deepseek-harness\resources\app.asar')
  (Join-Path $env:LOCALAPPDATA 'DeepSeek Harness\resources\app.asar')
)

$asar = $null
foreach ($p in $asarCandidates) { if (Test-Path $p) { $asar = $p; break } }

if (-not $asar) {
  # 注册表兜底
  $roots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($r in $roots) {
    $hits = Get-ItemProperty $r -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -match 'DeepSeek Harness' }
    foreach ($h in $hits) {
      $loc = $null
      if ($h.InstallLocation) { $loc = $h.InstallLocation }
      elseif ($h.DisplayIcon -and $h.DisplayIcon -match '^([A-Za-z]:\\.*?)\\') { $loc = $Matches[1] }
      if ($loc -and (Test-Path (Join-Path $loc 'resources\app.asar'))) {
        $asar = Join-Path $loc 'resources\app.asar'
        break
      }
    }
    if ($asar) { break }
  }
}

if (-not $asar) {
  Write-Host '  [X] 没找到 app.asar。DSH 装在哪？请把安装目录告诉我。' -ForegroundColor Red
} else {
  Write-Host "  找到: $asar"
  $size = (Get-Item $asar).Length
  Write-Host "  大小: $size 字节"
  Write-Host "  修改时间: $((Get-Item $asar).LastWriteTime)"

  # 直接读字节找 backgroundMaterial（不解 asar，够用）
  $bytes = [System.IO.File]::ReadAllBytes($asar)
  $text = [System.Text.Encoding]::UTF8.GetString($bytes)

  $hasMaterial = $text.Contains('backgroundMaterial: "acrylic"')
  $hasTransparentTitle = $text.Contains('color: "#00000000",')
  # 检查主窗口分支里是否混入了会禁用材质的透明 backgroundColor
  $hasBadBg = $text -match '&& primary \? \{[\s\S]{0,300}?backgroundColor: "#00000000"'

  Write-Host ''
  Write-Host "  主窗口有 backgroundMaterial : $(if($hasMaterial){'是 OK'}else{'否  ← 补丁没打进去'})" -ForegroundColor $(if($hasMaterial){'Green'}else{'Red'})
  Write-Host "  标题栏 overlay 已透明      : $(if($hasTransparentTitle){'是 OK'}else{'否'})" -ForegroundColor $(if($hasTransparentTitle){'Green'}else{'Yellow'})
  Write-Host "  主窗口无透明 backgroundColor: $(if($hasBadBg){'否 ← 这会禁用材质'}else{'是 OK'})" -ForegroundColor $(if($hasBadBg){'Red'}else{'Green'})
}

# ---------------------------------------------------------------------------
Section '2. Windows 版本是否支持 Acrylic'

$cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
$build = 0
if ($cv.CurrentBuild) { $build = [int]$cv.CurrentBuild }
Write-Host "  系统: $($cv.ProductName)"
Write-Host "  版本: $($cv.DisplayVersion)   Build: $build"

# Acrylic 需要 Win10 1803 (Build 17134) 及以上。
# Win11 全部支持；Win10 低于 17134 不支持。
if ($build -ge 17134) {
  Write-Host "  [OK] 系统版本支持 Acrylic 材质（需要 Build >= 17134）" -ForegroundColor Green
} else {
  Write-Host "  [X] 系统版本太老，不支持 Acrylic 材质（需要 Build >= 17134）" -ForegroundColor Red
  Write-Host "      Win10 1803 以前的版本只能做全透明或实色，没有毛玻璃。"
}

# ---------------------------------------------------------------------------
Section '3. 系统"透明效果"开关'

$personalize = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction SilentlyContinue
$trans = $personalize.EnableTransparency
Write-Host "  EnableTransparency = $trans   (1 = 开, 0 = 关)"
if ($trans -eq 0) {
  Write-Host '  [X] 系统的透明效果是关闭的 —— 关掉后所有程序的 Acrylic 都不生效。' -ForegroundColor Red
  Write-Host '      设置 -> 个性化 -> 颜色 -> 透明效果 -> 打开'
} elseif ($trans -eq 1) {
  Write-Host '  [OK] 透明效果已开启' -ForegroundColor Green
} else {
  Write-Host '  [?] 读不到这个值，可能在"设置->个性化->颜色"里手动确认一次'
}

# ---------------------------------------------------------------------------
Section '4. 运行环境（虚拟机 / 远程桌面 会让 DWM 禁用 Acrylic）'

$bios = Get-ItemProperty 'HKLM:\HARDWARE\DESCRIPTION\System\BIOS' -ErrorAction SilentlyContinue
$sysMfr = "$($bios.SystemManufacturer)"
$sysProd = "$($bios.SystemProductName)"
Write-Host "  制造商: $sysMfr"
Write-Host "  型号  : $sysProd"

$vmHints = 'VMware|VirtualBox|VBOX|QEMU|Hyper-V|Parallels|Xen|innotek|Microsoft Corporation'
if ($sysMfr -match $vmHints -or $sysProd -match $vmHints) {
  Write-Host '  [!] 这是一台虚拟机。' -ForegroundColor Yellow
  Write-Host '      多数虚拟机没有真正的 GPU 合成，Windows 会退化为不透明窗口。'
} else {
  Write-Host '  [OK] 看起来是物理机' -ForegroundColor Green
}

# 基本显示适配器 = 没有显卡驱动，Acrylic 会被关掉
$gpu = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0000' -ErrorAction SilentlyContinue
if ($gpu.DriverDesc) {
  Write-Host "  显卡驱动: $($gpu.DriverDesc)"
  if ($gpu.DriverDesc -match 'Basic Display|Basic Render|标准 VGA') {
    Write-Host '  [X] 只有"基本显示适配器"——没有显卡驱动，Acrylic 不会生效。' -ForegroundColor Red
    Write-Host '      装一下虚拟机的增强工具/显卡驱动（VMware Tools、VirtualBox Guest Additions 等）。'
  }
} else {
  Write-Host '  [?] 读不到显卡驱动信息'
}

# 远程桌面会话下 DWM 也会禁用透明
$sessionName = $env:SESSIONNAME
Write-Host "  会话: $sessionName"
if ($sessionName -match 'RDP') {
  Write-Host '  [X] 当前是远程桌面(RDP)会话，Acrylic 在 RDP 下不生效。' -ForegroundColor Red
  Write-Host '      请在本机控制台会话里查看效果。'
}

# ---------------------------------------------------------------------------
Section '结论'

$problems = @()
if ($asar -and -not $hasMaterial) { $problems += '补丁没有写进 app.asar（需要重新运行 enable-transparency.cmd）' }
if ($asar -and $hasBadBg) { $problems += '主窗口带了透明 backgroundColor，会禁用 Acrylic 材质' }
if ($build -gt 0 -and $build -lt 17134) { $problems += 'Windows 版本低于 Build 17134，系统不支持 Acrylic' }
if ($trans -eq 0) { $problems += '系统"透明效果"开关是关闭的' }
if ($sysMfr -match $vmHints -or $sysProd -match $vmHints) { $problems += '运行在虚拟机里（可能缺少 GPU 合成）' }
if ($sessionName -match 'RDP') { $problems += '当前是 RDP 远程桌面会话' }

if ($problems.Count -eq 0) {
  Write-Host '  没发现明显问题。如果窗口仍然不透明，把上面的输出整段发给开发者。' -ForegroundColor Yellow
} else {
  Write-Host '  发现这些问题：' -ForegroundColor Yellow
  $n = 1
  foreach ($p in $problems) { Write-Host "    $n. $p"; $n++ }
}

Write-Host ''
Write-Host '============================================================'
Write-Host ''
