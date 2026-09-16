/**
 * 立绘（PNGTuber）渲染层。
 *
 * 与 Live2D 渲染层实现同一个 `CharacterStage` 接口，所以交互逻辑完全复用：
 * 悬浮判定、点击反应、口型、待机都是同一套代码，只是「参数帧」的解释方式不同。
 *
 * Live2D：参数写进模型，由 Cubism 算出形变。
 * 立绘：参数被当成**语义**解释 ——
 *   呼吸 → 上下浮动 + 轻微缩放
 *   头部偏转 → 位移 + 旋转
 *   口型 → 换嘴差分（没有差分就拉伸下巴）
 *   眨眼 → 换眼差分
 *
 * 这是 PNGTuber 的通行做法：离散换图，不做形变。看起来「够活」，成本几乎为零。
 */

import { Application, Container, Sprite } from 'pixi.js'
import type { CharacterAbilities, CharacterFrame, CharacterStage } from '../character/types'
import {
  buildAlphaMask,
  loadPortrait,
  splitAtJaw,
  type PortraitManifest,
} from './assets'

/** idle.ts 里各参数的标称幅度，用来把参数归一化成 0~1 再映射到位移/旋转 */
const ANGLE_X_RANGE = 4
const ANGLE_Z_RANGE = 1.4
const BODY_ANGLE_RANGE = 2

/** 低于这个开口度就是「闭嘴」= 不叠任何差分 */
const CLOSED_LEVEL = 0.1
/** 刚开口时的最小缩放：再小就看不出张开了，只剩一条缝 */
const MIN_OPEN_SCALE = 0.35

/**
 * 开口度 → (用第几张差分, 纵向缩放)。
 *
 * 为什么需要这么个映射：立绘只有「离散热差分」，而**说话时振幅几乎不会掉到闭嘴阈值以下**
 * ——直接按阈值二选一的话，看起来就是全程张嘴（这是实际踩过的坑）。
 * 所以中间那些开口度靠**纵向缩放**凑：
 *
 *   1. 先算一个连续的开度 openness（0.35~1，低开度用幂函数抬一抬，
 *      因为小振幅在听觉上也是"在说话"，嘴不能只开一条缝）；
 *   2. 有多少张差分就有几档，取「第一档标称开度 ≥ openness」的那张；
 *   3. 缩放 = openness / 该档标称开度 —— 于是换图那一刻两张的**视觉大小是连着的**，
 *      不会出现「突然大一圈」的跳变。
 *
 * 只有一张差分时（最常见）：永远用它，缩放直接就是 openness。
 */
export function mouthLevel(m: number, tiers: number): { index: number; scale: number } {
  if (tiers <= 1) return { index: Math.max(0, tiers - 1), scale: 1 }
  const art = tiers - 1 // 真·差分张数（索引 0 是「闭嘴」= 空纹理）
  if (m < CLOSED_LEVEL) return { index: 0, scale: 1 }

  const t = Math.min(1, Math.max(0, (m - CLOSED_LEVEL) / (1 - CLOSED_LEVEL)))
  const openness = MIN_OPEN_SCALE + (1 - MIN_OPEN_SCALE) * Math.pow(t, 0.7)

  let index = art
  for (let k = 1; k <= art; k++) {
    if (openness <= k / art + 1e-6) {
      index = k
      break
    }
  }
  const nominal = index / art
  return { index, scale: Math.min(1, Math.max(MIN_OPEN_SCALE, openness / nominal)) }
}

export interface PortraitStageOptions {
  /** 素材目录，默认 `portrait` */
  baseUrl?: string
}

