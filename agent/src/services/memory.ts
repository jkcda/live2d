/**
 * 长期记忆：**从转录里定期提炼出来的结构化条目**。
 *
 * 分两层（这是这次重做的核心）：
 *   转录 `data/transcripts/<sid>.jsonl` —— 原始事实，只追加、不调模型（见 transcript.ts）
 *   记忆 `data/memory/user.md`        —— 提炼后的条目，**每行一条**，全量注入 system prompt
 *
 * 为什么从"每轮问一次模型"改成"定期读转录窗口提炼"：
 *   1. **以前只看最近一轮**：他上周反复提过的事，这周就不被看见了 —— 近视。
 *      现在喂的是一段窗口（默认最近 20 轮），能看见"他一直在提什么"。
 *   2. **以前每轮都调模型**：又贵又容易抖，同一件事被反复改写。
 *      现在每 N 轮整理一次（默认 4 轮），平时零成本。
 *   3. **以前失败是静默的**：提取失败只写日志，界面上什么都看不出来 ——
 *      用户看到的就是"记忆好像是假的"。所以现在有 `lastError` / `lastDistillAt`，
 *      状态通过 /memory 暴露到界面上。
 *
 * 为什么是"输出完整列表"而不是"增量追加"：增量会让同一件事攒出七八个版本
 * （"他喜欢猫" / "他养了只猫" / "他家有只橘猫"），而完整列表天然逼着模型做合并。
 *
 * 为什么不上向量库：这个规模（几十条）下，全量注入 system prompt 优于检索 ——
 * 零依赖、零召回错误。到 200~300 条以上再谈检索，第一步也是 SQLite FTS5（标准库自带）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../config.js'
import type { LLMConfig } from '../config.js'
import { chatOnce } from './llm.js'
import { readRecentTurns, transcriptStats } from './transcript.js'

const MEMORY_DIR = path.join(DATA_DIR, 'memory')
const MEMORY_FILE = path.join(MEMORY_DIR, 'user.md')

/** 每几轮整理一次记忆 */
const DISTILL_EVERY_TURNS = Number(process.env.AGENT_DISTILL_EVERY || 4)
/** 每次整理看最近多少轮转录 */
const DISTILL_WINDOW_TURNS = Number(process.env.AGENT_DISTILL_WINDOW || 20)

function ensureDir(): void {
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true })
}

/** 记忆条目（每行一条，去掉 `- ` 前缀） */
export function listEntries(): string[] {
  if (!fs.existsSync(MEMORY_FILE)) return []
  return fs
    .readFileSync(MEMORY_FILE, 'utf-8')
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean)
}

/** 写回条目（统一成 `- xxx` 列表；空数组 = 清空） */
function writeEntries(entries: string[]): void {
  ensureDir()
  const body = entries.map((e) => `- ${e}`).join('\n')
  fs.writeFileSync(MEMORY_FILE, body ? `${body}\n` : '', 'utf-8')
}

/** 拼成可以塞进 system prompt 的那段（空时返回空串，别给模型看"暂无记忆"的噪音） */
export function loadMemory(): string {
  const entries = listEntries()
  if (!entries.length) return ''
  return `--- 你记得的事 ---\n${entries.map((e) => `- ${e}`).join('\n')}\n--- 记忆结束 ---`
}

export function clearMemory(): void {
  if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE)
}

/** 删掉某一条（界面上的"忘掉这条"） */
export function forgetEntry(index: number): boolean {
  const entries = listEntries()
  if (index < 0 || index >= entries.length) return false
  entries.splice(index, 1)
  writeEntries(entries)
  return true
}

/**
 * 当场记一条（`remember` 工具走这条）。
 *
 * 为什么工具和自动整理要并存：整理是"每 4 轮扫一遍"，可能漏掉"这句话很重要"；
 * 他明确说"记住"的时候，当场落笔比等下一轮扫描可靠。
 */
export function rememberEntry(text: string): string {
  const entry = text.replace(/^\s*[-*]\s*/, '').trim()
  if (!entry) return '内容为空，没记。'
  const entries = listEntries()
  if (entries.some((e) => e === entry)) return `已经记过了：${entry}`
  entries.push(entry)
  writeEntries(entries.slice(-60))
  return `记住了：${entry}`
}

