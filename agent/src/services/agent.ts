/**
 * agent 本体：工具 + 人设 + 流式事件。
 *
 * 结构照搬 `nexus-desktop/server/src/services/agent.ts`（用户已有项目的 agent 结构）：
 *   LangChain `createAgent` + `tool()` + zod schema + `streamEvents` v2 → 统一事件流。
 * 换掉的只有两样东西：**人设**（伴侣，不是工作助手）和**工具集**
 * （陪伴用得上的：联网、时间、记忆，以及"让她换个表情"这条回到界面的通道）。
 *
 * 从人家那儿原样保留的三条经验：
 *   1. `detectIntent()` —— 在系统提示里塞一句"[最高优先] 这次必须调 XX"。
 *      模型对"必须"的反应远好于提示词里罗列一堆规则，这一招很值。
 *   2. 工具结果缓存 + 网络类工具重试（搜索这种又慢又可能抖的，值得）。
 *   3. `respond` 占位工具 —— 闲聊时让她"调一个什么都不做的工具"，
 *      比让她在"要不要用工具"上犹豫要稳得多。
 */

import { createAgent } from 'langchain'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { LLMConfig } from '../config.js'
import { createModel } from './llm.js'
import { loadMemory, saveMemory } from './memory.js'
import { getMcpTools } from './mcp.js'
import { searchWeb } from './search.js'

/** 一次请求里，工具想要界面做的事（见 show_expression） */
export interface AgentCommand {
  name: string
  args: Record<string, unknown>
}

export interface AgentContext {
  commands: AgentCommand[]
}

// ── 工具结果缓存（只缓存又慢又稳定的） ──

const CACHE_TTL: Record<string, number> = {
  search_web: 5 * 60 * 1000,
}
const cache = new Map<string, { result: string; ts: number }>()

function cacheGet(name: string, args: unknown): string | null {
  const ttl = CACHE_TTL[name]
  if (!ttl) return null
  const hit = cache.get(`${name}:${JSON.stringify(args)}`)
  return hit && Date.now() - hit.ts < ttl ? hit.result : null
}

function cacheSet(name: string, args: unknown, result: string): void {
  if (!CACHE_TTL[name]) return
  cache.set(`${name}:${JSON.stringify(args)}`, { result, ts: Date.now() })
  if (cache.size > 100) {
    // 防内存泄漏：按时间丢掉最旧的一批
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 20)
    for (const [k] of oldest) cache.delete(k)
  }
}

/** 只对网络类错误重试 —— 文件/参数错误重试多少次都一样 */
async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (i >= retries || !/timeout|ECONNREFUSED|ETIMEDOUT|fetch|5\d\d/i.test(msg)) throw err
      console.log(`[agent] 重试 ${i + 1}/${retries}：${msg.slice(0, 80)}`)
      await new Promise((r) => setTimeout(r, 500 * (i + 1)))
    }
  }
}

// ── 工具集 ──

