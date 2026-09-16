/**
 * 麦克风采集。
 *
 * 输出固定格式：16kHz 单声道 int16 PCM，每块 512 采样（32ms）。
 * 这个格式不是随便定的 —— 它是 Silero VAD 的标准输入帧长，
 * 也是服务端 `service/vad/base.py` 里写死的 FRAME_SAMPLES。
 *
 * 重采样策略：直接开一个 `sampleRate: 16000` 的 AudioContext，
 * 让浏览器在采集层就把 48kHz 重采样成 16kHz。
 * 比在 JS 里手写重采样省事得多，Chromium 下可靠。
 */

/** 与后端 FRAME_SAMPLES 必须一致 */
export const FRAME_SAMPLES = 512
/** 与后端 SAMPLE_RATE 必须一致 */
export const MIC_SAMPLE_RATE = 16000

/**
 * AudioWorklet 处理器源码。
 *
 * 用 Blob URL 注入而不是单独的文件 —— 免去 Vite 的 worklet 打包配置，
 * 也让这段逻辑和它的调用方待在一起。
 */
const WORKLET_SOURCE = `
class NexusCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(${FRAME_SAMPLES})
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true

    for (let i = 0; i < channel.length; i++) {
      this.buf[this.filled++] = channel[i]

      if (this.filled === this.buf.length) {
        const pcm = new Int16Array(this.buf.length)
        for (let j = 0; j < this.buf.length; j++) {
          const v = this.buf[j] < -1 ? -1 : this.buf[j] > 1 ? 1 : this.buf[j]
          pcm[j] = v * 32767
        }
        this.port.postMessage(pcm.buffer, [pcm.buffer])
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('nexus-capture', NexusCapture)
`

export interface MicOptions {
  /** 每凑满一帧回调一次，参数是 int16 PCM 的 ArrayBuffer */
  onFrame: (pcm: ArrayBuffer) => void
  /** 采集出错时回调（权限被拒、设备被拔等） */
  onError?: (err: Error) => void
}

export class MicCapture {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private sink: GainNode | null = null
  private workletUrl: string | null = null
  private readonly opts: MicOptions

  constructor(opts: MicOptions) {
    this.opts = opts
  }

  get active(): boolean {
    return this.node !== null
  }

  async start(): Promise<void> {
    if (this.node) return

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // 这三个对「边放音边录音」的场景很关键：
          // 不开回声消除的话，TTS 的声音会被自己录进去，导致无限自问自答
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
    } catch (err) {
      const message =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? '麦克风权限被拒绝'
          : err instanceof Error
            ? err.message
            : String(err)
      throw new Error(`无法打开麦克风：${message}`)
    }

    // 让浏览器在采集层完成 48k → 16k 重采样
    const ctx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE })

    try {
      if (!ctx.audioWorklet) {
        throw new Error('当前环境不支持 AudioWorklet')
      }

      this.workletUrl = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
      )
      await ctx.audioWorklet.addModule(this.workletUrl)

      const source = ctx.createMediaStreamSource(this.stream)
      const node = new AudioWorkletNode(ctx, 'nexus-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      })

      node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        this.opts.onFrame(event.data)
      }

      // 必须接到 destination 才会被驱动，但 gain 设 0 —— 否则自己的声音会回授
      const sink = ctx.createGain()
      sink.gain.value = 0

      source.connect(node)
      node.connect(sink)
      sink.connect(ctx.destination)

      this.ctx = ctx
      this.node = node
      this.sink = sink
    } catch (err) {
      this.cleanup()
      void ctx.close()
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  stop(): void {
    this.cleanup()
  }

  private cleanup(): void {
    if (this.node) {
      this.node.port.onmessage = null
      this.node.disconnect()
      this.node = null
    }
    this.sink?.disconnect()
    this.sink = null

    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null

    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl)
      this.workletUrl = null
    }

    if (this.ctx) {
      void this.ctx.close()
      this.ctx = null
    }
  }
}