// ── 整理状态（界面要能看见"到底有没有在记"） ──

let turnsSinceDistill = 0
let lastDistillAt = 0
let lastError = ''
let distilling = false

export interface MemoryStatus {
  entries: string[]
  lastDistillAt: number
  lastError: string
  turnsSinceDistill: number
  distillEvery: number
  window: number
  transcriptTurns: number
}

export function memoryStatus(sessionId = 'default'): MemoryStatus {
  return {
    entries: listEntries(),
    lastDistillAt,
    lastError,
    turnsSinceDistill,
    distillEvery: DISTILL_EVERY_TURNS,
    window: DISTILL_WINDOW_TURNS,
    transcriptTurns: transcriptStats(sessionId).turns,
  }
}

const DISTILL_PROMPT = `你是她的记忆管理器。下面是两个人最近的对话记录，以及她**现在已经记得**的事。

## 已有记忆
{existing}

## 最近的对话
{dialog}

## 任务
输出**更新后的完整记忆列表**（每行一条，以 "- " 开头）。

规则：
- 只记**关于他这个人**、长期有价值的事：偏好、习惯、作息、近况、在意的人和事、两个人的约定
- 不记：临时的问答、一次性的查询、闲聊客套
- **合并同类**：已有条目被新信息更新了就改写那一条，不要新增重复的
- **保持简短**：一条一句话；时间敏感的事在括号里标月份，例如"（9月）"
- **总数控制在 50 条以内**：重要的先留，过时的直接删掉
- 没有值得记的、且已有记忆也不用改 → 只输出 NO_UPDATE

只输出记忆列表或 NO_UPDATE，不要任何解释：`

/** 现在整理一次：读转录窗口 → 让模型输出完整条目列表 → 落盘 */
export async function distillNow(
  sessionId: string,
  llm: LLMConfig,
): Promise<{ updated: boolean; error?: string }> {
  if (distilling) return { updated: false }
  if (!llm.apiKey) {
    // ★ 这条也要**留下痕迹**：不然界面上还是"什么都没发生"（本次改动的初衷之一）
    lastError = '没有可用的 LLM 配置（检查设置里的接口地址和 key）'
    return { updated: false, error: lastError }
  }

  distilling = true
  try {
    const turns = readRecentTurns(sessionId, DISTILL_WINDOW_TURNS)
    if (!turns.length) return { updated: false }

    const dialog = turns
      .map((t) => `${t.role === 'user' ? '他' : '我'}: ${t.text.slice(0, 300)}`)
      .join('\n')
    const existing = listEntries()
    const prompt = DISTILL_PROMPT.replace(
      '{existing}',
      existing.length ? existing.map((e) => `- ${e}`).join('\n') : '（还没有）',
    ).replace('{dialog}', dialog)

    const out = (await chatOnce(prompt, llm, 900)).trim()
    lastDistillAt = Date.now()
    turnsSinceDistill = 0

    if (!out || out === 'NO_UPDATE') {
      lastError = ''
      return { updated: false }
    }

    const entries = out
      .split('\n')
      .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
      .filter((l) => l && !l.startsWith('#') && l !== 'NO_UPDATE')
      .slice(0, 60)

    if (!entries.length) return { updated: false }

    writeEntries(entries)
    lastError = ''
    console.log(`[memory] 已整理：${entries.length} 条`)
    return { updated: true }
  } catch (err) {
    // ★ 错误要留下来给界面看：以前只 console.warn，用户看到的就是"记忆好像是假的"
    lastError = err instanceof Error ? err.message : String(err)
    console.warn('[memory] 整理失败：', lastError)
    return { updated: false, error: lastError }
  } finally {
    distilling = false
  }
}

/**
 * 一轮对话之后调用：先记账（转录，零成本），到点了才整理。
 * 不阻塞响应 —— 调用方 `void` 掉即可。
 */
export function afterTurn(sessionId: string, llm: LLMConfig): void {
  turnsSinceDistill++
  if (turnsSinceDistill < DISTILL_EVERY_TURNS) return
  void distillNow(sessionId, llm)
}
