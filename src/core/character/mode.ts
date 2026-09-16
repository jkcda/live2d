/**
 * 角色渲染模式。
 *
 *   live2d   —— 用 Live2D 模型（有表情、动作、立体转头）
 *   portrait —— 用立绘差分图（PNGTuber：换图式口型/眨眼，成本极低）
 *
 * ★ 现在模式是**角色的属性**，不是独立设置：清单里每个角色自带 `kind`
 *   （见 `public/characters/index.json` 与 `core/character/packs.ts`）。
 *   这个模块只负责记住「上次用的是哪一种」，供两处使用：
 *     · 没有 characters/index.json 时的兜底角色（老安装不能因为升级就瘸掉）；
 *     · 以后要按类型给用户推荐角色时的默认值。
 *
 * 开发期想强制某种渲染器：`?portrait=1` / `?live2d=1`（挑该类型的第一个角色），
 * 或 `?pack=<id>` 直接指定角色 —— 逻辑在 packs.ts 的 resolveCurrentPack。
 */

export type CharacterKind = 'live2d' | 'portrait'

const KEY = 'nexus.character.kind'

export const DEFAULT_CHARACTER_KIND: CharacterKind = 'live2d'

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
