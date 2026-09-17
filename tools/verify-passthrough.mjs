/**
 * 验证「穿透之后能回来」。
 *
 * ── 为什么这条必须用真鼠标 ──
 *
 * 穿透的坏法**没法用合成事件验出来**：CDP 的 Input.dispatchMouseEvent 是
 * 直接塞进渲染进程的，根本不经过 Windows 的命中测试 —— 窗口正在忽略鼠标，
 * 合成点击照样能点到按钮，于是「坏了」和「好了」看起来一模一样。
 *
 * 只有真的移动系统光标、真的发一次系统点击，才复现得出用户说的
 * 「点了没反应」。所以这里直调 user32：
 *   SetCursorPos 移光标 → mouse_event 真点一下
 * 再用 GetWindowLongW 读窗口的 WS_EX_TRANSPARENT —— 那一位就是
 * 「这个窗口现在收不收鼠标」的真相。
 *
 * ── 断言 ──
 *   ① 点「穿透」之后：窗口真的进入穿透态（样式位 + 页面状态两边都对得上）
 *   ② 光标移到提示条上：窗口恢复收鼠标（靠 forward 转发的 mousemove + hover）
 *   ③ 真点一下提示条：穿透退出，窗口恢复收鼠标
 *      ← 这一条只有点击**真的落在她窗口上**才可能通过；
 *        穿透没退干净的话点击会穿到桌面上，状态不会变
 *
 * 用法（先 pnpm build）：
 *   node tools/verify-passthrough.mjs
 *   node tools/verify-passthrough.mjs --keep
 */

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const has = (name) => args.includes(name)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const PORT = Number(argOf('--port', '9341'))
const KEEP = has('--keep')
const ROOT = process.cwd()
const electron = require('electron')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Win32 ────────────────────────────────────────────────────────────

const koffi = require('koffi')
const user32 = koffi.load('user32.dll')

/*
 * ★ 先声明本进程 DPI 感知，再碰任何坐标 API。
 *
 * 不声明的话这一整套会静默错位：非 DPI 感知进程拿到的 GetWindowRect 是
 * **虚拟化（缩放后）坐标**，而 SetCursorPos 走的是另一套 —— 屏幕上 125% 缩放时
 * 两者差 1.25 倍，于是"把光标移到按钮上"实际移到了按钮外面（还可能是别的窗口上），
 * 表现就是「页面收不到任何鼠标事件」，非常难查。
 * 声明之后 GetWindowRect / SetCursorPos / WindowFromPoint 统一是物理像素，
 * 页面里的 CSS 像素再乘 devicePixelRatio 就是屏幕坐标。
 */
user32.func('bool SetProcessDPIAware()')()

const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' })
const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })

const GetTopWindow = user32.func('uint64 GetTopWindow(uint64 hWnd)')
const GetWindow = user32.func('uint64 GetWindow(uint64 hWnd, uint32 uCmd)')
const IsWindowVisible = user32.func('bool IsWindowVisible(uint64 hWnd)')
const GetWindowTextW = user32.func('int32 GetWindowTextW(uint64 hWnd, _Out_ uint16 *lp, int32 nMax)')
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(uint64 hWnd, _Out_ uint32 *pid)')
const GetWindowLongW = user32.func('int32 GetWindowLongW(uint64 hWnd, int32 nIndex)')
const GetWindowRect = user32.func('bool GetWindowRect(uint64 hWnd, _Out_ RECT *rect)')
const SetCursorPos = user32.func('bool SetCursorPos(int32 X, int32 Y)')
const GetCursorPos = user32.func('bool GetCursorPos(_Out_ POINT *p)')
const mouse_event = user32.func('void mouse_event(uint32 dwFlags, int32 dx, int32 dy, uint32 dwData, uint64 dwExtraInfo)')

const GWL_EXSTYLE = -20
const GW_HWNDNEXT = 2
const WS_EX_TRANSPARENT = 0x00000020
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004

function titleOf(hwnd) {
  const buf = new Uint16Array(512)
  const len = GetWindowTextW(hwnd, buf, 512)
  if (len <= 0) return ''
  return Buffer.from(buf.buffer, 0, len * 2).toString('utf16le')
}

function pidOf(hwnd) {
  const buf = new Uint32Array(1)
  GetWindowThreadProcessId(hwnd, buf)
  return buf[0]
}

function mainWindowOf(pid) {
  let h = GetTopWindow(0)
  let guard = 0
  while (h && guard++ < 3000) {
    if (pidOf(h) === pid && IsWindowVisible(h) && titleOf(h)) return h
    h = GetWindow(h, GW_HWNDNEXT)
  }
  return 0n
}

/** 光标底下这个窗口收不收鼠标（WS_EX_TRANSPARENT = 不收） */
const ignoringMouse = (hwnd) => (GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TRANSPARENT) !== 0

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(200)
  }
  console.log(`    （等「${what}」超时）`)
  return false
}

// ── CDP ──────────────────────────────────────────────────────────────

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

// ── 断言 ─────────────────────────────────────────────────────────────

