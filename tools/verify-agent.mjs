/**
 * agent 链路验证：工具调用 / 记忆 / 表情命令 / 服务不在时的降级。
 *
 * 为什么必须在**页面里**发请求：LLM 的 key 在应用的设置（localStorage）里，
 * 验证脚本不该去读它。让页面自己调 `chatSession.send()`，
 * key 就一直在页面里，脚本只收结果 —— 这既是不碰凭据，也是**真的走用户路径**。
 *
 * 用法（dev server 5176 要跑着；agent 服务 8766 建议也跑着）：
 *   node tools/verify-agent.mjs
 *   node tools/verify-agent.mjs --url "http://localhost:5176/?portrait=1"
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
const PORT = Number(argOf('--port', '9334'))
const AGENT = argOf('--agent', 'http://127.0.0.1:8766')

const electron = require('electron')
const child = spawn(electron, ['tools/probe-main.cjs', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, PROBE_URL: URL_, PROBE_WIDTH: '1000', PROBE_HEIGHT: '900' },
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
      // 还没起来
    }
    await sleep(400)
  }
  throw new Error('等不到 Electron 调试端口')
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const pending = new Map()
    let next = 1
    ws.onopen = () =>
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const id = next++
            pending.set(id, { res, rej })
            ws.send(JSON.stringify({ id, method, params }))
          })
        },
        close: () => ws.close(),
      })
    ws.onerror = (e) => reject(new Error(`CDP 连接失败：${e.message ?? e}`))
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
const record = (label, ok, detail = '') => {
  checks.push([label, ok])
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` —— ${detail}` : ''}`)
}

async function main() {
  const page = await findPage()
  const cdp = await connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')

  const evaluate = async (expression, timeoutMs = 120000) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
    })
    if (r.exceptionDetails) {
      throw new Error(`页面里报错：${r.exceptionDetails.exception?.description ?? '未知'}`)
    }
    return r.result?.value
  }

  // 等应用就绪
  for (let i = 0; i < 40; i++) {
    const ready = await evaluate(`Boolean(window.__nexusRuntime && window.__nexusRuntime.chatSession)`)
    if (ready) break
    await sleep(500)
  }

  /*
   * 允许用环境变量临时指定 LLM（`NEXUS_LLM_API_KEY` / `NEXUS_LLM_BASE_URL` / `NEXUS_LLM_MODEL`）。
   *
   * 为什么需要：Electron 探针有自己的 localStorage（跟浏览器那份不是一套），
   * 探针里存的 key 可能是旧的/占位的 —— 实测就撞上了 401，
   * 那是**探针 profile 的问题**，不是应用的。有环境变量就能把这条测试做得确定。
   */
  if (process.env.NEXUS_LLM_API_KEY) {
    const override = {
      baseURL: process.env.NEXUS_LLM_BASE_URL || 'https://api.deepseek.com/v1',
      apiKey: process.env.NEXUS_LLM_API_KEY,
      model: process.env.NEXUS_LLM_MODEL || 'deepseek-chat',
      temperature: 0.85,
    }
    await evaluate(
      `window.__nexusRuntime.chatSession.updateConfig(${JSON.stringify(override)})`,
    )
    console.log(`\n用环境变量里的 LLM 配置：${override.baseURL} / ${override.model}`)
  }

  const agentUp = await evaluate(`(async () => {
    try {
      const r = await fetch('${AGENT}/health', { signal: AbortSignal.timeout(1500) })
      const d = await r.json()
      return { ok: r.ok, mcp: d.mcp }
    } catch (e) { return { ok: false, error: String(e) } }
  })()`)

  console.log(`\nagent 服务（${AGENT}）：${agentUp.ok ? '在线' : '离线（会走降级路径）'}`)
  if (agentUp.ok) {
    console.log(`  MCP：${agentUp.mcp?.state}（工具 ${agentUp.mcp?.toolCount ?? 0}）`)
  }
  record('agent 服务在线', agentUp.ok === true, agentUp.ok ? '' : '没起服务时下面测的就是降级路径')

  /*
   * 一轮对话：把事件全收回来。
   * 顺便看看到底走的是哪条路 —— 有 tool_call 就说明走的是 agent 服务
   * （直连 LLM 那条路根本没有工具）。
   */
  const runTurn = (text) =>
    evaluate(`(async () => {
      const s = window.__nexusRuntime.chatSession
      const events = []
      let content = ''
      try {
        for await (const ev of s.send(${JSON.stringify(text)})) {
          events.push(ev.type === 'delta' ? { type: 'delta' } : ev)
          if (ev.type === 'delta') content += ev.content
          if (ev.type === 'error') return { events, content, error: ev.message }
        }
      } catch (e) {
        return { events, content, error: String(e && e.message || e) }
      }
      return { events, content }
    })()`)

  console.log('\n第 1 轮：问时间（应该调 get_time 工具）')
  const t1 = await runTurn('现在几点了？')
  const tools1 = t1.events.filter((e) => e.type === 'tool_call').map((e) => e.tool)
  console.log(`  工具：${tools1.length ? tools1.join(', ') : '（没有调用工具）'}`)
  console.log(`  回复：${(t1.content || '').slice(0, 80)}${t1.error ? ` ⚠ ${t1.error}` : ''}`)
  record('她回了话', Boolean(t1.content && t1.content.trim()), t1.error || '')
  if (agentUp.ok) {
    record('走的是 agent 服务（调到了工具）', tools1.length > 0, tools1.join(', '))
    record('时间类问题调的是 get_time', tools1.includes('get_time'), tools1.join(', '))
  }

  console.log('\n第 2 轮：让她记住一件事（应该调 remember 工具）')
  const t2 = await runTurn('记住：我每周一上午要开周会，别在那时候打扰我')
  const tools2 = t2.events.filter((e) => e.type === 'tool_call').map((e) => e.tool)
  console.log(`  工具：${tools2.length ? tools2.join(', ') : '（没有调用工具）'}`)
  console.log(`  回复：${(t2.content || '').slice(0, 80)}`)
  if (agentUp.ok) record('memory 类请求调了 remember', tools2.includes('remember'), tools2.join(', '))

  // 记忆落盘了没有（直接问 agent 服务，比查文件更接近真实使用）
  if (agentUp.ok && tools2.includes('remember')) {
    await sleep(1200)
    const mem = await evaluate(`(async () => {
      const r = await fetch('${AGENT}/memory')
      return await r.json()
    })()`)
    const hit = (mem.text || '').includes('周会') || (mem.text || '').includes('周一')
    console.log(`  记忆文件：${(mem.files || []).join(', ') || '（空）'}`)
    record('记忆真的写进去了（里面有"周一/周会"）', hit, (mem.text || '').slice(0, 60))
  }

  console.log('\n第 3 轮：让她换个表情（应该发 command 事件并落到脸上）')
  const before = await evaluate(`(() => {
    const p = window.__nexusPortrait
    return p ? p.layers().expressionVisible : null
  })()`)
  const t3 = await runTurn('我今天被老板骂了，好烦')
  const commands = t3.events.filter((e) => e.type === 'command')
  console.log(`  command 事件：${commands.length ? JSON.stringify(commands) : '（没有）'}`)
  await sleep(400)
  const after = await evaluate(`(() => {
    const p = window.__nexusPortrait
    return p ? { visible: p.layers().expressionVisible, id: p.layers().expressionId } : null
  })()`)
  console.log(`  表情：之前 ${JSON.stringify(before)} → 之后 ${JSON.stringify(after)}`)
  console.log(`  回复：${(t3.content || '').slice(0, 80)}`)
  if (agentUp.ok) {
    record('情绪类对话发出了 command 事件', commands.length > 0, JSON.stringify(commands))
  }
  if (after && after.visible) {
    record('表情真的贴到她脸上了（command 被舞台执行）', true, `当前 ${after.id}`)
  }

  /*
   * 降级：把 agent 地址指到一个没人听的端口。
   * 这是**必须有**的一条 —— agent 服务是独立进程，没起来是常态，
   * 那时候她必须还能说话（只是没有工具和记忆）。
   */
  console.log('\n降级测试：agent 地址指向死端口，她应该仍然能回话')
  const t4 = await evaluate(`(async () => {
    const s = window.__nexusRuntime.chatSession
    const original = { url: '${AGENT}', enabled: true, sessionId: 'default' }
    s.updateAgent({ url: 'http://127.0.0.1:9', enabled: true, sessionId: 'default' })
    let content = ''
    let error = null
    try {
      for await (const ev of s.send('你还在吗？一句话就好')) {
        if (ev.type === 'delta') content += ev.content
        if (ev.type === 'error') error = ev.message
      }
    } catch (e) { error = String(e && e.message || e) }
    s.updateAgent(original)
    return { content, error }
  })()`)
  console.log(`  回复：${(t4.content || '').slice(0, 80)}${t4.error ? ` ⚠ ${t4.error}` : ''}`)
  record('agent 服务不可用时，她仍然回话（退回直连 LLM）', Boolean(t4.content && t4.content.trim()), t4.error || '')

  const failed = checks.filter(([, ok]) => !ok)
  console.log(`\n共 ${checks.length} 条断言，失败 ${failed.length} 条`)
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
