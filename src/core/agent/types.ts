/**
 * Agent 层公共类型。
 *
 * 事件协议刻意与 NEXUS 的 SSE 工具事件保持一致
 * （tool_call / tool_result 的字段名相同），方便直接复用那边的渲染逻辑。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type AgentEvent =
  /** 文本增量 */
  | { type: 'delta'; content: string }
  /** 工具开始调用 */
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  /** 工具返回结果 */
  | { type: 'tool_result'; tool: string; result: string }
  /** 本轮结束 */
  | { type: 'done' }
  /** 出错 */
  | { type: 'error'; message: string }

export interface LLMConfig {
  /** OpenAI 兼容接口的 base URL，例如 https://api.deepseek.com/v1 */
  baseURL: string
  apiKey: string
  model: string
  /** 采样温度，角色扮演建议 0.8~1.0 */
  temperature?: number
  /** 单次回复的最大 token 数 */
  maxTokens?: number
}
