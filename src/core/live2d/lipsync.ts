/**
 * 口型驱动：音频振幅 → ParamMouthOpenY。
 *
 * 张嘴快、闭嘴慢是自然口型的关键 —— 起音要跟得上辅音爆破，
 * 收音要留一点余韵，否则看起来像在机械开合。
 */
export interface LipSyncOptions {
  /** 振幅增益，补偿 TTS 输出偏小 */
  gain: number
  /** 张嘴时间常数（毫秒），越小越灵敏 */
  attackMs: number
  /** 闭嘴时间常数（毫秒），越大越柔和 */
  releaseMs: number
  /** 开口度下限，避免完全闭合显得僵硬 */
  minOpen: number
  /** 开口度上限 */
  maxOpen: number
}

export const DEFAULT_LIPSYNC: LipSyncOptions = {
  gain: 1.6,
  attackMs: 45,
  releaseMs: 110,
  minOpen: 0,
  maxOpen: 1,
}

export class LipSyncDriver {
  private open = 0
  private readonly opts: LipSyncOptions

  constructor(opts: Partial<LipSyncOptions> = {}) {
    this.opts = { ...DEFAULT_LIPSYNC, ...opts }
  }

  /**
   * @param amplitude 瞬时振幅 0~1（来自 AudioPlayer.amplitude()）
   * @param dtMs      距上一帧的毫秒数
   * @returns ParamMouthOpenY 的目标值
   */
  update(amplitude: number, dtMs: number): number {
    const { gain, attackMs, releaseMs, minOpen, maxOpen } = this.opts

    const target = Math.min(1, Math.max(0, amplitude * gain))
    const tau = target > this.open ? attackMs : releaseMs

    // 指数趋近：k 是这一帧应该走完的比例，与帧率无关
    const k = tau <= 0 ? 1 : 1 - Math.exp(-dtMs / tau)
    this.open += (target - this.open) * k

    return minOpen + (maxOpen - minOpen) * this.open
  }

  /** 打断时立刻归零 */
  reset(): void {
    this.open = 0
  }
}
