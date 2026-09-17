/**
 * 假的 OpenAI 兼容端点 —— 用来验证「她真的看得到」这条链。
 *
 * 为什么需要它：验证"图有没有送到模型"必须能看到**模型收到的那个请求**，
 * 而真模型（用户自己的 key）既不该被验证脚本用，也看不到它收到了什么。
 * 这里就摆一个假端点：把请求体原样记下来（`GET /_last` 取回），
 * 然后回一句固定的流式回答。
 *
 * 用法（一般由 tools/verify-see.mjs 自动启动）：
 *   node tools/stub-llm.mjs 8799
 */
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] || 8799)
const REPLY = '我看到了，你在跟验证脚本打交道。'

/** 最近的请求体。验证脚本靠它断言"模型到底收到了什么" */
const requests = []
const MAX_KEPT = 20

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/_last') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(requests[requests.length - 1] ?? null))
    return
  }
  /*
   * ★ 为什么要留一整串，而不是只留最后一条
   *
   * agent 除了对话，还会**在后台**调模型（记忆整理、历史压缩用的是同一个
   * LLM 配置）。只留最后一条的话，验证脚本很可能拿到那条后台请求 ——
   * 表现是"图没送到"，其实只是看错了请求（第一次跑就撞上了）。
   */
  if (req.method === 'GET' && req.url === '/_all') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(requests))
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(404)
    res.end()
    return
  }

  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    try {
      requests.push(JSON.parse(body))
    } catch {
      requests.push({ parseError: true, head: body.slice(0, 300) })
    }
    if (requests.length > MAX_KEPT) requests.splice(0, requests.length - MAX_KEPT)

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const chunk = (delta, finish = null) =>
      `data: ${JSON.stringify({
        id: 'stub',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'stub',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`

    res.write(chunk({ role: 'assistant', content: '' }))
    res.write(chunk({ content: REPLY }))
    res.write(chunk({}, 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

server.listen(PORT, '127.0.0.1', () => console.log(`[stub-llm] 127.0.0.1:${PORT} 就绪`))
