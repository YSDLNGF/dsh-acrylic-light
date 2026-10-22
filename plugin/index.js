/**
 * dsh-acrylic-light 的宿主半部 —— 给页面提供桌面壁纸。
 *
 * 为什么需要宿主提供壁纸：
 *   页面里的 backdrop-filter 只能模糊「同一张画布里、位于它背后的像素」。
 *   窗口背后的真实桌面不在 Chromium 的画布里，所以 CSS 永远采不到它。
 *   解法是：把壁纸**作为一张图铺进页面最底层**，
 *   这样它就成了画布内的像素，玻璃才有东西可糊。
 *   这条路线**不需要改 app.asar**，也不需要窗口透明。
 *
 * 为什么用 HTTP 路由而不是全局变量：
 *   插件宿主跑在独立的 Node 进程里，和页面的渲染进程不共享内存。
 *   dshmarket 等插件就是通过 host.webServer.register() 把数据给页面的，
 *   这里沿用同一套机制。
 *
 * 壁纸来源：Windows 固定的当前壁纸缓存
 *   %APPDATA%\Microsoft\Windows\Themes\TranscodedWallpaper
 *   路径不变、换壁纸时内容自动更新。注册表里的 Wallpaper 值在
 *   Wallpaper Engine 等工具下会指向过期文件，所以只作兜底。
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'acrylic'

/** 路由：页面用同源 fetch 取壁纸。 */
const ROUTE = '/dsh-acrylic-light/wallpaper'

/**
 * 路由：页面读写「已读公告版本」。
 *
 * 为什么必须有宿主侧存储（而不是只用 localStorage）：
 *   DSH Desktop 每次启动都用随机端口（`--port 0`），页面的 origin 随之改变，
 *   而 localStorage 是**按 origin 隔离**的 —— 重启后 origin 一变，
 *   之前写入的标记就读不到了。所以「点过知道了、重启不再弹」这件事
 *   必须存在不随端口变化的宿主文件里，localStorage 只能当缓存。
 *
 * ⚠ 为什么状态文件放在**插件自己的目录**里，而不是用户主目录：
 *   用户的口径是「重装或首次安装就弹，不卸载重装则不弹」。
 *   如果把状态写到 `~/.dsh-acrylic-light/config.json` 这种**用户级目录**，
 *   卸载插件时那个目录不会被删（它不是插件的一部分），于是重装后
 *   读到「已读」，公告还是不出来 —— 这正是第一版踩的坑。
 *
 *   放进插件包目录后：
 *     · 卸载 → 目录被整个删掉 → 状态自然清空；
 *     · 重装 → 状态文件不存在 → 公告重新出现；
 *     · 不卸载只重启 → 文件还在 → 不再弹。
 *   三种行为与用户描述完全一致。
 *
 *   代价：插件升级（重新 pnpm add）同样会重置，用户会再看到一次公告。
 *   对本插件可接受 —— 公告本身就是安装指引，升级后重申一次也无害。
 *
 * 为什么整段包在 try/catch 里：
 *   设置读写只是公告的附属能力。任何一步失败（目录不可写、JSON 损坏、
 *   路由重复注册）都只应让公告退化为「每次加载都提示」，**绝不能**
 *   影响壁纸路由、插件加载或页面渲染 —— 之前一次崩溃就是附属逻辑
 *   顺着加载链把整页带崩。
 */
const NOTICE_ROUTE = '/dsh-acrylic-light/notice'

/**
 * 状态文件路径：插件包目录下的 `.notice-state.json`。
 *
 * `import.meta.url` 指向本文件（.../dsh-acrylic-light/plugin/index.js），
 * 上跳两级就是包根目录。用 ESM 的 import.meta 而不是 process.cwd()：
 * 宿主的 cwd 是 DSH 的安装目录，不是插件目录。
 *
 * 文件名以点开头，且不在 package.json 的 `files` 白名单里，
 * 所以既不会被 git 跟踪，也不会随 npm 包分发。
 */
function configPath() {
  const override = process.env.DSH_ACRYLIC_DATA_DIR
  if (override && override.trim()) return join(resolve(override.trim()), 'config.json')
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return join(dirname(here), '.notice-state.json')
  } catch {
    // 极端情况下拿不到模块路径：退回用户目录，功能不中断
    return join(homedir(), '.dsh-acrylic-light', 'config.json')
  }
}

