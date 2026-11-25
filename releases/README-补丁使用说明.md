# dsh-acrylic-light 窗口透明补丁

双击 `enable-transparency.cmd` 即可让 DeepSeek Harness 窗口透出桌面壁纸。

> **补丁包版本 v1.3.0** —— 适配 DeepSeek Harness 0.2.2-rc.5（Electron 44）。
> 旧版补丁包在新版 DSH 上会找不到锚点而直接放弃，表现为"补丁没打上、界面纯黑"。

---

## 用法（三步）

**1. 完全退出 DeepSeek Harness**

托盘图标（右下角箭头里）→ 右键 → **退出**。
只点窗口右上角的 × 是**没用的**，程序还在后台运行。

**2. 双击 `enable-transparency.cmd`**

双击后它会：
- 等你退出 Harness（没退出就一直等，不会乱来）
- 自动找到安装目录并打补丁
- 校验补丁确实写进去了
- 自动重新启动 Harness

**3. 重启后看效果**

窗口应该透出桌面壁纸了。

---

## 新版 DSH 补了什么（v1.3.0）

新版主进程给主窗口加了一个**不透明**的 `backgroundColor`，它会在 Chromium 层
把整个窗口表面涂满，DWM 的亚克力材质被压在下面 —— 这就是"纯黑"的来源。
而且建窗之后还有两处 `setBackgroundColor(...)` 会把不透明色再刷回去
（切深浅色时、每次进入工作区时），所以只改构造参数不够。

v1.3.0 一次性处理四处：

| 位置 | 原来 | 现在 |
| --- | --- | --- |
| 主窗口构造参数 | `backgroundColor: chromeFallbackFill()` | `#00000000` + `backgroundMaterial: "acrylic"` |
| 标题栏 40px | `color: chromeFallbackFill()` | `#00000000` |
| 主题切换回调 | `setBackgroundColor(chromeFallbackFill())` | `#00000000` + 补回材质 |
| 进入工作区 | `setBackgroundColor(chromeFallbackFill())` | `#00000000` + 补回材质 |

> ⚠ 刻意**不用** `transparent: true`：那会让窗口走 layered window 路径，
> DWM 材质反而彻底失效。正确做法是 `backgroundColor: "#00000000"`。

---

## 打了补丁还是不透明？先跑诊断

双击 **`diagnose.cmd`**，它会逐项检查：

1. **补丁是否真的写进了主窗口分支**（不是欢迎小窗自带的那个）
2. **主窗口底色是否已是透明**（不透明底色会盖住材质）
3. **建窗后有没有被刷回不透明**（切主题/重进工作区会变黑）
4. **Windows 版本是否支持 Acrylic**（需要 Build ≥ 17134）
5. **系统「透明效果」开关**（设置 → 个性化 → 颜色；关掉后所有程序都不生效）
6. **运行环境**：是否虚拟机、显卡是否为「基本显示适配器」、是否 RDP 远程桌面
   —— 这三种情况下 Windows 会主动禁用 Acrylic，补丁再正确也没用

诊断输出会逐条打勾，把它整段发给开发者即可定位。

### 已知限制（不是补丁的问题）

| 情况 | 结果 |
| --- | --- |
| Windows Build < 17134 | 系统没有 Acrylic 材质，只能全透明或实色 |
| 系统「透明效果」关闭 | 任何程序的 Acrylic 都不生效 |
| 虚拟机缺显卡驱动（基本显示适配器） | DWM 不做 GPU 合成，窗口退化为不透明 |
| 远程桌面（RDP）会话 | Acrylic 在 RDP 下不生效，请在本机控制台查看 |
| DSH 更新后 | 更新会覆盖 `app.asar`，需重新双击一次补丁 |

---

## 如果失败

脚本会打印失败原因。常见情况：

| 提示 | 解决办法 |
| --- | --- |
| `Harness is STILL RUNNING` | 打开任务管理器，结束所有 `DeepSeek Harness` 进程，重新双击 |
| `app.asar is still locked` | 同上，可能有残留进程占着文件 |
| `锚点「主窗口材质」—— 这个 DSH 版本的主进程结构变了` | 补丁包太旧，去仓库 Releases 下新版 |
| `app.asar not found automatically` | 手动指定路径，见下方 |
| `Access denied` | 右键 `enable-transparency.cmd` → **以管理员身份运行** |

**手动指定路径：**

```powershell
powershell -ExecutionPolicy Bypass -File apply-when-closed.ps1 -Asar "D:\你的安装目录\resources\app.asar"
```

---

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `enable-transparency.cmd` | **双击这个**，一键流程 |
| `apply-when-closed.ps1` | 脚本主体（等退出 → 打补丁 → 校验 → 重启） |
| `patch-asar.mjs` | 实际打补丁的工具（改完重算 asar 头部） |
| `verify-asar.mjs` | 校验补丁是否真的写进去了（含归档结构完整性） |
| `restore-asar.ps1` | 还原（撤销补丁） |
| `diagnose.cmd` / `diagnose.ps1` | 透明效果诊断 |

## 关于 Node（重要）

> **旧版插件补丁需要 node 文件，而旧版 dsh 内部没有 node，需要另外下载。
> 新版本的不用下载，dsh 内部就有。**

| 组合 | 是否需要自己装 Node |
| --- | --- |
| 旧版补丁 + 旧版 dsh | **需要** —— dsh 不带 node，去 [nodejs.org](https://nodejs.org) 下载 |
| 新版补丁 + 新版 dsh | **不需要** —— dsh 自带 node |

新版脚本会依次查找系统 PATH、**DSH 自带运行时**
（`resources\runtime\primary-runtime\dependencies\node\bin\node.exe`）、
以及 `~/.dsh\dsh-runtimes`。

实测：即使系统 PATH 里没有 node、也从没装过 Node.js，新版补丁照样能打上。

⚠ 只有当脚本明确打印「找不到 node.exe」时，才需要自己装 Node.js ——
说明你的 Harness 版本不带运行时。

---

## 还原

```powershell
powershell -ExecutionPolicy Bypass -File restore-asar.ps1
```

然后重启 Harness，窗口恢复原生外观。

---

## 注意事项

- 补丁会**重算并重写 asar 头部**（main.js 长度变了，其后所有条目的偏移都要平移），
  写完后脚本会逐项读回校验：条目大小、哈希、内容、以及全归档条目布局是否连续无重叠。
  任何一步不符就拒绝写出，**绝不留下半成品**。
- 每次打补丁前都会把原 `app.asar` 备份到 `backups/<时间戳>/`。
- **Harness 更新后会覆盖 `app.asar`，补丁失效**。届时重新双击一次即可。
- 重复运行是安全的：检测到已打过会直接拒绝，不会重复插入。
- 日志写在同目录的 `apply.log`。

