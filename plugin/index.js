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
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'acrylic'

/** 路由：页面用同源 fetch 取壁纸。 */
const ROUTE = '/dsh-acrylic-light/wallpaper'

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
    })
  } catch (error) {
    // 拿不到 webServer（非 web profile）时静默跳过：
    // 页面侧会用 CSS 渐变兜底，不会黑屏。
    console.warn('[dsh-acrylic-light] 壁纸路由未注册：', error?.message ?? error)
  }
}
