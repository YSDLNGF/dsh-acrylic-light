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
import { execFileSync } from 'node:child_process'
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

export async function apply(ctx) {
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
