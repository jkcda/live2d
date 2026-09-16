/**
 * 立绘（PNGTuber）渲染层。
 *
 * 与 Live2D 渲染层实现同一个 `CharacterStage` 接口，所以交互逻辑完全复用：
 * 悬浮判定、点击反应、口型、待机都是同一套代码，只是「参数帧」的解释方式不同。
 *
 * Live2D：参数写进模型，由 Cubism 算出形变。
 * 立绘：参数被当成**语义**解释 ——
 *   呼吸 → 上下浮动 + 轻微缩放
 *   头部偏转 → 位移 + 旋转
 *   口型 → 换嘴差分（没有差分就拉伸下巴）
 *   眨眼 → 换眼差分
 *
 * 这是 PNGTuber 的通行做法：离散换图，不做形变。看起来「够活」，成本几乎为零。
 */

import { Application, Container, Rectangle, Sprite, Texture } from 'pixi.js'
import type { CharacterAbilities, CharacterFrame, CharacterStage } from '../character/types'
import type { CharacterTuning } from '../character/packs'
import { pickExpression } from '../live2d/reactions'
import {
  buildAlphaMask,
  loadPortrait,
  splitAtJaw,
  type PortraitExpression,
  type PortraitManifest,
  type PortraitPose,
} from './assets'
import { expressionSpec } from './expressions'

/** idle.ts 里各参数的标称幅度，用来把参数归一化成 0~1 再映射到位移/旋转 */
const ANGLE_X_RANGE = 4
const ANGLE_Z_RANGE = 1.4
const BODY_ANGLE_RANGE = 2

/**
 * 视线跟随的幅度（相对角色高度的比例）。
 *
 * 立绘没有瞳孔图层（`features.gaze` 为 false），所以"看"完全靠**整体视差**表现：
 * 她整个人朝鼠标方向挪一点、再歪一点。这是 PNGTuber 的通行做法，
 * 效果比想象的强 —— 人眼对"她朝我这边转了"很敏感，对瞳孔那 3 像素反而迟钝。
 *
 * ★ 平移只给一点点（0.7%），主要靠**绕腰倾斜**（GAZE_ROLL_DEG）。
 *   第一版平移给了 1.4%，实测头动 ~25px、底边也跟着动 ~9px，
 *   观感是"整个人在滑"而不是"她转过来了"——平移是滑，倾斜才是转。
 *
 * 为什么用比例而不是像素：窗口大小差很多（浏览器全屏 vs 桌宠 420×640），
 * 写死像素在桌宠里会显得幅度巨大。
 */
/**
 * 视线跟随里"身体"那部分（整体平移 + 绕腰倾斜）的幅度。
 *
 * ★ 现在是**全 0：身体完全不动，只有瞳仁在动**。
 *   用户看过两种之后再选的：整体平移会读成"整个人在滑"，绕腰倾斜又太像待机摇晃，
 *   而他要的是"眼睛跟着你动"。所以画面里唯一响应鼠标的就是瞳仁。
 *   要恢复整体视差，把这三个值调回 0.007 / 0.003 / 1.6 即可（历史版本里有）。
 *
 * 代价说清楚：瞳仁的余量只有 3~4 画布像素（见 PUPIL_SHIFT_MAX_PX），
 * 换算到桌宠窗口不到 1 屏幕像素 —— 视线跟随现在是**很轻**的效果。
 */
const GAZE_SHIFT_RATIO = 0
const GAZE_LIFT_RATIO = 0
const GAZE_ROLL_DEG = 0

/**
 * 瞳孔能移多少（画布像素）。横向 3px、纵向 4px（= 3 × 1.35）。
 *
 * 上限由**素材本身**决定，不是随便定的：瞳仁核（67×32）嵌在虹膜（72×44）里，
 * 左右只剩约 2.5px 余量、上边 4px、下边 8px。超过就会碰到虹膜边缘。
 *
 * 为什么是"只动瞳仁"而不是整块虹膜：这张图的虹膜几乎占满眼睛开口，
 * 整块一动看起来就是"整只眼睛挪了"（实测 10px 时最明显）。
 * 纵向特意给得比横向多（1.35 倍）——上下方向余量本来就大，
 * 而且第一版纵向只有 2.7px，实际看几乎察觉不到箭头上下看。
 */
const PUPIL_SHIFT_MAX_PX = 3
const PUPIL_LIFT_RATIO = 1.35

/** 低于这个开口度就是「闭嘴」= 不叠任何差分 */
const DEFAULT_CLOSED_LEVEL = 0.1
/** 刚开口时的最小缩放：再小就看不出张开了，只剩一条缝 */
const DEFAULT_MIN_OPEN_SCALE = 0.35

/**
 * 被点之后表情挂多久（毫秒），和 Live2D 那边的兜底时长保持一致。
 * 到了就自动回到素颜 —— 表情是「反应」，不该永久挂在脸上。
 */
const EXPRESSION_HOLD_MS = 4000

/**
 * 一次姿态（招手之类）默认挂多久。
 *
 * 比表情长：姿态是"她做了个动作"，一闪而过看不出是什么；
 * 但也不能太长 —— 一直举着手会很怪，而且没有第二张差分时
 * 只能"保持举手"，时间越长越像卡住了。
 */
const POSE_HOLD_MS = 3200

