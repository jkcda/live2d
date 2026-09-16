/**
 * 立绘素材的加载与校验。
 *
 * 目录约定（放在 `public/portrait/`）：
 *
 *   portrait.json      配置：画布尺寸、缩放基准、命中区、待机幅度（必需）
 *   body.png           底图（必需）—— 只有这一张也能动：呼吸/晃动/下巴开合
 *   mouth_0.png        嘴：闭       ┐
 *   mouth_1.png        嘴：半开     ├ 可选，有了才有真正的口型
 *   mouth_2.png        嘴：大开     ┘
 *   eyes_open.png      眼：睁       ┐ 可选，有了才会眨眼
 *   eyes_closed.png    眼：闭       ┘
 *   expr_<id>.png      表情差分     ┐ 可选，一张一个情绪（id 见 expressions.ts）
 *                                   ┘ 整张画布的差分：脸的部分常驻，嘴在那块让位给口型
 *   pose_<id>.png      姿态差分     ┐ 可选（id 见 poses.ts）。**整身替换图**，
 *                                   ┘ 不是"叠上去的差分"：见 poses.ts 的说明
 *   hair_front.png     前发         ┐ 可选，晃动时单独动，更生动
 *   hair_back.png      后发         ┘
 *
 * 差分图统一按**整画布尺寸**导出（只有对应区域有内容，其余透明）——
 * 画师交付 PSD 时本来就是这么分层的，叠上去不用对位。
 *
 * 缺哪张就降级，不会报错：缺嘴差分 → 用「下巴分界线」做张嘴；缺眼差分 → 不眨眼。
 */

import { Assets, Rectangle, Texture } from 'pixi.js'
import { EXPRESSION_SPECS, expressionFileNames } from './expressions'
import { POSE_SPECS, poseFileNames } from './poses'

