/**
 * 角色包：把「角色」变成一等公民。
 *
 * 之前的问题：系统里只有**渲染模式**（live2d / portrait），没有「角色」这个对象 ——
 *   · Live2D 默认模型写死在 CharacterStage.vue 顶部；
 *   · 立绘目录是常量 `portrait`，同时只能存在一个立绘角色，换角色 = 覆盖文件；
 *   · 切换要 location.reload()；
 *   · 待机幅度、嘴的开合阈值这些是全局的，没法按角色分开；
 *   · 以后要做的视线跟随 / 头发飘动 / 表情，**没地方声明「这个角色有没有对应素材」**。
 *
 * 这个模块解决前四条，并用 `features`（能力探测）解决最后一条：
 * 新功能一律先查能力，缺素材就自动退化，而不是写死。
 *
 * 清单文件：`public/characters/index.json`
 *
 *   {
 *     "current": "me",
 *     "characters": [
 *       { "id": "me",   "name": "我的角色", "kind": "portrait", "dir": "portrait" },
 *       { "id": "haru", "name": "Haru（官方示例）", "kind": "live2d",
 *         "model": "Haru/Haru.model3.json" }
 *     ]
 *   }
 *
 * 没有这个文件也能跑（老安装 / 没配过）：退回「按 mode.ts 里存的模式」合成一个包，
 * 也就是原来的行为 —— 不能让升级把应用直接弄瘸。
 */

import { loadCharacterKind, saveCharacterKind, type CharacterKind } from './mode'

/** 立绘素材目录里各文件的存在性（探测出来的，不是配置里写的） */
export interface PortraitProbe {
  body: boolean
  /** 嘴差分张数（0 = 只有底图，靠拉伸下巴） */
  mouths: number
  eyesClosed: boolean
  eyesOpen: boolean
  /** 有独立瞳孔图层（抠出来的虹膜），有了才能做"眼睛跟着动" */
  pupil: boolean
  hairFront: boolean
  hairBack: boolean
}

/**
 * 角色实际具备的能力。
 *
 * ★ 这是给「以后的功能」用的接口：视线跟随要 `gaze`、头发飘动要 `hairSway`、
 *   动作/表情只有 Live2D 有。功能先查这里，缺就安静地退化，
 *   而不是"这个角色上点了没反应"。
 */
export interface CharacterFeatures {
  /** 会眨眼（有眼差分，或 Live2D 模型自带） */
  blink: boolean
  /** 瞳孔能跟着动（立绘需要独立的瞳孔/眼睛图层，目前一律 false） */
  gaze: boolean
  /**
   * 有几张**嘴差分素材**。
   *
   * 注意它和运行时 `mouths.length` 不是一个数：运行时会把「闭嘴」也算一档
   * （底图本身就是闭嘴，那一档是空纹理），所以 1 张素材 = 运行时 2 档。
   * 0 表示一张都没有，只能靠拉伸下巴表现张嘴。
   * Live2D 恒为 0 —— 它的口型是参数驱动的，不吃素材。
   */
  mouthArt: number
  /** 有独立头发图层可做飘动 */
  hairSway: boolean
  /** 有动作组可播（只有 Live2D） */
  motions: boolean
  /** 有表情可切（只有 Live2D） */
  expressions: boolean
}

/** 按角色覆盖的可调参数；不写就用全局默认 */
export interface CharacterTuning {
  /** 待机幅度倍率（0 = 静止），覆盖设置里的全局值 */
  idleFactor?: number
  /** 口型驱动手感 */
  lipsync?: { gain?: number; attackMs?: number; releaseMs?: number }
  /** 立绘口型的开合映射 */
  mouth?: { closedLevel?: number; minOpenScale?: number }
  /** 立绘待机幅度（覆盖自动推导与 portrait.json） */
  motion?: { bobPercent?: number; swayDegrees?: number; breatheScale?: number }
}

