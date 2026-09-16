/**
 * 当前角色：一个极小的「选择 + 订阅」状态。
 *
 * 为什么不用 Vue 的 store / provide-inject：
 *   需要响应角色变化的是**舞台组件**（要卸载重建渲染器），
 *   而改角色的是**设置面板**，两者是兄弟关系 —— 中间隔着一层 App。
 *   用一个模块级的小对象 + 订阅，比往上传事件 / 引 store 都短，
 *   而且渲染器、验证脚本（DEV 钩子）都能直接拿到当前角色。
 *
 * 注意：这里只管「选哪个包」，**不管创建是否成功**。
 * 创建失败时由舞台负责回退（见 CharacterStage.vue 的 switchPack），
 * 所以选中状态不会因为一次素材缺失就永久坏掉。
 */

import {
  featuresOf,
  loadPacks,
  persistSelection,
  probePortrait,
  resolveCurrentPack,
  type CharacterFeatures,
  type CharacterPack,
  type PortraitProbe,
} from './packs'

export interface PackState {
  pack: CharacterPack
  features: CharacterFeatures
  probe?: PortraitProbe
  /** 是否来自 URL 强制（`?portrait=1` 之类）—— 那种情况下不写回选择 */
  forced: boolean
}

let state: PackState | null = null
let initPromise: Promise<PackState> | null = null
const listeners = new Set<(s: PackState) => void>()

async function describe(pack: CharacterPack, forced: boolean): Promise<PackState> {
  const probe = pack.kind === 'portrait' ? await probePortrait(pack.dir ?? 'portrait') : undefined
  return { pack, features: featuresOf(pack, probe), probe, forced }
}

/** 初始化（幂等）：读清单 → 决定用哪个 → 探测素材 */
export function initCharacter(): Promise<PackState> {
  initPromise ??= resolveCurrentPack().then(({ pack, forced }) => {
    state = null
    return describe(pack, forced).then((s) => {
      state = s
      return s
    })
  })
  return initPromise
}

export function characterState(): PackState | null {
  return state
}

export async function listCharacterPacks(): Promise<CharacterPack[]> {
  return (await loadPacks()).packs
}

/**
 * 切换角色。
 *
 * `persist: false` 用于「切换失败要回退」的场景 —— 回退时不该把选择写回去
 * （用户选的还是新角色，只是这次没成功；下次他修好素材直接刷新就能用）。
 */
export async function selectCharacter(id: string, persist = true): Promise<PackState> {
  const packs = await listCharacterPacks()
  const pack = packs.find((p) => p.id === id)
  if (!pack) throw new Error(`没有这个角色：${id}`)
  const next = await describe(pack, false)
  state = next
  if (persist) persistSelection(pack)
  for (const fn of listeners) fn(next)
  return next
}

/** 订阅角色变化。返回取消订阅函数。 */
export function onCharacterChange(fn: (s: PackState) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/*
 * 开发期钩子。
 *
 * ★ 必须挂在 window 上，不能让外部脚本 `import('/src/core/character/selection.ts?t=…')`：
 *   Vite 在 HMR 下会给改动过的模块加查询串，那样拿到的是**另一个模块实例** ——
 *   selectCharacter 调用会落到没人订阅的副本上，表现为「切换没有任何反应」。
 *   验证脚本里就踩过这个坑（切换后角色没变，但页面也没刷新，最难查）。
 */
if (import.meta.env.DEV) {
  Object.assign(window as unknown as Record<string, unknown>, {
    __nexusCharacter: {
      select: (id: string) => selectCharacter(id),
      list: () => listCharacterPacks(),
      current: () => characterState(),
    },
  })
}
