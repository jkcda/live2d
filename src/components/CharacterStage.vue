<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { createLive2DCharacter, type Live2DCharacter } from '@/core/character/live2d'
import { createPortraitStage, type PortraitCharacter } from '@/core/portrait/stage'
import { expressionLabel } from '@/core/portrait/expressions'
import { poseLabel } from '@/core/portrait/poses'
import type { CharacterFrame, CharacterStage } from '@/core/character/types'
import { resolveModelUrl } from '@/core/live2d/models'
import { classify } from '@/core/live2d/reactions'
import { LipSyncDriver } from '@/core/live2d/lipsync'
import { IdleAnimator, type IdleFrame } from '@/core/live2d/idle'
import { GazeDriver } from '@/core/character/gaze'
import { initCharacter, onCharacterChange, selectCharacter, type PackState } from '@/core/character/selection'
import { idleRuntime } from '@/core/settings'
import { audioPlayer } from '@/core/runtime'

/**
 * Live2D 模型的路径（模型不随仓库分发，受 Live2D 授权条款限制）。
 *
 * 当前用官方示例 Haru —— 它带 8 个表情 + Head/Body 命中区，口型落点也正常。
 * 换模型时用 handle 的能力接口先看两件事：
 *   1. 有 Groups.LipSync（否则口型无处可写，比如 Mao 是 ParamA）
 *   2. 有 Expressions / HitAreas（否则表情和点击反馈做不了，比如 miara 两样都没有）
 */

/**
 * 角色舞台。
 *
 * ★ 这里做的核心事情是**热插拔**：切换角色不需要刷新页面。
 *   以前舞台是 onMounted 里一次性建的，换个角色只能 location.reload()；
 *   现在拆成 mount(pack) / unmount()：
 *     销毁旧渲染器 → 清空容器 → 建新的，音频队列和对话会话都不受影响。
 *   切换失败（素材缺失）会**回退到原来的角色**并报错，不会切成一片空白。
 *
 * 角色从哪来：`core/character/selection.ts`（清单见 public/characters/index.json）。
 * 开发期可以用 ?pack=<id> 指定角色，?portrait=1 / ?live2d=1 按类型挑一个（见 packs.ts）。
 */

function modelOverride(): string | undefined {
  if (!import.meta.env.DEV) return undefined
  const q = new URLSearchParams(window.location.search).get('model')
  return q ?? undefined
}

const emit = defineEmits<{ hover: [on: boolean] }>()

const host = ref<HTMLElement | null>(null)
const status = ref('模型加载中…')
const failed = ref(false)
/** 指针是否停在角色轮廓上 —— 桌宠形态下这是 UI 浮现的依据 */
const hovering = ref(false)
/**
 * 测试条是否可见。
 *
 * ★ 不能直接绑 hovering —— 测试条在右上角，而 hovering 只表示「鼠标在她身上」，
 *   人把鼠标从她身上移到按钮的这几百毫秒里 hovering 已经是 false，
 *   按钮当场消失，单鼠标根本点不到（自动化测试用瞬时点击反而测不出来）。
 *   所以：指针停在按钮上时保持显示，另外留一段迟滞时间跨越中间的空白。
 */
const barHovered = ref(false)
const barVisible = ref(false)
let barHideAt = 0
/** 移开后延迟多久收起（毫秒）—— 够人把鼠标移到按钮上 */
const BAR_HIDE_DELAY_MS = 600
/** 当前渲染器（立绘 / Live2D），显示在状态里便于确认 */
const kindLabel = ref('')
/** 当前角色名，显示在测试条上 */
const packName = ref('')

/**
 * 表情：素材里实际存在的那几张（只有立绘才有）。
 *
 * 为什么做成按钮而不是"让她自己随机换"：表情是**看一眼就知道对不对**的东西，
 * 让用户靠戳身体碰运气试出来太别扭；而且素材少了以后，
 * 随机挑很容易出现"摸头却甩一张生气的脸"，那比没反应更糟。
 */
const expressionIds = ref<string[]>([])
/** 手动选中的表情（null = 素颜）。点击反应给的是限时表情，不进这里 */
const activeExpression = ref<string | null>(null)
const expressionChips = computed(() =>
  expressionIds.value.map((id) => ({ id, label: expressionLabel(id) })),
)

