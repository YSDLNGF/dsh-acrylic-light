/**
 * verify-asar.mjs —— 校验 app.asar 里的窗口材质补丁是否真的就位。
 *
 * 只读，不修改任何文件。用来在重启前确认"这次值得重启"，
 * 避免反复试错却不知道补丁有没有落进去。
 *
 * 用法：node verify-asar.mjs --asar <app.asar>
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const idx = args.indexOf('--asar')
const asarArg = idx === -1 ? undefined : args[idx + 1]
if (asarArg === undefined) {
  console.error('用法: node verify-asar.mjs --asar <app.asar>')
  process.exit(2)
}
const asarPath = resolve(asarArg)

const buffer = readFileSync(asarPath)
const headerDataSize = buffer.readUInt32LE(4)
const jsonSize = buffer.readUInt32LE(12)
const header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString('utf8'))
const dataStart = 8 + headerDataSize

const entry = header.files.lib.files['main.js']
const start = dataStart + Number(entry.offset)
const main = buffer.subarray(start, start + Number(entry.size)).toString('utf8')

/**
 * win32 语境里是否还有不透明底色。
 *
 * macOS 分支里有一处 `setBackgroundColor(chromeFallbackFill())`（窗口被最小化
 * 时退回实色），与 Windows 完全无关，不该算失败 —— 所以只检查 win32 附近的。
 */
function win32OpaqueBackgroundLeft(text) {
  for (const m of text.matchAll(/setBackgroundColor\(chromeFallbackFill\(\)\)/gu)) {
    if (/win32/u.test(text.slice(Math.max(0, m.index - 300), m.index))) return true
  }
  return /process\.platform === "win32" && primary \? \{[\s\S]{0,220}?backgroundColor: chromeFallbackFill\(\)/u.test(text)
}

const checks = [
  [
    '主窗口分支有 backgroundMaterial',
    /process\.platform === "win32" && primary \? \{[\s\S]{0,400}?backgroundMaterial: "(?:acrylic|mica|tabbed|auto)"/u.test(main),
  ],
  [
    '主窗口分支 backgroundColor 已透明',
    /process\.platform === "win32" && primary \? \{[\s\S]{0,400}?backgroundColor: "#00000000"/u.test(main),
  ],
  ['没有引入 transparent: true（会让 DWM 材质失效）', !/primary \? \{[\s\S]{0,400}?transparent: true/u.test(main)],
  ['标题栏 overlay 已透明', /titleBarOverlay: \{\s*height: \d+,\s*color: "#00000000",/u.test(main)],
  ['win32 路径不再写不透明底色', !win32OpaqueBackgroundLeft(main)],
  ['win32 路径会补回 backgroundMaterial', (main.match(/setBackgroundMaterial\(/gu) ?? []).length >= 2],
]

let failed = 0
for (const [label, ok] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`)
}

// 顺带确认 asar 结构完好：条目大小与头部一致。
// 注意必须比字节数：main.js 里有中文注释，字符数不等于字节数。
const mainBytes = Buffer.byteLength(main, 'utf8')
const okSize = Number(entry.size) === mainBytes
console.log(`${okSize ? 'OK  ' : 'FAIL'} main.js 大小与头部记录一致（${entry.size} vs ${mainBytes}）`)
if (!okSize) failed += 1

// 再确认归档没有在重写时错位：抽查另一个条目能否正确读出。
try {
  const pkgEntry = header.files['package.json']
  if (pkgEntry !== undefined && pkgEntry.files === undefined) {
    const pkgStart = dataStart + Number(pkgEntry.offset)
    const pkgText = buffer.subarray(pkgStart, pkgStart + Number(pkgEntry.size)).toString('utf8')
    const ok = JSON.parse(pkgText) !== null
    console.log(`${ok ? 'OK  ' : 'FAIL'} 其他条目偏移未错位（package.json 可解析）`)
    if (!ok) failed += 1
  }
} catch {
  console.log('FAIL 其他条目偏移未错位（package.json 读不出来）')
  failed += 1
}

// 最有力的结构校验：所有条目的 [offset, offset+size) 必须首尾相接、无重叠，
// 且正好铺满数据区。补丁在改写时会平移 offset，一旦平移错位（例如把 main.js
// 自己也平移了），这条就会立刻失败 —— 比抽查单个条目可靠。
try {
  const ranges = []
  const collect = (node) => {
    if (node.files !== undefined) {
      for (const key of Object.keys(node.files)) collect(node.files[key])
      return
    }
    if (node.unpacked) return
    if (node.offset === undefined) return
    ranges.push([Number(node.offset), Number(node.offset) + Number(node.size)])
  }
  collect(header)
  ranges.sort((a, b) => a[0] - b[0])
  let cursor = 0
  let overlap = false
  for (const [start, end] of ranges) {
    if (start !== cursor) { overlap = true; break }
    cursor = end
  }
  const archiveDataSize = buffer.length - dataStart
  const ok = !overlap && cursor === archiveDataSize
  console.log(`${ok ? 'OK  ' : 'FAIL'} 归档条目布局连续无重叠（${ranges.length} 个条目，数据区 ${archiveDataSize} 字节）`)
  if (!ok) failed += 1
} catch (error) {
  console.log(`FAIL 归档条目布局检查出错：${error.message}`)
  failed += 1
}

console.log('')
console.log(failed === 0 ? '补丁已就位，可以重启验证' : `有 ${failed} 项不符合，别重启`)
process.exit(failed === 0 ? 0 : 1)
