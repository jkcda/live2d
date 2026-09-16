/**
 * 全局运行时单例。
 *
 * 为什么必须是单例：口型的数据源是「正在播放的那段音频」，
 * 所以 TTS 输出和 Live2D 舞台必须共用同一个 AudioPlayer —— 各建一个就永远对不上。
 */
import { AudioPlayer } from './audio/player'
import { VoiceOutput, type TTSConfig } from './audio/tts'
import { VoiceInput, type StreamEvent, type VoiceInputStatus } from './audio/stream'
import { ChatSession } from './agent/session'
import { loadLLMConfig, loadTTSConfig, saveTTSConfig } from './settings'

/** 全应用唯一的音频输出 */
export const audioPlayer = new AudioPlayer()

/** 语音输出队列（读的是实时配置，改设置后立即生效） */
export const voiceOutput = new VoiceOutput(audioPlayer, () => loadTTSConfig())

/** 当前对话会话 */
export const chatSession = new ChatSession({
  cfg: loadLLMConfig(),
  onSentence: (sentence) => voiceOutput.enqueue(sentence),
})

/**
 * 打断一切：停止生成 + 停止播放 + 口型归零。
 *
 * 集中在这里是因为它有三个触发源 ——
 * 用户点「打断」按钮、VAD 检测到用户开口、窗口被隐藏 ——
 * 分散实现迟早会漏掉某一路。
 */
export function bargeIn(): void {
  chatSession.interrupt()
  voiceOutput.interrupt()
}

// ---------------------------------------------------------------- 语音输入

type EventHandler = (event: StreamEvent) => void
type StatusHandler = (status: VoiceInputStatus, detail?: string) => void

let voiceEventHandler: EventHandler | null = null
let voiceStatusHandler: StatusHandler | null = null

/** 订阅语音输入事件。返回取消订阅函数。 */
export function subscribeVoiceEvents(handler: EventHandler): () => void {
  voiceEventHandler = handler
  return () => {
    if (voiceEventHandler === handler) voiceEventHandler = null
  }
}

export function subscribeVoiceStatus(handler: StatusHandler): () => void {
  voiceStatusHandler = handler
  return () => {
    if (voiceStatusHandler === handler) voiceStatusHandler = null
  }
}

export const voiceInput = new VoiceInput({
  serviceURL: () => loadTTSConfig().baseURL,

  onEvent(event) {
    // ★ barge-in：VAD 一报「开始说话」就立刻掐断，不等 ASR。
    //   等 ASR 要多 300ms，那 300ms 里用户会听到自己的声音和 TTS 叠在一起。
    if (event.type === 'vad' && event.state === 'speech') {
      bargeIn()
    }

    voiceEventHandler?.(event)
  },

  onStatus(status, detail) {
    voiceStatusHandler?.(status, detail)
  },
})

// ---------------------------------------------------------------- 配置

/** 配置变更后重建会话，让新的 baseURL / key / 人设立即生效 */
export function reconfigureSession(): void {
  chatSession.interrupt()
  chatSession.updateConfig(loadLLMConfig())
}

/** 更新语音配置并落盘 */
export function applyTTSConfig(cfg: TTSConfig): void {
  saveTTSConfig(cfg)
}
