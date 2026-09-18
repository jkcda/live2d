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
import type { AgentEvent } from './agent/types'
import { idleRuntime, loadAgentConfig, loadLLMConfig, loadTTSConfig, saveTTSConfig } from './settings'

/** 全应用唯一的音频输出 */
export const audioPlayer = new AudioPlayer()

/** 语音输出队列（读的是实时配置，改设置后立即生效） */
export const voiceOutput = new VoiceOutput(audioPlayer, () => loadTTSConfig())

/*
 * 启动时探一次服务端引擎，按它的快慢定切分粒度。
 *
 * 云端 RTF 0.14 → 整段合成（语气连贯）；本地 cosyvoice RTF > 1 → 切短
 * （让播放追上合成时那个停顿落在句号处，听起来是换气而不是卡住）。
 * 详见 VoiceOutput.probeEngine 的注释。
 *
 * 不 await：这是个后台优化，探不到就用默认值（整段），不该拖住启动。
 */
void voiceOutput.probeEngine()

/**
 * agent 事件订阅者。
 *
 * 为什么要这么一层：`command` 事件（"换个表情"）要落到**舞台**上，
 * 而舞台活在 Vue 组件里、会随热插拔重建；会话是模块级单例。
 * 让组件在 mount 时挂上、unmount 时摘掉，比让 runtime 去认识舞台干净得多。
 */
type AgentEventHandler = (event: AgentEvent) => void
const agentHandlers = new Set<AgentEventHandler>()

export function onAgentEvent(handler: AgentEventHandler): () => void {
  agentHandlers.add(handler)
  return () => agentHandlers.delete(handler)
}

