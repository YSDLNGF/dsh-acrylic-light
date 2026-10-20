/**
 * dsh-acrylic-light 的宿主半部。
 *
 * 结论（已实测，见 README「已知限制」）：
 *   窗口材质 backgroundMaterial 只能在 BrowserWindow **构造时**设置。
 *   插件的宿主侧跑在独立的 Node 进程里，require('electron') 直接报
 *   Cannot find module 'electron' —— 拿不到 BrowserWindow，
 *   因此**插件无法在运行时给窗口设置亚克力材质**。
 *
 *   Electron 30+ 虽有 win.setBackgroundMaterial() 这个运行时 API，
 *   但它同样需要窗口对象；宿主进程没有它，这条路不通。
 *
 * 所以本插件分成两半：
 *   · 页面样式  —— 随插件安装，见 client.js
 *   · 窗口材质  —— 需要用户按 README「第 2 步」运行补丁脚本（改 app.asar）
 *
 * 宿主侧因此不做任何事。首次安装的说明由 client.js 里的一次性公告告知用户。
 */
export const name = 'acrylic'

export async function apply() {
  // 无宿主侧工作：窗口材质必须在主进程侧解决，插件够不到。
}
