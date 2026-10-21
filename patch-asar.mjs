/**
 * patch-asar.mjs —— 给 DSH 主窗口补上 Windows 亚克力材质（等字节修补）
 *
 * 为什么要改 app.asar
 * -------------------
 * 窗口材质（Mica / Acrylic）是 Electron `BrowserWindow` 的构造参数，
 * 只存在于主进程。插件跑在渲染进程的 Node 侧，拿不到窗口对象。
 * 实测也证明「从外部用 DwmSetWindowAttribute 硬设」不可行：
 * 跨进程调用返回 0x80070006（无效句柄），材质设不上去。
 *
 * 这一版 DSH（0.2.1-rc.2）的主窗口 Windows 分支只有：
 *   titleBarStyle: "hidden",
 *   titleBarOverlay: { height: 40, color: chromeFallbackFill(), symbolColor: ... }
 * 注意 color 是**实色**（#1b1b1c / #f9fafb）——它会把标题栏那 40px 涂死，
 * 这是「上面一条实心、下面透」的根因之一。
 *
 * 本补丁做三件事（全部是"改值"，不新增顶层结构）：
 *   1. 主窗口 win32 分支补 backgroundMaterial: "acrylic" 与 backgroundColor: "#00000000"；
 *   2. titleBarOverlay.color 由 chromeFallbackFill() 改成透明；
 *   3. 用一段真实 JSDoc 注释裁掉等长字节来配平，保证 main.js 大小不变，
 *      因此 asar 头部所有条目的 offset 都不用动，只更新该条目自身的 integrity 哈希。
 *
 * 任何一步不匹配都直接抛错退出，绝不写出半成品。
 *
 * 用法：
 *   node patch-asar.mjs --asar <app.asar> [--material acrylic|mica] [--dry-run]
 *   node patch-asar.mjs --restore <backup.app.asar> --asar <app.asar>
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MATERIALS = new Set(['acrylic', 'mica', 'tabbed', 'auto', 'none'])

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
const buffer = readFileSync(asarPath)
// asar 格式：4字节 pickle 长度 + 4字节 header 大小 + JSON，条目数据紧随其后。
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

const entry = entryOf('lib/main.js')
const mainStart = dataStart + Number(entry.offset)
const mainSize = entry.size
const mainText = buffer.subarray(mainStart, mainStart + mainSize).toString('utf8')

console.log(`归档     : ${asarPath} (${(buffer.length / 1048576).toFixed(1)} MB)`)
console.log(`main.js  : ${mainSize} 字节 @ ${mainStart}`)
console.log(`目标材质 : ${args.material}`)

// ---------- 幂等检查 ----------
// 判断"已经打过补丁"必须可靠，否则会重复插入 backgroundMaterial，
// 把 main.js 改坏。之前用 400 字节窗口匹配，但补丁版里
// backgroundMaterial 和 primary ? { 之间隔着 titleBarOverlay 等属性，
// 窗口一超就漏判 —— 现在改成：[从 primary ? { 到下一个顶层 } 之间] 是否已有。
const idempotentPattern = /process\.platform === "win32" && primary \? \{[\s\S]{0,2000}?backgroundMaterial:/u
if (idempotentPattern.test(mainText)) {
  fail('主窗口分支已含 backgroundMaterial，补丁已经打过（如需重打，先 --restore 还原）')
}

// ---------- 1. 定位主窗口 win32 分支（必须唯一）----------
const anchorPattern = /process\.platform === "win32" && primary \? \{(\s*)titleBarStyle: "hidden",/u
const anchorMatches = [...mainText.matchAll(new RegExp(anchorPattern.source, 'gu'))]
if (anchorMatches.length !== 1) fail(`主窗口锚点匹配 ${anchorMatches.length} 处，应为 1 处`)
const anchor = anchorMatches[0]
const innerIndent = anchor[1].replace(/^\n/u, '')
if (innerIndent.length === 0) fail('无法推断主窗口属性缩进')
const insertAt = anchor.index + anchor[0].length
console.log(`主窗口锚点唯一匹配 @${anchor.index}（缩进 ${innerIndent.length} 字符）`)

// ---------- 2. 定位 titleBarOverlay 的实色 color（必须唯一且在锚点之后）----------
// 形如：titleBarOverlay: { height: 40, color: chromeFallbackFill(), symbolColor: ... }
const overlayPattern = /titleBarOverlay: \{\s*height: (\d+),\s*color: chromeFallbackFill\(\),/u
const overlayMatches = [...mainText.matchAll(new RegExp(overlayPattern.source, 'gu'))]
if (overlayMatches.length !== 1) fail(`titleBarOverlay 锚点匹配 ${overlayMatches.length} 处，应为 1 处`)
const overlay = overlayMatches[0]
if (overlay.index < insertAt) fail('titleBarOverlay 锚点位于主窗口分支之前，结构不符合预期')
const overlayIndent = (() => {
  const lineStart = mainText.lastIndexOf('\n', overlay.index) + 1
  return mainText.slice(lineStart, overlay.index)
})()
console.log(`titleBarOverlay 锚点唯一匹配 @${overlay.index}`)

// ---------- 3. 计算插入与替换 ----------
// A. 在 titleBarStyle 之后只插入材质。
//    刻意**不加** backgroundColor: "#00000000"：Electron 里显式设置透明背景色会让
//    窗口走「透明窗口」路径，那条路径与系统材质（Mica/Acrylic）互斥，结果就是
//    材质被静默忽略（实测 backdrop(Type38) 始终为 0）。
//    DSH 自己的欢迎窗就是只用 backgroundMaterial、不设 backgroundColor，且有效。
const insertion = `\n${innerIndent}backgroundMaterial: "${args.material}",`
// B. 把实色 overlay 换成透明（值变短，需要一并配平）
const overlayOld = overlay[0]
const overlayNew = overlayOld.replace('color: chromeFallbackFill(),', 'color: "#00000000",')
if (overlayNew === overlayOld) fail('titleBarOverlay 替换未生效')

const netBytes = Buffer.byteLength(insertion, 'utf8') + (Buffer.byteLength(overlayNew, 'utf8') - Buffer.byteLength(overlayOld, 'utf8'))
console.log(`净增 ${netBytes} 字节（插入 ${Buffer.byteLength(insertion, 'utf8')}，overlay 缩短 ${Buffer.byteLength(overlayOld, 'utf8') - Buffer.byteLength(overlayNew, 'utf8')}）`)

// ---------- 4. 找一段可裁剪的 JSDoc 来配平 ----------
/**
 * 只认「行首起始、独立成行、后面紧跟声明关键字」的 JSDoc。
 * 这样能确保它是真注释而不是字符串里的内容，裁掉也不会改变语义。
 */
