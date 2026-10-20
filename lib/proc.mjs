/**
 * lib/proc.mjs —— 认路 + 拉起「重启器」
 * ============================================================================
 * 事实（0.2.1-rc.2 桌面版实测）：
 *   · 插件跑在 Host 子进程里，Host 由 Electron 主进程 spawn
 *       → process.ppid = Electron 主进程 PID，process.execPath = 桌面版 exe
 *   · Electron 主进程把窗口 close 当「隐藏到托盘」，`before-quit` 在有任务时还会弹确认框
 *       → 没有「礼貌退出」的程序入口，只能结束主进程
 *   · Chromium 主进程带 job object，直接杀主进程会把 Host 与普通子进程一起带走
 *       → 重启器必须用 WMI 创建（父进程是 WmiPrvSE.exe），才能活过主进程
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { basename, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** 当前进程在桌面版里的身份；不是桌面宿主时 `desktop` 为 false */
export function appInfo() {
  const exe = process.execPath
  const electron = process.versions?.electron ?? null
  const base = basename(exe)
  const desktop = Boolean(electron) && process.env.ELECTRON_RUN_AS_NODE === '1'
  return {
    platform: process.platform,
    exe,
    exeName: base,
    appPid: process.ppid,
    hostPid: process.pid,
    electron,
    desktop,
    // 只有「桌面宿主 + Windows」才走 kill → relaunch 这条路
    restartSupported: desktop && process.platform === 'win32' && /harness/i.test(base),
    note: desktop
      ? `${base} · app pid ${process.ppid} · host pid ${process.pid}`
      : `当前不是桌面宿主（${base}），重启按钮不可用`,
  }
}

/** 跑一段 PowerShell 并收集 stdout（隐藏窗口，带超时） */
function runPowerShell(args, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 忽略 */ }
      resolve({ code: -1, out, err: err || 'timeout' })
    }, timeoutMs)
    child.stdout?.on('data', (b) => { out += String(b) })
    child.stderr?.on('data', (b) => { err += String(b) })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e?.message ?? e) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out, err }) })
  })
}

/**
 * 用 WMI 创建一个脱离当前进程树的重启器（父进程是 WmiPrvSE.exe）。
 * @returns {{ ok: boolean, pid: number|null, error: string|null, mode: string }}
 */
export async function launchRestarter({ appPid, hostPid, exe, logFile, delayMs = 2500 }) {
  const launcher = join(PLUGIN_DIR, 'scripts', 'launch-restarter.ps1')
  const restarter = join(PLUGIN_DIR, 'scripts', 'restart.ps1')

  const r = await runPowerShell([
    '-File', launcher,
    '-AppPid', String(appPid),
    '-HostPid', String(hostPid),
    '-Exe', exe,
    '-Script', restarter,
    '-Log', logFile,
    '-DelayMs', String(delayMs),
  ])

  const match = /PID\s+(\d+)/.exec(r.out || '')
  if (r.code === 0 && match) {
    return { ok: true, pid: Number(match[1]), error: null, mode: 'wmi' }
  }
  return {
    ok: false,
    pid: null,
    error: (r.err || r.out || `exit ${r.code}`).trim().slice(0, 400),
    mode: 'wmi',
  }
}
