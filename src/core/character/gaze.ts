/**
 * 视线驱动：鼠标在哪 → 她往哪看。
 *
 * 为什么值得单独一个模块（而不是塞进渲染器）：
 *   1. 「看」这件事是**渲染器无关**的语义 —— Live2D 用瞳孔参数 + 转头实现，
 *      立绘用整体视差 + 倾斜实现，两边吃同一个视角值；
 *   2. 指针从哪算起必须知道**她脸在屏幕上的哪**，那是渲染器才知道的信息
 *      （见 CharacterStage.anchor()），所以这里只管"给定两个点，算出视角"；
 *   3. 平滑（快跟、慢松）需要按时间积分，和口型是同一类东西。
 *
 * 手感上的两个决定：
 *   · **跟得快、松得慢**（130ms / 320ms）：被人盯着看是"注意力"，会跟得很紧；
 *     人把鼠标移开则慢慢失焦，回落到待机游移 —— 反过来的话看起来很神经质。
 *   · **水平和垂直用不同的参考距离**：窗口是扁的，用同一个半径会让横向几乎不动
 *     而纵向一碰就到 ±1。
 */

export interface GazeOptions {
  /** 跟上目标的时间常数（毫秒），越小越灵敏 */
  attackMs: number
  /** 目标消失后回落的时间常数（毫秒），越大越"恋恋不舍" */
  releaseMs: number
  /**
   * 参考距离：指针离脸多远算"看到边"（像素）。
   * 不填就按窗口大小算 —— 窗口边缘大约对应 ±1。
   */
  refX?: number
  refY?: number
}

export const DEFAULT_GAZE: GazeOptions = {
  attackMs: 130,
  releaseMs: 320,
}

export interface Gaze {
  /** -1~1，负 = 左/上 */
  x: number
  y: number
}

export function clampSigned(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v
}

export class GazeDriver {
  private x = 0
  private y = 0
  /** 这一帧想看向哪（未平滑） */
  private targetX = 0
  private targetY = 0
  private readonly opts: GazeOptions

  constructor(opts: Partial<GazeOptions> = {}) {
    this.opts = { ...DEFAULT_GAZE, ...opts }
  }

  /**
   * 指定看向哪里。
   *
   * @param pointer 指针位置（clientX/clientY）；传 null 表示"没人了"（鼠标离开窗口）
   * @param anchor  她的脸在屏幕上的位置（CharacterStage.anchor('head')）
   */
  aim(pointer: { x: number; y: number } | null, anchor: { x: number; y: number } | null): void {
    if (!pointer || !anchor) {
      this.targetX = 0
      this.targetY = 0
      return
    }
    const refX = this.opts.refX ?? Math.max(220, window.innerWidth * 0.45)
    const refY = this.opts.refY ?? Math.max(180, window.innerHeight * 0.45)
    this.targetX = clampSigned((pointer.x - anchor.x) / refX)
    // 屏幕坐标 y 向下，而"往上看"是正方向，所以取反
    this.targetY = clampSigned(-(pointer.y - anchor.y) / refY)
  }

  /** 直接指定目标（自动化验证/剧情演出用） */
  aimAt(x: number, y: number): void {
    this.targetX = clampSigned(x)
    this.targetY = clampSigned(y)
  }

  /** @param dtMs 距上一帧的毫秒数 */
  update(dtMs: number): Gaze {
    const near = Math.abs(this.targetX - this.x) + Math.abs(this.targetY - this.y)
    // 目标变小（松手/移开）时走得慢一些，看起来像"慢慢失焦"
    const tau = near > 0.001 && this.magnitudeGrowing() ? this.opts.attackMs : this.opts.releaseMs
    const k = tau <= 0 ? 1 : 1 - Math.exp(-dtMs / tau)
    this.x += (this.targetX - this.x) * k
    this.y += (this.targetY - this.y) * k
    return { x: this.x, y: this.y }
  }

  /** 目标是"比现在更看向某处"（离开中心）还是在回落 */
  private magnitudeGrowing(): boolean {
    return Math.hypot(this.targetX, this.targetY) > Math.hypot(this.x, this.y)
  }

  /** 当前值（不推进时间）—— 调试与自动化验证用 */
  value(): Gaze {
    return { x: this.x, y: this.y }
  }

  /** 立刻归零（打断、切换角色时用） */
  reset(): void {
    this.x = 0
    this.y = 0
    this.targetX = 0
    this.targetY = 0
  }
}
