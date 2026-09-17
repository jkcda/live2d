/**
 * 验证屏幕截图这一层。
 *
 * ── 为什么单写一个 ──
 *
 * 截图的每一环也都是看不见的，而且**错了很难发现**：
 *   · 截的是全屏还是只有前台窗口那一块？
 *   · 变化门控真的在拦，还是每次都放行（等于每轮塞一张差不多的图）？
 *   · 黑名单管不管截图？还是只管了窗口标题、图照样截？
 *   · 暂停了以后图还截不截？
 * 肉眼只能看出「她好像看到屏幕了」，看不出上面任何一条。
 *
 * ── 测的到底是什么 ──
 *
 *   ① 预载桥接有 captureScreen
 *   ② 抓得到图，且是 JPEG data URL
 *   ③ 长边不超过 1024（降采样真的做了）
 *   ④ 宽高比和前台窗口一致（说明是**裁到窗口**，不是整屏）
 *   ⑤ 同一画面连抓两次，哈希相同（哈希是稳定的，不是随机的）
 *   ⑥ 非 force 调用在最小间隔内返回 null（门控在拦）
 *   ⑦ 观察暂停 → null（暂停真的断了截图，不只是断了标题）
 *   ⑧ 前台标题命中黑名单 → null（黑名单同样管截图）
 *
 * 用法（先 pnpm build）：
 *   node tools/verify-screen.mjs
 *   node tools/verify-screen.mjs --keep     # 验证完不关窗口
 */

import { spawn } from 'node:child_process'
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

const PORT = Number(argOf('--port', '9338'))
const KEEP = has('--keep')
const TARGET_TITLE = 'NEXUS 截图靶子'
const ROOT = process.cwd()
const electron = require('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Win32（把靶子推上前台用）────────────────────────────────────────

const koffi = require('koffi')
const user32 = koffi.load('user32.dll')
const GetTopWindow = user32.func('uint64 GetTopWindow(uint64 hWnd)')
const GetWindow = user32.func('uint64 GetWindow(uint64 hWnd, uint32 uCmd)')
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(uint64 hWnd, _Out_ uint32 *pid)')
const GetWindowTextW = user32.func('int32 GetWindowTextW(uint64 hWnd, _Out_ uint16 *lp, int32 nMax)')
const IsWindowVisible = user32.func('bool IsWindowVisible(uint64 hWnd)')
const SetForegroundWindow = user32.func('bool SetForegroundWindow(uint64 hWnd)')
const GetWindowRect = user32.func('bool GetWindowRect(uint64 hWnd, _Out_ int32 *rect)')
const GetClientRect = user32.func('bool GetClientRect(uint64 hWnd, _Out_ int32 *rect)')
const ClientToScreen = user32.func('bool ClientToScreen(uint64 hWnd, _Inout_ int32 *pt)')
const ShowWindow = user32.func('bool ShowWindow(uint64 hWnd, int32 nCmdShow)')

const GW_HWNDNEXT = 2
const SW_RESTORE = 9

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

function findWindow(pid, titlePart) {
  let h = GetTopWindow(0)
  let guard = 0
  while (h && guard++ < 3000) {
    if (pidOf(h) === pid && IsWindowVisible(h) && titleOf(h).includes(titlePart)) {
      return h
    }
    h = GetWindow(h, GW_HWNDNEXT)
  }
  return 0n
}

/**
 * 窗口的**客户区**尺寸。
 *
 * 用客户区不是 GetWindowRect：主进程那边裁的就是客户区（去掉了标题栏，
 * 因为标题栏里就是窗口标题，可能带文件名）。
 */
function rectOf(hwnd) {
  const c = new Int32Array(4)
  if (!GetClientRect(hwnd, c)) return null
  const pt = new Int32Array([c[0], c[1]])
  if (!ClientToScreen(hwnd, pt)) return null
  return { x: pt[0], y: pt[1], width: c[2] - c[0], height: c[3] - c[1] }
}

async function waitForWindow(pid, titlePart, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const h = findWindow(pid, titlePart)
    if (h) return h
    await sleep(400)
  }
  return 0n
}

// ── CDP ──────────────────────────────────────────────────────────────

async function findPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 还没起来 */
    }
    await sleep(500)
  }
  throw new Error(`CDP 连不上（端口 ${PORT}）`)
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let id = 0
    const pending = new Map()
    const ready = new Promise((res, rej) => {
      ws.addEventListener('open', () => res())
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')))
    })
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result ?? msg)
        pending.delete(msg.id)
      }
    })
    ready.then(() =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res) => {
            const myId = ++id
            pending.set(myId, res)
            ws.send(JSON.stringify({ id: myId, method, params }))
          }),
        close: () => ws.close(),
      }),
    )
    ready.catch(reject)
  })
}

