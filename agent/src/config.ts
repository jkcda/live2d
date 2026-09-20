/**
 * 配置。
 *
 * 为什么键从**请求里**也能传：LLM 的 baseURL / key / 模型名在应用里是
 * 设置面板管的（存在 localStorage），前端本来就拿着。让 agent 服务再维护一份
 * 只会出现「设置里改了、服务不知道」这种最难查的不一致。
 * 所以：请求里带了就用请求里的（用户当场配的那套），没带才用这里的 .env。
 *
 * 反过来，**记忆目录、MCP 服务器清单**这类东西属于服务自己的运行环境，
 * 前端管不着，就只放这边。
 */

import 'dotenv/config'
import path from 'node:path'

export interface LLMOverride {
  baseURL?: string
  apiKey?: string
  model?: string
  temperature?: number
}

export interface LLMConfig {
  baseURL: string
  apiKey: string
  model: string
  temperature: number
}

/** agent 服务监听端口。Python 推理服务占了 8765，这里从 8766 起 */
export const PORT = Number(process.env.AGENT_PORT || 8766)

/** 数据目录（记忆 / 摘要）。已在 .gitignore 里，属于运行期数据 */
export const DATA_DIR = path.resolve(process.cwd(), process.env.AGENT_DATA_DIR || 'data')

/** 默认 LLM（请求里没带时用） */
export const DEFAULT_LLM: LLMConfig = {
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1',
  apiKey: process.env.OPENAI_API_KEY || '',
  model: process.env.AGENT_MODEL || 'deepseek-chat',
  temperature: Number(process.env.AGENT_TEMPERATURE || 0.85),
}

/** 联网搜索（Tavily 优先，没有 key 就退回 DuckDuckGo 抓 HTML） */
export const WEB_SEARCH = {
  enabled: process.env.AGENT_WEB_SEARCH !== '0',
  maxResults: Number(process.env.AGENT_SEARCH_RESULTS || 5),
  tavilyKey: process.env.TAVILY_API_KEY || '',
}

/**
 * 文件工作区 —— 她能读写的那个目录。
 *
 *     AGENT_WORKSPACE=D:\我的文档\给她看的东西
 *
 * ★ **不设 = 文件能力整个关闭。**
 *
 * 这是个 opt-in 的能力，不是"默认全盘可读"。判据很简单：
 * 给她文件访问权 = 把「她能碰到你硬盘上什么」交出去了。
 * 屏幕是「此刻这一眼」，文件是「你硬盘上躺着的一切」—— 后者更重。
 *
 * 所以默认什么都不给，要的时候你自己划一块地方出来。
 * 具体的拒绝规则（黑名单 / 符号链接 / 不覆盖已有文件）见 services/files.ts。
 *
 * ★ 它只是**初始值**。设置面板改过的值会落盘到 data/workspace.json 并优先于它 ——
 *   环境变量改不了运行时状态，而设置面板要能当场改。
 */
export const WORKSPACE = (process.env.AGENT_WORKSPACE || '').trim()

/**
 * MCP 服务器清单。
 *
 * 默认带 Playwright —— 「能自己上网看一眼」是陪伴型 agent 最常用的一项能力，
 * 而且它不需要任何 API key。关掉某个就设 AGENT_MCP_DISABLE=playwright。
 */
export interface McpServerConfig {
  name: string
  label: string
  command: string
  args: string[]
}

export const MCP_SERVERS: McpServerConfig[] = [
  {
    name: 'playwright',
    label: 'Playwright 浏览器',
    command: 'npx',
    args: ['-y', '@playwright/mcp'],
  },
]

export const MCP_DISABLED = new Set(
  (process.env.AGENT_MCP_DISABLE || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

/** 合并请求里的覆盖项 */
export function resolveLLM(override?: LLMOverride | null): LLMConfig {
  return {
    baseURL: override?.baseURL || DEFAULT_LLM.baseURL,
    apiKey: override?.apiKey || DEFAULT_LLM.apiKey,
    model: override?.model || DEFAULT_LLM.model,
    temperature: override?.temperature ?? DEFAULT_LLM.temperature,
  }
}