export interface PortraitRegion {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 一张差分图里「真正有内容的那块」（**像素**坐标，不是比例）。
 *
 * `anchorX/anchorY` 是这块内容的 alpha 质心，用来当缩放支点：
 * 差分是**叠在底图上**的，压扁它的时候支点选错就会露馅 ——
 * 支点取在区间上边缘时，一压扁整块往上缩，底图那条闭嘴线就从下面露出来了
 * （表现就是「底图的闭嘴一直在」）。质心大致落在嘴的中线上，绕它缩放两件事同时成立：
 * 嘴不会跑位，底图的闭嘴线也一直被盖住。
 */
export interface PortraitPatch extends PortraitRegion {
  anchorX: number
  anchorY: number
}

export interface PortraitManifest {
  name?: string
  note?: string
  /** 画布尺寸（像素）。差分图必须与它一致 */
  canvas: { width: number; height: number }
  /**
   * 缩放基准：画布里哪一块算「角色」（比例 0~1）。
   * 布局时按这块的高度铺满窗口高度。
   * 不填就用整张画布。
   */
  content?: PortraitRegion
  /**
   * 下巴分界线（0~1，相对画布高度）。
   * 没有嘴差分时，靠拉伸这条线以下的像素来表现张嘴。
   */
  jawLine?: number
  /** 命中区（比例 0~1），决定点击反应；名字沿用 Live2D 的 Head / Body */
  regions?: Record<string, PortraitRegion>
  /** 待机动作幅度 */
  motion?: {
    /** 呼吸上下浮动，占角色高度的比例 */
    bobPercent?: number
    /** 左右摆动角度（度） */
    swayDegrees?: number
    /** 呼吸时整体缩放的幅度 */
    breatheScale?: number
  }
}

/**
 * 一张表情差分。
 *
 * 差分图是**整张画布**尺寸、只有变化的那一块有内容（和画师给的 PSD 分层一致），
 * 所以叠上去不用对位。
 */
export interface PortraitExpression {
  /** 规范 id（`expr_<id>.png`），也是界面与反应编排里用的名字 */
  id: string
  /** 界面显示名 */
  label: string
  texture: Texture
}

/**
 * 一张姿态差分（`pose_<id>.png`）。
 *
 * ★ 和表情不同：这是**整身替换图**，不是"只有改动区域有内容的差分"。
 *   因为"原来的姿势要消失"这件事，靠往上叠图层做不到（只能加像素，不能擦像素），
 *   所以姿态是整张换、和底图交叉淡入淡出。素材怎么做见 docs/portrait-assets.md。
 */
export interface PortraitPose {
  id: string
  label: string
  texture: Texture
}

export interface PortraitAssets {
  manifest: PortraitManifest
  baseUrl: string
  /** 配置是否是从底图自动推导的（没有 portrait.json 或没写关键字段时为 true） */
  derivedManifest: boolean
  /** 「闭嘴」是否用空纹理补的（底图本身闭着嘴，没有 mouth_0.png） */
  derivedClosedMouth: boolean
  /** 「睁眼」是否用空纹理补的（底图本身睁着眼，没有 eyes_open.png） */
  derivedOpenEyes: boolean
  body: Texture
  hairBack?: Texture
  hairFront?: Texture
  eyesOpen?: Texture
  eyesClosed?: Texture
  /**
   * 瞳孔/虹膜图层（可选）。
   *
   * 为什么它和"眨眼"是两回事：眨眼的差分是**整只眼睛**换图，而瞳孔图层是
   * 把虹膜单独抠出来（底图对应位置已经补成眼白），于是它能在眼白范围内小幅平移 ——
   * 这才是"眼睛真的跟着鼠标动"。
   * 画法顺序：底图 → 瞳孔 → 眼差分 → 嘴差分，所以眨眼会盖住瞳孔。
   */
  pupil?: Texture
  /** 嘴差分，按顺序：闭 → 半开 → 大开。长度可能是 0 */
  mouths: Texture[]
  /**
   * 每张嘴差分「实际有内容的那一小块」在画布里的位置（**像素**，不是比例）。
   *
   * 为什么要量它：只有一张差分时要靠**纵向缩放**做出「微张 ~ 全开」的连续过渡，
   * 而缩放支点必须是嘴的中线 —— 支点写死不行（每个人嘴的位置都不一样），
   * 支点取错更不行（会露出底图的闭嘴线），所以就地问 alpha 质心。
   */
  mouthPatches: (PortraitPatch | undefined)[]
  /** 表情差分（按 `expressions.ts` 的候选顺序）。长度可能是 0 */
  expressions: PortraitExpression[]
  /** 姿态差分（按 `poses.ts` 的候选顺序）。长度可能是 0 */
  poses: PortraitPose[]
}

async function loadOptionalTexture(url: string): Promise<Texture | undefined> {
  try {
    // 先探一下：缺文件时 dev server 会返回 index.html（200），所以比对 content-type
    const resp = await fetch(url, { method: 'GET' })
    if (!resp.ok) return undefined
    const type = resp.headers.get('content-type') ?? ''
    if (!type.startsWith('image/')) return undefined
    return await Assets.load<Texture>(url)
  } catch {
    return undefined
  }
}

/**
 * 把一张图缩到小尺寸量 alpha：既给出非透明包围盒（比例坐标），也给出遮罩本身。
 *
 * 遮罩有两个用途：找脖子（宽度剖面）、以及运行时做轮廓命中判定。
 */
async function measureAlpha(
  url: string,
): Promise<
  { box: PortraitRegion; alpha: Uint8Array; width: number; height: number } | undefined
> {
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    if (!img.naturalWidth) return undefined

    const scale = 256 / img.naturalWidth
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    const ctx = cv.getContext('2d')
    if (!ctx) return undefined
    ctx.drawImage(img, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h).data

    const alpha = new Uint8Array(w * h)
    let minX = w, minY = h, maxX = -1, maxY = -1
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = data[(y * w + x) * 4 + 3]
        alpha[y * w + x] = a
        if (a > 24) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < 0) return undefined

    return {
      box: {
        x: minX / w,
        y: minY / h,
        width: (maxX - minX + 1) / w,
        height: (maxY - minY + 1) / h,
      },
      alpha,
      width: w,
      height: h,
    }
  } catch {
    return undefined
  }
}

/**
 * 从轮廓的**宽度剖面**找「脖子」，用来切分头部与身体。
 *
 * 为什么不用固定比例：全身立绘里头部只占身高的 12~18%，而半身像能到 35%，
 * 写死一个比例必然有一边是错的（点击胸口被当成摸头）。
 * 脖子在剖面里是个稳定的局部最窄点 —— 头宽 → 脖窄 → 肩宽 —— 所以找它。
 *
 * 长发披肩会让脖子那行也被算成宽，这种情况下找不到明显的最小值，
 * 就退回固定比例。
 */
