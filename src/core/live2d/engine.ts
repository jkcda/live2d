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
  setParameterValueByIndex?(index: number, value: number, weight?: number): void
  /** 框架内部持有的 Core 原生模型 —— 参数 ID 表只有这里拿得到正确顺序 */
  _model?: { parameters?: { ids?: string[] } }
}

/**
 * 参数名 → 索引表。
 *
 * ★ 为什么不能直接用 coreModel.setParameterValueById(name, value)：
 *
 *   Core 6（SDK for Web 5-r.5）下引擎自己的 ID 查询是坏的 ——
 *   `getParameterIndex('ParamMouthOpenY')` 返回 **147**，而这个模型只有 138 个参数。
 *   于是 setParameterValueById 写到一个越界槽位，被 Float32Array **静默丢弃**：
 *   不报错、不警告，只是「呼吸 / 眨眼 / 视线游移 / 口型怎么都不动」。
 *
 *   更阴险的是画面上照旧有东西在动 —— 那是引擎自带的效果链
 *   （breathDepth / eyeBlink / autoFocus），它们用构造时预先解析好的索引写，
 *   所以不受这个 bug 影响。看起来一切正常，实际我们的参数一个都没落地。
 *
 *   走 setParameterValueByIndex 是实测有效的路径（_parameterValues 就是 Core 的内存视图，
 *   索引写入立即反映到渲染）。
 */
function buildParameterIndex(core: CoreModelLike | null): Map<string, number> {
  const map = new Map<string, number>()
  const ids = core?._model?.parameters?.ids
  if (Array.isArray(ids)) {
    for (let i = 0; i < ids.length; i++) map.set(ids[i], i)
  }
  return map
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

  const model = await Model.from(opts.url, {
    anchorMode: 'canvas',
    /*
     * 关掉引擎自带的效果链 —— 它们和「程序化待机 + 振幅口型」抢同一批参数。
     *
     * 尤其 autoFocus：指针一动它就把头转到 ParamAngleX ±30°；
     * 默认 breathDepth=1 又会叠加 ±15° 的全身摆动。
     * 两个加起来，角色看上去就是「一直在大幅摇晃」——
     * 而按设计，待机动作应该由 IdleAnimator 生成（±4° 微摆）。
     *
     * 这三项关掉后，待机与口型的参数只有我们一个写入方。
     */
    eyeBlink: false,
    breathDepth: 0,
    autoFocus: false,

    /*
     * 关掉「自动播放待机动作」。
     *
     * 引擎默认拿模型 Idle 动作组里的动作**无限循环**播放
     * （motionManager.update() 里那句 startRandomMotion(groups.idle, IDLE)）。
     * 而模型作者放进 Idle 组的往往不是待机动作，而是一整段演出 ——
     * miara 的 Idle 组是 Scene1/2/3，曲线里带 ParamMoveX / ParamAllX / 双腿 / 双臂，
     * 于是角色会一直在原地走来走去，还会盖掉我们的口型。
     *
     * 指到一个不存在的组名即可：startRandomMotion 找不到定义就返回 false，
     * 不抛异常。**显式播放不受影响** —— playMotion('Tap') 之类照常能用，
     * 因为那条路是调用方自己给组名的。
     */
    idleMotionGroup: '__nexus_no_auto_idle__',
  })
  app.stage.addChild(model)

  const core = resolveCoreModel(model)
  const paramIndex = buildParameterIndex(core)

  /** 按索引写核心参数；索引表拿不到时退回按 ID 写（老 Core 上那条是通的） */
  const warnedParams = new Set<string>()
  const writeParam = (name: string, value: number): void => {
    if (!core) return
    const index = paramIndex.get(name)

    if (index !== undefined && typeof core.setParameterValueByIndex === 'function') {
      core.setParameterValueByIndex(index, value)
      return
    }

    // 「静默丢参数」正是这个文件里两次翻车的原因，开发期必须吵出来。
    // 只在索引表建起来了（说明模型参数表读得到）时才算「真的没这个参数」，
    // 否则老 Core 走兜底路径会误报。
    if (
      import.meta.env.DEV &&
      paramIndex.size > 0 &&
      index === undefined &&
      !warnedParams.has(name)
    ) {
      warnedParams.add(name)
      console.warn(`[live2d] 模型没有参数 ${name}，写入被忽略`)
    }
    core.setParameterValueById(name, value)
  }

  const handle: ModelHandle = {
    setParam(name, value) {
      writeParam(name, value)
    },
    setParams(params) {
      if (!core) return
      for (const name of Object.keys(params)) {
        writeParam(name, params[name])
      }
    },
    playMotion(group, index) {
      void model.motion(group, index)
    },
    setExpression(id) {
      void model.expression(id)
    },
  }

  /*
   * 开发期调试钩子。
   *
   * 为什么留着：参数写入这条路是**静默失败**的 —— core 拿不到时 setParams 直接
   * return，界面上完全看不出来（角色照样在眨眼呼吸，因为那是引擎自带的效果）。
   * 排查「口型不动」这类问题时，必须能直接把 core / model 掏出来看。
   * 生产构建会被 import.meta.env.DEV 摇掉。
   */
  if (import.meta.env.DEV) {
    Object.assign(handle as unknown as Record<string, unknown>, {
      debugCore: core,
      debugModel: model,
    })
  }

  /*
   * 取景基准用**画布**尺寸（originalWidth/Height），不是 model.width/height。
   *
   * 两条理由，都是踩出来的：
   *
   * ① model.width / height 含当前缩放（内容包围盒 × scale），拿它们算比例会形成正反馈：
   *      第一次 layout → 算出 0.41，缩放生效；
   *      第二次 layout → model.height 已经是 878，于是算出 1.0，又变回原始尺寸；
   *    最终停在哪个值只取决于 layout() 被调用了几次（ResizeObserver 挂载时就调一次）。
   *    实测停在 1：模型保持 1562×2144 的原始尺寸，而视口只有 1200×878，
   *    锚点又是「底部居中」，屏幕上**只剩两条腿**。
   *
   * ② anchor 锚的是**画布**边界。若缩放按内容包围盒算、位置按画布算，
   *    两者差多少内容就偏出去多少 —— miara 的画布底部有一段水面场景，
   *    内容比画布底边高 125.7 单位，于是头顶被切掉 52px。
   *
   * 两者都统一到画布上，layout() 才既是幂等的、又是对齐的。
   */
  const naturalWidth = model.internalModel.originalWidth
  const naturalHeight = model.internalModel.originalHeight

  const layout = (width: number, height: number) => {
    if (width <= 0 || height <= 0) return
    if (naturalWidth <= 0 || naturalHeight <= 0) return
    const fit = opts.fitRatio ?? 1
    const scale = Math.min(width / naturalWidth, (height * fit) / naturalHeight)
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
