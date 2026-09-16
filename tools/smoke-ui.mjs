/**
 * UI 烟测：设置面板打得开吗、下拉里有东西吗、切角色真的生效吗、有没有报错。
 *
 * 为什么需要它：类型检查过了、脚本跑通了，**不代表界面是好的** ——
 *   控制条是悬浮才浮现的（桌宠形态的要求），DOM 里没按钮时最容易写出
 *   「看起来对、点开是空的」这种问题，而截图逐像素比也看不出「下拉里没有选项」。
 *   这个脚本走的是**用户真实路径**：派 mousemove 让控制条浮现 → 点「设置」→
 *   读下拉内容 → 用界面上的 <select> 触发 change → 校验角色真的换了。
 *
 * 用法（dev server 要在 5176 上跑着）：
 *   node tools/smoke-ui.mjs
 *   node tools/smoke-ui.mjs --url "http://localhost:5176/?portrait=1"
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const URL_ = argOf('--url', 'http://localhost:5176/?portrait=1')
const PORT = Number(argOf('--port', '9344'))

const child = spawn(require('electron'), ['tools/probe-main.cjs', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, PROBE_URL: URL_ },
  stdio: 'ignore',
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Electron 在 dev 下必然喊的 CSP 警告，和我们的改动无关，不当成失败 */
const IGNORED = /Electron Security Warning|Content Security Policy/i

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page' && t.url.startsWith('http'))
      if (p?.webSocketDebuggerUrl) return p
    } catch {
      // 还没起来
    }
    await sleep(400)
  }
  throw new Error('调试端口没起来')
}

const page = await findPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
const problems = []
let next = 1
await new Promise((r) => (ws.onopen = r))
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Runtime.exceptionThrown') {
    problems.push('异常: ' + (m.params.exceptionDetails?.exception?.description ?? '?'))
  }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
    if (!IGNORED.test(text)) problems.push(`${m.params.type}: ${text}`)
  }
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result)
    pending.delete(m.id)
  }
}
const send = (method, params) =>
  new Promise((res) => {
    const id = next++
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面报错')
  return r.result?.value
}

await send('Runtime.enable')
await send('Page.enable')
await sleep(4000)

/*
 * 控制条是悬浮才浮现的，所以先派两个真实的 mousemove 到角色身上。
 * 少了这一步 DOM 里一个按钮都没有（第一版就是这么拿到 buttons: [] 的）。
 */
const hoverAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
  await sleep(500)
}
await hoverAt(450, 500)
await hoverAt(452, 520)

const bars = await evaluate(`(() => {
  const btns = [...document.querySelectorAll('button')]
  return { count: btns.length, labels: btns.map((x) => (x.textContent || '').trim()).slice(0, 14) }
})()`)
console.log('悬浮后的按钮：', JSON.stringify(bars))
if (!bars.count) {
  console.error('❌ 悬浮没让控制条浮现 —— 要么命中判定坏了，要么按钮被 v-if 吃掉了')
  process.exitCode = 1
}

// 真的点一下表情按钮（走用户路径：悬浮 → 点按钮 → 看她换脸）
const expression = await evaluate(`(async () => {
  const chip = [...document.querySelectorAll('.test-bar button')]
    .find((x) => /生气|伤心|开心|害羞|惊讶|无语/.test(x.textContent || ''))
  if (!chip) return { ok: false, reason: '控制条上没有表情按钮' }
  const label = chip.textContent.trim()
  const read = () => {
    const p = window.__nexusPortrait
    return p ? { visible: p.layers().expressionVisible, id: p.layers().expressionId } : null
  }
  chip.click()
  await new Promise((r) => setTimeout(r, 350))
  const on = read()
  chip.click()
  await new Promise((r) => setTimeout(r, 350))
  const off = read()
  return { ok: true, label, on, off }
})()`)
if (expression.ok) {
  const good = expression.on?.visible === true && expression.off?.visible === false
  console.log(
    `点表情按钮「${expression.label}」：点一下 → ${expression.on?.visible ? `换脸「${expression.on.id}」` : '没反应 ❌'}` +
      `｜再点一下 → ${expression.off?.visible ? '没收回去 ❌' : '收回素颜 ✅'}`,
  )
  if (!good) process.exitCode = 1
} else {
  // Live2D 角色没有表情按钮是正常的（它的表情走模型自己的资源），只在立绘上要求
  console.log(`表情按钮：${expression.reason}（Live2D 角色属于正常）`)
}

