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

/**
 * 默认值。
 *
 * ⚠ 这里踩过两个坑，都记在这：
 *   坑一：`alpha` 默认 0，让 `--acrylic-panel-solid` 变成 `rgb(16 18 22 / 0%)`，
 *        输入栏整块透明。变量一旦有值，CSS 兜底值就永远不生效。
 *   坑二：改成"完全透明 + 只做模糊"，结果只剩一条白边 ——
 *        用户原话"只加了一个白边，里面还是透明的，不是模糊的"。
 *        原因：磨砂的实体感来自**白色薄雾**，不是来自模糊。
 *        模糊只能让背后的东西变糊，不会让表面变得"有材质"。
 *
 * 输入栏就是一层透出桌面的玻璃，不暴露可调参数 ——
 * 设置页只保留「启用」开关（frost/blur/saturate 已移除）。

 * 文字裁切：用 JS 把输入栏座从滚动容器里「抬」出来，文字就硬断在
 * 输入栏上沿（见 paint() 的 ensureLifted()，以及 GLASS_STYLE 里
 * 给 seat 的 absolute 定位规则）。蒙版方案已废弃（裁切线随文本滚、
 * 且会误削消息）。
 */
const DEFAULTS = {
  enabled: true,
  // 是否在页面底层铺桌面壁纸。
  // 默认关闭：用户选的是「窗口真透明透出真实桌面」，不是页面截图式假壁纸。
  // 关闭后窗口靠 backgroundMaterial:"acrylic" 透出桌面，瓦片上不叠任何图。
  // 想退回旧截图式外观，可在这里改回 true。
  wallpaper: false,
  // 壁纸预模糊半径（px）。仅当 wallpaper=true 时生效。
  wallpaperBlur: 40,
}

