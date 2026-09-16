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
export function createSentenceSplitter() {
  let pending = ''

  return {
    /** 喂入增量，返回本次可以送去合成的完整句子（可能为空数组） */
    push(chunk: string): string[] {
      pending += chunk
      const out: string[] = []

      // 中文句末标点 + 英文句末标点 + 换行
      const boundary = /[。！？；\n!?;]+/g
      let lastIndex = 0
      let match: RegExpExecArray | null

      while ((match = boundary.exec(pending)) !== null) {
        const end = match.index + match[0].length
        const sentence = pending.slice(lastIndex, end).trim()
        if (sentence) out.push(sentence)
        lastIndex = end
      }

      pending = pending.slice(lastIndex)

      // 兜底：单句过长（模型不吐标点）时强切，避免一直不发声
      if (pending.length >= 60) {
        out.push(pending.trim())
        pending = ''
      }

      return out
    },

    /** 流结束时取出残留文本 */
    flush(): string {
      const rest = pending.trim()
      pending = ''
      return rest
    },
  }
}
