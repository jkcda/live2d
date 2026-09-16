/**
 * 历史压缩（渐进式）。
 *
 * 结构来自 `nexus-desktop/server/src/services/compaction.ts`，把"代码变更"那类
 * 工作助手的摘要分类换成了陪伴场景的分类（近况/承诺/偏好/约定）。
 *
 * 为什么需要它：陪伴是要**长期**的 —— 聊了三个月之后，历史不可能全带上。
 * 策略保持人家那套（好用）：
 *   1. 消息数 ≤ 60 → 原样保留，不压缩（压缩本身也是一次 LLM 调用，白花钱）
 *   2. 超过 → 旧消息压成结构化摘要，最近 30 轮保留原文
 *   3. 摘要会随对话推进**合并更新**（不是每次重写，旧的先给它看）
 *
 * 为什么摘要要落盘：进程重启之后还得在。她是"记得上次聊到哪"的那种存在，
 * 而这份摘要是记忆之外的第二层上下文。
 */

import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../config.js'
import type { LLMConfig } from '../config.js'
import { chatOnce } from './llm.js'

const COMPACTION_DIR = path.join(DATA_DIR, 'compaction')

export interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 超过这个轮数（1 轮 = user + assistant）才开始压缩 */
const COMPACT_AFTER_ROUNDS = 30

function ensureDir(): void {
  if (!fs.existsSync(COMPACTION_DIR)) fs.mkdirSync(COMPACTION_DIR, { recursive: true })
}

function compactionFile(sessionId: string): string {
  const safe = sessionId.replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 60) || 'default'
  return path.join(COMPACTION_DIR, `${safe}.md`)
}

export function loadCompaction(sessionId: string): string {
  const file = compactionFile(sessionId)
  if (!fs.existsSync(file)) return ''
  return fs.readFileSync(file, 'utf-8').trim()
}

function saveCompaction(sessionId: string, summary: string): void {
  ensureDir()
  fs.writeFileSync(compactionFile(sessionId), summary, 'utf-8')
}

export function deleteCompaction(sessionId: string): void {
  const file = compactionFile(sessionId)
  if (fs.existsSync(file)) fs.unlinkSync(file)
}

const SECTIONS = `### 他的近况
- 他最近在忙什么、心情怎么样、有什么变化

### 两个人的约定
- 说好要做的、要提醒的、要一起看的东西

### 他喜欢什么
- 称呼、说话方式、口味、习惯、不喜欢的东西

### 聊到哪了
- 最近在聊的话题、没说完的事`

const COMPRESS_PROMPT = `把下面这段对话压缩成结构化摘要，给"她"自己以后看（她是他的桌面伴侣）。

## 输出格式（严格遵循）
${SECTIONS}

## 规则
- 只留对以后聊天有用的
- 去掉寒暄、重复、一次性问答
- 每类最多 5 条，多的挑最重要的
- 某类没内容就省略这一类

## 对话内容
{dialog}`

const MERGE_PROMPT = `把「已有摘要」和「新增对话」合并成一份完整摘要。

## 已有摘要
{old}

## 新增对话
{dialog}

## 输出格式（严格遵循）
${SECTIONS}

## 规则
- 合并去重，新信息优先（旧的被新信息推翻就删掉）
- 每类最多 5 条
- 某类没内容就省略这一类`

/**
 * 需要时压缩历史。返回可以直接发给模型的消息数组。
 *
 * 压缩失败时**退化为截断**（保留最近的部分）而不是抛错：
 * 摘要是优化，聊不下去才是事故。
 */
export async function compactHistory(
  messages: HistoryMessage[],
  sessionId: string,
  llm: LLMConfig,
  recentRounds = COMPACT_AFTER_ROUNDS,
): Promise<HistoryMessage[]> {
  if (messages.length === 0) return messages

  const keepCount = recentRounds * 2
  if (messages.length <= keepCount) return messages

  const recent = messages.slice(-keepCount)
  const older = messages.slice(0, -keepCount)
  if (older.length === 0) return messages

  const dialog = older
    .map((m) => `${m.role === 'user' ? '他' : '我'}: ${m.content.slice(0, 300)}`)
    .join('\n')

  try {
    const old = loadCompaction(sessionId)
    const prompt = old
      ? MERGE_PROMPT.replace('{old}', old).replace('{dialog}', dialog)
      : COMPRESS_PROMPT.replace('{dialog}', dialog)

    const summary = (await chatOnce(prompt, llm, 800)).trim()
    if (summary) {
      saveCompaction(sessionId, summary)
      console.log(`[compaction] ${sessionId}: ${messages.length} 条 → 摘要 + 最近 ${recent.length} 条`)
      return [{ role: 'user', content: `[之前聊过的（摘要）]\n${summary}` }, ...recent]
    }
  } catch (err) {
    console.warn('[compaction] 压缩失败，退化为截断：', err instanceof Error ? err.message : err)
  }

  return recent
}
