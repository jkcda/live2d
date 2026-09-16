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
  /**
   * 让界面做一件事（不是文本）。
   *
   * 现在只有一条：`expression` —— 她说话时的情绪要**落到脸上**。
   * 为什么走事件而不是让模型直接调前端函数：模型跑在 agent 服务里，
   * 它只能通过这条流把意图带回来，由上层决定怎么执行。
   */
  | { type: 'command'; name: string; args: Record<string, unknown> }
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
