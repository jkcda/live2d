/**
 * 语音输出。
 *
 * 核心是「合成并行、播放串行」：
 *   LLM 按句吐出文本 → 每句立刻发起合成（并行，抢首包时间）
 *   → 播放严格按顺序排队（串行，避免抢话和断句错乱）
 *
 * 音频从哪来由 Python 推理服务决定（见 python/README.md 的接口约定），
 * 这里只负责调用和排队。服务没起来时静默降级为「只显示文字，不出声」。
 */
import type { AudioPlayer } from './player'

export interface TTSConfig {
  /** Python 推理服务地址，例如 http://127.0.0.1:8765 */
  baseURL: string
  /** 音色标识，由服务端定义（如 CosyVoice 的 spk_id 或参考音频名） */
  voice?: string
  /** 语速倍率 */
  speed?: number
}

export const DEFAULT_TTS_CONFIG: TTSConfig = {
  baseURL: 'http://127.0.0.1:8765',
  voice: 'default',
  speed: 1,
}

export class VoiceOutput {
  /** 播放队列尾；每句话挂到它后面，保证串行 */
  private queue: Promise<void> = Promise.resolve()
  /** 代次计数：interrupt 时自增，队列里过期的句子据此丢弃 */
  private generation = 0
  /** 队列中未播完的句子数 */
  private pending = 0
  /** 一次「说话回合」共用一个 AbortController */
  private controller: AbortController | null = null

  private readonly player: AudioPlayer
  private readonly getConfig: () => TTSConfig

  constructor(player: AudioPlayer, getConfig: () => TTSConfig) {
    this.player = player
    this.getConfig = getConfig
  }

  /** 是否还有话没说完 */
  get busy(): boolean {
    return this.pending > 0
  }

  /**
   * 排入一句话。合成立刻发起，播放按顺序等待。
   * 这是接 LLM 流式输出的入口 —— 每凑够一句就调一次。
   */
  enqueue(sentence: string): void {
    const text = sentence.trim()
    if (!text) return

    const gen = this.generation
    const controller = this.ensureController()
    this.pending++

    // 关键：先发起合成（不 await），再挂到播放链尾 —— 合成与播放解耦
    const audio = this.synthesize(text, controller.signal)

    this.queue = this.queue
      .then(async () => {
        // 这一句在排队期间被打断了，直接丢弃
        if (gen !== this.generation) return
        const buffer = await audio
        if (!buffer || gen !== this.generation) return
        await this.player.playBufferAndWait(buffer)
      })
      .catch((err) => {
        console.warn('[tts] 播放失败', err)
      })
      .finally(() => {
        if (gen === this.generation) this.pending--
      })
  }

  /**
   * 打断：掐断播放、取消未完成的合成、丢弃排队的句子。
   * 用户一开口就调这个 —— 这是陪伴感的分水岭。
   */
  interrupt(): void {
    this.generation++
    this.pending = 0

    this.controller?.abort()
    this.controller = null

    this.player.stop()
  }

  /** 探一下推理服务在不在 */
  async health(): Promise<boolean> {
    const cfg = this.getConfig()
    if (!cfg.baseURL) return false
    try {
      const resp = await fetch(`${trimSlash(cfg.baseURL)}/health`, {
        signal: AbortSignal.timeout(1500),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  private ensureController(): AbortController {
    if (!this.controller) this.controller = new AbortController()
    return this.controller
  }

  private async synthesize(text: string, signal: AbortSignal): Promise<AudioBuffer | null> {
    const cfg = this.getConfig()
    if (!cfg.baseURL) return null

    try {
      const resp = await fetch(`${trimSlash(cfg.baseURL)}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: cfg.voice, speed: cfg.speed }),
        signal,
      })

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`)
      }

      const data = await resp.arrayBuffer()
      if (data.byteLength === 0) return null

      return await this.player.context.decodeAudioData(data)
    } catch (err) {
      // 打断导致的取消是正常路径，不报错
      if (err instanceof DOMException && err.name === 'AbortError') return null
      if (err instanceof Error && err.name === 'TimeoutError') return null
      console.warn('[tts] 合成失败（服务未启动？）', err)
      return null
    }
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}
