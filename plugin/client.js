/**
 * dsh-acrylic-light —— 浏览器半部。
 *
 * 设计原则（这是和之前几版最不一样的地方）
 * ----------------------------------------
 * 1. **模糊由系统材质负责，不由 CSS 负责。**
 *    桌面壁纸在窗口「背后」，页面里的 backdrop-filter 只能模糊页面内它背后的东西，
 *    碰不到壁纸。所以真正让壁纸变模糊的是 Windows 的 Acrylic 材质
 *    （由 app.asar 补丁在主进程打开）。CSS 这边只需要**足够透**，让材质透上来。
 *
 * 2. **不要再叠不透明层。**
 *    之前效果不好的主因是：.frame(侧栏色) → .centerCol(bg-base) → ConversationRoot.root
 *    每层 alpha 0.7 叠完接近 100%，看起来就是实心板。
 *    现在把「容器层」全部清成透明，只在**最上层三列**各铺一次低 alpha。
 *
 * 3. **标题栏单独处理。**
 *    Windows 分支的 .frame 和 .frame::before（拖动区那 40px）都被涂了侧栏色，
 *    不处理就会出现「上面一条实心、下面透」。
 *
 * 4. 所有参数走 CSS 变量，设置页拖滑块即时生效，不需要重启。
 */

const NS = 'dsh-acrylic-light'
const LOCAL_KEY = 'dsh-acrylic-light:prefs'
/** 首次使用公告的「已读」标记，只存一次，之后不再打扰。 */
const NOTICE_KEY = 'dsh-acrylic-light:first-run-notice'

/** 默认值：全透明，和顶栏完全一致（纯亚克力）。 */
const DEFAULTS = {
  enabled: true,
  // 面板额外底色（%）。0 = 完全透明，和顶栏一样是纯亚克力。
  // 大于 0 会给面板蒙一层深色 —— 注意半透明会叠出灰，
  // 所以默认 0，只有在文字压在浅色壁纸上读不清时才往上加一点。
  alpha: 0,
  // 噪点强度（%）。亚克力有细微颗粒感，纯色平板没有，加一点点能显著"像"。
  noise: 3.2,
}

const DICTIONARIES = {
  zh: {
    nav: '透明亚克力',
    title: '透明亚克力',
    intro: '窗口透出桌面壁纸，由 Windows Acrylic 材质提供模糊。下列参数实时生效。',
    enable: '启用',
    enableHint: '关闭后恢复 DSH 原生外观（窗口材质仍在，只是页面不再透明）。',
    alpha: '面板不透明度',
    alphaHint: '越低越透。建议 18–32：再低文字会开始发虚，再高就接近实心。',
    noise: '颗粒感',
    noiseHint: '亚克力的细微噪点，让表面不像一块塑料。0 关闭。',
    reset: '恢复默认',
    noticeTitle: '首次使用必读',
    noticeBody:
      '这个插件分成两部分：页面样式由插件市场负责，但“窗口透出桌面壁纸”需要替换一个窗口材质补丁。'
      + '补丁没法随插件一起安装，请到 GitHub 仓库下载并运行（README 的“第 2 步”有具体说明）：',
    noticeLink: 'github.com/YSDLNGF/dsh-acrylic-light',
    noticeFoot:
      '不装补丁也能用，只是窗口不会真的透明，主面板会显示为深色。此提示只出现一次。',
    noticeOk: '知道了',
  },
  en: {
    nav: 'Transparent acrylic',
    title: 'Transparent acrylic',
    intro: 'The window shows the desktop wallpaper; Windows Acrylic supplies the blur. Changes apply live.',
    enable: 'Enable',
    enableHint: 'Off restores the stock DSH look (the window material stays).',
    alpha: 'Panel opacity',
    alphaHint: 'Lower is more transparent. 18–32 works best.',
    noise: 'Grain',
    noiseHint: 'Fine acrylic grain so the surface is not a flat plastic sheet. 0 disables.',
    reset: 'Reset',
    noticeTitle: 'Before you start',
    noticeBody:
      'This plugin comes in two parts. The page styling installs with the plugin, but showing the desktop '
      + 'wallpaper through the window requires a window-material patch. The patch cannot ship with the plugin — '
      + 'download and run it from the GitHub repo (see “Step 2” in the README):',
    noticeLink: 'github.com/YSDLNGF/dsh-acrylic-light',
    noticeFoot:
      'The plugin works without it, but the window will not be transparent — the main panel stays dark. '
      + 'This notice appears only once.',
    noticeOk: 'Got it',
  },
}

