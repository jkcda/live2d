/**
 * 屏幕截图 + 变化门控。
 *
 * ══ 隐私边界 ══
 *
 * 这一层的敏感度比窗口标题高一个量级，所以三道闸门缺一不可：
 *
 *   1. **只截前台窗口那一块**，不截全桌面。多显示器下截全屏等于一半是空白，
 *      还顺带把另一块屏上的东西也送出去了。
 *   2. **黑名单同样管截图** —— 复用的是 observer 那份名单：调用方只有拿到
 *      非 null 的 activity 才该来截图（命中的窗口 observer 直接返回 null）。
 *   3. **变化门控**：画面没怎么变就不往上送。不是为了省钱（虽然也省），
 *      是因为「每轮都塞一张差不多的图」会让模型开始无视它。
 *
 * ══ 为什么用感知哈希而不是逐像素 diff ══
 *
 * 视频在播、光标在闪、时钟在走 —— 逐像素 diff 每帧都会判定「变了」，
 * 等于没门控。dHash 看的是**结构**，这些高频小噪点影响不到它。
 */

import { desktopCapturer, screen, type NativeImage } from 'electron'
import { foregroundWindowRect } from './observer.js'

/** 长边上限。1080p 全屏进去很贵，压到 1024 以内 */
const MAX_EDGE = 1024

/** JPEG 质量。80 是肉眼几乎无损和体积的平衡点 */
const JPEG_QUALITY = 80

/** 汉明距离小于它就算「没怎么变」 */
const DEFAULT_HASH_THRESHOLD = 6

/** 两次「值得上报」之间的最小间隔 */
const DEFAULT_MIN_GAP_MS = 8000

export interface ScreenFrame {
  /** data URL，可直接塞进 image_url */
  dataUrl: string
  /** 感知哈希（64 bit 的十六进制） */
  hash: string
  width: number
  height: number
  at: number
}

// ── 感知哈希 ──

/**
 * dHash：缩到 9x8，逐行比较相邻像素的亮度，得到 64 bit。
 *
 * 选 dHash 不选 pHash（DCT）是因为它够用且零依赖 —— 我们要判断的是
 * 「用户是不是换了件事做」，不是「两张图是不是同一张」。
 */
function dHash(image: NativeImage): string {
  const small = image.resize({ width: 9, height: 8, quality: 'good' })
  // 注意用 toBitmap 不是 getBitmap —— 后者在这版 Electron 里是已废弃的别名，
  // 类型签名还标成了 void（拿它做索引会编译不过）
  const bmp = small.toBitmap() // BGRA

  let bits = ''
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = (y * 9 + x) * 4
      const j = (y * 9 + x + 1) * 4
      // BGRA 三个通道求和当亮度，省一次转换
      const left = bmp[i] + bmp[i + 1] + bmp[i + 2]
      const right = bmp[j] + bmp[j + 1] + bmp[j + 2]
      bits += left > right ? '1' : '0'
    }
  }

  let hex = ''
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex
}

/** 两个哈希的汉明距离（不同位的个数） */
export function hamming(a: string, b: string): number {
  let d = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    d += ((x >> 3) & 1) + ((x >> 2) & 1) + ((x >> 1) & 1) + (x & 1)
  }
  return d
}

// ── 截图 ──

function clampCrop(
  crop: { x: number; y: number; width: number; height: number },
  bound: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.min(crop.x, bound.width - 1))
  const y = Math.max(0, Math.min(crop.y, bound.height - 1))
  return {
    x,
    y,
    width: Math.max(1, Math.min(crop.width, bound.width - x)),
    height: Math.max(1, Math.min(crop.height, bound.height - y)),
  }
}

/**
 * 抓一张前台窗口的截图。
 *
 * **调用前必须确认当前活动可见**（observer.snapshot() 非 null）——
 * 那一步已经过了黑名单，这里不重复判断，免得两处名单不同步。
 */
export async function captureForeground(): Promise<ScreenFrame | null> {
  // GetWindowRect 给的是物理像素，Electron 的 screen API 用 DIP，先转
  const physRect = foregroundWindowRect()
  if (!physRect) return null

  const dipRect = screen.screenToDipRect(null, physRect)
  const display = screen.getDisplayMatching(dipRect)

  // 要这个显示器的物理尺寸，拿到就是 1:1 的缩略图
  const physBounds = screen.dipToScreenRect(null, display.bounds)

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: physBounds.width, height: physBounds.height },
  })

  const source =
    sources.find((s) => s.display_id === String(display.id)) ??
    sources.find((s) => s.thumbnail.getSize().width > 0)
  if (!source) return null

  const thumb = source.thumbnail
  if (thumb.isEmpty()) return null

  const thumbSize = thumb.getSize()
  // 缩略图尺寸和请求的可能差一两个像素（比例取整），按实际值算缩放
  const scaleX = thumbSize.width / physBounds.width
  const scaleY = thumbSize.height / physBounds.height

  const cropped = thumb.crop(
    clampCrop(
      {
        x: Math.round((physRect.x - physBounds.x) * scaleX),
        y: Math.round((physRect.y - physBounds.y) * scaleY),
        width: Math.round(physRect.width * scaleX),
        height: Math.round(physRect.height * scaleY),
      },
      thumbSize,
    ),
  )

  const size = cropped.getSize()
  const longest = Math.max(size.width, size.height)
  const scaled =
    longest > MAX_EDGE
      ? cropped.resize({
          width: Math.round((size.width * MAX_EDGE) / longest),
          height: Math.round((size.height * MAX_EDGE) / longest),
          quality: 'good',
        })
      : cropped

  const jpeg = scaled.toJPEG(JPEG_QUALITY)
  if (!jpeg.length) return null

  const final = scaled.getSize()
  return {
    dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    hash: dHash(scaled),
    width: final.width,
    height: final.height,
    at: Date.now(),
  }
}

// ── 门控 ──

export interface ScreenGateOptions {
  /** 汉明距离阈值：小于它算「没怎么变」，默认 6 */
  hashThreshold?: number
  /** 两次上报之间的最小间隔（ms），默认 8000 */
  minGapMs?: number
}

/**
 * 变化门控。
 *
 * 和 observer 的「(进程, 标题) 变了才更新」是同一个思路，
 * 只是这里判据从字符串相等换成了感知哈希距离。
 */
export class ScreenGate {
  private lastHash: string | null = null
  private lastEmitAt = 0

  private readonly hashThreshold: number
  private readonly minGapMs: number

  constructor(opts: ScreenGateOptions = {}) {
    this.hashThreshold = opts.hashThreshold ?? DEFAULT_HASH_THRESHOLD
    this.minGapMs = opts.minGapMs ?? DEFAULT_MIN_GAP_MS
  }

  /**
   * 这一帧值不值得送出去。
   *
   * 两个条件都要满足：变化够大 **且** 距上次够久。
   * 只要变化大就送的话，快速切换窗口时会连发好几张；
   * 只要时间够就送的话，画面没变也会重复发同一张。
   */
  accept(frame: ScreenFrame): boolean {
    const now = Date.now()

    if (this.lastHash && hamming(this.lastHash, frame.hash) < this.hashThreshold) {
      return false
    }
    if (now - this.lastEmitAt < this.minGapMs) return false

    this.lastHash = frame.hash
    this.lastEmitAt = now
    return true
  }

  /** 距上次上报过了多久（调试用） */
  get sinceLastEmitMs(): number {
    return this.lastEmitAt ? Date.now() - this.lastEmitAt : Number.POSITIVE_INFINITY
  }

  reset(): void {
    this.lastHash = null
    this.lastEmitAt = 0
  }
}
