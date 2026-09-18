/**
 * 语音输入：麦克风 → WebSocket → 服务端 VAD/ASR → 事件。
 *
 * 最关键的一件事是 **barge-in**：收到 `vad: speech` 时立刻掐断 TTS。
 * 这个判断只能由 VAD 给出 —— 等 ASR 出文字再打断要多等 300ms，
 * 那 300ms 里用户会听到自己的声音和 TTS 叠在一起，体验直接崩掉。
 */
import { MicCapture } from './mic'

export type VoiceInputStatus = 'idle' | 'connecting' | 'listening' | 'error'

export interface StreamReady {
  type: 'ready'
  sample_rate: number
  frame_samples: number
  vad: string
  vad_ready: boolean
  vad_detail: string
  asr: string | null
  asr_ready: boolean
  asr_detail: string
}

export type StreamEvent =
  | StreamReady
  | { type: 'vad'; state: 'speech' | 'silence'; probability: number }
  | { type: 'asr_start' }
  | { type: 'asr'; text: string; final: boolean }
  | { type: 'error'; message: string }

export interface VoiceInputOptions {
  /** 返回服务地址（http/https），内部会转成 ws/wss */
  serviceURL: () => string
  onEvent: (event: StreamEvent) => void
  onStatus?: (status: VoiceInputStatus, detail?: string) => void
}

export class VoiceInput {
  private ws: WebSocket | null = null
  private mic: MicCapture | null = null
  private readonly opts: VoiceInputOptions
  private _status: VoiceInputStatus = 'idle'

  constructor(opts: VoiceInputOptions) {
    this.opts = opts
  }

  get status(): VoiceInputStatus {
    return this._status
  }

  /** 连接并开始采集。失败会 throw，调用方负责显示。 */
  async start(): Promise<void> {
    if (this._status === 'listening' || this._status === 'connecting') return

    const url = toWebSocketURL(this.opts.serviceURL())
    this.setStatus('connecting')

    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (err) {
      this.setStatus('error', err instanceof Error ? err.message : String(err))
      throw new Error(`无法连接语音服务：${url}`)
    }

    this.ws = ws

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('连接语音服务超时')), 5000)

        ws.onopen = () => {
          clearTimeout(timer)
          resolve()
        }
        ws.onerror = () => {
          clearTimeout(timer)
          reject(new Error(`连接语音服务失败：${url}`))
        }
      })
    } catch (err) {
      this.teardown()
      const message = err instanceof Error ? err.message : String(err)
      this.setStatus('error', message)
      throw err
    }

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      try {
        this.opts.onEvent(JSON.parse(event.data) as StreamEvent)
      } catch {
        // 非 JSON 帧直接忽略
      }
    }

    ws.onclose = () => {
      if (this._status !== 'idle') this.setStatus('idle')
      this.teardown()
    }

    // 先建好 WS 再开麦，避免采到的音频没地方发
    const mic = new MicCapture({
      onFrame: (pcm) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(pcm)
      },
    })

    try {
      await mic.start()
    } catch (err) {
      this.teardown()
      const message = err instanceof Error ? err.message : String(err)
      this.setStatus('error', message)
      throw err
    }

    this.mic = mic
    this.setStatus('listening')
  }

  /** 停止采集并断开 */
  stop(): void {
    this.setStatus('idle')
    this.teardown()
  }

  /**
   * 通知服务端重置 VAD 状态。
   *
   * 注意：掐断 TTS 播放是本地行为（`voiceOutput.interrupt()`），
   * 不需要等这里往返 —— 网络往返的几十毫秒会让打断感觉迟钝。
   * 这个调用的作用是让服务端丢掉正在累积的语音，避免把插话当成一轮完整输入。
   */
  resetServer(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'interrupt' }))
    }
  }

  /**
   * 手动结束这一轮说话：告诉服务端「我说完了」。
   *
   * ★ 为什么要有它
   *
   * 服务端原来靠 VAD 报静音来自动收尾 —— 但那个判定太敏感：
   * **停半秒喘口气就被切成一句**，用户听到的是半截话，
   * 而且下一句还会被当成新的一轮。
   *
   * **「我说完了」只有用户自己知道**，所以改成显式通知。
   *
   * 注意它**不等**识别结果 —— 结果走 `asr` 事件回来，由调用方决定什么时候断开。
   * 这里只负责把「我完了」这个信号发出去（本地状态先按"已经说完"处理）。
   */
  finish(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'flush' }))
    }
  }

  private setStatus(status: VoiceInputStatus, detail?: string): void {
    this._status = status
    this.opts.onStatus?.(status, detail)
  }

  private teardown(): void {
    this.mic?.stop()
    this.mic = null

    const ws = this.ws
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
      this.ws = null
    }
  }
}

function toWebSocketURL(serviceURL: string): string {
  const base = serviceURL.trim().replace(/\/+$/, '')
  const swapped = base.replace(/^http/i, 'ws')
  return `${swapped}/stream`
}
