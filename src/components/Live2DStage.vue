<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { createStage, type Stage } from '@/core/live2d/engine'
import { resolveModelUrl } from '@/core/live2d/models'
import { LipSyncDriver } from '@/core/live2d/lipsync'
import { IdleAnimator } from '@/core/live2d/idle'
import { AudioPlayer } from '@/core/audio/player'

/**
 * 模型不随仓库分发（受 Live2D 授权条款限制）。
 * 留空则自动探测 public/models/ 下的常见命名；
 * 想固定某个模型就填相对路径，例如 'Haru/Haru.model3.json'。
 */
const EXPLICIT_MODEL = ''

const host = ref<HTMLElement | null>(null)
const status = ref('模型加载中…')
const failed = ref(false)

let stage: Stage | null = null
let idle: IdleAnimator | null = null
let lipsync: LipSyncDriver | null = null
let rafId = 0
let lastTs = 0
let resizeObserver: ResizeObserver | null = null

const player = new AudioPlayer()

/**
 * 每帧合成参数。
 * 待机层永远在跑（角色的底色），口型层只在有音频时有值。
 */
function frame(ts: number) {
  rafId = requestAnimationFrame(frame)
  if (!stage || !idle || !lipsync) return

  // 首帧或卡顿后，把 dt 夹在合理区间，避免参数瞬移
  const dt = lastTs === 0 ? 16 : Math.min(64, ts - lastTs)
  lastTs = ts

  const idleFrame = idle.update(dt)
  const mouthOpen = lipsync.update(player.amplitude(), dt)

  stage.model.setParams({
    ...idleFrame,
    ParamMouthOpenY: mouthOpen,
  })
}

/**
 * 合成一段带说话节奏的测试音，用来在接 TTS 之前验证口型链路。
 * 音高在 150~260Hz 间游走，每 0.28s 一个音节包络。
 */
function makeTestSpeech(): AudioBuffer {
  const ctx = player.context
  const sr = ctx.sampleRate
  const buffer = ctx.createBuffer(1, Math.floor(sr * 3.2), sr)
  const ch = buffer.getChannelData(0)

  for (let i = 0; i < ch.length; i++) {
    const t = i / sr
    const phase = (t % 0.28) / 0.28
    const env = Math.pow(Math.sin(Math.PI * phase), 1.6)
    const f0 = 190 + Math.sin(t * 2.1) * 55 + Math.sin(t * 5.7) * 20
    ch[i] = Math.sin(2 * Math.PI * f0 * t) * env * 0.32
  }
  return buffer
}

function testLipSync() {
  player.playBuffer(makeTestSpeech())
}

/** 打断演示：立刻掐断音频，口型同步归零 */
function testInterrupt() {
  player.stop()
  lipsync?.reset()
}

onMounted(async () => {
  const el = host.value
  if (!el) return

  try {
    const url = await resolveModelUrl(EXPLICIT_MODEL || undefined)
    stage = await createStage(el, { url })
    idle = new IdleAnimator()
    lipsync = new LipSyncDriver()

    status.value = ''
    rafId = requestAnimationFrame(frame)

    resizeObserver = new ResizeObserver(() => {
      if (stage && el) stage.layout(el.clientWidth, el.clientHeight)
    })
    resizeObserver.observe(el)
  } catch (err) {
    failed.value = true
    status.value = err instanceof Error ? err.message : String(err)
    console.error('[stage] 模型加载失败', err)
  }
})

onUnmounted(() => {
  cancelAnimationFrame(rafId)
  resizeObserver?.disconnect()
  player.dispose()
  stage?.destroy()
  stage = null
})
</script>

<template>
  <div class="stage">
    <div ref="host" class="canvas-host" />

    <div v-if="status" class="overlay" :class="{ failed }">
      <p class="title">{{ failed ? '模型加载失败' : status }}</p>
      <p v-if="failed" class="hint">
        模型不随仓库分发（受 Live2D 授权条款限制）。<br />
        下载一个 Cubism 3/4/5 模型解压到 <code>public/models/&lt;名字&gt;/</code>，<br />
        或在本组件顶部把 <code>EXPLICIT_MODEL</code> 指向具体的 <code>.model3.json</code>
      </p>
      <pre v-if="failed" class="detail">{{ status }}</pre>
    </div>

    <div v-if="!status" class="test-bar no-drag">
      <button class="btn" @click="testLipSync">测试口型</button>
      <button class="btn" @click="testInterrupt">打断</button>
    </div>
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
  padding: 24px;
  text-align: center;
  color: #9a9aa4;
  font-size: 13px;
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
  max-width: 100%;
  max-height: 120px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.35);
  color: #c88;
  text-align: left;
  white-space: pre-wrap;
  word-break: break-all;
}

.test-bar {
  position: absolute;
  right: 10px;
  top: 10px;
  display: flex;
  gap: 6px;
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
</style>