/**
 * 换姿势的交叉淡入淡出时长（毫秒）。
 *
 * 为什么必须淡：
 *   姿态是**整身替换图**（见 poses.ts），硬切会像掉帧；
 *   而素材已经保证"头部区域和底图逐像素一致"（见 docs），
 *   所以淡入淡出期间**脸和头发一个像素都不会动**，动的只有身体/手臂 —— 这正是想要的效果。
 */
const POSE_FADE_MS = 170

/**
 * 表情的嘴那一块往外扩多少像素（再遮住）。
 *
 * 为什么要一个数、为什么是 6：表情差分的**嘴是单独一坨**（和眉毛/脸颊不相连），
 * 说话时这块必须让位给口型，否则底图那张嘴和表情那张嘴会同时出现在脸上。
 * 遮挡靠一张「底图同一位置的切片」—— 于是一个矩形要既完整盖住表情的嘴、
 * 又不碰旁边的脸颊。实测（`expr_angry` / `expr_sad` 两张差分）：
 *   嘴差分的包围盒 = 785,410 ~ 846,444；表情的嘴 = 784,419 ~ 849,438（孤立一团）
 *   margin 6 → 779,404 ~ 852,450：正好只包住嘴，碰到 0 个别的色块
 *   margin 8 → 777,402 ~ 854,452：开始切到脸颊的 7 个像素（说话时会闪一下）
 * 所以取 6。换素材后如果表情的嘴比嘴差分大得多，这个值要重调。
 */
const MOUTH_COVER_MARGIN = 6

/** 口型的开合映射参数（可被角色包覆盖） */
export interface MouthMapping {
  /** 低于它就闭嘴，调大 = 更容易闭 */
  closedLevel: number
  /** 最小开口时的纵向缩放，调大 = 微张也张得更明显 */
  minOpenScale: number
}

export const DEFAULT_MOUTH_MAPPING: MouthMapping = {
  closedLevel: DEFAULT_CLOSED_LEVEL,
  minOpenScale: DEFAULT_MIN_OPEN_SCALE,
}

/**
 * 开口度 → (用第几张差分, 纵向缩放)。
 *
 * 为什么需要这么个映射：立绘只有「离散热差分」，而**说话时振幅几乎不会掉到闭嘴阈值以下**
 * ——直接按阈值二选一的话，看起来就是全程张嘴（这是实际踩过的坑）。
 * 所以中间那些开口度靠**纵向缩放**凑：
 *
 *   1. 先算一个连续的开度 openness（最小开度~1，低开度用幂函数抬一抬，
 *      因为小振幅在听觉上也是"在说话"，嘴不能只开一条缝）；
 *   2. 有多少张差分就有几档，取「第一档标称开度 ≥ openness」的那张；
 *   3. 缩放 = openness / 该档标称开度 —— 于是换图那一刻两张的**视觉大小是连着的**，
 *      不会出现「突然大一圈」的跳变。
 *
 * 只有一张差分时（最常见）：永远用它，缩放直接就是 openness。
 */
export function mouthLevel(
  m: number,
  tiers: number,
  map: MouthMapping = DEFAULT_MOUTH_MAPPING,
): { index: number; scale: number } {
  const { closedLevel, minOpenScale } = map
  if (tiers <= 1) return { index: Math.max(0, tiers - 1), scale: 1 }
  const art = tiers - 1 // 真·差分张数（索引 0 是「闭嘴」= 空纹理）
  if (m < closedLevel) return { index: 0, scale: 1 }

  const t = Math.min(1, Math.max(0, (m - closedLevel) / (1 - closedLevel)))
  const openness = minOpenScale + (1 - minOpenScale) * Math.pow(t, 0.7)

  let index = art
  for (let k = 1; k <= art; k++) {
    if (openness <= k / art + 1e-6) {
      index = k
      break
    }
  }
  const nominal = index / art
  return { index, scale: Math.min(1, Math.max(minOpenScale, openness / nominal)) }
}

export interface PortraitStageOptions {
  /** 素材目录，默认 `portrait` */
  baseUrl?: string
  /**
   * 按角色覆盖的可调参数（来自角色包 `character.json` 的 tuning）。
   * 优先级：这里的值 > portrait.json 的 motion > 内置默认。
   */
  tuning?: CharacterTuning
}

/**
 * 立绘舞台。比 `CharacterStage` 多一条：**能手动切表情**。
 *
 * 为什么这条不进 `CharacterStage`：Live2D 那边表情是模型的资源（`model.setExpression`），
 * 语义和「立绘换一张差分」并不一样，硬塞进公共接口只会让两边互相将就。
 * 上层需要时用 `kind === 'portrait'` 收窄即可（设置面板/悬浮条就是这么用的）。
 */
export interface PortraitCharacter extends CharacterStage {
  kind: 'portrait'
  /**
   * 切表情。`null` = 素颜。
   * 手动切的表情**不会自动复原**（用户是特意选的）；点击反应走的是限时那条路。
   */
  setExpression(id: string | null): void
  /** 素材里实际存在的表情 id（= `abilities.expressionNames`） */
  readonly expressionNames: string[]
  /**
   * 换姿势（招手之类）。`null` = 回到底图那套。
   * 换的时候和底图交叉淡入淡出，脸和头发一个像素都不动（见 poseLayer 的说明）。
   */
  setPose(id: string | null, holdMs?: number): void
  /** 素材里实际存在的姿势 id */
  readonly poseNames: string[]
  /**
   * 打个招呼：有「招手」素材就招一次（限时，自己收回），没有就什么都不做。
   *
   * 为什么单独给一个语义方法而不是让调用方 `setPose('wave', 3200)`：
   * 「打招呼」以后会从好几处触发（她登场、你切回窗口、她开口），
   * 每处都写一遍姿势 id 和时长，早晚会有一处写成别的姿势或者忘加时长。
   */
  greet(): void
}