export interface CharacterPack {
  id: string
  name: string
  kind: CharacterKind
  /** Live2D：相对 `public/models/` 的 `*.model3.json` 路径 */
  model?: string
  /** 立绘：相对 `public/` 的素材目录（默认 `portrait`） */
  dir?: string
  /** 设置面板里显示的一句话说明 */
  note?: string
  tuning?: CharacterTuning
}

export interface CharacterIndex {
  current?: string
  characters: CharacterPack[]
}

const SELECTED_KEY = 'nexus.character.pack'

function assetBase(): string {
  return import.meta.env.BASE_URL || '/'
}

async function probeAsset(url: string): Promise<boolean> {
  try {
    const head = await fetch(url, { method: 'HEAD' })
    const type = head.headers.get('content-type') ?? ''
    if (head.ok && type.startsWith('image/')) return true
    /*
     * 有些静态服务器（含某些打包后的 file:// 场景）对 HEAD 不给 content-type。
     * 这时退回 GET 但**不读 body** —— 只需要头部的 content-type。
     * 不能只判断 `resp.ok`：dev server 对不存在的路径会回 index.html(200)，
     * 那种「200 但不是图片」正是当初「素材明明没放却以为加载成功」的原因。
     */
    if (head.ok || !type) {
      const get = await fetch(url)
      return (get.headers.get('content-type') ?? '').startsWith('image/')
    }
    return false
  } catch {
    return false
  }
}

/** 探测一个立绘素材目录：哪些文件在、有几档嘴型 */
export async function probePortrait(dir: string): Promise<PortraitProbe> {
  const base = `${assetBase()}${dir.replace(/^\/+|\/+$/g, '')}/`
  const [body, eyesClosed, eyesOpen, pupil, hairFront, hairBack, m0, m1, m2] = await Promise.all([
    probeAsset(`${base}body.png`),
    probeAsset(`${base}eyes_closed.png`),
    probeAsset(`${base}eyes_open.png`),
    probeAsset(`${base}pupil.png`),
    probeAsset(`${base}hair_front.png`),
    probeAsset(`${base}hair_back.png`),
    probeAsset(`${base}mouth_0.png`),
    probeAsset(`${base}mouth_1.png`),
    probeAsset(`${base}mouth_2.png`),
  ])

  /*
   * 嘴差分是从 mouth_0 起**连续编号**读的，缺号就停（见 loadPortrait）。
   * 但底图本身就是闭嘴时允许缺 mouth_0 —— 那种情况下「闭嘴」= 不叠任何东西，
   * 所以这里也按同样的规则数：没有 0 但有 1，就算作 1 张可用差分。
   */
  let mouths = 0
  if (m0) mouths = m1 ? (m2 ? 3 : 2) : 1
  else if (m1) mouths = m2 ? 2 : 1

  return { body, mouths, eyesClosed, eyesOpen, pupil, hairFront, hairBack }
}

/** 由探测结果推出能力表（配置里写的声明不作数，实测才算） */
export function featuresOf(pack: CharacterPack, probe?: PortraitProbe): CharacterFeatures {
  if (pack.kind === 'live2d') {
    return {
      blink: true, // 引擎自带眨眼（我们用程序化眨眼，模型只需有眼睛参数）
      gaze: true, // Live2D 有 ParamEyeBallX/Y，可以做瞳孔跟随
      mouthArt: 0, // 参数驱动，不吃素材
      hairSway: true, // 头发物理在模型里，参数一动就飘
      motions: true,
      expressions: true,
    }
  }
  return {
    blink: Boolean(probe?.eyesClosed),
    // 有瞳孔图层才能真正"眼睛跟着动"；否则只能整体视差（见 docs）
    gaze: Boolean(probe?.pupil),
    mouthArt: probe?.mouths ?? 0,
    hairSway: Boolean(probe?.hairFront || probe?.hairBack),
    motions: false,
    expressions: false,
  }
}