function findBalanceTarget(text, need) {
  const pattern = /\n([ \t]*)(\/\*\*[\s\S]*?\*\/)(?=\n[ \t]*(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\b)/gu
  const found = []
  let hit
  while ((hit = pattern.exec(text)) !== null) {
    const body = hit[2]
    if (body.length >= need + 24) found.push({ at: hit.index + 1 + hit[1].length, len: body.length })
  }
  found.sort((a, b) => a.len - b.len)
  return found[0] ?? null
}

const balance = findBalanceTarget(mainText, netBytes)
if (balance === null) fail(`找不到可配平的 JSDoc（需要 >= ${netBytes + 24} 字节）`)
const oldComment = mainText.slice(balance.at, balance.at + balance.len)
if (!oldComment.startsWith('/**') || !oldComment.endsWith('*/')) fail('配平目标不是完整块注释')

const targetLen = balance.len - netBytes
const keepBody = oldComment.slice(3, oldComment.length - 2).slice(0, targetLen - 5)
const newComment = `/**${keepBody}*/`
if (Buffer.byteLength(newComment, 'utf8') !== targetLen) fail('配平长度计算不符')
console.log(`配平注释 @${balance.at}: ${balance.len} -> ${targetLen} 字节`)

// ---------- 5. 施加修改（从后往前，避免位移）----------
const edits = [
  { at: balance.at, len: balance.len, text: newComment },
  { at: overlay.index, len: overlayOld.length, text: overlayNew },
  { at: insertAt, len: 0, text: insertion },
].sort((a, b) => b.at - a.at)

let patched = mainText
for (const edit of edits) {
  patched = patched.slice(0, edit.at) + edit.text + patched.slice(edit.at + edit.len)
}

const patchedBuffer = Buffer.from(patched, 'utf8')
if (patchedBuffer.length !== mainSize) fail(`大小不匹配：${patchedBuffer.length} vs ${mainSize}（等字节修补失败）`)
console.log(`✅ 等字节修补完成（${mainSize} 字节）`)

// ---------- 6. 校验结果 ----------
const verifyPattern = new RegExp(
  `process\\.platform === "win32" && primary \\? \\{\\s*titleBarStyle: "hidden",\\s*backgroundMaterial: "${args.material}",`,
  'u',
)
if (!verifyPattern.test(patched)) fail('材质属性插入校验失败')
// 必须确保没有残留的透明 backgroundColor —— 它会禁用系统材质。
if (/&& primary \? \{[\s\S]{0,200}?backgroundColor: "#00000000"/u.test(patched)) {
  fail('主窗口分支仍带透明 backgroundColor，会禁用系统材质')
}
if (!patched.includes('titleBarOverlay: {\n\t\t\t\theight: 40,\n\t\t\t\tcolor: "#00000000",')) {
  // 缩进可能不同，退化为语义检查
  if (!/titleBarOverlay: \{\s*height: \d+,\s*color: "#00000000",/u.test(patched)) fail('titleBarOverlay 透明化校验失败')
}
console.log('✅ 材质属性与透明标题栏校验通过')

// ---------- 7. 更新 integrity（只改哈希，长度不变）----------
const oldHash = entry.integrity?.hash
if (typeof oldHash !== 'string') fail('头部缺少 integrity.hash')
const sourceHash = createHash('sha256').update(buffer.subarray(mainStart, mainStart + mainSize)).digest('hex')
if (sourceHash !== oldHash) fail('源 main.js 的 sha256 与头部记录不符，拒绝继续')
const newHash = createHash('sha256').update(patchedBuffer).digest('hex')
if (oldHash === newHash) fail('哈希未变化，说明补丁没生效')

const hashCount = headerJson.split(oldHash).length - 1
if (hashCount !== 2) fail(`旧哈希在头部出现 ${hashCount} 次，预期 2 次（hash + blocks[0]）`)
const newHeaderJson = headerJson.split(oldHash).join(newHash)
if (newHeaderJson.length !== headerJson.length) fail('头部长度变化，拒绝写出')
console.log(`integrity: ${oldHash.slice(0, 12)}… -> ${newHash.slice(0, 12)}…`)

// ---------- 8. 写出 ----------
if (args.dryRun) {
  writeFileSync(join(HERE, '_dryrun-main.js'), patched, 'utf8')
  console.log(`\n[试运行] 未写入安装目录。main.js 已导出到 ${join(HERE, '_dryrun-main.js')}`)
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
const backupDir = join(HERE, 'backups', stamp)
mkdirSync(backupDir, { recursive: true })
copyFileSync(asarPath, join(backupDir, 'app.asar'))

const temporary = join(dirname(asarPath), 'app.asar.glass-new')
{
  const output = Buffer.from(buffer)
  patchedBuffer.copy(output, mainStart)
  Buffer.from(newHeaderJson, 'utf8').copy(output, 16)
  writeFileSync(temporary, output)
}

// 读回校验：大小、哈希、内容都必须一致
{
  const check = readFileSync(temporary)
  const checkJsonSize = check.readUInt32LE(12)
  const checkHeader = JSON.parse(check.subarray(16, 16 + checkJsonSize).toString('utf8'))
  const checkEntry = checkHeader.files.lib.files['main.js']
  if (Number(checkEntry.size) !== mainSize) fail('校验失败：条目大小变化')
  if (checkEntry.integrity.hash !== newHash) fail('校验失败：integrity 未更新')
  const checkDataStart = 8 + check.readUInt32LE(4)
  const readBack = check.subarray(checkDataStart + Number(checkEntry.offset), checkDataStart + Number(checkEntry.offset) + mainSize).toString('utf8')
  if (readBack !== patched) fail('校验失败：归档内 main.js 与预期不一致')
  if (check.length !== buffer.length) fail('校验失败：归档总大小变化')
}
console.log('✅ 归档读回校验通过')

renameSync(asarPath, `${asarPath}.glass-original`)
renameSync(temporary, asarPath)
rmSync(`${asarPath}.glass-original`, { force: true })

writeFileSync(join(backupDir, 'restore.cmd'), [
  '@echo off',
  'chcp 65001 >nul',
  'echo Restoring window material patch. Make sure DeepSeek Harness is fully closed.',
  `copy /y "${join(backupDir, 'app.asar')}" "${asarPath}" >nul`,
  'echo.',
  'echo Restored. Restart DeepSeek Harness.',
  'pause',
].join('\r\n') + '\r\n', 'utf8')

console.log(`\n[完成] 窗口材质补丁已应用（${args.material}）`)
console.log(`  归档：${asarPath}（${(statSync(asarPath).size / 1048576).toFixed(1)} MB，大小未变）`)
console.log(`  备份：${backupDir}`)
console.log('\n下一步：完全退出 DeepSeek Harness 再启动，窗口才会透出壁纸。')