function findNeckRatio(alpha: Uint8Array, w: number, h: number): { ratio: number; found: boolean } {
  const rows: number[] = []
  for (let y = 0; y < h; y++) {
    let count = 0
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > 40) count++
    }
    rows.push(count)
  }

  // 先找上下的内容边界
  const first = rows.findIndex((c) => c > 0)
  let last = rows.length - 1
  while (last > 0 && rows[last] === 0) last--
  if (first < 0 || last - first < 10) return { ratio: 0.38, found: false }

  const span = last - first + 1
  // 只看上 45%：脖子一定在这段里（再往下是胸腹）
  const from = first + Math.round(span * 0.06)
  const to = first + Math.round(span * 0.45)
  if (to <= from) return { ratio: 0.38, found: false }

  // 3 行滑动平均去毛刺
  const smooth = (i: number) => (rows[i - 1] + rows[i] + rows[i + 1]) / 3

  let bestRow = -1
  let bestWidth = Infinity
  for (let y = from; y <= to; y++) {
    const width = smooth(y)
    if (width < bestWidth) {
      bestWidth = width
      bestRow = y
    }
  }

  // 校验：脖子必须比它上方（头）和下方（肩）都明显窄，否则判定失败
  const headWidth = Math.max(...rows.slice(from, bestRow).map((_, i) => smooth(from + i)))
  const shoulderWidth = Math.max(...rows.slice(bestRow, Math.min(last, bestRow + Math.round(span * 0.2))).map((_, i) => smooth(bestRow + i)))
  const narrow = bestWidth < headWidth * 0.7 && bestWidth < shoulderWidth * 0.7

  return {
    ratio: narrow ? (bestRow - first) / span : 0.38,
    found: narrow,
  }
}

/**
 * 没有 portrait.json 时，从底图**自动推导**一份配置。
 *
 * 目的是让「只有一张立绘」这条路的门槛降到零：丢一张 body.png 进去就能用，
 * 不用先学会写配置。推导结果不一定完美（比如半身像和全身像的头部比例差很多），
 * 想要更准就写一份 portrait.json 覆盖掉。
 */
async function deriveManifest(
  bodyUrl: string,
  width: number,
  height: number,
): Promise<PortraitManifest> {
  const measured = await measureAlpha(bodyUrl)
  const box = measured?.box ?? { x: 0, y: 0, width: 1, height: 1 }

  // 命中区按轮廓宽度剖面切「头 / 身体」，切不出来就退回上 38%
  const neck = measured
    ? findNeckRatio(measured.alpha, measured.width, measured.height)
    : { ratio: 0.38, found: false }
  const headHeight = box.height * neck.ratio

  if (import.meta.env.DEV) {
    const how = neck.found ? '按轮廓最窄处（脖子）' : '未找到脖子，退回固定比例'
    console.info(
      `[portrait] 自动推导：头部占角色高度 ${(neck.ratio * 100).toFixed(0)}%（${how}）`,
    )
  }

  return {
    canvas: { width, height },
    content: box,
    jawLine: box.y + box.height * 0.62,
    regions: {
      Head: { x: box.x, y: box.y, width: box.width, height: headHeight },
      Body: {
        x: box.x,
        y: box.y + headHeight,
        width: box.width,
        height: box.height - headHeight,
      },
    },
  }
}

/**
 * 量一张差分图里「真正有内容的那块」：像素包围盒 + alpha 质心（当缩放支点）。
 *
 * 为什么按 800 宽降采样：嘴在 1600×2848 的立绘里只有五十来像素宽，
 * 按 256 宽量会粗到 ±6px（嘴总共才 24px 高，误差 25% 就白量了）；
 * 800 宽的误差约 ±2px，够用，而且比全分辨率扫描快四倍。
 */
async function measurePatchBox(url: string, targetWidth = 800): Promise<PortraitPatch | undefined> {
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    if (!img.naturalWidth) return undefined

    const scale = Math.min(1, targetWidth / img.naturalWidth)
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    const ctx = cv.getContext('2d')
    if (!ctx) return undefined
    ctx.drawImage(img, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h).data

    let minX = w
    let minY = h
    let maxX = -1
    let maxY = -1
    let sum = 0
    let sumX = 0
    let sumY = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // 阈值给高一点：羽化出来的那些 alpha<24 的边不算内容
        const a = data[(y * w + x) * 4 + 3]
        if (a <= 24) continue
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        sum += a
        sumX += a * x
        sumY += a * y
      }
    }
    if (maxX < 0 || sum === 0) return undefined

    return {
      x: minX / scale,
      y: minY / scale,
      width: (maxX - minX + 1) / scale,
      height: (maxY - minY + 1) / scale,
      anchorX: sumX / sum / scale,
      anchorY: sumY / sum / scale,
    }
  } catch {
    return undefined
  }
}

const trim = (s: string) => s.replace(/\/+$/, '')

/**
 * 加载立绘素材。
 *
 * @param baseUrl 素材目录（默认 `portrait/`，相对站点根）
 */
