/**
 * MCP 客户端。
 *
 * 结构借自 `nexus-desktop/server/src/services/mcp.ts`（用户已有项目的 agent 结构）——
 * 这块本来就与场景无关：挂上什么 MCP 服务器，她就多什么能力。
 *
 * ★ 但有一处我改成了**不阻塞**，因为照搬会踩坑（实测踩到了）：
 *   原来 `getMcpStatus()` 里 `await client.getTools()`，而 MCP 服务器是
 *   `npx -y @playwright/mcp` —— **首次运行要先下载整个包**（几十秒到几分钟）。
 *   于是 `/health` 跟着一起挂住：一个"探活"接口卡在 MCP 下载上，
 *   前端会以为整个 agent 服务没起来，而实际上它只是浏览器工具还没就绪。
 *
 * 所以现在的模型是：连接与取工具在**后台**进行，状态是一个可读的枚举；
 * 任何人问状态都立刻拿到（不 await）。工具没就绪的那几轮对话就是"没有浏览器工具"，
 * 不影响说话 —— 能力扩展的死活不该影响核心功能。
 */

import { MultiServerMCPClient } from '@langchain/mcp-adapters'
import { MCP_DISABLED, MCP_SERVERS } from '../config.js'

export type McpState = 'idle' | 'connecting' | 'ready' | 'failed'

let client: MultiServerMCPClient | null = null
let tools: unknown[] = []
let state: McpState = 'idle'
let detail = ''
let started = false
const disabled = new Set(MCP_DISABLED)

/** 后台连接。重复调用无副作用。 */
export function initMcp(): void {
  if (started) return
  started = true

  const enabled = MCP_SERVERS.filter((s) => !disabled.has(s.name))
  if (enabled.length === 0) {
    state = 'ready'
    detail = '没有启用的 MCP 服务器'
    console.log('[mcp] 没有启用的 MCP 服务器')
    return
  }

  client = new MultiServerMCPClient({
    throwOnLoadError: false, // 一个 server 起不来不能拖死整个 agent
    prefixToolNameWithServerName: true, // 工具会重名（多个 server 都有 click）
    mcpServers: Object.fromEntries(
      enabled.map((s) => [s.name, { transport: 'stdio' as const, command: s.command, args: s.args }]),
    ),
  })

  state = 'connecting'
  detail = `正在连接 ${enabled.map((s) => s.name).join(', ')}（首次可能要下包，慢）`
  console.log(`[mcp] ${detail}`)

  void (async () => {
    try {
      await client!.initializeConnections()
      tools = await client!.getTools()
      state = 'ready'
      detail = `已连接，工具 ${tools.length} 个`
      console.log(`[mcp] ${detail}`)
    } catch (err) {
      // 失败不清空 client：下次 /health 还能看到状态，用户知道该去修什么
      state = 'failed'
      detail = err instanceof Error ? err.message : String(err)
      console.warn('[mcp] 连接失败：', detail)
    }
  })()
}

/**
 * 取 MCP 工具。**同步、不等待** —— 没就绪就返回空数组。
 * agent 每轮都会调它，绝不能让它挂住一次对话。
 */
export function getMcpTools(): unknown[] {
  return state === 'ready' ? tools : []
}

export interface McpStatus {
  state: McpState
  detail: string
  toolCount: number
  servers: Array<{ name: string; label: string; enabled: boolean }>
}

/** 立刻返回的状态（不 await 任何东西） */
export function getMcpStatus(): McpStatus {
  return {
    state,
    detail,
    toolCount: tools.length,
    servers: MCP_SERVERS.map((s) => ({
      name: s.name,
      label: s.label,
      enabled: !disabled.has(s.name),
    })),
  }
}

/** 每个 server 各贡献了多少工具（工具名形如 `playwright__browser_click`） */
export function mcpToolCounts(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const t of tools) {
    const server = String((t as { name?: string }).name || '').split('__')[0] || 'unknown'
    counts[server] = (counts[server] || 0) + 1
  }
  return counts
}

export async function closeMcp(): Promise<void> {
  if (!client) return
  try {
    await client.close()
  } catch {
    // 关不掉就算了 —— 进程要退出了
  }
  client = null
  tools = []
  state = 'idle'
}
