/**
 * 表情差分的「名字表」。
 *
 * 立绘的表情就是一张张画好的差分图（`expr_<id>.png`），文件名是唯一的声明处：
 * 图里画的是什么情绪，代码看不出来，只能由名字说了算。
 *
 * 为什么单独一个不依赖 Pixi 的文件：
 *   同一份清单有两个互不相干的用处 ——
 *     · 素材探测（`character/packs.ts`：设置面板一打开就要知道"这个角色有没有表情"）
 *     · 渲染层加载（`portrait/assets.ts`）
 *   探测那条路跑在设置面板里，不该为了几个字符串把 Pixi 拖进来；
 *   而且两边各写一份候选名，早晚会不一致（一边认中文名、一边只认英文，最难查）。
 *
 * 情绪（mood）为什么要写死在这里：Live2D 的表情情绪是从 exp3 驱动的参数**推**出来的
 * （见 `live2d/reactions.ts`），立绘推不出来 —— 但点击反应那套编排（摸头想要开心/害羞、
 * 戳身体想要惊讶/不满）是渲染器无关的，只要每张差分声明一个情绪就能整层复用。
 */

import type { Mood } from '../live2d/reactions'

export interface ExpressionSpec {
  /** 规范 id：文件名 `expr_<id>.png`，也是界面与反应编排里用的名字 */
  id: string
  /** 界面上的中文名 */
  label: string
  /** 情绪标签，供点击反应挑选 */
  mood: Mood
  /**
   * 允许的别名文件名（`expr_高兴.png` 这种）。
   *
   * 存在的意义：素材是画师/用户手工命名的，写了中文名却**静默不生效**
   * 是这类功能最难查的故障 —— 多探两个名字比让用户对着文档找错别字便宜。
   */
  aliases?: string[]
}

/** 候选清单。顺序 = 设置/悬浮条上的显示顺序 */
export const EXPRESSION_SPECS: readonly ExpressionSpec[] = [
  { id: 'happy', label: '开心', mood: 'happy', aliases: ['高兴', '笑'] },
  { id: 'shy', label: '害羞', mood: 'shy', aliases: ['羞'] },
  { id: 'surprised', label: '惊讶', mood: 'surprised', aliases: ['吃惊'] },
  { id: 'angry', label: '生气', mood: 'unhappy', aliases: ['愤怒', '怒'] },
  { id: 'sad', label: '伤心', mood: 'unhappy', aliases: ['难过', '悲伤'] },
  { id: 'neutral', label: '无语', mood: 'neutral', aliases: ['平静'] },
]

const BY_NAME = new Map<string, ExpressionSpec>()
for (const spec of EXPRESSION_SPECS) {
  BY_NAME.set(spec.id, spec)
  for (const alias of spec.aliases ?? []) BY_NAME.set(alias, spec)
}

/** 按 id 或别名找规范条目 */
export function expressionSpec(name: string): ExpressionSpec | undefined {
  return BY_NAME.get(name)
}

/** 界面显示名（认不出来就原样返回，别把名字吞掉） */
export function expressionLabel(name: string): string {
  return expressionSpec(name)?.label ?? name
}

/**
 * 一张表情差分**所有可能**的文件名（id 优先，其次别名）。
 * 探测和加载都走这里，保证「能找到的」和「能加载的」是同一批。
 */
export function expressionFileNames(spec: ExpressionSpec): string[] {
  return [spec.id, ...(spec.aliases ?? [])]
}
