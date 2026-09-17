/**
 * 「语音这条路还通不通」的诊断。
 *
 * 为什么需要它：用户说「怎么没有语音回复了」时，可能的原因**分散在四层**上，
 * 而且症状长得一模一样（只有文字、没有声音）：
 *
 *   ① 推理服务没起 / 引擎没就绪        → 合成直接失败
 *   ② 合成慢（RTF > 1）               → 第一句要等十几秒，听起来像没出声
 *   ③ 播放链断了（AudioContext 挂起、解码失败）
 *   ④ **barge-in 误触发**：麦克风听到任何声音（视频、音乐）就判成"用户开口"，
 *      于是每句刚合成完就被 interrupt 丢掉 —— 这一条最像"完全没有语音"
 *
 * 这个脚本把四层**分别**量一遍，而不是笼统地说"语音坏了"：
 *   · 服务在不在（/health）
 *   · 真合成一句要多久、音频多长 → 算得出 RTF
 *   · 能不能真的播起来（播放状态有没有变成 playing）
 *   · 麦克风现在是开着的吗（开着就意味着 barge-in 随时可能抢话）
 *
 * 用法（应用自己那套配置，需要 dev server 在跑）：
 *   node tools/check-voice.mjs
 *   node tools/check-voice.mjs --fresh      # 用临时 profile，不动你当前的应用
 *   node tools/check-voice.mjs --text "换一句测试"
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
const PORT = Number(argOf('--port', '9355'))
const URL_ = argOf('--url', 'http://localhost:5176/')
const TEXT = argOf('--text', '测试一句：一二三四五六七八九十。')
const FRESH = has('--fresh')
const ROOT = process.cwd()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const base = mkdtempSync(join(tmpdir(), 'nexus-voice-'))
const env = { ...process.env, VITE_DEV_SERVER_URL: URL_ }
const extraArgs = ['.', `--remote-debugging-port=${PORT}`]
if (FRESH) extraArgs.push(`--user-data-dir=${join(base, 'profile')}`)

// dev server 得在跑（调试钩子只在 dev 构建里）
try {
  const r = await fetch(URL_, { signal: AbortSignal.timeout(3000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
} catch (err) {
  console.log(`✗ dev server（${URL_}）没在跑：${err.message}\n  先起它：pnpm dev:web`)
  process.exit(1)
}

console.log(FRESH ? '用临时 profile（不动你当前的应用）' : '用当前 profile（沿用你的音色设置）')
const child = spawn(electron, extraArgs, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
child.stdout.on('data', (d) => (log += d.toString()))
child.stderr.on('data', (d) => (log += d.toString()))

let cdp = null
try {
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(400)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      page = list.find((t) => t.type === 'page' && (t.url.startsWith(URL_) || /index\.html/.test(t.url)))
    } catch {
      /* 还没起来 */
    }
  }
  if (!page) throw new Error('等不到调试端口')

  cdp = await new Promise((res, rej) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    const pending = new Map()
    let n = 1
    ws.onopen = () =>
      res({
        send: (method, params) =>
          new Promise((r2, j2) => {
            const id = n++
            pending.set(id, { r: r2, j: j2 })
            ws.send(JSON.stringify({ id, method, params }))
          }),
        close: () => ws.close(),
      })
    ws.onerror = (e) => rej(new Error(String(e.message)))
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (!m.id || !pending.has(m.id)) return
      const { r, j } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result)
    }
  })
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面里抛异常了')
    return r.result.value
  }

  for (let i = 0; i < 60; i++) {
    if (await ev('Boolean(window.__nexusRuntime)')) break
    await sleep(250)
  }

  console.log('\n' + '='.repeat(62))
  console.log('语音诊断')
  console.log('='.repeat(62))

  // ① 配置 + 服务
  const cfg = await ev(`JSON.parse(localStorage.getItem('nexus.tts.config') || 'null')`)
  console.log(`  TTS 配置：${JSON.stringify(cfg)}`)
  const health = await ev(`window.__nexusRuntime.voiceOutput.health()`)
  console.log(`  ${health ? 'OK ' : '✗  '}推理服务可达：${health}`)

  // ② 合成 + ③ 播放（一次量完）
  const probe = await ev(`(async () => {
    const { voiceOutput, audioPlayer } = window.__nexusRuntime
    const cfg = JSON.parse(localStorage.getItem('nexus.tts.config') || '{}')
    const base = (cfg.baseURL || 'http://127.0.0.1:8765').replace(/\\/+$/, '')
    const t0 = performance.now()
    const resp = await fetch(base + '/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: ${JSON.stringify(TEXT)}, voice: cfg.voice, speed: cfg.speed }),
    })
    if (!resp.ok) return { error: 'HTTP ' + resp.status + ' ' + (await resp.text()).slice(0, 160) }
    const buf = await resp.arrayBuffer()
    const synthMs = performance.now() - t0
    if (!buf.byteLength) return { error: '服务返回空音频' }
    const decoded = await audioPlayer.context.decodeAudioData(buf.slice(0))
    return { synthMs: Math.round(synthMs), audioSec: +decoded.duration.toFixed(2), bytes: buf.byteLength, state: audioPlayer.context.state }
  })()`)

  if (probe.error) {
    console.log(`  ✗ 合成失败：${probe.error}`)
  } else {
    const rtf = (probe.synthMs / 1000 / probe.audioSec).toFixed(2)
    console.log(
      `  合成：${probe.synthMs}ms 出了 ${probe.audioSec}s 音频（${(probe.bytes / 1024).toFixed(0)} KB）→ RTF ${rtf}`,
    )
    console.log(`        AudioContext：${probe.state}`)
    console.log(
      rtf > 1
        ? '        ⚠ RTF > 1：合成比播放还慢，句子一长就会"话赶不上嘴"，听起来像没声音'
        : '        RTF < 1：合成比播放快，正常',
    )
  }

  const play = await ev(`(async () => {
    const { voiceOutput, audioPlayer } = window.__nexusRuntime
    const t0 = performance.now()
    const p = voiceOutput.preview(${JSON.stringify(TEXT)})
    /*
     * ★ 观察窗口必须比"合成"长。
     *   第一版只盯 4 秒，而合成这一句要 8 秒（RTF 1.6），于是报"从没进入 playing" ——
     *   一个**假阴性**：播放其实好得很。所以这里盯到 promise 落地为止（上限 60 秒）。
     */
    let sawPlaying = false
    let firstAudioMs = null
    const watch = (async () => {
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 100))
        if (audioPlayer.isPlaying) { sawPlaying = true; firstAudioMs = Math.round(performance.now() - t0); break }
      }
    })()
    try { await p } catch (e) { await watch; return { error: String(e && e.message || e), sawPlaying, firstAudioMs } }
    await watch
    return { sawPlaying, firstAudioMs, totalMs: Math.round(performance.now() - t0) }
  })()`)

  if (play.error) {
    console.log(`  ✗ 播放失败：${play.error}`)
  } else {
    console.log(
      `  ${play.sawPlaying ? 'OK ' : '✗  '}真的播起来了：${play.sawPlaying}（首音 ${play.firstAudioMs}ms，整句 ${play.totalMs}ms）`,
    )
    if (!play.sawPlaying) console.log('        ⚠ 合成成功但播放状态一直没变成 playing —— 播放链有问题')
  }

  // ④ 麦克风 / barge-in
  const mic = await ev(`(() => {
    const vi = window.__nexusRuntime.voiceInput
    return { status: vi && vi.status, micOpen: vi ? !!(vi.capture || vi['#capture']) : null }
  })()`)
  console.log(`  语音输入状态：${JSON.stringify(mic)}`)
  if (mic.status && mic.status !== 'idle' && mic.status !== 'closed') {
    console.log('        ⚠ 麦克风开着：VAD 只要听到声音（视频、音乐、键盘）就会 barge-in，')
    console.log('          每句刚合成完就被丢掉 —— 这正是"完全没有语音回复"最常见的原因')
  }

  const errs = log.split('\n').filter((l) => /\[tts\]|\[voice|合成失败|播放失败/.test(l))
  if (errs.length) {
    console.log('\n  进程输出里的语音相关日志：')
    for (const l of errs.slice(-6)) console.log(`    ${l.trim()}`)
  }
} catch (err) {
  console.log(`\n✗ 诊断中断：${err.message}`)
  process.exitCode = 1
} finally {
  cdp?.close()
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  try {
    rmSync(base, { recursive: true, force: true })
  } catch {
    /* 临时目录 */
  }
}
