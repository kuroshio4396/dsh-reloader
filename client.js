/**
 * dsh-reloader —— 浏览器半端（设置里的「重载与重启」一页）
 * ============================================================================
 * client bundle 不是 ESM，是自注册脚本：window.__ModuleLoader__.load({ id, factory })，
 * id 必须等于 package.json 的 name。
 *
 * 页面只做两件事：
 *   · 重载刷新：POST /reload → 轮询 /reload-state → 页面 location.reload()
 *   · 自动重启：POST /restart → 倒计时提示（宿主会在 delay 后结束主进程）
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-reloader',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const CANDIDATES = ['/api/dsh-reloader', '/dsh-reloader/api']
    let BASE = null
    const resolveBase = async () => {
      if (BASE) return BASE
      for (const b of CANDIDATES) {
        try {
          const r = await fetch(`${b}/ping`, { credentials: 'same-origin', signal: AbortSignal.timeout(2500) })
          if (r.ok) { BASE = b; return b }
        } catch { /* 试下一条 */ }
      }
      BASE = CANDIDATES[0]
      return BASE
    }

    const asJson = async (res) => {
      const text = await res.text().catch(() => '')
      let data = null
      try { data = text ? JSON.parse(text) : null } catch { /* 不是 JSON */ }
      if (!res.ok) {
        const detail = data?.error || data?.message || text.slice(0, 160) || res.statusText
        throw new Error(`HTTP ${res.status}${detail ? '：' + detail : ''}（${BASE}）`)
      }
      return data
    }

    const request = async (p, opts = {}) => {
      const base = await resolveBase()
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 15000)
      try {
        const res = await fetch(base + p, { credentials: 'same-origin', ...opts, signal: ctl.signal })
        return await asJson(res)
      } catch (e) {
        if (e?.name === 'AbortError') throw new Error('请求超时 —— 插件后端没响应（看 reloader.log）')
        if (e instanceof TypeError) throw new Error(`网络错误（${e.message}）—— 找不到插件后端 ${base}`)
        throw e
      } finally { clearTimeout(timer) }
    }
    const jget = (p) => request(p)
    const jpost = (p, body) => request(p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })

    const CSS = `
[data-rl]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 12px;max-width:680px;}
[data-rl-sec]{display:flex;flex-direction:column;gap:8px;}
[data-rl-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-rl-card]{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));
  background:var(--dsw-alias-bg-secondary,rgba(128,128,128,.04));}
[data-rl-title]{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;}
[data-rl-label]{font-size:13px;line-height:19px;}
[data-rl-note]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-rl-note][data-warn]{color:#c2410c;}
[data-rl-bar]{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
[data-rl-btn]{padding:6px 13px;border-radius:8px;font-size:12px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.35));
  background:var(--dsw-alias-bg-secondary,transparent);color:inherit;}
[data-rl-btn]:disabled{opacity:.45;cursor:default;}
[data-rl-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-rl-btn][data-danger]{border-color:#dc2626;color:#dc2626;}
[data-rl-btn][data-danger]:not(:disabled):hover{background:rgba(220,38,38,.08);}
[data-rl-badge]{font-size:11px;padding:1px 7px;border-radius:9px;background:rgba(128,128,128,.15);}
[data-rl-badge][data-ok]{background:rgba(22,163,74,.15);color:#15803d;}
[data-rl-badge][data-bad]{background:rgba(220,38,38,.15);color:#b91c1c;}
[data-rl-say]{font-size:12px;line-height:18px;padding:8px 10px;border-radius:8px;background:rgba(128,128,128,.09);}
[data-rl-say][data-tone=ok]{background:rgba(22,163,74,.1);color:#15803d;}
[data-rl-say][data-tone=bad]{background:rgba(220,38,38,.1);color:#b91c1c;}
[data-rl-kv]{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:11px;line-height:17px;}
[data-rl-kv] > span:first-child{color:var(--dsw-alias-label-tertiary,#9aa0a6);white-space:nowrap;}
[data-rl-kv] > span:last-child{word-break:break-all;}
[data-rl-events]{display:flex;flex-direction:column;gap:4px;font-size:11px;line-height:16px;}
[data-rl-event]{display:flex;gap:8px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-rl-event] > b{font-weight:600;color:inherit;}
[data-rl-event][data-ok] > b{color:#15803d;}
[data-rl-event][data-bad] > b{color:#b91c1c;}
[data-rl-pre]{font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;margin:0;
  background:rgba(128,128,128,.07);border-radius:8px;padding:8px;max-height:150px;overflow:auto;
  font-family:ui-monospace,Consolas,monospace;}
`

    const fmtTime = (iso) => {
      if (!iso) return '—'
      try {
        const d = new Date(iso)
        const pad = (n) => String(n).padStart(2, '0')
        return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      } catch { return String(iso) }
    }

    function Card({ title, badge, children }) {
      return h('div', { 'data-rl-card': '' },
        h('div', { 'data-rl-title': '' }, title, badge || null),
        children)
    }

    function Badge({ tone, children }) {
      return h('span', { 'data-rl-badge': '', 'data-ok': tone === 'ok' ? '' : undefined, 'data-bad': tone === 'bad' ? '' : undefined }, children)
    }

    function Panel() {
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(null) // 'reload' | 'restart' | null
      const [say, setSay] = React.useState(null) // { tone, text }
      const [reloadElapsed, setReloadElapsed] = React.useState(0)
      const [countdown, setCountdown] = React.useState(null)
      const alive = React.useRef(true)

      React.useEffect(() => () => { alive.current = false }, [])

      const load = React.useCallback(async () => {
        try {
          const data = await jget('/status')
          if (alive.current) { setStatus(data); setError(null) }
          return data
        } catch (e) {
          if (alive.current) setError(String(e?.message ?? e))
          return null
        }
      }, [])

      React.useEffect(() => { void load() }, [load])

      /** 重载：触发 → 轮询 → 刷新页面 */
      const doReload = async () => {
        setBusy('reload'); setSay(null); setReloadElapsed(0)
        const startedAt = Date.now()
        try {
          const r = await jpost('/reload')
          if (r?.hmr === false) {
            setSay({ tone: null, text: '宿主没有 HMR：只刷新界面。' })
          } else {
            setSay({ tone: null, text: '正在重载插件与配置（HMR）…' })
          }
        } catch (e) {
          setBusy(null)
          setSay({ tone: 'bad', text: `重载没能开始：${e?.message ?? e}` })
          return
        }

        // 轮询到结束（最多 45 秒）；之后无论如何都刷新页面
        const deadline = Date.now() + 45000
        let finalText = '重载完成，正在刷新页面…'
        for (;;) {
          await new Promise((r) => setTimeout(r, 500))
          if (!alive.current) return
          setReloadElapsed(Math.round((Date.now() - startedAt) / 100) / 10)
          if (Date.now() > deadline) { finalText = '等太久了，直接刷新页面…'; break }
          let s
          try { s = await jget('/reload-state') } catch { break } // 后端被热替换掉时会 404 / 断连
          if (s?.phase === 'done' || s?.phase === 'failed' || s?.phase === 'idle') {
            const res = s.result || {}
            if (s.phase === 'failed' || res.ok === false) {
              finalText = `重载出错（${res.error || '未知原因'}），仍然刷新页面…`
            } else if (res.mode === 'hmr') {
              finalText = `重载完成${res.pending ? `（${res.pending} 个模块写了盘，需重启才生效）` : ''}，刷新页面…`
            }
            break
          }
        }
        setSay({ tone: null, text: finalText })
        await new Promise((r) => setTimeout(r, 450))
        try { globalThis.location.reload() } catch { /* 忽略 */ }
      }

      /** 重启：先确认，再排程，倒计时期间不给退路 */
      const doRestart = async () => {
        const ok = globalThis.confirm(
          '彻底关闭 DSH 并立即重启？\n\n'
          + '· 窗口会消失几秒，然后自动重新打开\n'
          + '· 进行中的任务会被中断\n'
          + '· 如果 30 秒后没回来，请手动双击桌面上的 DeepSeek Harness',
        )
        if (!ok) return
        setBusy('restart'); setSay({ tone: 'bad', text: '正在安排重启…' })
        try {
          const r = await jpost('/restart')
          const delay = Number(r?.delayMs || 2500)
          setSay({ tone: 'bad', text: `重启器已就位（pid ${r?.restarterPid}），${(delay / 1000).toFixed(1)} 秒后关闭程序…` })
          const until = Date.now() + delay
          const tick = () => {
            const left = Math.max(0, Math.ceil((until - Date.now()) / 100) / 10)
            setCountdown(left)
            if (left > 0 && alive.current) setTimeout(tick, 100)
            else if (alive.current) setSay({ tone: 'bad', text: '正在关闭并重新启动…如果窗口没回来，请手动启动 DeepSeek Harness' })
          }
          tick()
        } catch (e) {
          setBusy(null)
          setCountdown(null)
          setSay({ tone: 'bad', text: `重启没能安排上：${e?.message ?? e}` })
        }
      }

      if (error && !status) {
        return h('div', { 'data-rl': '' },
          h('div', { 'data-rl-say': '', 'data-tone': 'bad' }, `读不到插件后端：${error}`),
          h('div', { 'data-rl-bar': '' },
            h('button', { 'data-rl-btn': '', onClick: () => { setError(null); void load() } }, '重试'),
            h('button', { 'data-rl-btn': '', onClick: () => { BASE = null; setError(null); void load() } }, '重新探测通道')))
      }
      if (!status) return h('div', { 'data-rl': '', style: { opacity: 0.6, fontSize: 12 } }, '读取状态中…')

      const app = status.app || {}
      const hmr = status.hmr || {}
      const restartSupported = Boolean(app.restartSupported)
      const reloadRunning = status.reload?.phase === 'running'

      return h('div', { 'data-rl': '' },

        h('div', { 'data-rl-h': '' }, '当前程序'),

        h(Card, {
          title: 'DeepSeek Harness 桌面版',
          badge: hmr.reconcile ? h(Badge, { tone: 'ok' }, 'HMR 可用') : h(Badge, { tone: 'bad' }, '无 HMR'),
        },
          h('div', { 'data-rl-kv': '' },
            h('span', {}, '程序'), h('span', {}, app.exe || '—'),
            h('span', {}, '主进程 PID'), h('span', {}, String(app.appPid ?? '—')),
            h('span', {}, '宿主 PID'), h('span', {}, String(app.hostPid ?? '—')),
            h('span', {}, 'Electron'), h('span', {}, String(app.electron ?? '—')),
            h('span', {}, '界面模块'), h('span', {}, status.client?.registered
              ? `已登记（${status.client.path || 'client.js'}）`
              : '未登记（重启后仍未出现就查 client.js 是否有语法错误）')),
          app.note ? h('div', { 'data-rl-note': '', 'data-warn': restartSupported ? undefined : '' }, app.note) : null),

        h('div', { 'data-rl-h': '' }, '动作'),

        h(Card, { title: '① 重载刷新' },
          h('div', { 'data-rl-note': '' },
            '不关闭程序：让宿主重新组合 profile（插件代码 / 配置改动会热替换），然后刷新页面重新取数。等价于浏览器里的 Ctrl+F5，只是连后端插件一起重来。'),
          h('div', { 'data-rl-bar': '' },
            h('button', {
              'data-rl-btn': '', 'data-primary': '',
              disabled: busy !== null,
              onClick: doReload,
            }, busy === 'reload' ? `正在重载… ${reloadElapsed.toFixed(1)}s` : '重载刷新'),
            hmr.reconcile ? null : h('span', { 'data-rl-note': '', 'data-warn': '' }, '宿主没有 HMR，只能刷新界面'),
            reloadRunning && busy === null
              ? h('button', { 'data-rl-btn': '', onClick: doReload }, '有重载在进行，继续等它')
              : null)),

        h(Card, { title: '② 自动重启' },
          h('div', { 'data-rl-note': '' },
            '彻底结束整个程序（主进程 + 宿主），再由一个独立的重启器立即把程序拉起来。窗口会消失几秒；正在跑的任务会被中断。'),
          h('div', { 'data-rl-bar': '' },
            h('button', {
              'data-rl-btn': '', 'data-danger': '',
              disabled: busy !== null || !restartSupported,
              onClick: doRestart,
            }, busy === 'restart' ? (countdown !== null ? `${countdown.toFixed(1)} 秒后重启…` : '安排中…') : '自动重启'),
            !restartSupported ? h('span', { 'data-rl-note': '', 'data-warn': '' }, '当前环境不支持（只实现了桌面版 Windows）') : null)),

        say ? h('div', { 'data-rl-say': '', 'data-tone': say.tone || undefined }, say.text) : null,

        h('div', { 'data-rl-h': '' }, '最近动作'),
        h(Card, { title: '台账' },
          status.events?.length
            ? h('div', { 'data-rl-events': '' },
                status.events.map((e, i) => h('div', {
                  key: `${e.at}-${i}`, 'data-rl-event': '', 'data-ok': e.ok ? '' : undefined, 'data-bad': e.ok ? undefined : '',
                },
                  h('span', { style: { whiteSpace: 'nowrap' } }, fmtTime(e.at)),
                  h('b', {}, e.kind === 'restart' ? '重启' : '重载'),
                  h('span', {}, e.ok ? '' : '失败'),
                  h('span', { style: { flex: 1, minWidth: 0 } }, e.note || ''))))
            : h('div', { 'data-rl-note': '' }, '还没有记录。'),
          status.logTail?.length
            ? h('pre', { 'data-rl-pre': '' }, status.logTail.join('\n'))
            : null,
          h('div', { 'data-rl-bar': '' },
            h('button', { 'data-rl-btn': '', onClick: () => { void load() } }, '刷新状态'),
            h('button', {
              'data-rl-btn': '',
              onClick: () => { jpost('/open-log').catch(() => {}) },
            }, '打开日志'),
            h('span', { 'data-rl-note': '' }, status.home || ''))),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-reloader: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots?.inject || !slots?.register) return
        ctx.effect(() => slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'dsh-reloader', order: 60, label: '重载与重启' },
          () => h(Panel),
        )), 'dsh-reloader: 设置页')
      },
    }
  },
})