/** 点一下换这张脸，再点一下收回素颜 */
function toggleExpression(id: string): void {
  if (!portrait) return
  const next = activeExpression.value === id ? null : id
  activeExpression.value = next
  portrait.setExpression(next)
}

/**
 * 姿势（招手之类）：一张整身替换图，和底图交叉淡入淡出。
 *
 * 和表情一样做成按钮，理由更硬：**姿势只在"她做动作"的那几秒看得到**，
 * 而什么时候做动作是个语义问题（打招呼？被点？）——
 * 没定下来之前，至少得能手动看一眼素材对不对。
 */
const poseIds = ref<string[]>([])
const activePose = ref<string | null>(null)
const poseChips = computed(() => poseIds.value.map((id) => ({ id, label: poseLabel(id) })))

/** 点一下摆这个姿势（一直保持），再点一下回到原来的姿势 */
function togglePose(id: string): void {
  if (!portrait) return
  const next = activePose.value === id ? null : id
  activePose.value = next
  portrait.setPose(next)
}

let stage: CharacterStage | null = null
/**
 * 立绘舞台（有表情时要用它多出来的 `setExpression`）。
 * 单独留一份引用而不是每次 `stage as PortraitCharacter`：
 * 类型断言在换渲染器时不会报错，只会静默地不工作。
 */
let portrait: PortraitCharacter | null = null
let idle: IdleAnimator | null = null
let lipsync: LipSyncDriver | null = null
/** 视线驱动：鼠标在哪她就往哪看（渲染器无关，见 core/character/gaze.ts） */
const gaze = new GazeDriver()
let rafId = 0
let lastTs = 0
let resizeObserver: ResizeObserver | null = null
/** 最近一次指针位置，供 rAF 里做命中判定（避免在 pointermove 里直接采样） */
let pointer: { x: number; y: number } | null = null
let lastHitAt = 0
/** 当前生效的角色状态（热插拔时要拿它对比 / 回退） */
let packState: PackState | null = null
/** 帧循环里读的待机幅度：角色可以覆盖全局设置 */
let idleFactor = 1
/** 角色变化订阅的取消函数 */
let unsubscribePack: (() => void) | null = null
/** 正在切换的角色 id（防重入，见 switchPack） */
let switching: string | null = null
/** 切换途中排队的下一个角色 id */
let pendingId: string | null = null

/**
 * 按「待机幅度」设置衰减参数帧。
 *
 * 只衰减**动作**类参数（呼吸/视线/微摆），**不碰眼睛开合** ——
 * 眨眼是「她活着」的最小信号，关掉待机也该保留，否则真成贴图了。
 *
 * 呼吸要绕 0.5 收缩而不是乘系数：ParamBreath 是 0~1 的半程值，
 * 直接乘会让「关掉待机」变成一直吸气（停在 0，也就是呼气到底）。
 */
function dampIdle(f: IdleFrame, k: number): IdleFrame {
  if (k === 1) return f
  return {
    ParamEyeLOpen: f.ParamEyeLOpen,
    ParamEyeROpen: f.ParamEyeROpen,
    ParamBreath: 0.5 + (f.ParamBreath - 0.5) * k,
    ParamEyeBallX: f.ParamEyeBallX * k,
    ParamEyeBallY: f.ParamEyeBallY * k,
    ParamAngleX: f.ParamAngleX * k,
    ParamAngleY: f.ParamAngleY * k,
    ParamAngleZ: f.ParamAngleZ * k,
    ParamBodyAngleX: f.ParamBodyAngleX * k,
  }
}

/**
 * 每帧合成参数并交给渲染器。
 *
 * 参数是 Live2D 的参数名，但它们同时是**语义名**：
 * 待机（呼吸/眨眼/视线/微摆）来自 IdleAnimator，口型来自音频振幅。
 * 立绘渲染器把同样的语义解释成位移/旋转/换图，所以两种角色的节奏一致。
 */
