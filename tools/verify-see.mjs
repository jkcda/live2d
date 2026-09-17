/**
 * 验证「她真的看得到」这条链 —— 端到端，而且不用用户自己的 key。
 *
 * ── 这条链有四个环节，任何一环断了都会表现成"她好像没看见" ──
 *
 *   ① 主进程：前台窗口过黑名单/暂停开关 → 抓图 → 变化门控 → 给渲染层
 *   ② 渲染层：把图**随这一轮的请求**带上（不进 messages、不进 localStorage）
 *   ③ agent 服务：把图拼成**图片内容块**挂在用户那条消息上
 *   ④ 模型：真的收到 content 数组（含 data:image/jpeg;base64,…）
 *
 * ①②④ 都能单独测，唯独"图有没有真的到模型手里"必须看**模型收到的请求**。
 * 所以这里摆一个假端点（tools/stub-llm.mjs）：它把请求体记下来，
 * 验证脚本再要回来看。这样不用用户的 key，也不用真模型。
 *
 * ★ 一个自证的点：直连 LLM 那条降级路径**不支持图片**（ChatMessage 是纯文字的）。
 *   所以"假端点收到了 image_url 块"这件事本身就证明了走的是 agent 服务那条路。
 *
 * 用法（先 pnpm build；agent 服务 8766 要在跑）：
 *   node tools/verify-see.mjs
 *   node tools/verify-see.mjs --keep
 */

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const electron = require('electron')

const args = process.argv.slice(2)
const has = (name) => args.includes(name)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const PORT = Number(argOf('--port', '9353'))
const STUB_PORT = Number(argOf('--stub-port', '8799'))
const AGENT = argOf('--agent', 'http://127.0.0.1:8766')
/**
 * ★ 必须走 dev server，不能用 dist 产物。
 *
 * 这条验证要驱动一轮真实对话，靠的是应用暴露的调试钩子
 * `window.__nexusRuntime.chatSession` —— 它被 `import.meta.env.DEV` 保护，
 * 生产构建里会被摇掉（那是故意的，见 src/core/runtime.ts）。
 */
const URL_ = argOf('--url', 'http://localhost:5176/')
const KEEP = has('--keep')
const ROOT = process.cwd()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Win32：把靶子窗口推到前台（她的"看"需要有个可看的前台窗口）────────

const koffi = require('koffi')
const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
user32.func('bool SetProcessDPIAware()')()

const GetTopWindow = user32.func('uint64 GetTopWindow(uint64 hWnd)')
const GetWindow = user32.func('uint64 GetWindow(uint64 hWnd, uint32 uCmd)')
const IsWindowVisible = user32.func('bool IsWindowVisible(uint64 hWnd)')
const GetWindowTextW = user32.func('int32 GetWindowTextW(uint64 hWnd, _Out_ uint16 *lp, int32 nMax)')
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(uint64 hWnd, _Out_ uint32 *pid)')
const GetForegroundWindow = user32.func('uint64 GetForegroundWindow()')
const SetForegroundWindow = user32.func('bool SetForegroundWindow(uint64 hWnd)')
const ShowWindow = user32.func('bool ShowWindow(uint64 hWnd, int32 nCmdShow)')
const AttachThreadInput = user32.func('bool AttachThreadInput(uint32 a, uint32 b, bool f)')
const keybd_event = user32.func('void keybd_event(uint8 vk, uint8 scan, uint32 flags, uint64 extra)')
const GetCurrentThreadId = kernel32.func('uint32 GetCurrentThreadId()')

const titleOf = (h) => {
  const b = new Uint16Array(512)
  const n = GetWindowTextW(h, b, 512)
  return n <= 0 ? '' : Buffer.from(b.buffer, 0, n * 2).toString('utf16le')
}
const pidOf = (h) => {
  const b = new Uint32Array(1)
  GetWindowThreadProcessId(h, b)
  return b[0]
}
function windowOf(pid, wantTitle) {
  let h = GetTopWindow(0)
  for (let i = 0; h && i < 3000; i++) {
    if (pidOf(h) === pid && IsWindowVisible(h) && titleOf(h) && (!wantTitle || titleOf(h) === wantTitle)) return h
    h = GetWindow(h, 2)
  }
  return 0n
}

