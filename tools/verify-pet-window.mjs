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
 *   ✓ 走的是透明合成路径             → WS_EX_LAYERED 或 WS_EX_NOREDIRECTIONBITMAP
 *                                       （Electron 现在走后者，只认前者会假失败）
 *   ✓ WS_EX_TOPMOST 还在             → 还置顶
 *   ✗ WS_EX_NOACTIVATE 没设          → 会抢焦点
 *   ✗ 扩展样式整个变成 0             → 窗口被写坏了（GetWindowLongW 读到 0
 *                                       还拿去做位运算的经典后果）
 *
 * 用法（先 pnpm build）：
 *   node tools/verify-pet-window.mjs
 *   node tools/verify-pet-window.mjs --url http://localhost:5176   # 用 dev server
 *   node tools/verify-pet-window.mjs --keep                        # 验证完不关窗口
 *   node tools/verify-pet-window.mjs --no-tray                     # 强制托盘创建失败，
 *                                                                  # 验证「关窗即退出」兜底
 *   node tools/verify-pet-window.mjs --exe release/win-unpacked/NexusLive2D.exe
 *       # 打包版。这条是 asar 的唯一硬证据：窗口上有 NOACTIVATE
 *       # 就说明原生模块 koffi 从 asar 里加载成功了（加载不上会静默降级，
 *       # 那时这个位不会被设置）。
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
const EXE = argOf('--exe', '')
const NO_TRAY = has('--no-tray')
const KEEP = has('--keep')
const electron = require('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 后段（托盘失败兜底）用的断言。前段的窗口检查有自己的列表 */
let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓ ' : '✗ '} ${label}${detail ? ` —— ${detail}` : ''}`)
  if (!ok) failures++
}

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
const PostMessageW = user32.func('bool PostMessageW(uint64 hWnd, uint32 Msg, uint64 wParam, int64 lParam)')

const GWL_EXSTYLE = -20
const GW_HWNDNEXT = 2
const WM_CLOSE = 0x0010

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
// 强制走「托盘建不起来」那条路（正常机器上这条分支跑不到，见 main.ts 里的钩子）
if (NO_TRAY) env.NEXUS_NO_TRAY = '1'

console.log(EXE ? `启动打包后的可执行文件：${EXE}\n` : '启动真实主进程…\n')
const child = EXE
  ? spawn(EXE, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(electron, ['.'], { env, stdio: ['ignore', 'pipe', 'pipe'] })

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

  /*
   * 透明那一条**不能**只认 WS_EX_LAYERED。
   *
   * Electron 在 Windows 上早就改用 DirectComposition 做透明窗口了（窗口带
   * WS_EX_NOREDIRECTIONBITMAP、不带 WS_EX_LAYERED）—— 实测就是这条路径，
   * 只认 LAYERED 会拿到一个假失败：样式看着"不对"，窗口其实是好的。
   *
   * 反过来也要说清楚：这两个位只能证明"没被切到普通不透明合成路径"，
   * **证不了真的透明**。真要确认透明得看像素 ——
   * --keep 留着窗口，比一眼窗口角落和后面的桌面。
   */
  const transparentPath = on.includes('WS_EX_LAYERED') || on.includes('WS_EX_NOREDIRECTIONBITMAP')

  const checks = [
    ['WS_EX_NOACTIVATE 已设置', on.includes('WS_EX_NOACTIVATE'), '点她不会抢走你正在打字的焦点'],
    [
      '走的是透明合成路径',
      transparentPath,
      on.includes('WS_EX_NOREDIRECTIONBITMAP')
        ? 'DirectComposition —— Electron 现在的默认路径'
        : 'WS_EX_LAYERED —— 老路径',
    ],
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

// ── 托盘创建失败那条路（--no-tray）─────────────────────────────────────
/*
 * 托盘建不起来时，绝不能留下「没有窗口、没有托盘、进程还在」的幽灵。
 * 正常机器上这条分支走不到，所以主进程留了 NEXUS_NO_TRAY=1 的开关（见 main.ts）。
 *
 * 断言两件事：
 *   ① 日志里明确报了失败（不是静默吞掉）
 *   ② 发一个 WM_CLOSE 关掉窗口之后，进程真的退出了
 *      —— 这是「关窗即退出」兜底生效的唯一硬证据
 */
if (NO_TRAY && !lastError && found.length) {
  const main = found.find((w) => w.title) ?? found[0]

  console.log()
  console.log('='.repeat(62))
  console.log('托盘失败兜底')
  console.log('='.repeat(62))

  check('托盘创建失败被接住并报了错', stdout.includes('托盘创建失败'))

  PostMessageW(main.hwnd, WM_CLOSE, 0, 0)
  const deadline = Date.now() + 9000
  while (child.exitCode === null && Date.now() < deadline) await sleep(300)
  const exited = child.exitCode !== null
  check('关掉窗口后进程退出（没变成看不见的幽灵）', exited, exited ? `exit ${child.exitCode}` : '9 秒内还活着')
  if (!exited) {
    console.log('     ↑ 有托盘时窗口全关 ≠ 退出（这是对的），但托盘没建成时必须退')
  }
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

// 托盘兜底那几项没通过要体现在退出码里，否则 CI 里看不出来
if (failures) process.exitCode = 1
