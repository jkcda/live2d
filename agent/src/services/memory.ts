/**
 * 持久记忆。
 *
 * 结构来自 `nexus-desktop/server/src/services/memory.ts`（用户已有项目的 agent 结构），
 * 针对**陪伴**场景改了两处：
 *
 *   1. 记住的东西不一样。那边是"用户偏好/技术栈/决策"（工作助手），
 *      这边是"关于指挥官这个人的事"：习惯、近况、他说过的话、约定。
 *   2. 多了 `rememberNow()` —— 给模型一个**主动记**的工具。
 *      自动提取（每轮对话后异步跑一次）负责"顺手记住"，
 *      但有些事是"这句话很重要，现在就记下来"，自动提取会漏。
 *
 * 为什么就是一堆 .md 文件、不上向量库：陪伴场景的记忆量是**几十条**级别，
 * 全部塞进 system prompt 完全放得下（实测 20 条约 1.5k token），
 * 而检索的复杂度、embedding 的依赖、召回不准的风险都是净负担。
 * 真到了几百条再说 —— 那时候要换的是存储层，接口就这两个函数。
 */

import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../config.js'
import type { LLMConfig } from '../config.js'
import { chatOnce } from './llm.js'

const MEMORY_DIR = path.join(DATA_DIR, 'memory')

function ensureDir(): void {
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true })
}

/** 记忆文件列表（不带扩展名） */
export function listMemory(): string[] {
  ensureDir()
  return fs
    .readdirSync(MEMORY_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
}

/**
 * 加载全部记忆，拼成一段可以塞进 system prompt 的文本。
 *
 * 空的时候返回空串（而不是"（暂无记忆）"）：调用方会无脑拼接，
 * 编一句"暂无记忆"给模型看纯属噪音。
 */
export function loadMemory(): string {
  ensureDir()
  const files = listMemory()
  if (files.length === 0) return ''

  const parts: string[] = []
  for (const name of files) {
    const content = fs.readFileSync(path.join(MEMORY_DIR, `${name}.md`), 'utf-8').trim()
    if (content) parts.push(`[${name}]\n${content}`)
  }
  if (parts.length === 0) return ''
  return `--- 你记得的事 ---\n${parts.join('\n\n')}\n--- 记忆结束 ---`
}

/** 写入/覆盖一个记忆文件 */
export function saveMemory(name: string, content: string): void {
  ensureDir()
  const safe = name.replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 40) || 'note'
  fs.writeFileSync(path.join(MEMORY_DIR, `${safe}.md`), content.trim(), 'utf-8')
}

/** 清空记忆（设置面板里的「让她忘掉」） */
export function clearMemory(): void {
  ensureDir()
  for (const name of listMemory()) fs.unlinkSync(path.join(MEMORY_DIR, `${name}.md`))
}

const EXTRACT_PROMPT = `你是她的记忆管理器。判断下面这段对话里，有没有**关于指挥官这个人**、值得长期记住的事。

已有记忆：
{existing}

最新对话：
指挥官: {user}
她: {assistant}

判断规则：
- 记住：他的偏好、习惯、作息、近况、在意的人和事、说过的重要的话、两个人的约定
- 不记：临时性的内容（这次问的问题、一次性查询、闲聊客套）
- 不重复：已有的记忆里已经写了就别再写一遍
- 宁缺勿滥：拿不准就不记。记错比记不住更糟 —— 她会用错误的记忆去关心他

有值得记的 → 输出更新后的**完整**记忆（Markdown，分条，每条一行，最多 60 条）
没有 → 只输出 NO_UPDATE
不要输出别的内容：`

/**
 * 异步提取记忆 —— 一轮对话之后跑，**不阻塞回复**。
 *
 * 这是陪伴感的来源之一：下次她开口时，"你还记得我昨天说……"是设计出来的，
 * 靠的就是这里悄悄写下的几行字。
 */
export async function extractMemory(
  userMessage: string,
  assistantReply: string,
  llm: LLMConfig,
): Promise<string | null> {
  if (!llm.apiKey) return null
  try {
    const existing = loadMemory()
    const prompt = EXTRACT_PROMPT.replace('{existing}', existing || '（还没有）')
      .replace('{user}', userMessage.slice(0, 800))
      .replace('{assistant}', assistantReply.slice(0, 800))

    const result = await chatOnce(prompt, llm, 600)
    const text = (result || '').trim()
    if (!text || text === 'NO_UPDATE' || text.length < 10) return null

    saveMemory('user', text)
    console.log(`[memory] 已更新（${text.length} 字）`)
    return text
  } catch (err) {
    // 记忆失败不能影响对话 —— 她是伴侣，不是数据库
    console.warn('[memory] 提取失败：', err instanceof Error ? err.message : err)
    return null
  }
}
