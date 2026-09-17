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

/** 去掉口气词、问句壳子 —— 中文口语直接搜命中率很低 */
export function optimizeQuery(query: string): string {
  const q = query
    .replace(/[✦◆]/g, '')
    .replace(/请[帮]?我/g, '')
    .trim()

  /*
   * ★ 这里**故意不做**"给带时间词的查询加当前年月前缀"。
   *
   * 那是我从 nexus 的 webSearch.ts 搬来的，但在实测里它是**有害**的：
   * 查「原神 最新版本」被改写成「2026年9月 原神 最新版本」，
   * Bing 于是返回一堆「2026年日历/放假安排」——年份把查询带偏了。
   * 时间限定对"新闻/价格"确实有用，但判断该不该加需要语义理解，
   * 靠一个"句子里有没有'最新'"的正则做不到 —— 结果就是帮倒忙。
   * 宁可让搜索引擎自己理解，也不要加错限定。
   */
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

/**
 * Bing 抓 HTML —— 国内可用的兜底。
 *
 * ★ 为什么要它：DuckDuckGo 在国内**直接连不上**（实测 fetch failed，10 秒超时、0 条），
 *   而 Tavily 要用户先去注册一个 key —— 一个陪伴型桌宠，"她能不能上网"
 *   不该卡在"先去注册一个搜索服务"上。cn.bing.com 国内可达，且不需要 key。
 */
async function searchBing(query: string): Promise<SearchSource[]> {
  const resp = await fetch(`https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(15_000),
  })
  const html = await resp.text()

  // 结果块：<li class="b_algo"><h2><a href="URL">标题</a></h2> … <p>摘要</p>
  const clean = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim()
  const out: SearchSource[] = []
  for (const block of html.split(/<li class="b_algo"/).slice(1)) {
    const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!link) continue
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)
    out.push({ title: clean(link[2]), url: link[1], snippet: snippet ? clean(snippet[1]) : '' })
    if (out.length >= WEB_SEARCH.maxResults) break
  }
  return out
}

export async function searchWeb(query: string): Promise<WebSearchResult> {
  const empty: WebSearchResult = { text: '', sources: [] }
  if (!WEB_SEARCH.enabled) return empty

  const q = optimizeQuery(query)
  /*
   * 三级兜底，按"用户要付多少代价"排：
   *   Tavily（要 key，最准）→ Bing 抓 HTML（国内可达，不要 key）→ DuckDuckGo（国外可用）
   * 前一级失败或空结果就试下一级 —— 任何一级挂掉都不该让"联网"这个能力整体消失。
   */
  const attempts: Array<[string, () => Promise<SearchSource[]>]> = []
  if (WEB_SEARCH.tavilyKey) attempts.push(['Tavily', () => searchTavily(q)])
  attempts.push(['Bing', () => searchBing(q)], ['DuckDuckGo', () => searchDuckDuckGo(q)])

  for (const [name, run] of attempts) {
    try {
      const results = await run()
      if (!results.length) {
        console.log(`[search] ${name} 没有结果，试下一个`)
        continue
      }
      const text =
        `\n--- 以下是刚查到的东西（来源：${name}）---\n` +
        results.map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet}`).join('\n\n') +
        `\n--- 结束 ---\n`
      console.log(`[search] ${name} 拿到 ${results.length} 条`)
      return { text, sources: results }
    } catch (err) {
      console.warn(`[search] ${name} 失败：`, err instanceof Error ? err.message : err)
    }
  }
  return empty
}
