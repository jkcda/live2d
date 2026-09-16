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
 *   hair_front.png     前发         ┐ 可选，晃动时单独动，更生动
 *   hair_back.png      后发         ┘
 *
 * 差分图统一按**整画布尺寸**导出（只有对应区域有内容，其余透明）——
 * 画师交付 PSD 时本来就是这么分层的，叠上去不用对位。
 *
 * 缺哪张就降级，不会报错：缺嘴差分 → 用「下巴分界线」做张嘴；缺眼差分 → 不眨眼。
 */

import { Assets, Rectangle, Texture } from 'pixi.js'

export interface PortraitRegion {
  x: number
  y: number
  width: number
  height: number
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
  /** 嘴差分，按顺序：闭 → 半开 → 大开。长度可能是 0 */
  mouths: Texture[]
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

  const [hairBack, hairFront, eyesOpen, eyesClosed] = await Promise.all([
    loadOptionalTexture(`${base}/hair_back.png`),
    loadOptionalTexture(`${base}/hair_front.png`),
    loadOptionalTexture(`${base}/eyes_open.png`),
    loadOptionalTexture(`${base}/eyes_closed.png`),
  ])

  /*
   * 嘴差分：从 0（闭）开始连续编号，缺号就停。
   *
   * ★ 但 0（闭嘴）允许缺 —— 底图本身就是闭着嘴的，
   *   「闭嘴」最自然的表达是**什么都不叠**（用空纹理占位）。
   *   所以只要做了「半开」「大开」两张，口型就能工作。
   */
  const mouths: Texture[] = []
  let derivedClosedMouth = false
  for (let i = 0; i < 8; i++) {
    const t = await loadOptionalTexture(`${base}/mouth_${i}.png`)
    if (!t) {
      if (i === 0 && (await loadOptionalTexture(`${base}/mouth_1.png`))) {
        // 有半开/大开但没做闭嘴 → 闭嘴用空纹理
        mouths.push(Texture.EMPTY)
        derivedClosedMouth = true
        continue
      }
      break
    }
    mouths.push(t)
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
    mouths,
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
