/**
 * 被点之后的反应编排。
 *
 * 为什么需要这一层：引擎能播动作、能切表情（都验过），但**没人决定什么时候播哪个**。
 * 而「随便挑一个」是不行的 —— 摸她头却给她一张生气的脸，比没有反应更糟。
 *
 * 表情语义从**参数**推，不写死表情名：
 *   exp3.json 里驱动的参数就说明了情绪 ——
 *     ParamEyeLSmile / ParamEyeRSmile > 0  → 笑眼
 *     ParamMouthForm > 0                   → 嘴角上扬
 *     ParamTere > 0                        → 照羞（Cubism 通用参数名）
 *     ParamEyeLOpen > 1.2 或 抬眉          → 惊讶
 *     ParamMouthForm <= -1 或 皱眉         → 不满
 *   所以换任何模型都不用改这张表；模型没有表情时整层自动失效。
 */

export type Mood = 'happy' | 'shy' | 'surprised' | 'unhappy' | 'neutral'

/** 一个表情驱动了哪些参数（由引擎适配层归一化后给出） */
export interface ExpressionDrive {
  name: string
  drives: Array<{ id: string; value: number }>
}

/** 命中区 → 期望的情绪优先级（没有匹配就顺延，最后退回随机） */
const MOOD_PREFERENCE: Record<string, Mood[]> = {
  // 摸头：亲昵的回应
  Head: ['happy', 'shy', 'neutral'],
  // 戳身体：意外或抗议
  Body: ['surprised', 'unhappy', 'neutral'],
  // 没有命中区信息（比如 miara）时的通用偏好
  '': ['happy', 'surprised', 'neutral'],
}

export function moodOf(expression: ExpressionDrive): Mood {
  const value = (id: string): number =>
    expression.drives.find((d) => d.id === id)?.value ?? 0

  if (value('ParamTere') > 0) return 'shy'
  if (value('ParamEyeLSmile') > 0 || value('ParamEyeRSmile') > 0) return 'happy'
  if (value('ParamMouthForm') >= 0.2) return 'happy'
  if (value('ParamEyeLOpen') > 1.2 || value('ParamBrowLY') > 0.5) return 'surprised'
  if (value('ParamMouthForm') <= -1 || value('ParamBrowLForm') <= -0.5) return 'unhappy'
  return 'neutral'
}

/** 给每个表情打上情绪标签（同情绪内顺序保持，便于「多戳几次能看到不同表情」） */
export function classify(expressions: ExpressionDrive[]): Array<{ name: string; mood: Mood }> {
  return expressions.map((e) => ({ name: e.name, mood: moodOf(e) }))
}

/**
 * 按命中区挑一个表情。
 *
 * @param areas  命中区名（引擎 hitTest 的结果，可能是空数组）
 * @param recent 最近用过的表情 —— 连着点同一个地方时换新的，别一直同一张脸
 */
export function pickExpression(
  expressions: Array<{ name: string; mood: Mood }>,
  areas: string[],
  recent: string[] = [],
): string | undefined {
  if (!expressions.length) return undefined

  const avoid = new Set(recent)
  const preferred = MOOD_PREFERENCE[areas[0] ?? ''] ?? MOOD_PREFERENCE['']
  for (const mood of preferred) {
    const candidates = expressions.filter((e) => e.mood === mood && !avoid.has(e.name))
    if (candidates.length) {
      return candidates[Math.floor(Math.random() * candidates.length)].name
    }
  }

  // 该情绪下都被避开了：宁可重复，也别没反应
  for (const mood of preferred) {
    const candidates = expressions.filter((e) => e.mood === mood)
    if (candidates.length) {
      return candidates[Math.floor(Math.random() * candidates.length)].name
    }
  }

  const pool = expressions.filter((e) => !avoid.has(e.name))
  const list = pool.length ? pool : expressions
  return list[Math.floor(Math.random() * list.length)].name
}

/** 挑一段动作。优先用 TapBody（官方模型里就是「被戳一下」的反应），否则用除 Idle 外的任意组 */
export function pickMotion(
  groups: Record<string, number>,
  random: () => number = Math.random,
): { group: string; index: number } | undefined {
  const preferred = groups.TapBody
    ? 'TapBody'
    : Object.keys(groups).find((g) => g !== 'Idle' && groups[g] > 0)
  if (!preferred || groups[preferred] <= 0) return undefined
  return { group: preferred, index: Math.floor(random() * groups[preferred]) }
}
