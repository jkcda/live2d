/**
 * 抓一张「她此刻会看到的图」，存成文件让你自己用眼睛看。
 *
 * ── 为什么需要这个 ──
 *
 * 截图这一层现在**只到采集为止**：图还没接进对话（渲染层还没把图随请求附上、
 * ChatMessage 也还不支持 content block）。所以「她能不能看到」暂时没法在聊天里验，
 * 能验的是**抓到的到底是什么** —— 那就把它存下来，用眼睛看：
 *
 *   · 截的是不是你想让她看的那块窗口（不是整屏、不是别的东西）
 *   · 比例对不对、有没有把标题栏也算进去
 *   · 1024 长边压过之后，字还认不认得出来（这直接决定她能不能读懂内容）
 *
 * 用法：
 *   node tools/grab-screen.mjs                        # 存到 logs/screen-<时间>.jpg
 *   node tools/grab-screen.mjs --out d:\shot.jpg
 *   node tools/grab-screen.mjs --gated                # 走变化门控（默认绕过）
 *
 * 注意：脚本会先把「你现在的前台窗口」记下来，起完应用再还回去 ——
 * 否则新开的窗口会抢走前台，抓到的就是她自己了。
 */

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const electron = require('electron')

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const has = (name) => args.includes(name)

const PORT = Number(argOf('--port', '9351'))
const GATED = has('--gated')
const ROOT = process.cwd()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Win32（还前台用）────────────────────────────────────────────────

const koffi = require('koffi')
const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
user32.func('bool SetProcessDPIAware()')()

const GetForegroundWindow = user32.func('uint64 GetForegroundWindow()')
const SetForegroundWindow = user32.func('bool SetForegroundWindow(uint64 hWnd)')
const IsWindow = user32.func('bool IsWindow(uint64 hWnd)')
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(uint64 hWnd, _Out_ uint32 *pid)')
const AttachThreadInput = user32.func('bool AttachThreadInput(uint32 a, uint32 b, bool f)')
const keybd_event = user32.func('void keybd_event(uint8 vk, uint8 scan, uint32 flags, uint64 extra)')
const GetCurrentThreadId = kernel32.func('uint32 GetCurrentThreadId()')

/** 把前台还给某个窗口。系统的前台锁会挡直接调用，所以要那几个标准绕法 */
async function restoreForeground(hwnd) {
  if (!hwnd || !IsWindow(hwnd)) return false
  if (SetForegroundWindow(hwnd) && GetForegroundWindow() === hwnd) return true

  const pidBuf = new Uint32Array(1)
  const fgThread = GetWindowThreadProcessId(GetForegroundWindow(), pidBuf)
  const me = GetCurrentThreadId()
  if (fgThread && fgThread !== me) AttachThreadInput(fgThread, me, true)
  const ok = SetForegroundWindow(hwnd)
  if (fgThread && fgThread !== me) AttachThreadInput(fgThread, me, false)
  if (ok && GetForegroundWindow() === hwnd) return true

  keybd_event(0x12, 0, 0, 0)
  keybd_event(0x12, 0, 2, 0)
  await sleep(80)
  return SetForegroundWindow(hwnd) && GetForegroundWindow() === hwnd
}

// ── CDP ──────────────────────────────────────────────────────────────

async function findPage(timeoutMs = 40000) {
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

// ── 主流程 ───────────────────────────────────────────────────────────

const outPath = resolve(argOf('--out', join('logs', `screen-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`)))
const profile = mkdtempSync(join(tmpdir(), 'nexus-grab-'))
const env = { ...process.env }
delete env.VITE_DEV_SERVER_URL

const before = GetForegroundWindow()
console.log('起一个应用实例（验证用的，抓完就关）…')
const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', (d) => (log += d.toString()))
child.stderr.on('data', (d) => (log += d.toString()))

let cdp = null
try {
  const page = await findPage()
  cdp = await connect(page.webSocketDebuggerUrl)
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面里抛异常了')
    return r.result.value
  }

  // 等桥接挂上
  for (let i = 0; i < 60; i++) {
    if ((await ev('typeof window.nexus?.captureScreen')) === 'function') break
    await sleep(250)
  }

  // 新窗口会抢走前台，还回去 —— 不然抓到的就是她自己
  const restored = await restoreForeground(before)
  console.log(restored ? '已把前台还给你原来的窗口' : '⚠ 前台没能还回去（下面可能抓到她自己的窗口）')

  // 观察器要等一个 tick + 变化门控，最多等 6 秒
  let act = null
  for (let i = 0; i < 24; i++) {
    act = await ev('window.nexus.getActivity()')
    if (act) break
    await sleep(250)
  }
  console.log(`前台窗口（她眼里的）: ${act ? `${act.process} / ${act.title}` : '看不到（null）'}`)

  const frame = await ev(`window.nexus.captureScreen(${GATED ? 'false' : 'true'})`)
  if (!frame) {
    console.log('\n✗ 没抓到图。可能的原因：')
    console.log('   1. 前台是她自己的窗口 / 桌面（没标题的窗口读不到）')
    console.log('   2. 当前窗口命中了黑名单（密码、银行、简历… 见 electron/observer.ts）')
    console.log('   3. 观察被暂停了')
    if (GATED) console.log('   4. 画面和上一张没什么变化（变化门控拦下了）—— 去掉 --gated 再试')
    process.exitCode = 1
  } else {
    const b64 = String(frame.dataUrl).replace(/^data:image\/jpeg;base64,/, '')
    const buf = Buffer.from(b64, 'base64')
    mkdirSync(resolve(outPath, '..'), { recursive: true })
    writeFileSync(outPath, buf)
    console.log()
    console.log('✅ 抓到了')
    console.log(`   文件   : ${outPath}`)
    console.log(`   大小   : ${frame.width}x${frame.height}（长边压到 1024，JPEG q80）`)
    console.log(`   体积   : ${(buf.length / 1024).toFixed(0)} KB`)
    console.log(`   哈希   : ${frame.hash}（dHash，用来做变化门控）`)
    console.log()
    console.log('   打开看一眼：截的是不是那块窗口、比例对不对、标题栏有没有、字认不认得出来')
  }
} catch (err) {
  console.log(`✗ ${err.message}`)
  const tail = log.trim().split('\n').slice(-8)
  if (tail.length) for (const l of tail) console.log(`  ${l}`)
  process.exitCode = 1
} finally {
  cdp?.close()
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* 临时目录 */
  }
}
