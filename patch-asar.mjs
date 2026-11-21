/**
 * patch-asar.mjs —— 给 DSH 主窗口补上 Windows 亚克力材质
 *
 * 为什么要改 app.asar
 * -------------------
 * 窗口材质（Mica / Acrylic）是 Electron `BrowserWindow` 的构造参数，
 * 只存在于主进程。插件跑在渲染进程的 Node 侧，拿不到窗口对象。
 * 实测也证明「从外部用 DwmSetWindowAttribute 硬设」不可行：
 * 跨进程调用返回 0x80070006（无效句柄），材质设不上去。
 *
 * 这一版针对的 DSH（0.2.2-rc.5 / Electron 44）主窗口 Windows 分支是：
 *   ...process.platform === "win32" && primary ? {
 *     backgroundColor: chromeFallbackFill(),        ← 不透明实色（#1b1b1c / #f9fafb）
 *     titleBarStyle: "hidden",
 *     titleBarOverlay: { height: 40, color: chromeFallbackFill(), symbolColor: ... }
 *   } : {},
 *
 * 两个把材质压死的东西，都在这里：
 *   1. `backgroundColor` 是**不透明**实色。Chromium 会先用它把整个窗口表面涂满，
 *      DWM 材质在它背后，于是一点都透不上来 —— 表现得就是"纯黑/纯白"。
 *      必须改成 `#00000000`。注意：**不能**加 `transparent: true`，
 *      那会让窗口走 layered window 路径，DWM 材质反而彻底失效。
 *   2. `titleBarOverlay.color` 同样是实色，会把标题栏那 40px 涂死。
 *
 * 另外，新版 main.js 在窗口建好后还会调 `window.setBackgroundColor(...)`
 * 把不透明色**再刷回去**两次：
 *   · `nativeTheme.on("updated")` 回调 —— 系统主题一变就刷；
 *   · `enterWorkspace()` 里 —— 每次进入工作区刷。
 * 只改构造参数不够，这两处也得改成透明，否则切换深浅色 / 重进工作区就黑掉。
 * 现在还多了一处 `window.setBackgroundMaterial("acrylic")` 在材质被系统重置时补回来。
 *
 * 修补策略（幂等 + 自校验）
 * -------------------------
 * 每条替换都是「精确字符串 → 精确字符串」，长度可以不等，最后整体重算
 * asar 头部的 integrity 并整体重写归档。改了长度就必须重写头部条目偏移，
 * 所以这里走的是**完整重序列化**：只改目标条目的 offset/integrity，
 * 其余条目原样保留，最后校验读回一致。
 *
 * 任何一步不匹配都直接抛错退出，绝不写出半成品。
 *
 * 用法：
 *   node patch-asar.mjs --asar <app.asar> [--material acrylic|mica] [--dry-run]
 *   node patch-asar.mjs --restore <backup.app.asar> --asar <app.asar>
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, openSync, closeSync, ftruncateSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MATERIALS = new Set(['acrylic', 'mica', 'tabbed', 'auto', 'none'])
const MAIN_ENTRY = 'lib/main.js'

function parseArgs(argv) {
  const out = { asar: undefined, material: 'acrylic', dryRun: false, restore: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--dry-run') out.dryRun = true
    else if (token === '--asar') out.asar = argv[++i]
    else if (token === '--material') out.material = argv[++i]
    else if (token === '--restore') out.restore = argv[++i]
    else throw new Error(`未知参数: ${token}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.asar === undefined) {
  console.error('用法: node patch-asar.mjs --asar <app.asar> [--material acrylic] [--dry-run]')
  process.exit(2)
}
const asarPath = resolve(args.asar)
if (!existsSync(asarPath)) {
  console.error(`找不到 ${asarPath}`)
  process.exit(2)
}

const fail = (message) => {
  console.error(`\n[失败] ${message}`)
  process.exit(1)
}
const info = (message) => console.log(message)

// ---------- 还原 ----------
if (args.restore !== undefined) {
  const from = resolve(args.restore)
  if (!existsSync(from)) fail(`找不到备份 ${from}`)
  copyFileSync(from, asarPath)
  console.log(`[完成] 已还原：${from} -> ${asarPath}`)
  process.exit(0)
}

if (!MATERIALS.has(args.material)) fail(`不支持的材质 "${args.material}"，可选：${[...MATERIALS].join(' / ')}`)

// ---------- 解析 asar ----------
// asar 格式（全部小端）：
//   u32 @0   = 4                （第一个 pickle 的头部大小，常量）
//   u32 @4   = 4 + 头部负载大小  （第一个 pickle 总大小）
//   u32 @8   = 头部负载大小
//   u32 @12  = JSON 字节数
//   @16      = JSON，随后用 0 补齐到 4 字节对齐
//   dataStart= 8 + u32@4，各条目数据依次排布
const buffer = readFileSync(asarPath)
const headerDataSize = buffer.readUInt32LE(4)
const jsonSize = buffer.readUInt32LE(12)
const headerJson = buffer.subarray(16, 16 + jsonSize).toString('utf8')
let header
try {
  header = JSON.parse(headerJson)
} catch (error) {
  fail(`解析头部 JSON 失败：${error.message}`)
}
const dataStart = 8 + headerDataSize

function entryOf(relative) {
  const parts = relative.split('/')
  let map = header.files
  let node
  for (const part of parts) {
    node = map[part]
    if (node === undefined) fail(`asar 缺少条目：${relative}`)
    map = node.files
  }
  return node
}

const entry = entryOf(MAIN_ENTRY)
const mainStart = dataStart + Number(entry.offset)
const mainSize = Number(entry.size)
const mainBuffer = buffer.subarray(mainStart, mainStart + mainSize)
const mainText = mainBuffer.toString('utf8')

info(`归档     : ${asarPath} (${(buffer.length / 1048576).toFixed(1)} MB)`)
info(`main.js  : ${mainSize} 字节 @ ${mainStart}`)
info(`目标材质 : ${args.material}`)

// ---------- 幂等检查 ----------
// 判断"已经打过补丁"必须可靠，否则会重复插入 backgroundMaterial，
// 把 main.js 改坏。
const alreadyPattern = /process\.platform === "win32" && primary \? \{[\s\S]{0,400}?backgroundMaterial:/u
if (alreadyPattern.test(mainText)) {
  fail('主窗口分支已含 backgroundMaterial，补丁已经打过（如需重打，先 --restore 还原）')
}

// ---------- 目标替换表 ----------
//
// 每一项都是「旧串必须**唯一**出现 → 换成新串」。任何一项找不到或不唯一，
// 说明这个 DSH 版本的主进程结构与预期不同 —— 直接失败，不做猜测。
//
// 所有替换都围绕同一件事：**别让不透明的 backgroundColor 盖住 DWM 材质**。
const edits = []

const addEdit = (label, find, replace, { optional = false } = {}) => {
  const count = mainText.split(find).length - 1
  if (count === 0) {
    if (optional) {
      info(`跳过   : ${label}（本版没有这段，非必需）`)
      return
    }
    fail(`找不到锚点「${label}」—— 这个 DSH 版本的主进程结构变了，补丁需要更新`)
  }
  if (count !== 1) fail(`锚点「${label}」出现 ${count} 次，应为 1 次`)
  edits.push({ label, find, replace })
  info(`定位   : ${label}`)
}

// ① 主窗口构造参数：不透明 backgroundColor → 全透明，并补上 backgroundMaterial。
//
// ⚠ 顺序很重要：backgroundColor 必须显式写成 "#00000000"。
//   Electron 文档与社区实测一致：backgroundMaterial 要生效，窗口表面必须
//   允许 alpha；不写 backgroundColor 会退到默认白底，同样把材质盖住。
//   但**绝不能**改成 transparent: true —— 那是 layered window 路径，
//   DWM 材质会被静默忽略。
addEdit(
  '主窗口材质',
  `...process.platform === "win32" && primary ? {\n\t\t\tbackgroundColor: chromeFallbackFill(),\n\t\t\ttitleBarStyle: "hidden",`,
  `...process.platform === "win32" && primary ? {\n\t\t\tbackgroundColor: "#00000000",\n\t\t\tbackgroundMaterial: "${args.material}",\n\t\t\ttitleBarStyle: "hidden",`,
)
// ② 标题栏 40px 那一条：实色 → 透明，让材质透上来。
addEdit(
  '标题栏 overlay 透明',
  `titleBarOverlay: {\n\t\t\t\theight: 40,\n\t\t\t\tcolor: chromeFallbackFill(),`,
  `titleBarOverlay: {\n\t\t\t\theight: 40,\n\t\t\t\tcolor: "#00000000",`,
)

// ③ 建窗后按系统主题刷新底色的回调 —— 不透明色会把材质重新盖掉。
//    顺带把材质补回来：系统切换深浅色/进入省电模式时，DWM 可能把
//    backgroundMaterial 重置成 "none"，只刷底色不足以恢复。
addEdit(
  '主题切换回调',
  `const updateBackground = () => {\n\t\t\tif (!window.isDestroyed()) window.setBackgroundColor(chromeFallbackFill());\n\t\t};`,
  `const updateBackground = () => {\n\t\t\tif (window.isDestroyed()) return;\n\t\t\twindow.setBackgroundColor("#00000000");\n\t\t\tif (typeof window.setBackgroundMaterial === "function") window.setBackgroundMaterial("${args.material}");\n\t\t};`,
)

// ④ 进入工作区时再刷一次底色 —— 同理，不清掉的话"重进工作区就变黑"。
addEdit(
  '进入工作区刷底色',
  `if (process.platform === "win32") window.setBackgroundColor(chromeFallbackFill());`,
  `if (process.platform === "win32") {\n\t\t\twindow.setBackgroundColor("#00000000");\n\t\t\tif (typeof window.setBackgroundMaterial === "function") window.setBackgroundMaterial("${args.material}");\n\t\t}`,
)

// ---------- 施加替换 ----------
let patched = mainText
for (const edit of edits) {
  patched = patched.replace(edit.find, () => edit.replace)
}
if (patched === mainText) fail('所有替换都没生效，拒绝继续')

// ---------- 校验结果 ----------
//
// ⚠ 关于 "残留 chromeFallbackFill"：macOS 分支里还有一处
//   `window.setVibrancy(null); window.setBackgroundColor(chromeFallbackFill());`
//   它是"窗口被最小化/隐藏时退回不透明色"的 macOS 专用逻辑，与 Windows 无关，
//   不该被改。所以这里只检查 **win32 语境**下不再有不透明底色。
const win32OpaqueLeft = (() => {
  for (const m of patched.matchAll(/setBackgroundColor\(chromeFallbackFill\(\)\)/gu)) {
    if (/win32/u.test(patched.slice(Math.max(0, m.index - 300), m.index))) return true
  }
  return false
})()

const checks = [
  [
    '主窗口分支有 backgroundMaterial',
    new RegExp(`process\\.platform === "win32" && primary \\? \\{[^}]*?backgroundMaterial: "${args.material}"`, 'u'),
  ],
  [
    '主窗口分支 backgroundColor 已透明',
    /process\.platform === "win32" && primary \? \{[^}]*?backgroundColor: "#00000000"/u,
  ],
  ['没有引入 transparent: true', !/primary \? \{[^}]*?transparent: true/u.test(patched)],
  ['标题栏 overlay 已透明', /titleBarOverlay: \{\s*height: \d+,\s*color: "#00000000",/u.test(patched)],
  ['win32 路径不再写不透明底色', !win32OpaqueLeft],
  ['win32 路径会补回 backgroundMaterial', (patched.match(/setBackgroundMaterial\(/gu) ?? []).length >= 2],
]
let failed = 0
for (const [label, ok] of checks) {
  if (!ok) failed += 1
  info(`${ok ? '✅' : '❌'} ${label}`)
}
if (failed > 0) fail(`${failed} 项校验未通过，拒绝写出`)

// ---------- 语法体检 ----------
// main.js 是 ESM（顶层 import），交给 Node 自己做真正的语法检查，而不是
// 自己写括号配对 —— 主进程里有大量正则字面量与模板字符串，
// 手写的配平器会误判（实测误报过一次）。
function syntaxOk(text) {
  const tmp = join(tmpdir(), `dsh-acrylic-check-${process.pid}.mjs`)
  const log = join(tmpdir(), `dsh-acrylic-check-${process.pid}.log`)
  let fd
  try {
    writeFileSync(tmp, text, 'utf8')
    // ⚠ 用文件描述符接 stderr，而不是默认的管道：
    //   某些受沙箱限制的环境里无法创建匿名管道（spawn 会直接 EPERM）。
    fd = openSync(log, 'w')
    // --check 只解析不执行。
    execFileSync(process.execPath, ['--check', tmp], { stdio: ['ignore', 'ignore', fd] })
    return { ok: true }
  } catch (error) {
    let detail = ''
    try { detail = readFileSync(log, 'utf8').trim() } catch { /* 日志读不到就只给退出码 */ }
    return { ok: false, detail: detail || String(error?.message ?? error) }
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* 已关闭 */ } }
    try { rmSync(tmp, { force: true }) } catch { /* 临时文件删不掉不影响结果 */ }
    try { rmSync(log, { force: true }) } catch { /* 同上 */ }
  }
}
const syntax = syntaxOk(patched)
if (!syntax.ok) fail(`修补后的 main.js 语法检查未通过：\n${syntax.detail}`)
info('✅ main.js 语法检查通过（node --check）')