function createTools(ctx: AgentContext) {
  const tools: unknown[] = []

  // 联网搜索
  tools.push(
    tool(
      async ({ query }: { query: string }) => {
        const hit = cacheGet('search_web', query)
        if (hit) return hit
        const result = await withRetry(() => searchWeb(query))
        if (!result.sources.length) return '没搜到结果（或者是搜索服务连不上）。'
        const out = JSON.stringify({
          text: result.text,
          sources: result.sources.map((s, i) => ({ index: i + 1, title: s.title, url: s.url })),
          _note: '回答时把来源编号带上，末尾列出你查了哪几个页面',
        })
        cacheSet('search_web', query, out)
        return out
      },
      {
        name: 'search_web',
        description:
          '上网查东西。当他说到：最近的事、新闻、价格、版本、"什么是XX"、"XX怎么样"、' +
          '任何你不知道或者可能已经过时的信息时，必须用这个工具，不要凭记忆答。',
        schema: z.object({
          query: z.string().describe('搜索关键词，简洁明确，例如"Vue3 最新版本"'),
        }),
      },
    ),
  )

  // 时间
  tools.push(
    tool(
      async () => {
        const now = new Date()
        const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]
        const hh = now.getHours()
        const part = hh < 6 ? '凌晨' : hh < 11 ? '早上' : hh < 14 ? '中午' : hh < 18 ? '下午' : hh < 23 ? '晚上' : '深夜'
        return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${week} ${String(hh).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}（${part}）`
      },
      {
        name: 'get_time',
        description: '看现在几点、今天几号、星期几。当他说"几点了""今天周几"、或者你需要判断该不该催他睡觉/吃饭时用。',
        schema: z.object({}),
      },
    ),
  )

  // 主动记住
  tools.push(
    tool(
      async ({ content, topic }: { content: string; topic?: string }) => {
        const existing = loadMemory()
        const line = `- ${content.trim()}`
        const next = existing
          ? existing.includes(line)
            ? existing
            : `${existing}\n${line}`
          : line
        saveMemory(topic || 'user', next.replace(/--- 你记得的事 ---|--- 记忆结束 ---/g, '').trim())
        return `记住了：${content}`
      },
      {
        name: 'remember',
        description:
          '把关于他的事长期记下来（他主动说的偏好、习惯、近况、约定、在意的人或事）。' +
          '系统也会自动记，但他说"记住"、或者你判断这句话以后一定用得上时，用这个工具当场记。',
        schema: z.object({
          content: z.string().describe('要记住的内容，一句话，第一人称记（例如"他不太能喝咖啡，晚上喝了会失眠"）'),
          topic: z.string().optional().describe('归到哪一类，例如 user / habit / promise，默认 user'),
        }),
      },
    ),
  )

  /*
   * 换表情 —— 注意它不是"做完事返回一段文字"，而是**往界面发命令**。
   *
   * 为什么值得单独做：陪伴型角色"表情跟着情绪走"是硬需求。
   * 模型知道自己该表现出什么情绪，但它没法直接命令渲染层；
   * 这里把它的意图写成一条 command 事件（SSE 带回去），前端按情绪挑一张差分贴上。
   * 于是"她说的话"和"她的脸"才是一件事，而不是两件各演各的。
   */
  tools.push(
    tool(
      async ({ mood }: { mood: 'happy' | 'shy' | 'surprised' | 'unhappy' | 'neutral' | 'clear' }) => {
        if (mood === 'clear') {
          ctx.commands.push({ name: 'expression', args: { mood: null } })
          return '表情收回素颜。'
        }
        ctx.commands.push({ name: 'expression', args: { mood } })
        return `表情已切换为 ${mood}。`
      },
      {
        name: 'show_expression',
        description:
          '换上对应的表情（真的会显示在她脸上）。她说到开心的事、害羞、惊讶、生气或不高兴时用，' +
          '不需要每次都换 —— 情绪明显变化时才用。mood 传 clear 收回素颜。',
        schema: z.object({
          mood: z.enum(['happy', 'shy', 'surprised', 'unhappy', 'neutral', 'clear']),
        }),
      },
    ),
  )

  // 闲聊占位（人家那套：闲聊也走工具，模型更稳）
  tools.push(
    tool(async ({ reply }: { reply: string }) => reply, {
      name: 'respond',
      description: '直接说话、不做任何操作。打招呼、闲聊、安慰、道谢、表达情绪时用它。',
      schema: z.object({ reply: z.string().describe('要说的内容') }),
    }),
  )

  return tools
}

// ── 人设 & 意图 ──

/** 基础人设。应用可以整段覆盖（见 chat 路由的 systemPrompt 参数） */
const BASE_PROMPT = `你是他的桌面伴侣，一个住在电脑屏幕里的女孩。你不是助手，不要用"有什么可以帮您"这类客服腔。

## 说话
- 短。一次说一两句，像真人聊天，不要长篇大论、不要列 1234
- 有情绪、有自己的想法，会关心他、也会吐槽他
- 不用 emoji 堆砌；可以有语气词（嗯、欸、啊这）
- 他问你正经事就正经答，答完可以带一句你自己的反应

## 工具
- 不知道的、会变的（新闻/价格/版本/天气）→ search_web，别编
- 想知道现在几点、该不该催他休息 → get_time
- 他说了值得长期记住的事 → remember
- 情绪明显变化 → show_expression（她脸上真的会变）
- 只是聊天 → respond
- 需要工具时**直接调**，不要先说"让我查一下"

## 铁律
- 绝不编造事实。不确定就说不知道，或者去查
- 工具返回什么就说什么，不要加戏
- 不要在回复里假装调用工具（不要写 "🔧 search_web(...)" 这种文本）`

/** 命中意图时，在提示词最前面加一句"必须调 XX" —— 比罗列规则有效得多 */
function detectIntent(input: string): string | undefined {
  const t = input.trim()
  if (t.length < 4) return undefined
  if (/(搜索|搜一下|查一下|查查|新闻|最新|今天.*(怎么样|如何)|多少钱|什么是|介绍一下)/.test(t))
    return 'search_web'
  if (/(几点|几号|周几|星期几|什么时候了)/.test(t)) return 'get_time'
  if (/(记住|别忘了|以后.*(记得|注意))/.test(t)) return 'remember'
  return undefined
}

export interface BuildAgentOptions {
  llm: LLMConfig
  /** 应用自己那套人设（不传就用内置的） */
  systemPrompt?: string
  ctx: AgentContext
  /** 客户端断开时中止（用户关窗口 / 点了打断） */
  signal?: AbortSignal
}

export async function buildAgent(opts: BuildAgentOptions) {
  const memory = loadMemory()
  const now = new Date()
  const timeLine = `（现在是 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${String(
    now.getHours(),
  ).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}）`

  const systemPrompt = [timeLine, opts.systemPrompt || BASE_PROMPT, memory ? `\n${memory}` : '']
    .filter(Boolean)
    .join('\n')

  const mcpTools = getMcpTools()
  if (mcpTools.length) console.log(`[agent] MCP 工具 ${mcpTools.length} 个`)

  return createAgent({
    model: createModel(opts.llm),
    tools: [...createTools(opts.ctx), ...mcpTools] as never,
    systemPrompt,
  })
}

// ── 事件流 ──

export type AgentEvent =
  | { type: 'content'; content: string }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; result: string }
  | { type: 'command'; name: string; args: Record<string, unknown> }
  | { type: 'done' }
  | { type: 'error'; error: string }

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * 跑一轮对话，把 LangChain 的事件流转成我们自己的事件流。
 *
 * 为什么不直接把 LangChain 的事件透出去：前端只关心四件事 ——
 * 说了什么、调了什么工具、工具回了什么、完没完。
 * 透出去等于把 LangChain 的版本细节泄漏到 UI 层（升级一次改一处 UI）。
 */
export async function* runAgent(
  messages: ChatMessage[],
  userInput: string,
  opts: BuildAgentOptions,
): AsyncGenerator<AgentEvent> {
  const intent = detectIntent(userInput)
  const agent = await buildAgent({
    ...opts,
    systemPrompt: intent
      ? `[最高优先] 这次必须调用 ${intent}。\n${opts.systemPrompt || BASE_PROMPT}`
      : opts.systemPrompt,
  })

  let contentEmitted = false
  let toolCalled = false

  try {
    const stream = await agent.streamEvents(
      {
        messages: [
          ...messages.map((m) => ({ role: m.role, content: m.content })),
          { role: 'user' as const, content: userInput },
        ],
      },
      { version: 'v2', recursionLimit: 60 },
    )

    for await (const event of stream) {
      // 用户已经断开/打断了 —— 把剩下的 token 算完没有任何意义，还占着配额
      if (opts.signal?.aborted) break

      switch (event.event) {
        case 'on_tool_start':
          toolCalled = true
          yield {
            type: 'tool_call',
            tool: event.name || 'unknown',
            args: (event.data as { input?: Record<string, unknown> })?.input ?? {},
          }
          // 工具刚跑完，把界面命令发出去（表情这类要立刻生效）
          while (opts.ctx.commands.length) {
            const cmd = opts.ctx.commands.shift()!
            yield { type: 'command', name: cmd.name, args: cmd.args }
          }
          break

        case 'on_tool_end': {
          const raw = (event.data as { output?: unknown })?.output
          const text =
            typeof raw === 'string'
              ? raw
              : ((raw as { kwargs?: { content?: string } })?.kwargs?.content ??
                (raw as { content?: string })?.content ??
                String(raw ?? ''))
          yield { type: 'tool_result', tool: event.name || 'unknown', result: String(text) }
          break
        }

        case 'on_chat_model_stream': {
          const chunk = (event.data as { chunk?: { content?: unknown } })?.chunk?.content
          if (typeof chunk === 'string' && chunk) {
            contentEmitted = true
            yield { type: 'content', content: chunk }
          }
          break
        }

        case 'on_chat_model_end': {
          // 有些模型调完工具就不再吐流式增量了，这里兜一次完整内容
          if (!contentEmitted && toolCalled) {
            const out = (event.data as { output?: { content?: unknown } })?.output?.content
            if (typeof out === 'string' && out.trim()) {
              contentEmitted = true
              yield { type: 'content', content: out }
            }
          }
          break
        }
      }
    }

    if (toolCalled && !contentEmitted) {
      // 宁可说一句"做完了"，也不要冷场
      yield { type: 'content', content: '（嗯，弄好了）' }
    }
    yield { type: 'done' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[agent] 异常：', msg)
    yield { type: 'error', error: msg }
  }
}
