/**
 * dsh-reloader —— 宿主半端
 * ============================================================================
 * 两件事：
 *   ① 重载刷新：调宿主的 HMR 服务重组合 profile（插件代码 / 配置有变就热替换），
 *      前端再 reload 一次页面 —— 相当于「不关程序的 Ctrl+F5」。
 *   ② 自动重启：结束 Electron 主进程，再由一个脱离进程树的重启器把 exe 拉起来。
 *
 * ⚠️ 桌面版不监听 TCP，HTTP 路由必须注册在 `ctx.connection.fetch`；
 *    `ctx.webServer.register` 只在源码模式 / Web 模式有效（两条都挂，前端自己探测）。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { appInfo, launchRestarter } from './lib/proc.mjs'
import { stateDirOf, appendLog, tailLog, readState, record, logFile } from './lib/state.mjs'

export const name = 'dsh-reloader'
// 不 inject 任何服务：缺服务时靠 svc() 探测降级，避免整条插件不激活
export const inject = []

const API = '/api/dsh-reloader'
const LEGACY = '/dsh-reloader/api'
const VERSION = '1.0.0'
const RELOAD_TIMEOUT_MS = 60_000
const RESTART_DELAY_MS = 2500

/** cordis 里未 inject 的属性访问会抛错，必须与 ctx.get 分开 try */
function svc(ctx, key) {
  if (!ctx) return undefined
  try {
    const direct = ctx[key]
    if (direct !== undefined && direct !== null) return direct
  } catch { /* 未 inject：继续走 get */ }
  try { return ctx.get?.(key) ?? undefined } catch { return undefined }
}

