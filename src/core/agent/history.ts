/**
 * 对话历史的持久化。
 *
 * 为什么需要它：`ChatSession` 里本来就有 `toJSON()` / `load()`，
 * 但**全项目没有一处调用它们** —— 结果就是刷新一下页面，聊过的东西全没了。
 * 用户的原话是"每次打开对话都是最新的（空的）"，而"她记得我们聊过什么"
 * 是陪伴最基础的一层（比长期记忆更基础：连本次会话都留不住，谈什么记住上周）。
 *
 * 存哪：localStorage。
 *   · 会话历史本来就有上限（`ChatSession.maxHistory = 40` 条），几十 KB，
 *     离 localStorage 的 5MB 差得远；
 *   · 更长远要看的是**服务端 jsonl 转录**（agent 的记忆系统要从完整转录里提炼），
 *     但那是另一件事：这里先解决"打开就有"这个最直接的痛点。
 *
 * 坏了怎么办：读不出来（格式变了、被手改坏了）就当没有，绝不能让一段坏数据
 * 把"能不能聊天"这件事拖下水。
 */

import type { ChatMessage } from './types'

const KEY = 'nexus.chat.history'

/** 只持久化能恢复对话的最小结构（role + content），不带 system */
export function loadHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (m): m is ChatMessage =>
          Boolean(m) &&
          typeof (m as ChatMessage).content === 'string' &&
          ((m as ChatMessage).role === 'user' || (m as ChatMessage).role === 'assistant'),
      )
      .map((m) => ({ role: m.role, content: m.content }))
  } catch (err) {
    console.warn('[history] 读取失败，当作没有历史', err)
    return []
  }
}

export function saveHistory(messages: readonly ChatMessage[]): void {
  try {
    // system 不入库：它由人设和角色包决定，存下来反而会在改人设后变成旧的那份
    const payload = messages.filter((m) => m.role !== 'system')
    localStorage.setItem(KEY, JSON.stringify(payload))
  } catch (err) {
    // 配额满了之类：不抛，顶多这次没存上（下一次成功就会覆盖）
    console.warn('[history] 保存失败', err)
  }
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // 清不掉也没关系（下次 saveHistory 会覆盖）
  }
}