/** 当前对话会话（走 agent 服务；服务不在时自动退回直连 LLM） */
export const chatSession = new ChatSession({
  cfg: loadLLMConfig(),
  agent: loadAgentConfig(),
  onSentence: (sentence) => voiceOutput.enqueue(sentence),
  onEvent: (event) => {
    for (const fn of agentHandlers) fn(event)
  },
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

/*
 * ★ 订阅用 Set（多handler），不是单个字段。
 *
 * 原来是「一个字段 + 覆盖」—— 那意味着**只能有一个订阅者**：
 * runtime 自己挂一个，面板再挂一个就把前一个顶掉了，
 * 而且不报错（表现是「某个地方莫名其妙收不到事件」）。
 *
 * 语音现在有两个消费方：面板（画波形/状态）和 runtime（收尾 + 发给她）。
 * 所以必须是多播。
 */
const voiceEventHandlers = new Set<EventHandler>()
const voiceStatusHandlers = new Set<StatusHandler>()

/** 订阅语音输入事件。返回取消订阅函数。 */
export function subscribeVoiceEvents(handler: EventHandler): () => void {
  voiceEventHandlers.add(handler)
  return () => {
    voiceEventHandlers.delete(handler)
  }
}

export function subscribeVoiceStatus(handler: StatusHandler): () => void {
  voiceStatusHandlers.add(handler)
  return () => {
    voiceStatusHandlers.delete(handler)
  }
}

// ---------------------------------------------------------------- 语音回合

/**
 * 语音回合的状态。
 *
 * 「按一次开始录、再按一次结束」—— **快捷键和面板按钮走同一条路**，
 * 免得两边各有一套状态机（那必然会出现「面板显示在录、其实没录」这种事）。
 */
export type VoiceRoundState = 'idle' | 'recording' | 'recognizing'

let roundState: VoiceRoundState = 'idle'
const roundHandlers = new Set<(s: VoiceRoundState) => void>()

function setRoundState(s: VoiceRoundState): void {
  if (roundState === s) return
  roundState = s
  for (const fn of roundHandlers) fn(s)
}

export function subscribeVoiceRound(handler: (s: VoiceRoundState) => void): () => void {
  roundHandlers.add(handler)
  handler(roundState) // 立即回放当前状态，订阅方不用自己初始化
  return () => {
    roundHandlers.delete(handler)
  }
}

/**
 * 一轮对话的广播事件。
 *
 * ★ 为什么要有它：**发消息的入口不止一个**
 *
 *   · 面板里打字 / 点麦克风
 *   · 全局快捷键直接说话（面板可能压根没挂载）
 *
 * 如果每个入口自己驱动会话、自己渲染，就会有两套渲染逻辑，
 * 而且必然出现「快捷键说的那句话，面板里看不到」这种。
 *
 * 所以：**runtime 负责发，面板负责画**，中间用这个广播接上。
 * 面板不再直接调 `chatSession.send()`。
 */
export type TurnEvent =
  | { type: 'start'; text: string }
  | { type: 'agent'; event: AgentEvent }
  | { type: 'end' }

const turnHandlers = new Set<(e: TurnEvent) => void>()

export function subscribeTurns(handler: (e: TurnEvent) => void): () => void {
  turnHandlers.add(handler)
  return () => {
    turnHandlers.delete(handler)
  }
}

function emitTurn(e: TurnEvent): void {
  for (const fn of turnHandlers) fn(e)
}

/**
 * 把一轮话发给她 —— **所有入口都走这里**。
 *
 * 只负责驱动会话（写历史 + 触发 TTS 那条 hook）并广播事件；
 * **渲染由订阅方负责**（面板订阅了 `subscribeTurns`）。
 */
let turnBusy = false

export async function sendTurn(text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed || turnBusy) return

  turnBusy = true
  emitTurn({ type: 'start', text: trimmed })
  try {
    for await (const event of chatSession.send(trimmed)) {
      emitTurn({ type: 'agent', event })
    }
  } catch (err) {
    console.warn('[turn] 这一轮失败', err)
  } finally {
    turnBusy = false
    emitTurn({ type: 'end' })
  }
}

/** 一轮是不是还在跑（面板据此禁用输入框） */
export function turnInFlight(): boolean {
  return turnBusy
}

/**
 * 按一次开始录、再按一次结束。
 *
 * ★ 为什么它在 runtime 而不是 ChatPanel
 *
 * 因为「按快捷键直接说话」时对话面板是关着的，挂在面板里麦克风根本不存在。
 * **语音是一条独立的入口，和打字平级**，不该寄居在打字面板里。
 */
export async function toggleVoiceRound(): Promise<void> {
  if (roundState === 'recording') {
    setRoundState('recognizing')
    voiceInput.finish()
    // 兜底：3 秒还没等到 asr 就强行断开，别把麦克风一直占着
    window.setTimeout(() => {
      if (roundState === 'recognizing') {
        voiceInput.stop()
        setRoundState('idle')
      }
    }, 3000)
    return
  }

  if (roundState !== 'idle') return // 识别中，别插队

  try {
    await voiceInput.start()
    setRoundState('recording')
  } catch (err) {
    console.warn('[voice] 开麦失败', err)
    setRoundState('idle')
  }
}

/** 当前语音回合状态（面板用来画按钮） */
export function voiceRoundState(): VoiceRoundState {
  return roundState
}

export const voiceInput = new VoiceInput({
  serviceURL: () => loadTTSConfig().baseURL,

  onEvent(event) {
    // ★ barge-in：VAD 一报「开始说话」就立刻掐断，不等 ASR。
    //   等 ASR 要多 300ms，那 300ms 里用户会听到自己的声音和 TTS 叠在一起。
    if (event.type === 'vad' && event.state === 'speech') {
      bargeIn()
    }

    /*
     * 语音回合的收尾。**必须在 runtime 做**，不能在面板里 ——
     * 快捷键录音时面板是关着的（v-if 卸载），它收不到这个事件。
     *
     * 顺序：先关麦，再发文字。反过来的话麦克风还开着，
     * 她的回复会被自己听到、触发 barge-in 把自己掐断。
     */
    if (roundState === 'recognizing') {
      if (event.type === 'asr') {
        voiceInput.stop()
        setRoundState('idle')
        void sendTurn(event.text)
      } else if (event.type === 'error') {
        voiceInput.stop()
        setRoundState('idle')
      }
    }

    for (const fn of voiceEventHandlers) fn(event)
  },

  onStatus(status, detail) {
    for (const fn of voiceStatusHandlers) fn(status, detail)
  },
})

// ---------------------------------------------------------------- 快捷键

/*
 * 订阅「语音回合」快捷键（默认 Ctrl+Shift+V）。
 *
 * ★ 为什么在 runtime 订阅，不在组件里
 *
 * 这个快捷键的全部价值就在于**面板关着也能用** —— 而面板是 `v-if` 的，
 * 关着就整个卸载了。挂它上面等于只在「面板已经开着」时才有效，
 * 那还不如直接点面板上的按钮。
 *
 * 浏览器版没有 `window.nexus`（那是 Electron 的桥），所以这里判空跳过 ——
 * 浏览器里用面板上那个麦克风按钮，走的是同一个 `toggleVoiceRound()`。
 */
if (typeof window !== 'undefined' && window.nexus?.onToggleVoice) {
  window.nexus.onToggleVoice(() => {
    void toggleVoiceRound()
  })
}

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

/*
 * 开发期调试钩子。
 *
 * 为什么要暴露这些单例：Vite 在 HMR 下会给改动过的模块加 `?t=` 查询串，
 * 于是从外部 `import('/src/core/runtime.ts')` 拿到的**未必是应用正在用的那个实例**
 * —— 实例级补丁会打在一个没人用的副本上（而原型补丁看起来生效，更具迷惑性）。
 * 排查播放队列、打断这类问题时必须拿到真身。
 * 生产构建会被 import.meta.env.DEV 摇掉。
 */
if (import.meta.env.DEV) {
  Object.assign(window as unknown as Record<string, unknown>, {
    __nexusRuntime: { audioPlayer, voiceOutput, chatSession, voiceInput, bargeIn, idleRuntime },
  })
}