// ---------- 重算 integrity 并重写归档 ----------
const patchedBuffer = Buffer.from(patched, 'utf8')
const oldHash = entry.integrity?.hash
if (typeof oldHash !== 'string') fail('头部缺少 integrity.hash')
const sourceHash = createHash('sha256').update(mainBuffer).digest('hex')
if (sourceHash !== oldHash) fail('源 main.js 的 sha256 与头部记录不符，拒绝继续')
const newHash = createHash('sha256').update(patchedBuffer).digest('hex')
if (oldHash === newHash) fail('哈希未变化，说明补丁没生效')

const sizeDelta = patchedBuffer.length - mainSize
info(`main.js 大小 : ${mainSize} -> ${patchedBuffer.length}（${sizeDelta >= 0 ? '+' : ''}${sizeDelta} 字节）`)

// 先复制一份内存中的完整归档，改掉目标条目的数据，再重建头部。
const output = Buffer.from(buffer)
const tail = buffer.subarray(mainStart + mainSize)

// 目标条目之后的条目 offset 需要整体平移 sizeDelta。
// 遍历整棵树，凡是起点在当前 main.js **之后**的条目都修正。
//
// ⚠ 必须是严格大于（start > mainStart），不能写成 >=：
//   main.js 自己的起点恰好等于 mainStart，用 >= 会把它的 offset 也平移，
//   于是头部指向的位置比真实数据晚了 sizeDelta 字节 —— 读回校验会立刻
//   发现"归档内 main.js 与预期不一致"。这个错误正是被读回校验抓到的。
//   顺带：main.js 自己的 offset 不变，只有 size/integrity 变。
function shiftOffsets(node, base) {
  if (node.files !== undefined) {
    for (const key of Object.keys(node.files)) shiftOffsets(node.files[key], base)
    return
  }
  if (typeof node.offset !== 'string' && typeof node.offset !== 'number') return
  const start = base + Number(node.offset)
  if (start > mainStart) node.offset = String(Number(node.offset) + sizeDelta)
}
shiftOffsets(header, dataStart)
entry.size = patchedBuffer.length
entry.integrity = { algorithm: 'SHA256', hash: newHash, blockSize: 4194304, blocks: [newHash] }