/**
 * 把窗口推到前台。
 *
 * ★ 这一步不能省：直接 SetForegroundWindow 会被前台锁挡掉，
 *   而"她看的是前台窗口"—— 推不上去，抓到的就是别人的窗口。
 *   （实测过：推上去 3.5 秒后前台又被用户自己的窗口抢回去，
 *     所以下面每次发请求前都会回读确认。）
 */
async function forceForeground(hwnd) {
  ShowWindow(hwnd, 9)
  if (SetForegroundWindow(hwnd) && GetForegroundWindow() === hwnd) return 'SetForegroundWindow'

  const pidBuf = new Uint32Array(1)
  const fgThread = GetWindowThreadProcessId(GetForegroundWindow(), pidBuf)
  const me = GetCurrentThreadId()
  if (fgThread && fgThread !== me) AttachThreadInput(fgThread, me, true)
  const ok = SetForegroundWindow(hwnd)
  if (fgThread && fgThread !== me) AttachThreadInput(fgThread, me, false)
  if (ok && GetForegroundWindow() === hwnd) return 'AttachThreadInput'

  keybd_event(0x12, 0, 0, 0)
  keybd_event(0x12, 0, 2, 0)
  await sleep(80)
  if (SetForegroundWindow(hwnd) && GetForegroundWindow() === hwnd) return '模拟 ALT'
  return null
}

// ── CDP ──────────────────────────────────────────────────────────────

