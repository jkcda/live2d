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

  /**
   * 流式播放：已排期但可能还没开始播的节点。
   *
   * 和上面那个单一 `source` 的区别是**同时存在多个** ——
   * 流式是「一块一块排到时间轴上」，同一时刻可能有好几块已经排好等着播。
   */
  private scheduled: AudioBufferSourceNode[] = []
  /** 时间轴游标：下一块从什么时候开始（AudioContext 的秒数） */
  private nextStartTime = 0
  /** 流式播放的采样率，beginStream 时确定 */
  private streamRate = 24000
  /** 流是否已经没有新块了 */
  private streamDone = false
  /** endStream 的唤醒回调 */
  private streamEnd: (() => void) | null = null

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

  // ── 流式播放 ──
  //
  // 和非流式的区别：那边是「一整段 buffer 一次 start()」，
  // 这边是「一块一块排到时间轴上」。**时间轴本身就是缓冲区** ——
  // 所以不需要额外攒，也不需要额外的队列。

  /** 开始一段流式播放（会先掐断正在播的） */
  beginStream(sampleRate: number): void {
    this.stop()
    this.streamRate = sampleRate
    this.nextStartTime = 0
    this.streamDone = false
    this.streamEnd = null
  }

  /**
   * 排一块进去。单声道 Float32，范围 -1~1。
   *
   * ★ 关键是**排期**而不是「立刻播」
   *
   * 每块都接在上一块**结束的时刻**。用「现在」的话：
   *   · 合成比播放快 → 后一块盖住前一块的尾巴（丢字）
   *   · 合成比播放慢 → 中间留一段静音（断续）
   * 两者都是「听起来不对但很难说哪里不对」的那类问题。
   *
   * 落后于当前时间（合成慢了、播放追上来了）就退回「现在 + 20ms」——
   * `start()` 传一个过去的时间点会让节点立即播放，容易咔一声。
   */
  pushStreamChunk(samples: Float32Array): void {
    if (samples.length === 0) return

    const ctx = this.ensureContext()
    const buffer = ctx.createBuffer(1, samples.length, this.streamRate)
    // 用 getChannelData().set() 而不是 copyToChannel()：
    // 后者在 TS 5.7 的类型里要求 Float32Array<ArrayBuffer>，
    // 而调用方传的是默认泛型 Float32Array<ArrayBufferLike>，对不上。
    // 两者行为等价，这个写法还少一次类型断言。
    buffer.getChannelData(0).set(samples)

    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.analyser!)

    const now = ctx.currentTime
    const startAt = Math.max(this.nextStartTime, now + 0.02)
    src.start(startAt)
    this.nextStartTime = startAt + buffer.duration

    src.onended = () => {
      try {
        src.disconnect()
      } catch {
        // 已经断开了
      }
      const i = this.scheduled.indexOf(src)
      if (i >= 0) this.scheduled.splice(i, 1)

      // 最后一块也播完了
      if (!this.scheduled.length) {
        this.playing = false
        if (this.streamDone) {
          const done = this.streamEnd
          this.streamEnd = null
          done?.()
        }
      }
    }

    this.scheduled.push(src)
    this.playing = true
  }

  /** 流结束：等所有已排期的块播完 */
  async endStream(): Promise<void> {
    this.streamDone = true
    if (!this.scheduled.length) {
      this.playing = false
      return
    }
    return new Promise<void>((resolve) => {
      this.streamEnd = resolve
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
      /*
       * 自然播完也要 disconnect。
       *
       * 原来只有 stop()（打断那条路）才断，正常播完的节点就一直连着 analyser。
       * 断开之后它才确定可回收 —— 这是 Web Audio 的标准做法。
       *
       * 说清楚边界：**我没有实测过不断开就一定泄漏**（那需要真实浏览器里
       * 量音频线程的内存，Node 里没有 Web Audio）。但一个播完的节点
       * 还挂在图上没有任何好处，显式断开的代价也几乎为零。
       */
      try {
        src.disconnect()
      } catch {
        // 已经断开了
      }

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

    // 流式的等待者同样要唤醒 —— 否则 endStream() 永远不 resolve，
    // 队列卡死，后面所有句子都播不出来（而且不报错）
    const streamDone = this.streamEnd
    this.streamEnd = null
    this.streamDone = false
    streamDone?.()
  }

  /** 只停声音，不碰等待者 */
  private stopSource(): void {
    /*
     * 流式：**所有已排期的都要停**，不只是正在播的那个。
     *
     * 这是个容易漏的地方 —— 打断时只停当前节点的话，后面排好的几块
     * 会接着播出来。表现是「她明明被打断了，过一秒又自己说起来」。
     */
    for (const node of this.scheduled) {
      node.onended = null
      try {
        node.stop()
      } catch {
        // 已经自然结束
      }
      try {
        node.disconnect()
      } catch {
        // 已断开
      }
    }
    this.scheduled = []

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
