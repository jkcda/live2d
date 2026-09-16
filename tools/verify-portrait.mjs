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
  env: {
    ...process.env,
    PROBE_URL: URL_,
    /*
     * 窗口放大一点：视线用例要往四个方向移动鼠标，而角色是**铺满窗口**的，
     * 脸天然靠近顶部（18% 高度处）。窗口太矮时"鼠标移到脸上面"会撞到控制条，
     * 指针被判为离开 → 读不到"往上看"。窗口高一些才有余量。
     */
    PROBE_WIDTH: argOf('--width', '1000'),
    PROBE_HEIGHT: argOf('--height', '1400'),
  },
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
  /*
   * 全程把视线钉在正中（除视线用例自己会改）。
   *
   * 为什么：真机上物理鼠标就在窗口里，指针一动瞳孔和整体都会跟着偏 ——
   * 那些靠截图逐像素比的用例（口型换图、待机漂移）就会被污染，
   * 表现为"变化像素忽多忽少"，排查起来很费劲。
   */
  await evaluate(`(window.__nexusGazeOverride = { x: 0, y: 0 })`)
  /*
   * 不是立绘模式（比如 ?live2d=1）时，立绘专属的断言跳过 ——
   * 但**待机漂移**这条对两个渲染器都成立，所以照样测（见文件末尾）。
   */
  const portrait = Boolean(assets)
  if (portrait) {
    console.log(`素材：${JSON.stringify(assets.counts)}`)
    console.log(`取景：${JSON.stringify(assets.content)}  命中区：${assets.regions.join('/')}`)
    console.log(`命中率：${(assets.opaqueRatio * 100).toFixed(1)}%`)
    console.log(`初始状态：${JSON.stringify(assets.shown)}`)
  } else {
    const info = await evaluate(`(() => {
      const s = window.__nexusStage.stage
      return { kind: s.kind, lipSync: s.abilities.lipSyncParams, motions: s.abilities.motionGroups }
    })()`)
    console.log(
      `渲染器：${info.kind}｜口型参数 ${JSON.stringify(info.lipSync)}｜动作组 ${JSON.stringify(info.motions)}`,
    )
    console.log('（不是立绘模式，跳过立绘专属断言，只测待机漂移）')
  }

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

  // 以下到 ramp 为止都是立绘专属（口型换图 / 眨眼换图），Live2D 没有这些概念
  let closed = null
  let half = null
  let wide = null
  let eyesOpen = null
  let eyesClosed = null
  if (portrait) {
    await freezeIdle(true)
    closed = await setAndShoot('mouth-closed', 0)
    console.log(`闭嘴   → ${closed.shown}`)

    half = await setAndShoot('mouth-1', 0.3)
    console.log(`半开   → ${half.shown}`)

    wide = await setAndShoot('mouth-2', 0.9)
    console.log(`大开   → ${wide.shown}`)

    await setMouth(0)
    await freezeIdle(true)
    eyesOpen = await shoot('eyes-open')

    await freezeIdle(false)
    eyesClosed = await shoot('eyes-closed')
    console.log(`闭眼   → ${JSON.stringify((await snapshot())?.shown ?? null)}`)
  }

  /*
   * 口型渐变：从「闭嘴」到「全开」取几个点各截一张。
   * 为什么必须测这个：立绘只有离散热差分，中间开口度是靠纵向缩放凑的 ——
   * 一旦映射写错，表现就是「说话时只有闭/全开两态」，看着像全程张嘴。
   * 验收标准：mouthScale 单调递增，且变化像素数也单调递增。
   */
  await freezeIdle(true)
  const ramp = []
  if (portrait) {
    for (const m of [0, 0.15, 0.35, 0.6, 1.0]) {
      await setMouth(m)
      const shot = await shoot(`mouth-ramp-${String(m).replace('.', '_')}`)
      const st = (await snapshot())?.shown
      ramp.push({ mouthParam: m, shown: st, shot })
      console.log(`开口度 ${m.toFixed(2)} → 差分#${st.mouthIndex} 纵向缩放 ${st.mouthScale.toFixed(3)}`)
    }
    writeFileSync(join(OUT_DIR, 'ramp.json'), JSON.stringify(ramp, null, 2))
  }

  /*
   * 表情差分。
   *
   * 验的是三件**互相独立**的事，缺一件都会「看起来做了表情但不对」：
   *   1. 切过去之后那张差分确实被画上去了（读 Pixi 场景的可见性，不是读状态变量）
   *   2. 闭嘴时表情**自己那张嘴**露着（被遮了的话表情就白做了）
   *   3. 说话时它让位给口型 —— 否则底图的嘴和表情的嘴会同时在脸上
   *
   * 判据 3 光靠数值不够硬，所以每个状态都截了图：
   * `expr-<id>-talk` 与 `expr-neutral-talk`（同样的开口度）拿去逐像素比，
   * **嘴那一块必须完全一样**，而眉眼那块必须不一样。
   */
  const exprChecks = []
  if (portrait) {
    const info = await evaluate(`(() => {
      const p = window.__nexusPortrait
      return { available: p.expressions, cover: p.mouthCoverBox }
    })()`)
    const layers = () =>
      evaluate(`JSON.parse(JSON.stringify(window.__nexusPortrait.layers()))`)
    const setExpression = async (id) => {
      await evaluate(`window.__nexusPortrait.setExpression(${id === null ? 'null' : `'${id}'`})`)
      await sleep(260)
      return layers()
    }

    console.log(
      `\n表情：素材 ${info.available.length} 张（${info.available.map((e) => `${e.id}=${e.label}`).join('、') || '无'}）` +
        `｜遮嘴矩形 ${info.cover ? `${info.cover.x},${info.cover.y} ${info.cover.width}×${info.cover.height}` : '无'}`,
    )

    await freezeIdle(true)
    await setMouth(0)
    const neutralSilent = await shoot('expr-neutral')
    await setMouth(0.5)
    const neutralTalk = await shoot('expr-neutral-talk')
    console.log(`素颜：闭嘴 ${JSON.stringify(await layers())}`)

    const exprShots = {}
    for (const e of info.available) {
      await setMouth(0)
      const silent = await setExpression(e.id)
      const silentShot = await shoot(`expr-${e.id}`)

      await setMouth(0.5)
      const talk = await setExpression(e.id)
      const talkShot = await shoot(`expr-${e.id}-talk`)
      const shown = (await snapshot())?.shown ?? {}

      console.log(
        `  ${e.label}(${e.id})：闭嘴→图层 ${silent.expressionVisible ? `显示「${silent.expressionId}」` : '未显示'}` +
          `｜说话→图层 ${talk.expressionVisible ? '显示' : '未显示'}、遮嘴 ${talk.mouthCoverVisible ? '开（口型接管）' : '关'}` +
          `｜口型差分区 #${shown.mouthIndex}`,
      )

      exprShots[e.id] = { silent: silentShot, talk: talkShot }
      exprChecks.push(
        [`${e.label}：切过去后差分真的画上去了`, silent.expressionVisible && silent.expressionId === e.id],
        [`${e.label}：闭嘴时表情自己的嘴露着`, silent.mouthCoverVisible === false],
        [
          `${e.label}：说话时表情的嘴让位给口型`,
          talk.expressionVisible && talk.mouthCoverVisible === true && (shown.mouthIndex ?? 0) > 0,
        ],
      )
    }

    const cleared = await setExpression(null)
    // 素颜 + 说话：这时候没有"表情的嘴"要遮，遮罩必须是关的
    await setMouth(0.5)
    const neutralTalking = await layers()
    await setMouth(0)
    exprChecks.push(['收回素颜后表情图层隐藏', cleared.expressionVisible === false])
    exprChecks.push(
      ['遮嘴矩形落在嘴的位置上（存在且小于整张画布）', Boolean(info.cover) && info.cover.width < 200],
    )
    exprChecks.push(['素颜时说话不遮嘴（没有表情的嘴要遮）', neutralTalking.mouthCoverVisible === false])

    let ok = true
    for (const [label, pass] of exprChecks) {
      if (!pass) ok = false
      console.log(`  ${pass ? '✅' : '❌'} ${label}`)
    }

    /*
     * 点击 → 表情：走的是 Live2D 那套情绪编排（摸头想要开心/害羞，戳身体想要惊讶/不满），
     * 只是立绘的情绪由文件名声明（见 portrait/expressions.ts）。
     *
     * ★ 两条断言缺一不可：
     *   戳身体**必须**变脸 —— 伤心/生气都算 unhappy，正好对得上"戳一下她不满"；
     *   摸头**必须不变脸** —— 素材里没有开心/害羞，strict 模式下宁可没反应，
     *   也不能像 Live2D 那样随机甩一张生气的脸出来（那是这套编排最容易做错的地方）。
     */
    const pokes = []
    for (const area of ['Body', 'Body', 'Head']) {
      await setExpression(null)
      await evaluate(`window.__nexusStage.stage.react(['${area}'])`)
      await sleep(220)
      const state = await layers()
      // 反应的弹跳还在进行，这里只读图层，不看像素
      pokes.push({ area, expression: state.expressionId, visible: state.expressionVisible })
      console.log(`  戳${area === 'Head' ? '头' : '身体'} → ${state.expressionVisible ? `换脸「${state.expressionId}」` : '不变脸（保持素颜）'}`)
    }
    exprChecks.push(
      ['戳身体 → 按情绪挑到不满系表情（生气/伤心）', pokes[0].visible && ['angry', 'sad'].includes(pokes[0].expression)],
      ['戳身体 → 连着戳会换一张（不是永远同一张脸）', pokes[1].visible],
      ['摸头 → 没有开心/害羞素材时不变脸（strict）', pokes[2].visible === false],
    )

    // 限时表情到点自己回到素颜（4s）—— 表情是"反应"，不该永久挂在脸上
    await setExpression(null)
    await evaluate(`window.__nexusStage.stage.react(['Body'])`)
    // 图层可见性是**每帧**在 applyFrame 里刷的，react 之后要等一帧才读得到
    await sleep(250)
    const duringPoke = await layers()
    await sleep(4600)
    const afterHold = await layers()
    exprChecks.push([
      '点击给的表情 4 秒后自动收回',
      duringPoke.expressionVisible === true && afterHold.expressionVisible === false,
    ])
    console.log(
      `  限时表情：戳完 ${duringPoke.expressionVisible ? '显示' : '没显示'} → 4.6s 后 ${afterHold.expressionVisible ? '还挂着 ❌' : '已收回 ✅'}`,
    )

    for (const [label, pass] of exprChecks.slice(-4)) {
      if (!pass) ok = false
      console.log(`  ${pass ? '✅' : '❌'} ${label}`)
    }
    if (!ok) console.log('  ⚠ 表情用例有失败项')
    writeFileSync(
      join(OUT_DIR, 'expressions.json'),
      JSON.stringify({ info, neutralSilent, neutralTalk, shots: exprShots }, null, 2),
    )
  }

  /*
   * 待机漂移：隔一段时间连拍若干张，交给外部逐像素比。
   *
   * 为什么要测这个：待机是**永远在跑**的，一旦旋转支点/幅度不对，
   * 角色就会「一直在漂浮」（曾经就是这样：旋转绕画布左上角做，
   * 微摆被放大成半径 1600px 的圆弧漂移）。判据不是"好不好看"，而是
   * 「角色轮廓的上沿/下沿各漂了多少像素」——底沿应该几乎不动。
   */
  const idleSeries = async (factor, tag, frames = 8, gapMs = 260) => {
    await freezeIdle(true)
    // 解开冻结：用真的 IdleAnimator 才测得到待机本身
    await evaluate(`(() => {
      delete window.__nexusStage.idle.update
      window.__nexusRuntime.idleRuntime.factor = ${factor}
      return true
    })()`)
    await sleep(600)
    const files = []
    for (let i = 0; i < frames; i++) {
      files.push(await shoot(`idle-${tag}-${i}`))
      await sleep(gapMs)
    }
    return files
  }

  /*
   * 视线跟随。
   *
   * ★ 两个坑都在这段里踩过，注释留着免得再犯：
   *   1. **不能用截图测**：鼠标一动控制条就浮现，轮廓包围盒立刻被 UI 污染，
   *      量出来的位移根本不是角色的（第一版得到的"鼠标在右只移了 1.5px"就是这么来的）。
   *      改成读数值：驱动输出 / 送进渲染器的帧 / 立绘根节点变换，三者要对得上。
   *   2. **不能注入目标**：渲染循环每帧都会 `aim(pointer)`，注入的值下一帧就被覆盖
   *      （第一版读到的 (0.48,-0.53) 就是覆盖后剩下的残值）。
   *      所以要真的派鼠标事件 —— 反正读的是数值，不怕界面浮现。
   */
  const gazeRows = []
  await evaluate(`(window.__nexusRuntime.idleRuntime.factor = 0)`)
  await sleep(300)
  const anchor = await evaluate(`window.__nexusStage.stage.anchor('head')`)
  /*
   * 视线用**覆盖值**驱动，不派鼠标事件。
   *
   * 踩过的坑：合成鼠标事件会被真实指针盖掉（窗口里物理鼠标动一下就是一次 pointermove），
   * 于是读出来的方向跟注入值毫无关系；另外鼠标移到角色上还会浮出控制条，
   * 污染基于截图的测量。覆盖值让这个用例与鼠标无关，结果才是确定的。
   */
  const cases = [
    ['脸原位', 0, 0],
    ['看左', -1, 0],
    ['看右', 1, 0],
    ['看上', 0, 1],
    ['看下', 0, -1],
  ]
  for (const [label, gx, gy] of cases) {
    await evaluate(`(window.__nexusGazeOverride = { x: ${gx}, y: ${gy} })`)
    await sleep(700) // 平滑时间常数 130ms，700ms 足够收敛
    const row = await evaluate(`(() => {
      const s = window.__nexusStage
      const t = window.__nexusPortrait ? window.__nexusPortrait.transform() : null
      const shown = window.__nexusPortrait ? JSON.parse(JSON.stringify(window.__nexusPortrait.shown)) : null
      return {
        gaze: s.gaze.value(),
        pointer: s.pointer,
        anchor: s.anchor,
        frame: s.lastFrame ? { x: s.lastFrame.gazeX, y: s.lastFrame.gazeY } : null,
        transform: t,
        pupil: shown ? { x: shown.pupilX, y: shown.pupilY } : null,
      }
    })()`)
    gazeRows.push({ label, target: [gx, gy], ...row })
  }
  console.log(`\n视线跟随（待机已置 0，锚点 ${anchor.x.toFixed(0)},${anchor.y.toFixed(0)}）：`)
  console.log('  鼠标      应用看到的指针   驱动输出        瞳孔偏移           整体位移         旋转')
  const base = gazeRows[0]
  for (const r of gazeRows) {
    const dx = r.transform && base.transform ? r.transform.x - base.transform.x : 0
    const dy = r.transform && base.transform ? r.transform.y - base.transform.y : 0
    const rot = r.transform ? `${r.transform.rotationDeg.toFixed(2)}°` : '?'
    const p = r.pointer ? `${r.pointer.x},${r.pointer.y}` : 'null'
    const pu = r.pupil ? `(${r.pupil.x.toFixed(1)},${r.pupil.y.toFixed(1)})` : '无图层'
    console.log(
      `  ${r.label}  ${p}`.padEnd(26) +
        `(${r.gaze.x.toFixed(2)},${r.gaze.y.toFixed(2)})`.padEnd(16) +
        pu.padEnd(19) +
        `Δ(${dx.toFixed(1)},${dy.toFixed(1)}) px`.padEnd(17) +
        rot,
    )
  }
  const hasPupil = Boolean(gazeRows[1].pupil)
  console.log(`  瞳孔图层：${hasPupil ? '有（眼睛会真的动）' : '没有（只能整体视差）'}`)
  const g = (i) => gazeRows[i].gaze
  const d = (i, axis) => {
    const b = gazeRows[0].transform
    const t = gazeRows[i].transform
    if (!b || !t) return 0
    return axis === 'x' ? t.x - b.x : t.y - b.y
  }
  // 顺序：脸原位 / 看左 / 看右 / 看上 / 看下
  // 注意：身体幅度现在**故意为 0**（只有瞳仁动），所以这里断言的是"身体别动"
  const checks = [
    ['看左 → gazeX 明显为负', g(1).x < -0.6],
    ['看右 → gazeX 明显为正', g(2).x > 0.6],
    ['看上 → gazeY 明显为正', g(3).y > 0.6],
    ['看下 → gazeY 明显为负', g(4).y < -0.6],
    ['看左/右 → 身体不跟着晃', Math.abs(d(1, 'x')) < 0.5 && Math.abs(d(2, 'x')) < 0.5],
    ['看上/下 → 身体不跟着晃', Math.abs(d(3, 'y')) < 0.5 && Math.abs(d(4, 'y')) < 0.5],
    ['驱动输出 = 送进渲染器的值', Math.abs(g(1).x - (gazeRows[1].frame?.x ?? 99)) < 0.02],
  ]
  // 有瞳孔图层时再加三条：瞳孔方向和幅度要对（它才是"眼睛真的在动"）
  if (gazeRows[1].pupil) {
    const pu = (i, axis) => {
      const b = gazeRows[0].pupil
      const t = gazeRows[i].pupil
      return axis === 'x' ? t.x - b.x : t.y - b.y
    }
    checks.push(
      ['瞳孔跟着看左（画布像素，负）', pu(1, 'x') < -1.5 && Math.abs(pu(1, 'x')) <= 3.5],
      ['瞳孔跟着看右（画布像素，正）', pu(2, 'x') > 1.5 && pu(2, 'x') <= 3.5],
      ['瞳孔跟着看下（屏幕上往下）', pu(4, 'y') > 2.5 && pu(4, 'y') <= 4.5],
    )
  }
  let allOk = true
  for (const [label, ok] of checks) {
    if (!ok) allOk = false
    console.log(`  ${ok ? '✅' : '❌'} ${label}`)
  }
  writeFileSync(join(OUT_DIR, 'gaze.json'), JSON.stringify({ anchor, rows: gazeRows }, null, 2))
  await evaluate(
    `(() => {
      window.__nexusGazeOverride = null
      window.__nexusStage.gaze.reset()
      window.__nexusRuntime.idleRuntime.factor = 1
      return true
    })()`,
  )
  if (!allOk) console.log('  ⚠ 视线用例有失败项')

  await setMouth(0)
  const idleNormal = await idleSeries(1, 'normal')
  const idleOff = await idleSeries(0, 'off')
  console.log(`待机样本：normal ${idleNormal.length} 张、off ${idleOff.length} 张`)
  writeFileSync(join(OUT_DIR, 'idle.json'), JSON.stringify({ idleNormal, idleOff }, null, 2))

  /*
   * 热插拔：换角色**不该刷新页面**。
   *
   * 判据很硬：先在页面上放一个标记，切完角色后标记还在 ⇒ 页面没有重新加载。
   * （光看"角色变了"不够 —— 刷新页面也能让角色变，但那样正在播放的语音会被打断。）
   */
  const packs = await evaluate(`window.__nexusCharacter ? window.__nexusCharacter.list() : null`)
  if (packs && packs.length > 1) {
    const before = await evaluate(`(() => {
      window.__hotSwapMarker = 'alive-' + Date.now()
      return window.__nexusStage.kind
    })()`)
    const target = packs.find((p) => p.kind !== before) ?? packs[0]
    console.log(`\n热插拔：${before} → ${target.kind}（${target.name}）`)
    await evaluate(`window.__nexusCharacter.select('${target.id}')`)
    await sleep(2500)
    const after = await evaluate(`(() => ({
      marker: window.__hotSwapMarker ?? null,
      kind: window.__nexusStage ? window.__nexusStage.kind : null,
      pack: window.__nexusStage && window.__nexusStage.pack ? window.__nexusStage.pack.id : null,
      canvases: document.querySelectorAll('canvas').length,
    }))()`)
    const kept = typeof after.marker === 'string'
    const swapped = after.pack === target.id
    console.log(
      `  切换后：kind=${after.kind} pack=${after.pack} canvas 数=${after.canvases}` +
        `｜角色真的换了 ${swapped ? '✅' : '❌'}｜页面标记${kept ? '还在 ⇒ 没有刷新页面 ✅' : '没了 ⇒ 发生了刷新 ❌'}`,
    )
    await shoot(`after-switch-${target.kind}`)
    // 切回去，别把用户的选择改掉
    const back = packs.find((p) => p.kind === before) ?? packs[0]
    await evaluate(`window.__nexusCharacter.select('${back.id}')`)
    await sleep(2000)
  }

  shots.mouthClosed = closed?.path
  shots.mouth1 = half?.path
  shots.mouth2 = wide?.path
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
