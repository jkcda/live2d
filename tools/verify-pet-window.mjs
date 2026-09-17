/**
 * 桌宠窗口验证：不用肉眼，直接问 Windows「这个窗口到底是什么样的」。
 *
 * 为什么需要它：桌宠形态最关键的两件事都是**看不见的**——
 *   · 点她该不该抢走你正在打字的焦点
 *   · 透明/置顶/穿透这些样式有没有被写坏
 * 肉眼只能看出「点了一下好像没反应」，看不出到底是哪种情况。
 *
 * 这个脚本启动**真实的主进程**（不是 probe-main.cjs 那个验证专用宿主），
 * 然后直调 user32 把窗口的扩展样式读出来解码成人类能看的名字。
 *
 * 关键检查项：
 *   ✓ WS_EX_NOACTIVATE 已设置        → 点她不抢焦点（这是桌宠能日用的前提）
 *   ✓ WS_EX_LAYERED 还在             → 窗口还是透明的
 *   ✓ WS_EX_TOPMOST 还在             → 还置顶
 *   ✗ WS_EX_NOACTIVATE 没设          → 会抢焦点
 *   ✗ 扩展样式整个变成 0             → 窗口被写坏了（GetWindowLongW 读到 0
 *                                       还拿去做位运算的经典后果）
 *
 * 用法（先 pnpm build）：
 *   node tools/verify-pet-window.mjs
 *   node tools/verify-pet-window.mjs --url http://localhost:5176   # 用 dev server
 *   node tools/verify-pet-window.mjs --keep                        # 验证完不关窗口
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const has = (name) => args.includes(name)

const URL_ = argOf('--url', '')
const KEEP = has('--keep')
const electron = require('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Win32 ────────────────────────────────────────────────────────────

const koffi = require('koffi')
const user32 = koffi.load('user32.dll')

const GetTopWindow = user32.func('uint64 GetTopWindow(uint64 hWnd)')
const GetWindow = user32.func('uint64 GetWindow(uint64 hWnd, uint32 uCmd)')
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(uint64 hWnd, _Out_ uint32 *pid)')
const GetWindowLongW = user32.func('int32 GetWindowLongW(uint64 hWnd, int32 nIndex)')
const GetWindowTextW = user32.func('int32 GetWindowTextW(uint64 hWnd, _Out_ uint16 *lp, int32 nMax)')
const IsWindowVisible = user32.func('bool IsWindowVisible(uint64 hWnd)')
const GetForegroundWindow = user32.func('uint64 GetForegroundWindow()')

const GWL_EXSTYLE = -20
const GW_HWNDNEXT = 2

const EX_FLAGS = {
  WS_EX_DLGMODALFRAME: 0x00000001,
  WS_EX_NOPARENTNOTIFY: 0x00000004,
  WS_EX_TOPMOST: 0x00000008,
  WS_EX_ACCEPTFILES: 0x00000010,
  WS_EX_TRANSPARENT: 0x00000020,
  WS_EX_MDICHILD: 0x00000040,
  WS_EX_TOOLWINDOW: 0x00000080,
  WS_EX_WINDOWEDGE: 0x00000100,
  WS_EX_CLIENTEDGE: 0x00000200,
  WS_EX_CONTEXTHELP: 0x00000400,
  WS_EX_RIGHT: 0x00001000,
  WS_EX_RTLREADING: 0x00002000,
  WS_EX_LEFTSCROLLBAR: 0x00004000,
  WS_EX_CONTROLPARENT: 0x00010000,
  WS_EX_STATICEDGE: 0x00020000,
  WS_EX_APPWINDOW: 0x00040000,
  WS_EX_LAYERED: 0x00080000,
  WS_EX_NOINHERITLAYOUT: 0x00100000,
  WS_EX_NOREDIRECTIONBITMAP: 0x00200000,
  WS_EX_LAYOUTRTL: 0x00400000,
  WS_EX_COMPOSITED: 0x02000000,
  WS_EX_NOACTIVATE: 0x08000000,
}

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

function decodeExStyle(style) {
  const on = []
  const off = []
  for (const [name, bit] of Object.entries(EX_FLAGS)) {
    ;(style & bit ? on : off).push(name)
  }
  return { on, off }
}

/** 遍历所有顶层窗口，找出属于指定 PID 的可见窗口 */
function windowsOfPid(pid) {
  const found = []
  let h = GetTopWindow(0)
  let guard = 0
  while (h && guard++ < 3000) {
    if (pidOf(h) === pid && IsWindowVisible(h)) {
      const t = titleOf(h)
      found.push({ hwnd: h, title: t, style: GetWindowLongW(h, GWL_EXSTYLE) >>> 0 })
    }
    h = GetWindow(h, GW_HWNDNEXT)
  }
  return found
}

