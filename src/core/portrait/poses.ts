/**
 * 姿态差分的「名字表」（`pose_<id>.png`）。
 *
 * 和表情（`expressions.ts`）是**两回事**，别混：
 *   · 表情改的是**脸**（眉毛/眼睛/嘴），可以一直挂着，说话时只有嘴让位；
 *   · 姿态改的是**整个人**（抬手、弯腰、叉腰），要连底图一起换 ——
 *     因为"把手放下来"这件事没法靠"叠一层"表达：差分图层只能往上加像素，
 *     加不出"擦掉"的效果，原来那条垂着的胳膊会留在原地（两只手）。
 *     所以姿态是一张**整身替换图**，切换时和底图做交叉淡入淡出。
 *
 * 因此姿态素材的做法也和表情不同：不是"抠出改动区域"，而是"整张抠好底、
 * 但把脸恢复成底图那张"（否则 AI 重画过的脸会在招手时轻微变样）——
 * 见 `docs/portrait-assets.md`。
 */

export interface PoseSpec {
  /** 规范 id：文件名 `pose_<id>.png` */
  id: string
  /** 界面显示名 */
  label: string
  /** 允许的别名文件名 */
  aliases?: string[]
}

/**
 * 候选清单。**目前只有招手** —— 不预先占坑：
 * 每多一个 id 就多几次素材探测请求，而且"清单里有、素材没有"只会让人困惑。
 * 加一个新姿势 = 这里加一行 + 放一张图。
 */
export const POSE_SPECS: readonly PoseSpec[] = [
  { id: 'wave', label: '招手', aliases: ['打招呼', '挥手'] },
]

const BY_NAME = new Map<string, PoseSpec>()
for (const spec of POSE_SPECS) {
  BY_NAME.set(spec.id, spec)
  for (const alias of spec.aliases ?? []) BY_NAME.set(alias, spec)
}

/** 按 id 或别名找规范条目 */
export function poseSpec(name: string): PoseSpec | undefined {
  return BY_NAME.get(name)
}

/** 界面显示名（认不出来就原样返回） */
export function poseLabel(name: string): string {
  return poseSpec(name)?.label ?? name
}

/** 一张姿态差分所有可能的文件名（id 优先，其次别名）；探测和加载共用 */
export function poseFileNames(spec: PoseSpec): string[] {
  return [spec.id, ...(spec.aliases ?? [])]
}
