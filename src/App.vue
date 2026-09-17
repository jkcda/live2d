<script setup lang="ts">
import { computed, onUnmounted, onMounted, ref, watch } from 'vue'
import CharacterStage from './components/CharacterStage.vue'
import ChatPanel from './components/ChatPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import { chatSession, voiceOutput } from './core/runtime'

const version = ref('0.1.0')
const passthrough = ref(false)
const showChat = ref(false)
const showSettings = ref(false)

/** 有没有 Electron 桥。没有就是浏览器里跑，窗口控制按钮点了也没用，直接不显示。 */
const isDesktop = Boolean(window.nexus)

/*
 * 控制条按桌宠的规矩来：平时不出现，鼠标移到她身上才浮现，移开就收起来。
 *
 * 为什么要有「隐藏延迟」：从小人移到控制条上时，中间会经过一段不属于她的区域，
 * 立刻隐藏的话控制条会在你要点它的瞬间消失。延迟窗口足够跨过那段间隙。
 */
const hoveringCharacter = ref(false)
const barRevealed = ref(false)
let hideTimer: number | undefined

/**
 * 面板开着的时候控制条不能收 —— 否则设置面板会突然失去入口
 */
const barPinned = computed(() => showChat.value || showSettings.value)

/**
 * 移开角色后延迟多久收起。
 *
 * 600ms 不是随手定的：控制条在底部、角色在中间，人把鼠标移过去要几百毫秒，
 * 延迟太短就会「刚要点击它先消失」。这条和 CharacterStage 里测试条的迟滞同一个道理。
 */
const BAR_HIDE_DELAY_MS = 600

function revealBar() {
  window.clearTimeout(hideTimer)
  barRevealed.value = true
}

function scheduleHideBar() {
  if (barPinned.value) return
  window.clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => {
    barRevealed.value = false
  }, BAR_HIDE_DELAY_MS)
}

function onCharacterHover(on: boolean) {
  hoveringCharacter.value = on
  if (on) revealBar()
  else scheduleHideBar()
}

const showBar = computed(
  () => !passthrough.value && (barRevealed.value || barPinned.value),
)

/**
 * 面板开着 → 窗口需要键盘焦点；关掉 → 立刻摘掉，回到「点她不抢焦点」。
 *
 * 主进程那边是给窗口打/摘 WS_EX_NOACTIVATE。刻意不用 Electron 的
 * `focusable: false` —— 那个会把 mousedown 一起吃掉，表现为点她没反应。
 */
watch(
  () => showChat.value || showSettings.value,
  (open) => {
    void window.nexus?.setPanelOpen(open)
  },
)

let unsubscribeOpenPanel: (() => void) | null = null
let unsubscribeResetHover: (() => void) | null = null

onMounted(async () => {
  if (window.nexus) {
    version.value = await window.nexus.version()

    // 托盘菜单点了「和她说话…」/「设置…」时从这里进来
    unsubscribeOpenPanel = window.nexus.onOpenPanel((panel) => {
      if (panel === 'chat') {
        showChat.value = true
        showSettings.value = false
      } else {
        showSettings.value = true
      }
      revealBar()
    })

    /*
     * 窗口重新显示后，主进程会把窗口强设成穿透态（那是 setIgnoreMouseEvents
     * 转发失效后的必要重设）。但渲染层自己记的状态没变，两边就不一致了 ——
     * 这里按渲染层认定的状态重新同步回去。
     */
    unsubscribeResetHover = window.nexus.onResetHover(() => {
      void window.nexus?.setInteractive(!passthrough.value)
    })
  }
})

onUnmounted(() => {
  window.clearTimeout(hideTimer)
  unsubscribeOpenPanel?.()
  unsubscribeResetHover?.()
})

/** 切换点击穿透：穿透后鼠标事件直接落到桌面上 */
async function togglePassthrough() {
  passthrough.value = !passthrough.value
  await window.nexus?.setInteractive(!passthrough.value)
}

function toggleChat() {
  showChat.value = !showChat.value
  if (showChat.value) showSettings.value = false
  if (showChat.value) revealBar()
  else scheduleHideBar()
}

function openSettings() {
  showSettings.value = true
  revealBar()
}

function closeSettings() {
  showSettings.value = false
  scheduleHideBar()
}

/** 隐藏角色时把没说完的话一并掐掉，避免只闻其声不见其人 */
async function hide() {
  chatSession.interrupt()
  voiceOutput.interrupt()
  // 面板一起收掉：否则窗口藏起来时它还开着，再显示出来焦点状态是错的
  showChat.value = false
  showSettings.value = false
  await window.nexus?.hide()
}

async function quit() {
  chatSession.interrupt()
  voiceOutput.interrupt()
  await window.nexus?.quit()
}
</script>

<template>
  <div class="app" :class="{ passthrough }">
    <!-- 顶部拖动条：唯一可拖动窗口的区域，避免和角色交互打架 -->
    <div class="title-strip drag-handle" @mouseenter="revealBar" />

    <main class="stage-area">
      <CharacterStage @hover="onCharacterHover" />

      <Transition name="slide">
        <div v-if="showChat && !passthrough" class="chat-slot">
          <ChatPanel @close="toggleChat" @settings="openSettings" />
        </div>
      </Transition>

      <Transition name="fade">
        <div v-if="showSettings && !passthrough" class="settings-slot">
          <SettingsPanel @close="closeSettings" />
        </div>
      </Transition>
    </main>

    <Transition name="bar">
      <div
        v-if="showBar && !showSettings"
        class="control-bar no-drag"
        :class="{ 'above-chat': showChat }"
        @mouseenter="revealBar"
        @mouseleave="scheduleHideBar"
      >
        <span class="version">v{{ version }}</span>
        <button class="btn" :class="{ on: showChat }" @click="toggleChat">对话</button>
        <button class="btn" :class="{ on: showSettings }" @click="openSettings">设置</button>
        <template v-if="isDesktop">
          <button class="btn" @click="togglePassthrough">穿透</button>
          <button class="btn" @click="hide">隐藏</button>
          <button class="btn danger" @click="quit">退出</button>
        </template>
        <span v-else class="badge" title="没跑在 Electron 里，窗口控制不可用">浏览器模式</span>
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

.chat-slot {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 8px;
  height: 56%;
  min-height: 220px;
}

.settings-slot {
  position: absolute;
  inset: 8px;
}

.control-bar {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 10px;
  background: rgba(24, 24, 28, 0.78);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  font-size: 12px;
  white-space: nowrap;
}

/*
 * 对话面板打开时把控制条抬到它上方。
 * 不抬的话两者都贴底（面板 8px、控制条 12px），控制条会压住输入框。
 * max() 是为了照顾面板的 min-height —— 窗口矮的时候 56% 会小于 220px。
 */
.control-bar.above-chat {
  bottom: calc(max(56%, 220px) + 28px);
}

.version {
  color: #8a8a92;
  padding-right: 2px;
}

.badge {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(180, 150, 60, 0.22);
  border: 1px solid rgba(200, 170, 80, 0.35);
  color: #d8c07a;
}

.btn {
  border: none;
  border-radius: 6px;
  padding: 4px 9px;
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

.btn.on {
  background: rgba(90, 120, 200, 0.55);
  color: #f0f0f4;
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

.slide-enter-active,
.slide-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}

.slide-enter-from,
.slide-leave-to {
  opacity: 0;
  transform: translateY(14px);
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
