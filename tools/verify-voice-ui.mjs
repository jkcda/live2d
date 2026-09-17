/**
 * 验证「语音」这块界面：音色列表、克隆表单、试听按钮。
 *
 * 为什么单写一个：这几项是**给用户点的**，而之前它们只存在于命令行里。
 * 界面坏了（下拉空、克隆表单不显示、点了没反应）只能靠人肉发现 ——
 * 这个脚本把"设置面板里到底有没有这些控件、读到了几个音色"变成断言。
 *
 * 用法（dev server 5176 + 主服务 8765/8790 都要起着）：
 *   node tools/verify-voice-ui.mjs
 *   node tools/verify-voice-ui.mjs --tts http://127.0.0.1:8790
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const URL_ = argOf('--url', 'http://localhost:5176/')
const TTS = argOf('--tts', 'http://127.0.0.1:8765')
const PORT = Number(argOf('--port', '9335'))

const child = spawn(require('electron'), ['tools/probe-main.cjs', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, PROBE_URL: URL_, PROBE_WIDTH: '1100', PROBE_HEIGHT: '900' },
  stdio: 'inherit',
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.url.startsWith('http'))
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

const checks = []
const check = (label, ok, detail = '') => {
  checks.push([label, ok])
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` —— ${detail}` : ''}`)
}

async function main() {
  const page = await findPage()
  const cdp = await connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面报错')
    return r.result?.value
  }

  /*
   * 先等"真的落到应用页面上"再动手。
   *
   * 为什么：调试端口刚起来时，列表里可能先出现 about:blank 或还在导航中的文档，
   * 那种上下文里访问 localStorage 会直接抛 SecurityError（第一版就是这么挂的）。
   */
  const origin = new URL(URL_).origin
  let landed = false
  for (let i = 0; i < 40; i++) {
    const state = await evaluate(`(() => {
      try {
        return { href: location.href, hasStorage: Boolean(localStorage.getItem('nexus.tts.config') !== undefined) }
      } catch (err) {
        return { href: location.href, hasStorage: false, err: String(err) }
      }
    })()`)
    if (state?.href?.startsWith(origin) && state.hasStorage) {
      landed = true
      break
    }
    await sleep(500)
  }
  if (!landed) throw new Error(`页面一直没落到 ${origin}（拿不到 localStorage）`)

  // 让应用把 TTS 服务地址指向我们要测的那个（默认 8765，可能没起）
  await evaluate(`(() => {
    const cfg = JSON.parse(localStorage.getItem('nexus.tts.config') || '{}')
    localStorage.setItem('nexus.tts.config', JSON.stringify({ ...cfg, baseURL: '${TTS}' }))
    return true
  })()`)
  await evaluate(`location.reload()`)
  await sleep(4000)

  for (let i = 0; i < 30; i++) {
    if (await evaluate(`Boolean(window.__nexusStage)`)) break
    await sleep(500)
  }

  // 打开设置面板。
  // ★ 悬浮必须用 CDP 的**真实鼠标事件**：合成 PointerEvent 会被真实指针盖掉，
  //   控制条根本不会浮现（smoke-ui 里踩过同一个坑）。
  const hoverAt = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
    await sleep(600)
  }
  await hoverAt(520, 520)
  await hoverAt(523, 540)

  const opened = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /设置|⚙/.test(x.textContent || ''))
    if (!b) return { ok: false, buttons: [...document.querySelectorAll('button')].map((x) => x.textContent.trim()) }
    b.click()
    return { ok: true }
  })()`)
  if (!opened.ok) console.log('  页面上现有的按钮：', JSON.stringify(opened.buttons))
  await sleep(3000)

  const ui = await evaluate(`(() => {
    const panel = document.querySelector('.panel')
    const selects = [...(panel?.querySelectorAll('select') ?? [])]
    const voiceSelect = selects.find((s) => [...s.options].some((o) => /default|voice|音色/i.test(o.textContent)))
    const all = voiceSelect ?? selects[selects.length - 1]
    return {
      opened: Boolean(panel),
      inputs: [...(panel?.querySelectorAll('input') ?? [])].map((i) => i.type),
      textareas: [...(panel?.querySelectorAll('textarea') ?? [])].length,
      buttons: [...(panel?.querySelectorAll('button') ?? [])].map((b) => (b.textContent || '').trim()),
      voiceOptions: all ? [...all.options].map((o) => o.textContent.trim()) : [],
      voiceValue: all ? all.value : null,
      hint: [...(panel?.querySelectorAll('.hint') ?? [])].map((h) => (h.textContent || '').trim()),
    }
  })()`)

  console.log(`\n设置面板：${ui.opened ? '打开了' : '没打开'}`)
  console.log(`  音色下拉：${ui.voiceOptions.length} 项 → ${ui.voiceOptions.join(', ') || '（空）'}`)
  console.log(`  当前选中：${ui.voiceValue}`)
  console.log(`  按钮：${ui.buttons.join(' / ')}`)
  console.log(`  提示文字：${ui.hint.filter(Boolean).join(' ｜ ') || '（无）'}`)

  check('设置面板能打开', ui.opened === true)
  check('音色是一个下拉框（不是让用户手打）', ui.voiceOptions.length > 0, `${ui.voiceOptions.length} 项`)
  check('下拉里读到了服务端的音色', ui.voiceOptions.some((v) => /default|test/i.test(v)), ui.voiceOptions.join(','))
  check('有「刷新」按钮（服务重启后不用刷新页面）', ui.buttons.some((b) => /刷新/.test(b)))
  check('有「试听」按钮', ui.buttons.some((b) => /试听/.test(b)))
  check('克隆表单在（选了文件 + 填文字 + 添加）', ui.inputs.includes('file') && ui.textareas >= 1 && ui.buttons.some((b) => /添加这个音色/.test(b)),
    `file=${ui.inputs.includes('file')} textarea=${ui.textareas}`)

  const failed = checks.filter(([, ok]) => !ok)
  console.log(`\n共 ${checks.length} 条，失败 ${failed.length} 条`)
  if (failed.length) console.log(failed.map(([l]) => `  · ${l}`).join('\n'))

  cdp.close()
  child.kill()
  process.exitCode = failed.length ? 1 : 0
}

main().catch((err) => {
  console.error(`\n验证失败：${err.message}`)
  child.kill()
  process.exitCode = 1
})
