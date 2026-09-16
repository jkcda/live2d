/**
 * LLM 客户端。
 *
 * 两件事：
 *   1. `createModel()` —— 给 LangChain agent 用的对话模型（支持工具调用）
 *   2. `chatOnce()`    —— 单次纯文本调用（记忆提取、历史压缩这类内部活儿）
 *
 * 为什么不用项目里原有的 provider Manager（`nexus-desktop/server/src/providers/Manager.ts`）：
 * 那一套是为了"多供应商可切换 + 设置面板管理"设计的，接口面很大；
 * live2d 这边只需要"一个 OpenAI 兼容端点"（设置面板里配的那套），
 * 搬过来反而多一层。真要多供应商时，换的就是这个文件里的 createModel。
 */

import { ChatOpenAI } from '@langchain/openai'
import type { LLMConfig } from '../config.js'

/** 对话模型（agent 用，必须支持 function calling） */
export function createModel(cfg: LLMConfig) {
  return new ChatOpenAI({
    model: cfg.model,
    temperature: cfg.temperature,
    apiKey: cfg.apiKey || 'not-needed',
    configuration: { baseURL: cfg.baseURL },
    // 流式是硬要求：她的口型和语音都建立在"边说边出"上
    streaming: true,
  })
}

/**
 * 单次纯文本调用（不带工具、不流式）。
 *
 * 直接用 fetch 而不是走 LangChain：这两处调用（记忆提取、历史压缩）
 * 只需要"提示词进去、文本出来"，LangChain 的消息类型转换在这里是纯开销，
 * 而且少一层就能少一处版本升级带来的意外。
 */
export async function chatOnce(prompt: string, cfg: LLMConfig, maxTokens = 600): Promise<string> {
  const url = `${cfg.baseURL.replace(/\/+$/, '')}/chat/completions`
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.3,
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status} ${detail.slice(0, 160)}`)
  }

  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return data.choices?.[0]?.message?.content ?? ''
}