// ── 主流程 ───────────────────────────────────────────────────────────

const env = { ...process.env }
if (URL_) {
  env.VITE_DEV_SERVER_URL = URL_
} else {
  // 不设的话主进程走 loadFile(dist/index.html)，顺带不会开 DevTools
  delete env.VITE_DEV_SERVER_URL
}

console.log('启动真实主进程…\n')
const child = spawn(electron, ['.'], { env, stdio: ['ignore', 'pipe', 'pipe'] })

let stdout = ''
child.stdout.on('data', (d) => {
  stdout += d.toString()
})
child.stderr.on('data', (d) => {
  stdout += d.toString()
})

let found = []
let lastError = ''

for (let i = 0; i < 30; i++) {
  await sleep(1000)
  if (child.exitCode !== null) {
    lastError = `主进程提前退出了（exit ${child.exitCode}）`
    break
  }
  found = windowsOfPid(child.pid)
  // 只关心有内容的窗口；主进程还会有一些隐藏的辅助窗口
  if (found.some((w) => w.title)) break
}

console.log('='.repeat(62))
console.log('窗口检查')
console.log('='.repeat(62))

if (lastError) {
  console.log(`✗ ${lastError}`)
  /*
   * 退出原因必须打出来。
   * 只报「失败了」不说为什么的验证脚本等于没用 —— 尤其是 Electron 这种
   * 启动失败原因千奇百怪（GPU 进程挂、沙箱拦、二进制没装好）的东西。
   */
  const tail = stdout.trim().split('\n').slice(-12)
  if (tail.length) {
    console.log()
    console.log('  进程输出（最后 12 行）：')
    for (const l of tail) console.log(`    ${l}`)
  } else {
    console.log('  进程没有任何输出 —— 可能是被环境拦掉了（沙箱 / 权限）')
  }
} else if (!found.length) {
  console.log('✗ 没找到属于该进程的可见窗口')
} else {
  const main = found.find((w) => w.title) ?? found[0]
  const { on, off } = decodeExStyle(main.style)

  console.log(`  句柄   : 0x${main.hwnd.toString(16)}`)
  console.log(`  标题   : ${main.title || '(无)'}`)
  console.log(`  扩展样式: 0x${main.style.toString(16).padStart(8, '0')}`)
  console.log(`  已置位 : ${on.join(', ') || '(无)'}`)
  console.log(`  未置位 : ${off.join(', ') || '(无)'}`)
  console.log()

  const checks = [
    ['WS_EX_NOACTIVATE 已设置', on.includes('WS_EX_NOACTIVATE'), '点她不会抢走你正在打字的焦点'],
    ['WS_EX_LAYERED 还在', on.includes('WS_EX_LAYERED'), '窗口还是透明的'],
    ['WS_EX_TOPMOST 还在', on.includes('WS_EX_TOPMOST'), '还置顶'],
    ['扩展样式非 0', main.style !== 0, '没有被 GetWindowLongW 读到 0 后写坏'],
  ]

  console.log('='.repeat(62))
  console.log('结果')
  console.log('='.repeat(62))
  let allPass = true
  for (const [name, ok, why] of checks) {
    console.log(`  ${ok ? '✓' : '✗'}  ${name.padEnd(26)} ${why}`)
    if (!ok) allPass = false
  }

  const fg = GetForegroundWindow()
  const isFg = fg === main.hwnd
  console.log()
  console.log(`  当前是不是前台窗口: ${isFg ? '是' : '否'}`)
  console.log(`  （启动后立刻测；为「是」说明没抢焦点成功）`)

  console.log()
  console.log(allPass ? '全部通过 ✅' : '有项目没通过 ❌')
}

// ── 主进程日志 ───────────────────────────────────────────────────────

const interesting = stdout
  .split('\n')
  .filter((l) => l.includes('[main]') || l.includes('[observer]') || l.includes('[win-style]'))
  .map((l) => l.trim())

if (interesting.length) {
  console.log()
  console.log('='.repeat(62))
  console.log('主进程日志')
  console.log('='.repeat(62))
  for (const l of interesting.slice(0, 15)) console.log(`  ${l}`)

  if (stdout.includes('托盘创建失败')) {
    console.log()
    console.log('⚠ 托盘创建失败 —— 应用会退回「关窗即退出」模式')
  }
}

if (!KEEP) {
  child.kill()
  console.log('\n窗口已关闭（--keep 可保留）')
} else {
  console.log('\n窗口保留中，Ctrl+C 结束')
}