const checks = []
const check = (label, ok, detail = '') => {
  checks.push([label, ok])
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` —— ${detail}` : ''}`)
}

// ── 主流程 ───────────────────────────────────────────────────────────

const profile = mkdtempSync(join(tmpdir(), 'nexus-verify-pass-'))
const env = { ...process.env }
delete env.VITE_DEV_SERVER_URL

const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (d) => (out += d.toString()))
child.stderr.on('data', (d) => (out += d.toString()))

const startCursor = { x: 0, y: 0 }
GetCursorPos(startCursor)

let cdp = null

try {
  const page = await findPage()
  cdp = await connect(page.webSocketDebuggerUrl)
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面里抛异常了')
    return r.result.value
  }

  const hwnd = await waitForWindowHwnd(child.pid)
  if (!hwnd) throw new Error('找不到她的窗口')
  const rect = { left: 0, top: 0, right: 0, bottom: 0 }
  GetWindowRect(hwnd, rect)
  if (!rect.right) throw new Error('读不到窗口位置（GetWindowRect 没填上）')

  // CSS 像素 → 屏幕像素的倍数（125% 缩放时是 1.25）
  const dpr = await ev('window.devicePixelRatio')
  console.log(
    `窗口句柄 0x${hwnd.toString(16)}  物理位置 (${rect.left}, ${rect.top})  ` +
      `大小 ${rect.right - rect.left}x${rect.bottom - rect.top}  缩放 ${dpr}\n`,
  )

  /** 页面里某个元素中心的屏幕坐标 */
  const screenPointOf = async (selector, byText = false) => {
    const p = await ev(byText
      ? `(() => { const el = [...document.querySelectorAll('.btn')].find((b) => b.textContent.trim() === ${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`
      : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    if (!p) return null
    return { x: Math.round(rect.left + p.x * dpr), y: Math.round(rect.top + p.y * dpr) }
  }

  const isPassthrough = () => ev("document.querySelector('.app')?.classList.contains('passthrough') === true")
  const moveTo = (p) => SetCursorPos(p.x, p.y)
  const realClick = () => {
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
  }

  console.log('='.repeat(62))
  console.log('穿透能不能回来')
  console.log('='.repeat(62))
  console.log(`  起点：收鼠标 = ${!ignoringMouse(hwnd)}，穿透态 = ${await isPassthrough()}`)

  const barShown = () => ev("Boolean(document.querySelector('.control-bar'))")

  /*
   * 控制条是「鼠标压在她身上」才浮现的，所以得先找一个真的压在轮廓上的点。
   * 不能猜坐标（轮廓判定是按贴图 alpha 走的，猜中心很可能落在她胳膊之间的空气里），
   * 也不该用顶部拖动条 —— 那片是 -webkit-app-region: drag，
   * 系统把它的鼠标事件当非客户区吃掉了，@mouseenter 根本不触发。
   * 所以这里直接在窗口里扫一遍：哪个点能把控制条唤出来，就是它。
   */
  async function findHoverPoint() {
    const stripTry = await screenPointOf('.title-strip')
    if (stripTry) {
      moveTo(stripTry)
      await sleep(400)
      if (await barShown()) return { p: stripTry, how: '标题条' }
    }
    for (let cy = 120; cy <= 600; cy += 40) {
      for (let cx = 40; cx <= 380; cx += 40) {
        const p = { x: Math.round(rect.left + cx * dpr), y: Math.round(rect.top + cy * dpr) }
        moveTo(p)
        await sleep(120)
        if (await barShown()) return { p, how: `角色 (${cx},${cy})` }
      }
    }
    return null
  }

  const hover = await findHoverPoint()
  if (!hover) throw new Error('找不到能让她浮现控制条的位置（她画出来了吗？）')
  console.log(`  悬停点：${hover.how}`)

  const passBtn = await screenPointOf('穿透', true)
  if (!passBtn) throw new Error('找不到「穿透」按钮')
  moveTo(passBtn)
  await sleep(250)
  realClick()
  await sleep(700)

  const inPassthrough = await isPassthrough()
  const ignoringNow = ignoringMouse(hwnd)
  check(
    '点「穿透」→ 窗口真的不收鼠标了',
    inPassthrough && ignoringNow,
    `页面穿透态=${inPassthrough}，WS_EX_TRANSPARENT=${ignoringNow}`,
  )

  // ② 光标移到提示条上 —— 靠 forward 转发的 mousemove，窗口应该重新收鼠标
  const hint = await screenPointOf('.passthrough-hint')
  if (!hint) throw new Error('找不到提示条')
  moveTo(hint)
  const hovered = await waitFor(() => !ignoringMouse(hwnd), 3000, '窗口恢复收鼠标')
  check('光标移到提示条上 → 窗口重新收鼠标（提示条变成可点的）', hovered, hovered ? '' : '悬停没能把交互打开')

  // ③ 真点一下
  realClick()
  await sleep(700)
  const backToInteractive = !(await isPassthrough())
  check(
    '真点一下提示条 → 穿透退出',
    backToInteractive && !ignoringMouse(hwnd),
    backToInteractive ? '点击落在了她窗口上（穿到桌面的话这条不会变）' : '还是穿透态',
  )

  console.log()
  console.log('='.repeat(62))
  const bad = checks.filter(([, ok]) => !ok).length
  console.log(bad ? `有 ${bad} 项没通过 ❌` : `全部通过 ✅（${checks.length} 项）`)
  console.log('='.repeat(62))

  if (bad) {
    const lines = out.split('\n').filter((l) => l.includes('[main]')).map((l) => l.trim())
    if (lines.length) {
      console.log('\n主进程日志：')
      for (const l of lines.slice(-10)) console.log(`  ${l}`)
    }
  }
} catch (err) {
  console.log(`\n✗ 验证中断：${err.message}`)
  const tail = out.trim().split('\n').slice(-8)
  if (tail.length) for (const l of tail) console.log(`  ${l}`)
  process.exitCode = 1
} finally {
  cdp?.close()
  if (!KEEP) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    // 把光标还回去，别让用户莫名其妙发现鼠标跑了
    SetCursorPos(startCursor.x, startCursor.y)
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* 临时目录 */
    }
  } else {
    console.log('\n窗口保留中（--keep）')
  }
}

/** 等窗口出现（主进程刚起时还没有） */
async function waitForWindowHwnd(pid, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const h = mainWindowOf(pid)
    if (h) return h
    await sleep(400)
  }
  return 0n
}