const newHeaderJson = JSON.stringify(header)
const headerBytes = Buffer.from(newHeaderJson, 'utf8')
const pad = (4 - ((4 + headerBytes.length) % 4)) % 4
const payloadSize = 4 + headerBytes.length + pad
const head = Buffer.alloc(16)
head.writeUInt32LE(4, 0)
head.writeUInt32LE(4 + payloadSize, 4)
head.writeUInt32LE(payloadSize, 8)
head.writeUInt32LE(headerBytes.length, 12)

const rebuilt = Buffer.concat([
  head,
  headerBytes,
  Buffer.alloc(pad),
  buffer.subarray(dataStart, mainStart),
  patchedBuffer,
  tail,
])
info(`归档大小 : ${buffer.length} -> ${rebuilt.length}（${(rebuilt.length / 1048576).toFixed(1)} MB）`)

// ---------- 写出 ----------
if (args.dryRun) {
  const dump = join(HERE, '_dryrun-main.js')
  writeFileSync(dump, patched, 'utf8')
  info(`\n[试运行] 未写入安装目录。main.js 已导出到 ${dump}`)
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
const backupDir = join(HERE, 'backups', stamp)
mkdirSync(backupDir, { recursive: true })
copyFileSync(asarPath, join(backupDir, 'app.asar'))

const temporary = join(dirname(asarPath), 'app.asar.glass-new')
writeFileSync(temporary, rebuilt)

// 读回校验：大小、哈希、内容都必须一致。
{
  const check = readFileSync(temporary)
  const checkJsonSize = check.readUInt32LE(12)
  const checkDataStart = 8 + check.readUInt32LE(4)
  const checkHeader = JSON.parse(check.subarray(16, 16 + checkJsonSize).toString('utf8'))
  const checkEntry = checkHeader.files.lib.files['main.js']
  if (Number(checkEntry.size) !== patchedBuffer.length) fail('校验失败：条目大小变化')
  if (checkEntry.integrity.hash !== newHash) fail('校验失败：integrity 未更新')
  const readBack = check.subarray(
    checkDataStart + Number(checkEntry.offset),
    checkDataStart + Number(checkEntry.offset) + patchedBuffer.length,
  ).toString('utf8')
  if (readBack !== patched) fail('校验失败：归档内 main.js 与预期不一致')
  // 抽查一个排在 main.js 之前的条目，确认没被移位影响。
  const pkg = checkHeader.files['package.json']
  if (pkg !== undefined && !pkg.files) {
    const pkgStart = checkDataStart + Number(pkg.offset)
    const pkgText = check.subarray(pkgStart, pkgStart + Number(pkg.size)).toString('utf8')
    if (!pkgText.trimStart().startsWith('{')) fail('校验失败：前置条目内容被破坏')
  }
  info('✅ 归档读回校验通过')
}

/**
 * 把 rebuild 后的归档写回目标路径。
 *
 * 首选方案是「写临时文件 → rename 覆盖」，这是原子操作。
 *
 * ⚠ 但 DeepSeek Harness 运行时会以共享读方式持有 app.asar：
 *   此时 WriteFile 打得开、rename 却会 EBUSY（Windows 不允许重命名被映射的文件）。
 *   所以失败时回退到**原地写**：
 *     · 备份已经先做过了，坏掉也能 restore；
 *     · fopen("r+") 打开同一个文件逐个字节覆盖，末尾用 ftruncate 收尾；
 *     · 原地写期间若进程正好在读，可能读到半份数据 —— 这只影响正在运行的
 *       那个实例的界面（下次启动就正常），不会损坏归档本身。
 *   真正要紧的是：**任何一步失败都不留下半成品**，所以原地写也是
 *   "先整体算完、校验完，再一次性覆盖"。
 */
function writeInPlace(target, bytes) {
  const fd = openSync(target, 'r+')
  try {
    let written = 0
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written, written)
    }
    // 新文件比旧文件短时（本补丁是变长，但仍要处理）必须截断。
    ftruncateSync(fd, bytes.length)
  } finally {
    closeSync(fd)
  }
}

