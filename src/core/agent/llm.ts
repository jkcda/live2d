/**
 * LLM 流式客户端（OpenAI 兼容接口）。
 *
 * 只做一件事：把 SSE 流解析成 AgentEvent 序列。
 * 编排（人设、记忆、工具）由上层负责，这里不掺业务逻辑。
 */
import type { AgentEvent, ChatMessage, LLMConfig } from './types'

function endpoint(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/chat/completions`
}

/**
 * 发起流式对话。
 *
 * @param messages 完整消息数组（含 system）
 * @param cfg      接口配置
 * @param signal   传入 AbortSignal 即可打断
 */
export async function* streamChat(
  messages: ChatMessage[],
  cfg: LLMConfig,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  let resp: Response
  try {
    resp = await fetch(endpoint(cfg.baseURL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        stream: true,
        temperature: cfg.temperature ?? 0.85,
        ...(cfg.maxTokens ? { max_tokens: cfg.maxTokens } : {}),
      }),
      signal,
    })
  } catch (err) {
    // AbortError 是正常打断，不当错误上报
    if (err instanceof DOMException && err.name === 'AbortError') return
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
    return
  }

  if (!resp.ok || !resp.body) {
    const detail = await resp.text().catch(() => '')
    yield { type: 'error', message: `HTTP ${resp.status} ${resp.statusText} ${detail.slice(0, 200)}` }
    return
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // SSE 以空行分隔事件，但增量到达时可能切断行 —— 只处理完整的行
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) continue

        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') {
          yield { type: 'done' }
          return
        }

        try {
          const json = JSON.parse(payload)
          const delta: unknown = json?.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta.length > 0) {
            yield { type: 'delta', content: delta }
          }
        } catch {
          // 无法解析的行（keep-alive、注释等）直接跳过
        }
      }
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
    return
  }

  yield { type: 'done' }
}

/**
 * 把 LLM 的文本增量按标点切成句。
 *
 * 这是流式 TTS 的关键：不等整段回复生成完，凑够一句就送去合成，
 * 否则首包延迟会翻好几倍。
 */
/**
 * 一次合成最多多少字。超过就切一刀。
 *
 * ★ 这个值**取决于引擎有多快**，不是固定的
 *
 * 实测（同一台机器）：
 *
 *   引擎               RTF      首块
 *   云端 siliconflow   0.14     0.4~0.9s   几乎不随长度恶化
 *   本地 cosyvoice     1.00~1.86（10 字→20 字）  随长度明显恶化
 *
 * RTF > 1 意味着**合成比播放慢**，播放迟早追上合成、中间必须停一下。
 * 而**这个「停」落在哪里，决定你听到什么**：
 *
 *   · 停在句号处 → 听起来是换气，自然
 *   · 停在句子中间 → 「快说出来了突然停一下」，明显是卡
 *
 * 所以：
 *   · **快的引擎（RTF < 1）**：整段合成。它根本不会停，而且整段语气连贯
 *   · **慢的引擎（RTF > 1）**：切短。让停顿时常落在句号处，听起来是换气
 *
 * 默认 150（整段）。`setSplitMaxChars()` 会在探测到引擎后改掉它 —— 见 tts.ts。
 */
let splitMaxChars = 150

/**
 * 按引擎速度调整切分粒度。
 *
 * 为什么是模块级的可变值：切分发生在 agent 层（这里），而**引擎信息在音频层**
 * （要问服务端 /health 才知道）。让 agent 层去查 HTTP 是把依赖倒过来了。
 * 这个值全应用只有一份，用一个模块级的设置函数最省事。
 */
export function setSplitMaxChars(n: number): void {
  splitMaxChars = Math.max(20, Math.min(400, Math.round(n)))
}

export function getSplitMaxChars(): number {
  return splitMaxChars
}

export function createSentenceSplitter() {
  let pending = ''

  return {
    /**
     * 喂入增量。**只在超过上界时才返回内容**，否则一直攒着 ——
     * 真正的整段提交发生在 `flush()`。
     */
    push(chunk: string): string[] {
      pending += chunk
      if (pending.length < splitMaxChars) return []

      /*
       * 到上界了，切一刀。
       *
       * 优先切在**最后一个句末标点**处 —— 那是最自然的断点，
       * 比在字中间硬切好听得多。找不到标点才硬切。
       */
      const cut = lastBoundaryIn(pending)
      const head = pending.slice(0, cut).trim()
      pending = pending.slice(cut)

      return head ? [head] : []
    },

    /** 流结束时取出**全部**残留文本 —— 这就是「整段」的落点 */
    flush(): string {
      const rest = pending.trim()
      pending = ''
      return rest
    },
  }
}

/** 找出这段文本里最后一个句末标点的**位置之后**（用作切点）；没有就返回整段长度 */
function lastBoundaryIn(text: string): number {
  // 中文句末标点 + 英文句末标点 + 换行
  const re = /[。！？；\n!?;]/g
  let last = -1
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) last = m.index + m[0].length

  // 找不到标点、或者断点太靠前（切完剩一大截没意义）就整段切走
  if (last < text.length * 0.5) return text.length
  return last
}