async function findPage(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      // dev server 下页面地址是 http://localhost:5176/（没有 index.html），
      // 所以两种都得认 —— 否则会一直等一个永远不出现的标题
      const page = list.find((t) => t.type === 'page' && (t.url.startsWith(URL_) || /index\.html/.test(t.url)))
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

const base = mkdtempSync(join(tmpdir(), 'nexus-verify-see-'))
const env = { ...process.env, VITE_DEV_SERVER_URL: URL_ }

let stubProc = null
let appProc = null
let targetProc = null
let cdp = null

try {
  // dev server 得在跑 —— 调试钩子只在 dev 构建里有
  try {
    const r = await fetch(URL_, { signal: AbortSignal.timeout(3000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
  } catch (err) {
    throw new Error(`dev server（${URL_}）没在跑：${err.message}\n  先起它：pnpm dev:web`)
  }

  console.log('启动假 LLM 端点…')
  stubProc = spawn(process.execPath, [join(ROOT, 'tools', 'stub-llm.mjs'), String(STUB_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stubLog = ''
  stubProc.stdout.on('data', (d) => (stubLog += d.toString()))
  stubProc.stderr.on('data', (d) => (stubLog += d.toString()))

  // 等它起来
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://127.0.0.1:${STUB_PORT}/_last`)
      break
    } catch {
      await sleep(200)
    }
  }

  console.log('启动应用（dist 产物）…')
  appProc = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(base, 'app')}`], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let appLog = ''
  appProc.stdout.on('data', (d) => (appLog += d.toString()))
  appProc.stderr.on('data', (d) => (appLog += d.toString()))

  console.log('启动靶子窗口（她这一轮"看到"的对象）…\n')
  targetProc = spawn(electron, ['tools/verify-target.cjs', `--user-data-dir=${join(base, 'target')}`], {
    cwd: ROOT,
    env: { ...env, NEXUS_TITLE_FILE: join(base, 'title.txt'), NEXUS_TARGET_TITLE: 'NEXUS 看得见靶子' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const page = await findPage()
  cdp = await connect(page.webSocketDebuggerUrl)
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面里抛异常了')
    return r.result.value
  }

  for (let i = 0; i < 60; i++) {
    if (await ev('Boolean(window.__nexusRuntime && window.__nexusRuntime.chatSession)')) break
    await sleep(250)
  }

  // 把 LLM 指向假端点：这样"模型收到的请求"是我们能看的
  await ev(
    `window.__nexusRuntime.chatSession.updateConfig(${JSON.stringify({
      baseURL: `http://127.0.0.1:${STUB_PORT}/v1`,
      apiKey: 'stub-key',
      model: 'stub-model',
      temperature: 0.5,
    })})`,
  )

  const agentUp = await ev(`(async () => {
    try { const r = await fetch('${AGENT}/health', { signal: AbortSignal.timeout(2000) }); const d = await r.json(); return { ok: r.ok, tools: d.mcp?.toolCount } }
    catch (e) { return { ok: false, error: String(e) } }
  })()`)

  console.log('='.repeat(62))
  console.log('她真的看得到吗')
  console.log('='.repeat(62))
  check('agent 服务在线（截图要走这条路）', agentUp.ok === true, agentUp.ok ? `MCP 工具 ${agentUp.tools}` : agentUp.error)

  // 靶子推前台，并确认观察器真的看到了它
  let tgt = 0n
  for (let i = 0; i < 30 && !tgt; i++) {
    tgt = windowOf(targetProc.pid)
    if (!tgt) await sleep(400)
  }
  const how = await forceForeground(tgt)
  let activity = null
  for (let i = 0; i < 20; i++) {
    activity = await ev('window.nexus.getActivity()')
    if (activity) break
    await sleep(300)
  }
  check(
    '她这一轮「看」的前台窗口就绪',
    Boolean(activity),
    activity ? `${activity.process} / ${activity.title}（推前台方式：${how ?? '失败'}）` : '拿不到前台快照',
  )

  // 这一轮的截图：直接问主进程要（和真实对话走同一条 IPC）
  const t0 = Date.now()
  const frame = await ev('window.nexus.screenForTurn()')
  const frameMs = Date.now() - t0
  check(
    '① 主进程给得出一张可以附的图',
    Boolean(frame && frame.dataUrl?.startsWith('data:image/jpeg;base64,')),
    frame ? `${frame.width}x${frame.height}，${(frame.dataUrl.length / 1024).toFixed(0)} KB base64，${frame.ageSeconds} 秒前抓的` : '拿到了 null',
  )
  /*
   * ★ 零延迟是硬要求，不是"最好能快"。
   *   抓一次图要 100~300ms（desktopCapturer 要把整屏渲染成全分辨率位图再编码），
   *   如果它卡在"他按下回车"和"请求发出去"之间，每一句回复都会慢一截 ——
   *   用户的第一反应就是"回复也变慢了很多"。
   *   所以这里必须命中后台预热好的缓存，只做一次内存读取。
   */
  check('   取图不阻塞这一轮（走后台缓存，不现场抓）', frameMs < 30, `${frameMs}ms`)

  /*
   * 参考值：现场抓一张要多久。
   * 这不是断言，是把"挪出去的那笔钱"量出来给读者看 ——
   * 原来这一笔就卡在"他按下回车"和"请求发出去"之间。
   */
  const tLive = Date.now()
  await ev('window.nexus.captureScreen(true)')
  console.log(`     参考：现场抓一张要 ${Date.now() - tLive}ms（getSources 整屏 + 编码）`)

  /*
   * ★ 这一条是用户真正踩到的坑：**前台是她自己的窗口**。
   *
   * 对话面板要能打键盘，主进程在面板打开时会 focus() —— 所以"他问她你在看什么"
   * 的那一刻，前台窗口恰恰是她自己。截图只认实时前台的话，真实使用里一张图
   * 都送不出去（症状就是"她只能说出窗口标题"）。
   */
  await ev('window.nexus.setPanelOpen(true)')
  await sleep(1500)
  const selfFrame = await ev('window.nexus.screenForTurn()')
  check(
    '①b 前台是她自己时，仍拿得到「最后一个可看窗口」那张图',
    Boolean(selfFrame && selfFrame.dataUrl?.startsWith('data:image/jpeg')),
    selfFrame
      ? `${selfFrame.width}x${selfFrame.height}，${selfFrame.ageSeconds} 秒前`
      : '拿到了 null —— 真实使用里她就是这样"只看得见标题"的',
  )
  await ev('window.nexus.setPanelOpen(false)')
  await sleep(300)

  // 真的发一轮对话
  const turn = await ev(`(async () => {
    const s = window.__nexusRuntime.chatSession
    let content = ''
    const tools = []
    for await (const e of s.send('你看我在干嘛？')) {
      if (e.type === 'delta') content += e.content
      if (e.type === 'tool_call') tools.push(e.tool)
    }
    return { content, tools }
  })()`)
  check('她回了话（模型那一侧通了）', Boolean(turn.content && turn.content.trim()), turn.content?.slice(0, 60))
  console.log(`     她这一轮调的工具：${turn.tools.length ? turn.tools.join(', ') : '（没调）'}`)

  // 看模型到底收到了什么
  /*
   * ★ 要在一串请求里挑出「这一轮对话」那条，不能只看最后一条：
   *   agent 会在后台调模型做记忆整理 / 历史压缩，那些请求会盖在后面
   *   （第一次跑就撞上了：拿到的是"你是她的记忆管理器"那条）。
   *   判据：带 tools 的那条就是对话（后台那两条都不带工具）。
   */
  const all = await (await fetch(`http://127.0.0.1:${STUB_PORT}/_all`)).json()
  const list = Array.isArray(all) ? all : []
  const last =
    [...list].reverse().find((r) => Array.isArray(r?.tools)) ??
    [...list].reverse().find((r) => JSON.stringify(r?.messages ?? '').includes('你看我在干嘛')) ??
    list[list.length - 1]
  const msgs = Array.isArray(last?.messages) ? last.messages : []
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
  const blocks = Array.isArray(lastUser?.content) ? lastUser.content : []
  const img = blocks.find((b) => b?.type === 'image_url')
  const textBlock = blocks.find((b) => b?.type === 'text')
  const system = msgs.find((m) => m.role === 'system')

  check('④ 模型真的收到了图片内容块', Boolean(img), img ? `url 前缀 ${String(img.image_url?.url).slice(0, 32)}…` : `收到的是：${JSON.stringify(lastUser?.content)?.slice(0, 120)}`)
  console.log(
    `     诊断：这次请求 ${Array.isArray(last?.tools) ? `带 ${last.tools.length} 个工具（agent 那条路）` : '不带工具（直连 LLM 那条路）'}，` +
      `消息 ${msgs.length} 条，system ${system ? `${String(system.content).length} 字` : '缺失'}`,
  )
  check(
    '   图片是合法的 data URL 且不是空图',
    Boolean(img && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]{1000,}$/.test(String(img.image_url?.url))),
    img ? `${(String(img.image_url.url).length / 1024).toFixed(0)} KB` : '',
  )
  check(
    '   同一格里写明了图是几秒前抓的',
    Boolean(textBlock && /截图/.test(textBlock.text) && /秒前|刚刚/.test(textBlock.text)),
    textBlock ? textBlock.text.slice(-40) : '',
  )
  /*
   * system 的 content 可能是字符串，也可能是**内容块数组**
   * （LangChain 见到多模态模型会把文本包成 [{type:'text',text}]）——
   * 直接 String() 会得到 "[object Object]"，够写出一个"永远失败"的断言。
   */
  const systemText =
    typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content ?? '')
  check(
    '   人设里带着「你看得到屏幕」这段',
    /截图/.test(systemText) && systemText.length > 200,
    system ? `system ${systemText.length} 字：${systemText.slice(0, 50).replace(/\n/g, ' ⏎ ')}…` : '没看到 system 消息',
  )

  // 图绝不能进历史（localStorage 会被 base64 撑爆）
  const hist = await ev(`localStorage.getItem('nexus.chat.history') || ''`)
  check(
    '图片没有进 localStorage 历史',
    !String(hist).includes('data:image'),
    `${(String(hist).length / 1024).toFixed(1)} KB 历史里没有 base64 图`,
  )
  const histMsgs = await ev(`(window.__nexusRuntime.chatSession.messages || []).filter((m) => typeof m.content !== 'string').length`)
  check('会话内存里的历史也都是纯文字', histMsgs === 0, `非文字消息 ${histMsgs} 条`)

  console.log()
  console.log('='.repeat(62))
  const bad = checks.filter(([, ok]) => !ok).length
  console.log(bad ? `有 ${bad} 项没通过 ❌` : `全部通过 ✅（${checks.length} 项）`)
  console.log('='.repeat(62))

  if (bad) {
    const lines = appLog.split('\n').filter((l) => /\[main\]|\[screen\]|\[agent\]/.test(l))
    for (const l of lines.slice(-8)) console.log(`  ${l.trim()}`)
    const stubLines = stubLog.trim().split('\n').slice(-4)
    for (const l of stubLines) console.log(`  ${l}`)
  }
} catch (err) {
  console.log(`\n✗ 验证中断：${err.message}`)
  process.exitCode = 1
} finally {
  cdp?.close()
  if (!KEEP) {
    for (const p of [targetProc, appProc, stubProc]) {
      if (p?.pid) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
    }
    try {
      rmSync(base, { recursive: true, force: true })
    } catch {
      /* 临时目录 */
    }
  } else {
    console.log('\n窗口保留中（--keep）')
  }
}
