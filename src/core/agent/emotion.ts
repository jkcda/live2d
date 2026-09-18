/**
 * 语气标记 —— 她在文本里插的那些方括号，怎么变成给人看的字。
 *
 * ## 为什么是这个机制（不是「让模型输出两份」）
 *
 * CosyVoice 的 tokenizer 里注册了一批**副语言标记**（见官方
 * `cosyvoice/tokenizer/tokenizer.py`），直接写在待合成文本里就能生效：
 *
 *     '在他讲述那个荒诞故事的过程中，他突然[laughter]停下来。'
 *
 * 实测（同输入跑 3 次的噪声是 ±0.40s）：
 *
 *     [laughter]  时长 +2.5s   ← 真的笑了一段
 *     [sigh]      时长 +2.1s   ← 真的叹了气
 *
 * **关键好处：这是「一份内容，两处消费」** ——
 * 同一份带标记的文本，前端翻译成给人看的字，TTS 原样收下。
 * 不需要拼接、不需要两份、不存在「读到的和听到的不一样」。
 *
 * （另一条路是 instruct 指令 —— `请非常开心地说一句话<|endofprompt|>`，
 * 实测也有效（±1.4s）。但它是**整句级**的，而且要单独拼一个字符串，
 * 更重要的是**本地那条路不支持**（我们用的是 inference_zero_shot，
 * 不是 inference_instruct2）。所以标记这条路两边都能用。）
 *
 * ## 为什么有些标记要「翻译」有些要「删掉」
 *
 * `[laughter]` / `[sigh]` 是**她能做出来的反应**，写进文字里是加分项 ——
 * 读者知道她笑了。
 *
 * 但 `[breath]` 不是：**换气是说话的生理动作，不是反应**。
 * 把它显示成「（吸气）」只会让文字变得像剧本。所以呼吸类**直接删掉** ——
 * 它只对声音有意义，对文字没有。
 */

/** 显示成文字的反应（她做出来的动作，写出来是加分项） */
const SPOKEN_ACTIONS: Record<string, string> = {
  '[laughter]': '（笑）',
  '<laughter>': '（笑）',
  '</laughter>': '',
  '[sigh]': '（叹气）',
}

/** 只对声音有意义、对文字没有的（呼吸之类）—— 显示时删掉 */
const SOUND_ONLY = ['[breath]', '[quick_breath]', '[noise]', '[cough]', '[hissing]', '[lipsmack]', '[vocalized-noise]', '[clucking]', '[accent]', '[mn]']

/** 强调标记：去掉标签、留下内容 */
const WRAPPERS: [RegExp, string][] = [
  [/<strong>(.*?)<\/strong>/g, '$1'],
]

/** 全部标记（用于识别 + 剔除） */
const ALL_MARKERS = [
  ...Object.keys(SPOKEN_ACTIONS),
  ...SOUND_ONLY,
  '<strong>',
  '</strong>',
]

/**
 * 文本末尾可能是一个**没写完的标记**。
 *
 * ★ 为什么必须处理：流式下 delta 是随便切的，
 *   `[laug` 和 `hter]` 可能分两次到达。不扣住的话，
 *   界面上会先闪一下「[laug」再变成「（笑）」—— 很廉价。
 *
 * 扣住的是**显示**，不是数据：`bubbles` 里存的还是原文，
 * 下一次 delta 到了自然就完整了。
 */
function trailingPartial(text: string): string {
  const i = text.lastIndexOf('[')
  if (i === -1) return ''
  const tail = text.slice(i)
  // 开了方括号但还没闭合，且短得像个标记（不是正文里的 `[1]` 那种）
  if (!tail.includes(']') && tail.length <= 20 && !/^\d/.test(tail.slice(1))) return tail
  return ''
}

/**
 * 把带标记的原文转成**给人看**的文字。
 *
 * 流式渲染时每来一个 delta 都会调一次，所以它必须是无状态的纯函数。
 */
export function toDisplayText(text: string): string {
  let out = text

  // 末尾没写完的标记先扣住不显示（下一次 delta 到了自然会补全）
  const partial = trailingPartial(out)
  if (partial) out = out.slice(0, out.length - partial.length)

  for (const [re, to] of WRAPPERS) out = out.replace(re, to)
  for (const [marker, label] of Object.entries(SPOKEN_ACTIONS)) {
    out = out.split(marker).join(label)
  }
  for (const marker of SOUND_ONLY) {
    out = out.split(marker).join('')
  }

  return out
}

/** 这段文本里有没有语气标记（诊断/测试用） */
export function hasMarkers(text: string): boolean {
  return ALL_MARKERS.some((m) => text.includes(m))
}

/** 供 prompt 用的清单 —— 只列**希望她用的**那几个，不把全部标记暴露出去 */
export const PROMPT_MARKERS = ['[laughter]', '[sigh]', '[breath]'] as const
