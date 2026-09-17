/**
 * 对话路由（SSE）。
 *
 * 协议（和项目里 Python 服务的 /stream 一个风格：SSE，每行一个 JSON）：
 *
 *   POST /chat
 *   { "messages": [{role,content}], "input": "在吗", "llm": {baseURL,apiKey,model},
 *     "systemPrompt": "…（可选）", "sessionId": "…（可选，用于历史压缩）" }
 *
 *   data: {"type":"tool_call","tool":"search_web","args":{...}}
 *   data: {"type":"tool_result","tool":"search_web","result":"…"}
 *   data: {"type":"command","name":"expression","args":{"mood":"happy"}}
 *   data: {"type":"content","content":"我查到了"}
 *   data: {"type":"done"}
 *
 * ★ 为什么 LLM 的三个参数从**请求体**里来而不是服务端配置：
 *   设置面板在应用里，用户改完当场生效；服务端再存一份，
 *   就会出现"设置里明明改了却没生效"这种最难查的问题。见 config.ts。
 */

import { Router, type Request, type Response } from 'express'
import { resolveLLM, type LLMOverride } from '../config.js'
import {
  builtinToolNames,
  runAgent,
  type ActivitySnapshot,
  type AgentContext,
  type ChatMessage,
} from '../services/agent.js'
import { compactHistory, loadCompaction } from '../services/compaction.js'
import { clearMemory, afterTurn, distillNow, forgetEntry, memoryStatus } from '../services/memory.js'
import { appendTurn, clearTranscript, readRecentTurns } from '../services/transcript.js'
import { getMcpStatus, mcpToolCounts } from '../services/mcp.js'

export const chatRouter = Router()

interface ChatBody {
  messages?: ChatMessage[]
  input?: string
  llm?: LLMOverride
  systemPrompt?: string
  sessionId?: string
  /** 当前前台窗口快照。前端发请求前向 Electron 主进程取一次带上（已过黑名单） */
  activity?: ActivitySnapshot | null
}

chatRouter.post('/chat', async (req: Request, res: Response) => {
  const body = req.body as ChatBody
  const input = (body.input || '').trim()
  if (!input) {
    res.status(400).json({ error: 'input 不能为空' })
    return
  }

  const llm = resolveLLM(body.llm)
  const sessionId = (body.sessionId || 'default').slice(0, 60)
  const history = Array.isArray(body.messages) ? body.messages : []

  /*
   * 长对话先压缩再喂给模型。
   * 放在这里（每次请求的开头）而不是"聊完再压"：聊完那一刻用户已经在等下一句了，
   * 而这里本来就要等模型，压缩的那点延迟是**重叠**掉的。
   */
  let messages = history
  try {
    messages = await compactHistory(history, sessionId, llm)
  } catch (err) {
    console.warn('[chat] 压缩失败，用原历史：', err instanceof Error ? err.message : err)
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const send = (event: unknown): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  // 客户端断开（用户关窗口 / 点打断）时告诉 agent 别再算了
  const abort = new AbortController()
  req.on('close', () => abort.abort())

  const ctx: AgentContext = { commands: [], activity: body.activity ?? null }
  let assistantText = ''

  try {
    let connected = false
    for await (const event of runAgent(messages, input, {
      llm,
      systemPrompt: body.systemPrompt,
      ctx,
      signal: abort.signal,
    })) {
      if (abort.signal.aborted) break
      if (!connected) {
        connected = true
        // 先发一条注释行让前端知道"接上了"（否则首字延迟里界面是死的，没法区分"在想"和"没连上"）
        res.write(': connected\n\n')
      }
      if (event.type === 'content') assistantText += event.content
      send(event)
    }
  } catch (err) {
    send({ type: 'error', error: err instanceof Error ? err.message : String(err) })
  } finally {
    res.end()
  }

  /*
   * 一轮结束之后（这里已经 res.end 了，不占用户等待时间）：
   *   1. **先记账** —— 把这一轮原样写进 jsonl 转录（零 LLM 成本，绝不失败到影响聊天）
   *   2. **到点才整理** —— 每 N 轮读一段转录窗口提炼记忆（见 memory.ts 的 afterTurn）
   *
   * 以前是"每轮问一次模型、只看最近一轮"，既贵又近视；现在这两步分开，
   * 而且转录本身让"以后想用历史做任何事"都有了底料。
   */
  if (assistantText.trim() && !abort.signal.aborted) {
    appendTurn(sessionId, input, assistantText)
    afterTurn(sessionId, llm)
  }
})

/** 她记得什么（含整理状态 —— 界面上要能看见"到底有没有在记"） */
chatRouter.get('/memory', (req, res) => {
  const sessionId = String(req.query.sessionId || 'default').slice(0, 60)
  res.json({
    ...memoryStatus(sessionId),
    summary: loadCompaction(sessionId),
  })
})

/** 「忘掉这条」 */
chatRouter.delete('/memory/:index', (req, res) => {
  const index = Number(req.params.index)
  if (!Number.isInteger(index) || !forgetEntry(index)) {
    res.status(404).json({ error: '没有这一条' })
    return
  }
  res.json({ ok: true, ...memoryStatus() })
})

/** 「立即整理」—— 不想等 4 轮就手动触发一次 */
chatRouter.post('/memory/distill', async (req, res) => {
  const body = req.body as { llm?: LLMOverride; sessionId?: string }
  const sessionId = String(body.sessionId || 'default').slice(0, 60)
  const result = await distillNow(sessionId, resolveLLM(body.llm))
  res.json({ ...result, ...memoryStatus(sessionId) })
})

chatRouter.post('/memory/clear', (req, res) => {
  const sessionId = String((req.body as { sessionId?: string })?.sessionId || 'default').slice(0, 60)
  clearMemory()
  clearTranscript(sessionId)
  res.json({ ok: true, ...memoryStatus(sessionId) })
})

chatRouter.get('/tools', (_req, res) => {
  const mcp = getMcpStatus()
  res.json({
    // 从工具定义里取，不是手写列表 —— 手写的加了工具会忘
    builtin: builtinToolNames(),
    mcp: { ...mcp, counts: mcpToolCounts() },
  })
})

/**
 * 取服务端保存的对话历史。
 *
 * ★ 为什么需要这个接口
 *
 * 前端的对话历史存在 `localStorage`，而 localStorage 是**按 origin 隔离**的：
 * 浏览器（http://localhost:5176）和桌面窗口是两个 origin，各存各的。
 * 于是「浏览器里聊过的，桌面打开看不到」—— 看着像功能没做，其实是存储位置选错了。
 *
 * 转录（jsonl）在服务端，**谁连上来都是同一份**。这里把它暴露出来，
 * 让 UI 有个跨端一致的来源。localStorage 退化成「服务端连不上时的兜底」。
 *
 * 顺带：转录是只追加的，所以它天然就是「全量保留」的那份 ——
 * 而 UI 显示的条数和喂给模型的窗口长度是两件事，这里给的是前者。
 */
chatRouter.get('/history', (req, res) => {
  const sessionId = String(req.query.sessionId || 'default').slice(0, 60)

  // 上限兜一下：转录可能几万行，一次全吐出去会把前端和网络都拖住
  const raw = Number(req.query.turns)
  const turns = Number.isFinite(raw) ? Math.min(500, Math.max(1, Math.trunc(raw))) : 100

  const records = readRecentTurns(sessionId, turns)
  res.json({
    sessionId,
    /** 实际返回了几轮（一问一答算一轮） */
    turns: Math.ceil(records.length / 2),
    messages: records.map((r) => ({ role: r.role, content: r.text })),
  })
})