const CONTROL_STYLE = [
  '.acrylic-root{display:flex;flex-direction:column;gap:16px;padding:16px 20px 28px;max-width:560px}',
  '.acrylic-head{display:flex;flex-direction:column;gap:6px}',
  '.acrylic-title{font-size:15px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary)}',
  '.acrylic-intro{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.acrylic-card{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
  '.acrylic-row{display:flex;align-items:center;justify-content:space-between;gap:16px}',
  '.acrylic-label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
  '.acrylic-value{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
  '.acrylic-slider{width:100%;height:20px;margin:0;appearance:none;background:transparent;cursor:pointer}',
  '.acrylic-slider::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2))}',
  '.acrylic-slider::-webkit-slider-thumb{appearance:none;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:var(--dsw-alias-label-primary)}',
  '.acrylic-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.acrylic-switch{display:inline-flex;align-items:center;gap:8px;padding:5px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
  '.acrylic-switch[aria-checked=true]{border-color:var(--dsw-alias-brand-primary)}',
  '.acrylic-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
  '.acrylic-switch[aria-checked=true] .acrylic-dot{background:var(--dsw-alias-brand-primary)}',
  '.acrylic-actions{display:flex;flex-wrap:wrap;gap:8px}',
  '.acrylic-button{padding:6px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
  '.acrylic-button:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.acrylic-note{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary)}',

  /* ── 首次使用公告：浮在页面右下角，只出现一次 ───────────────── */
  '.acrylic-notice{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:min(400px,calc(100vw - 40px));'
    + 'box-sizing:border-box;padding:16px 18px;border-radius:14px;'
    + 'border:.5px solid var(--dsw-alias-border-l2, rgb(255 255 255 / 18%));'
    + 'background:var(--acrylic-notice-bg, rgb(24 26 32 / 96%));color:#fff;'
    + 'box-shadow:0 18px 48px rgb(0 0 0 / 45%);'
    + 'backdrop-filter:blur(20px) saturate(140%);-webkit-backdrop-filter:blur(20px) saturate(140%);'
    + 'font-size:13px;line-height:1.65;animation:acrylic-notice-in .22s cubic-bezier(.22,1,.36,1)}',
  '@keyframes acrylic-notice-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
  '.acrylic-notice h3{margin:0 0 8px;font-size:14px;font-weight:600;line-height:1.4}',
  '.acrylic-notice p{margin:0 0 10px;color:rgb(255 255 255 / 82%)}',
  '.acrylic-notice code{display:block;margin:0 0 10px;padding:8px 10px;border-radius:8px;'
    + 'background:rgb(255 255 255 / 8%);color:#9ecbff;font-family:var(--ds-font-family-code,Consolas,monospace);'
    + 'font-size:12px;line-height:1.5;word-break:break-all;user-select:all}',
  '.acrylic-notice footer{color:rgb(255 255 255 / 52%);font-size:12px;line-height:1.6}',
  '.acrylic-notice button{margin-top:12px;width:100%;padding:8px 14px;border:0;border-radius:9px;'
    + 'background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;font:inherit;font-size:13px;'
    + 'font-weight:500;cursor:pointer}',
  '.acrylic-notice button:hover{filter:brightness(1.08)}',
  /* 浅色主题下换成白底，否则深底压在浅色页面上很突兀 */
  'body:not([data-ds-dark-theme]) .acrylic-notice{background:rgb(255 255 255 / 97%);color:#0f1115;'
    + 'border-color:rgba(15,17,21,.12)}',
  'body:not([data-ds-dark-theme]) .acrylic-notice p{color:rgba(15,17,21,.82)}',
  'body:not([data-ds-dark-theme]) .acrylic-notice code{background:rgba(15,17,21,.06);color:#0b62d6}',
  'body:not([data-ds-dark-theme]) .acrylic-notice footer{color:rgba(15,17,21,.55)}',
].join('')

/**
 * 玻璃层样式。
 *
 * 用 `[class*="_xxx"]` 后缀匹配：DSH 的 CSS Module 类名形如 `BynINW_centerCol`，
 * 哈希前缀随构建变化，但 `_centerCol` 这一段是稳定语义名。
 */
