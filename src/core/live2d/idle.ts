/**
 * 程序化待机动画：呼吸 / 眨眼 / 视线游移 / 头部微摆。
 *
 * 这些动作连续、随机、永远在跑，是角色的"底色"。
 * 用代码生成比从视频提取更自然 —— 提取出来的会僵硬，而且零素材成本。
 */

export interface IdleOptions {
  /** 呼吸周期（毫秒） */
  breathPeriodMs: number
  /** 眨眼间隔范围（毫秒） */
  blinkIntervalMs: [number, number]
  /** 单次眨眼时长（毫秒） */
  blinkDurationMs: number
  /** 头部摆动幅度（度） */
  swayAmplitude: number
  /** 视线游移幅度 0~1 */
  gazeAmplitude: number
}

export const DEFAULT_IDLE: IdleOptions = {
  breathPeriodMs: 3800,
  blinkIntervalMs: [2200, 6200],
  blinkDurationMs: 130,
  swayAmplitude: 4,
  gazeAmplitude: 0.35,
}

/** 每帧输出的参数集合 —— 直接喂给 ModelHandle.setParams() */
export interface IdleFrame {
  ParamBreath: number
  ParamEyeLOpen: number
  ParamEyeROpen: number
  ParamEyeBallX: number
  ParamEyeBallY: number
  ParamAngleX: number
  ParamAngleY: number
  ParamAngleZ: number
  ParamBodyAngleX: number
}

export class IdleAnimator {
  private t = 0
  private blinkAt: number
  private blinkPhase = -1
  private readonly opts: IdleOptions

  constructor(opts: Partial<IdleOptions> = {}) {
    this.opts = { ...DEFAULT_IDLE, ...opts }
    this.blinkAt = this.pickBlinkDelay()
  }

  private pickBlinkDelay(): number {
    const [lo, hi] = this.opts.blinkIntervalMs
    return lo + Math.random() * Math.max(0, hi - lo)
  }

  /** @param dtMs 距上一帧的毫秒数 */
  update(dtMs: number): IdleFrame {
    this.t += dtMs
    const o = this.opts

    // ── 呼吸：慢速正弦，0~1 ──
    const breath = (Math.sin((this.t / o.breathPeriodMs) * Math.PI * 2) + 1) / 2

    // ── 眨眼：随机间隔触发一次快速闭合再睁开 ──
    let eyeOpen = 1
    if (this.blinkPhase < 0) {
      this.blinkAt -= dtMs
      if (this.blinkAt <= 0) this.blinkPhase = 0
    } else {
      this.blinkPhase += dtMs
      const p = this.blinkPhase / o.blinkDurationMs
      if (p >= 1) {
        this.blinkPhase = -1
        this.blinkAt = this.pickBlinkDelay()
      } else {
        eyeOpen = 1 - Math.sin(p * Math.PI)
      }
    }

    // ── 视线游移：两个不共周期的正弦叠加，看起来像无规律的扫视 ──
    const gazeX = Math.sin(this.t / 4100) * 0.6 + Math.sin(this.t / 1700) * 0.4
    const gazeY = Math.sin(this.t / 5300 + 1.3) * 0.7 + Math.sin(this.t / 2300) * 0.3

    // ── 头部微摆：比视线更慢、幅度更小 ──
    const swayX = Math.sin(this.t / 6700) * o.swayAmplitude
    const swayY = Math.sin(this.t / 8900 + 0.7) * o.swayAmplitude * 0.6
    const tilt = Math.sin(this.t / 11300 + 2.1) * o.swayAmplitude * 0.35

    return {
      ParamBreath: breath,
      ParamEyeLOpen: eyeOpen,
      ParamEyeROpen: eyeOpen,
      ParamEyeBallX: gazeX * o.gazeAmplitude,
      ParamEyeBallY: gazeY * o.gazeAmplitude,
      ParamAngleX: swayX,
      ParamAngleY: swayY,
      ParamAngleZ: tilt,
      ParamBodyAngleX: swayX * 0.5,
    }
  }
}