export async function createPortraitStage(
  host: HTMLElement,
  opts: PortraitStageOptions = {},
): Promise<CharacterStage> {
  const assets = await loadPortrait(opts.baseUrl ?? 'portrait')
  const manifest = assets.manifest
  const canvasW = manifest.canvas.width
  const canvasH = manifest.canvas.height

  const app = new Application()
  await app.init({
    backgroundAlpha: 0,
    antialias: true,
    preference: 'webgl',
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    resizeTo: host,
  })
  host.appendChild(app.canvas)

  // ── 图层。z 顺序靠 addChild 顺序决定
  const root = new Container()
  app.stage.addChild(root)

  if (assets.hairBack) root.addChild(new Sprite(assets.hairBack))

  /*
   * 底图：有嘴差分就整张放；没有就沿下巴分界线切成两半，靠拉伸下半张做张嘴。
   * 拉伸而不是平移，是为了不露出断口。
   */
  const mouthStates = assets.mouths
  const hasMouthArt = mouthStates.length > 0
  const jawLineRatio = manifest.jawLine ?? 0.5

  let jaw: Container | null = null
  if (hasMouthArt) {
    root.addChild(new Sprite(assets.body))
  } else {
    const { upper, lower, jawY } = splitAtJaw(assets.body, canvasH * jawLineRatio)
    root.addChild(new Sprite(upper))
    jaw = new Container()
    jaw.position.set(0, jawY)
    const lowerSprite = new Sprite(lower)
    lowerSprite.position.set(0, 0)
    jaw.addChild(lowerSprite)
    root.addChild(jaw)
  }

  const eyes = assets.eyesOpen ? new Sprite(assets.eyesOpen) : null
  if (eyes) root.addChild(eyes)

  const mouth = hasMouthArt ? new Sprite(mouthStates[0]) : null
  if (mouth) {
    /*
     * ★ 支点 = 差分内容的 alpha 质心（大致就是嘴的中线）。
     *
     * 立绘只有一张嘴差分时，中间的开口度靠纵向缩放凑出来（见 applyFrame 里的 mouthScale）。
     * 而差分是**叠在底图上**的 —— 底图那张闭嘴脸一直在下面，
     * 支点选错就会露馅：一开始我按「区间上边缘」当支点，一压扁整块往上缩，
     * 底图那条闭嘴线就从下面露出来，看起来像「底图的闭嘴一直在」。
     * 绕质心缩放则两头都稳：嘴不跑位，闭嘴线一直被盖住。
     */
    const patch = assets.mouthPatches.find((p) => p)
    if (patch) {
      mouth.pivot.set(patch.anchorX, patch.anchorY)
      mouth.position.set(patch.anchorX, patch.anchorY)
    }
    root.addChild(mouth)
  }

  const hairFront = assets.hairFront ? new Sprite(assets.hairFront) : null
  if (hairFront) root.addChild(hairFront)

  // ── 程序化反应：点她之后的弹跳/歪头
  let reactionUntil = 0
  let reactionKind: 'head' | 'body' = 'body'

  // ── 轮廓遮罩
  const mask = await buildAlphaMask(assets)
  /** 底图是不是整张不透明（没抠背景）—— 见 hitTest 里的退化处理 */
  const maskOpaque = mask.opaqueRatio > 0.9
  if (maskOpaque && import.meta.env.DEV) {
    console.warn(
      `[portrait] 底图看起来没有透明背景（不透明像素占 ${(mask.opaqueRatio * 100).toFixed(0)}%），` +
        '轮廓判定会退化成矩形。建议把背景抠掉，否则桌宠的「只有她身上才响应」会失效。',
    )
  }

  // ── 布局
  let viewW = app.renderer.width
  let viewH = app.renderer.height
  let scale = 1

  const content = manifest.content
  const contentHeightPx = content ? content.height * canvasH : canvasH
  const contentWidthPx = content ? content.width * canvasW : canvasW

  /*
   * ★ 旋转/缩放的支点 = 角色**底部中点**（腰或脚）。
   *
   * 这是踩过的坑：root 不设 pivot 时，旋转是绕**画布左上角 (0,0)** 做的，
   * 而角色中心离那个角有 1600 多像素 —— 于是「微摆 ±2.8°」被当成半径 1600 的圆弧，
   * 整个人横向漂 ±80 像素、纵向也跟着画圈，看起来就是**一直在漂浮**，
   * 而不是站在原地轻微摇晃。呼吸缩放同理（绕角缩放会把底边推出去）。
   *
   * 绕底部中点就对了：脚（下半身边缘）钉住，上半身轻微晃，这才是待机该有的样子。
   */
  const pivotX = (content ? content.x + content.width / 2 : 0.5) * canvasW
  const pivotY = (content ? content.y + content.height : 1) * canvasH
  root.pivot.set(pivotX, pivotY)

  const layout = (width: number, height: number) => {
    if (width <= 0 || height <= 0) return
    viewW = width
    viewH = height
    scale = height / contentHeightPx
    root.scale.set(scale)
    // 锚在底边居中：与 Live2D 那边的取景保持一致
    root.position.set((width - contentWidthPx * scale) / 2, height - (canvasH - (content?.y ?? 0) * canvasH) * scale)
  }

  /*
   * 待机幅度。
   *
   * 默认值调小过一轮：原来 bobPercent 1.2% / swayDegrees 2.2°，配上「绕画布角旋转」
   * 那个 bug，看起来就像在飘。现在支点修对了（绕底部中点），幅度也收到
   * 「能看出在呼吸、但不注意就看不出来」的程度 —— 待机不该抢戏。
   * 嫌太静或太动，都能在 portrait.json 的 motion 里覆盖，或直接用
   * 设置 → 角色 → 待机动作 整体加减。
   */
  const motion = {
    bobPercent: manifest.motion?.bobPercent ?? 0.004,
    swayDegrees: manifest.motion?.swayDegrees ?? 0.8,
    breatheScale: manifest.motion?.breatheScale ?? 0.004,
  }

  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

  /** 当前显示的嘴型索引 / 眼睛状态 —— 换图是离散的，出问题时必须能一眼看出换到了哪张 */
  const shown = { mouthIndex: -1, mouthScale: 1, eyesOpen: true, jawStretch: 1 }

  const applyFrame = (frame: CharacterFrame) => {
    const breath = clamp01(frame.ParamBreath)
    const now = performance.now()
    const reacting = now < reactionUntil
    const reactPhase = reacting ? (reactionUntil - now) / 420 : 0

    // 呼吸：上下浮动 + 轻微放大
    const bob = -breath * motion.bobPercent * contentHeightPx
    const breathe = 1 + breath * motion.breatheScale
    // 头部偏转：归一化 → 位移/旋转（单位是「度」，Pixi 用弧度）
    const yaw = frame.ParamAngleX / ANGLE_X_RANGE
    const tilt = frame.ParamAngleZ / ANGLE_Z_RANGE
    const lean = frame.ParamBodyAngleX / BODY_ANGLE_RANGE

    let extraRot = 0
    let extraY = 0
    let extraX = 0
    if (reacting) {
      // 摸头：点头示意（前后小幅摆动）；戳身体：弹一下
      const damp = Math.sin(reactPhase * Math.PI * 3) * reactPhase
      if (reactionKind === 'head') {
        extraRot = damp * 4
        extraY = -Math.abs(damp) * 6
      } else {
        extraY = -Math.abs(damp) * 14
        extraRot = damp * 2
      }
      extraX = damp * 2
    }

    /*
     * 位置 = 基准位 + 缩放后支点的偏移。
     * 因为设了 pivot，Pixi 画的是 position + R·S·(local - pivot)，
     * 所以要把「支点本身也应落在基准位」这件事补回来，否则一设 pivot 整个角色会跳走。
     */
    const s = scale * breathe
    root.position.set(
      (viewW - contentWidthPx * s) / 2 + yaw * 0.012 * contentWidthPx * s + extraX + pivotX * s,
      viewH - (canvasH - (content?.y ?? 0) * canvasH) * s + bob + extraY + pivotY * s,
    )
    root.rotation = ((tilt * motion.swayDegrees + lean * 0.6 + extraRot) * Math.PI) / 180
    root.scale.set(s, s)

    // 前发比身体动得多一点，看起来有惯性
    if (hairFront) {
      hairFront.position.set(tilt * 3 + extraX * 0.5, breath * 2)
    }

    // 眨眼：换图（没有眼差分就什么都不做）
    if (eyes && assets.eyesClosed) {
      const open = (frame.ParamEyeLOpen + frame.ParamEyeROpen) / 2
      shown.eyesOpen = open >= 0.5
      eyes.texture = shown.eyesOpen ? assets.eyesOpen! : assets.eyesClosed
    }

    // 口型
    const m = clamp01(frame.mouth)
    if (mouth && mouthStates.length) {
      const pick = mouthLevel(m, mouthStates.length)
      shown.mouthIndex = pick.index
      shown.mouthScale = pick.scale
      mouth.texture = mouthStates[pick.index]
      /*
       * 纵向缩放做出中间档。
       * 只有一张嘴差分时（最常见的情况），要是不缩放，口型就只剩「闭 / 全开」两态，
       * 而说话时振幅几乎一直在阈值以上 —— 看起来就是**全程张嘴**。
       * 横向**不缩放**：嘴的宽度收窄会让底图那条闭嘴线的两端露出来。
       */
      mouth.scale.set(1, pick.scale)
    } else if (jaw) {
      // 没嘴差分：拉伸下半张脸代替张嘴（幅度刻意克制，不然会像橡皮）
      shown.jawStretch = 1 + m * 0.05
      jaw.scale.set(1, shown.jawStretch)
    }
  }

  const hitTest = (clientX: number, clientY: number): boolean => {
    const rect = app.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    // 屏幕 → 画布比例坐标
    const nx = (clientX - rect.left) / rect.width
    const ny = (clientY - rect.top) / rect.height
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return false

    /*
     * 底图没有透明背景时（整张图都是不透明的），像素遮罩会变成「处处都命中」，
     * 轮廓判定就失去意义了。这时退化成「角色包围盒」矩形判定 ——
     * 虽然不精确，但至少不会让整块窗口都吃掉鼠标事件。
     */
    if (maskOpaque) {
      const c = manifest.content
      if (!c) return true
      return nx >= c.x && nx <= c.x + c.width && ny >= c.y && ny <= c.y + c.height
    }

    // 画布比例 → 遮罩坐标（遮罩覆盖整张画布）
    const mx = Math.min(mask.width - 1, Math.max(0, Math.round(nx * mask.width)))
    const my = Math.min(mask.height - 1, Math.max(0, Math.round(ny * mask.height)))
    return mask.alpha[my * mask.width + mx] > 40
  }

  const hitAreaAt = (clientX: number, clientY: number): string[] => {
    const rect = app.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return []
    const nx = (clientX - rect.left) / rect.width
    const ny = (clientY - rect.top) / rect.height

    const regions = manifest.regions ?? {}
    const hits: string[] = []
    for (const [name, r] of Object.entries(regions)) {
      if (nx >= r.x && nx <= r.x + r.width && ny >= r.y && ny <= r.y + r.height) {
        hits.push(name)
      }
    }
    return hits
  }

  const abilities: CharacterAbilities = {
    lipSyncParams: [],
    expressionNames: [],
    motionGroups: {},
  }

  const stage: CharacterStage = {
    kind: 'portrait',
    abilities,
    layout,
    applyFrame,
    hitTest,
    hitAreaAt,
    react(areas: string[]) {
      reactionKind = areas[0] === 'Head' ? 'head' : 'body'
      reactionUntil = performance.now() + 420
      if (import.meta.env.DEV) {
        console.debug(`[stage] 被点了 ${JSON.stringify({ areas, reaction: reactionKind })}`)
        Object.assign(window as unknown as Record<string, unknown>, {
          __nexusLastPoke: { areas, reaction: reactionKind },
        })
      }
    },
    destroy() {
      app.destroy(true, { children: true })
    },
  }

  layout(app.renderer.width, app.renderer.height)

  if (import.meta.env.DEV) {
    Object.assign(window as unknown as Record<string, unknown>, {
      __nexusPortrait: {
        stage,
        manifest: manifest as PortraitManifest,
        /** 当前显示的嘴型/眼睛状态，便于自动化断言 */
        shown,
        counts: {
          mouths: mouthStates.length,
          hasEyes: !!assets.eyesClosed,
          hasHairFront: !!hairFront,
          hasHairBack: !!assets.hairBack,
          /** 闭嘴/睁眼是用「不叠加」补的（底图本身就是那个状态） */
          derivedClosedMouth: assets.derivedClosedMouth,
          derivedOpenEyes: assets.derivedOpenEyes,
        },
        mask,
      },
    })
  }

  return stage
}
