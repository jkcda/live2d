/**
 * agent 服务的客户端。
 *
 * 为什么要有这一层：应用原本是"渲染进程直接打 LLM"（见 llm.ts）。
 * 那条路只够聊天 —— 没有工具、没有记忆、没有 MCP。
 * 现在多一条路：**agent 服务**（`agent/`，8766）负责"想 + 做"，这边负责"说 + 演"。
 *
 * ★ 两条路都要留着，而且能随时切换：
 *   · agent 服务是独立进程，没起、崩了、端口被占都是可能的；
 *   · 服务不在时**必须还能聊天**（退化成直连 LLM），
 *     否则"她想跟你说话"这件事就绑在一个可选组件的生死上了。
 *
 * 事件协议与 agent 服务一一对应（content / tool_call / tool_result / command / done / error），
 * 这里把它翻成应用内部的 AgentEvent（delta / tool_call / tool_result / command / done / error）。
 * 两边字段名刻意保持一致 —— `types.ts` 里那句注释说的就是这件事。
 */

import type { AgentEvent, ChatMessage, LLMConfig } from './types'

export interface AgentStreamOptions {
  /** agent 服务地址，例如 http://127.0.0.1:8766 */
  url: string
  /** 历史（**不含 system** —— 人设由 systemPrompt 单独传，服务端自己拼） */
  messages: ChatMessage[]
  /** 这一句 */
  input: string
  /** 设置面板里那套 LLM 配置。为什么要传：服务端不存 key，见 agent/src/config.ts */
  llm: LLMConfig
  /** 应用自己那套人设（persona.ts） */
  systemPrompt?: string
  sessionId?: string
  /**
   * 当前前台窗口快照（她「看得见」的依据）。
   *
   * 由调用方在发请求前向主进程取一次，随请求带上 —— 不搞常驻推送通道。
   * 取不到（没在观察 / 已暂停 / 命中黑名单）就是 undefined，服务端当「不知道」处理。
   */
  activity?: ActivitySnapshot | null
  /**
   * 这一轮附上的屏幕截图（前台窗口那一块，已过黑名单 + 暂停开关）。
   *
   * 服务端把它作为**图片内容块**拼在这条用户消息上，不写进历史 ——
   * 历史里塞 base64 会把 localStorage 撑爆（见 electron/screen.ts 的契约）。
   * 拿不到就是 null：她照样能聊，只是少一张图。
   */
  screen?: ScreenForTurn | null
  signal?: AbortSignal
}

/** agent 服务返回的原始事件 */
interface RawEvent {
  type?: string
  content?: string
  tool?: string
  args?: Record<string, unknown>
  result?: string
  name?: string
  error?: string
}

/**
 * 连 agent 服务，把它的 SSE 流转成应用的事件流。
 *
 * 连接失败（服务没起）会**抛出** —— 由调用方决定退化成直连还是报错。
 * 这里不自己兜底：那样调用方就分不清"她没回话"和"服务没起来"。
 */
export async function* streamAgent(opts: AgentStreamOptions): AsyncGenerator<AgentEvent> {
  const url = `${opts.url.replace(/\/+$/, '')}/chat`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      input: opts.input,
      llm: opts.llm,
      systemPrompt: opts.systemPrompt,
      sessionId: opts.sessionId,
      activity: opts.activity ?? null,
      screen: opts.screen ?? null,
    }),
    signal: opts.signal,
  })

  if (!resp.ok || !resp.body) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`agent 服务 HTTP ${resp.status} ${detail.slice(0, 120)}`)
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    // SSE：事件之间用空行分隔。只处理完整的段落，最后一段留在 buffer 里等下一块
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''

    for (const block of blocks) {
      const line = block
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('data:'))
      if (!line) continue // `: connected` 这类注释行

      let raw: RawEvent
      try {
        raw = JSON.parse(line.slice(5).trim()) as RawEvent
      } catch {
        continue // 半截 JSON（极少见）直接跳过，别把整轮打断
      }

      switch (raw.type) {
        case 'content':
          if (raw.content) yield { type: 'delta', content: raw.content }
          break
        case 'tool_call':
          yield { type: 'tool_call', tool: raw.tool ?? 'unknown', args: raw.args ?? {} }
          break
        case 'tool_result':
          yield { type: 'tool_result', tool: raw.tool ?? 'unknown', result: raw.result ?? '' }
          break
        case 'command':
          yield { type: 'command', name: raw.name ?? '', args: raw.args ?? {} }
          break
        case 'done':
          yield { type: 'done' }
          return
        case 'error':
          yield { type: 'error', message: raw.error ?? 'agent 出错' }
          return
      }
    }
  }

  yield { type: 'done' }
}

/**
 * agent 服务可用性缓存。
 *
 * 为什么缓存：`/chat` 失败一次就够判断"服务不在"了，
 * 而每一句话都先探一次健康检查会白白多一次往返。
 * 30 秒的窗口是这个权衡：服务刚起来最多等半分钟就被发现。
 */
const UNAVAILABLE_MS = 30_000
let unavailableUntil = 0

export function markAgentDown(): void {
  unavailableUntil = Date.now() + UNAVAILABLE_MS
}

export function agentLikelyUp(): boolean {
  return Date.now() >= unavailableUntil
}

/** 探活（设置面板显示状态用） */
export async function probeAgent(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const resp = await fetch(`${url.replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!resp.ok) return { ok: false, detail: `HTTP ${resp.status}` }
    const data = (await resp.json()) as {
      mcp?: { state?: string; toolCount?: number; detail?: string }
      memoryFiles?: number
    }
    const mcp = data.mcp
    return {
      ok: true,
      detail:
        `MCP ${mcp?.state ?? '?'}（工具 ${mcp?.toolCount ?? 0}）` +
        `｜记忆 ${data.memoryFiles ?? 0} 条`,
    }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
