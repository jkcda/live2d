/**
 * 角色渲染模式的选择与持久化。
 *
 *   live2d   —— 用 Live2D 模型（有表情、动作、立体转头）
 *   portrait —— 用立绘差分图（PNGTuber：换图式口型/眨眼，成本极低）
 *
 * 存 localStorage（与其它设置一致，见 settings.ts 的写入时机说明）。
 * 开发期可以用 ?portrait=1 / ?live2d=1 临时切换，便于对比。
 */

export type CharacterKind = 'live2d' | 'portrait'

const KEY = 'nexus.character.kind'

export const DEFAULT_CHARACTER_KIND: CharacterKind = 'live2d'

/** 各模式的默认入口（模型配置在 CharacterStage.vue 顶部，立绘目录固定为 public/portrait） */
export const CHARACTER_LABELS: Record<CharacterKind, string> = {
  live2d: 'Live2D 模型',
  portrait: '立绘差分（PNGTuber）',
}

export function loadCharacterKind(): CharacterKind {
  try {
    const raw = localStorage.getItem(KEY)
    return raw === 'portrait' || raw === 'live2d' ? raw : DEFAULT_CHARACTER_KIND
  } catch {
    return DEFAULT_CHARACTER_KIND
  }
}

export function saveCharacterKind(kind: CharacterKind): void {
  try {
    localStorage.setItem(KEY, kind)
  } catch (err) {
    console.warn('[character] 保存渲染模式失败', err)
  }
}

/** 实际生效的模式：开发期的 query 参数优先（方便对比两种渲染器） */
export function resolveCharacterKind(): CharacterKind {
  if (import.meta.env.DEV) {
    const q = new URLSearchParams(window.location.search)
    if (q.has('portrait')) return 'portrait'
    if (q.has('live2d')) return 'live2d'
  }
  return loadCharacterKind()
}
