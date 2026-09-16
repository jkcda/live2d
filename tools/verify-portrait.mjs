/**
 * 立绘模式验证脚本：不需要人眼，直接问应用「你现在到底在画哪张图」。
 *
 * 为什么需要它：立绘模式下最容易出的错是**素材加载了但没生效**
 * —— mouth_1.png 文件名写错、尺寸和底图不一致、差分图框偏了……
 * 这些在界面上都是「看起来正常，说话时嘴型不对」，靠肉眼看很费劲。
 * 脚本把三种状态（闭嘴 / 半开 / 大开）和眨眼各自截一张图，
 * 逐像素比出「哪块变了、变了多少」，于是：
 *   · 三张截图完全一样 → 差分没生效（文件没读到，或名字不对）
 *   · 只有脸上一小块在变   → 正确
 *   · 全身大面积在变       → 差分图里混进了 AI 的整张漂移
 *
 * 用法（dev server 必须在 5176 上跑着）：
 *   node tools/verify-portrait.mjs
 *   node tools/verify-portrait.mjs --url "http://localhost:5176/?portrait=1" --keep
 *
 * 截图落在系统临时目录，--keep 时会把路径打出来。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const URL_ = argOf('--url', 'http://localhost:5176/?portrait=1')
const PORT = Number(argOf('--port', '9333'))
const OUT_DIR = argOf('--out', join(tmpdir(), 'nexus-portrait-verify'))

const electron = require('electron')
mkdirSync(OUT_DIR, { recursive: true })

// ────────────────────────────────────────────── 启动宿主

const child = spawn(electron, ['tools/probe-main.cjs', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, PROBE_URL: URL_ },
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
  throw new Error('等不到 Electron 的调试端口 —— 窗口没起来？')
}

// ────────────────────────────────────────────── CDP 小客户端

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

async function main() {
  const page = await findPage()
  const cdp = await connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      throw new Error(`页面里报错：${r.exceptionDetails.exception?.description ?? '未知'}`)
    }
    return r.result?.value
  }

  // 等舞台就绪（素材是异步加载的）
  let ready = null
  for (let i = 0; i < 60; i++) {
    ready = await evaluate(`(() => {
      const s = window.__nexusStage
      if (!s || !s.stage || !s.idle) return null
      return { kind: s.kind }
    })()`)
    if (ready) break
    await sleep(500)
  }
  if (!ready) throw new Error('舞台一直没就绪 —— 看窗口里的报错')

  console.log(`\n模式：${ready.kind}`)
  /*
   * __nexusPortrait.mask 里有 192×342 的 alpha 数组 —— 整包 stringify 会有几百 KB，
   * 上一次就是这么把终端刷爆的。只取需要断言的那几项。
   */
  const snapshot = () =>
    evaluate(`(() => {
      const p = window.__nexusPortrait
      if (!p) return null
      return {
        counts: p.counts,
        shown: JSON.parse(JSON.stringify(p.shown)),
        content: p.manifest ? p.manifest.content : null,
        regions: p.manifest ? Object.keys(p.manifest.regions ?? {}) : [],
        opaqueRatio: +(p.mask.opaqueRatio.toFixed(3)),
      }
    })()`)

  const assets = await snapshot()
  if (!assets) throw new Error('没有 __nexusPortrait —— 当前不是立绘模式？')
  console.log(`素材：${JSON.stringify(assets.counts)}`)
  console.log(`取景：${JSON.stringify(assets.content)}  命中区：${assets.regions.join('/')}`)
  console.log(`命中率：${(assets.opaqueRatio * 100).toFixed(1)}%`)
  console.log(`初始状态：${JSON.stringify(assets.shown)}`)

  const shoot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = join(OUT_DIR, `${name}.png`)
    writeFileSync(file, Buffer.from(r.data, 'base64'))
    return file
  }

  /**
   * 冻住待机动画。
   *
   * ★ 这一步是必须的：待机是每帧都在动的（呼吸/摆动/眨眼），
   *   不冻住的话「闭嘴 vs 大开」两张截图里**整个人**都在动，
   *   逐像素比出来到处都是差异，等于什么都没验证到。
   *   冻住之后画面里唯一会变的就是我们要测的那一块。
   */
  const freezeIdle = async (eyesOpen = true) => {
    await evaluate(`(() => {
      const s = window.__nexusStage
      s.idle.update = () => ({
        ParamBreath: 0,
        ParamEyeLOpen: ${eyesOpen ? 1 : 0},
        ParamEyeROpen: ${eyesOpen ? 1 : 0},
        ParamEyeBallX: 0,
        ParamEyeBallY: 0,
        ParamAngleX: 0,
        ParamAngleY: 0,
        ParamAngleZ: 0,
        ParamBodyAngleX: 0,
        mouth: 0,
      })
      return true
    })()`)
    await sleep(300)
  }

  /** 口型固定成某个值：直接换掉 lipsync.update 的返回值 */
  const setMouth = async (v) => {
    await evaluate(`(() => {
      window.__nexusStage.lipsync.update = () => ${v}
      return true
    })()`)
    await sleep(300)
    return JSON.stringify((await snapshot())?.shown ?? null)
  }

  const shots = {}
  /** 先设状态再截图 —— 反过来就会截到上一张的状态（第一版就是这么错的） */
  const setAndShoot = async (file, mouth) => {
    const shown = await setMouth(mouth)
    const path = await shoot(file)
    return { shown, path }
  }

  await freezeIdle(true)
  const closed = await setAndShoot('mouth-closed', 0)
  console.log(`闭嘴   → ${closed.shown}`)

  const half = await setAndShoot('mouth-1', 0.3)
  console.log(`半开   → ${half.shown}`)

  const wide = await setAndShoot('mouth-2', 0.9)
  console.log(`大开   → ${wide.shown}`)

  await setMouth(0)
  await freezeIdle(true)
  const eyesOpen = await shoot('eyes-open')

  await freezeIdle(false)
  const eyesClosed = await shoot('eyes-closed')
  console.log(`闭眼   → ${JSON.stringify((await snapshot())?.shown ?? null)}`)

  /*
   * 口型渐变：从「闭嘴」到「全开」取几个点各截一张。
   * 为什么必须测这个：立绘只有离散热差分，中间开口度是靠纵向缩放凑的 ——
   * 一旦映射写错，表现就是「说话时只有闭/全开两态」，看着像全程张嘴。
   * 验收标准：mouthScale 单调递增，且变化像素数也单调递增。
   */
  await freezeIdle(true)
  const ramp = []
  for (const m of [0, 0.15, 0.35, 0.6, 1.0]) {
    await setMouth(m)
    const shot = await shoot(`mouth-ramp-${String(m).replace('.', '_')}`)
    const st = (await snapshot())?.shown
    ramp.push({ mouthParam: m, shown: st, shot })
    console.log(`开口度 ${m.toFixed(2)} → 差分#${st.mouthIndex} 纵向缩放 ${st.mouthScale.toFixed(3)}`)
  }
  writeFileSync(join(OUT_DIR, 'ramp.json'), JSON.stringify(ramp, null, 2))

  shots.mouthClosed = closed.path
  shots.mouth1 = half.path
  shots.mouth2 = wide.path
  shots.eyesOpen = eyesOpen
  shots.eyesClosed = eyesClosed

  const result = { url: URL_, kind: ready.kind, shots, outDir: OUT_DIR }
  console.log(`\n截图目录：${OUT_DIR}`)
  console.log(JSON.stringify(result, null, 2))
  writeFileSync(join(OUT_DIR, 'result.json'), JSON.stringify(result, null, 2))

  cdp.close()
  child.kill()
  // 不用 process.exit()：管道下它会把还没冲出去的 stdout 丢掉（表现为「什么也没打印」）
  process.exitCode = 0
}

main().catch((err) => {
  console.error(`\n验证失败：${err.message}`)
  child.kill()
  process.exitCode = 1
})
