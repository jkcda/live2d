/**
 * 构建产物 / 打包版「能不能真的跑起来」的检查。
 *
 * 为什么需要：`pnpm dev` 走的是 dev server（http://localhost:5176），
 * 而打包版走的是 **file://** —— 这两条路的差别正是最容易翻车的地方：
 *   · fetch / XHR 在 file:// 下的行为不一样（模型、角色包都是本地文件）
 *   · 资源路径（base、public/ 拷贝位置、asar 内外的边界）不一样
 * 光看「窗口起来了」看不出来，因为窗口起来和画得出角色是两件事。
 *
 * 所以这里直接连渲染层，把「页面自己怎么说」打出来：
 *   · 页面正文（应用有错误 UI 的话，错误就写在里面）
 *   · canvas 数量（有没有真的建出画布）
 *   · 几个关键 fetch 的结果（模型、角色包）
 *
 * 用法：
 *   node tools/check-built.mjs                                   # dist 产物 + electron
 *   node tools/check-built.mjs --exe release/win-unpacked/NexusLive2D.exe
 */

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const electron = require('electron')
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const EXE = argOf('--exe', '')
const PORT = Number(argOf('--port', '9339'))
const ROOT = process.cwd()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const profile = mkdtempSync(join(tmpdir(), 'nexus-check-built-'))
const env = { ...process.env }
delete env.VITE_DEV_SERVER_URL

const proc = EXE
  ? spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(electron, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

let out = ''
proc.stdout.on('data', (d) => (out += d.toString()))
proc.stderr.on('data', (d) => (out += d.toString()))

async function findPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* 还没起来 */
    }
    await sleep(400)
  }
  throw new Error('等不到调试端口')
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const pending = new Map()
    let next = 1
    ws.onopen = () =>
      resolve({
        send: (method, params) =>
          new Promise((res, rej) => {
            const id = next++
            pending.set(id, { res, rej })
            ws.send(JSON.stringify({ id, method, params }))
          }),
        close: () => ws.close(),
      })
    ws.onerror = (e) => reject(new Error(`CDP 失败：${e.message ?? e}`))
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (!msg.id || !pending.has(msg.id)) return
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
    }
  })
}

try {
  const page = await findPage()
  const cdp = await connect(page.webSocketDebuggerUrl)
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) return `⚠ 页面抛异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`
    return r.result.value
  }

  await sleep(4000) // 给渲染层时间去加载资源

  console.log('='.repeat(62))
  console.log(EXE ? `打包版：${EXE}` : 'dist 产物（electron .）')
  console.log('='.repeat(62))
  console.log(`页面地址 : ${await ev('location.href')}`)
  console.log(`canvas   : ${await ev("document.querySelectorAll('canvas').length")} 个`)
  console.log(`就绪状态 : ${await ev('document.readyState')}`)

  console.log()
  console.log('关键资源能不能读到：')
  const probe = await ev(`(async () => {
    const urls = ['./models/Haru/Haru.model3.json', './models/', './characters/index.json']
    const res = {}
    for (const u of urls) {
      try { const r = await fetch(u, { method: 'GET' }); res[u] = 'HTTP ' + r.status } catch (e) { res[u] = 'ERR ' + (e && e.message) }
    }
    return res
  })()`)
  console.log(JSON.stringify(probe, null, 2))

  console.log()
  console.log('页面正文（前 500 字，应用自己的错误提示会在这里）：')
  const text = await ev('document.body.innerText.slice(0, 500)')
  console.log(text ? String(text).split('\n').map((l) => `  ${l}`).join('\n') : '  (空)')

  const errs = out.split('\n').filter((l) => /error|failed|Failed|ERR/.test(l))
  if (errs.length) {
    console.log()
    console.log('进程输出里的错误行：')
    for (const l of errs.slice(0, 8)) console.log(`  ${l.trim()}`)
  }
  cdp.close()
} catch (err) {
  console.log(`✗ ${err.message}`)
  const tail = out.trim().split('\n').slice(-10)
  if (tail.length) {
    console.log('\n进程输出（最后 10 行）：')
    for (const l of tail) console.log(`  ${l}`)
  }
} finally {
  spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* 临时目录，占着就算了 */
  }
}
