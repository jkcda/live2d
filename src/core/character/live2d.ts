/**
 * Live2D 渲染器 → CharacterStage 适配。
 *
 * 分工：
 *   core/live2d/engine.ts   底层：Pixi + 引擎的加载、参数写入、取景、轮廓命中
 *   本文件                   行为：把「参数帧」写进模型，以及被点之后播动作/表情
 *   core/portrait/stage.ts  立绘渲染器，实现同一套行为接口
 */

import type { Application } from 'pixi.js'
import { createStage, type ModelHandle, type Stage } from '../live2d/engine'
import { classify, pickExpression, pickMotion } from '../live2d/reactions'
import type { CharacterAbilities, CharacterFrame, CharacterStage } from './types'

export interface Live2DCharacterOptions {
  /** .model3.json 的 URL */
  url: string
  fitRatio?: number
}

/**
 * 视线 → 转头幅度（度）。
 *
 * 为什么这么小：Live2D 的 ParamAngleX 标称范围是 ±30°，
 * 眼睛看到指针就跑满 30° 会像"头被拽着走"；±7° 大约是"转头看一眼"的量。
 */
const GAZE_YAW_DEG = 7
const GAZE_PITCH_DEG = 4.5
const GAZE_ROLL_DEG = 1.5

export interface Live2DCharacter extends CharacterStage {
  kind: 'live2d'
  /** 调试用：底层舞台与模型句柄 */
  readonly raw: Stage
  readonly model: ModelHandle
  readonly app: Application
}

export async function createLive2DCharacter(
  host: HTMLElement,
  opts: Live2DCharacterOptions,
): Promise<Live2DCharacter> {
  const raw = await createStage(host, { url: opts.url, fitRatio: opts.fitRatio })
  const model = raw.model

  /*
   * 口型落点由模型决定（Mao 是 ParamA），不能写死。
   * 模型没声明 LipGroup 时退回官方模型的通行叫法。
   */
  const lipSyncParams = model.lipSyncParams
  const mouthParam = lipSyncParams[0] ?? 'ParamMouthOpenY'

  /** 最近用过的表情：连着点同一个地方时换新的 */
  const recent: string[] = []
  let resetTimer: number | undefined

  const abilities: CharacterAbilities = {
    lipSyncParams,
    expressionNames: model.expressionNames,
    motionGroups: model.motionGroups,
  }

  if (import.meta.env.DEV) {
    console.info(
      `[character] Live2D 能力：口型=${mouthParam}｜表情 ${abilities.expressionNames.length} 个｜动作组`,
      abilities.motionGroups,
    )
  }

  return {
    kind: 'live2d',
    abilities,
    raw,
    model,
    app: raw.app,

    layout: raw.layout,
    hitTest: raw.hitTest,

    hitAreaAt(clientX, clientY) {
      return model.hitAreaAt(clientX, clientY)
    },

    anchor(part = 'head') {
      // Live2D 只知道脸的位置；问身体就按"脸往下 40% 身高"估
      const face = raw.faceAnchor()
      if (part === 'head') return face
      const rect = raw.app.canvas.getBoundingClientRect()
      return { x: face.x, y: face.y + (rect.height - (face.y - rect.top)) * 0.45 }
    },

    applyFrame(frame: CharacterFrame) {
      /*
       * 视线落到 Live2D 身上是最实的一档：瞳孔真的会动，头也会转 ——
       * 因为模型自带这两套参数，不需要任何素材。
       *
       * 为什么在这里相加而不是在驱动层混好：驱动层要能单独衰减待机
       * （设置 → 待机动作），而"看鼠标"不该被一起关掉。
       */
      const { mouth, gazeX, gazeY, ...rest } = frame
      model.setParams({
        ...rest,
        // 瞳孔：满幅跟随（这是"看"最直接的表现）
        ParamEyeBallX: gazeX,
        ParamEyeBallY: gazeY,
        // 头：跟着转，但幅度要克制 —— 满幅转会像脖子装了电机
        ParamAngleX: rest.ParamAngleX + gazeX * GAZE_YAW_DEG,
        ParamAngleY: rest.ParamAngleY - gazeY * GAZE_PITCH_DEG,
        ParamAngleZ: rest.ParamAngleZ + gazeX * GAZE_ROLL_DEG,
        [mouthParam]: mouth,
      })
    },

    react(areas: string[]) {
      const motion = pickMotion(model.motionGroups)
      const expression = pickExpression(classify(model.expressionDrives), areas, recent)

      if (expression) {
        recent.unshift(expression)
        if (recent.length > 2) recent.pop()
        model.setExpression(expression)
      }

      /*
       * 表情复位的时机跟动作走（动作结束回调），另有兜底定时器 ——
       * 动作组不存在或回调没触发时，也不能让表情一直挂着。
       */
      window.clearTimeout(resetTimer)
      const resetExpression = () => model.resetExpression()

      if (motion) {
        model.playMotion(motion.group, motion.index, resetExpression)
        resetTimer = window.setTimeout(resetExpression, 9000)
      } else if (expression) {
        resetTimer = window.setTimeout(resetExpression, 4000)
      }

      if (import.meta.env.DEV) {
        const reaction = { areas, motion, expression }
        console.debug(`[stage] 被点了 ${JSON.stringify(reaction)}`)
        Object.assign(window as unknown as Record<string, unknown>, { __nexusLastPoke: reaction })
      }
    },

    destroy() {
      window.clearTimeout(resetTimer)
      raw.destroy()
    },
  }
}
