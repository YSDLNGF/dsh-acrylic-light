/**
 * build-release.mjs —— 生成「补丁包」zip（发给普通用户用的那个）
 *
 * 为什么单独做成 zip：
 *   补丁要写到 DSH 安装目录的 app.asar 里，普通用户既不该、也不需要
 *   去 git clone 整个仓库。他们只需要：下载 zip → 解压 → 双击 .cmd。
 *   所以发布物是一个自包含的压缩包，里面有 .cmd 入口 + PowerShell 主体
 *   + patch/verify 两个 mjs + 还原脚本 + 诊断 + 说明。
 *
 * 为什么要脚本生成、而不是手动压缩：
 *   · 仓库里改完文件忘了重新打包，是最容易发生的发布事故
 *     （用户下到的 zip 里是旧脚本）。这个脚本保证 zip 与仓库同源。
 *   · zip 里的文件清单是**白名单**，避免把 backups/、.log、私钥之类打进去。
 *
 * 用法：
 *   node build-release.mjs                # 打包到 releases/dsh-acrylic-light-patch.zip
 *   node build-release.mjs --out <path>   # 指定输出
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDeflateRaw } from 'node:zlib'
import { pipeline } from 'node:stream/promises'

const HERE = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const out = { out: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') out.out = argv[++i]
    else throw new Error(`未知参数: ${argv[i]}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))

/**
 * 打包清单（白名单）。
 *
 * ⚠ 每一项都必须真实存在，缺一个就直接失败 —— 宁可打包报错，
 *   也不要发布一个"少了 restore-asar.ps1"的半成品 zip：
 *   用户在补丁打坏之后正是靠它救回来。
 *
 * 格式：[仓库内路径, zip 内路径(可选)]
 * 说明文档改稿之前一直在 releases/ 下维护，所以从这里取、但仍以根层级放进 zip，
 * 用户解压后看到的是一层文件，而不是一层套一层的目录。
 */
const FILES = [
  ['enable-transparency.cmd'],
  ['apply-when-closed.ps1'],
  ['patch-asar.mjs'],
  ['verify-asar.mjs'],
  ['restore-asar.ps1'],
  ['diagnose.cmd'],
  ['diagnose.ps1'],
  ['releases/README-补丁使用说明.md'],
  ['releases/安装说明.txt'],
].map(([src, name]) => ({ src, name: name ?? src.split('/').pop() }))

const missing = FILES.filter(item => !existsSync(join(HERE, item.src)))
if (missing.length > 0) {
  console.error(`[失败] 缺少这些文件，无法打包：\n  ${missing.map(i => i.src).join('\n  ')}`)
  process.exit(1)
}
for (const item of FILES) {
  if (!statSync(join(HERE, item.src)).isFile()) {
    console.error(`[失败] ${item.src} 不是普通文件`)
    process.exit(1)
  }
}

// ---------- 最小 zip 写入器 ----------
// 不引第三方依赖（这个仓库刻意零依赖），直接按 ZIP 规范写。
// 只做「存储 + deflate」两种方式，文件名用 UTF-8 并置通用位标记，
// 否则 Windows 资源管理器解压中文名会变乱码。
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunks = []
let offset = 0

function dosTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f)
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  return { time, day }
}

const central = []

for (const item of FILES) {
  const raw = readFileSync(join(HERE, item.src))
  // 小文件直接 deflate；已经压过的不值得再压，但补丁包全是文本，统一压。
  const deflated = await new Promise((resolveBuffer, reject) => {
    const chunksOut = []
    const deflate = createDeflateRaw({ level: 9 })
    deflate.on('data', c => chunksOut.push(c))
    deflate.on('end', () => resolveBuffer(Buffer.concat(chunksOut)))
    deflate.on('error', reject)
    deflate.end(raw)
  })

  const useDeflate = deflated.length < raw.length
  const data = useDeflate ? deflated : raw
  const method = useDeflate ? 8 : 0
  const nameBytes = Buffer.from(item.name, 'utf8')
  const crc = crc32(raw)
  const { time, day } = dosTime(statSync(join(HERE, item.src)).mtime)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)          // 本地文件头签名
  local.writeUInt16LE(20, 4)                   // 解压所需版本 2.0
  local.writeUInt16LE(0x0800, 6)               // 通用位：文件名是 UTF-8
  local.writeUInt16LE(method, 8)
  local.writeUInt16LE(time, 10)
  local.writeUInt16LE(day, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)         // 压缩后大小
  local.writeUInt32LE(raw.length, 22)          // 原始大小
  local.writeUInt16LE(nameBytes.length, 26)
  local.writeUInt16LE(0, 28)                   // extra 长度

  chunks.push(local, nameBytes, data)

  const cd = Buffer.alloc(46)
  cd.writeUInt32LE(0x02014b50, 0)              // 中央目录头签名
  cd.writeUInt16LE(20, 4)                      // 创建版本
  cd.writeUInt16LE(20, 6)                      // 解压所需版本
  cd.writeUInt16LE(0x0800, 8)                  // UTF-8 标记
  cd.writeUInt16LE(method, 10)
  cd.writeUInt16LE(time, 12)
  cd.writeUInt16LE(day, 14)
  cd.writeUInt32LE(crc, 16)
  cd.writeUInt32LE(data.length, 20)
  cd.writeUInt32LE(raw.length, 24)
  cd.writeUInt16LE(nameBytes.length, 28)
  cd.writeUInt16LE(0, 30)                      // extra
  cd.writeUInt16LE(0, 32)                      // comment
  cd.writeUInt16LE(0, 34)                      // 磁盘号
  cd.writeUInt16LE(0, 36)                      // 内部属性
  cd.writeUInt32LE(0, 38)                      // 外部属性
  cd.writeUInt32LE(offset, 42)                 // 本地头偏移
  central.push({ header: cd, name: nameBytes })

  offset += local.length + nameBytes.length + data.length
  console.log(`  + ${item.name}  (${raw.length} -> ${data.length} 字节)`)
}

const centralStart = offset
for (const item of central) {
  chunks.push(item.header, item.name)
  offset += item.header.length + item.name.length
}
const centralSize = offset - centralStart

const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)              // 中央目录结束签名
end.writeUInt16LE(0, 4)                        // 磁盘号
end.writeUInt16LE(0, 6)                        // 中央目录起始磁盘
end.writeUInt16LE(central.length, 8)           // 本磁盘条目数
end.writeUInt16LE(central.length, 10)          // 总条目数
end.writeUInt32LE(centralSize, 12)
end.writeUInt32LE(centralStart, 16)
end.writeUInt16LE(0, 20)                       // 注释长度
chunks.push(end)

const outPath = resolve(args.out ?? join(HERE, 'releases', 'dsh-acrylic-light-patch.zip'))
mkdirSync(dirname(outPath), { recursive: true })
await pipeline(
  async function* source() { for (const c of chunks) yield c },
  createWriteStream(outPath),
)

const size = statSync(outPath).size
console.log('')
console.log(`[完成] v${pkg.version}`)
console.log(`  ${outPath}`)
console.log(`  ${(size / 1024).toFixed(1)} KB，${FILES.length} 个文件`)
console.log('')
console.log('发布时把这个 zip 挂到 GitHub Release 即可；用户解压后双击 enable-transparency.cmd。')
