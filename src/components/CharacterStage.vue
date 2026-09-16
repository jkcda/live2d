<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { createLive2DCharacter, type Live2DCharacter } from '@/core/character/live2d'
import { createPortraitStage } from '@/core/portrait/stage'
import { resolveCharacterKind } from '@/core/character/mode'
import type { CharacterFrame, CharacterStage } from '@/core/character/types'
import { resolveModelUrl } from '@/core/live2d/models'
import { classify } from '@/core/live2d/reactions'
import { LipSyncDriver } from '@/core/live2d/lipsync'
import { IdleAnimator, type IdleFrame } from '@/core/live2d/idle'
import { idleRuntime } from '@/core/settings'
import { audioPlayer } from '@/core/runtime'

/**
 * Live2D 模型的路径（模型不随仓库分发，受 Live2D 授权条款限制）。
 *
 * 当前用官方示例 Haru —— 它带 8 个表情 + Head/Body 命中区，口型落点也正常。
 * 换模型时用 handle 的能力接口先看两件事：
 *   1. 有 Groups.LipSync（否则口型无处可写，比如 Mao 是 ParamA）
 *   2. 有 Expressions / HitAreas（否则表情和点击反馈做不了，比如 miara 两样都没有）
 *
 * 开发期可以用 ?model=<目录>/<文件>.model3.json 临时换模型，
 * 或用 ?portrait=1 切到立绘模式（素材放 public/portrait/）。
 */
const EXPLICIT_MODEL = 'Haru/Haru.model3.json'

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

let stage: CharacterStage | null = null
let idle: IdleAnimator | null = null
let lipsync: LipSyncDriver | null = null
let rafId = 0
let lastTs = 0
let resizeObserver: ResizeObserver | null = null
/** 最近一次指针位置，供 rAF 里做命中判定（避免在 pointermove 里直接采样） */
let pointer: { x: number; y: number } | null = null
let lastHitAt = 0

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

  const next: CharacterFrame = { ...dampIdle(idleFrame, idleRuntime.factor), mouth }
  stage.applyFrame(next)

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

onMounted(async () => {
  const el = host.value
  if (!el) return

  const kind = resolveCharacterKind()

  try {
    if (kind === 'portrait') {
      status.value = '立绘加载中…'
      stage = await createPortraitStage(el)
      kindLabel.value = '立绘'
    } else {
      const url = await resolveModelUrl(modelOverride() ?? (EXPLICIT_MODEL || undefined))
      const live2d = await createLive2DCharacter(el, { url })
      stage = live2d
      kindLabel.value = 'Live2D'
      logAbilities(live2d)
    }

    idle = new IdleAnimator()
    lipsync = new LipSyncDriver()
    status.value = ''
    rafId = requestAnimationFrame(frame)

    // 开发期调试钩子：自动化脚本靠它读到舞台 / 口型 / 音频的真实状态
    if (import.meta.env.DEV) {
      Object.assign(window as unknown as Record<string, unknown>, {
        __nexusStage: { kind, stage, idle, lipsync, audioPlayer },
      })
    }

    resizeObserver = new ResizeObserver(() => {
      if (stage && el) stage.layout(el.clientWidth, el.clientHeight)
    })
    resizeObserver.observe(el)
  } catch (err) {
    failed.value = true
    status.value =
      err instanceof Error ? err.message : String(err)
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
  cancelAnimationFrame(rafId)
  resizeObserver?.disconnect()
  // 不要 dispose 共享的 audioPlayer —— 它是全局单例，关掉会让整个应用失去音频
  stage?.destroy()
  stage = null
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
      >
        <span class="tag">{{ kindLabel }}</span>
        <button class="btn" @click="testLipSync">测试口型</button>
        <button class="btn" @click="testInterrupt">打断</button>
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

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
