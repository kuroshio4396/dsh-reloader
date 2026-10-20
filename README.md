# dsh-reloader

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）**桌面版**用的一个小插件，只做两件事：

| 功能 | 做什么 | 代价 |
|---|---|---|
| **重载刷新** | 让宿主重组合 profile（插件代码 / 配置有变就热替换），然后刷新页面重新取数 | 页面会闪一下，设置面板会关掉 |
| **自动重启** | 彻底结束整个程序，再由独立重启器立即把程序拉起来 | 窗口消失约 5 秒，进行中的任务会中断 |

入口：**设置 → 重载与重启**。

> 适用于打包版（Electron 桌面版）。源码模式跑 `dsh web` 时，「重载刷新」可用，「自动重启」会提示不支持。

## 为什么需要它

- 桌面版把窗口关闭当「隐藏到托盘」，`before-quit` 在有任务时还会弹确认框 —— 没有「礼貌退出」的程序入口。
- 插件装了 / 改了，DSH 默认要整个重启才生效；HMR 面世后可以只重载插件。
- 现在这两个动作都在设置页里，一键完成。

## 实现要点（改代码前先看）

```
index.js        宿主半端：路由 + HMR 重载 + 排程重启
client.js       界面半端：设置里的「重载与重启」页（自注册脚本，非 ESM）
lib/proc.mjs    认路（exe / app pid / host pid）+ 用 WMI 拉起重启器
lib/state.mjs   家目录、日志、事件台账（重启后还要能读到）
scripts/launch-restarter.ps1   用 Win32_Process.Create 创建「脱离进程树」的重启器
scripts/restart.ps1            等一会 → 校验 pid → 结束主进程 → 等宿主死透 → 重新拉起
selfcheck.mjs   自检（改完必跑）
```

### 1. HTTP 路由必须挂 `connection.fetch`

桌面版界面走 Electron 自定义协议，`ctx.webServer.register` 收不到请求。所以两条都挂：

- `/api/dsh-reloader/*` —— `ctx.connection.fetch.register`，桌面版与 Web 版都走这条（带鉴权）
- `/dsh-reloader/api/*` —— `ctx.webServer.register` 前缀路由，源码模式 / 老宿主用

前端启动时先探 `/ping`，哪个通就用哪个。

### 2. 重载 = `ctx.hmr.runExclusive(() => ctx.hmr.reconcileProfile())`

- 必须在 `runExclusive` 里跑（HMR 所有变更共用一条串行队列）
- 它会把「磁盘上文件变过的插件」停掉、重新 import、重新 apply
- 返回 `{ warnings, pending, restartReason }`：`pending` 是写了盘但要重启才生效的模块数
- ⚠️ 重载会**替换本插件自己**（文件变了就会换新实例），所以内存状态会被清零 —— 结果必须落盘到 `state.json`

### 3. 重启 = 杀 Electron 主进程 + 由「逃出 job object」的重启器重新拉起

链路上的三个事实：

1. 插件跑在 Host 子进程里（Electron 主进程 spawn 的）。`process.ppid` = 主进程 PID，`process.execPath` = 桌面版 exe。
2. Chromium 主进程带 **job object**（kill-on-close）：主进程一死，Host 与它 spawn 的普通子进程会被一起干掉。
3. 所以重启器**不能**是普通子进程 —— 用 `Win32_Process.Create` 创建，父进程是 `WmiPrvSE.exe`，既不在 job 里，也不会被 `taskkill /T` 顺着父链带走。

时序：

```
前端 POST /restart
  → 宿主 launch-restarter.ps1（WMI create，拿回重启器 PID）
  → 立即返回 { ok, restarterPid, delayMs }（前端进入倒计时）
  → 重启器睡 delayMs（默认 2500ms，让响应先落地）
  → 校验进程名是 DeepSeek*，taskkill /PID <主进程> /F（只杀主进程，不带 /T）
  → 等宿主 PID 消失（最多 10s），还活着才 taskkill /T /F
  → 等主进程消失 → Start-Process <exe>（失败退回 cmd start）
```

坑（都踩过）：

- `Win32_Process.Create` 的 CommandLine **第一个 token 必须是可执行文件**，否则返回 `9`（path not found）
- `Split-Path -LiteralPath X -Parent` 在 PowerShell 5.1 里是**冲突参数集**，返回 `$null`，会让 `Start-Process -WorkingDirectory` 报参数绑定错误 —— 用 `[System.IO.Path]::GetDirectoryName()`
- 主进程那一步**不能**带 `/T`，否则把还没起作用的进程树一起带走
- PowerShell 脚本保持**纯 ASCII**：cmd/PS 按 ANSI 读，中文会变成乱码命令；日志用 `-Encoding UTF8` 写（配 `tailLog` 去 BOM）

## 安装（desktop profile）

桌面版自带一套 dsh CLI，插件装进桌面版的 `desktop` profile：

```bash
# <安装目录> 里应是 DeepSeek Harness.exe
<安装目录>/resources/runtime/cli/bin/dsh.cmd plugin --profile desktop add "link:<本仓库的绝对路径>"
```

装完 HMR 通常会**当场**把插件载入（不用重启）。没载入就点一次「重载刷新」，或手动重启。

> 也可以用 git 依赖的方式装：`add "https://github.com/kuroshio4396/dsh-reloader.git"`。

## 自检

```bash
node selfcheck.mjs
```

13 项：包字段、client 模块 id、cordis patch、`/api` 前缀、PowerShell 纯 ASCII、`restart.ps1` 不许对主进程用 `/T`……
