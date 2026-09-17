/**
 * 验证「她看得见你在干嘛」这条链。
 *
 * ── 为什么单写一个 ──
 *
 * 前台窗口观察整条链**每一环都是看不见的**：
 *   · 主进程到底读到了哪个窗口？
 *   · 黑名单是在主进程拦的，还是只是没读到？
 *   · 暂停开关真的断了信号，还是只是界面上那个勾变了？
 * 肉眼只能看出「她好像知道你开了浏览器」，看不出上面任何一条。
 *
 * ── 怎么做到可控 ──
 *
 * 借用户自己的窗口当靶子是不行的（打扰他，而且标题不受指挥）。
 * 所以脚本自己开一个**靶子窗口**（tools/verify-target.cjs），
 * 标题由文件驱动 —— 换标题不用重启进程，窗口句柄不变，测的才是同一件事。
 * 再直调 user32 把靶子推到前台，然后通过 CDP 问渲染层要快照。
 *
 * ── 测的到底是什么 ──
 *
 *   ① 预载桥接在不在
 *   ② koffi 在真实主进程里加载成功（asarUnpack 出问题的第一现场）
 *   ③ 前台窗口换了，快照跟着换
 *   ④ 标题命中黑名单 → 快照为 null（**在主进程**拦掉，标题根本没进内存）
 *   ⑤ 标题改回 → 快照恢复（证明是过滤，不是观察挂了）
 *   ⑥ 暂停 → null，恢复 → 回来
 *   ⑦ 面板打开导致应用自己成为前台窗口时，**不该**把「她在跟你聊天」
 *      当成「你在用 NexusLive2D」
 *   ⑧ agent 服务的工具表里有 what_is_user_doing
 *
 * 用法（先 pnpm build；不需要 dev server，脚本直接跑 dist 的产物）：
 *   node tools/verify-activity.mjs
 *   node tools/verify-activity.mjs --keep     # 验证完不关窗口，自己看
 */

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const has = (name) => args.includes(name)

const PORT = Number(argOf('--port', '9337'))
const AGENT = argOf('--agent', 'http://127.0.0.1:8766')
const KEEP = has('--keep')
const TARGET_TITLE = 'NEXUS 前台窗口靶子'
const APP_TITLE = 'Nexus Live2D'
const ROOT = process.cwd()
const electron = require('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Win32 ────────────────────────────────────────────────────────────

const koffi = require('koffi')
const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')

const GetForegroundWindow = user32.func('uint64 GetForegroundWindow()')
const SetForegroundWindow = user32.func('bool SetForegroundWindow(uint64 hWnd)')
const ShowWindow = user32.func('bool ShowWindow(uint64 hWnd, int32 nCmdShow)')
const GetTopWindow = user32.func('uint64 GetTopWindow(uint64 hWnd)')
const GetWindow = user32.func('uint64 GetWindow(uint64 hWnd, uint32 uCmd)')
const IsWindowVisible = user32.func('bool IsWindowVisible(uint64 hWnd)')
const GetWindowTextW = user32.func('int32 GetWindowTextW(uint64 hWnd, _Out_ uint16 *lp, int32 nMax)')
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(uint64 hWnd, _Out_ uint32 *pid)')
const AttachThreadInput = user32.func('bool AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)')
const keybd_event = user32.func('void keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uint64 dwExtraInfo)')
const GetCurrentThreadId = kernel32.func('uint32 GetCurrentThreadId()')

const GW_HWNDNEXT = 2
const SW_RESTORE = 9
const VK_MENU = 0x12
const KEYEVENTF_KEYUP = 0x0002

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

/** 遍历顶层窗口，找出属于指定 PID 的可见窗口 */
function windowsOfPid(pid) {
  const found = []
  let h = GetTopWindow(0)
  let guard = 0
  while (h && guard++ < 3000) {
    if (pidOf(h) === pid && IsWindowVisible(h)) found.push({ hwnd: h, title: titleOf(h) })
    h = GetWindow(h, GW_HWNDNEXT)
  }
  return found
}

async function waitForWindow(pid, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const w = windowsOfPid(pid).find((x) => x.title)
    if (w) return w
    await sleep(400)
  }
  return null
}

/**
 * 把某个窗口推到前台。
 *
 * 直接 SetForegroundWindow 通常会被前台锁挡掉（我们的进程不是当前前台、
 * 也没收到过用户输入），所以失败时用两个标准绕法：
 *   · AttachThreadInput —— 把自己的输入队列挂到前台窗口那条线程上
 *   · 模拟按一下 ALT —— 系统会把「刚发生过用户输入」记上，前台锁随之松开
 * 两个都只是为了让测试能控制前台，不影响被测代码。
 */