export async function createPortraitStage(
  host: HTMLElement,
  opts: PortraitStageOptions = {},
): Promise<PortraitCharacter> {
  const assets = await loadPortrait(opts.baseUrl ?? 'portrait')
  const manifest = assets.manifest
  const canvasW = manifest.canvas.width
  const canvasH = manifest.canvas.height

  const app = new Application()
  await app.init({
    backgroundAlpha: 0,
    antialias: true,
    preference: 'webgl',
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    resizeTo: host,
  })
  host.appendChild(app.canvas)

  // ── 图层。z 顺序靠 addChild 顺序决定
  const root = new Container()
  app.stage.addChild(root)

  if (assets.hairBack) root.addChild(new Sprite(assets.hairBack))

  /*
   * 底图：有嘴差分就整张放；没有就沿下巴分界线切成两半，靠拉伸下半张做张嘴。
   * 拉伸而不是平移，是为了不露出断口。
   *
   * `bodySprites` 单独留着：换姿势时要把底图整体淡出（见 poseLayer）。
   */
  const mouthStates = assets.mouths
  const hasMouthArt = mouthStates.length > 0
  const jawLineRatio = manifest.jawLine ?? 0.5

  let jaw: Container | null = null
  const bodySprites: Sprite[] = []
  if (hasMouthArt) {
    const bodySprite = new Sprite(assets.body)
    bodySprites.push(bodySprite)
    root.addChild(bodySprite)
  } else {
    const { upper, lower, jawY } = splitAtJaw(assets.body, canvasH * jawLineRatio)
    bodySprites.push(new Sprite(upper))
    root.addChild(bodySprites[0])
    jaw = new Container()
    jaw.position.set(0, jawY)
    const lowerSprite = new Sprite(lower)
    lowerSprite.position.set(0, 0)
    jaw.addChild(lowerSprite)
    root.addChild(jaw)
    bodySprites.push(lowerSprite)
  }

  /*
   * 姿态图层：整身替换图（`pose_<id>.png`），和底图**交叉淡入淡出**。
   *
   * 为什么是"整身替换"而不是像表情那样"叠一层差分"：差分图层只能往上加像素，
   * 加不出"擦掉"的效果 —— 招手时原来那条垂着的胳膊必须消失，否则会看到她有两只左手。
   * 所以姿态是整张换：底图 alpha 1→0、姿态 alpha 0→1。
   *
   * 换的时候脸不会跟着变：素材那一端保证了**头部区域和底图逐像素一致**
   * （做法见 docs/portrait-assets.md：抠底之后把脸恢复成底图那张，
   *  因为 AI 重画过的脸在招手时会轻微变样）。所以淡入淡出期间动的只有身体和手臂。
   *
   * 位置：底图之上、表情/瞳孔之下 —— 脸的图层永远压在身体之上。
   * （没有嘴差分、靠拉下巴张嘴的角色，摆姿势时下巴拉伸会被姿态图盖住 ——
   *  和表情的遮嘴块同一个道理，都是"没有嘴素材"那条退化路线的代价。）
   */
  const poseLayer = assets.poses.length ? new Sprite(assets.poses[0].texture) : null
  if (poseLayer) {
    poseLayer.alpha = 0
    poseLayer.visible = false
    root.addChild(poseLayer)
  }

  /** 当前姿势 / 到期时间（0 = 手动选的，不过期）/ 淡入淡出进度 0~1 */
  let pose: PortraitPose | null = null
  let poseUntil = 0
  let poseMix = 0
  let lastPoseAt = 0

  /*
   * 表情图层：整张差分盖在脸上（眉毛/眼睛/脸颊都归它），**在瞳孔和眼差分之下**。
   *
   * z 顺序是权衡出来的，往上一格就丢东西：
   *   在底图之上 → 表情能盖住底图的眉毛（必须的，不然皱眉只皱一半）；
   *   在瞳孔之下 → 瞳仁还看得见，「眼睛跟着鼠标动」不会被表情吃掉；
   *   在眼差分之下 → 眨眼还能盖住它（表情画的是睁着的眼睛）。
   * 唯独它自带的那张嘴得单独处理 —— 见 mouthCover。
   */
  const exprLayer = assets.expressions.length ? new Sprite(assets.expressions[0].texture) : null
  if (exprLayer) {
    exprLayer.visible = false
    root.addChild(exprLayer)
  }

  /*
   * 当前挂着的表情 / 到期时间（0 = 手动选的，不过期）。
   * 状态放在闭包里而不是挂在 sprite 上：验证脚本要能读到"现在到底是谁的脸"。
   */
  let expr: PortraitExpression | null = null
  let exprUntil = 0

  /*
   * 瞳孔图层：画在底图之上、眼差分之下 ——
   * 这样眨眼时闭眼图会盖住它（顺序反了就会"闭着眼还能看到眼珠"）。
   */
  const pupil = assets.pupil ? new Sprite(assets.pupil) : null
  if (pupil) root.addChild(pupil)

  const eyes = assets.eyesOpen ? new Sprite(assets.eyesOpen) : null
  if (eyes) root.addChild(eyes)

  const mouth = hasMouthArt ? new Sprite(mouthStates[0]) : null
  if (mouth) {
    /*
     * ★ 支点 = 差分内容的 alpha 质心（大致就是嘴的中线）。
     *
     * 立绘只有一张嘴差分时，中间的开口度靠纵向缩放凑出来（见 applyFrame 里的 mouthScale）。
     * 而差分是**叠在底图上**的 —— 底图那张闭嘴脸一直在下面，
     * 支点选错就会露馅：一开始我按「区间上边缘」当支点，一压扁整块往上缩，
     * 底图那条闭嘴线就从下面露出来，看起来像「底图的闭嘴一直在」。
     * 绕质心缩放则两头都稳：嘴不跑位，闭嘴线一直被盖住。
     */
    const patch = assets.mouthPatches.find((p) => p)
    if (patch) {
      mouth.pivot.set(patch.anchorX, patch.anchorY)
      mouth.position.set(patch.anchorX, patch.anchorY)
    }
    root.addChild(mouth)
  }

  /*
   * ── 说话时盖住「表情自带的嘴」的那一小块 ──
   *
   * 为什么要它：表情差分里也画了一张嘴，而口型是**另一条图层**（mouth_1.png 缩放叠加）。
   * 两张嘴同时出现在脸上就露馅了。但只在**真的在叠口型差分**时才需要遮 ——
   * 闭嘴那一档是空纹理，这时候恰恰要露出表情的嘴，否则「生气」的脸配一张素颜嘴。
   *
   * 做法：直接从**底图**同一位置切一个矩形盖上，而不是"把表情图挖个洞"。
   * 挖洞要给每张表情多存一张整画布纹理（1600×2848×4 ≈ 18MB），
   * 而这里借的是底图**同一份 GPU 纹理**，切子矩形不额外占显存。
   * 代价是这个矩形里凡是表情画的东西都会被底图盖掉 ——
   * 所以它必须只框住嘴，靠 MOUTH_COVER_MARGIN 保证（那个常量有实测数据）。
   *
   * 盖的是底图那张**闭嘴**的脸：口型差分本来就是在它上面缩放叠加的（做表情之前一直如此），
   * 所以说话时看到的东西和"没有表情功能"时完全一样。
   *
   * 没有嘴差分的角色（靠拉下巴张嘴）没有这一层：那种情况下表情的嘴会挡住下巴拉伸。
   */
  const mouthPatch = assets.mouthPatches.find((p) => p)
  let mouthCover: Sprite | null = null
  let mouthCoverBox: { x: number; y: number; width: number; height: number } | null = null
  if (exprLayer && mouth && mouthPatch) {
    const x = Math.max(0, Math.round(mouthPatch.x - MOUTH_COVER_MARGIN))
    const y = Math.max(0, Math.round(mouthPatch.y - MOUTH_COVER_MARGIN))
    const width = Math.min(canvasW - x, Math.round(mouthPatch.width + MOUTH_COVER_MARGIN * 2))
    const height = Math.min(canvasH - y, Math.round(mouthPatch.height + MOUTH_COVER_MARGIN * 2))
    mouthCoverBox = { x, y, width, height }
    mouthCover = new Sprite(
      new Texture({ source: assets.body.source, frame: new Rectangle(x, y, width, height) }),
    )
    mouthCover.position.set(x, y)
    mouthCover.visible = false
    // ★ 必须插在口型图层**下面**：放上面就把口型自己遮掉了
    root.addChildAt(mouthCover, root.getChildIndex(mouth))
  }

  const hairFront = assets.hairFront ? new Sprite(assets.hairFront) : null
  if (hairFront) root.addChild(hairFront)

  // ── 程序化反应：点她之后的弹跳/歪头
  let reactionUntil = 0
  let reactionKind: 'head' | 'body' = 'body'

  // ── 轮廓遮罩
  const mask = await buildAlphaMask(assets)
  /** 底图是不是整张不透明（没抠背景）—— 见 hitTest 里的退化处理 */
  const maskOpaque = mask.opaqueRatio > 0.9
  if (maskOpaque && import.meta.env.DEV) {
    console.warn(
      `[portrait] 底图看起来没有透明背景（不透明像素占 ${(mask.opaqueRatio * 100).toFixed(0)}%），` +
        '轮廓判定会退化成矩形。建议把背景抠掉，否则桌宠的「只有她身上才响应」会失效。',
    )
  }

  // ── 布局
  let viewW = app.renderer.width
  let viewH = app.renderer.height
  let scale = 1

  const content = manifest.content
  const contentHeightPx = content ? content.height * canvasH : canvasH
  const contentWidthPx = content ? content.width * canvasW : canvasW

  /*
   * ★ 旋转/缩放的支点 = 角色**底部中点**（腰或脚）。
   *
   * 这是踩过的坑：root 不设 pivot 时，旋转是绕**画布左上角 (0,0)** 做的，
   * 而角色中心离那个角有 1600 多像素 —— 于是「微摆 ±2.8°」被当成半径 1600 的圆弧，
   * 整个人横向漂 ±80 像素、纵向也跟着画圈，看起来就是**一直在漂浮**，
   * 而不是站在原地轻微摇晃。呼吸缩放同理（绕角缩放会把底边推出去）。
   *
   * 绕底部中点就对了：脚（下半身边缘）钉住，上半身轻微晃，这才是待机该有的样子。
   */
  const pivotX = (content ? content.x + content.width / 2 : 0.5) * canvasW
  const pivotY = (content ? content.y + content.height : 1) * canvasH
  root.pivot.set(pivotX, pivotY)
  /** 静止时的屏幕位置（renderer 坐标），见 layout 里的说明 */
  let restX = 0
  let restY = 0

  const layout = (width: number, height: number) => {
    if (width <= 0 || height <= 0) return
    viewW = width
    viewH = height
    scale = height / contentHeightPx
    root.scale.set(scale)
    // 锚在底边居中：与 Live2D 那边的取景保持一致
    root.position.set((width - contentWidthPx * scale) / 2, height - (canvasH - (content?.y ?? 0) * canvasH) * scale)
    /*
     * 记下「静止时」的位置，供 anchor() 用。
     * ★ 必须在 layout 里算、而不是拿 root.position 现读：
     *   root.position 每帧都被待机和视线改，用它当视线基准会形成**负反馈**
     *   （她朝鼠标挪 → 相对角度变小 → 挪得更少），表现是"幅度比预期小、还发黏"。
     */
    restX = (width - contentWidthPx * scale) / 2 + pivotX * scale
    restY = height - (canvasH - (content?.y ?? 0) * canvasH) * scale + pivotY * scale
  }

  /*
   * 待机幅度。
   *
   * 默认值调小过一轮：原来 bobPercent 1.2% / swayDegrees 2.2°，配上「绕画布角旋转」
   * 那个 bug，看起来就像在飘。现在支点修对了（绕底部中点），幅度也收到
   * 「能看出在呼吸、但不注意就看不出来」的程度 —— 待机不该抢戏。
   * 嫌太静或太动，都能在 portrait.json 的 motion 里覆盖，或直接用
   * 设置 → 角色 → 待机动作 整体加减。
   */
  const motion = {
    bobPercent: opts.tuning?.motion?.bobPercent ?? manifest.motion?.bobPercent ?? 0.004,
    swayDegrees: opts.tuning?.motion?.swayDegrees ?? manifest.motion?.swayDegrees ?? 0.8,
    breatheScale: opts.tuning?.motion?.breatheScale ?? manifest.motion?.breatheScale ?? 0.004,
  }

  /** 口型的开合映射，同样可以按角色覆盖 */
  const mouthMap: MouthMapping = {
    closedLevel: opts.tuning?.mouth?.closedLevel ?? DEFAULT_MOUTH_MAPPING.closedLevel,
    minOpenScale: opts.tuning?.mouth?.minOpenScale ?? DEFAULT_MOUTH_MAPPING.minOpenScale,
  }

  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

  /** 当前显示的嘴型索引 / 眼睛状态 —— 换图是离散的，出问题时必须能一眼看出换到了哪张 */
  const shown = {
    mouthIndex: -1,
    mouthScale: 1,
    eyesOpen: true,
    jawStretch: 1,
    /** 瞳孔相对底图的偏移（画布像素），排查"眼睛没动"时看它 */
    pupilX: 0,
    pupilY: 0,
    /** 当前挂在脸上的表情 id（null = 素颜） */
    expression: null as string | null,
    /** 表情自带的嘴这一帧是否让给了口型 */
    expressionMouthYielded: false,
    /** 当前姿势 id（null = 底图那套） */
    pose: null as string | null,
    /** 底图 → 姿态的混合进度（0 = 全底图，1 = 全姿态） */
    poseMix: 0,
  }

  const applyFrame = (frame: CharacterFrame) => {
    const breath = clamp01(frame.ParamBreath)
    const now = performance.now()
    const reacting = now < reactionUntil
    const reactPhase = reacting ? (reactionUntil - now) / 420 : 0

    // 呼吸：上下浮动 + 轻微放大
    const bob = -breath * motion.bobPercent * contentHeightPx
    const breathe = 1 + breath * motion.breatheScale
    const s = scale * breathe
    // 头部偏转：归一化 → 位移/旋转（单位是「度」，Pixi 用弧度）
    const yaw = frame.ParamAngleX / ANGLE_X_RANGE
    const tilt = frame.ParamAngleZ / ANGLE_Z_RANGE
    const lean = frame.ParamBodyAngleX / BODY_ANGLE_RANGE

    let extraRot = 0
    let extraY = 0
    let extraX = 0
    if (reacting) {
      // 摸头：点头示意（前后小幅摆动）；戳身体：弹一下
      const damp = Math.sin(reactPhase * Math.PI * 3) * reactPhase
      if (reactionKind === 'head') {
        extraRot = damp * 4
        extraY = -Math.abs(damp) * 6
      } else {
        extraY = -Math.abs(damp) * 14
        extraRot = damp * 2
      }
      extraX = damp * 2
    }

    /*
     * 视线视差：整个人朝鼠标方向挪 + 歪一点。
     * 位移量按角色高度取比例，所以浏览器全屏和桌宠小窗看起来幅度一致。
     */
    const gazeX = frame.gazeX ?? 0
    const gazeY = frame.gazeY ?? 0
    const gazeShift = gazeX * GAZE_SHIFT_RATIO * contentHeightPx * s
    const gazeLift = gazeY * GAZE_LIFT_RATIO * contentHeightPx * s

    /*
     * 位置 = 基准位 + 缩放后支点的偏移。
     * 因为设了 pivot，Pixi 画的是 position + R·S·(local - pivot)，
     * 所以要把「支点本身也应落在基准位」这件事补回来，否则一设 pivot 整个角色会跳走。
     */
    root.position.set(
      (viewW - contentWidthPx * s) / 2 +
        yaw * 0.012 * contentWidthPx * s +
        extraX +
        pivotX * s +
        gazeShift,
      viewH - (canvasH - (content?.y ?? 0) * canvasH) * s + bob + extraY + pivotY * s - gazeLift,
    )
    root.rotation =
      ((tilt * motion.swayDegrees + lean * 0.6 + extraRot + gazeX * GAZE_ROLL_DEG) * Math.PI) / 180
    root.scale.set(s, s)

    // 前发比身体动得多一点，看起来有惯性
    if (hairFront) {
      hairFront.position.set(tilt * 3 + extraX * 0.5, breath * 2)
    }

    // 眨眼：换图（没有眼差分就什么都不做）
    const eyeOpen = clamp01((frame.ParamEyeLOpen + frame.ParamEyeROpen) / 2)
    if (eyes && assets.eyesClosed) {
      shown.eyesOpen = eyeOpen >= 0.5
      eyes.texture = shown.eyesOpen ? assets.eyesOpen! : assets.eyesClosed
    }

    /*
     * 瞳孔跟着视线平移。
     *
     * ★ 为什么要乘 eyeOpen：闭眼时瞳孔必须回到正中，否则眨眼瞬间会有一小块
     *   眼珠从闭眼图的边缘露出来（差分只覆盖了原位置的虹膜，移出去的部分盖不住）。
     *   顺带也更自然 —— 人眨眼时眼球本来就回中位。
     */
    if (pupil) {
      shown.pupilX = gazeX * PUPIL_SHIFT_MAX_PX * eyeOpen
      shown.pupilY = -gazeY * PUPIL_SHIFT_MAX_PX * PUPIL_LIFT_RATIO * eyeOpen
      pupil.position.set(shown.pupilX, shown.pupilY)
    }

    // 口型
    const m = clamp01(frame.mouth)
    /**
     * 这一帧口型是不是**真的叠了差分**（不是"闭嘴"那一档）。
     * 表情的嘴要不要让位就看它 —— 用开口度阈值判断是错的：
     * 阈值和 mouthMap.closedLevel 是两套数，改一个忘另一个就会"嘴闭着却盖着表情的嘴"。
     */
    let mouthArtDrawn = false
    if (mouth && mouthStates.length) {
      const pick = mouthLevel(m, mouthStates.length, mouthMap)
      shown.mouthIndex = pick.index
      shown.mouthScale = pick.scale
      mouth.texture = mouthStates[pick.index]
      mouthArtDrawn = pick.index > 0
      /*
       * 纵向缩放做出中间档。
       * 只有一张嘴差分时（最常见的情况），要是不缩放，口型就只剩「闭 / 全开」两态，
       * 而说话时振幅几乎一直在阈值以上 —— 看起来就是**全程张嘴**。
       * 横向**不缩放**：嘴的宽度收窄会让底图那条闭嘴线的两端露出来。
       */
      mouth.scale.set(1, pick.scale)
    } else if (jaw) {
      // 没嘴差分：拉伸下半张脸代替张嘴（幅度刻意克制，不然会像橡皮）
      shown.jawStretch = 1 + m * 0.05
      jaw.scale.set(1, shown.jawStretch)
    }

    /*
     * 表情。
     *
     * 到期就回到素颜（点击反应挂的是限时表情）；手动选的（exprUntil = 0）一直挂着。
     * 判断放在这里而不是用 setTimeout：每帧本来就要读 now，
     * 而且待机停下时（比如窗口隐藏）不该继续"计时"。
     */
    if (expr && exprUntil !== 0 && now >= exprUntil) {
      expr = null
      exprUntil = 0
    }
    if (exprLayer) {
      if (expr && exprLayer.texture !== expr.texture) exprLayer.texture = expr.texture
      exprLayer.visible = expr !== null
    }
    if (mouthCover) mouthCover.visible = expr !== null && mouthArtDrawn
    shown.expression = expr?.id ?? null
    /** 表情的嘴这一帧让给口型了吗（排查"两张嘴"时先看它） */
    shown.expressionMouthYielded = mouthCover ? mouthCover.visible : false

    /*
     * 姿态：底图和姿态图交叉淡入淡出。
     *
     * 用**时间**推进而不是每帧乘个系数：看得到的是"淡了多久"，
     * 乘系数会随帧率变化（144Hz 上比 60Hz 快一倍多，同一份代码两种手感）。
     */
    if (poseLayer) {
      if (pose && poseUntil !== 0 && now >= poseUntil) {
        pose = null
        poseUntil = 0
      }
      const dt = lastPoseAt === 0 ? 16 : Math.min(64, now - lastPoseAt)
      lastPoseAt = now
      const step = dt / POSE_FADE_MS
      const target = pose ? 1 : 0
      poseMix =
        target > poseMix ? Math.min(target, poseMix + step) : Math.max(target, poseMix - step)

      if (pose && poseLayer.texture !== pose.texture) poseLayer.texture = pose.texture
      poseLayer.alpha = poseMix
      poseLayer.visible = poseMix > 0.001
      // 底图整体淡出：姿态图里也有头和脸（且和底图逐像素一致），所以不会缺东西
      const bodyAlpha = 1 - poseMix
      for (const s of bodySprites) s.alpha = bodyAlpha
      shown.pose = pose?.id ?? null
      shown.poseMix = poseMix
    }
  }

  /**
   * 脸（或身体）在屏幕上的位置。
   *
   * 取命中区的中心 —— 命中区是从轮廓宽度剖面自动推出来的（脖子分界），
   * 所以不同立绘不用配坐标，脸在哪它就在哪。
   * 注意要跟着当前变换走：root 有位移/缩放/旋转，直接把画布坐标当屏幕坐标会偏。
   */
  const anchor = (part: 'head' | 'body' = 'head'): { x: number; y: number } | null => {
    const regions = manifest.regions ?? {}
    const r = part === 'head' ? regions.Head : regions.Body
    if (!r) return null

    // 画布像素 → 静止状态下的 renderer 坐标（用 restX/restY，不跟当前姿态走，见 layout 的说明）
    const localX = (r.x + r.width / 2) * canvasW
    const localY = (r.y + r.height / 2) * canvasH
    const worldX = restX + (localX - pivotX) * scale
    const worldY = restY + (localY - pivotY) * scale

    // renderer 坐标 → CSS 像素（autoDensity 下 canvas 的 CSS 尺寸 = 物理尺寸 / resolution）
    const res = app.renderer.resolution || 1
    const rect = app.canvas.getBoundingClientRect()
    return { x: rect.left + worldX / res, y: rect.top + worldY / res }
  }

  const hitTest = (clientX: number, clientY: number): boolean => {
    const rect = app.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    // 屏幕 → 画布比例坐标
    const nx = (clientX - rect.left) / rect.width
    const ny = (clientY - rect.top) / rect.height
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return false

    /*
     * 底图没有透明背景时（整张图都是不透明的），像素遮罩会变成「处处都命中」，
     * 轮廓判定就失去意义了。这时退化成「角色包围盒」矩形判定 ——
     * 虽然不精确，但至少不会让整块窗口都吃掉鼠标事件。
     */
    if (maskOpaque) {
      const c = manifest.content
      if (!c) return true
      return nx >= c.x && nx <= c.x + c.width && ny >= c.y && ny <= c.y + c.height
    }

    // 画布比例 → 遮罩坐标（遮罩覆盖整张画布）
    const mx = Math.min(mask.width - 1, Math.max(0, Math.round(nx * mask.width)))
    const my = Math.min(mask.height - 1, Math.max(0, Math.round(ny * mask.height)))
    return mask.alpha[my * mask.width + mx] > 40
  }

  const hitAreaAt = (clientX: number, clientY: number): string[] => {
    const rect = app.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return []
    const nx = (clientX - rect.left) / rect.width
    const ny = (clientY - rect.top) / rect.height

    const regions = manifest.regions ?? {}
    const hits: string[] = []
    for (const [name, r] of Object.entries(regions)) {
      if (nx >= r.x && nx <= r.x + r.width && ny >= r.y && ny <= r.y + r.height) {
        hits.push(name)
      }
    }
    return hits
  }

  const expressionNames = assets.expressions.map((e) => e.id)
  /** 纹理 → id：验证脚本要能说出"现在画的是哪一张脸" */
  const textureIds = new Map(assets.expressions.map((e) => [e.texture, e.id]))

  /**
   * 切表情（`null` = 素颜）。
   *
   * @param holdMs > 0 时限时挂一会儿后自动复原（点击反应走这条），0 = 一直挂着（手选）
   */
  const setExpression = (id: string | null, holdMs = 0): void => {
    if (id === null) {
      expr = null
      exprUntil = 0
      return
    }
    const found = assets.expressions.find((e) => e.id === id)
    if (!found) {
      // 认不出来就只警告、不动画面 —— 静默失败是这类功能最难查的故障
      if (import.meta.env.DEV) {
        console.warn(
          `[portrait] 没有这张表情：${id}｜可用：${expressionNames.join('、') || '（一张都没有）'}`,
        )
      }
      return
    }
    expr = found
    exprUntil = holdMs > 0 ? performance.now() + holdMs : 0
  }

  /*
   * 表情的「名字 → 情绪」表：立绘的表情情绪推不出来（Live2D 是从 exp3 驱动的参数推的），
   * 只能由文件名声明，声明表在 expressions.ts。
   */
  const expressionCatalog = assets.expressions.map((e) => ({
    name: e.id,
    mood: expressionSpec(e.id)?.mood ?? 'neutral',
  }))
  /** 最近给过的表情：连着戳同一个地方时换一张，别一直同一张脸 */
  const recentExpressions: string[] = []

  const poseNames = assets.poses.map((p) => p.id)
  /** 纹理 → id：验证脚本要能说出"现在摆的是哪个姿势" */
  const poseIds = new Map(assets.poses.map((p) => [p.texture, p.id]))

  /**
   * 换姿势（`null` = 回到底图那套）。
   *
   * @param holdMs > 0 时限时做这个动作、到点自己收回去（打招呼/点击反应走这条）；
   *                0 = 一直保持（手动在界面上选的）
   */
  const setPose = (id: string | null, holdMs = 0): void => {
    if (id === null) {
      pose = null
      poseUntil = 0
      return
    }
    const found = assets.poses.find((p) => p.id === id)
    if (!found) {
      if (import.meta.env.DEV) {
        console.warn(
          `[portrait] 没有这个姿势：${id}｜可用：${poseNames.join('、') || '（一张都没有）'}`,
        )
      }
      return
    }
    pose = found
    poseUntil = holdMs > 0 ? performance.now() + holdMs : 0
  }

  const abilities: CharacterAbilities = {
    lipSyncParams: [],
    expressionNames,
    motionGroups: {},
  }

  /** 打招呼用的姿势 id：有「招手」就用它（`poses.ts` 里的 id） */
  const GREETING_POSE = 'wave'
  const greet = (): void => {
    if (assets.poses.some((p) => p.id === GREETING_POSE)) setPose(GREETING_POSE, POSE_HOLD_MS)
  }

  const stage: PortraitCharacter = {
    kind: 'portrait',
    abilities,
    expressionNames,
    setExpression,
    poseNames,
    setPose,
    greet,
    layout,
    applyFrame,
    hitTest,
    hitAreaAt,
    anchor,
    react(areas: string[]) {
      reactionKind = areas[0] === 'Head' ? 'head' : 'body'
      reactionUntil = performance.now() + 420

      /*
       * 表情：复用 Live2D 那套情绪编排（摸头想要开心/害羞，戳身体想要惊讶/不满），
       * 只是情绪从文件名来而不是从参数推。
       *
       * ★ strict：没有对得上情绪的表情时**宁可不变脸**。
       *   Live2D 那边是「宁可重复也别没反应」—— 模型的表情是一整套，总能挑到一个；
       *   而立绘的表情是画师一张张画的：只有「生气」「伤心」两张素材时，
       *   摸头随机甩一张生气的脸，比没有反应更糟。
       */
      const picked = pickExpression(expressionCatalog, areas, recentExpressions, { strict: true })
      if (picked) {
        recentExpressions.unshift(picked)
        if (recentExpressions.length > 2) recentExpressions.pop()
        setExpression(picked, EXPRESSION_HOLD_MS)
      }

      if (import.meta.env.DEV) {
        const reaction = { areas, reaction: reactionKind, expression: picked ?? null }
        console.debug(`[stage] 被点了 ${JSON.stringify(reaction)}`)
        Object.assign(window as unknown as Record<string, unknown>, { __nexusLastPoke: reaction })
      }
    },
    destroy() {
      app.destroy(true, { children: true })
    },
  }

  layout(app.renderer.width, app.renderer.height)

  if (import.meta.env.DEV) {
    Object.assign(window as unknown as Record<string, unknown>, {
      __nexusPortrait: {
        stage,
        manifest: manifest as PortraitManifest,
        /** 当前显示的嘴型/眼睛状态，便于自动化断言 */
        shown,
        counts: {
          mouths: mouthStates.length,
          hasEyes: !!assets.eyesClosed,
          hasPupil: !!assets.pupil,
          hasHairFront: !!hairFront,
          hasHairBack: !!assets.hairBack,
          /** 闭嘴/睁眼是用「不叠加」补的（底图本身就是那个状态） */
          derivedClosedMouth: assets.derivedClosedMouth,
          derivedOpenEyes: assets.derivedOpenEyes,
          /** 表情差分实际加载到的张数（缺哪张就是"这个角色做不出这个表情"） */
          expressions: assets.expressions.length,
          /** 姿态差分实际加载到的张数 */
          poses: assets.poses.length,
        },
        /** 表情：可用的清单 + 手动切换入口（验证脚本靠它逐张看效果） */
        expressions: assets.expressions.map((e) => ({ id: e.id, label: e.label })),
        setExpression: (id: string | null, holdMs = 0) => setExpression(id, holdMs),
        /** 姿态：可用的清单 + 手动切换入口 */
        poses: assets.poses.map((p) => ({ id: p.id, label: p.label })),
        setPose: (id: string | null, holdMs = 0) => setPose(id, holdMs),
        /**
         * 图层的**真实**可见状态（从 Pixi 场景里读，不是从状态变量推）。
         *
         * 为什么非要读场景：`shown.expression` 只是"我打算显示哪张脸"，
         * setExpression 一调它就变了 —— 拿它断言等于自己证明自己。
         * 真正要验的是「那张差分确实被画上去了，而且说的时候嘴那块让开了」。
         */
        layers: () => ({
          expressionVisible: exprLayer?.visible ?? false,
          expressionId: exprLayer ? (textureIds.get(exprLayer.texture) ?? null) : null,
          expressionCount: assets.expressions.length,
          mouthCoverVisible: mouthCover?.visible ?? false,
          eyesVisible: eyes?.visible ?? false,
          poseVisible: poseLayer?.visible ?? false,
          poseId: poseLayer ? (poseIds.get(poseLayer.texture) ?? null) : null,
          poseCount: assets.poses.length,
          /** 底图 → 姿态的混合进度：1 = 完全换成姿态图 */
          poseMix,
          /** 底图的 alpha（换姿势时淡出，用来断言"没有两张脸叠着"） */
          bodyAlpha: bodySprites[0]?.alpha ?? 1,
        }),
        /** 说话时用来遮住「表情自带的嘴」的那个矩形（画布像素），排查"两张嘴"时看它 */
        mouthCoverBox,
        mask,
        /**
         * 当前的根变换（renderer 坐标）。
         * 视线跟随这类效果靠截图测量会被界面元素污染（鼠标一上来控制条就浮现），
         * 直接读数值才是可靠的验收方式。
         */
        transform: () => ({
          x: root.position.x,
          y: root.position.y,
          rotationDeg: (root.rotation * 180) / Math.PI,
          scale: root.scale.x,
          restX,
          restY,
        }),
      },
    })
  }

  return stage
}
