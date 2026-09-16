/**
 * 角色舞台的统一接口。
 *
 * 有两个实现：
 *   - Live2D 模型    → `core/live2d/engine.ts`
 *   - 立绘（PNGTuber）→ `core/portrait/stage.ts`
 *
 * 上层（CharacterStage.vue）只依赖这个接口，所以「换成自己的角色」不需要动交互逻辑：
 * 悬浮判定、点击反应、口型、待机全都在这一层之上。
 *
 * ★ 关键约定：两个实现都吃**同一份参数帧**。
 *   待机动画（IdleAnimator）和口型（LipSyncDriver）算出来的是 Live2D 的参数语义，
 *   立绘渲染层把它当「语义」解释成位移/旋转/换图，而不是当参数写进模型。
 *   这样两边的节奏、口型手感完全一致，换渲染器不用重调。
 */

/** 一帧的参数。字段名沿用 Live2D 的参数名，因为它们同时是语义名 */
export interface CharacterFrame {
  /** 呼吸 0~1 */
  ParamBreath: number
  /** 眼睛开合 0~1（1 是睁开） */
  ParamEyeLOpen: number
  ParamEyeROpen: number
  ParamEyeBallX: number
  ParamEyeBallY: number
  /** 头部偏转，幅度见 idle.ts：X ±4 / Y ±2.4 / Z ±1.4 */
  ParamAngleX: number
  ParamAngleY: number
  ParamAngleZ: number
  /** 身体侧倾，±2 */
  ParamBodyAngleX: number
  /** 口型开合 0~1，来自音频振幅 */
  mouth: number
  /**
   * 视线：鼠标在哪，她就往哪看。**-1~1**，负 = 左 / 上。
   *
   * ★ 为什么不塞进 ParamAngleX / ParamEyeBallX 里就完事：
   *   待机幅度可以调到「静止」，而"看鼠标"不该跟着一起被关掉 ——
   *   两者混在一个参数里就没法分开衰减。所以视线是独立字段，
   *   由各渲染器自己决定怎么落地：
   *     Live2D → 瞳孔参数 + 转头
   *     立绘   → 整体视差位移 + 倾斜（没有瞳孔图层，见 features.gaze）
   */
  gazeX: number
  gazeY: number
}

/** 渲染器能提供的能力。立绘给不出表情/动作，UI 据此退化 */
export interface CharacterAbilities {
  /** 模型声明的口型参数（立绘为空） */
  lipSyncParams: string[]
  /** 表情名（立绘为空） */
  expressionNames: string[]
  /** 动作组 → 数量（立绘为空） */
  motionGroups: Record<string, number>
}

export interface CharacterStage {
  readonly kind: 'live2d' | 'portrait'
  readonly abilities: CharacterAbilities

  /** 容器尺寸变化后重新布局 */
  layout(width: number, height: number): void

  /** 应用一帧参数（待机 + 口型） */
  applyFrame(frame: CharacterFrame): void

  /**
   * 屏幕坐标是否落在角色**轮廓**上。
   * 悬浮浮现 UI、点击穿透都依赖它 —— 不能退化成矩形判定。
   */
  hitTest(clientX: number, clientY: number): boolean

  /** 屏幕坐标落在哪个命中区（Head / Body …），没定义时返回空数组 */
  hitAreaAt(clientX: number, clientY: number): string[]

  /**
   * 角色某个部位**在屏幕上的位置**（CSS 像素）。
   *
   * 为什么渲染器必须提供它：视线跟随要知道"指针相对于她的脸在哪" ——
   * 用窗口中心当基准是错的（角色不一定居中，而且不同取景下脸的位置差很多），
   * 结果就是"看着鼠标但视线偏一边"。只有渲染器自己知道脸画在哪。
   */
  anchor(part?: 'head' | 'body'): { x: number; y: number } | null

  /** 被点之后的反应。Live2D 播动作/表情，立绘做程序化弹跳/歪头 */
  react(areas: string[]): void

  destroy(): void
}
