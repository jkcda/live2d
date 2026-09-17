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
import { agentLikelyUp, markAgentDown, streamAgent } from './agentClient'
import { clearHistory, loadHistory, saveHistory } from './history'
import { buildSystemPrompt, DEFAULT_PERSONA, type Persona } from './persona'
import type { AgentEvent, ChatMessage, LLMConfig } from './types'

/** agent 服务配置（工具 / MCP / 记忆都在这条路上） */
export interface AgentServiceConfig {
  /** 服务地址，例如 http://127.0.0.1:8766 */
  url: string
  /** 关掉就退回「直连 LLM」的老路（只有聊天，没有工具和记忆） */
  enabled: boolean
  /** 分会话存摘要；将来多角色/多会话时区分 */
  sessionId?: string
}

/**
 * 取一次当前前台窗口快照。
 *
 * 放在发请求前取，而不是搞常驻推送通道 —— 一次 IPC 往返几毫秒，
 * 而且拿到的一定是最新的。
 *
 * **永远不抛**：她「看得见」是锦上添花，不能因为它把整轮对话搞挂。
 * 拿不到就是 null，服务端当「不知道」处理。
 */
async function currentActivity(): Promise<ActivitySnapshot | null> {
  try {
    return (await window.nexus?.getActivity()) ?? null
  } catch {
    return null
  }
}

export interface SessionOptions {
  cfg: LLMConfig
  persona?: Persona
  /** agent 服务（不传 = 直连 LLM） */
  agent?: AgentServiceConfig
  /** 每凑够一句回调一次 —— 接流式 TTS */
  onSentence?: (sentence: string) => void
  /** 每个 token 增量回调 —— 接字幕渲染 */
  onDelta?: (delta: string) => void
  /**
   * 每一个事件都回调一次（含 tool_call / tool_result / command）。
   *
   * ★ 为什么需要它：`command`（比如"换个表情"）要落到**舞台**上，
   *   而舞台是另一个 Vue 组件 —— 它不消费这个生成器。
   *   会话是所有人共用的咽喉（文字输入和语音输入都从这儿走），
   *   在这儿广播一次，两个入口就都覆盖到了。
   */
  onEvent?: (event: AgentEvent) => void
  /** 历史里保留的最大消息条数（不含 system）。默认 40，约 20 轮 */
  maxHistory?: number
}

export class ChatSession {
  private cfg: LLMConfig
  private system: string
  private agent: AgentServiceConfig | undefined
  private readonly hooks: Pick<SessionOptions, 'onSentence' | 'onDelta' | 'onEvent'>
  private readonly maxHistory: number

  private history: ChatMessage[] = []
  private controller: AbortController | null = null

  constructor(opts: SessionOptions) {
    this.cfg = opts.cfg
    this.agent = opts.agent
    this.system = buildSystemPrompt(opts.persona ?? DEFAULT_PERSONA)
    this.hooks = { onSentence: opts.onSentence, onDelta: opts.onDelta, onEvent: opts.onEvent }
    this.maxHistory = opts.maxHistory ?? 40
    /*
     * ★ 恢复上次的对话历史。
     *   这一行就是"每次打开对话都是空的"的解药 —— 以前 toJSON()/load() 写了却没人调，
     *   刷新一次全丢。会话是模块级单例，只在这里恢复一次；面板重开时读 this.messages 即可。
     */
    this.history = loadHistory()
    this.trim()
  }

  /** 热更新接口配置与人设（改设置后调用，无需重建实例） */
  updateConfig(cfg: LLMConfig, persona?: Persona): void {
    this.cfg = cfg
    if (persona) this.system = buildSystemPrompt(persona)
  }

  /** 热更新 agent 服务配置（设置里开关一下就该生效，不该要求重启应用） */
  updateAgent(agent: AgentServiceConfig | undefined): void {
    this.agent = agent
  }

  /** 当前是不是走 agent 服务（设置面板显示状态用） */
  get usingAgent(): boolean {
    return Boolean(this.agent?.enabled)
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
      for await (const ev of this.stream(text, controller.signal)) {
        if (ev.type === 'delta') {
          assistant += ev.content
          this.hooks.onDelta?.(ev.content)

          for (const sentence of splitter.push(ev.content)) {
            this.hooks.onSentence?.(sentence)
          }
        } else if (ev.type === 'error') {
          errored = true
        }
        // 广播给"不消费这个生成器"的部分（舞台要执行 command、面板要显示工具）
        this.hooks.onEvent?.(ev)
        yield ev
      }

      // 收尾：把最后没带标点的残句也送出去。
      //
      // ★ 但被打断时绝不能送：那样用户刚打断，她立刻又把半句话读出来 ——
      //   实测是「打断后 1ms 残句进队列，播放队列重新出声」，且残句往往还是
      //   半截的（比如只到「要不要一起出去」）。
      //   打断要贯穿到链路的最后一步，包括这个收尾。
      if (!controller.signal.aborted) {
        const rest = splitter.flush()
        if (rest) this.hooks.onSentence?.(rest)
      }
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

      /*
       * 落盘放在 finally 里：**成功、报错、被用户打断**三种结局都要留下痕迹。
       * 只写在成功路径上是个常见的坑 —— 用户打断一半再刷新，那一轮就凭空消失了。
       */
      saveHistory(this.history)
    }
  }

  /**
   * 挑一条路走：优先 agent 服务，不行就退回直连 LLM。
   *
   * ★ 退化必须是**自动**的：agent 服务是独立进程（要跑 pnpm，还要连 MCP），
   *   没起来是常态。如果这时候她连话都不说了，用户会觉得"这软件坏了"，
   *   而实际上她只是少了工具 —— 少了工具还能聊天，这才是对的降级。
   *
   * 服务刚挂掉那 30 秒内不再重试（见 agentClient 的 markAgentDown）：
   * 否则每一句话都要先等一次连接超时，那才是真的卡。
   */
  private async *stream(text: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const agentCfg = this.agent
    if (agentCfg?.enabled && agentLikelyUp()) {
      try {
        for await (const ev of streamAgent({
          url: agentCfg.url,
          // agent 服务自己拼 system（人设 + 记忆 + 时间），所以历史里不带 system
          messages: this.history.slice(0, -1),
          input: text,
          llm: this.cfg,
          systemPrompt: this.system,
          sessionId: agentCfg.sessionId,
          activity: await currentActivity(),
          signal,
        })) {
          yield ev
        }
        return
      } catch (err) {
        if (signal.aborted) return
        markAgentDown()
        console.warn(
          '[session] agent 服务不可用，这一轮退回直连 LLM：',
          err instanceof Error ? err.message : err,
        )
      }
    }

    yield* streamChat(this.messages as ChatMessage[], this.cfg, signal)
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
    // 落盘的那份也要清 —— 否则刷新一下，刚清掉的历史又全回来了
    clearHistory()
  }

  /**
   * 导出，供持久化用。
   *
   * 注意：实际落盘走的是 history.ts 的 saveHistory（每次对话结束自动存），
   * 这个方法是给外部（比如导出成文件）用的 —— 别再出现"写了却没人调"的情况。
   */
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