export async function loadPortrait(baseUrl = 'portrait'): Promise<PortraitAssets> {
  const base = trim(baseUrl)

  // 配置文件是可选的：缺了就从底图自动推导（见 deriveManifest）
  let raw: Partial<PortraitManifest> = {}
  try {
    const resp = await fetch(`${base}/portrait.json`)
    if (resp.ok) {
      const type = resp.headers.get('content-type') ?? ''
      // dev server 对不存在的路径会回 index.html，所以要看一下 content-type
      if (type.includes('json')) raw = (await resp.json()) as Partial<PortraitManifest>
    }
  } catch {
    // 没有配置文件也能跑
  }

  const body = await loadOptionalTexture(`${base}/body.png`)
  if (!body) {
    throw new Error(`读不到 ${base}/body.png —— 立绘模式至少需要一张底图`)
  }

  const width = body.width
  const height = body.height

  /*
   * ★ 画布尺寸一律以**底图**为准，不信配置文件。
   *   配置里写的 canvas 只是给作者看的说明 —— 差分图必须和底图同尺寸，
   *   所以底图才是唯一事实来源。两边不一致时说明素材放错了（比如换了底图忘了换差分），
   *   这时宁可忽略配置里的尺寸，也不要按错的尺寸去摆图层。
   */
  if (
    import.meta.env.DEV &&
    raw.canvas &&
    (raw.canvas.width !== width || raw.canvas.height !== height)
  ) {
    console.warn(
      `[portrait] portrait.json 里写的是 ${raw.canvas.width}×${raw.canvas.height}，` +
        `但 body.png 实际是 ${width}×${height}。已按底图为准 —— ` +
        '如果你的差分图是按另一个尺寸画的，请重新导出成和底图一致。',
    )
  }

  const derived = await deriveManifest(`${base}/body.png`, width, height)
  const manifest: PortraitManifest = {
    ...derived,
    ...raw,
    canvas: { width, height },
    // content / jawLine / regions 允许单独缺省，缺哪项就用推导值
    content: raw.content ?? derived.content,
    jawLine: raw.jawLine ?? derived.jawLine,
    regions: raw.regions ?? derived.regions,
    motion: raw.motion ?? derived.motion,
  }

  const [hairBack, hairFront, eyesOpen, eyesClosed, pupil] = await Promise.all([
    loadOptionalTexture(`${base}/hair_back.png`),
    loadOptionalTexture(`${base}/hair_front.png`),
    loadOptionalTexture(`${base}/eyes_open.png`),
    loadOptionalTexture(`${base}/eyes_closed.png`),
    loadOptionalTexture(`${base}/pupil.png`),
  ])

  /*
   * 嘴差分：从 0（闭）开始连续编号，缺号就停。
   *
   * ★ 但 0（闭嘴）允许缺 —— 底图本身就是闭着嘴的，
   *   「闭嘴」最自然的表达是**什么都不叠**（用空纹理占位）。
   *   所以只要做了「半开」「大开」两张，口型就能工作。
   */
  const mouths: Texture[] = []
  const mouthPatches: (PortraitPatch | undefined)[] = []
  let derivedClosedMouth = false
  for (let i = 0; i < 8; i++) {
    const url = `${base}/mouth_${i}.png`
    const t = await loadOptionalTexture(url)
    if (!t) {
      if (i === 0 && (await loadOptionalTexture(`${base}/mouth_1.png`))) {
        // 有半开/大开但没做闭嘴 → 闭嘴用空纹理
        mouths.push(Texture.EMPTY)
        mouthPatches.push(undefined)
        derivedClosedMouth = true
        continue
      }
      break
    }
    mouths.push(t)
    mouthPatches.push(await measurePatchBox(url))
  }

  /*
   * 眼差分同理：底图是睁眼的，所以「睁眼」= 不叠任何东西。
   * 只做了 eyes_closed.png 时，也要能眨眼 —— 用空纹理当睁眼状态。
   */
  let derivedOpenEyes = false
  let eyesOpenFinal = eyesOpen
  if (!eyesOpenFinal && eyesClosed) {
    eyesOpenFinal = Texture.EMPTY
    derivedOpenEyes = true
  }

  if (import.meta.env.DEV && (derivedClosedMouth || derivedOpenEyes)) {
    console.info(
      `[portrait] 用「不叠加」补足默认状态：` +
        `${derivedClosedMouth ? '闭嘴' : ''}${derivedClosedMouth && derivedOpenEyes ? '、' : ''}` +
        `${derivedOpenEyes ? '睁眼' : ''}（底图本身已经是这个状态，不需要单独做差分）`,
    )
  }

  /*
   * 表情差分：一张一个情绪，缺哪张就是"这个角色做不出这个表情"（静默跳过）。
   *
   * ★ 名字不写死在这一处：候选名（含中文别名）来自 `expressions.ts`，
   *   和设置面板里做**素材探测**的那份是同一份 —— 那边说有、这边就一定要能加载到，
   *   否则会出现"能力显示有表情，点了却没反应"。
   */
  const expressions: PortraitExpression[] = []
  for (const spec of EXPRESSION_SPECS) {
    for (const name of expressionFileNames(spec)) {
      const texture = await loadOptionalTexture(`${base}/expr_${name}.png`)
      if (texture) {
        expressions.push({ id: spec.id, label: spec.label, texture })
        break
      }
    }
  }

  if (import.meta.env.DEV && expressions.length) {
    console.info(
      `[portrait] 表情差分 ${expressions.length} 张：` +
        expressions.map((e) => `${e.id}(${e.label})`).join('、'),
    )
  }

  /*
   * 姿态差分：整身替换图，和表情一样按候选名探（含中文别名）。
   * 同样地，探测（设置面板）和加载共用 poses.ts 那一份清单。
   */
  const poses: PortraitPose[] = []
  for (const spec of POSE_SPECS) {
    for (const name of poseFileNames(spec)) {
      const texture = await loadOptionalTexture(`${base}/pose_${name}.png`)
      if (texture) {
        poses.push({ id: spec.id, label: spec.label, texture })
        break
      }
    }
  }

  if (import.meta.env.DEV && poses.length) {
    console.info(
      `[portrait] 姿态差分 ${poses.length} 张：` + poses.map((p) => `${p.id}(${p.label})`).join('、'),
    )
  }

  return {
    manifest,
    baseUrl: base,
    derivedManifest: !raw.canvas && !raw.content,
    derivedClosedMouth,
    derivedOpenEyes,
    body,
    hairBack,
    hairFront,
    eyesOpen: eyesOpenFinal,
    eyesClosed,
    pupil,
    mouths,
    mouthPatches,
    expressions,
    poses,
  }
}

