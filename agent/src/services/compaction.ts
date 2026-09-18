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
/**
 * 压缩的触发条件是「**快到上下文上限**」，不是「聊了多少条」。
 *
 * 这两件事在现代模型上差得很远：128k 窗口装得下几千条对话，
 * 而按条数触发（原来是 60 条 ≈ 5k token，离上限差 25 倍）等于
 * 每聊几轮就白花一次摘要的 LLM 调用，还把本来能看见的上下文丢掉了。
 *
 * 用户的原话：「现在 ai 都 1m 上下文了，一般是快到上下文上限才压缩出摘要吧」。
 * 按条数触发是**用旧时代的约束做今天的决定**。
 */
const CONTEXT_WINDOW_TOKENS = 128_000

/** 用到窗口的这个比例才开始压缩（留出回复本身的空间） */
const COMPACT_AT_RATIO = 0.6

/** 压缩后保留最近这么多 token 的原文 —— 摘要替掉的是更早的那些 */
const KEEP_TOKENS = 32_000

/**
 * 粗估 token 数。
 *
 * 故意不引 tokenizer：中文约 1 字 1 token、英文约 4 字符 1 token，
 * 这里统一按 **每字符 0.75 token** 估。
 * 估大了只是早点压缩（浪费一点），估小了才会撑爆上下文 —— 所以取保守的。
 */
function estimateTokens(messages: HistoryMessage[]): number {
  let chars = 0
  for (const m of messages) chars += m.content.length
  return Math.ceil(chars * 0.75)
}

/** 从后往前取，攒够 keepTokens 就停 */
function recentWithin(messages: HistoryMessage[], keepTokens: number): HistoryMessage[] {
  let used = 0
  let i = messages.length
  while (i > 0) {
    const len = messages[i - 1].content.length
    if (used + len > keepTokens && i < messages.length) break
    used += len
    i--
  }
  return messages.slice(i)
}

/** 该不该压缩 —— 按 token 估，不按条数 */
function needsCompaction(messages: HistoryMessage[]): boolean {
  return estimateTokens(messages) > CONTEXT_WINDOW_TOKENS * COMPACT_AT_RATIO
}

/**
 * 只用**已有的**摘要裁剪历史 —— 不调模型，快到可以放在请求路径上。
 *
 * ★ 为什么要把「应用」和「生成」拆开
 *
 * `compactHistory` 内部要调一次 LLM 生成摘要，**实测能到 47.7 秒**。
 * 它原来是在请求路径上 `await` 的 —— 用户每问一句，都要先等一次摘要生成。
 * 实测一轮 60 秒里 **48 秒**花在这儿，而模型自己只花了 11 秒。
 *
 * 摘要是**优化**，不是回复的前提：这一轮先用上次的摘要（或者干脆不裁），
 * 摘要本身放到回复发完之后慢慢算。
 *
 * 没到该压缩的程度、或者还没有摘要时，**原样返回** ——
 * 多花点 token 比让用户等 47 秒强。
 */
export function applyCompaction(
  messages: HistoryMessage[],
  sessionId: string,
): HistoryMessage[] {
  if (messages.length === 0) return messages
  if (!needsCompaction(messages)) return messages

  const summary = loadCompaction(sessionId)
  if (!summary) return messages

  return [
    { role: 'user', content: `[之前聊过的（摘要）]\n${summary}` },
    ...recentWithin(messages, KEEP_TOKENS),
  ]
}

export async function compactHistory(
  messages: HistoryMessage[],
  sessionId: string,
  llm: LLMConfig,
): Promise<HistoryMessage[]> {
  if (messages.length === 0) return messages
  if (!needsCompaction(messages)) return messages

  const recent = recentWithin(messages, KEEP_TOKENS)
  const older = messages.slice(0, messages.length - recent.length)
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