function frame(ts: number) {
  rafId = requestAnimationFrame(frame)
  if (!stage || !idle || !lipsync) return

  // 首帧或卡顿后，把 dt 夹在合理区间，避免参数瞬移
  const dt = lastTs === 0 ? 16 : Math.min(64, ts - lastTs)
  lastTs = ts

  const idleFrame = idle.update(dt)
  const mouth = lipsync.update(audioPlayer.amplitude(), dt)

  /*
   * 视线：指针在 → 看向指针；指针离开窗口 → 慢慢失焦（回落曲线见 gaze.ts）。
   * 基准点是**她的脸在屏幕上的位置**，由渲染器给（用窗口中心算会偏，见 types.ts）。
   */
  gaze.aim(pointer, stage.anchor('head'))
  /*
   * 开发期：允许外部直接指定这一帧看向哪（`window.__nexusGazeOverride = {x,y}`）。
   *
   * 为什么需要：验证脚本没法可靠地"移动鼠标" —— 派进去的合成鼠标事件会被
   * **真实指针**的事件盖掉（窗口里物理鼠标一动就发 pointermove），
   * 于是测出来的视线方向跟注入值毫无关系，白排查半天。
   * 有覆盖值就与指针无关，这个用例才是确定的。
   */
  if (import.meta.env.DEV) {
    const ov = (window as unknown as { __nexusGazeOverride?: { x: number; y: number } | null })
      .__nexusGazeOverride
    if (ov) gaze.aimAt(ov.x, ov.y)
  }
  const g = gaze.update(dt)

  const next: CharacterFrame = {
    ...dampIdle(idleFrame, idleFactor),
    mouth,
    gazeX: g.x,
    gazeY: g.y,
  }
  stage.applyFrame(next)

  // 验证脚本要确认「参数真的送到了渲染器」，光看驱动层的值不算
  if (import.meta.env.DEV) {
    const dbg = (
      window as unknown as {
        __nexusStage?: { lastFrame: CharacterFrame | null; pointer: unknown; anchor: unknown }
      }
    ).__nexusStage
    if (dbg) {
      dbg.lastFrame = next
      // 指针和锚点一起留下来：视线不对时，先分清是"算错了"还是"指针根本没更新"
      dbg.pointer = pointer ? { x: Math.round(pointer.x), y: Math.round(pointer.y) } : null
      dbg.anchor = stage.anchor('head')
    }
  }

  /*
   * 悬浮检测：轮廓判定，节流到 ~30Hz。
   * 复用渲染循环，避免为了判定悬浮再开一条定时器。
   */
  if (pointer && ts - lastHitAt >= 33) {
    lastHitAt = ts
    const on = stage.hitTest(pointer.x, pointer.y)
    if (on !== hovering.value) {
      hovering.value = on
      emit('hover', on)
    }
  }

  /*
   * 测试条的显隐：在她身上、或在按钮上 → 立刻显示；
   * 两者都不满足 → 等 BAR_HIDE_DELAY_MS 再收，让人来得及把鼠标移过去。
   */
  if (hovering.value || barHovered.value) {
    barVisible.value = true
    barHideAt = 0
  } else if (barVisible.value) {
    if (barHideAt === 0) barHideAt = ts + BAR_HIDE_DELAY_MS
    else if (ts >= barHideAt) {
      barVisible.value = false
      barHideAt = 0
    }
  }
}

function onPointerMove(e: PointerEvent) {
  pointer = { x: e.clientX, y: e.clientY }
}

function onPointerLeave() {
  pointer = null
  if (hovering.value) {
    hovering.value = false
    emit('hover', false)
  }
}

function onPointerDown(e: PointerEvent) {
  // 只响应落在她身上的按下；点在空白处不该有反应
  if (!stage || e.button !== 0) return
  if (!stage.hitTest(e.clientX, e.clientY)) return
  stage.react(stage.hitAreaAt(e.clientX, e.clientY))
}

/**
 * 合成一段带说话节奏的测试音，用来在接 TTS 之前验证口型链路。
 *
 * ★ 关键是要有**真正的静音段**。
 *   第一版是连续音（每 0.28s 一个包络、峰谷之间不断开），结果振幅永远在闭嘴阈值以上，
 *   看起来就是「全程张嘴、根本不会闭」—— 那不是口型坏了，是这段测试音测不出来。
 *   所以现在按「音节 + 停顿」来：0.22s 出声、0.13s 静音，每 4 个音节后停长一点。
 *   静音够长（> 口型的 releaseMs）嘴才闭得下来。
 */