async function forceForeground(hwnd) {
  ShowWindow(hwnd, SW_RESTORE)
  if (SetForegroundWindow(hwnd) && GetForegroundWindow() === hwnd) return 'SetForegroundWindow'

  const fg = GetForegroundWindow()
  const pidBuf = new Uint32Array(1)
  const fgThread = fg ? GetWindowThreadProcessId(fg, pidBuf) : 0
  const me = GetCurrentThreadId()
  if (fgThread && fgThread !== me) AttachThreadInput(fgThread, me, true)
  const ok1 = SetForegroundWindow(hwnd)
  if (fgThread && fgThread !== me) AttachThreadInput(fgThread, me, false)
  if (ok1 && GetForegroundWindow() === hwnd) return 'AttachThreadInput'

  keybd_event(VK_MENU, 0, 0, 0)
  keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
  await sleep(80)
  const ok2 = SetForegroundWindow(hwnd)
  if (ok2 && GetForegroundWindow() === hwnd) return '模拟 ALT'
  return null
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
  throw new Error('等不到调试端口（应用起来了吗？pnpm build 跑过了吗？）')
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
  return ok
}
const skip = (label, why) => {
  console.log(`  ⏭  ${label} —— ${why}`)
}

// ── 主流程 ───────────────────────────────────────────────────────────

const base = mkdtempSync(join(tmpdir(), 'nexus-verify-activity-'))
const profileApp = join(base, 'app')
const profileTarget = join(base, 'target')
const titleFile = join(base, 'title.txt')
writeFileSync(titleFile, TARGET_TITLE, 'utf8')
const writeTitle = (t) => writeFileSync(titleFile, t, 'utf8')

const logs = { app: '', target: '' }
const env = { ...process.env }
delete env.VITE_DEV_SERVER_URL // 不设的话主进程加载 dist/index.html，这才是打包形态

