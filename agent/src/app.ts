/**
 * agent 服务入口。
 *
 * 为什么是一个**独立进程**（而不是塞进 Electron 主进程或渲染进程）：
 *   · 渲染进程里跑不了 —— LangChain + MCP 是 Node 的事，浏览器里没有 fs/子进程；
 *   · Electron 主进程里能跑，但网页版（`pnpm dev:web`）就没有 agent 了，
 *     而且 MCP 子进程崩了会一起带走窗口。
 *   和 Python 推理服务放在同一层（8765 管声音、8766 管脑子），前端只认 HTTP。
 *
 * 接口：
 *   GET  /health   探活 + 模型/工具/MCP 状态
 *   GET  /tools    有哪些工具（设置面板里给她看）
 *   POST /chat     SSE 流：content / tool_call / tool_result / command / done / error
 *   GET  /memory   她记得什么
 *   POST /memory/clear  让她忘掉
 */

import express from 'express'
import cors from 'cors'
import { PORT } from './config.js'
import { chatRouter } from './routes/chat.js'
import { initMcp, closeMcp, getMcpStatus } from './services/mcp.js'
import { listEntries } from './services/memory.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.get('/health', (_req, res) => {
  // 立刻返回：MCP 是后台连的，绝不能让它把探活接口挂住（踩过这个坑）
  res.json({
    ok: true,
    service: 'nexus-agent',
    port: PORT,
    mcp: getMcpStatus(),
    memoryFiles: listEntries().length,
  })
})

app.use(chatRouter)

app.use((_req, res) => res.status(404).json({ error: 'not found' }))

const server = app.listen(PORT, () => {
  console.log(`\n  agent 服务已启动：http://127.0.0.1:${PORT}`)
  console.log(`  · POST /chat   SSE 对话（工具 / MCP / 记忆都在这条路上）`)
  console.log(`  · GET  /health 状态   GET /memory 她记得什么\n`)
  // MCP 连接放后台：npx 首次要下包，别让服务启动卡在这儿
  void initMcp()
})

async function shutdown(): Promise<void> {
  console.log('\n关闭中…')
  await closeMcp()
  server.close(() => process.exit(0))
  // 兜底：3 秒还没退就强退（MCP 子进程偶尔不肯走）
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