function makeTestSpeech(): AudioBuffer {
  const ctx = audioPlayer.context
  const sr = ctx.sampleRate
  const buffer = ctx.createBuffer(1, Math.floor(sr * 3.4), sr)
  const ch = buffer.getChannelData(0)

  const BURST = 0.22
  const GAP = 0.13
  const PHRASE_GAP = 0.4

  let t = 0
  let syllable = 0
  while (t < 3.4) {
    const dur = BURST
    const start = Math.floor(t * sr)
    const end = Math.min(ch.length, Math.floor((t + dur) * sr))
    for (let i = start; i < end; i++) {
      const local = (i - start) / sr
      const p = local / dur
      // 起音快、收音更快，模拟音节的爆开与收住
      const env = Math.min(1, p / 0.12) * Math.pow(1 - p, 0.8)
      const f0 = 175 + Math.sin(syllable * 1.7) * 45 + Math.sin((i / sr) * 6.1) * 14
      ch[i] = Math.sin(2 * Math.PI * f0 * (i / sr)) * env * 0.34
    }
    syllable++
    // 每 4 个音节来一次长停顿，让人看清「说完了嘴闭上」
    t += dur + (syllable % 4 === 0 ? PHRASE_GAP : GAP)
  }
  return buffer
}

function testLipSync() {
  audioPlayer.playBuffer(makeTestSpeech())
}

/** 打断演示：立刻掐断音频，口型同步归零 */
function testInterrupt() {
  audioPlayer.stop()
  lipsync?.reset()
}

/**
 * 建舞台（可重复调用）。
 *
 * 每次都会**先清空容器**：旧渲染器的画布必须自己移掉 ——
 * Pixi 的 destroy 只释放资源，不保证把 <canvas> 从 DOM 摘干净，
 * 留着的话新角色会叠在旧角色上面（表现为"换了角色但没变"）。
 */
async function mount(s: PackState): Promise<void> {
  const el = host.value
  if (!el) return
  const pack = s.pack

  // 待机幅度：角色自己的 tuning 优先，否则用设置里的全局值
  idleFactor = pack.tuning?.idleFactor ?? idleRuntime.factor

  if (pack.kind === 'portrait') {
    status.value = `立绘加载中…（${pack.name}）`
    const created = await createPortraitStage(el, {
      baseUrl: pack.dir ?? 'portrait',
      tuning: pack.tuning,
    })
    stage = created
    portrait = created
    expressionIds.value = created.expressionNames
    poseIds.value = created.poseNames
    kindLabel.value = '立绘'
  } else {
    status.value = `模型加载中…（${pack.name}）`
    const url = await resolveModelUrl(modelOverride() ?? pack.model)
    const live2d = await createLive2DCharacter(el, { url })
    stage = live2d
    kindLabel.value = 'Live2D'
    // 换到 Live2D：把立绘那套入口收掉（它的表情/姿态走模型自己的资源）
    portrait = null
    expressionIds.value = []
    poseIds.value = []
    logAbilities(live2d)
  }
  // 换了角色就回到原始状态：上一次选的属于上一个角色，素材可能根本没这张
  activeExpression.value = null
  activePose.value = null

  // 口型手感可以按角色调（比如某个角色的立绘振幅偏小）
  lipsync = new LipSyncDriver(pack.tuning?.lipsync)
  idle ??= new IdleAnimator()
  lastTs = 0
  cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(frame)

  packState = s
  packName.value = pack.name
  status.value = ''
  failed.value = false
  console.info(
    `[stage] 角色就位：${pack.name}（${pack.kind}）｜能力 ${JSON.stringify(s.features)}` +
      `${s.probe ? `｜素材 ${JSON.stringify(s.probe)}` : ''}`,
  )

  /*
   * 她登场时打个招呼：有「招手」素材就招一次（限时 3.2s，自己收回），没有就什么都不做。
   * 放在 mount 里而不是 onMounted：切换角色也算"她重新登场"，手感一致；
   * 而且用户换完角色立刻能看到她动一下，而不是对着一张静止的图怀疑切换失败了。
   */
  portrait?.greet()

  if (import.meta.env.DEV) {
    // 开发期调试钩子：自动化脚本靠它读到舞台 / 口型 / 音频的真实状态
    Object.assign(window as unknown as Record<string, unknown>, {
      __nexusStage: {
        kind: pack.kind,
        pack,
        stage,
        idle,
        lipsync,
        gaze,
        audioPlayer,
        features: s.features,
        /** 最近一帧参数（验证视线/口型有没有真的送到渲染器） */
        lastFrame: null as CharacterFrame | null,
        /** 最近一次指针位置与脸的位置（排查"视线不对"时先看这两个） */
        pointer: null as { x: number; y: number } | null,
        anchor: null as { x: number; y: number } | null,
      },
    })
  }
}

