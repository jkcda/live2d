<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Live2DStage from './components/Live2DStage.vue'

const version = ref('0.1.0')
const passthrough = ref(false)
const showBar = ref(true)

onMounted(async () => {
  if (window.nexus) {
    version.value = await window.nexus.version()
  }
})

/** 切换点击穿透：穿透后鼠标事件直接落到桌面上 */
async function togglePassthrough() {
  passthrough.value = !passthrough.value
  await window.nexus?.setInteractive(!passthrough.value)
}

async function quit() {
  await window.nexus?.quit()
}
</script>

<template>
  <div class="app" :class="{ passthrough }">
    <!-- 顶部拖动条：唯一可拖动窗口的区域，避免和角色交互打架 -->
    <div class="title-strip drag-handle" @mouseenter="showBar = true" />

    <main class="stage-area">
      <Live2DStage />
    </main>

    <Transition name="bar">
      <div v-if="showBar && !passthrough" class="control-bar no-drag">
        <span class="version">v{{ version }}</span>
        <button class="btn" @click="togglePassthrough">点击穿透</button>
        <button class="btn danger" @click="quit">退出</button>
      </div>
    </Transition>

    <Transition name="bar">
      <div v-if="passthrough" class="passthrough-hint no-drag" @click="togglePassthrough">
        穿透中 · 点击恢复交互
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.app {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: transparent;
}

/* 穿透模式下整层不接收鼠标事件 */
.app.passthrough {
  pointer-events: none;
}

.title-strip {
  height: 22px;
  flex-shrink: 0;
  cursor: grab;
}

.title-strip:active {
  cursor: grabbing;
}

.stage-area {
  flex: 1;
  min-height: 0;
  position: relative;
}

.control-bar {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 10px;
  background: rgba(24, 24, 28, 0.78);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  font-size: 12px;
  white-space: nowrap;
}

.version {
  color: #8a8a92;
  padding-right: 4px;
}

.btn {
  border: none;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  font-family: inherit;
  color: #d8d8dc;
  background: rgba(255, 255, 255, 0.09);
  cursor: pointer;
  transition: background 0.15s ease;
}

.btn:hover {
  background: rgba(255, 255, 255, 0.16);
}

.btn.danger:hover {
  background: rgba(200, 60, 60, 0.45);
}

.passthrough-hint {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  padding: 8px 16px;
  border-radius: 10px;
  background: rgba(24, 24, 28, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.12);
  font-size: 12px;
  color: #b8b8c0;
  cursor: pointer;
  pointer-events: auto;
}

.bar-enter-active,
.bar-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.bar-enter-from,
.bar-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(6px);
}
</style>
