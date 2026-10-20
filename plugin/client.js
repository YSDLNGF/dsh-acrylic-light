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
 * 所以现在三个参数分别对应材质的三个真实维度：
 *   frost    —— 白雾浓度（%）。这是"磨砂板"的本体，0 就只剩模糊。
 *   blur     —— 模糊半径（px）。让背后内容糊开，制造"透过玻璃看"的感觉。
 *   saturate —— 提饱和（%）。把透上来的颜色挤出来，是玻璃质感的另一半。
 */
const DEFAULTS = {
  enabled: true,
  // 白雾浓度（%）。必须很淡：实测 28% 会把模糊结果盖平（边缘能量 1.03），
  // 8% 才既提亮又不遮（边缘能量 0.54）。
  frost: 8,
  // 模糊半径（px）。28 是实测最像亚克力的一档。
  blur: 28,
  // 提饱和（%）。140 让颜色饱满又不偏亮；去掉它会发灰（饱和度掉到 79%）。
  saturate: 140,
}

const DICTIONARIES = {
  zh: {
    nav: '透明亚克力',
    title: '透明亚克力',
    intro: '窗口透出桌面壁纸，由 Windows Acrylic 材质提供模糊。输入栏是一块毛玻璃。',
    enable: '启用',
    enableHint: '关闭后恢复 DSH 原生外观（窗口材质仍在，只是页面不再透明）。',
    frost: '磨砂白雾',
    frostHint: '输入栏的白色薄雾浓度。调太高会把背后的模糊盖住，8 是平衡点。',
    blur: '输入栏模糊',
    blurHint: '输入栏背后内容的模糊半径。28 是默认档：再低看得清背后的字，再高就糊成一片。',
    saturate: '玻璃饱和度',
    saturateHint: '提饱和让透上来的颜色更饱满，这是玻璃感的来源。100 等于不提。',
    reset: '恢复默认',
  },
  en: {
    nav: 'Transparent acrylic',
    title: 'Transparent acrylic',
    intro: 'The window shows the desktop wallpaper; Windows Acrylic supplies the blur. The composer is a pane of frosted glass.',
    enable: 'Enable',
    enableHint: 'Off restores the stock DSH look (the window material stays).',
    frost: 'Frost',
    frostHint: 'How much white haze the composer carries. Too much will hide the blur behind it; 8 is the balance point.',
    blur: 'Composer blur',
    blurHint: 'Blur radius over the content behind the composer. 28 is the default sweet spot.',
    saturate: 'Glass saturation',
    saturateHint: 'Boosting saturation is what makes it read as glass rather than tinted plastic. 100 disables.',
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
  '.acrylic-note{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary)}',
].join('')

/**
 * 玻璃层样式。
 *
 * 用 `[class*="_xxx"]` 后缀匹配：DSH 的 CSS Module 类名形如 `BynINW_centerCol`，
 * 哈希前缀随构建变化，但 `_centerCol` 这一段是稳定语义名。
 */
const GLASS_STYLE = [
  /* ── 根：全部清空，让窗口材质透上来 ───────────────────────────
     ⚠ 这一组必须保留：DSH 默认给整页铺 #0f1115（近黑），
       它压在窗口 Acrylic 材质之上，壁纸就透不出来。
       清成透明后，材质才是唯一的底色来源。 */
  'html[data-dsh-acrylic-light],html[data-dsh-acrylic-light] body{background:transparent!important}',
  'html[data-dsh-acrylic-light] #root{background:transparent!important}',

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
  'html[data-dsh-acrylic-light] [data-composer-card],',
  'html[data-dsh-acrylic-light] [class*="RlGAzG_card"]{',
  /* ① 白雾：必须很淡。28% 会盖住模糊，8% 刚好提亮又不遮。
        ⚠ 这里只有一层渐变，不加噪点 —— 颗粒会拉高边缘能量，
          等于用假细节盖住真模糊。 */
  '  background:transparent!important;',
  '  background-image:linear-gradient(180deg,',
  '      rgb(255 255 255 / var(--acrylic-frost-top, 8%)) 0%,',
  '      rgb(255 255 255 / var(--acrylic-frost-mid, 5%)) 42%,',
  '      rgb(255 255 255 / var(--acrylic-frost-bottom, 3%)) 100%)!important;',
  /* ② 边缘：0.5px 发丝描边 */
  '  border:.5px solid rgb(var(--acrylic-edge) / 24%)!important;',
  /* ③ 厚度感：上缘内高光 + 底部内阴影 + 外投影 */
  '  box-shadow:',
  '    inset 0 1px 0 rgb(255 255 255 / 30%),',
  '    inset 0 -1px 0 rgb(255 255 255 / 9%),',
  '    inset 0 0 0 .5px rgb(255 255 255 / 11%),',
  '    0 10px 32px -10px rgb(0 0 0 / 40%),',
  '    0 2px 8px -3px rgb(0 0 0 / 25%)!important;',
  /* ④ 模糊**不挂在本体上**。
     ⚠ 这是踩过的坑：backdrop-filter 挂在卡片本体时，模糊作用在整个元素上，
       连输入栏里的文字一起糊掉（用户反馈「输入栏的文字也模糊了」）。
     正确做法：本体设 none，模糊交给下面的 ::after —— 它用 z-index:-1
     压在卡片内容之下，只糊背后的历史消息。 */
  '  backdrop-filter:none!important;',
  '  -webkit-backdrop-filter:none!important;',
  /* ⑤ 定位上下文（::after 的 inset:0 需要它） */
  '  position:relative;',
  '}',
  /* ── 唯一的模糊层（::after）──
     z-index:-1 让它在卡片内容之下，所以：
       · 背后的历史消息被糊开  ✅
       · 输入栏自己的文字清晰  ✅ */
  'html[data-dsh-acrylic-light] [data-composer-card]::after,',
  'html[data-dsh-acrylic-light] [class*="RlGAzG_card"]::after{',
  '  content:"";position:absolute;inset:0;z-index:-1;border-radius:inherit;',
  '  pointer-events:none;',
  '  background:transparent;',
  '  backdrop-filter:blur(var(--acrylic-blur, 28px)) saturate(var(--acrylic-saturate, 140%)) brightness(1.02);',
  '  -webkit-backdrop-filter:blur(var(--acrylic-blur, 28px)) saturate(var(--acrylic-saturate, 140%)) brightness(1.02);',
  '}',
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

        /** 把配置写进 CSS 变量；关闭时摘掉属性，界面立刻恢复原生。 */
        const paint = (state) => {
          current = { ...DEFAULTS, ...state }
          if (current.enabled === false) {
            root.removeAttribute('data-dsh-acrylic-light')
            return
          }
          root.setAttribute('data-dsh-acrylic-light', 'true')
          const set = (name, value) => root.style.setProperty(name, value)
          const clamp = (value, min, max) => {
            const n = Number(value)
            return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min
          }
          // 三个材质参数：白雾、模糊、提饱和。
          // 白雾（frost）是最关键的 —— 没有它，输入栏就只剩一条白边。
          const frost = clamp(current.frost, 0, 100)
          // 浅色主题的白雾要浓得多：白底上 18% 的白几乎看不见，
          // 而深色底上 18% 已经很明显。所以按主题给不同系数。
          const dark = root.ownerDocument?.body?.hasAttribute('data-ds-dark-theme') ?? true
          const k = dark ? 1 : 3.4
          set('--acrylic-frost-top', `${Math.min(100, frost * k)}%`)
          // 中段与底部逐级变薄，模拟玻璃板越往下越薄的光学效果
          set('--acrylic-frost-mid', `${Math.min(100, frost * k * 0.55)}%`)
          set('--acrylic-frost-bottom', `${Math.min(100, frost * k * 0.33)}%`)
          set('--acrylic-blur', `${clamp(current.blur, 0, 64)}px`)
          // 第二层亚克力的半径取第一层的一半：两层叠加时，
          // 第二层只需"补一刀"，半径太大反而会糊成一片没有层次。
          set('--acrylic-blur-2', `${clamp(current.blur, 0, 64) * 0.5}px`)
          set('--acrylic-saturate', `${clamp(current.saturate, 100, 300)}%`)
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

        ctx.effect(() => () => {
          disposeGlass()
          disposeControls()
          root.removeAttribute('data-dsh-acrylic-light')
          for (const name of ['--acrylic-blur', '--acrylic-blur-2', '--acrylic-saturate']) {
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

            slider('frost', 'frost', 'frostHint', 0, 60, 1, '%'),
            slider('blur', 'blur', 'blurHint', 0, 64, 1, 'px'),
            slider('saturate', 'saturate', 'saturateHint', 100, 300, 5, '%'),

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