const GLASS_STYLE = [
  /* ── 根：全部清空，让窗口材质透上来 ─────────────────────────── */
  'html[data-dsh-acrylic-light],html[data-dsh-acrylic-light] body{background:transparent!important}',
  'html[data-dsh-acrylic-light] #root{background:transparent!important}',

  /* 深色/浅色两套基色：决定"透出来之后偏冷还是偏暖"。
     DSH 用 body[data-ds-dark-theme] 标深色；同时兼容 html 上带该属性的情况，
     两种都命中同一组值，避免主题切换时出现"透明但颜色错"的一帧。 */
  'html[data-dsh-acrylic-light]{--acrylic-surface:rgb(16 18 23);--acrylic-surface-2:rgb(20 22 28);--acrylic-ink:rgb(255 255 255)}',
  'html[data-dsh-acrylic-light]:has(body[data-ds-dark-theme]),html[data-dsh-acrylic-light][data-ds-dark-theme]{--acrylic-surface:rgb(14 16 20);--acrylic-surface-2:rgb(18 20 26);--acrylic-ink:rgb(255 255 255)}',
  'html[data-dsh-acrylic-light]:not(:has(body[data-ds-dark-theme])):not([data-ds-dark-theme]){--acrylic-surface:rgb(248 250 252);--acrylic-surface-2:rgb(255 255 255);--acrylic-ink:rgb(15 17 21)}',

  /* ══ 核心策略：整个窗口只留「一层」半透明 ═══════════════════════
     你的观察是对的：每一层都带一点半透明，叠几次就发灰。
     所以改成 —— 只有最外层那层铺色，其余层一律清成透明。

     ⚠ 关键教训（实测）：Electron 的 titleBarOverlay.color **支持 alpha**。
       把 --dsw-specific-sidebar-fill 设成不透明色 → 标题栏和侧栏一起纯黑；
       设成半透明 → 发灰。
       它被 DSH 的隐藏探针读取后传给 setTitleBarOverlay，
       所以这里必须给 transparent，标题栏才会是纯亚克力。 */
  'html[data-dsh-acrylic-light] [class*="_frame"]:has(> [class*="_sidebarCol"], > [class*="_centerCol"]){',
  '  background:transparent!important;',
  '  background-image:none!important;',
  '}',
  /* ::before 是标题栏那 40px 的拖动区，也清透明，让亚克力直接透上来。 */
  'html[data-dsh-acrylic-light] [class*="_frame"]:has(> [class*="_sidebarCol"], > [class*="_centerCol"])::before{',
  '  background:transparent!important;',
  '  background-image:none!important;',
  '}',

  /* 兜底：把 DSH 的底色 token 本身改成半透明。
     只改具体元素的 background 不够 —— 内部还有若干层直接用
     --dsw-alias-bg-base 铺底，叠起来又变实心。改 token 是从源头堵住。
     注意只动「页面底色/侧栏底色」，不碰浮层（菜单/对话框/代码块），
     否则设置面板会糊成一片。

     ⚠ 作用域必须是 body，不是 html：DSH 把 --dsw-alias-* 定义在 body 上，
     写在 html 上会被 body 自身的定义覆盖（实测 html 上读出来是空值）。 */
  /* ⚠ 同样要带 body[data-ds-dark-theme]：DSH 的深色块特异性更高，
     只写裸 body 会被压过。 */
  'html[data-dsh-acrylic-light] body,',
  'html[data-dsh-acrylic-light] body[data-ds-dark-theme]{',
  '  --dsw-alias-bg-base:transparent!important;',
  /* ⚠ --dsw-specific-sidebar-fill 必须是 transparent：
     它被两个地方消费 ——
       1. .frame::before（标题栏 40px 拖动区）
       2. DSH 的隐藏探针：preload 会读它的计算颜色，再调
          window.setTitleBarOverlay({color})。
     实测结论：titleBarOverlay 的颜色**支持 alpha**。
       不透明近黑 → 标题栏和侧栏一起纯黑
       半透明     → 发灰
       transparent → 纯亚克力（就是要这个）
     侧栏本身的配色已由下面的 _sidebarCol 规则接管，不依赖这个变量。 */
  '  --dsw-specific-sidebar-fill:transparent!important;',
  /* ⚠ 刻意不覆盖 --dsw-static-neutral-bluish-00/50：
     它们同时被 label-primary-foreground / switch-thumb / toast-label /
     input-major / code-block 等引用，改成深色会让开关滑块、输入框、
     代码块一起变暗（实测会明显发闷）。
     死白块改由「具体元素背景」那条规则处理，代价面小得多。 */
  '}',

  /* 表面类 token：分层处理。
     之前为了消灰，这里一律 transparent，结果把输入栏、悬停预览、
     菜单这些"要读字"的浮层也一起弄透了，内容糊在壁纸上没法看。

     现在分档，全部用 rgb() 实色百分比，**不混壁纸色**
     （混了就发灰，这是之前反复踩的坑）：
       浮层 bg-layer / menu / selector / tip → 14–22% 雾面
       聊天气泡、输入栏                    → 16–18%
       代码块                              → 55%（必须读字）
     主面板与问答正文仍由三列 alpha 控制，默认 0 = 通透。 */
  'html[data-dsh-acrylic-light] body,',
  'html[data-dsh-acrylic-light] body[data-ds-dark-theme]{',
  '  --dsw-alias-bg-layer-1:rgb(20 22 28 / 14%)!important;',
  '  --dsw-alias-bg-layer-2:rgb(20 22 28 / 16%)!important;',
  '  --dsw-alias-bg-layer-3:rgb(20 22 28 / 20%)!important;',
  '  --dsw-alias-bg-overlay:rgb(20 22 28 / 22%)!important;',
  '  --dsw-alias-bg-document-preview:rgb(20 22 28 / 16%)!important;',
  '  --dsw-alias-bg-module-platform:rgb(20 22 28 / 18%)!important;',
  '  --dsw-alias-bg-multi-select:rgb(20 22 28 / 18%)!important;',
  /* 这几个在深色主题里指向 bluish-850 (#2c2c2e，不透明中性灰)，
     实测主面板 22% 的灰像素就是它。改成 16–20% 雾面。 */
  '  --dsw-specific-bubble:rgb(20 22 28 / 16%)!important;',
  '  --dsw-specific-input-major:rgb(20 22 28 / 18%)!important;',
  '  --dsw-specific-menu:rgb(20 22 28 / 18%)!important;',
  '  --dsw-specific-tip:rgb(20 22 28 / 18%)!important;',
  '  --dsw-specific-selector:rgb(20 22 28 / 18%)!important;',
  '  --dsw-alias-markdown-placeholder:rgb(20 22 28 / 14%)!important;',
  '  --dsw-alias-markdown-tag:rgb(20 22 28 / 16%)!important;',
  '  --dsw-alias-tooltip-bg:rgb(20 22 28 / 18%)!important;',
  /* 代码块保持较浓，否则长段代码和正文糊在一起没法读 */
  '  --dsw-alias-markdown-code-block:rgb(20 22 28 / 55%)!important;',
  '  --dsw-alias-markdown-code-block-banner:rgb(20 22 28 / 62%)!important;',
  '}',

  /* ── 深色主题：文字必须提亮，否则在深色玻璃上发灰看不清 ─────────
     DSH 的 label-primary 链路是
       --dsw-alias-label-primary → --dsw-static-neutral-bluish-1000 → #0f1115（近黑）
     深色主题下这套「近黑文字」配「深色玻璃底」等于看不见。
     这里把 label 三档直接改成白/浅灰系，并保证层级仍然分明：
       primary 纯白、secondary 中灰、tertiary 更淡。
     只在深色主题下生效，浅色主题不受影响。 */
  /* 只改 label-* 这三档（正文/次要/辅助文字）。
     刻意**不动** --dsw-static-neutral-bluish-1000：它同时被
     brand-primary / brand-text 引用，改白会把品牌色也弄坏。 */
  'html[data-dsh-acrylic-light] body[data-ds-dark-theme]{',
  '  --dsw-alias-label-primary:rgb(255 255 255)!important;',
  '  --dsw-alias-label-secondary:rgb(240 243 247)!important;',
  '  --dsw-alias-label-tertiary:rgb(232 236 242)!important;',
  /* caption 是输入框下方小字、状态行、token 统计那一栏用的档位。
     实测 token 栏（._2WTFBq_trigger）直接引用 label-tertiary，
     深色下原本是 bluish-600(#81858c)，压在亚克力上明显发灰。 */
  '  --dsw-alias-label-caption:rgb(228 232 238)!important;',
  '  --dsw-alias-label-dimmed:rgb(214 219 226)!important;',
  '  --dsw-alias-label-document-preview:rgb(228 232 238)!important;',
  '}',
  /* 连带提亮底层静态色：上面几档都引用 bluish-200/300/400/600/700，
     直接在静态色这一层改，能一次覆盖所有引用者（包括写死用它们的组件）。
     ⚠ 不动 bluish-00/50/1000：它们被背景与品牌色共用。 */
  'html[data-dsh-acrylic-light] body[data-ds-dark-theme]{',
  '  --dsw-static-neutral-bluish-400:rgb(228 232 238)!important;',
  '  --dsw-static-neutral-bluish-300:rgb(236 240 245)!important;',
  '  --dsw-static-neutral-bluish-200:rgb(242 245 249)!important;',
  '  --dsw-static-neutral-bluish-600:rgb(228 232 238)!important;',
  '  --dsw-static-neutral-bluish-700:rgb(240 243 247)!important;',
  '}',

  /* ── 三列：唯一铺色的地方 ───────────────────────────────────
     alpha 默认 0 = 完全透明（纯亚克力）。
     想给问答正文加一点点底，把 alpha 调到 10–16 即可
     （实色百分比，不会像混壁纸色那样发灰）。 */
  'html[data-dsh-acrylic-light] [class*="_sidebarCol"]{',
  '  background:rgb(20 22 28 / 8%)!important;',
  '  border-right:.5px solid rgb(255 255 255 / 7%)!important;',
  '}',
  'html[data-dsh-acrylic-light] [class*="_centerCol"],',
  'html[data-dsh-acrylic-light] [class*="_rightbarCol"]{',
  '  background:rgb(16 18 23 / 10%)!important;',
  '}',
  'html[data-dsh-acrylic-light] [class*="_bottomRow"]{background:transparent!important}',

  /* 主面板内部的容器同样清透明（ConversationRoot / 聊天区）。
     ⚠ 只清背景色，不动布局：ConversationRoot 还负责 composerSeat 的
     底部渐变与 phase 状态，那些规则保持原样。 */
  'html[data-dsh-acrylic-light] [class*="Dc7zOa_root"]{background:transparent!important}',

  'html[data-dsh-acrylic-light] [class*="xz4KEq_root"],',
  'html[data-dsh-acrylic-light] [class*="xz4KEq_frame"],',
  'html[data-dsh-acrylic-light] [class*="xz4KEq_scroll"]{background:transparent!important}',

  /* ══ 浮层统一兜底：悬停预览 / tooltip / 气泡 ═══════════════════
     上面已通过 token 覆盖了浮层底色。但 DSH 有些浮层组件
     在 CSS 里**写死了颜色**（例如 .Xt1eiG_panel 用 var(--dsw-specific-menu)），
     只要 token 覆盖到就有效；若某处改用了别的类名与哈希，
     这里再兜一层：任何"悬浮在内容之上、需要读字"的面板，
     统一给雾面实色底，与输入栏同一档次。

     用 [role] 与常见浮层类名筛选，命中面广，
     不影响中层布局（那些没有 role 也不是菜单/浮层）。 */
  'html[data-dsh-acrylic-light] [role="tooltip"],',
  'html[data-dsh-acrylic-light] [role="menu"],',
  'html[data-dsh-acrylic-light] [role="listbox"],',
  'html[data-dsh-acrylic-light] [role="dialog"],',
  'html[data-dsh-acrylic-light] [role="popover"],',
  'html[data-dsh-acrylic-light] [data-radix-popper-content-wrapper] > *{',
  '  background-color:var(--acrylic-panel-float, rgb(20 22 28 / 18%))!important;',
  '  backdrop-filter:blur(12px) saturate(160%);',
  '  -webkit-backdrop-filter:blur(12px) saturate(160%);',
  '  border:.5px solid rgb(255 255 255 / 12%)!important;',
  '}',
  /* ══ 输入框：雾面实色（最终采用）═══════════════════════════════
     技术结论（实测得出，不是猜测）：
       1. 主面板的通透来自 Windows Acrylic —— DWM 系统材质，
          模糊的是**桌面壁纸**，CSS 无法调用；
       2. backdrop-filter 理论上能模糊窗口内部背后的内容（双层亚克力），
          但在本项目的透明窗口里实测采样不到：逐带测量边缘梯度，
          输入框区域与上方正文同样锐利（18–21），完全没有被糊开的迹象。
          伪元素、z-index、去 isolation、blur 加到 56px 都试过，无变化。
       3. 所以采用「高不透明度雾面」：它不模糊，但层次明确，
          且因为是实色（不掺壁纸色），不会发灰 —— 这是和低透明度方案的关键差别。

     78% 与设置面板同档：读字清晰，观感是磨砂面板。 */
  'html[data-dsh-acrylic-light] [data-composer-seat],',
  'html[data-dsh-acrylic-light] [class*="Dc7zOa_composerSeat"]{',
  '  background:transparent!important;',
  '}',
  /* active 态 DSH 会盖一条 linear-gradient，清掉避免深色带 */
  'html[data-dsh-acrylic-light] [data-phase="active"] [data-composer-seat],',
  'html[data-dsh-acrylic-light] [data-phase="active"] [class*="Dc7zOa_composerSeat"]{',
  '  background:transparent!important;',
  '}',
  'html[data-dsh-acrylic-light] [data-composer-card],',
  'html[data-dsh-acrylic-light] [class*="RlGAzG_card"]{',
  '  background:var(--acrylic-panel-solid, rgb(16 18 22 / 92%))!important;',
  '  border:.5px solid rgb(255 255 255 / 12%)!important;',
  '  box-shadow:0 8px 24px rgb(0 0 0 / 40%),inset 0 1px 0 rgb(255 255 255 / 6%)!important;',
  '}',
  'html[data-dsh-acrylic-light] body:not([data-ds-dark-theme]) [data-composer-card],',
  'html[data-dsh-acrylic-light] body:not([data-ds-dark-theme]) [class*="RlGAzG_card"]{',
  '  background:rgb(250 250 252 / 82%)!important;',
  '  border:.5px solid rgb(15 17 21 / 10%)!important;',
  '}',
  /* ── 内容区底部渐隐：去掉 ───────────────────────────────────
     这条是"模糊失败"时期的替代方案（用 mask 让文字淡出）。
     现在座位层的 backdrop-filter 能真正糊掉背后的字，
     两者叠加会让边缘出现"糊 + 淡"的双重衰减，反而不自然。
     ⚠ 也刻意不加 mask：mask 会创建 backdrop root，
     反而会破坏上面刚修好的模糊采样。 */
  /* ── 深色主题下的死白块 ─────────────────────────────────────
     深色主题里 --dsw-static-neutral-bluish-00 仍是 #fff，凡是直接用它
     铺底的容器在透明主题里就是一块死白。这里按元素精确处理，
     而不是改那个静态色（那会连累开关滑块/输入框/代码块）。 */
  'html[data-dsh-acrylic-light] body[data-ds-dark-theme] [class*="_scroll"],',
  'html[data-dsh-acrylic-light] body[data-ds-dark-theme] [class*="_viewport"],',
  'html[data-dsh-acrylic-light] body[data-ds-dark-theme] [class*="_paneBody"],',
  'html[data-dsh-acrylic-light] body[data-ds-dark-theme] [class*="_tabHostBody"]{',
  '  background:transparent!important;',
  '}',

  /* ── DSH 自带的底部深色渐隐带已由上面的 composerSeat 规则接管 ──
     原来那条 linear-gradient(180deg, transparent, bg-base 36px)
     会在透明主题里糊成一条黑带。
     现在 composerSeat 统一给「淡深底 + blur」，既盖掉黑带，
     又让滚到输入框附近的历史消息被模糊掉。
     ⚠ 不要再单独写 background:none —— 会因后定义把 blur 那条压掉。 */

  /* ── 侧栏会话列表底部的渐隐条 ───────────────────────────────
     DSH 的 ._9lTDKa_fade 是会话列表底部 24px 的遮罩：
       background: linear-gradient(to bottom, transparent, var(--dsw-specific-sidebar-fill))
       position: absolute; bottom: 0; height: 24px
     它的本意是让滚动内容"淡出"。但本主题把 --dsw-specific-sidebar-fill
     改成了半透明深色，这条渐变就变成压在账号区上方的黑色小渐变，很难看。
     macOS 版本来就是 display:none，这里对齐 macOS 的做法直接隐藏。

     ⚠ 不要写成通用的 [class*="_fade"]：聊天区的 _fadeTop/_fadeBottom
     是正常的滚动遮罩（用 mask-image 实现），不该被一起干掉。 */
  'html[data-dsh-acrylic-light] [class*="_9lTDKa_fade"]{display:none!important}',

  /* ══ 浮层（设置面板 / 二级菜单 / 对话框）统一磨砂 ══════════════
     实测 DSH 这两类浮层的结构（类名是构建期哈希，但后缀稳定）：

       设置面板  .wCInkW_overlay > .wCInkW_mask + .wCInkW_panel
         mask  : background:var(--dsw-alias-bg-mask-1); backdrop-filter:var(--dsw-mask-blur)
         panel : background:var(--dsw-alias-bg-layer-2);  ← 没有 backdrop-filter
       对话框    ._root_o6lrb_6 > ._mask_o6lrb_18 + ._dialog_o6lrb_33
         mask  : backdrop-filter:var(--dsw-mask-blur)
         dialog: background:var(--dsw-alias-bg-layer-2)   ← 没有 backdrop-filter

     两个关键事实：
       1. --dsw-mask-blur 默认就是 none，所以遮罩层等于没模糊；
       2. 面板自己完全没有 backdrop-filter，只是一块半透明色。
     这就是"设置面板看起来不糊"的全部原因。

     做法：给遮罩层和面板各自补上 blur，面板底色再压到半透明。 */

  'html[data-dsh-acrylic-light]{',
  '  --acrylic-overlay-blur:24px;',
  /* 面板底：深色偏冷、浅色偏白，都留一点透明度让壁纸的色温透进来 */
  '  --acrylic-overlay-panel-dark:rgb(26 28 34 / 78%);',
  '  --acrylic-overlay-panel-light:rgb(250 250 252 / 82%);',
  '}',

  /* 遮罩层：原来 --dsw-mask-blur 是 none，补上模糊 */
  'html[data-dsh-acrylic-light] body{--dsw-mask-blur:blur(12px)!important}',

  /* ── 设置面板 ─────────────────────────────────────────────── */
  'html[data-dsh-acrylic-light] [class*="wCInkW_panel"]{',
  '  background:var(--acrylic-overlay-panel-dark)!important;',
  '  backdrop-filter:blur(var(--acrylic-overlay-blur)) saturate(150%);',
  '  -webkit-backdrop-filter:blur(var(--acrylic-overlay-blur)) saturate(150%);',
  '}',
  'html[data-dsh-acrylic-light] body:not([data-ds-dark-theme]) [class*="wCInkW_panel"]{',
  '  background:var(--acrylic-overlay-panel-light)!important;',
  '}',

  /* ── 通用对话框（确认框、命令面板等）────────────────────────── */
  'html[data-dsh-acrylic-light] [class*="_dialog_o6lrb"]{',
  '  background:var(--acrylic-overlay-panel-dark)!important;',
  '  backdrop-filter:blur(var(--acrylic-overlay-blur)) saturate(150%);',
  '  -webkit-backdrop-filter:blur(var(--acrylic-overlay-blur)) saturate(150%);',
  '}',
  'html[data-dsh-acrylic-light] body:not([data-ds-dark-theme]) [class*="_dialog_o6lrb"]{',
  '  background:var(--acrylic-overlay-panel-light)!important;',
  '}',

  /* ── 菜单 / 下拉：它们本来就有 blur(40px)，这里统一强度并确保底色够实 ── */
  'html[data-dsh-acrylic-light] [class*="_material_ri079"]{',
  '  backdrop-filter:blur(var(--acrylic-overlay-blur)) saturate(150%)!important;',
  '  -webkit-backdrop-filter:blur(var(--acrylic-overlay-blur)) saturate(150%)!important;',
  '}',

  /* 兜底：任何 role=dialog / menu / listbox 的浮层都补上模糊，
     覆盖上面没枚举到的第三方浮层。 */
  'html[data-dsh-acrylic-light] [role="dialog"],',
  'html[data-dsh-acrylic-light] [role="menu"],',
  'html[data-dsh-acrylic-light] [role="listbox"]{',
  '  backdrop-filter:blur(var(--acrylic-overlay-blur)) saturate(150%);',
  '  -webkit-backdrop-filter:blur(var(--acrylic-overlay-blur)) saturate(150%);',
  '}',

  /* ── 颗粒感：亚克力的"薄"很大程度来自这点噪点 ─────────────── */
  'html[data-dsh-acrylic-light]::after{',
  '  content:"";position:fixed;inset:0;z-index:2147483646;pointer-events:none;',
  '  opacity:calc(var(--acrylic-noise) / 100);',
  '  background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'160\' height=\'160\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.85\' numOctaves=\'3\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\'/%3E%3C/svg%3E");',
  '  mix-blend-mode:overlay;',
  '}',
].join('')

