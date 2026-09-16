/**
 * Live2D 渲染引擎适配层。
 *
 * 第三方引擎（untitled-pixi-live2d-engine）的 API 差异全部收敛在这里，
 * 上层只依赖 ModelHandle / Stage 两个接口 —— 换引擎只改这个文件。
 */
import { Application } from 'pixi.js'
import { Live2DModel } from 'untitled-pixi-live2d-engine'

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
  /** .model3.json / .model.json 的 URL */
  url: string
  /** 模型高度占容器高度的比例，默认 1（铺满） */
  fitRatio?: number
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
  const app = new Application()
  await app.init({
    backgroundAlpha: 0,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    resizeTo: host,
  })
  host.appendChild(app.canvas)

  const model = await Live2DModel.from(opts.url, { anchorMode: 'canvas' })
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
