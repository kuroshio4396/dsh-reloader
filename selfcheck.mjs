#!/usr/bin/env node
/**
 * selfcheck.mjs —— dsh-reloader 自检（改完插件必跑）
 * ----------------------------------------------------------------------------
 * 检查的都是「装到宿主上才炸」的那几处约定：
 *   · package.json 的 dsh.bundle.patch / dsh.client / exports('./client')
 *   · client bundle 的模块 id 必须等于包名
 *   · cordis.patch.yml 的 insert id 必须存在
 *   · index.js 的路由前缀必须带 /api（connection.fetch 只接受 /api 下）
 *   · PowerShell 脚本必须纯 ASCII（cmd/PS 按 ANSI 读，中文会变乱码命令）
 * 用法：node selfcheck.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
let failed = 0
let passed = 0

function ok(name, detail = '') {
  passed++
  console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
}
function bad(name, detail = '') {
  failed++
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}
function check(name, fn) {
  try {
    const detail = fn()
    ok(name, detail || '')
  } catch (e) {
    bad(name, String(e?.message ?? e))
  }
}
function read(p) {
  if (!existsSync(p)) throw new Error(`缺文件：${p}`)
  return readFileSync(p, 'utf8')
}

console.log('dsh-reloader selfcheck')

const pkg = JSON.parse(read(join(ROOT, 'package.json')))

check('package.json: name / type', () => {
  if (!pkg.name) throw new Error('没有 name')
  if (pkg.type !== 'module') throw new Error('type 必须是 module（宿主按 ESM 加载）')
  return pkg.name
})

check('package.json: main 指向存在的文件', () => {
  const p = join(ROOT, pkg.main || '')
  if (!existsSync(p)) throw new Error(`main 不存在：${pkg.main}`)
  return pkg.main
})

check('package.json: exports["./client"] 存在且文件在', () => {
  const entry = pkg.exports?.['./client']
  if (!entry) throw new Error('没有 exports["./client"]，宿主找不到客户端 bundle')
  if (!existsSync(join(ROOT, entry))) throw new Error(`客户端文件不存在：${entry}`)
  return entry
})

check('package.json: dsh.bundle.patch 文件在', () => {
  const patch = pkg.dsh?.bundle?.patch
  if (!patch) throw new Error('没有 dsh.bundle.patch，profile 不会插入本插件')
  if (!existsSync(join(ROOT, patch))) throw new Error(`patch 文件不存在：${patch}`)
  return patch
})

check('package.json: dsh.client.platform = web', () => {
  const client = pkg.dsh?.client
  if (!client) throw new Error('没有 dsh.client')
  if (client.platform !== 'web') throw new Error(`platform=${client.platform}`)
  if (!Array.isArray(client.inject) || client.inject.length === 0) throw new Error('inject 为空')
  return client.inject.join(', ')
})

check('client.js: 模块 id 等于包名', () => {
  const text = read(join(ROOT, 'client.js'))
  const m = /__ModuleLoader__\.load\(\s*\{\s*id:\s*'([^']+)'/.exec(text)
  if (!m) throw new Error('找不到 __ModuleLoader__.load({ id })')
  if (m[1] !== pkg.name) throw new Error(`id=${m[1]}，包名=${pkg.name}`)
  return m[1]
})

check('client.js: 注册 settings.section', () => {
  const text = read(join(ROOT, 'client.js'))
  if (!text.includes("'settings.section'")) throw new Error('没有注册 settings.section')
  return 'OK'
})

check('cordis.patch.yml: insert 里有本包', () => {
  const text = read(join(ROOT, 'cordis.patch.yml'))
  if (!/insert:/.test(text)) throw new Error('没有 insert 段')
  if (!text.includes('name: dsh-reloader')) throw new Error('insert 里没有 name: dsh-reloader')
  return 'OK'
})

check('index.js: 路由前缀带 /api', () => {
  const text = read(join(ROOT, 'index.js'))
  const m = /const API = '([^']+)'/.exec(text)
  if (!m) throw new Error('找不到 API 常量')
  if (!m[1].startsWith('/api/')) throw new Error(`API=${m[1]}，connection.fetch 只接受 /api 下的路径`)
  return m[1]
})

check('index.js: 引用的 lib 文件都在', () => {
  const text = read(join(ROOT, 'index.js'))
  const imports = [...text.matchAll(/from '(\.\/[^']+)'/g)].map((m) => m[1])
  for (const rel of imports) {
    if (!existsSync(join(ROOT, rel))) throw new Error(`缺 ${rel}`)
  }
  return imports.join(', ')
})

check('scripts: 两个 PowerShell 脚本都在', () => {
  for (const f of ['launch-restarter.ps1', 'restart.ps1']) {
    if (!existsSync(join(ROOT, 'scripts', f))) throw new Error(`缺 scripts/${f}`)
  }
  return 'launch-restarter.ps1, restart.ps1'
})

check('scripts: 纯 ASCII（含中文会被 cmd/PS 读错）', () => {
  for (const f of ['launch-restarter.ps1', 'restart.ps1']) {
    const text = read(join(ROOT, 'scripts', f))
    const badChars = [...text].filter((c) => c.charCodeAt(0) > 127)
    if (badChars.length) throw new Error(`${f} 有 ${badChars.length} 个非 ASCII 字符`)
  }
  return 'OK'
})

check('restart.ps1: 必须只杀主进程、不 /T（否则会连重启器一起杀）', () => {
  const text = read(join(ROOT, 'scripts', 'restart.ps1'))
  if (!/taskkill\.exe \/PID \$AppPid \/F/.test(text)) throw new Error('找不到 taskkill /PID $AppPid /F')
  if (/taskkill\.exe \/PID \$AppPid \/T/.test(text)) throw new Error('主进程那一步不能带 /T')
  return 'OK'
})

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
