/**
 * lib/state.mjs —— 插件家目录：日志、事件台账
 * ============================================================================
 * 桌面版重启会把宿主进程一起带走，所以「上一次动作的结果」必须落盘：
 * 页面刷新/重启回来后，设置页读这里把历史显示出来，而不是靠内存变量。
 * ============================================================================
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const MAX_LOG_BYTES = 512 * 1024
const MAX_EVENTS = 24

/** 插件家目录：优先问宿主要 dshHomePath，拿不到退回 $DSH_HOME / ~/.dsh */
export function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') dir = String(p('dsh-reloader') || '')
    else if (typeof p === 'string' && p) dir = join(p, 'dsh-reloader')
  } catch { /* 拿不到就兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-reloader')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function logFile(dir) { return join(dir, 'reloader.log') }
export function stateFile(dir) { return join(dir, 'state.json') }

/** 追加一行日志；超过 512KB 就轮转一次（只留 log.1） */
export function appendLog(dir, line) {
  const file = logFile(dir)
  try {
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) renameSync(file, file + '.1')
  } catch { /* 轮转失败不影响写日志 */ }
  try {
    appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch { /* 磁盘满之类的，忽略 */ }
}

export function tailLog(dir, lines = 8) {
  try {
    // PowerShell 的 Add-Content -Encoding UTF8 在新建文件时会写 BOM，读回来要去掉
    const text = readFileSync(logFile(dir), 'utf8').replace(/^\uFEFF/, '')
    return text.trimEnd().split(/\r?\n/).slice(-lines)
  } catch { return [] }
}

export function readState(dir) {
  try {
    const v = JSON.parse(readFileSync(stateFile(dir), 'utf8'))
    return v && typeof v === 'object' ? v : {}
  } catch { return {} }
}

export function writeState(dir, state) {
  try { writeFileSync(stateFile(dir), JSON.stringify(state, null, 2), 'utf8') } catch { /* 忽略 */ }
}

/**
 * 记一条事件（给设置页的历史列表）。
 * @param dir 插件家目录
 * @param kind 'reload' | 'restart'
 * @param ok 成败
 * @param note 一句话说明
 */
export function record(dir, kind, ok, note) {
  const state = readState(dir)
  const at = new Date().toISOString()
  const events = Array.isArray(state.events) ? state.events : []
  events.push({ at, kind, ok, note: String(note ?? '').slice(0, 300) })
  state.events = events.slice(-MAX_EVENTS)
  state[kind === 'restart' ? 'lastRestart' : 'lastReload'] = { at, ok, note: String(note ?? '').slice(0, 300) }
  writeState(dir, state)
  appendLog(dir, `${kind} ${ok ? 'OK' : 'FAIL'} ${note ?? ''}`)
  return state
}
