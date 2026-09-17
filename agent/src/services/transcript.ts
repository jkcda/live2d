/**
 * 对话转录（jsonl，只追加）。
 *
 * 为什么先做这一层：它是所有记忆能力的**底料**，而且**零 LLM 成本、零依赖**。
 *   以前记忆只从"最近一轮"提炼 —— 聊得越久越近视：上周他反复提过的事，
 *   这周就不再被看见了，因为提炼时只喂了当前这一问一答。
 *   有了转录，"每隔几轮读一段窗口来提炼"才成立（见 memory.ts 的 distillNow）。
 *
 * 格式：一行一个 JSON，不重写、不整理、不删改。
 *   {"t":"2026-09-17T11:20:03Z","role":"user","text":"…","sid":"default"}
 *
 * 为什么是 jsonl 而不是 SQLite：写入是"追加一行"，崩在半路也只会坏最后一行；
 * 而且用肉眼就能看、grep 就能查、cat 就能读 —— 出问题时排查成本极低。
 * 真到了几万行需要按关键词捞，再上 SQLite FTS5（那是**标准库自带**的，不是向量库）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../config.js'

const TRANSCRIPT_DIR = path.join(DATA_DIR, 'transcripts')

export interface TurnRecord {
  /** ISO 时间 */
  t: string
  role: 'user' | 'assistant'
  text: string
  /** 会话 id（将来多角色/多会话时用来分开） */
  sid: string
}

function ensureDir(): void {
  if (!fs.existsSync(TRANSCRIPT_DIR)) fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true })
}

function fileOf(sessionId: string): string {
  const safe = sessionId.replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 60) || 'default'
  return path.join(TRANSCRIPT_DIR, `${safe}.jsonl`)
}

/** 追加一轮（user + assistant）。任何异常都吞掉 —— 转录失败不能影响聊天 */
export function appendTurn(sessionId: string, user: string, assistant: string): void {
  try {
    ensureDir()
    const t = new Date().toISOString()
    const lines = [
      JSON.stringify({ t, role: 'user', text: user, sid: sessionId } satisfies TurnRecord),
      JSON.stringify({ t, role: 'assistant', text: assistant, sid: sessionId } satisfies TurnRecord),
    ].join('\n')
    fs.appendFileSync(fileOf(sessionId), `${lines}\n`, 'utf-8')
  } catch (err) {
    console.warn('[transcript] 写入失败：', err instanceof Error ? err.message : err)
  }
}

/** 读最近 n 轮（含双方），按时间正序返回 —— 提炼记忆时喂给模型的就是它 */
export function readRecentTurns(sessionId: string, turns: number): TurnRecord[] {
  const file = fileOf(sessionId)
  if (!fs.existsSync(file)) return []
  try {
    const all = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as TurnRecord
        } catch {
          return null // 崩在半路的那一行就跳过，不要因为它把整个转录判死
        }
      })
      .filter((r): r is TurnRecord => Boolean(r?.text))
    return all.slice(-turns * 2)
  } catch (err) {
    console.warn('[transcript] 读取失败：', err instanceof Error ? err.message : err)
    return []
  }
}

/** 转录统计（界面上显示"聊了多少"用） */
export function transcriptStats(sessionId: string): { turns: number; bytes: number } {
  const file = fileOf(sessionId)
  if (!fs.existsSync(file)) return { turns: 0, bytes: 0 }
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    return {
      turns: Math.floor(raw.split('\n').filter(Boolean).length / 2),
      bytes: Buffer.byteLength(raw, 'utf-8'),
    }
  } catch {
    return { turns: 0, bytes: 0 }
  }
}

/** 清空转录（用户要"忘记一切"时） */
export function clearTranscript(sessionId: string): void {
  const file = fileOf(sessionId)
  if (fs.existsSync(file)) fs.unlinkSync(file)
}
