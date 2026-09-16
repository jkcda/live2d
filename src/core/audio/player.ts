/**
 * TTS 音频播放 + 实时音量包络提取。
 *
 * 口型的唯一数据源是音频本身，不是文本 —— 只有读实时波形，
 * 口型才能和实际发音对齐（包括停顿、拖长音、语气词）。
 */
export class AudioPlayer {
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private source: AudioBufferSourceNode | null = null
  private buf = new Float32Array(0)
  private playing = false
  /** playBufferAndWait 的唤醒回调，stop() 时要主动调用 */
  private pendingEnd: (() => void) | null = null

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.5
      analyser.connect(ctx.destination)

      this.ctx = ctx
      this.analyser = analyser
      this.buf = new Float32Array(analyser.fftSize)
    }
    return this.ctx
  }

  get isPlaying(): boolean {
    return this.playing
  }

  /**
   * 暴露内部 AudioContext。
   * AudioBuffer 不能跨 context 使用，合成音频前必须拿到同一个实例。
   */
  get context(): AudioContext {
    return this.ensureContext()
  }

  /** 播放一段 TTS 音频；会先打断正在播放的内容 */
  async play(data: ArrayBuffer): Promise<void> {
    const ctx = this.ensureContext()
    if (ctx.state === 'suspended') await ctx.resume()
    // decodeAudioData 会 detach 传入的 ArrayBuffer，复制一份以免影响调用方
    const audioBuffer = await ctx.decodeAudioData(data.slice(0))
    this.startSource(audioBuffer)
  }

  /** 直接播放已解码的音频（合成测试音、预生成语音包） */
  playBuffer(buffer: AudioBuffer): void {
    const ctx = this.ensureContext()
    if (ctx.state === 'suspended') void ctx.resume()
    this.startSource(buffer)
  }

  /**
   * 播放并等待自然结束。
   *
   * 流式 TTS 需要这个：一句话播完才能接下一句，
   * 但合成是并行进行的 —— 播放必须串行、合成必须并行。
   * 被打断时 Promise 同样 resolve（不是 reject），调用方不必区分。
   */
  async playBufferAndWait(buffer: AudioBuffer): Promise<void> {
    const ctx = this.ensureContext()
    if (ctx.state === 'suspended') await ctx.resume()
    return new Promise<void>((resolve) => {
      this.startSource(buffer, () => {
        if (this.pendingEnd === resolve) this.pendingEnd = null
        resolve()
      })
      // ★ 必须等 startSource 抢断完上一段之后再登记自己。
      //   顺序反了的话，startSource 内部的抢断会把刚登记的自己当场唤醒 ——
      //   playBufferAndWait 实际等待 0ms，一句还没播完就被下一句抢断，
      //   听起来就是「吞字、断续」。
      this.pendingEnd = resolve
    })
  }

  private startSource(buffer: AudioBuffer, onEnded?: () => void): void {
    // 抢断正在播的那一段：它的等待者代表「被打断的播放」，应该被唤醒。
    // 但绝不能碰即将登记的新等待者 —— 所以先把旧的取走、清空。
    const preempted = this.pendingEnd
    this.pendingEnd = null
    this.stopSource()
    preempted?.()

    const src = this.ctx!.createBufferSource()
    src.buffer = buffer
    src.connect(this.analyser!)

    src.onended = () => {
      if (this.source === src) {
        this.source = null
        this.playing = false
      }
      onEnded?.()
    }

    src.start()
    this.source = src
    this.playing = true
  }

  /** 立即掐断播放 —— 用户插话（barge-in）时调用 */
  stop(): void {
    this.stopSource()

    // 唤醒等待中的 playBufferAndWait，避免调用方永久挂起
    const done = this.pendingEnd
    this.pendingEnd = null
    done?.()
  }

  /** 只停声音，不碰等待者 */
  private stopSource(): void {
    const src = this.source
    if (src) {
      src.onended = null
      try {
        src.stop()
      } catch {
        // 已经自然结束
      }
      try {
        src.disconnect()
      } catch {
        // 已断开
      }
      this.source = null
    }
    this.playing = false
  }

  /** 当前瞬时振幅，0~1。未播放时恒为 0 */
  amplitude(): number {
    if (!this.playing || !this.analyser) return 0
    this.analyser.getFloatTimeDomainData(this.buf)

    let sum = 0
    for (let i = 0; i < this.buf.length; i++) {
      sum += this.buf[i] * this.buf[i]
    }
    const rms = Math.sqrt(sum / this.buf.length)
    // TTS 输出通常在 0.05~0.3 RMS，放大到可用区间
    return Math.min(1, rms * 3.5)
  }

  dispose(): void {
    this.stop()
    void this.ctx?.close()
    this.ctx = null
    this.analyser = null
  }
}