/** 卸载舞台：停帧循环、销毁渲染器、清空容器 */
function unmount(): void {
  cancelAnimationFrame(rafId)
  rafId = 0
  pointer = null
  hovering.value = false
  stage?.destroy()
  stage = null
  portrait = null
  // 渲染器可能留了 canvas / 调试用元素，一律清掉
  if (host.value) host.value.replaceChildren()
}

/**
 * 切换角色：先建新的，失败就回退。
 *
 * 顺序很重要 —— 先 unmount 再 mount 的话，一旦新素材有问题，
 * 用户面对的是一片空白且不知道原因；这里改成**建成功了才销毁旧的**，
 * 失败时把旧角色重新挂回来并显示错误。
 *
 * ★ 必须防重入：selectCharacter 会通知订阅者，而订阅者见"选中变了"又会调回这里 ——
 *   不加锁就是**无限递归**（每轮都新建一个舞台），第一次写出来直接把页面跑死了。
 *   所以：自己发起的那次变化用 `switching` 挡掉；切换途中来的新请求记到 `pending`，
 *   等这一轮结束再处理（用户连点两次不该丢第二次）。
 */
async function switchPack(id: string): Promise<void> {
  if (switching) {
    pendingId = id
    return
  }
  switching = id
  const previous = packState
  try {
    const next = await selectCharacter(id)
    unmount()
    await mount(next)
  } catch (err) {
    failed.value = true
    status.value = err instanceof Error ? err.message : String(err)
    console.error('[stage] 切换角色失败，回退到上一个', err)
    if (previous) {
      try {
        unmount()
        await mount(previous)
        status.value = `切换失败，仍在使用「${previous.pack.name}」：${status.value}`
      } catch {
        // 回退也失败就只剩错误信息了
      }
    }
  } finally {
    switching = null
    const queued = pendingId
    pendingId = null
    if (queued && queued !== packState?.pack.id) void switchPack(queued)
  }
}

onMounted(async () => {
  const el = host.value
  if (!el) return

  try {
    const s = await initCharacter()
    await mount(s)

    resizeObserver = new ResizeObserver(() => {
      if (stage && el) stage.layout(el.clientWidth, el.clientHeight)
    })
    resizeObserver.observe(el)

    unsubscribePack = onCharacterChange((next) => {
      // 这次变化就是自己发起的（selectCharacter 会回调订阅者）→ 跳过，否则无限递归
      if (switching === next.pack.id) return
      // 只处理"选中变了但舞台还没跟上"的情况（切换动作由 switchPack 负责）
      if (next.pack.id !== packState?.pack.id) void switchPack(next.pack.id)
    })
  } catch (err) {
    failed.value = true
    status.value = err instanceof Error ? err.message : String(err)
    console.error('[stage] 加载失败', err)
  }
})

/** 开发期把模型能力打出来 —— 换模型时一眼就能判断能不能用 */
function logAbilities(live2d: Live2DCharacter): void {
  if (!import.meta.env.DEV) return
  const { abilities, model } = live2d
  console.info(
    `[stage] 模型能力：口型=${abilities.lipSyncParams[0] ?? '(未声明)'}｜表情 ${abilities.expressionNames.length} 个｜动作组`,
    abilities.motionGroups,
  )
  if (model.expressionDrives.length) {
    // 情绪是从 exp3 驱动的参数推出来的（见 reactions.ts），打出来便于核对
    console.info(
      '[stage] 表情情绪：',
      classify(model.expressionDrives)
        .map((e) => `${e.name}=${e.mood}`)
        .join(' '),
    )
  }
}