const backupPath = join(backupDir, 'app.asar')
let wroteInPlace = false
try {
  renameSync(asarPath, `${asarPath}.glass-original`)
  renameSync(temporary, asarPath)
  rmSync(`${asarPath}.glass-original`, { force: true })
} catch (error) {
  if (error?.code !== 'EBUSY' && error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
  info('')
  info('⚠ DeepSeek Harness 正在运行，归档被占用，改用原地写入。')
  info('  备份已保存，写入完成后请完全退出 DSH 再启动，补丁才会生效。')
  writeInPlace(asarPath, rebuilt)
  wroteInPlace = true
  // 临时文件已无用，清掉
  try { rmSync(temporary, { force: true }) } catch { /* 删不掉不影响结果 */ }
  // 原地写完再读回确认一次（此时文件已是被覆盖过的）
  const verifyBytes = readFileSync(asarPath)
  if (verifyBytes.length !== rebuilt.length) fail('原地写入后大小不符，请用备份还原')
  if (!verifyBytes.equals(rebuilt)) fail('原地写入后内容不符，请用备份还原')
  info('✅ 原地写入读回校验通过')
}

writeFileSync(join(backupDir, 'restore.cmd'), [
  '@echo off',
  'chcp 65001 >nul',
  'echo Restoring window material patch. Make sure DeepSeek Harness is fully closed.',
  `copy /y "${join(backupDir, 'app.asar')}" "${asarPath}" >nul`,
  'echo.',
  'echo Restored. Restart DeepSeek Harness.',
  'pause',
].join('\r\n') + '\r\n', 'utf8')

info(`\n[完成] 窗口材质补丁已应用（${args.material}）`)
info(`  归档：${asarPath}（${(statSync(asarPath).size / 1048576).toFixed(1)} MB）`)
info(`  备份：${backupDir}`)
if (wroteInPlace) {
  info('')
  info('⚠ 本次是原地写入（当时 DSH 正在运行）。')
  info('  请**完全退出** DeepSeek Harness（托盘图标 → 退出）再启动，补丁才会生效。')
} else {
  info('\n下一步：完全退出 DeepSeek Harness 再启动，窗口才会透出壁纸。')
}
