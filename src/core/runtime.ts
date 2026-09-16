/**
 * 全局运行时单例。
 *
 * 为什么必须是单例：口型的数据源是「正在播放的那段音频」，
 * 所以 TTS 输出和 Live2D 舞台必须共用同一个 AudioPlayer —— 各建一个就永远对不上。
 */
import { AudioPlayer } from './audio/player'
import { VoiceOutput, type TTSConfig } from './audio/tts'
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

/** 配置变更后重建会话，让新的 baseURL / key / 人设立即生效 */
export function reconfigureSession(): void {
  chatSession.interrupt()
  chatSession.updateConfig(loadLLMConfig())
}

/** 更新语音配置并落盘 */
export function applyTTSConfig(cfg: TTSConfig): void {
  saveTTSConfig(cfg)
}