/** 读配置；任何异常都回空对象，调用方不必 try/catch。 */
function readConfig() {
  try {
    const raw = readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 原子写：先写 .tmp 再 rename，崩溃不会留下半份文件。 */
function writeConfig(config) {
  const file = configPath()
  const tmp = `${file}.tmp${process.pid}`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(tmp, JSON.stringify(config), 'utf8')
  renameSync(tmp, file)
}

/** 缓存：壁纸约 1MB，没必要每个请求都重读。 */
let cache = { mtime: 0, bytes: null, mime: 'image/jpeg' }

function wallpaperPaths() {
  const out = []
  const appData = process.env.APPDATA
  if (appData) {
    // Windows 的当前壁纸缓存，路径固定
    out.push(join(appData, 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper'))
  }
  // 注册表兜底（可能被壁纸工具改写，所以排在后面）
  try {
    const text = execFileSync('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'Wallpaper'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    })
    const m = text.match(/Wallpaper\s+REG_SZ\s+(.+)/)
    if (m) out.push(m[1].trim())
  } catch {
    // 读不到注册表就只用 TranscodedWallpaper
  }
  return out
}

function detectMime(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42) return 'image/webp'
  return 'application/octet-stream'
}

/** 读壁纸字节；带 mtime 缓存，换壁纸后自动失效。 */
function readWallpaper() {
  for (const path of wallpaperPaths()) {
    try {
      if (!existsSync(path)) continue
      const st = statSync(path)
      // 正常壁纸 ~1MB；超过 12MB 视为异常，不塞进页面
      if (!st.isFile() || st.size === 0 || st.size > 12 * 1024 * 1024) continue

      if (cache.bytes !== null && cache.mtime === st.mtimeMs) {
        return cache
      }

      const bytes = readFileSync(path)
      const mime = detectMime(bytes)
      if (mime === 'application/octet-stream') continue

      cache = { mtime: st.mtimeMs, bytes, mime }
      return cache
    } catch {
      // 换下一个候选
    }
  }
  return null
}

/**
 * 安装瞬间的原生提示框（宿主侧）。
 *
 * 为什么这里能"安装后立即弹"，而 client.js 里的公告不能：
 *   插件被市场安装时，宿主侧会被**热挂载并立即执行**（市场日志里的
 *   `exit=0 hot=true` 就是这个意思），不需要重启 DSH。而前端代码
 *   （client.js）必须等页面重新加载才执行 —— 那已经是重启之后了。
 *   所以"装上就能看到"的提示只能从这里发。
 *
 * 为什么用 Windows 消息框而不是别的：
 *   - 宿主跑在独立 Node 进程里，没有 DOM，弹不出网页风格的浮层；
 *   - MessageBox 由 Win32 直接绘制，不依赖 DSH 页面是否已刷新；
 *   - 走 PowerShell 的 PresentationFramework 是最稳的方式（系统自带的 .NET），
 *     不引入任何依赖，也不会因为缺模块而失败。
 *
 * 安全约束（这是硬要求，之前崩过一次）：
 *   1. **异步、非阻塞**：用 spawn 而不是 execFileSync，宿主进程不会卡住；
 *   2. **detached + unref**：对话框独立于插件生命周期，插件卸载也不影响它；
 *   3. **整体 try/catch**：弹窗失败只写一行日志，绝不影响壁纸路由与插件加载；
 *   4. **一次安装只弹一次**：用包根的状态文件去重，卸载即清除。
 */
function showInstallDialog() {
  try {
    const state = readConfig()
    if (state.dialogShown === true) return
  } catch {
    // 读不到就当作没弹过
  }

  const repo = 'https://github.com/YSDLNGF/dsh-acrylic-light'
  /* 文案只改文字，弹窗机制（写文件 + spawn + 去重）一律不动。
     措辞沿用页内公告那一版：先说"样式已生效"，再让用户按现象自行判断，
     不假设他还没装补丁。 */
  const lines = [
    '插件已安装完成，界面样式即刻生效。',
    '',
    '关于"窗口透出桌面壁纸"，请按下面两点自行判断：',
    '',
    '  · 如果窗口已经是磨砂玻璃（能透出桌面壁纸）',
    '    说明补丁早就装好了，直接忽略本提示即可。',
    '',
    '  · 如果窗口还是不透明的',
    '    需要先装一个补丁，步骤如下：',
    '',
    '    1. 从下面的地址下载补丁包',
    '    2. 完全退出 DeepSeek Harness（托盘右键 → 退出）',
    '    3. 双击补丁包里的 enable-transparency.cmd',
    '',
    '  补丁会等你退出后自动打补丁、校验并重新启动。',
    '',
    repo,
  ].join('\n')

  /* 把文案写到临时文件再让 PowerShell 读，而不是拼进 -Command 字符串。
     理由：PowerShell 的单引号、反引号、换行、中文编码各有各的转义规则，
     拼字符串时任何一处写错都会让脚本报错或显示乱码。
     写文件后脚本里只剩一个路径，几乎不可能出错。
     文件用 UTF-8 带 BOM：PowerShell 5.1 靠 BOM 才能正确识别中文。 */
  let msgFile
  try {
    msgFile = join(dirname(configPath()), '.install-dialog.txt')
    writeFileSync(msgFile, '\uFEFF' + lines, 'utf8')
  } catch {
    // 写不出文件就不弹了，绝不冒险
    return
  }

  const escaped = String(msgFile).replace(/'/g, "''")
  const script = [
    'Add-Type -AssemblyName PresentationFramework',
    `$t = Get-Content -LiteralPath '${escaped}' -Raw -Encoding UTF8`,
    "[System.Windows.MessageBox]::Show($t,'dsh-acrylic-light','OK','Information') | Out-Null",
  ].join('; ')

  try {
    const child = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script],
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
    child.unref()
  } catch (error) {
    // 弹窗失败就退化为"只写日志"，不影响任何功能
    try {
      console.warn('[dsh-acrylic-light] 安装提示框未能显示：', error?.message ?? error)
    } catch { /* ignore */ }
    return
  }

  // 记下"已弹过"，避免热挂载重复执行时反复弹窗
  try {
    const state = readConfig()
    state.dialogShown = true
    writeConfig(state)
  } catch {
    // 写不进去就下次再弹，无害
  }
}

export async function apply(ctx) {
  /* 安装后立即弹的提示框。
     放在 apply 最外层、独立于 webServer 注入 —— 即使这个 profile 没有
     webServer（非 web 环境），提示也该出现。

     ⚠ 这里**同步调用**，不套 setTimeout。
       实测：在这个宿主环境里，apply 返回后安排的长延时定时器不一定能跑
       到（进程生命周期不由插件掌握），延时方案会让提示永远不出现。
       而 showInstallDialog 自身是「写文件 + spawn(detached) + unref」，
       全是毫秒级操作，同步调用不会卡住宿主。 */
  try {
    showInstallDialog()
  } catch {
    // showInstallDialog 内部已有兜底；这里再兜一层，确保 apply 继续往下走
  }

  try {
    ctx.inject(['webServer'], (hostCtx) => {
      const dispose = hostCtx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: (request, response) => {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { allow: 'GET, HEAD' })
            response.end()
            return
          }

          const found = readWallpaper()
          if (found === null) {
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            response.end('wallpaper not found')
            return
          }

          response.writeHead(200, {
            'content-type': found.mime,
            'content-length': String(found.bytes.length),
            // 壁纸会变（用户换壁纸），不让浏览器长缓存
            'cache-control': 'no-cache',
          })
          if (request.method === 'HEAD') {
            response.end()
            return
          }
          response.end(found.bytes)
        },
      })

      // 插件卸载时注销路由
      ctx.on?.('dispose', () => {
        try {
          dispose?.()
        } catch {
          // 已注销
        }
      })

      /* ── 公告已读状态路由 ──────────────────────────────────────────
         独立 try/catch：注册失败只会让公告退化为「每次提示」，
         壁纸路由与插件加载不受任何影响。 */
      try {
        const disposeNotice = hostCtx.webServer.register({
          kind: 'exact',
          path: NOTICE_ROUTE,
          handler: (request, response) => {
            const send = (status, body) => {
              const text = JSON.stringify(body)
              response.writeHead(status, {
                'content-type': 'application/json; charset=utf-8',
                'content-length': String(Buffer.byteLength(text)),
                // 状态会变（用户点知道了），不许缓存
                'cache-control': 'no-store',
              })
              response.end(text)
            }

            try {
              if (request.method === 'GET' || request.method === 'HEAD') {
                const config = readConfig()
                send(200, {
                  // 已经点过「知道了」的最高公告版本；空串表示从未点过
                  seen: typeof config.noticeSeen === 'string' ? config.noticeSeen : '',
                })
                return
              }

              if (request.method === 'POST') {
                let raw = ''
                request.on('data', (chunk) => {
                  // 防御：公告只会回一个很小的字符串，超过 1MB 一定是异常请求
                  if (raw.length > 1024 * 1024) return
                  raw += chunk
                })
                request.on('end', () => {
                  try {
                    const parsed = JSON.parse(raw || '{}')
                    const seen = typeof parsed.seen === 'string' ? parsed.seen.slice(0, 64) : ''
                    const config = readConfig()
                    config.noticeSeen = seen
                    writeConfig(config)
                    send(200, { ok: true, seen })
                  } catch (error) {
                    // 写失败不影响用户：下一次加载会再提示一次
                    send(500, { ok: false, error: String(error?.message ?? error) })
                  }
                })
                request.on('error', () => {
                  try { send(400, { ok: false }) } catch { /* 已断开 */ }
                })
                return
              }

              send(405, { ok: false, error: 'method not allowed' })
            } catch (error) {
              // handler 内任何异常都不能冒泡出去
              try {
                response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
                response.end('notice route error')
              } catch { /* 响应已关闭 */ }
            }
          },
        })

        ctx.on?.('dispose', () => {
          try {
            disposeNotice?.()
          } catch {
            // 已注销
          }
        })
      } catch (error) {
        // 公告状态路由不可用：页面侧回退到 localStorage，功能降级但不报错
        console.warn('[dsh-acrylic-light] 公告状态路由未注册：', error?.message ?? error)
      }
    })
  } catch (error) {
    // 拿不到 webServer（非 web profile）时静默跳过：
    // 页面侧会用 CSS 渐变兜底，不会黑屏。
    console.warn('[dsh-acrylic-light] 壁纸路由未注册：', error?.message ?? error)
  }
}
