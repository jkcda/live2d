/**
 * Live2D 渲染引擎适配层。
 *
 * 第三方引擎（untitled-pixi-live2d-engine）的 API 差异全部收敛在这里，
 * 上层只依赖 ModelHandle / Stage 两个接口 —— 换引擎只改这个文件。
 *
 * ⚠️ 关于「为什么用动态 import」：
 *   这个包在**模块顶层**就做运行时检查 ——
 *
 *     if (typeof window.Live2DCubismCore === 'undefined') {
 *       throw new Error('Could not find Cubism runtime...')
 *     }
 *
 *   也就是说只要 `import` 它，Core 不在 window 上就直接抛异常。
 *   而顶层 import 发生在模块求值阶段，比任何函数调用都早 ——
 *   写成静态 import 的话，缺 Core 会让**整个应用白屏**，
 *   连「请放入 Core 文件」的提示都显示不出来。
 *
 *   所以必须在 `ensureCubismCore()` 之后再动态导入。
 *
 * 另外注意入口选择：默认入口 `untitled-pixi-live2d-engine`（index.js）
 * 同时要求 Cubism 2 的 live2d.min.js **和** Cubism 3/4/5 的 Core。
 * 我们只支持现代模型，所以走 `/cubism` 子路径，不引入已停止分发的 legacy 运行时。
 */
import { Application, extensions } from 'pixi.js'
import type { Live2DModel } from 'untitled-pixi-live2d-engine'
import { ensureCubismCore } from './cubism'

/**
 * Cubism 2 与 Cubism 4/5 的 coreModel 是两套类型，
 * 但都提供 setParameterValueById —— 这是它们的公共子集。
 */
interface CoreModelLike {
  setParameterValueById(id: string, value: number, weight?: number): void
}

export interface ModelHandle {
  /** 设置单个参数；模型没有该参数时静默忽略 */
  setParam(name: string, value: number): void
  /** 批量设置参数 */
  setParams(params: Record<string, number>): void
  /** 播放动作组；动作不存在时静默失败 */
  playMotion(group: string, index?: number): void
  /** 切换表情 */
  setExpression(id: string): void
}

export interface Stage {
  app: Application
  model: ModelHandle
  /** 容器尺寸变化后重新布局（等比缩放 + 底部居中） */
  layout(width: number, height: number): void
  destroy(): void
}

export interface CreateStageOptions {
  /** .model3.json 的 URL */
  url: string
  /** 模型高度占容器高度的比例，默认 1（铺满） */
  fitRatio?: number
}

/** 引擎模块缓存。ES 规范规定求值失败的模块会被记住，重复 import 直接抛同一个错。 */
type EngineModule = typeof import('untitled-pixi-live2d-engine/cubism')
let engineModule: EngineModule | null = null

/**
 * 加载引擎模块。**必须在 ensureCubismCore() 之后调用。**
 *
 * 注意：如果这里抛过一次错，同一次页面会话内再调用会直接抛同样的错
 * （模块求值失败会被缓存）。所以拿到 Core 文件后要刷新页面，
 * 这不是 bug，是 ES 模块的规范行为。
 */
async function loadEngine(): Promise<EngineModule> {
  if (!engineModule) {
    engineModule = await import('untitled-pixi-live2d-engine/cubism')
  }
  return engineModule
}

/**
 * Live2D 是一个自定义渲染管线，必须在创建 Application 之前注册进 pixi 的扩展表，
 * 否则模型能加载但画不出来（画布全透明）。
 */
let pluginRegistered = false
function registerLive2DPlugin(plugin: EngineModule['Live2DPlugin']): void {
  if (pluginRegistered) return
  extensions.add(plugin)
  pluginRegistered = true
}

function resolveCoreModel(model: Live2DModel): CoreModelLike | null {
  const core = (model.internalModel as unknown as { coreModel?: unknown } | undefined)?.coreModel
  if (core && typeof (core as CoreModelLike).setParameterValueById === 'function') {
    return core as CoreModelLike
  }
  console.warn('[live2d] coreModel 不可用，参数设置将被忽略')
  return null
}

export async function createStage(host: HTMLElement, opts: CreateStageOptions): Promise<Stage> {
  // ★ 顺序不能变：
  //   1. 先把 Cubism Core 挂到 window（引擎模块求值时就会检查它）
  //   2. 再动态导入引擎并注册渲染管线
  //   3. 最后才建 Application
  await ensureCubismCore()

  const { Live2DModel: Model, Live2DPlugin } = await loadEngine()
  registerLive2DPlugin(Live2DPlugin)

  const app = new Application()
  await app.init({
    backgroundAlpha: 0,
    antialias: true,
    // Live2D 走自定义 WebGL 管线，必须显式要求 webgl 渲染器
    preference: 'webgl',
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    resizeTo: host,
  })
  host.appendChild(app.canvas)

  const model = await Model.from(opts.url, { anchorMode: 'canvas' })
  app.stage.addChild(model)

  const core = resolveCoreModel(model)

  const handle: ModelHandle = {
    setParam(name, value) {
      core?.setParameterValueById(name, value)
    },
    setParams(params) {
      if (!core) return
      for (const name of Object.keys(params)) {
        core.setParameterValueById(name, params[name])
      }
    },
    playMotion(group, index) {
      void model.motion(group, index)
    },
    setExpression(id) {
      void model.expression(id)
    },
  }

  const layout = (width: number, height: number) => {
    if (width <= 0 || height <= 0) return
    const fit = opts.fitRatio ?? 1
    const scale = Math.min(width / model.width, (height * fit) / model.height)
    model.scale.set(scale)
    model.anchor.set(0.5, 1)
    model.position.set(width / 2, height)
  }

  layout(app.renderer.width, app.renderer.height)

  return {
    app,
    model: handle,
    layout,
    destroy() {
      app.destroy(true, { children: true })
    },
  }
}