// 姿势按钮（招手）：同一条用户路径。注意姿态要等交叉淡入淡出，所以多等一会儿
const pose = await evaluate(`(async () => {
  const chip = [...document.querySelectorAll('.test-bar button')].find((x) => /招手|打招呼/.test(x.textContent || ''))
  if (!chip) return { ok: false, reason: '控制条上没有姿势按钮' }
  const label = chip.textContent.trim()
  const read = () => {
    const p = window.__nexusPortrait
    const l = p.layers()
    return { visible: l.poseVisible, id: l.poseId, mix: +l.poseMix.toFixed(2), bodyAlpha: +l.bodyAlpha.toFixed(2) }
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  chip.click()
  await wait(450)
  const on = read()
  chip.click()
  await wait(450)
  const off = read()
  return { ok: true, label, on, off }
})()`)
if (pose.ok) {
  const good = pose.on?.visible === true && pose.on?.mix === 1 && pose.off?.visible === false
  console.log(
    `点姿势按钮「${pose.label}」：摆上 → ${pose.on?.visible ? `「${pose.on.id}」混合 ${pose.on.mix}、底图 alpha ${pose.on.bodyAlpha}` : '没反应 ❌'}` +
      `｜再点一下 → ${pose.off?.visible ? '没收回去 ❌' : '回到原姿势 ✅'}`,
  )
  if (!good) process.exitCode = 1
} else {
  console.log(`姿势按钮：${pose.reason}（Live2D 角色属于正常）`)
}

const opened = await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /设置|⚙/.test(x.textContent || ''))
  if (!b) return { ok: false }
  b.click()
  return { ok: true }
})()`)
console.log('打开设置面板：', opened.ok ? '成功' : '❌ 没找到设置按钮')
await sleep(1500)

const panel = await evaluate(`(() => {
  const selects = [...document.querySelectorAll('select')]
  return {
    selects: selects.map((s) => ({
      value: s.value,
      options: [...s.options].map((o) => o.textContent.trim()),
    })),
    notes: [...document.querySelectorAll('.note')].map((n) => n.textContent.trim().slice(0, 70)),
  }
})()`)
console.log('下拉框：', JSON.stringify(panel.selects, null, 2))
console.log('说明文字：')
for (const n of panel.notes.slice(0, 5)) console.log('  ·', n)

// 真的切一次角色（走界面上的 <select>，模拟用户操作）
const switched = await evaluate(`(() => {
  const s = [...document.querySelectorAll('select')].find((x) =>
    [...x.options].some((o) => /立绘|Live2D/.test(o.textContent)),
  )
  if (!s) return { err: '没找到角色下拉' }
  const other = [...s.options].find((o) => o.value !== s.value)
  if (!other) return { err: '下拉里只有一个角色' }
  const from = window.__nexusStage?.pack?.id
  s.value = other.value
  s.dispatchEvent(new Event('change', { bubbles: true }))
  return { from, to: other.value, label: other.textContent.trim() }
})()`)
console.log('界面切角色：', JSON.stringify(switched))
await sleep(3500)

const after = await evaluate(`(() => ({
  kind: window.__nexusStage?.kind,
  pack: window.__nexusStage?.pack?.id,
  canvases: document.querySelectorAll('canvas').length,
  overlay: document.querySelector('.overlay .title')?.textContent ?? null,
}))()`)
const ok = !switched.err && after.pack === switched.to && after.canvases === 1
console.log('切换后：', JSON.stringify(after), ok ? '✅' : '❌')

console.log(
  problems.length ? `\n⚠ 页面报错/警告 ${problems.length} 条：\n` + problems.join('\n') : '\n✅ 无控制台错误',
)
ws.close()
child.kill()
process.exitCode = ok && problems.length === 0 ? 0 : 1