const appProc = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileApp}`], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
appProc.stdout.on('data', (d) => (logs.app += d.toString()))
appProc.stderr.on('data', (d) => (logs.app += d.toString()))

const origFg = GetForegroundWindow()
let targetProc = null
let cdp = null

function cleanup() {
  if (!KEEP) {
    for (const p of [targetProc, appProc]) {
      if (p?.pid) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
    }
    cdp?.close()
    // 把前台还回去，别让用户莫名其妙换了窗口
    if (origFg) SetForegroundWindow(origFg)
    try {
      rmSync(base, { recursive: true, force: true })
    } catch {
      /* 目录还占着就算了，临时目录 */
    }
  }
}

async function main() {
  console.log('启动真实主进程（dist 产物，不是 dev server）…')

  const page = await findPage()
  cdp = await connect(page.webSocketDebuggerUrl)
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? '页面里抛异常了')
    }
    return r.result.value
  }

  console.log('启动前台窗口靶子…\n')
  targetProc = spawn(electron, ['tools/verify-target.cjs', `--user-data-dir=${profileTarget}`], {
    cwd: ROOT,
    env: { ...env, NEXUS_TITLE_FILE: titleFile, NEXUS_TARGET_TITLE: TARGET_TITLE },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  targetProc.stdout.on('data', (d) => (logs.target += d.toString()))
  targetProc.stderr.on('data', (d) => (logs.target += d.toString()))

  const targetWin = await waitForWindow(targetProc.pid)
  if (!targetWin) throw new Error('靶子窗口没起来，看下面的进程输出')

  // 等预载桥接挂上（页面刚加载时 window.nexus 可能还没有）
  for (let i = 0; i < 40; i++) {
    if ((await ev('typeof window.nexus?.getActivity')) === 'function') break
    await sleep(250)
  }

  const waitSnap = async (pred, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    let last = 'never'
    while (Date.now() < deadline) {
      const s = await ev('window.nexus.getActivity()')
      last = JSON.stringify(s)
      if (pred(s)) return s
      await sleep(400)
    }
    return { __timeout: last }
  }

  console.log('='.repeat(62))
  console.log('前台窗口观察')
  console.log('='.repeat(62))

  check('预载桥接 window.nexus.getActivity 存在', (await ev('typeof window.nexus?.getActivity')) === 'function')

  const status = await ev('window.nexus.observeStatus()')
  check(
    '观察器可用（koffi 在真实主进程里加载成功）',
    status?.available === true,
    JSON.stringify(status),
  )

  const how = await forceForeground(targetWin.hwnd)
  const win = win => (win ? `0x${win.toString(16)}` : '(无)')
  check(
    '靶子窗口推到了前台',
    how !== null,
    how ? `方式：${how}，句柄 ${win(targetWin.hwnd)}` : `SetForegroundWindow 被前台锁挡住了，当前前台 ${win(GetForegroundWindow())}`,
  )

  if (!how) {
    console.log('\n  前台控制不了，后面的断言没有意义，先停在这里。')
    return
  }

  const s1 = await waitSnap((s) => s && s.title === TARGET_TITLE, 8000)
  check(
    '前台窗口换了 → 快照跟着换',
    s1 && s1.title === TARGET_TITLE,
    s1?.title === TARGET_TITLE ? `process=${s1.process} since=${s1.since ? '有' : '无'} for=${s1.forSeconds}s` : `拿到的是 ${JSON.stringify(s1)}`,
  )

  // ── 黑名单（隐私边界）──
  writeTitle('密码管理器 - 验证用标题')
  const s2 = await waitSnap((s) => s === null, 9000)
  check('标题命中黑名单 → 快照为 null（在主进程就拦掉了）', s2 === null, s2 === null ? '敏感标题没有进内存' : `拿到的是 ${JSON.stringify(s2)}`)

  writeTitle(TARGET_TITLE)
  const s3 = await waitSnap((s) => s && s.title === TARGET_TITLE, 9000)
  check('标题改回 → 快照恢复', Boolean(s3 && s3.title === TARGET_TITLE), '证明是过滤，不是观察坏了')

  // ── 暂停开关 ──
  await ev('window.nexus.setObservePaused(true)')
  const s4 = await waitSnap((s) => s === null, 5000)
  check('暂停观察 → 快照为 null', s4 === null)

  await ev('window.nexus.setObservePaused(false)')
  const s5 = await waitSnap((s) => s && s.title === TARGET_TITLE, 9000)
  check('恢复观察 → 快照回来', Boolean(s5 && s5.title === TARGET_TITLE))

  // ── 她自己的窗口 ──
  /*
   * 这一条是真实场景里最要紧的：对话面板必须能拿键盘焦点，
   * 所以主进程会在面板打开时 focus() —— 于是"他问你我在干嘛"的那一刻，
   * 前台窗口其实就是应用自己。不排掉的话，她看到的永远是"你在用 NexusLive2D"。
   */
  await ev('window.nexus.setPanelOpen(true)')
  await sleep(1200)

  const appWin = windowsOfPid(appProc.pid).find((w) => w.title === APP_TITLE)
  if (!appWin) {
    skip('应用自己的窗口不算「他在干嘛」', '找不到应用自己的窗口，这条测不了')
  } else {
    /*
     * 面板打开时主进程会自己 focus()，但**程序化** focus 常被 Windows 前台锁挡掉
     * （真实场景里前面有一次真实点击，所以那边能成）。这里直接把它推上前台，
     * 让被测的是观察器的判断，而不是 Windows 愿不愿意给焦点。
     */
    let fgIsApp = GetForegroundWindow() === appWin.hwnd
    if (!fgIsApp) {
      await forceForeground(appWin.hwnd)
      fgIsApp = GetForegroundWindow() === appWin.hwnd
    }

    if (!fgIsApp) {
      skip('应用自己的窗口不算「他在干嘛」', `推不上前台（前台=${win(GetForegroundWindow())}），这条测不了`)
    } else {
      await sleep(3500) // 够跨过变化门控（2s）+ 轮询（1s）
      const s6 = await ev('window.nexus.getActivity()')
      const isSelf = Boolean(s6 && s6.title === APP_TITLE)
      const ok = Boolean(s6 && s6.title === TARGET_TITLE)
      check(
        '应用自己成为前台 → 快照仍是上一次的真实活动',
        ok,
        isSelf ? '❌ 看到的是她自己 —— 面板一开，她就以为你在用 NexusLive2D' : ok ? `仍然是 ${s6.process} / ${s6.title}` : `拿到的是 ${JSON.stringify(s6)}`,
      )
    }
  }

  // ── agent 服务那边有没有这个工具 ──
  try {
    const tools = await (await fetch(`${AGENT}/tools`)).json()
    // 形状是 { builtin: string[], mcp: {...} }（见 agent/src/routes/chat.ts）
    const names = Array.isArray(tools) ? tools.map((t) => t.name ?? t) : (tools.builtin ?? [])
    check('agent 工具表里有 what_is_user_doing', names.includes('what_is_user_doing'), `内置工具 ${names.length} 个：${names.join(', ')}`)
  } catch (err) {
    skip('agent 工具表里有 what_is_user_doing', `agent 服务没起来（${err.message}），启动后重跑这条`)
  }
}

try {
  await main()
} catch (err) {
  console.log(`\n✗ 验证中断：${err.message}`)
  checks.push(['验证跑完', false])
} finally {
  const bad = checks.filter(([, ok]) => !ok)
  console.log()
  console.log('='.repeat(62))
  console.log(bad.length ? `有 ${bad.length} 项没通过 ❌` : `全部通过 ✅（${checks.length} 项）`)
  console.log('='.repeat(62))

  const interesting = logs.app
    .split('\n')
    .filter((l) => /\[main\]|\[observer\]|\[win-style\]/.test(l))
    .map((l) => l.trim())
  if (interesting.length) {
    console.log()
    console.log('主进程日志：')
    for (const l of interesting.slice(0, 12)) console.log(`  ${l}`)
  }

  cleanup()
  if (KEEP) console.log('\n窗口保留中（--keep），Ctrl+C 结束')
  process.exit(bad.length ? 1 : 0)
}