onUnmounted(() => {
  unsubscribePack?.()
  resizeObserver?.disconnect()
  // 不要 dispose 共享的 audioPlayer —— 它是全局单例，关掉会让整个应用失去音频
  unmount()
})
</script>

<template>
  <div
    class="stage"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
    @pointerdown="onPointerDown"
  >
    <div ref="host" class="canvas-host" />

    <div v-if="status" class="overlay" :class="{ failed }">
      <p class="title">{{ failed ? '角色加载失败' : status }}</p>
      <p v-if="failed" class="hint">
        立绘模式：把素材放到 <code>public/portrait/</code>（至少要一张 <code>body.png</code>
        和一份 <code>portrait.json</code>）。<br />
        Live2D 模式：模型受 Live2D 授权条款限制不随仓库分发，需自行下载后放到
        <code>public/models/&lt;名字&gt;/</code>，或把 <code>EXPLICIT_MODEL</code>
        指向具体的 <code>.model3.json</code>。
      </p>
      <pre v-if="failed" class="detail">{{ status }}</pre>
    </div>

    <!-- 开发用的链路验证按钮：桌宠形态下不该常驻，跟着悬浮一起浮现 -->
    <Transition name="fade">
      <div
        v-if="!status && barVisible"
        class="test-bar no-drag"
        @pointerenter="barHovered = true"
        @pointerleave="barHovered = false"
        @pointerdown.stop
      >
        <span class="tag">{{ kindLabel }}</span>
        <span v-if="packName" class="name">{{ packName }}</span>
        <button class="btn" @click="testLipSync">测试口型</button>
        <button class="btn" @click="testInterrupt">打断</button>
        <!-- 表情：一个角色有哪些差分就显示哪几个（没有就整排不出现） -->
        <button
          v-for="chip in poseChips"
          :key="`pose-${chip.id}`"
          class="btn"
          :class="{ on: activePose === chip.id }"
          :title="`姿势：${chip.label}（再点一下回到原姿势）`"
          @click="togglePose(chip.id)"
        >
          {{ chip.label }}
        </button>
        <button
          v-for="chip in expressionChips"
          :key="chip.id"
          class="btn"
          :class="{ on: activeExpression === chip.id }"
          :title="`表情：${chip.label}（再点一下收回）`"
          @click="toggleExpression(chip.id)"
        >
          {{ chip.label }}
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.stage {
  position: relative;
  width: 100%;
  height: 100%;
}

.canvas-host {
  width: 100%;
  height: 100%;
}

.canvas-host :deep(canvas) {
  display: block;
}

.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px 18px;
  text-align: center;
  color: #9a9aa4;
  font-size: 13px;
  /* 长 URL 和代码片段不能把容器撑破 */
  overflow-wrap: anywhere;
}

.overlay > * {
  max-width: 100%;
}

.overlay.failed .title {
  color: #e07878;
}

.title {
  font-size: 14px;
}

.hint {
  line-height: 1.8;
  color: #7a7a84;
  overflow-wrap: anywhere;
}

.hint code,
.detail {
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
}

.hint code {
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  color: #b8c8e0;
}

.detail {
  box-sizing: border-box;
  width: 100%;
  max-height: 140px;
  overflow-y: auto;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.35);
  color: #c88;
  text-align: left;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.test-bar {
  position: absolute;
  right: 10px;
  top: 10px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.tag {
  font-size: 11px;
  padding: 3px 7px;
  border-radius: 5px;
  background: rgba(90, 120, 200, 0.28);
  border: 1px solid rgba(120, 150, 220, 0.35);
  color: #b8c8e0;
}

/* 角色名：弱化显示，只是让人确认「现在是谁」 */
.name {
  font-size: 11px;
  padding: 3px 7px;
  border-radius: 5px;
  background: rgba(24, 24, 28, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #a0a0aa;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn {
  border: none;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  font-family: inherit;
  color: #d8d8dc;
  background: rgba(24, 24, 28, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.1);
  cursor: pointer;
  transition: background 0.15s ease;
}

.btn:hover {
  background: rgba(255, 255, 255, 0.16);
}

/* 选中的表情：一眼看出"现在这张脸是我选的"，再点一下收回 */
.btn.on {
  background: rgba(90, 120, 200, 0.45);
  border-color: rgba(140, 170, 235, 0.6);
  color: #eaeefb;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