const DICTIONARIES = {
  zh: {
    nav: '透明亚克力',
    title: '透明亚克力',
    intro: '窗口透出桌面壁纸，由 Windows Acrylic 材质提供模糊。输入栏是一块毛玻璃。',
    enable: '启用',
    enableHint: '关闭后恢复 DSH 原生外观（窗口材质仍在，只是页面不再透明）。',
    reset: '恢复默认',
  },
  en: {
    nav: 'Transparent acrylic',
    title: 'Transparent acrylic',
    intro: 'The window shows the desktop wallpaper; Windows Acrylic supplies the blur. The composer is a pane of frosted glass.',
    enable: 'Enable',
    enableHint: 'Off restores the stock DSH look (the window material stays).',
    reset: 'Reset',
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
  '.acrylic-seg{display:flex;gap:8px}',
  '.acrylic-seg button{flex:1;padding:7px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
  '.acrylic-seg button[aria-selected=true]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary-soft,rgba(120,150,255,.14))}',
  '.acrylic-note{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary)}',
].join('')

/**
 * 玻璃层样式。
 *
 * 用 `[class*="_xxx"]` 后缀匹配：DSH 的 CSS Module 类名形如 `BynINW_centerCol`，
 * 哈希前缀随构建变化，但 `_centerCol` 这一段是稳定语义名。
 */
const GLASS_STYLE = [
  /* ══ 壁纸层：页面最底下的那张图 ═══════════════════════════════
     这是整套「真模糊」方案的地基。

     为什么必须把壁纸画进页面：
       backdrop-filter 只能采「同一张画布内、位于它背后的像素」。
       窗口背后的真实桌面不在 Chromium 画布里，所以永远采不到。
       把壁纸铺进页面后它就成了画布内像素，玻璃才有东西可糊。

     它和窗口是否透明无关：即使窗口不透明，这张图也照常显示、
     照常被上层玻璃模糊。所以这条路**不需要改 app.asar**。

     z-index:-3：在页面根之下、但在窗口背景之上。 */
  /* ⚠ 用 body::before + z-index:0，而不是 html::before + 负 z-index：
     负 z-index 会落到根背景之后，可能被整页绘制规则盖住（实测：属性加上了但看不见图）。
     改用 body::before 并与 #root 建立明确的层级关系，壁纸一定在内容之下。 */
  /* 兜底：壁纸取不到时用渐变，避免露出纯色或黑屏 */
  /* ── 根：全部清空，让窗口材质透上来 ───────────────────────────
     ⚠ 这一组必须保留：DSH 默认给整页铺 #0f1115（近黑），
       它压在窗口 Acrylic 材质之上，壁纸就透不出来。
       清成透明后，材质才是唯一的底色来源。 */
  'html[data-dsh-acrylic-light],html[data-dsh-acrylic-light] body{background:transparent!important}',
  /* body 建立层叠上下文，让 body::before 的 z-index:0 有确定的参照 */
  'html[data-dsh-acrylic-wallpaper] body{position:relative}',
  'html[data-dsh-acrylic-light] #root{background:transparent!important}',
  /* #root 必须抬到壁纸层（body::before, z-index:0）之上，否则页面内容会被壁纸盖住。
     用 position:relative + z-index:1 —— 注意不能只写 z-index，
     因为 static 定位下 z-index 无效。 */
  'html[data-dsh-acrylic-wallpaper] #root{position:relative;z-index:1}',

  /* .frame 是三列布局的外框；::before 是标题栏那 40px 拖动区。
     两者都是整块面积，必须一起清透明，否则会盖住窗口材质。
     ⚠ 这是我之前误删的规则 —— 成功那版有它。 */
  'html[data-dsh-acrylic-light] [class*="_frame"]:has(> [class*="_sidebarCol"], > [class*="_centerCol"]){',
  '  background:transparent!important;',
  '  background-image:none!important;',
  '}',
  'html[data-dsh-acrylic-light] [class*="_frame"]:has(> [class*="_sidebarCol"], > [class*="_centerCol"])::before{',
  '  background:transparent!important;',
  '  background-image:none!important;',
  '}',
  /* ── 根：全部清空，让窗口材质透上来 ─────────────────────────── */
  /* ⚠ 页面整体透明已撤掉：
     窗口没有亚克力材质时，页面透明 = 露出 Electron 黑底（实测「主面板纯黑」）。
     输入栏的透明是局部的（::after 用 backdrop-filter 糊页面内背后的内容），
     不依赖这里，所以撤掉之后输入栏效果不受影响。 */

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
  /* .frame 保持原生底色 —— 它透明会让整页失去底色（窗口没材质时就是黑的）。 */
  /* ::before 是标题栏那 40px 的拖动区 —— 保持原生，不做透明处理。 */

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
  /* 只让「整页底色令牌」透明，把画布让给窗口的 Acrylic 材质。
     这是壁纸能透出来的关键：DSH 深色主题默认 #0f1115 接近纯黑，
     它铺满整页压在材质之上，看起来就是黑的。
     ⚠ 只改这一个令牌，不动 html/body/#root/.frame ——
       改那些会让整页彻底失去底色（窗口无材质时直接露黑底）。 */
  '  --dsw-alias-bg-base:transparent!important;',
  /* ⚠ 这条必须是 transparent —— 它同时决定两处的颜色：
       1. 侧栏（_sidebarCol）底色
       2. 右上角三个窗口按钮所在的标题栏条
          （preload 读它的计算色 → setTitleBarOverlay({color})）
     设成原生深色会让这两处变成纯黑（已实测）。
     侧栏自身配色另有 _sidebarCol 规则接管，所以这里给透明不会丢层次。 */
  '  --dsw-specific-sidebar-fill:transparent!important;',
  /* --dsw-alias-bg-base 不再置透明：它是整页底色，透明后没有材质就是黑的。 */
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
  /* --dsw-specific-sidebar-fill 保持原生：
     它同时被 .frame::before（标题栏拖动区）和 DSH 的隐藏探针消费
     （preload 读它的计算色再调 setTitleBarOverlay）。
     原方案设成 transparent 是为了透出窗口亚克力；
     但窗口没有材质时，transparent 只会让标题栏变黑。
     侧栏配色仍由 _sidebarCol 规则接管，不依赖这个变量。 */
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
  /* ══ 文件预览卡：令牌层给实色（不透明）═════════════════════════════
     用户口径：对话末尾的文件预览框，悬停显示文件内容时背景是透明的，
     字号又小，压在壁纸上读不清；要求做成不透明、颜色跟随通用外观色。

     为什么只改令牌、不加 DOM 选择器：
       预览卡的容器与内容区都读 `--dsw-alias-bg-document-preview`
       以及 bg-layer 系列；透明是我们把这些令牌改淡造成的。
       令牌是官方 CSS 自己声明的位置，覆盖它不会碰任何 DOM 结构，
       也不会与第三方插件的类名哈希冲突 —— 比猜[class*=] 安全得多。
       （上一次崩溃就是往 DOM 上加硬选择器导致页面挂掉。）

     颜色用 `--acrylic-surface-2`：深色 rgb(18 20 26)、浅色 rgb(255 255 255)，
       与设置页外观一致，且**不带 alpha**，所以是不透明的。 */
  'html[data-dsh-acrylic-light] body,',
  'html[data-dsh-acrylic-light] body[data-ds-dark-theme]{',
  '  --dsw-alias-bg-document-preview:var(--acrylic-surface-2,rgb(18 20 26))!important;',
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

  /* ══ 文字不进输入栏：交给 DSH 原生布局 + 输入栏透明 ══════════
     输入的座位层（[data-composer-seat]）是单独的条，吸在容器底部，
     聊天内容在它上方的滚动区滚动，本来就不会跑进输入栏区域。
     输入栏透明后，用户透过它看到的就是面板/桌面。

     ⚠ 这里**不加** padding / margin / mask：
       padding 会顶得座位层离开底部（实测：输入栏上移），
       mask 要么跟着内容滚（基准是内容高度）、要么连座位层一起裁掉。
       保持 DSH 原生布局，输入栏才稳在底部。
       若文字仍与输入栏重叠，那说明滚动区高度覆盖了输入栏区域，
       需另找方式（见 paint() 里的处理）。 */
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
  /* 浮层要读字，所以给一层很淡的雾面底 —— 与输入栏不同：
     输入栏是"看着的"，浮层是"读的"。这里刻意保留一点填充，
     但只用 12% 的低浓度，不会像 92% 那样变成实心板。 */
  '  background-color:rgb(20 22 28 / 12%)!important;',
  /* ⚠ 浮层的模糊已关闭：用户要对比"面板模糊会不会影响输入栏"。
     关掉后浮层只留底色，输入栏的 ::after 模糊保持不动。 */
  '  backdrop-filter:none!important;',
  '  -webkit-backdrop-filter:none!important;',
  '  border:.5px solid rgb(var(--acrylic-edge) / 14%)!important;',
  '}',
  /* ══ 输入框：亚克力 ═══════════════════════════════════════════════
     目标（用户明确要求）：**和主面板一样透、不要发灰、整块卡片模糊**。

     之前的两个错，都值得记下来：

     错一：92% 实色 + 一句"backdrop-filter 实测无效"。
       那是测量前提错了 —— 底色已经 92% 不透明，背后的字只剩 8% 权重，
       糊不糊在像素上本来就没差别。**是不透明让模糊看不见。**

     错二：改成 46% 的深色染色（rgb(26 29 36 / 46%)）。
       深色叠在浅背景上**必然发灰** —— 这正是"看着不对"的来源。
       亚克力不靠染色做，靠「边缘 + 模糊」。

     所以现在：**不染色**。
       ① 背景完全透明，只让 backdrop-filter 的模糊结果透上来
          —— 主面板怎么透，这里就怎么透，两者观感一致；
       ② 靠 blur + saturate 制造材质，不靠颜色；
       ③ 靠 0.5px 发丝描边 + 上缘内高光交代"这是一块板"的边缘；
       ④ 靠投影把它从正文里抬起来。
     颜色只出现在边缘（描边/高光），永远不铺满整块 —— 这样不会发灰。 */
  'html[data-dsh-acrylic-light]{',
  /* 边缘色按主题分：深色下用白边，浅色下用深边。只有边缘用它。 */
  '  --acrylic-edge:255 255 255;',
  '  --acrylic-sheen:255 255 255;',
  '}',
  'html[data-dsh-acrylic-light]:not(:has(body[data-ds-dark-theme])):not([data-ds-dark-theme]){',
  '  --acrylic-edge:15 17 21;',
  '  --acrylic-sheen:255 255 255;',
  '}',

  /* 座位层必须完全透明：它铺满底部一整条，一旦有底色，
     亚克力就被垫在一层灰上面，看起来发闷。 */
  'html[data-dsh-acrylic-light] [data-composer-seat],',
  'html[data-dsh-acrylic-light] [class*="Dc7zOa_composerSeat"]{',
  '  background:transparent!important;',
  '  background-image:none!important;',
  '}',
  /* active 态 DSH 会盖一条 linear-gradient（文字渐隐用），
     在透明主题里它就是底部那条黑带，必须清掉。 */
  'html[data-dsh-acrylic-light] [data-phase="active"] [data-composer-seat],',
  'html[data-dsh-acrylic-light] [data-phase="active"] [class*="Dc7zOa_composerSeat"],',
  'html[data-dsh-acrylic-light] [data-content-phase="active"] [data-composer-seat]{',
  '  background:transparent!important;',
  '  background-image:none!important;',
  '}',

  /* ══ 文字硬裁在输入栏上沿：把输入栏座抬成滚动容器的兄弟 ═══
     做法：JS 把 seat 从 scrollBody 里 append 到 [data-conversation-content]
     （会话面板 body）。body 是 flex-direction:column，seat 自带 flex:none
     （DSH 原生高度），于是 flex 布局会**自动把 scrollBody 压缩到
     "输入栏上沿"** —— 滚动容器在 seat 顶部截止，聊天内容滚到底就
     硬断在输入栏上沿，不会钻进输入栏背后。这是真正的"硬裁"。

     ⚠ 不要给 seat 设 position:absolute —— 会把它移出 flex 流，
       scrollBody 就又填满到面板底部，裁切失效（实测"没有裁切"）。
     保持 seat 在流内作 flex 兄弟即可（DSH seat 自带 flex:none + sticky，
     作为列尾兄弟它就是原高度在底部）。 */
  /* ⚠ flex:none 只加在 **active** 阶段：
     hero（新会话）时 seat 仍在 scrollBody 内部、由官方
     .composerHero{align-self:center} 居中显示；若不分阶段一律 flex:none，
     会干扰它在居中容器里的表现。 */
  'html[data-dsh-acrylic-light] [data-phase="active"] [data-composer-seat],',
  'html[data-dsh-acrylic-light] [data-content-phase="active"] [data-composer-seat]{',
  '  flex:none!important;',
  '}',
  'html[data-dsh-acrylic-light] [data-conversation-content]{',
  '  position:relative!important;',
  '}',

  /* ══ 布局：一律不改 ═══════════════════════════════════════════
     这里曾经加过负 margin，想把聊天内容「拉到输入框背后」，
     好让 backdrop-filter 有东西可糊。结果是**输入栏边框被拖到了
     窗口底部** —— 因为负 margin 改的是容器自身的盒子，
     容器的边框跟着下缘一起移动。

     现在**完全不碰布局**：输入栏位置、滚动容器尺寸全部保持 DSH 原生。
     代价是输入框背后没有页面内内容可糊（背后只有 DWM 已糊平的壁纸），
     所以毛玻璃的观感来自「白雾 + 描边 + 高光」这三层材质线索，
     而不是来自"糊掉背后的文字"。

     ⚠ 不要再为了"让模糊可见"去改 scrollBody / composerSeat 的
       margin、padding、position。那会移动官方布局，属于侵入。 */

  /* ── 卡片本体：毛玻璃 ─────────────────────────────────────────
     目标：**看得出是一块毛玻璃**——半透明、有白雾、有边框和高光。

     ⚠ 这一节**完全不碰布局**。位置、尺寸、margin、padding 一律沿用
       DSH 原生值，输入栏就在官方位置。上一版为了"让背后有内容可糊"
       去改滚动容器的负 margin，结果把边框拖到了窗口底部 —— 已全部撤销。

     关于 backdrop-filter：保留着，但要知道它的局限 ——
       DSH 里 scrollBody 与 composerSeat 是**兄弟**（flex column 排列），
       聊天内容只在 scrollBody 内部滚动，不会跑到输入框背后。
       所以卡片背后通常只有 DWM 已经糊平的壁纸，
       backdrop-filter 再糊一次几乎看不出变化。
       真正让观感成立的，是下面这三层材质线索：
         ① 白雾（半透明白，提亮、显"厚"）
         ② 0.5px 发丝描边 + 上缘内高光（交代"这里有一块板"）
         ③ 外投影（把它从背景里抬起来）
       在没有可糊内容的前提下，这三层才是"像毛玻璃"的主要来源。

     ⚠ 白雾别调太高：实测 28% 会把本来就弱的模糊彻底盖平（边缘能量 1.03），
       8% 才平衡。 */

  /* ── 白雾浓度实测（同一位置，只改这一个值）────────────────────
       白雾  0% → 边缘能量 0.23
       白雾 10% → 边缘能量 0.61
       白雾 28% → 边缘能量 1.03
       白雾 50% → 边缘能量 1.37   ← 糊掉的细节被白雾重新"填平"
     所以默认取 8%。

     ⚠ 不要加噪点颗粒（试过，已移除）。
       颗粒是高频噪声，会把边缘能量拉回去 ——
       等于用一层假细节盖住真正的模糊，适得其反。 */

  /* 结构（从下往上）：
       ① backdrop-filter（卡片本身）  —— 糊开背后内容（若有）
       ② backdrop-filter（::after）   —— 再糊一层，叠加更厚
       ③ 极淡白雾（background-image）—— 8%，只提亮一点，不盖模糊 */
  /* ══ 输入栏：完全透明（mask 模式）═══════════════════════════
     用户最终选定的方案：不做模糊、不铺底色。
     输入栏区只是一块"空的透明区域"，看到的就是它背后的面板/桌面。
     文字不会出现在这里，是因为滚动容器加了 mask 裁切（见下面 D 段）。

     ⚠ 这里刻意什么都不画：一旦有底色或模糊，它就与面板"不同层"了，
       而用户要的是"输入栏看上去和面板是一层"。 */
  'html[data-dsh-acrylic-light] [data-composer-card],',
  'html[data-dsh-acrylic-light] [class*="RlGAzG_card"]{',
  '  background:transparent!important;',
  '  background-image:none!important;',
  '  backdrop-filter:none!important;',
  '  -webkit-backdrop-filter:none!important;',
  '  border:0!important;',
  '  box-shadow:none!important;',
  '  position:relative;',
  '}',
  /* ── 输入栏 ::after：已移除 ─────────────────────────────────
     这里原本是唯一的模糊层（backdrop-filter: blur），用来糊背后的聊天内容。
     用户最终要的效果是「输入栏和面板同一层、完全透明的」，
     所以整层删除 —— 只清卡片本体的 backdrop-filter 不够，
     因为真正在做事的是这个伪元素。
     文字不进入输入栏区域，改由聊天内容容器的 mask 裁切负责。 */
  /* 浅色主题：白玻璃在浅壁纸上会"看不见边界"，描边要更实。
     ⚠ 这里**不再**覆盖 background-image —— 噪点层是共用的，
       覆盖它会把噪点抹掉。白雾浓度由 paint() 按主题自动加倍，
       所以这一层只管描边与阴影。 */
  'html[data-dsh-acrylic-light] body:not([data-ds-dark-theme]) [data-composer-card],',
  'html[data-dsh-acrylic-light] body:not([data-ds-dark-theme]) [class*="RlGAzG_card"]{',
  '  border:.5px solid rgb(15 17 21 / 18%)!important;',
  '  box-shadow:',
  '    inset 0 1px 0 rgb(255 255 255 / 80%),',
  '    inset 0 -1px 0 rgb(255 255 255 / 35%),',
  '    inset 0 0 0 .5px rgb(255 255 255 / 50%),',
  '    0 10px 32px -10px rgb(15 17 21 / 18%),',
  '    0 2px 8px -3px rgb(15 17 21 / 11%)!important;',
  '}',
  /* 聚焦：描边亮一档 + 一圈极淡外环。
     ⚠ 阴影层数与静置态保持一致，浏览器才能逐层插值，环是"渐显"而不是跳出。 */
  'html[data-dsh-acrylic-light] [data-composer-card]:focus-within,',
  'html[data-dsh-acrylic-light] [class*="RlGAzG_card"]:focus-within{',
  '  border-color:rgb(var(--acrylic-edge) / 30%)!important;',
  '  box-shadow:',
  '    inset 0 1px 0 rgb(var(--acrylic-sheen) / 16%),',
  '    inset 0 -1px 0 rgb(var(--acrylic-sheen) / 6%),',
  '    inset 0 0 0 .5px rgb(var(--acrylic-sheen) / 8%),',
  '    0 12px 36px -10px rgb(0 0 0 / 40%),',
  '    0 0 0 3px rgb(120 150 255 / 12%)!important;',
  '  transition:box-shadow 220ms cubic-bezier(.22,1,.36,1),border-color 220ms cubic-bezier(.22,1,.36,1);',
  '}',
  /* ── 上缘高光条已并入 box-shadow 的 inset 层 ──────────────────
     原来这里用 ::before 画一条 1px 亮线，现在 ::before 让给了
     第一层亚克力（backdrop-filter），不能再占。
     "上缘有一条亮线"这件事改由卡片 box-shadow 的
       inset 0 1px 0 rgb(255 255 255 / 28%)
     来表达 —— 效果等价，且不额外占伪元素。 */
  /* ── 输入栏下方的 dock（统计 / 上下文计量）─────────────────────
     它在卡片内部，本来就会继承同一块玻璃。这里只清掉它自己的底色，
     否则会在玻璃上再糊一层不透明的条。 */
  'html[data-dsh-acrylic-light] [data-composer-dock],',
  'html[data-dsh-acrylic-light] [class*="RlGAzG_dock"]{',
  '  background:transparent!important;',
  '  background-image:none!important;',
  '}',
  /* ── 无障碍：系统要求"降低透明度"时退回实色，保证可读 ───────── */
  '@media (prefers-reduced-transparency: reduce){',
  '  html[data-dsh-acrylic-light] [data-composer-card],',
  '  html[data-dsh-acrylic-light] [class*="RlGAzG_card"]{',
  '    background:rgb(var(--acrylic-edge) / 88%)!important;',
  '    backdrop-filter:none!important;',
  '    -webkit-backdrop-filter:none!important;',
  '  }',
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
  'html[data-dsh-acrylic-light] body{--dsw-mask-blur:none!important}',

  /* ── 设置面板 ─────────────────────────────────────────────── */
  'html[data-dsh-acrylic-light] [class*="wCInkW_panel"]{',
  '  background:var(--acrylic-overlay-panel-dark)!important;',
  '  backdrop-filter:none!important;',
  '  -webkit-backdrop-filter:none!important;',
  '}',
  'html[data-dsh-acrylic-light] body:not([data-ds-dark-theme]) [class*="wCInkW_panel"]{',
  '  background:var(--acrylic-overlay-panel-light)!important;',
  '}',

  /* ── 通用对话框（确认框、命令面板等）────────────────────────── */
  'html[data-dsh-acrylic-light] [class*="_dialog_o6lrb"]{',
  '  background:var(--acrylic-overlay-panel-dark)!important;',
  '  backdrop-filter:none!important;',
  '  -webkit-backdrop-filter:none!important;',
  '}',
  'html[data-dsh-acrylic-light] body:not([data-ds-dark-theme]) [class*="_dialog_o6lrb"]{',
  '  background:var(--acrylic-overlay-panel-light)!important;',
  '}',

  /* ── 菜单 / 下拉：它们本来就有 blur(40px)，这里统一强度并确保底色够实 ── */
  'html[data-dsh-acrylic-light] [class*="_material_ri079"]{',
  '  backdrop-filter:none!important;',
  '  -webkit-backdrop-filter:none!important;',
  '}',

  /* 兜底：任何 role=dialog / menu / listbox 的浮层都补上模糊，
     覆盖上面没枚举到的第三方浮层。 */
  'html[data-dsh-acrylic-light] [role="dialog"],',
  'html[data-dsh-acrylic-light] [role="menu"],',
  'html[data-dsh-acrylic-light] [role="listbox"]{',
  '  backdrop-filter:none!important;',
  '  -webkit-backdrop-filter:none!important;',
  '}',

  /* ── 颗粒感：已移除 ───────────────────────────────────────────
     这里原本有一个整页 fixed 的 feTurbulence 噪点层。
     去掉的原因：
       1. 用户明确要求"不要颗粒"；
       2. 噪点是高频细节，铺在输入栏上会把 backdrop-filter 糊出来的
          柔和色块重新"打碎"，边缘能量回升 —— 等于用假细节盖住真模糊。
     磨砂的质感现在完全由「模糊 + 淡白雾」承担，表面更干净。 */

].join('')

window.__ModuleLoader__.load({
  id: 'dsh-acrylic-light',
  factory(require) {
    const React = require('react')

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

        /**
         * 文字裁切 —— 把输入栏座从滚动容器里"抬出去"。
         *
         * 为什么这么做：纯 CSS 蒙版方案的裁切线是相对消息容器的，会随文本滚动，
         * 钉不到屏幕固定位置，且会误削消息 —— 已废弃。要"固定位置 + 文字不进
         * 输入栏"且输入栏透明，唯一可靠办法是把输入栏座从滚动容器里移出来，
         * 让滚动容器的高度不再包含输入栏 —— 聊天内容滚动到底就正好止于输入栏上沿。
         *
         * 风险：composerSeat 是 React 托管的孩子（scrollBody.children = [Views, seat]），
         * 移动它会和 React 的 fiber 树产生分歧。历史教训：在初次渲染期间热移动
         * （rAF/setTimeout 内 + MutationObserver 高频回抬）会在冷启动时破坏首屏 →
         * 主面板空白。这里改用「更晚、更轻、防抖」的策略：
         *   1. 移动只在 paint() 里触发（插件每次 paint 时）；
         *   2. 初次移动推迟到会话面板确认渲染稳定之后；
         *   3. 之后用**防抖**的 observer 在 React 把 seat 放回时慢速回抬，
         *      不贴身紧咬，避免在 React commit 的中途插手。
         */
        let observer = null
        const findBody = () => document.querySelector('[data-conversation-content]')
        const findSeat = () => document.querySelector('[data-conversation-content] [data-composer-seat]')
        const findScroll = () => document.querySelector('[data-conversation-content] [data-conversation-scroll]')

        /* ── 阶段判断：官方靠 data-phase 切换输入栏位置 ────────────────
           官方 CSS（dsh-client-ui-conversation）：
             root[data-phase=hero]    新会话 -> scrollBody{justify-content:center}
                                       + .composerHero{align-self:center}
                                       => 输入栏在**中间**
             root[data-phase=active]  对话中 -> .composerSeat{position:sticky;bottom:0}
                                       => 输入栏贴底
           settling 是过渡期（composerSeat visibility:hidden）。

           我们的裁切做法是"把 seat 从 scrollBody 里抬出来当 flex 兄弟"，
           它只能产生"永远贴底"。新会话时官方本来要让输入栏居中，
           我们却把 seat 拽到底部 —— 用户看到的一瞬正常然后跳到底，
           就是这个原因。

           所以：**只在 active 阶段抬 seat**（那时官方本就要它贴底，
           抬出来 scrollBody 才会被压缩、文字才能硬断在上沿）；
           hero / settling 阶段把 seat 放回 scrollBody 原位，
           完全交还官方布局。 */
        /* 读当前阶段。
           ⚠ data-phase 到底挂在哪？官方源码写得清楚（dsh-client-ui-conversation）:

                <div className={ConversationRoot.root} data-phase={phase}>
                  ... <div className="body" data-conversation-content> ...

           即 **data-phase 在最外层 .root 上**，不在 [data-conversation-content] 上;
           后者只有 embedded 变体才带 data-content-phase。

           早先版本只查 [data-conversation-content]，主变体永远读到空串 ——
           空串被当作 hero，于是永不裁切;偶发读到别的值又表现为"贴底"。
           正确做法: 从内容节点 closest 向上找带 data-phase 的祖先。 */
        const phaseOf = () => {
          const node = findBody()

          // 1) 从内容节点向上找带 data-phase 的祖先（主变体的 .root 就在上面）
          if (node && node.closest) {
            const owner = node.closest('[data-phase]')
            if (owner) {
              const v = owner.getAttribute('data-phase')
              if (v) return v
            }
            // 2) embedded 变体: 内容节点自己带 data-content-phase
            const own = node.getAttribute('data-content-phase')
            if (own) return own
          }

          // 3) 兜底: 文档里任意带 data-phase 的会话根
          const rootEl = document.querySelector('[data-phase]')
          if (rootEl) {
            const v = rootEl.getAttribute('data-phase')
            if (v) return v
          }
          return ''
        }

        /** 把 seat 放回 scrollBody 内部（官方默认位置），撤销裁切。 */
        const lowerSeat = () => {
          const seat = findSeat()
          const scroll = findScroll()
          if (!seat || !scroll) return false
          if (seat.parentElement === scroll) return true // 已在原位
          scroll.appendChild(seat)
          return true
        }

        const liftSeat = () => {
          const seat = findSeat()
          const host = findBody()
          const scroll = findScroll()
          if (!seat || !host || !scroll || scroll === seat) return false

          /* hero / settling / 空值一律交还官方布局。
             空值按 hero 处理更安全：新会话刚创建的那一帧属性可能还没写，
             这时若去 lift 就会把居中布局拽掉。 */
          const phase = phaseOf()
          if (phase !== 'active') {
            lowerSeat()
            return false
          }

          if (seat.parentElement === host) return true // 已在正确位置
          // 插到 scrollBody 之后（WidthControls 之前）：flex 顺序 scroll→seat→…
          // 让 body 的 flex 布局把 scrollBody 压缩到 seat 上沿（真正产生硬裁）。
          scroll.insertAdjacentElement('afterend', seat)
          return true
        }

        let liftTimer = null
        const scheduleLift = () => {
          if (liftTimer !== null) return
          liftTimer = window.setTimeout(() => {
            liftTimer = null
            try { liftSeat() } catch {}
          }, 250)
        }

        /* ── 为什么 observer 观察 document.body 而不是 scrollBody ────────
           原来观察 `[data-conversation-scroll]` 那个具体节点。问题是：
           用户切到「插件」「自动化任务」等页面再切回会话时，React 会把
           整棵会话子树卸载重建 —— 旧的 scrollBody 节点已经被移除，
           observer 挂在一个**已脱离文档的节点**上，从此永远收不到通知，
           于是新 seat 没人回抬，裁切消失（重启后正常，因为那是首次挂载）。

           改成观察 document.body（subtree: true）：
             1. body 本身不会随页面切换被替换，observer 一直有效；
             2. 任何子树的增删都会触发，切回会话时新 seat 一出现就能捕获；
             3. 仍然走 250ms 防抖 + liftSeat 的"已在正确位置就返回"短路，
                不会频繁操作 DOM。

           代价是回调触发次数变多，但回调只做一件事：设一个 250ms 防抖定时器，
           定时器到点才真正查 DOM。开销可忽略。 */
        const startObserver = () => {
          if (observer) return
          observer = new MutationObserver(() => scheduleLift())
          // body 一定存在（插件在渲染层加载时已挂载），退化情况用 documentElement
          const target = document.body ?? document.documentElement
          if (!target) return
          observer.observe(target, { childList: true, subtree: true })
        }

        const stopObserver = () => {
          if (observer) { observer.disconnect(); observer = null }
          if (liftTimer !== null) { window.clearTimeout(liftTimer); liftTimer = null }
          if (ensureLifted && ensureLifted.cancelBoot) ensureLifted.cancelBoot()
        }

        const restoreSeat = () => {
          stopObserver()
          const seat = findSeat()
          const scroll = findScroll()
          if (seat && scroll && seat.parentElement !== scroll) scroll.appendChild(seat)
        }

        const ensureLifted = () => {
          /* 冷启动保护：首次移动与监听都推迟，等 React 首屏渲染稳定后再动，
             避免在初次 reconciliation 中途移动 seat → 主面板空白。

             ⚠ 这个保护只该用于「进程内的第一次挂载」。
             原实现用 `ensureLifted.inited` 做一次性闸门，副作用是：
             用户切到插件页 / 自动化任务页再切回会话时，DOM 已被 React
             重建，需要重新 lift + 重新挂 observer，但 inited 已是 true，
             只走到下面的 scheduleLift —— 而 observer 当时还没启动，
             这一次 lift 就成了唯一一次尝试，之后无人回抬，裁切消失。

             现在：首次仍延迟 900ms（保护首屏），但**每次都确保 observer 在跑**，
             这样切回会话后新 DOM 一出现就由 observer 驱动回抬。 */
          if (!ensureLifted.inited) {
            ensureLifted.inited = true
            let bootTimer = null
            const boot = () => {
              bootTimer = null
              try { liftSeat() } catch {}
              startObserver()
            }
            bootTimer = window.setTimeout(boot, 900)
            ensureLifted.cancelBoot = () => {
              if (bootTimer !== null) { window.clearTimeout(bootTimer); bootTimer = null }
            }
            return
          }
          // 之后每次调用：确保监听在跑，并排一次防抖 lift。
          // startObserver 内部有 `if (observer) return`，重复调用是安全的。
          startObserver()
          scheduleLift()
        }

        const paint = (state) => {
          current = { ...DEFAULTS, ...state }
          if (current.enabled === false) {
            root.removeAttribute('data-dsh-acrylic-light')
            restoreSeat()
            return
          }
          root.setAttribute('data-dsh-acrylic-light', 'true')
          ensureLifted()
          const set = (name, value) => root.style.setProperty(name, value)
          const clamp = (value, min, max) => {
            const n = Number(value)
            return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min
          }
          // 壁纸层开关：加属性才会命中 html[data-dsh-acrylic-wallpaper]::before 的样式。
          // ⚠ 这个属性是壁纸层能否显示的关键 —— 少了它，规则不匹配，页面什么都不会画。
          if (current.wallpaper === false) {
            root.removeAttribute('data-dsh-acrylic-wallpaper')
          } else {
            root.setAttribute('data-dsh-acrylic-wallpaper', 'true')
            set('--acrylic-wallpaper-blur', `${clamp(current.wallpaperBlur, 0, 120)}px`)
          }
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

        /* ── 壁纸加载 ──────────────────────────────────────────────
           壁纸由宿主侧的路由提供（读取 Windows 的 TranscodedWallpaper）。
           拿到后塞进 --acrylic-wallpaper，页面最底层那张 fixed 的 ::before
           就会显示它 —— 这样 backdrop-filter 才有东西可糊。

           为什么不用 file:// 直接引用：
             页面跑在 dsh-app:// 协议下，file:// 会被安全策略拦掉。
             走宿主 HTTP 路由是同源的，不受限制。 */
        const WALLPAPER_URL = '/dsh-acrylic-light/wallpaper'
        let wallpaperLoaded = false

        const loadWallpaper = async () => {
          if (wallpaperLoaded) return
          try {
            const response = await fetch(WALLPAPER_URL, { cache: 'no-cache' })
            if (!response.ok) return
            const blob = await response.blob()
            if (blob.size === 0) return

            // 转成 objectURL 比 base64 省内存（1MB 图转 base64 会涨到 1.37MB 字符串）
            const objectUrl = URL.createObjectURL(blob)
            root.style.setProperty('--acrylic-wallpaper', `url("${objectUrl}")`)
            // 打标记：兜底渐变只在没有壁纸时生效
            root.setAttribute('data-dsh-acrylic-wallpaper-ok', 'true')
            wallpaperLoaded = true
          } catch {
            // 拿不到壁纸就用 CSS 渐变兜底，不影响其它效果
          }
        }

        // 首帧就上色，避免"先闪一下原生底色"
        paint(readLocal())
        // 壁纸异步加载，不阻塞首帧
        loadWallpaper()

        // 注：座位不再移动（见 ensureLifted 停用说明），所以不需要
        // 座位位置由 ensureLifted 的 MutationObserver 在 lift 时校正。

        ctx.effect(() => () => {
          disposeGlass()
          disposeControls()
          root.removeAttribute('data-dsh-acrylic-light')
          root.removeAttribute('data-dsh-acrylic-wallpaper')
          root.removeAttribute('data-dsh-acrylic-wallpaper-ok')
          for (const name of ['--acrylic-wallpaper', '--acrylic-wallpaper-blur']) {
            root.style.removeProperty(name)
          }
          restoreSeat()
        }, 'dsh-acrylic-light: paint')

        /** 设置页：只保留「启用」开关。 */
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


/* ══════════════════════════════════════════════════════════════════════════
 * 首次使用公告 —— 完全独立于插件主体
 *
 * 这段代码刻意写在 `window.__ModuleLoader__.load({...})` 之外，并且整体包在
 * try/catch 里，理由：
 *
 *   1. 它不参与插件加载。哪怕这里抛错（DOM 不存在、localStorage 被禁、
 *      样式注入失败），也只会让「公告不显示」，绝不会影响插件挂载、
 *      输入栏裁切或页面渲染 —— 上一版把公告塞进 apply() 里，
 *      任何异常都会顺着插件加载链把整个页面带崩。
 *   2. 它不依赖 React / ctx / locale / require。纯 DOM + 内嵌文案，
 *      少一条依赖就少一条崩溃路径。
 *   3. 它自己拉长到 1.2s 后再执行，避开冷启动首屏，不和插件抢帧。
 *
 * 为什么只能在重启后出现：client.js 是渲染层代码，DSH 不重启就不会加载
 * 本文件，所以在「装好插件、还没重启」那段时间里插件代码根本没运行，
 * 任何提示都无处显示。重启后的首次加载是唯一能覆盖新用户的时点。
 * ══════════════════════════════════════════════════════════════════════════ */
;(function () {
  try {
    var NOTICE_VERSION = 'v1'
    var REPO = 'https://github.com/YSDLNGF/dsh-acrylic-light'
    var NOTICE_API = '/dsh-acrylic-light/notice'

    /* 「已读」的唯一真相源是宿主文件（插件包根 .notice-state.json）。

       ⚠ 为什么**绝不能**再退回 localStorage（第一版的错）：
         卸载重装时宿主目录被删、状态清空，本来该重新弹公告；
         但如果读宿主失败时退回 localStorage，而那份记录是**上一次
         安装时写下的、还留在浏览器里**，就会读成「已读」→ 不弹。
         用户的实际诉求是「只要安装就弹」，所以必须让状态与
         插件目录严格同生共死，不能有第二个持久化位置。

       宿主不可用时（非 web profile / 路由未注册 / 请求失败）：
         一律当作「没读过」→ 弹公告。宁可多提醒一次，
         也不要让该看到安装指引的人错过它。 */
    var readSeen = function () {
      return fetch(NOTICE_API, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null })
        .then(function (data) {
          if (data && typeof data.seen === 'string') return data.seen
          return ''
        })
        .catch(function () { return '' })
    }

    /* 只写宿主，不写 localStorage —— 见上面 readSeen 的说明。
       写失败不影响用户：本次关掉，下次加载会再提示一次。 */
    var writeSeen = function () {
      try {
        fetch(NOTICE_API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seen: NOTICE_VERSION }),
        }).catch(function () {})
      } catch (_) {}
    }

    /* 文案口径（重要）：
       1. 这段公告是在**重启之后**才被加载显示的 —— 插件前端代码只在页面
          启动时执行，安装当下的那一刻 DSH 只显示它自己的「请重启使更改
          生效」。所以绝不能写「请重启」，那是用户读到它时已经做完的事。
       2. 不能断言「还差一步」：用户可能在重装前就已经打过补丁，
          或者本来就不需要窗口透明。让**用户自己看效果判断**，
          比让插件猜更可靠 —— 所以文案改成条件式：
          「如果窗口已经是磨砂效果，忽略本提示」。
       3. 判断依据是**视觉现象**（窗口有没有透出桌面、是不是磨砂玻璃），
          不是让用户理解"窗口材质补丁"这种术语。 */
    /* 结构：标题 → 两个带边框的块 → 仓库地址 → 按钮。
       第一块 = 原来那句"需要去 GitHub 下载补丁"（以前是标题下的浅灰小字，
                现在升级成和下面同等分量的边框块）；
       第二块 = "补丁和插件绑定 / 关闭不影响其他主题"。
       不再有浅灰色小字说明。 */
    var ZH = {
      title: '使用提示',
      blocks: [
        '装插件后需要去 GitHub 下载透明补丁文件运行后才有透明效果',
        '补丁文件和插件绑定，缺一不可；如果不想用这个主题，<b>关闭后不影响其他主题效果</b>'
      ],
      repoLabel: 'GitHub 仓库地址',
      ok: '知道了'
    }
    var EN = {
      title: 'Please read',
      blocks: [
        'After installing, download and run the transparency patch from GitHub — the window only becomes transparent after that.',
        'The patch and the plugin are bound together — both are required. If you do not want this theme, <b>turning it off does not affect other themes</b>.'
      ],
      repoLabel: 'GitHub repository',
      ok: 'Got it'
    }
    var TEXT = ZH
    try {
      var lang = (navigator.languages && navigator.languages[0]) || navigator.language || ''
      if (!/^zh/i.test(lang)) TEXT = EN
    } catch (_) { /* 语言探测失败就用中文 */ }

    var CSS = [
      '.dsh-acrylic-notice{position:fixed;right:22px;bottom:22px;z-index:2147483000;',
      'width:min(430px,calc(100vw - 44px));box-sizing:border-box;padding:18px 20px 16px;',
      'border-radius:16px;border:.5px solid rgb(255 255 255 / 16%);',
      'background:rgb(22 24 30 / 96%);color:#fff;',
      'box-shadow:0 22px 60px rgb(0 0 0 / 52%),0 2px 8px rgb(0 0 0 / 30%);',
      'backdrop-filter:blur(22px) saturate(150%);-webkit-backdrop-filter:blur(22px) saturate(150%);',
      'font:400 13px/1.62 system-ui,-apple-system,"Segoe UI",sans-serif;',
      'animation:dsh-acrylic-notice-in .24s cubic-bezier(.22,1,.36,1)}',
      '@keyframes dsh-acrylic-notice-in{from{opacity:0;transform:translateY(12px) scale(.985)}to{opacity:1;transform:none}}',
      '.dsh-acrylic-notice h3{margin:0 0 10px;font-size:14px;font-weight:650;line-height:1.4;',
      'display:flex;align-items:center;gap:8px;color:#fff}',
      '.dsh-acrylic-notice h3::before{content:"";width:3px;height:14px;border-radius:2px;background:#4c9aff;flex:none}',
      /* 两个等分量的带边框块：同一套底色 + 1px 描边，视觉上对称。
         第一块是"需要去 GitHub 下载补丁"，第二块是"绑定关系 / 关闭不影响"。 */
      '.dsh-acrylic-notice .dsh-an-block{margin:0 0 10px;padding:10px 12px;border-radius:10px;',
      'background:rgb(255 255 255 / 6%);border:.5px solid rgb(255 255 255 / 14%);',
      'color:rgb(255 255 255 / 90%);font-size:12.5px;line-height:1.65}',
      '.dsh-acrylic-notice .dsh-an-block b{color:#fff;font-weight:600}',
      '.dsh-acrylic-notice .dsh-an-label{margin:0 0 5px;font-size:11.5px;color:rgb(255 255 255 / 48%)}',
      '.dsh-acrylic-notice code{display:block;margin:0 0 12px;padding:9px 11px;border-radius:9px;',
      'background:rgb(255 255 255 / 9%);color:#9ecbff;',
      'font:400 12px/1.5 Consolas,ui-monospace,monospace;',
      'word-break:break-all;user-select:all;-webkit-user-select:all}',
      '.dsh-acrylic-notice button{width:100%;padding:9px 14px;border:0;border-radius:10px;',
      'background:#3b82f6;color:#fff;font:inherit;font-size:13px;font-weight:550;cursor:pointer}',
      '.dsh-acrylic-notice button:hover{filter:brightness(1.1)}',
      /* 浅色主题：白底 + 深色描边，保证两个块的边框在浅色下也看得见 */
      'body:not([data-ds-dark-theme]) .dsh-acrylic-notice{background:rgb(255 255 255 / 97%);color:#0f1115;',
      'border-color:rgba(15,17,21,.1);box-shadow:0 22px 60px rgb(0 0 0 / 22%),0 2px 8px rgb(0 0 0 / 8%)}',
      'body:not([data-ds-dark-theme]) .dsh-acrylic-notice h3{color:#0f1115}',
      'body:not([data-ds-dark-theme]) .dsh-acrylic-notice .dsh-an-block{',
      'background:rgba(15,17,21,.045);border-color:rgba(15,17,21,.12);color:rgba(15,17,21,.88)}',
      'body:not([data-ds-dark-theme]) .dsh-acrylic-notice .dsh-an-block b{color:#0f1115}',
      'body:not([data-ds-dark-theme]) .dsh-acrylic-notice .dsh-an-label{color:rgba(15,17,21,.5)}',
      'body:not([data-ds-dark-theme]) .dsh-acrylic-notice code{background:rgba(15,17,21,.055);color:#0b62d6}',
      '@media (max-width:520px){.dsh-acrylic-notice{right:12px;left:12px;bottom:12px;width:auto}}'
    ].join('')

    var render = function () {
      try {
        if (document.querySelector('.dsh-acrylic-notice')) return

        var style = document.createElement('style')
        style.setAttribute('data-dsh-acrylic-notice', 'true')
        style.textContent = CSS
        document.head.appendChild(style)

        var box = document.createElement('aside')
        box.className = 'dsh-acrylic-notice'
        box.setAttribute('role', 'status')

        var h3 = document.createElement('h3')
        h3.textContent = TEXT.title
        box.appendChild(h3)

        /* 两个等分量的边框块。
           第一块是"需要去 GitHub 下载补丁"（原来是标题下的浅灰小字，
           用户要求把它升级成边框块，和下面那块对称）；
           第二块是"补丁和插件绑定 / 关闭不影响其他主题"。
           不再有浅灰小字（lead / foot 已删除）。 */
        for (var b = 0; b < TEXT.blocks.length; b++) {
          var block = document.createElement('div')
          block.className = 'dsh-an-block'
          block.innerHTML = TEXT.blocks[b]
          box.appendChild(block)
        }

        var label = document.createElement('p')
        label.className = 'dsh-an-label'
        label.textContent = TEXT.repoLabel
        box.appendChild(label)

        var code = document.createElement('code')
        code.textContent = REPO
        box.appendChild(code)

        var ok = document.createElement('button')
        ok.type = 'button'
        ok.textContent = TEXT.ok
        ok.addEventListener('click', function () {
          // 写入宿主（真相源）+ 本地缓存，重启后不再弹
          writeSeen()
          box.parentNode && box.parentNode.removeChild(box)
          style.parentNode && style.parentNode.removeChild(style)
        })
        box.appendChild(ok)

        document.body.appendChild(box)
      } catch (error) {
        // 公告自己失败就算了，绝不影响插件
        try { console.warn('[dsh-acrylic-light] notice skipped:', error) } catch (_) {}
      }
    }

    /* 决定是否显示：先等宿主把「已读」告诉我们，再决定。
       这样点过「知道了」的用户，重启（端口变了）也不会再看到；
       从未点过的用户一定会看到。宿主不可用时 readSeen 会退回本地缓存。 */
    var decide = function () {
      try {
        if (!document.body) { setTimeout(decide, 200); return }
        readSeen().then(function (seen) {
          if (seen === NOTICE_VERSION) return
          render()
        }).catch(function () {
          // 连兜底都失败就显示一次，宁可多提醒
          render()
        })
      } catch (error) {
        try { console.warn('[dsh-acrylic-light] notice skipped:', error) } catch (_) {}
      }
    }

    setTimeout(decide, 1200)
  } catch (_) {
    // 整段公告彻底失败也无声无息，插件照常工作
  }
})()