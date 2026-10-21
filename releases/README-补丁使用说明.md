# dsh-acrylic-light 窗口透明补丁

双击 `enable-transparency.cmd` 即可让 DeepSeek Harness 窗口透出桌面壁纸。

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

## 如果失败

脚本会打印失败原因。常见情况：

| 提示 | 解决办法 |
| --- | --- |
| `Harness is STILL RUNNING` | 打开任务管理器，结束所有 `DeepSeek Harness` 进程，重新双击 |
| `app.asar is still locked` | 同上，可能有残留进程占着文件 |
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
| `patch-asar.mjs` | 实际打补丁的工具（等字节修改） |
| `verify-asar.mjs` | 校验补丁是否真的写进去了 |
| `restore-asar.ps1` | 还原（撤销补丁） |

需要 **Node.js 18+**。没有的话脚本会自动找 DSH 自带的 node。

---

## 还原

```powershell
powershell -ExecutionPolicy Bypass -File restore-asar.ps1
```

然后重启 Harness，窗口恢复原生外观。

---

## 注意事项

- 补丁是**等字节修改**，`app.asar` 文件总大小不变，不会破坏归档其他内容。
  锚点对不上时脚本直接失败退出，**绝不写出半成品**。
- **Harness 更新后会覆盖 `app.asar`，补丁失效**。届时重新双击一次即可。
- 重复运行是安全的：检测到已打过会直接拒绝，不会重复插入。
- 日志写在同目录的 `apply.log`。
