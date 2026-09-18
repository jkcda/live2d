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
  type ScreenAttachment,
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
  /** 这一轮附上的屏幕截图（同样已在主进程过完黑名单 + 暂停开关） */
  screen?: ScreenAttachment | null
}

/**
 * 校验前端递上来的截图。
 *
 * ★ 为什么服务端还要判一遍格式和体积：
 *   过滤（黑名单）**不能**在这里做 —— 那必须在数据产生的地方做，
 *   事后过滤不算数。但**形状**必须判：这是个 HTTP 接口，谁都能 POST 一个
 *   几 MB 的字符串进来，而它会被塞进模型请求里（体积和费用都跟着走）。
 */
function sanitizeScreen(raw: unknown): ScreenAttachment | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Partial<ScreenAttachment>
  if (typeof s.dataUrl !== 'string') return null
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s.dataUrl)) return null
  // 上限 3MB base64（约 2.2MB 原图）。主进程压到长边 1024 之后是百来 KB
  if (s.dataUrl.length > 3_000_000) return null

  const age = Number(s.ageSeconds)
  return {
    dataUrl: s.dataUrl,
    width: Number.isFinite(Number(s.width)) ? Number(s.width) : 0,
    height: Number.isFinite(Number(s.height)) ? Number(s.height) : 0,
    ageSeconds: Number.isFinite(age) ? Math.max(0, Math.min(600, Math.trunc(age))) : 0,
  }
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
   * 计时。
   *
   * 用户报「文字回复慢得要命」，而这条链路上能拖时间的地方有四处，
   * 光看界面分不出来是哪一处：
   *   ① 请求体多大（带图的话 base64 就有几百 KB）
   *   ② compactHistory（它会调一次 LLM 做摘要 —— 每次请求开头都 await 它）
   *   ③ 模型首 token（外部 API，还有 system prompt / 工具 schema 的 prefill）
   *   ④ 事件在路上的转发
   * 打出来才能知道该修哪个，不然就是瞎猜。
   */
  const t0 = Date.now()
  const screenChars = typeof body.screen?.dataUrl === 'string' ? body.screen.dataUrl.length : 0

  /*
   * 长对话先压缩再喂给模型。
   * 放在这里（每次请求的开头）而不是"聊完再压"：聊完那一刻用户已经在等下一句了，
   * 而这里本来就要等模型，压缩的那点延迟是**重叠**掉的。
   */
  let messages = history
  let compactMs = 0
  try {
    messages = await compactHistory(history, sessionId, llm)
  } catch (err) {
    console.warn('[chat] 压缩失败，用原历史：', err instanceof Error ? err.message : err)
  } finally {
    compactMs = Date.now() - t0
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

  const ctx: AgentContext = {
    commands: [],
    activity: body.activity ?? null,
    screen: sanitizeScreen(body.screen),
  }
  let assistantText = ''

  let firstEventMs = 0
  let firstContentMs = 0
  let eventCount = 0

  try {
    let connected = false
    for await (const event of runAgent(messages, input, {
      llm,
      systemPrompt: body.systemPrompt,
      ctx,
      signal: abort.signal,
    })) {
      if (abort.signal.aborted) break
      eventCount++
      if (!firstEventMs) firstEventMs = Date.now() - t0
      if (event.type === 'content') {
        if (!firstContentMs) firstContentMs = Date.now() - t0
        assistantText += event.content
      }
      if (!connected) {
        connected = true
        // 先发一条注释行让前端知道"接上了"（否则首字延迟里界面是死的，没法区分"在想"和"没连上"）
        res.write(': connected\n\n')
      }
      send(event)
    }
  } catch (err) {
    send({ type: 'error', error: err instanceof Error ? err.message : String(err) })
  } finally {
    res.end()
    /*
     * 一轮的耗时拆解。用户等的是「首正文」那一列 ——
     * 它减去 compactMs 就是模型自己花的时间（含 system prompt + 工具 schema 的 prefill）。
     */
    console.log(
      `[chat] 入 ${input.length} 字｜历史 ${history.length} 条｜图 ${(screenChars / 1024).toFixed(0)}KB` +
        `｜压缩 ${compactMs}ms｜首事件 ${firstEventMs}ms｜首正文 ${firstContentMs}ms` +
        `｜事件 ${eventCount} 个｜总计 ${Date.now() - t0}ms`,
    )
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