/**
 * 从若干图层合成一张低分辨率 alpha 遮罩，用来做轮廓命中判定。
 *
 * 为什么要遮罩而不是读画布像素：立绘是普通的 2D 图，
 * 提前算好遮罩后每次判定只是查一次数组 —— 比 readPixels 便宜，也不用开 preserveDrawingBuffer。
 * 分辨率取 192 宽足够（判定只需分辨「在她身上」还是「在空白处」）。
 */
export async function buildAlphaMask(
  assets: PortraitAssets,
  maskWidth = 192,
): Promise<{ width: number; height: number; alpha: Uint8Array; opaqueRatio: number }> {
  const { canvas } = assets.manifest
  const scale = maskWidth / canvas.width
  const width = maskWidth
  const height = Math.max(1, Math.round(canvas.height * scale))

  const cv = document.createElement('canvas')
  cv.width = width
  cv.height = height
  const ctx = cv.getContext('2d')
  if (!ctx) throw new Error('拿不到 2D 上下文，无法生成遮罩')

  const urls = [
    `${assets.baseUrl}/body.png`,
    assets.hairBack ? `${assets.baseUrl}/hair_back.png` : null,
    assets.hairFront ? `${assets.baseUrl}/hair_front.png` : null,
  ].filter((u): u is string => Boolean(u))

  for (const url of urls) {
    const img = new Image()
    img.src = url
    await img.decode().catch(() => undefined)
    if (img.naturalWidth) ctx.drawImage(img, 0, 0, width, height)
  }

  const data = ctx.getImageData(0, 0, width, height).data
  const alpha = new Uint8Array(width * height)
  let opaque = 0
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = data[i * 4 + 3]
    if (alpha[i] > 40) opaque++
  }

  return { width, height, alpha, opaqueRatio: opaque / alpha.length }
}

/** 由画布比例算出的像素矩形 */
export function regionToPixels(
  region: PortraitRegion,
  canvas: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  return {
    x: region.x * canvas.width,
    y: region.y * canvas.height,
    width: region.width * canvas.width,
    height: region.height * canvas.height,
  }
}

/** 按分界线把底图切成上下两半（下半个用来做张嘴） */
export function splitAtJaw(
  texture: Texture,
  jawY: number,
): { upper: Texture; lower: Texture; jawY: number } {
  const source = texture.source
  const w = texture.width
  const h = texture.height
  const cut = Math.round(Math.max(1, Math.min(h - 1, jawY)))
  return {
    upper: new Texture({ source, frame: new Rectangle(0, 0, w, cut) }),
    lower: new Texture({ source, frame: new Rectangle(0, cut, w, h - cut) }),
    jawY: cut,
  }
}
