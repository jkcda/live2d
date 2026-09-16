/**
 * 对话编排层。
 *
 * 职责边界：
 *   - 维护消息历史（含裁剪）
 *   - 调 LLM 流式接口
 *   - 把 token 流按句切分后交给 TTS
 *   - 处理打断
 *
 * 不负责：音频播放、Live2D 参数、记忆持久化。那些由上层挂 hook 接。
 */
import { createSentenceSplitter, streamChat } from './llm'
import { buildSystemPrompt, DEFAULT_PERSONA, type Persona } from './persona'
import type { AgentEvent, ChatMessage, LLMConfig } from './types'

export interface SessionOptions {
  cfg: LLMConfig
  persona?: Persona
  /** 每凑够一句回调一次 —— 接流式 TTS */
  onSentence?: (sentence: string) => void
  /** 每个 token 增量回调 —— 接字幕渲染 */
  onDelta?: (delta: string) => void
  /** 历史里保留的最大消息条数（不含 system）。默认 40，约 20 轮 */
  maxHistory?: number
}

export class ChatSession {
  private cfg: LLMConfig
  private system: string
  private readonly hooks: Pick<SessionOptions, 'onSentence' | 'onDelta'>
  private readonly maxHistory: number

  private history: ChatMessage[] = []
  private controller: AbortController | null = null

  constructor(opts: SessionOptions) {
    this.cfg = opts.cfg
    this.system = buildSystemPrompt(opts.persona ?? DEFAULT_PERSONA)
    this.hooks = { onSentence: opts.onSentence, onDelta: opts.onDelta }
    this.maxHistory = opts.maxHistory ?? 40
  }

  /** 热更新接口配置与人设（改设置后调用，无需重建实例） */
  updateConfig(cfg: LLMConfig, persona?: Persona): void {
    this.cfg = cfg
    if (persona) this.system = buildSystemPrompt(persona)
  }

  /** 是否正在生成 */
  get busy(): boolean {
    return this.controller !== null
  }

  /** 只读历史快照（含 system） */
  get messages(): readonly ChatMessage[] {
    return [{ role: 'system', content: this.system }, ...this.history]
  }

  /**
   * 发一轮对话，流式产出事件。
   *
   * 调用方直接 `for await` 消费即可；口型/字幕/音频由 hooks 驱动，
   * 不需要在消费侧再解析一遍文本。
   */
  async *send(userText: string): AsyncGenerator<AgentEvent> {
    const text = userText.trim()
    if (!text) return
    if (this.controller) this.interrupt()

    this.history.push({ role: 'user', content: text })

    const controller = new AbortController()
    this.controller = controller

    const splitter = createSentenceSplitter()
    let assistant = ''
    let errored = false

    try {
      for await (const ev of streamChat(this.messages as ChatMessage[], this.cfg, controller.signal)) {
        if (ev.type === 'delta') {
          assistant += ev.content
          this.hooks.onDelta?.(ev.content)

          for (const sentence of splitter.push(ev.content)) {
            this.hooks.onSentence?.(sentence)
          }
        } else if (ev.type === 'error') {
          errored = true
        }
        yield ev
      }

      // 收尾：把最后没带标点的残句也送出去
      const rest = splitter.flush()
      if (rest) this.hooks.onSentence?.(rest)
    } finally {
      this.controller = null

      // 被打断时保留已生成的部分，让下一轮上下文连续
      if (assistant) {
        this.history.push({ role: 'assistant', content: assistant })
        this.trim()
      } else if (errored) {
        // 一个字都没吐且报错 —— 把这条用户消息撤回，避免污染上下文
        this.history.pop()
      }
    }
  }

  /**
   * 打断当前生成。用户一开口就调，这是陪伴感的分水岭。
   * 幂等，未在生成时调用无副作用。
   */
  interrupt(): void {
    this.controller?.abort()
    this.controller = null
  }

  /** 清空对话历史（人设保留） */
  clear(): void {
    this.interrupt()
    this.history = []
  }

  /** 导出，供持久化用 */
  toJSON(): ChatMessage[] {
    return [...this.history]
  }

  /** 从持久化数据恢复 */
  load(messages: ChatMessage[]): void {
    this.interrupt()
    this.history = messages.filter((m) => m.role !== 'system')
    this.trim()
  }

  /** 滑动窗口裁剪，system 永远在第一位、不参与裁剪 */
  private trim(): void {
    if (this.history.length <= this.maxHistory) return
    this.history = this.history.slice(-this.maxHistory)

    // 裁剪后开头可能是 assistant，补一条占位避免部分接口报错
    if (this.history[0]?.role === 'assistant') {
      this.history.unshift({ role: 'user', content: '(继续)' })
    }
  }
}