window.__ModuleLoader__.load({
  id: 'dsh-acrylic-light',
  factory(require) {
    const React = require('react')
    // 公告要挂到 body 上（浮在所有面板之上），需要自己建根。
    // 官方 conversation 插件也 require('react-dom')，所以这个模块可用。
    const ReactDOM = require('react-dom')

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const root = document.documentElement

        const t = (key) => {
          try {
            return ctx.locale.bind(NS)(key)
          } catch {
            return DICTIONARIES.zh[key] ?? key
          }
        }

        try {
          ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-acrylic-light: dictionaries')
        } catch (error) {
          console.warn('[dsh-acrylic-light] 字典注册失败', error)
        }

        const injectTag = (text, attr) => {
          const tag = document.createElement('style')
          tag.setAttribute(attr, 'true')
          tag.textContent = text
          document.head.append(tag)
          return () => tag.remove()
        }

        const disposeControls = injectTag(CONTROL_STYLE, 'data-dsh-acrylic-light-controls')
        const disposeGlass = injectTag(GLASS_STYLE, 'data-dsh-acrylic-light-style')

        let current = { ...DEFAULTS }

        /** 把配置写进 CSS 变量；关闭时摘掉属性，界面立刻恢复原生。 */
        const paint = (state) => {
          current = { ...DEFAULTS, ...state }
          if (current.enabled === false) {
            root.removeAttribute('data-dsh-acrylic-light')
            return
          }
          root.setAttribute('data-dsh-acrylic-light', 'true')
          const set = (name, value) => root.style.setProperty(name, value)
          const alpha = Number(current.alpha)
          // alpha 现在控制「浮层与输入栏的雾面厚度」：
          // 主面板与顶栏保持纯亚克力不受影响（那是系统材质的事）。
          // 92 = 输入栏那档（默认）；调低会让浮层更透。
          const thick = Math.max(0, Math.min(100, alpha))
          set('--acrylic-alpha', `${thick}%`)
          set('--acrylic-noise', `${Number(current.noise)}`)
          // 浮层/输入栏底色跟随 alpha：同一基色、不同厚度
          set('--acrylic-panel-solid', `rgb(16 18 22 / ${thick}%)`)
          set('--acrylic-panel-float', `rgb(20 22 28 / ${Math.round(thick * 0.2)}%)`)
        }

        const readLocal = () => {
          try {
            const raw = window.localStorage?.getItem(LOCAL_KEY)
            if (raw === null || raw === undefined) return { ...DEFAULTS }
            const parsed = JSON.parse(raw)
            const next = { ...DEFAULTS }
            for (const key of Object.keys(DEFAULTS)) {
              if (parsed[key] !== undefined) next[key] = parsed[key]
            }
            return next
          } catch {
            return { ...DEFAULTS }
          }
        }

        const writeLocal = (value) => {
          try {
            window.localStorage?.setItem(LOCAL_KEY, JSON.stringify(value))
          } catch {
            // 存储不可用不影响渲染
          }
        }

        // 首帧就上色，避免"先闪一下原生底色"
        paint(readLocal())

        /* ── 首次使用公告（只出现一次）───────────────────────────────
           为什么要这个公告：
             插件被拆成两半 —— 页面样式（随插件安装）和窗口材质补丁（需改 app.asar）。
             后者无法随插件分发：Electron 的窗口材质只能在创建窗口时设置，
             而插件跑在独立 Node 进程里，拿不到 BrowserWindow
             （实测 require('electron') 报 Cannot find module）。
             所以第一次安装时必须让用户知道还要去 GitHub 取补丁，
             否则他们会看到「装好了但窗口是黑的」，以为插件坏了。

           只出现一次：读完写 localStorage 标记，之后不再打扰。
           localStorage 不可用时（隐私模式等）仍会显示 —— 宁可多提醒一次，
           也不要让用户错过这个关键信息。 */
        const noticeSeen = () => {
          try {
            return window.localStorage?.getItem(NOTICE_KEY) === 'seen'
          } catch {
            return false
          }
        }

        const markNoticeSeen = () => {
          try {
            window.localStorage?.setItem(NOTICE_KEY, 'seen')
          } catch {
            // 存不上就每次显示，不影响功能
          }
        }

        const Notice = () => {
          const [open, setOpen] = React.useState(() => !noticeSeen())

          if (!open) return null

          return React.createElement('aside', { className: 'acrylic-notice', role: 'status' },
            React.createElement('h3', null, t('noticeTitle')),
            React.createElement('p', null, t('noticeBody')),
            React.createElement('code', null, t('noticeLink')),
            React.createElement('footer', null, t('noticeFoot')),
            React.createElement('button', {
              type: 'button',
              onClick: () => {
                markNoticeSeen()
                setOpen(false)
              },
            }, t('noticeOk')))
        }

        /* 挂到 body 上：公告要浮在所有面板之上，放进设置页的 slot 会被裁掉。 */
        let noticeHost = null
        ctx.effect(() => {
          noticeHost = document.createElement('div')
          noticeHost.setAttribute('data-dsh-acrylic-light-notice', 'true')
          document.body.append(noticeHost)

          const reactRoot = ReactDOM.createRoot
            ? ReactDOM.createRoot(noticeHost)
            : null

          if (reactRoot !== null) {
            reactRoot.render(React.createElement(Notice))
          } else {
            // 没有 createRoot（React 17 及以前）时用旧 API
            ReactDOM.render(React.createElement(Notice), noticeHost)
          }

          return () => {
            try {
              if (reactRoot !== null) reactRoot.unmount()
              else ReactDOM.unmountComponentAtNode(noticeHost)
            } catch {
              // 卸载失败不影响
            }
            noticeHost?.remove()
            noticeHost = null
          }
        }, 'dsh-acrylic-light: first-run notice')

        ctx.effect(() => () => {
          disposeGlass()
          disposeControls()
          root.removeAttribute('data-dsh-acrylic-light')
          for (const name of ['--acrylic-alpha', '--acrylic-noise']) {
            root.style.removeProperty(name)
          }
        }, 'dsh-acrylic-light: paint')

        /** 设置页：所有滑块都是即时生效的，改完不用重启。 */
        const Section = () => {
          const [state, setState] = React.useState(readLocal())

          const update = (patch) => {
            setState((previous) => {
              const next = { ...previous, ...patch }
              writeLocal(next)
              paint(next)
              return next
            })
          }

          const enabled = state.enabled !== false

          const slider = (key, labelKey, hintKey, min, max, step, unit) =>
            React.createElement('div', { className: 'acrylic-card' },
              React.createElement('div', { className: 'acrylic-row' },
                React.createElement('span', { className: 'acrylic-label' }, t(labelKey)),
                React.createElement('span', { className: 'acrylic-value' }, `${state[key]}${unit}`)),
              React.createElement('input', {
                className: 'acrylic-slider',
                type: 'range',
                min,
                max,
                step,
                value: state[key],
                disabled: !enabled,
                'aria-label': t(labelKey),
                onChange: (event) => update({ [key]: Number(event.target.value) }),
              }),
              React.createElement('div', { className: 'acrylic-hint' }, t(hintKey)))

          return React.createElement('div', { className: 'acrylic-root' },
            React.createElement('div', { className: 'acrylic-head' },
              React.createElement('div', { className: 'acrylic-title' }, t('title')),
              React.createElement('div', { className: 'acrylic-intro' }, t('intro'))),

            React.createElement('div', { className: 'acrylic-card' },
              React.createElement('div', { className: 'acrylic-row' },
                React.createElement('span', { className: 'acrylic-label' }, t('enable')),
                React.createElement('button', {
                  type: 'button',
                  className: 'acrylic-switch',
                  role: 'switch',
                  'aria-checked': enabled,
                  onClick: () => update({ enabled: !enabled }),
                }, React.createElement('span', { className: 'acrylic-dot' }), enabled ? 'ON' : 'OFF')),
              React.createElement('div', { className: 'acrylic-hint' }, t('enableHint'))),

            slider('alpha', 'alpha', 'alphaHint', 0, 100, 1, '%'),
            slider('noise', 'noise', 'noiseHint', 0, 12, 0.2, '%'),

            React.createElement('div', { className: 'acrylic-actions' },
              React.createElement('button', {
                type: 'button',
                className: 'acrylic-button',
                onClick: () => update({ ...DEFAULTS }),
              }, t('reset'))))
        }

        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'acrylic',
          order: 60,
          locale: NS,
          inject: () => ({ t }),
        }, Section))

        /**
         * 运行时调参入口。
         *
         * 为什么需要它：窗口材质补丁要重启 DSH 才生效，而调 alpha/模糊这些参数
         * 如果每次都要重启，试错成本太高。挂一个全局对象，就能在 DevTools 控制台里
         * 一边拖一边看：
         *
         *   glass({ alpha: 20 })        只改不透明度
         *   glass({ blur: 6 })          加页面模糊
         *   glass()                     看当前值
         *   glass.reset()               回到默认
         *
         * 值会写进 localStorage，下次启动沿用，所以调满意了就不必再动。
         */
        const api = {
          get: () => ({ ...current }),
          set: (patch) => {
            const next = { ...current, ...patch }
            writeLocal(next)
            paint(next)
            return { ...next }
          },
          reset: () => {
            writeLocal({ ...DEFAULTS })
            paint({ ...DEFAULTS })
            return { ...DEFAULTS }
          },
          defaults: () => ({ ...DEFAULTS }),
        }
        try {
          window.glass = api
        } catch {
          // 某些环境下 window 不可写，忽略即可
        }
      },
    }
  },
})