/** 没有任何清单文件时的兜底：沿用老行为（按 mode.ts 里存的模式 + 固定目录/自动探测） */
function fallbackPack(): CharacterPack {
  const kind = loadCharacterKind()
  return {
    id: kind === 'portrait' ? 'portrait' : 'live2d',
    name: kind === 'portrait' ? '立绘（public/portrait）' : 'Live2D 模型（自动探测）',
    kind,
    dir: kind === 'portrait' ? 'portrait' : undefined,
    note: '没有 public/characters/index.json，用的是兜底配置',
  }
}

interface CharacterList {
  packs: CharacterPack[]
  current: string
  fromIndex: boolean
}

let cache: CharacterList | null = null
let loading: Promise<CharacterList> | null = null

async function readIndex(): Promise<CharacterList> {
  try {
    const resp = await fetch(`${assetBase()}characters/index.json`)
    const type = resp.headers.get('content-type') ?? ''
    if (resp.ok && type.includes('json')) {
      const raw = (await resp.json()) as CharacterIndex
      const packs = (raw.characters ?? []).filter(
        (p): p is CharacterPack => Boolean(p && typeof p.id === 'string' && typeof p.kind === 'string'),
      )
      if (packs.length) {
        const saved = readSelectedId()
        const ids = packs.map((p) => p.id)
        const current =
          (saved && ids.includes(saved) && saved) ||
          (raw.current && ids.includes(raw.current) && raw.current) ||
          packs[0].id
        return { packs, current, fromIndex: true }
      }
      console.warn('[character] characters/index.json 里没有有效条目，退回兜底配置')
    }
  } catch (err) {
    console.info('[character] 没有读到 characters/index.json，用兜底配置', err)
  }
  const pack = fallbackPack()
  return { packs: [pack], current: pack.id, fromIndex: false }
}

/** 读取角色清单（结果缓存；`reload` 时强制重读） */
export async function loadPacks(reload = false): Promise<CharacterList> {
  if (reload) {
    cache = null
    loading = null
  }
  if (cache) return cache
  if (!loading) {
    loading = readIndex().then((v) => {
      cache = v
      return v
    })
  }
  return loading
}

function readSelectedId(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY)
  } catch {
    return null
  }
}

export function saveSelectedId(id: string): void {
  try {
    localStorage.setItem(SELECTED_KEY, id)
  } catch (err) {
    console.warn('[character] 保存角色选择失败', err)
  }
}

/**
 * 决定这次到底用哪个角色包。
 *
 * 优先级：URL 覆盖（`?pack=id`，或 `?portrait=1` / `?live2d=1` 选该类型的第一个）
 * → 上次选择的 id → 清单里的 current → 第一个。
 * URL 只影响这一次渲染，不写回 localStorage（对比两种渲染器时不该改掉用户的设置）。
 */
export async function resolveCurrentPack(): Promise<{ pack: CharacterPack; forced: boolean }> {
  const { packs, current } = (await loadPacks())!
  const found = (id: string | null | undefined) => (id ? packs.find((p) => p.id === id) : undefined)

  if (import.meta.env.DEV) {
    const q = new URLSearchParams(window.location.search)
    const byId = found(q.get('pack'))
    if (byId) return { pack: byId, forced: true }
    if (q.has('portrait') || q.has('live2d')) {
      const kind: CharacterKind = q.has('portrait') ? 'portrait' : 'live2d'
      const byKind = packs.find((p) => p.kind === kind)
      if (byKind) return { pack: byKind, forced: true }
    }
  }

  return { pack: found(readSelectedId()) ?? found(current) ?? packs[0], forced: false }
}

/** 切换角色：落盘 + 记住类型（兜底配置要用） */
export function persistSelection(pack: CharacterPack): void {
  saveSelectedId(pack.id)
  saveCharacterKind(pack.kind)
}