/** 超时包裹：HMR 卡住时至少让前端能拿到结果 */
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超过 ${Math.round(ms / 1000)} 秒未返回`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** 界面半端是否被宿主登记（clientModules 服务；没有就返回 unknown 而不是报错） */
function clientInfo(ctx) {
  try {
    const cm = svc(ctx, 'clientModules')
    if (!cm) return { available: false, registered: null, path: null, entries: null }
    const path = typeof cm.clientPath === 'function' ? cm.clientPath('dsh-reloader') : undefined
    let entries = null
    try {
      const graph = typeof cm.graph === 'function' ? cm.graph() : undefined
      if (Array.isArray(graph?.entries)) entries = graph.entries.length
    } catch { /* 图还没就绪 */ }
    return { available: true, registered: Boolean(path), path: path ?? null, entries }
  } catch (e) {
    return { available: false, registered: null, path: null, entries: null, error: String(e?.message ?? e) }
  }
}

export function apply(ctx) {
  const home = stateDirOf(ctx)
  const log = (m) => {
    appendLog(home, `[host] ${m}`)
    try { ctx.logger?.('dsh-reloader')?.info?.(m) } catch { /* 忽略 */ }
  }

  const info = appInfo()
  log(`加载 v${VERSION}：${info.note}`)

  const reloadState = { phase: 'idle', startedAt: 0, finishedAt: 0, result: null }
  let reloadRun = null
  let restartState = { phase: 'idle', at: 0, restarterPid: null, delayMs: RESTART_DELAY_MS, error: null }

  // ── ① 重载 ────────────────────────────────────────────────────────────────
  function startReload() {
    if (reloadRun) return { status: 409, body: { ok: false, error: '上一次重载还没结束，稍等' } }
    const hmr = svc(ctx, 'hmr')
    const canReconcile = Boolean(hmr && typeof hmr.runExclusive === 'function' && typeof hmr.reconcileProfile === 'function')
    reloadState.phase = 'running'
    reloadState.startedAt = Date.now()
    reloadState.finishedAt = 0
    reloadState.result = null
    log(`重载开始（hmr=${canReconcile ? 'on' : 'off'}）`)

    reloadRun = (async () => {
      if (!canReconcile) {
        reloadState.result = { ok: true, mode: 'page-only', note: '宿主没有提供 HMR 服务：只会刷新界面，插件代码不会热重载' }
        return
      }
      try {
        // runExclusive 是所有 HMR 变更共用的串行队列；reconcileProfile 必须跑在里面
        const r = await withTimeout(hmr.runExclusive(() => hmr.reconcileProfile()), RELOAD_TIMEOUT_MS, 'HMR 重载')
        reloadState.result = {
          ok: true,
          mode: 'hmr',
          warnings: Array.isArray(r?.warnings) ? r.warnings.slice(0, 4).map((w) => String(w).slice(0, 200)) : [],
          pending: Array.isArray(r?.pending) ? r.pending.length : 0,
          restartReason: r?.restartReason ?? null,
        }
      } catch (e) {
        reloadState.result = { ok: false, mode: 'hmr', error: String(e?.message ?? e).slice(0, 400) }
      }
    })().catch((e) => {
      reloadState.result = { ok: false, mode: 'hmr', error: String(e?.message ?? e).slice(0, 400) }
    }).finally(() => {
      const r = reloadState.result || {}
      reloadState.phase = r.ok === false ? 'failed' : 'done'
      reloadState.finishedAt = Date.now()
      reloadRun = null
      const note = r.mode !== 'hmr'
        ? (r.note || '仅刷新界面')
        : r.ok === false
          ? `HMR 重载失败：${r.error}`
          : `HMR 重载完成${r.pending ? `（${r.pending} 个模块要重启才生效）` : ''}${r.restartReason ? `，${r.restartReason}` : ''}`
      record(home, 'reload', r.ok !== false, note)
      log(`重载结束：${note}`)
    })

    return { status: 200, body: { ok: true, started: true, hmr: canReconcile } }
  }

  // ── ② 重启 ────────────────────────────────────────────────────────────────
  async function startRestart(body) {
    if (restartState.phase === 'running' || restartState.phase === 'scheduled') {
      return { status: 409, body: { ok: false, error: '已经在重启流程里了' } }
    }
    if (!info.restartSupported) {
      return { status: 409, body: { ok: false, error: info.note } }
    }
    const delayMs = Number.isFinite(Number(body?.delayMs))
      ? Math.min(15_000, Math.max(1_200, Math.round(Number(body.delayMs))))
      : RESTART_DELAY_MS

    restartState = { phase: 'running', at: Date.now(), restarterPid: null, delayMs, error: null }
    log(`重启请求：app pid ${info.appPid} / host pid ${info.hostPid} / delay ${delayMs}ms`)
    const r = await launchRestarter({
      appPid: info.appPid,
      hostPid: info.hostPid,
      exe: info.exe,
      logFile: logFile(home),
      delayMs,
    })
    if (!r.ok) {
      restartState = { phase: 'failed', at: Date.now(), restarterPid: null, delayMs, error: r.error }
      record(home, 'restart', false, `拉起重启器失败：${r.error}`)
      log(`重启器失败：${r.error}`)
      return { status: 500, body: { ok: false, error: r.error } }
    }
    restartState = { phase: 'scheduled', at: Date.now(), restarterPid: r.pid, delayMs, error: null }
    record(home, 'restart', true, `已排程：${delayMs}ms 后结束 pid ${info.appPid} 并重新启动（重启器 ${r.pid}）`)
    log(`重启器已启动 pid=${r.pid}`)
    return {
      status: 200,
      body: { ok: true, restarterPid: r.pid, delayMs, appPid: info.appPid, exe: info.exe },
    }
  }

  // ── 路由 ──────────────────────────────────────────────────────────────────
  const routes = {
    '/ping': { methods: ['GET'], handler: async () => ({ status: 200, body: { ok: true, plugin: 'dsh-reloader', version: VERSION } }) },
    '/status': {
      methods: ['GET'],
      handler: async () => {
        const hmr = svc(ctx, 'hmr')
        const saved = readState(home)
        return {
          status: 200,
          body: {
            ok: true,
            version: VERSION,
            app: info,
            hmr: { available: Boolean(hmr), reconcile: Boolean(hmr && typeof hmr.reconcileProfile === 'function') },
            client: clientInfo(ctx),
            reload: {
              phase: reloadState.phase,
              startedAt: reloadState.startedAt,
              finishedAt: reloadState.finishedAt,
              elapsedMs: reloadState.startedAt ? (reloadState.finishedAt || Date.now()) - reloadState.startedAt : 0,
              result: reloadState.result,
            },
            restart: restartState,
            lastReload: saved.lastReload ?? null,
            lastRestart: saved.lastRestart ?? null,
            events: Array.isArray(saved.events) ? saved.events.slice(-8).reverse() : [],
            logTail: tailLog(home, 8),
            home,
          },
        }
      },
    },
    '/reload': { methods: ['POST'], handler: async () => startReload() },
    '/reload-state': {
      methods: ['GET'],
      handler: async () => ({
        status: 200,
        body: {
          ok: true,
          phase: reloadState.phase,
          elapsedMs: reloadState.startedAt ? (reloadState.finishedAt || Date.now()) - reloadState.startedAt : 0,
          result: reloadState.result,
        },
      }),
    },
    '/restart': { methods: ['POST'], handler: async (_q, body) => startRestart(body || {}) },
    '/open-log': {
      methods: ['POST'],
      handler: async () => {
        const file = logFile(home)
        try { spawn('explorer.exe', ['/select,', file], { detached: true, stdio: 'ignore' }).unref() } catch { /* 忽略 */ }
        return { status: 200, body: { ok: true, file } }
      },
    },
  }

  async function handle(method, path, body) {
    const route = routes[path]
    if (!route) return { status: 404, body: { ok: false, error: `没有这个接口：${method} ${path}` } }
    if (!route.methods.includes(method)) return { status: 405, body: { ok: false, error: `${path} 不支持 ${method}` } }
    return route.handler(undefined, body)
  }

  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

  // ① 桌面 / Web 通用：connection.fetch 精确路由（必须挂在 /api 下）
  try {
    ctx.inject(['connection'], (c) => {
      const fetchHost = c.connection?.fetch
      if (!fetchHost?.register) { log('connection 没有 fetch 路由能力，跳过桌面通道'); return }
      const disposers = []
      for (const [path, route] of Object.entries(routes)) {
        try {
          disposers.push(fetchHost.register({
            path: `${API}${path}`,
            methods: route.methods,
            requestBody: route.methods.some((m) => m !== 'GET' && m !== 'HEAD') ? 'buffered' : 'none',
            fetch: async (request) => {
              try {
                const isPost = request.method !== 'GET' && request.method !== 'HEAD'
                let body
                if (isPost) {
                  try { body = await request.json() } catch { body = {} }
                }
                const r = await handle(request.method, path, body ?? {})
                return json(r.body, r.status)
              } catch (e) {
                log(`fetch 路由 ${path} 异常：${e?.message ?? e}`)
                return json({ ok: false, error: String(e?.message ?? e).slice(0, 300) }, 500)
              }
            },
          }))
        } catch (e) { log(`注册 fetch 路由 ${path} 失败：${e?.message ?? e}`) }
      }
      ctx.effect(() => () => { for (const d of disposers) { try { d?.() } catch { /* 忽略 */ } } })
      log(`connection.fetch 已挂载 ${API}/*（${disposers.length} 条）`)
    })
  } catch (e) { log(`connection.fetch 注册跳过：${e?.message ?? e}`) }

  // ② 源码模式 / 老宿主：webServer 前缀路由
  try {
    ctx.inject(['webServer'], (c) => {
      if (!c.webServer?.register) return
      const dispose = c.webServer.register({
        kind: 'prefix',
        path: LEGACY,
        handler: async (req, res) => {
          const url = new URL(req.url || '/', 'http://localhost')
          const path = url.pathname.startsWith(LEGACY) ? url.pathname.slice(LEGACY.length) || '/' : url.pathname
          const method = (req.method || 'GET').toUpperCase()
          let body
          if (method !== 'GET' && method !== 'HEAD') {
            body = await new Promise((resolve) => {
              let size = 0
              const chunks = []
              req.on('data', (chunk) => {
                size += chunk.length
                if (size > 64 * 1024) { resolve({}); req.destroy(); return }
                chunks.push(chunk)
              })
              req.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8')
                try { resolve(text ? JSON.parse(text) : {}) } catch { resolve({}) }
              })
              req.on('error', () => resolve({}))
            })
          }
          try {
            const r = await handle(method, path, body ?? {})
            res.statusCode = r.status
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.setHeader('cache-control', 'no-store')
            res.end(JSON.stringify(r.body))
          } catch (e) {
            res.statusCode = 500
            res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e).slice(0, 300) }))
          }
        },
      })
      ctx.effect(() => () => { try { dispose?.() } catch { /* 忽略 */ } })
      log(`webServer 前缀已挂载 ${LEGACY}`)
    })
  } catch (e) { log(`webServer 注册跳过：${e?.message ?? e}`) }
}