// ── 断言 ─────────────────────────────────────────────────────────────

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? `  —— ${detail}` : ''}`)
}

// ── 主流程 ───────────────────────────────────────────────────────────

const profileTarget = mkdtempSync(join(tmpdir(), 'nexus-screen-target-'))
const profileApp = mkdtempSync(join(tmpdir(), 'nexus-screen-app-'))
const titleFile = join(profileTarget, 'title.txt')
writeFileSync(titleFile, TARGET_TITLE, 'utf8')

let targetProc = null
let appProc = null
let cdp = null

function cleanup() {
  try {
    cdp?.close()
  } catch {
    /* ignore */
  }
  if (!KEEP) {
    targetProc?.kill()
    appProc?.kill()
  }
  if (!KEEP) {
    try {
      rmSync(profileTarget, { recursive: true, force: true })
      rmSync(profileApp, { recursive: true, force: true })
    } catch {
      /* Windows 上可能还被占着，无所谓 */
    }
  }
}

process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

async function main() {
  const env = { ...process.env }
  delete env.VITE_DEV_SERVER_URL

  console.log('启动靶子窗口…')
  targetProc = spawn(electron, ['tools/verify-target.cjs', `--user-data-dir=${profileTarget}`], {
    cwd: ROOT,
    env: { ...env, NEXUS_TITLE_FILE: titleFile, NEXUS_TARGET_TITLE: TARGET_TITLE },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let targetLog = ''
  targetProc.stdout.on('data', (d) => (targetLog += d.toString()))
  targetProc.stderr.on('data', (d) => (targetLog += d.toString()))

  const targetWin = await waitForWindow(targetProc.pid, TARGET_TITLE)
  if (!targetWin) throw new Error(`靶子窗口没起来：\n${targetLog}`)
  ShowWindow(targetWin, SW_RESTORE)
  SetForegroundWindow(targetWin)
  await sleep(800)

  console.log('启动应用主进程…')
  appProc = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    // 验证脚本要能绕过变化门控去抓「同一画面的第二张」（断言⑦⑧用）。
    // 这个后门默认关着 —— 见 main.ts 里 ALLOW_FORCE_CAPTURE 的注释。
    env: { ...env, NEXUS_ALLOW_FORCE_CAPTURE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let appLog = ''
  appProc.stdout.on('data', (d) => (appLog += d.toString()))
  appProc.stderr.on('data', (d) => (appLog += d.toString()))

  const page = await findPage()
  cdp = await connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')

  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? '页面里抛异常了')
    }
    return r.result.value
  }

  // 等桥接挂上
  for (let i = 0; i < 40; i++) {
    if (await ev('!!(window.nexus && window.nexus.captureScreen)')) break
    await sleep(500)
  }

  console.log('\n=== 断言 ===\n')

  check('① 预载桥接有 captureScreen', await ev('typeof window.nexus?.captureScreen === "function"'))

  // 让靶子保持前台
  SetForegroundWindow(targetWin)
  await sleep(600)
  await ev('window.nexus.resetScreenGate()')

  const frame = await ev('window.nexus.captureScreen(true)')
  check('② 抓得到图', !!frame && typeof frame.dataUrl === 'string')
  if (!frame) {
    console.log('\n拿不到图，后面的断言没法做。应用输出：\n' + appLog.slice(-2000))
    return
  }

  check(
    '③ 是 JPEG data URL',
    frame.dataUrl.startsWith('data:image/jpeg;base64,'),
    frame.dataUrl.slice(0, 32),
  )

  const longest = Math.max(frame.width, frame.height)
  check('④ 长边 ≤ 1024（降采样生效）', longest <= 1024, `${frame.width}x${frame.height}`)

  /*
   * 裁到窗口 → 宽高比应该和前台窗口的客户区一致（整屏的话会被拉成屏幕的比例）。
   *
   * ★ 为什么比宽高比而不是比尺寸
   *
   * 微软文档写着「GetWindowRect 已虚拟化为 DPI」—— 这个脚本跑在普通 Node 里
   * （DPI-unaware），拿到的坐标是缩放过的，而截图是物理像素。两边直接比尺寸
   * 是苹果比橘子（实测能差 1.24 倍）。
   *
   * **宽高比是尺度无关的**，所以这条断言不受 DPI 虚拟化影响。
   * 尺寸是否合理由主进程里那道「裁剪占比自检」兜（见 screen.ts）。
   */
  const wr = rectOf(targetWin)
  const shotRatio = frame.width / frame.height
  const winRatio = wr ? wr.width / wr.height : 0
  const ratioDiff = winRatio ? Math.abs(shotRatio - winRatio) / winRatio : 1
  check(
    '⑤ 宽高比和前台窗口客户区一致（是裁过的，不是整屏）',
    ratioDiff < 0.12,
    `图 ${shotRatio.toFixed(2)} vs 窗口 ${winRatio.toFixed(2)}`,
  )

  check('⑥ 哈希是 16 位十六进制', /^[0-9a-f]{16}$/.test(frame.hash ?? ''), frame.hash)

  // 同一画面连抓两次，哈希应该一样
  const again = await ev('window.nexus.captureScreen(true)')
  check(
    '⑦ 同一画面两次抓取哈希相同（哈希稳定）',
    !!again && again.hash === frame.hash,
    `${frame.hash} vs ${again?.hash}`,
  )

  // 非 force：刚抓过，门控应该拦掉
  const gated = await ev('window.nexus.captureScreen(false)')
  check('⑧ 门控拦住重复抓取（非 force 返回 null）', gated === null)

  // 暂停
  await ev('window.nexus.setObservePaused(true)')
  await sleep(300)
  const paused = await ev('window.nexus.captureScreen(true)')
  check('⑨ 观察暂停后不截图', paused === null)
  await ev('window.nexus.setObservePaused(false)')
  await sleep(300)

  // 黑名单：把靶子标题改成命中词
  writeFileSync(titleFile, TARGET_TITLE + ' 密码', 'utf8')
  await sleep(1500)
  const blocked = await ev('window.nexus.captureScreen(true)')
  check('⑩ 标题命中黑名单后不截图（黑名单同样管截图）', blocked === null)

  console.log()
  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    console.log(`${failed.length} 项没过：`)
    for (const f of failed) console.log(`  · ${f.name}`)
  } else {
    console.log('全部通过 ✅')
  }
}

main()
  .catch((err) => {
    console.error('\n出错了：', err.message)
    process.exitCode = 1
  })
  .finally(() => {
    if (!KEEP) {
      cleanup()
      console.log('\n窗口已关闭（--keep 可保留）')
    } else {
      console.log('\n窗口保留中，Ctrl+C 结束')
    }
  })
