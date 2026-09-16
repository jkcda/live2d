/**
 * 联网搜索。
 *
 * 从 `nexus-desktop/server/src/services/webSearch.ts` 搬过来，保留了两级结构：
 * Tavily（要 key，质量好）→ DuckDuckGo 抓 HTML（不要 key，兜底）。
 *
 * 为什么兜底不能省：Tavily 的 key 是"要用户额外去申请"的东西。
 * 一个陪伴型桌宠，"她能不能上网看一眼"不该卡在用户先去注册一个搜索服务上。
 * 所以没有 key 时走 DDG —— 结果糙一点，但"能查"和"不能查"是质变。
 *
 * 查询改写（optimizeQuery）也照搬了：中文口语问句（"今天天气咋样"）
 * 直接丢给搜索引擎命中率很差，去掉语气词、补上时间限定之后好很多。
 * 它不调 LLM，零延迟 —— 这点很重要，搜索本来就要等网络。
 */

import { WEB_SEARCH } from '../config.js'

export interface SearchSource {
  title: string
  url: string
  snippet: string
}

export interface WebSearchResult {
  text: string
  sources: SearchSource[]
}

/** 去掉口气词、补时间限定 —— 中文口语直接搜命中率很低 */
export function optimizeQuery(query: string): string {
  let q = query
    .replace(/[✦◆]/g, '')
    .replace(/请[帮]?我/g, '')
    .trim()

  const timeWords = ['今天', '最新', '最近', '现在', '当前', '今年', '今日', '近日', '近期', '刚刚']
  if (timeWords.some((w) => q.includes(w))) {
    const now = new Date()
    const ym = `${now.getFullYear()}年${now.getMonth() + 1}月`
    if (!q.includes(String(now.getFullYear()))) q = `${ym} ${q}`
  }

  return (
    q
      .replace(/^什么是/, '')
      .replace(/^是谁/, '')
      .replace(/^如何/, '')
      .replace(/^怎么/, '')
      .replace(/[？?！!。，,]$/, '')
      .trim() || query
  )
}

async function searchTavily(query: string): Promise<SearchSource[]> {
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: WEB_SEARCH.tavilyKey,
      query,
      max_results: WEB_SEARCH.maxResults,
      search_depth: 'basic',
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!resp.ok) throw new Error(`Tavily ${resp.status}`)
  const data = (await resp.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> }
  return (data.results || []).slice(0, WEB_SEARCH.maxResults).map((r) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.content || '',
  }))
}

async function searchDuckDuckGo(query: string): Promise<SearchSource[]> {
  const resp = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    signal: AbortSignal.timeout(20_000),
  })
  const html = await resp.text()

  const links: Array<{ url: string; title: string }> = []
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html)) !== null) {
    let url = m[1]
    try {
      url = new URL(m[1], 'https://duckduckgo.com').searchParams.get('uddg') || m[1]
    } catch {
      // 相对链接就用原样
    }
    links.push({ url, title: m[2].replace(/<[^>]+>/g, '').trim() })
  }

  const snippets: string[] = []
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  while ((m = snippetRe.exec(html)) !== null) snippets.push(m[1].replace(/<[^>]+>/g, '').trim())

  return links.slice(0, WEB_SEARCH.maxResults).map((l, i) => ({
    title: l.title,
    url: l.url,
    snippet: snippets[i] || '',
  }))
}

export async function searchWeb(query: string): Promise<WebSearchResult> {
  const empty: WebSearchResult = { text: '', sources: [] }
  if (!WEB_SEARCH.enabled) return empty

  const q = optimizeQuery(query)
  try {
    const results = WEB_SEARCH.tavilyKey ? await searchTavily(q) : await searchDuckDuckGo(q)
    if (!results.length) return empty

    const text =
      `\n--- 以下是刚查到的东西 ---\n` +
      results.map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet}`).join('\n\n') +
      `\n--- 结束 ---\n`

    return { text, sources: results }
  } catch (err) {
    console.warn('[search] 失败：', err instanceof Error ? err.message : err)
    return empty
  }
}
