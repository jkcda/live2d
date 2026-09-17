/**
 * 诊断：联网搜索到底能不能用。
 *
 * 为什么单独一个脚本：`search_web` 是最容易"看起来正常、其实什么都没查到"的工具 ——
 * 前端能看到 chip（工具被调用了），但结果是空的，模型只能说"没查到"，
 * 用户看到的就是"她明明查了却说不知道"。
 * 这里直接调底层，把每一级的真实结果打出来，不用 LLM、不用 key。
 *
 * 跑：cd agent && pnpm exec tsx scripts/check-search.ts 原神 最新版本
 */

import { optimizeQuery, searchWeb } from '../src/services/search.js'

const query = process.argv.slice(2).join(' ') || '原神 最新版本'

const optimized = optimizeQuery(query)
console.log(`查询：${query}`)
console.log(`改写后：${optimized}`)
console.log(`Tavily key：${process.env.TAVILY_API_KEY ? '有' : '没有（会退回 DuckDuckGo）'}`)
console.log('')

const t0 = Date.now()
const result = await searchWeb(query)
const ms = Date.now() - t0

console.log(`耗时 ${ms}ms｜拿到 ${result.sources.length} 条结果`)
for (const [i, s] of result.sources.entries()) {
  console.log(`  ${i + 1}. ${s.title}`)
  console.log(`     ${s.url}`)
  console.log(`     ${s.snippet.slice(0, 100)}`)
}

if (!result.sources.length) {
  console.log('')
  console.log('❌ 一条都没拿到。可能原因：')
  console.log('   · DuckDuckGo 在这个网络下被墙 / 返回验证码（国内常见）')
  console.log('   · 没配 TAVILY_API_KEY，走的是抓 HTML 的兜底路径')
  console.log('   解决：去 tavily.com 申请免费 key，写进 agent/.env 的 TAVILY_API_KEY')
  process.exitCode = 1
} else {
  console.log('')
  console.log('✅ 搜索可用。如果她还是说"不知道"，那就是结果没回到模型手里（另一条线）')
}
